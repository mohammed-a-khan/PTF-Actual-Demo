/**
 * cs_qa_ado_publish_run_results — consume the framework's report-data.json,
 * create an ADO Test Run, post per-scenario results in batches, upload
 * attachments, then mark the run Completed.
 *
 * Delivery notes / differentiators vs. ad-hoc "just POST every scenario":
 *   1. Retry-After honored on 429/503 via AdoHttpClient (not slammed through
 *      the throttle with exponential backoff).
 *   2. Per-batch Promise.allSettled — one bad row does not fail the whole run.
 *   3. Content-type-correct attachment upload — the ADO attachment endpoint
 *      expects `{stream: base64, fileName, comment, attachmentType}` and
 *      application/json. We never double-serialize.
 *   4. Data-driven scenarios (Scenario Outline with N Examples rows) publish
 *      row 1 → tag id[0], row 2 → tag id[1], … in ORDER — matches @TestCaseId:{a,b,c}.
 *      Row count > id count → warn + publish first N; id count > row count →
 *      publish for the rows we have and log the surplus.
 *   5. dryRun previews the entire ADO payload without a single write.
 *   6. Sync-back appends @RunId:<runId> to every touched feature file — new
 *      tool-managed tag that follows the same hoist rules as @TestPlanId.
 *   7. Sync-back failure NEVER fails the ADO writes — it emits a warning and
 *      the ADO run is still marked Completed.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, AdoHttpError, AdoCreds } from './_helpers/ado_http_client';
import { LruCache } from './_helpers/ado_lru_cache';
import { bulkExecute } from './_helpers/bulk_batcher';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';
import { resolvePlan, resolveSuite, createCache, type ResolverCache } from './ado_name_resolver';
import {
    syncFeaturesAfterRunPublished,
    extractTestCaseIdsFromScenario,
    type RunIdSyncResult,
} from './sync_feature_tags';

// =============================================================================
// Framework tag extractor — use the shipped one so we honor scenario+feature
// precedence, feature-level fallback, and braced-form parsing consistently.
// Falls back to the local implementation when the framework is not installed
// (e.g. PTF-ADO's own smoke tests). Both paths yield the same numeric IDs
// for the well-formed inputs we care about.
// =============================================================================

interface FrameworkTagExtractor {
    extractMetadata: (scenario: { tags?: string[]; name?: string }, feature?: { tags?: string[] }) => {
        testCaseIds: number[];
        testCaseId?: number;
        testPlanId?: number;
        testSuiteId?: number;
        buildId?: string;
        releaseId?: string;
    };
}

function loadFrameworkExtractor(workspaceRoot: string): FrameworkTagExtractor | null {
    const candidates = [
        path.resolve(workspaceRoot, 'node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/ado/CSADOTagExtractor.js'),
    ];
    for (const p of candidates) {
        if (!fs.existsSync(p)) continue;
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod = require(p) as { CSADOTagExtractor: { getInstance(): FrameworkTagExtractor } };
            return mod.CSADOTagExtractor.getInstance();
        } catch { /* fall through to local */ }
    }
    return null;
}

function extractIdsLocalFallback(scenarioTags: string[], featureTags: string[]): number[] {
    const scenarioIds = extractTestCaseIdsFromScenario(scenarioTags);
    if (scenarioIds.length > 0) return scenarioIds;
    return extractTestCaseIdsFromScenario(featureTags);
}

// =============================================================================
// report-data.json shape (framework's aggregator emits this at
// <TEST_RESULTS_DIR>/reports/report-data.json).
// =============================================================================

interface RD_Step {
    name?: string;
    status?: string;
    duration?: number;
    error?: string | { message?: string; stack?: string; stackTrace?: string };
    screenshot?: string;
    logs?: unknown[];
    actions?: unknown[];
}

interface RD_Scenario {
    name?: string;
    scenario?: string;
    status?: string;
    feature?: string;
    tags?: string[];
    steps?: RD_Step[];
    duration?: number;
    startTime?: string | number | Date;
    endTime?: string | number | Date;
    workerId?: number;
    error?: string | { message?: string; stack?: string; stackTrace?: string };
    testData?: Record<string, unknown>;
    id?: string;
    /** Per-scenario attachment file paths (screenshots, videos, traces). Absolute
     * or workspace-relative — the framework populates a mix depending on version. */
    attachments?: Array<{ name?: string; type?: string; path?: string }>;
}

interface RD_Stats {
    totalScenarios?: number;
    passed?: number;
    failed?: number;
    skipped?: number;
    pending?: number;
    broken?: number;
}

interface RD_Artifacts {
    screenshots?: string[];
    videos?: string[];
    traces?: string[];
    logs?: string[];
}

interface ReportData {
    project?: string;
    environment?: string;
    executionTime?: string;
    duration?: number;
    stats?: RD_Stats;
    scenarios?: RD_Scenario[];
    artifacts?: RD_Artifacts;
    parallel?: boolean;
    workers?: number;
}

// =============================================================================
// Zod schemas.
// =============================================================================

const InputSchema = z.object({
    reportPath: z.string().min(1).describe('Path to report-data.json OR its parent directory. When a directory is passed, we walk it looking for `**/reports/report-data.json` (via a shallow scan) and pick the most-recent file by mtime.'),
    planId: z.number().int().positive().optional(),
    planName: z.string().min(1).optional(),
    suiteId: z.number().int().positive().optional(),
    suiteName: z.string().min(1).optional(),
    configurationId: z.number().int().positive().optional().describe('ADO test configuration id (Chrome-Windows / Firefox-Linux / etc).'),
    configurationName: z.string().min(1).optional(),
    runName: z.string().min(1).optional().describe('Test-Run display name. Default: "<project> — <feature> — <YYYY-MM-DD HH:MM>".'),
    ownedBy: z.string().email().optional().describe('Owner email. Falls back to config.defaultAssignedTo.'),
    buildId: z.number().int().positive().optional(),
    releaseUri: z.string().min(1).optional(),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    pat: z.string().min(1).optional(),
    uploadRunZip: z.boolean().default(true),
    uploadPerResultAttachments: z.boolean().default(true),
    maxAttachmentBytes: z.number().int().positive().default(50 * 1024 * 1024),
    dryRun: z.boolean().default(false),
    syncBackTags: z.boolean().default(true),
    syncBackScanRoot: z.string().min(1).optional().describe('Narrow the sync-back scan (defaults to <workspaceRoot>/test).'),
    /** When true and a scenario has no @TestCaseId tag, warn+skip (never auto-create). */
    strictTagRequirement: z.boolean().default(true),
});
type Input = z.infer<typeof InputSchema>;

const SkippedRowSchema = z.object({ scenario: z.string(), reason: z.string() });
const ScenarioMappingSchema = z.object({
    scenario: z.string(),
    testCaseIds: z.array(z.number()),
    outcome: z.string(),
    durationInMs: z.number(),
    attachmentCount: z.number(),
});

const RunIdSyncOutSchema = z.object({
    filePath: z.string(),
    fileChanged: z.boolean(),
    scenariosPatched: z.number(),
    runIdHoisted: z.boolean(),
    warnings: z.array(z.string()),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    dryRun: z.boolean(),
    runId: z.number().optional(),
    runUrl: z.string().optional(),
    resolvedPlanId: z.number().optional(),
    resolvedSuiteId: z.number().optional(),
    resolvedConfigurationId: z.number().optional(),
    reportPath: z.string().optional(),
    scenariosFound: z.number(),
    scenariosPublished: z.number(),
    scenariosSkipped: z.array(SkippedRowSchema),
    scenarioMappings: z.array(ScenarioMappingSchema).optional(),
    results: z.object({ created: z.number(), failed: z.number() }),
    attachments: z.object({ runZipUploaded: z.boolean(), perResultUploaded: z.number(), skippedTooLarge: z.number() }),
    warnings: z.array(z.string()),
    syncBack: z.array(RunIdSyncOutSchema).optional(),
    ambiguous: z.boolean().optional(),
    ambiguousCandidates: z.array(z.object({ id: z.number(), name: z.string(), note: z.string().optional() })).optional(),
    note: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

// =============================================================================
// Report-data discovery + parsing.
// =============================================================================

function findReportDataJson(root: string): string | null {
    if (!fs.existsSync(root)) return null;
    const st = fs.statSync(root);
    if (st.isFile()) return root;
    // BFS with depth cap to keep memory bounded on huge repos.
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    const hits: Array<{ p: string; mtime: number }> = [];
    while (queue.length > 0) {
        const cur = queue.shift()!;
        if (cur.depth > 6) continue;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(cur.dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const p = path.join(cur.dir, e.name);
            if (e.isDirectory()) queue.push({ dir: p, depth: cur.depth + 1 });
            else if (e.isFile() && e.name === 'report-data.json') {
                try { hits.push({ p, mtime: fs.statSync(p).mtimeMs }); } catch { /* ignore */ }
            }
        }
    }
    if (hits.length === 0) return null;
    hits.sort((a, b) => b.mtime - a.mtime);
    return hits[0].p;
}

function loadReportData(reportPathArg: string, workspaceRoot: string): { data: ReportData; jsonPath: string } | null {
    const abs = path.isAbsolute(reportPathArg) ? reportPathArg : path.resolve(workspaceRoot, reportPathArg);
    const resolved = findReportDataJson(abs);
    if (!resolved) return null;
    try {
        const raw = fs.readFileSync(resolved, 'utf-8');
        return { data: JSON.parse(raw) as ReportData, jsonPath: resolved };
    } catch { return null; }
}

// =============================================================================
// Outcome mapping — framework → ADO. ADO expects: Passed, Failed, NotExecuted, Blocked, ...
// =============================================================================

function mapOutcome(raw: string | undefined): 'Passed' | 'Failed' | 'NotExecuted' | 'Blocked' | 'Warning' {
    const s = String(raw ?? '').toLowerCase();
    if (s === 'passed' || s === 'pass') return 'Passed';
    if (s === 'failed' || s === 'fail' || s === 'broken') return 'Failed';
    if (s === 'skipped' || s === 'skip') return 'NotExecuted';
    if (s === 'pending' || s === 'notimplemented') return 'NotExecuted';
    if (s === 'flaky') return 'Warning';
    return 'Failed';
}

function scenarioErrorInfo(sc: RD_Scenario): { errorMessage?: string; stackTrace?: string } {
    if (sc.error) {
        if (typeof sc.error === 'string') return { errorMessage: sc.error };
        return { errorMessage: sc.error.message, stackTrace: sc.error.stack ?? sc.error.stackTrace };
    }
    for (const s of sc.steps ?? []) {
        if (s.status === 'failed' && s.error) {
            if (typeof s.error === 'string') return { errorMessage: s.error };
            return { errorMessage: s.error.message, stackTrace: s.error.stack ?? s.error.stackTrace };
        }
    }
    return {};
}

// =============================================================================
// Attachment discovery — from `scenario.attachments`, `scenario.steps[].screenshot`,
// and the top-level `artifacts.screenshots` list. De-duped, absolute paths.
// =============================================================================

function collectScenarioAttachments(sc: RD_Scenario, reportJsonPath: string, workspaceRoot: string): string[] {
    const paths = new Set<string>();
    const norm = (p: string): string | null => {
        if (!p) return null;
        const abs = path.isAbsolute(p) ? p : path.resolve(path.dirname(reportJsonPath), p);
        // If that doesn't exist, try workspace-relative as a fallback.
        if (fs.existsSync(abs)) return abs;
        const wsAbs = path.isAbsolute(p) ? p : path.resolve(workspaceRoot, p);
        if (fs.existsSync(wsAbs)) return wsAbs;
        return null;
    };
    for (const a of sc.attachments ?? []) {
        const p = norm(String(a.path ?? ''));
        if (p) paths.add(p);
    }
    for (const s of sc.steps ?? []) {
        if (s.screenshot) {
            const p = norm(String(s.screenshot));
            if (p) paths.add(p);
        }
    }
    return Array.from(paths);
}

// =============================================================================
// Zip discovery + inline zipping (best-effort — the framework may have already
// zipped via finalizeTestRun).
// =============================================================================

function findSiblingRunZip(reportJsonPath: string): string | null {
    // reports/report-data.json lives inside <testResultsDir>/reports.
    // The zip typically lives at the parent of <testResultsDir>: e.g. reports/run-<timestamp>.zip
    // and/or the sibling of <testResultsDir>: test-results-<timestamp>.zip.
    const reportsDir = path.dirname(reportJsonPath);
    const testResultsDir = path.dirname(reportsDir);
    const parents = [testResultsDir, path.dirname(testResultsDir)];
    for (const p of parents) {
        if (!fs.existsSync(p)) continue;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (e.isFile() && /\.zip$/i.test(e.name)) return path.join(p, e.name);
        }
    }
    return null;
}

async function inlineZipDir(dir: string, outFile: string): Promise<boolean> {
    // Use Node's zlib+tar isn't ideal for ADO's zip attachments. We shell out to
    // the platform's `zip` when available; otherwise skip (uploadRunZip becomes
    // best-effort false).
    return new Promise<boolean>((resolve) => {
        try {
            const { spawn } = require('child_process') as typeof import('child_process');
            const proc = spawn('zip', ['-r', '-q', outFile, path.basename(dir)], { cwd: path.dirname(dir) });
            proc.on('error', () => resolve(false));
            proc.on('close', (code: number) => resolve(code === 0 && fs.existsSync(outFile)));
        } catch { resolve(false); }
    });
}

// =============================================================================
// ADO attachment upload — base64-encoded stream, JSON body.
// =============================================================================

async function uploadAttachment(
    client: AdoHttpClient,
    urlPath: string,
    fileAbs: string,
    fileName: string,
    comment: string,
    maxBytes: number,
    warnings: string[],
): Promise<boolean> {
    try {
        const st = fs.statSync(fileAbs);
        if (st.size > maxBytes) {
            warnings.push(`Attachment "${fileName}" (${st.size} bytes) exceeds maxAttachmentBytes (${maxBytes}) — skipped.`);
            return false;
        }
        const buf = fs.readFileSync(fileAbs);
        // ADO attachments body: {stream: base64, fileName, comment, attachmentType: 'GeneralAttachment'}
        await client.post(urlPath, {
            stream: buf.toString('base64'),
            fileName,
            comment,
            attachmentType: 'GeneralAttachment',
        });
        return true;
    } catch (e) {
        warnings.push(`Attachment "${fileName}" upload failed: ${(e as Error).message.slice(0, 200)}`);
        return false;
    }
}

// =============================================================================
// Configuration resolver — resolve configurationId by name via /test/configurations.
// Cached at module scope to keep repeated invocations quiet.
// =============================================================================

const configurationCache = new LruCache<string, Array<{ id: number; name: string }>>({ maxSize: 20, ttlMs: 5 * 60 * 1000 });

async function resolveConfiguration(
    client: AdoHttpClient,
    cfg: AdoCreds,
    opts: { configurationId?: number; configurationName?: string },
    warnings: string[],
): Promise<{ id?: number; ambiguousCandidates?: Array<{ id: number; name: string }>; notFound?: string }> {
    if (opts.configurationId !== undefined) return { id: opts.configurationId };
    if (!opts.configurationName || !opts.configurationName.trim()) return {};
    const cacheKey = `${cfg.orgUrl}|${cfg.project}|configurations`;
    let all = configurationCache.get(cacheKey);
    if (!all) {
        try {
            const data = await client.get<{ value?: Array<{ id: number; name: string }> }>(
                '_apis/test/configurations?api-version=7.1',
            );
            all = (data?.value ?? []).map((v) => ({ id: v.id, name: String(v.name) }));
            configurationCache.set(cacheKey, all);
        } catch (e) {
            warnings.push(`GET /test/configurations failed: ${(e as Error).message.slice(0, 200)} — proceeding without configurationId.`);
            return {};
        }
    }
    const target = opts.configurationName.trim();
    const matches = all.filter((c) => c.name === target);
    if (matches.length === 0) return { notFound: target };
    if (matches.length > 1) return { ambiguousCandidates: matches };
    return { id: matches[0].id };
}

// =============================================================================
// Scenario → per-scenario ADO result rows. Handles data-driven fan-out.
// =============================================================================

interface ScenarioResolved {
    scenarioName: string;
    testCaseIds: number[];
    outcome: 'Passed' | 'Failed' | 'NotExecuted' | 'Blocked' | 'Warning';
    durationInMs: number;
    errorMessage?: string;
    stackTrace?: string;
    attachments: string[];
    computerName?: string;
    /** Zero-indexed row position when the scenario is a Scenario Outline; else null. */
    exampleRowIndex: number | null;
}

interface FeatureBucket {
    featureName: string;
    scenarios: RD_Scenario[];
    featureTags: string[];
}

/**
 * Group scenarios by feature so data-driven runs (scenarios that share a name
 * inside one feature) can be identified. Feature-level tags come from the tags
 * shared across every scenario in the bucket (a heuristic — the report-data
 * shape does not preserve the original feature-tag block).
 */
function bucketByFeature(scenarios: RD_Scenario[]): Map<string, FeatureBucket> {
    const out = new Map<string, FeatureBucket>();
    for (const sc of scenarios) {
        const featureName = String(sc.feature ?? '(unknown feature)');
        let b = out.get(featureName);
        if (!b) {
            b = { featureName, scenarios: [], featureTags: [] };
            out.set(featureName, b);
        }
        b.scenarios.push(sc);
    }
    // Feature tags — intersection of scenario tags, so tags that only appear
    // on some rows (i.e. per-example tags) don't get treated as feature-level.
    for (const b of out.values()) {
        const scenarioTagSets = b.scenarios.map((s) => new Set((s.tags ?? []).map((t) => String(t))));
        if (scenarioTagSets.length === 0) continue;
        const first = Array.from(scenarioTagSets[0]);
        b.featureTags = first.filter((t) => scenarioTagSets.every((s) => s.has(t)));
    }
    return out;
}

function resolveScenarios(
    scenarios: RD_Scenario[],
    workspaceRoot: string,
    reportJsonPath: string,
    warnings: string[],
    scenariosSkipped: Array<{ scenario: string; reason: string }>,
    strictTagRequirement: boolean,
): ScenarioResolved[] {
    const framework = loadFrameworkExtractor(workspaceRoot);
    const buckets = bucketByFeature(scenarios);
    const out: ScenarioResolved[] = [];
    for (const b of buckets.values()) {
        // Group by scenario name inside a feature so we can fan out data-driven runs.
        const byName = new Map<string, RD_Scenario[]>();
        for (const s of b.scenarios) {
            const name = String(s.name ?? s.scenario ?? '(unnamed)');
            const arr = byName.get(name) || [];
            arr.push(s);
            byName.set(name, arr);
        }
        for (const [name, group] of byName) {
            // Use the FIRST scenario's tags as the mapping source — for
            // data-driven runs the framework typically emits the SAME tags
            // on every row (the outline tag block). If tags diverge across
            // rows we still fall back to per-row tag extraction below.
            const groupTagIds = framework
                ? framework.extractMetadata({ tags: group[0].tags ?? [], name }, { tags: b.featureTags }).testCaseIds
                : extractIdsLocalFallback(group[0].tags ?? [], b.featureTags);
            if (groupTagIds.length === 0) {
                // No @TestCaseId in tags — skip if strict, else record every row as
                // orphan (we still don't publish to ADO without an ID).
                for (const s of group) {
                    scenariosSkipped.push({ scenario: name, reason: strictTagRequirement ? 'no @TestCaseId tag' : 'no @TestCaseId tag (strict mode off but auto-create not implemented)' });
                }
                continue;
            }
            // Data-driven fan-out: N rows, M ids.
            // - N == M → 1:1 map, in row order
            // - N < M  → publish rows 0..N-1; warn about surplus ids
            // - N > M  → publish rows 0..M-1; warn about rows dropped
            const rows = group.length;
            const ids = groupTagIds.length;
            const boundary = Math.min(rows, ids);
            if (rows > ids) {
                warnings.push(`Scenario "${name}" has ${rows} example rows but only ${ids} @TestCaseId (${groupTagIds.join(',')}) — first ${ids} rows published, remaining ${rows - ids} skipped.`);
                for (let i = ids; i < rows; i++) {
                    scenariosSkipped.push({ scenario: `${name} [row ${i + 1}]`, reason: `no @TestCaseId slot (row ${i + 1} > ${ids} ids)` });
                }
            } else if (rows < ids && rows > 0) {
                warnings.push(`Scenario "${name}" has ${rows} example row(s) but ${ids} @TestCaseId (${groupTagIds.join(',')}) — extra ids ${groupTagIds.slice(rows).join(',')} not published.`);
            }
            for (let i = 0; i < boundary; i++) {
                const s = group[i];
                const err = scenarioErrorInfo(s);
                out.push({
                    scenarioName: rows > 1 ? `${name} [row ${i + 1}]` : name,
                    testCaseIds: [groupTagIds[i]],
                    outcome: mapOutcome(s.status),
                    durationInMs: Math.round(Number(s.duration ?? 0)),
                    errorMessage: err.errorMessage,
                    stackTrace: err.stackTrace,
                    attachments: collectScenarioAttachments(s, reportJsonPath, workspaceRoot),
                    computerName: s.workerId !== undefined ? `worker-${s.workerId}` : undefined,
                    exampleRowIndex: rows > 1 ? i : null,
                });
            }
        }
    }
    return out;
}

// =============================================================================
// Result-row builder for POST /runs/{runId}/results.
// =============================================================================

interface AdoResultRow {
    testCaseTitle: string;
    outcome: string;
    durationInMs: number;
    errorMessage?: string;
    stackTrace?: string;
    testCase: { id: number };
    configuration?: { id: number };
    computerName?: string;
    state: 'Completed';
}

function buildResultRow(r: ScenarioResolved, configurationId: number | undefined): AdoResultRow[] {
    const rows: AdoResultRow[] = [];
    for (const tcId of r.testCaseIds) {
        const row: AdoResultRow = {
            testCaseTitle: r.scenarioName,
            outcome: r.outcome,
            durationInMs: r.durationInMs,
            testCase: { id: tcId },
            state: 'Completed',
        };
        if (r.errorMessage) row.errorMessage = r.errorMessage.slice(0, 4000);
        if (r.stackTrace) row.stackTrace = r.stackTrace.slice(0, 8000);
        if (configurationId !== undefined) row.configuration = { id: configurationId };
        if (r.computerName) row.computerName = r.computerName;
        rows.push(row);
    }
    return rows;
}

// =============================================================================
// Registration.
// =============================================================================

registerPrimitive<Input, Output>({
    name: 'cs_qa_ado_publish_run_results',
    description:
        'Publish the framework\'s report-data.json to ADO as a Test Run (create run → post per-scenario results in batches of 50 → upload run zip + per-result attachments → mark Completed). ' +
        'Handles data-driven scenarios (Scenario Outline + @TestCaseId:{a,b,c} → row 1→a, row 2→b, row 3→c). ' +
        'Uses framework\'s CSADOTagExtractor for scenario+feature precedence when available; falls back to local braced-tag parser. ' +
        'dryRun previews the entire payload with ZERO ADO writes. ' +
        'On success, syncBackTags:true appends @RunId:<runId> to every touched .feature file (hoisted to feature-level when uniform). ' +
        'Retry-After honored on 429/503; per-batch Promise.allSettled means a single failed result does not fail the whole run.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input): Promise<Output> => {
        const logger = createLogger(ctx.invocationId, 'cs_qa_ado_publish_run_results', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        const scenariosSkipped: Array<{ scenario: string; reason: string }> = [];

        // 1. Load report data.
        const loaded = loadReportData(input.reportPath, ctx.workspaceRoot);
        if (!loaded) {
            return {
                ok: false, dryRun: input.dryRun,
                scenariosFound: 0, scenariosPublished: 0,
                scenariosSkipped: [],
                results: { created: 0, failed: 0 },
                attachments: { runZipUploaded: false, perResultUploaded: 0, skippedTooLarge: 0 },
                warnings: [`report-data.json not found under "${input.reportPath}". Pass either the file path directly or a parent directory to auto-discover.`],
                note: 'report not found',
            };
        }
        logger.info('report-data loaded', { path: loaded.jsonPath, scenarios: loaded.data.scenarios?.length ?? 0 });
        const scenariosRaw = loaded.data.scenarios ?? [];

        // 2. Resolve creds.
        const creds = getResolvedCreds(ctx.workspaceRoot, { orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat });
        if (!creds.creds) {
            return {
                ok: false, dryRun: input.dryRun,
                scenariosFound: scenariosRaw.length, scenariosPublished: 0,
                scenariosSkipped: [],
                results: { created: 0, failed: 0 },
                attachments: { runZipUploaded: false, perResultUploaded: 0, skippedTooLarge: 0 },
                warnings: [creds.diagnostic],
                reportPath: loaded.jsonPath,
                note: 'ADO not configured',
            };
        }
        const cfg = creds.creds;

        // Grab default plan/suite from config if user didn't supply.
        const defaultPlanId = creds.trace.defaultTestPlanId.value != null ? Number(creds.trace.defaultTestPlanId.value) : undefined;
        const defaultSuiteId = creds.trace.defaultTestSuiteId.value != null ? Number(creds.trace.defaultTestSuiteId.value) : undefined;
        const defaultAssigned = creds.trace.defaultAssignedTo.value ? String(creds.trace.defaultAssignedTo.value) : undefined;

        const client = new AdoHttpClient(cfg);
        const resolverCache: ResolverCache = createCache();

        // 3. Resolve plan.
        const planInput = { planId: input.planId ?? defaultPlanId, planName: input.planName };
        if (!planInput.planId && !planInput.planName) {
            return {
                ok: false, dryRun: input.dryRun,
                scenariosFound: scenariosRaw.length, scenariosPublished: 0,
                scenariosSkipped: [],
                results: { created: 0, failed: 0 },
                attachments: { runZipUploaded: false, perResultUploaded: 0, skippedTooLarge: 0 },
                warnings: ['planId (or planName) required — none provided and config has no defaultTestPlanId.'],
                reportPath: loaded.jsonPath,
                note: 'planId missing',
            };
        }
        const plan = await resolvePlan(cfg, planInput, resolverCache);
        warnings.push(...plan.warnings);
        if (plan.ambiguous) {
            return {
                ok: false, dryRun: input.dryRun,
                scenariosFound: scenariosRaw.length, scenariosPublished: 0,
                scenariosSkipped: [],
                results: { created: 0, failed: 0 },
                attachments: { runZipUploaded: false, perResultUploaded: 0, skippedTooLarge: 0 },
                warnings: [...warnings, `Ambiguous planName "${input.planName}"`],
                ambiguous: true,
                ambiguousCandidates: plan.candidates ?? [],
                reportPath: loaded.jsonPath,
                note: 'plan name ambiguous — pick an id',
            };
        }
        if (plan.resolved.length === 0) {
            return {
                ok: false, dryRun: input.dryRun,
                scenariosFound: scenariosRaw.length, scenariosPublished: 0,
                scenariosSkipped: [],
                results: { created: 0, failed: 0 },
                attachments: { runZipUploaded: false, perResultUploaded: 0, skippedTooLarge: 0 },
                warnings: [...warnings, `plan not found: ${input.planId ?? input.planName}`],
                reportPath: loaded.jsonPath,
                note: 'plan not found',
            };
        }
        const resolvedPlanId = plan.resolved[0].id;

        // 4. Resolve suite (optional).
        let resolvedSuiteId: number | undefined = input.suiteId ?? defaultSuiteId;
        if (!resolvedSuiteId && input.suiteName) {
            const suite = await resolveSuite(cfg, { planId: resolvedPlanId, suiteName: input.suiteName }, resolverCache);
            warnings.push(...suite.warnings);
            if (suite.ambiguous) {
                return {
                    ok: false, dryRun: input.dryRun,
                    scenariosFound: scenariosRaw.length, scenariosPublished: 0,
                    scenariosSkipped: [],
                    results: { created: 0, failed: 0 },
                    attachments: { runZipUploaded: false, perResultUploaded: 0, skippedTooLarge: 0 },
                    warnings, ambiguous: true, ambiguousCandidates: suite.candidates ?? [],
                    reportPath: loaded.jsonPath,
                    resolvedPlanId,
                    note: 'suite name ambiguous — pick an id',
                };
            }
            if (suite.resolved.length > 0) resolvedSuiteId = suite.resolved[0].id;
        }

        // 5. Resolve configuration.
        const confRes = await resolveConfiguration(client, cfg, { configurationId: input.configurationId, configurationName: input.configurationName }, warnings);
        if (confRes.ambiguousCandidates) {
            return {
                ok: false, dryRun: input.dryRun,
                scenariosFound: scenariosRaw.length, scenariosPublished: 0,
                scenariosSkipped: [],
                results: { created: 0, failed: 0 },
                attachments: { runZipUploaded: false, perResultUploaded: 0, skippedTooLarge: 0 },
                warnings, ambiguous: true, ambiguousCandidates: confRes.ambiguousCandidates,
                reportPath: loaded.jsonPath,
                resolvedPlanId, resolvedSuiteId,
                note: 'configuration name ambiguous — pick an id',
            };
        }
        const resolvedConfigurationId = confRes.id;
        if (confRes.notFound) warnings.push(`configurationName "${confRes.notFound}" not found — proceeding without configuration.`);

        // 6. Resolve scenario → test-case mapping.
        const resolved = resolveScenarios(scenariosRaw, ctx.workspaceRoot, loaded.jsonPath, warnings, scenariosSkipped, input.strictTagRequirement);
        const scenariosPublished = resolved.length;
        const scenarioMappings = resolved.map((r) => ({
            scenario: r.scenarioName,
            testCaseIds: r.testCaseIds,
            outcome: r.outcome,
            durationInMs: r.durationInMs,
            attachmentCount: r.attachments.length,
        }));

        // 7. Dry-run — return preview.
        if (input.dryRun) {
            return {
                ok: true, dryRun: true,
                resolvedPlanId, resolvedSuiteId, resolvedConfigurationId,
                reportPath: loaded.jsonPath,
                scenariosFound: scenariosRaw.length,
                scenariosPublished,
                scenariosSkipped,
                scenarioMappings,
                results: { created: 0, failed: 0 },
                attachments: { runZipUploaded: false, perResultUploaded: 0, skippedTooLarge: 0 },
                warnings,
                note: `[dry-run] Would create ADO Test Run under plan ${resolvedPlanId}${resolvedSuiteId ? `/suite ${resolvedSuiteId}` : ''} with ${scenariosPublished} result rows across ${Math.ceil(scenariosPublished / 50)} batch(es). Nothing written.`,
            };
        }

        if (scenariosPublished === 0) {
            return {
                ok: true, dryRun: false,
                resolvedPlanId, resolvedSuiteId, resolvedConfigurationId,
                reportPath: loaded.jsonPath,
                scenariosFound: scenariosRaw.length,
                scenariosPublished: 0,
                scenariosSkipped,
                results: { created: 0, failed: 0 },
                attachments: { runZipUploaded: false, perResultUploaded: 0, skippedTooLarge: 0 },
                warnings: [...warnings, 'No scenarios carried @TestCaseId — nothing to publish. Nothing written to ADO.'],
                note: 'no publishable scenarios',
            };
        }

        // 8. Create run.
        const runName = input.runName || (() => {
            const proj = loaded.data.project || 'Test Run';
            const feat = Array.from(new Set(scenariosRaw.map((s) => s.feature).filter(Boolean))).join(', ').slice(0, 60);
            const now = new Date();
            const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
            return [proj, feat, ts].filter(Boolean).join(' — ');
        })();

        const createRunBody: Record<string, unknown> = {
            name: runName,
            plan: { id: resolvedPlanId },
            automated: true,
        };
        if (resolvedConfigurationId !== undefined) createRunBody.configurationIds = [resolvedConfigurationId];
        if (input.buildId !== undefined) createRunBody.buildReference = { id: input.buildId };
        if (input.releaseUri) createRunBody.releaseUri = input.releaseUri;
        if (input.ownedBy || defaultAssigned) createRunBody.owner = { uniqueName: input.ownedBy ?? defaultAssigned };

        let runId = 0;
        let runUrl: string | undefined;
        try {
            const created = await client.post<{ id: number; url: string; webAccessUrl?: string }>(
                '_apis/test/runs?api-version=7.1',
                createRunBody,
                { onEvent: (evt) => logger.info('http', { evt }) },
            );
            runId = Number(created?.id ?? 0);
            runUrl = created?.webAccessUrl || (runId ? `${cfg.orgUrl}/${encodeURIComponent(cfg.project)}/_TestManagement/Runs?runId=${runId}&_a=runCharts` : undefined);
        } catch (e) {
            const err = e as AdoHttpError | Error;
            return {
                ok: false, dryRun: false,
                resolvedPlanId, resolvedSuiteId, resolvedConfigurationId,
                reportPath: loaded.jsonPath,
                scenariosFound: scenariosRaw.length,
                scenariosPublished: 0,
                scenariosSkipped,
                results: { created: 0, failed: 0 },
                attachments: { runZipUploaded: false, perResultUploaded: 0, skippedTooLarge: 0 },
                warnings: [...warnings, `Test Run create failed: ${err.message.slice(0, 300)}`],
                note: 'run create failed — nothing published',
            };
        }
        if (!runId) {
            return {
                ok: false, dryRun: false,
                resolvedPlanId, resolvedSuiteId, resolvedConfigurationId,
                reportPath: loaded.jsonPath,
                scenariosFound: scenariosRaw.length,
                scenariosPublished: 0,
                scenariosSkipped,
                results: { created: 0, failed: 0 },
                attachments: { runZipUploaded: false, perResultUploaded: 0, skippedTooLarge: 0 },
                warnings: [...warnings, 'ADO returned no runId in create-run response.'],
                note: 'run create returned no id',
            };
        }
        logger.info('run created', { runId, runUrl });

        // 9. Post results in batches of 50 with per-chunk failure isolation.
        const flatRows: AdoResultRow[] = [];
        // Index maintained so we can resolve scenario → resultId after ADO returns.
        const rowSourceIndex: number[] = [];   // rowsIdx → resolved[] index
        for (let i = 0; i < resolved.length; i++) {
            const rows = buildResultRow(resolved[i], resolvedConfigurationId);
            for (const r of rows) {
                flatRows.push(r);
                rowSourceIndex.push(i);
            }
        }

        const bulkResults = await bulkExecute<AdoResultRow, { adoResultId: number; scenarioIndex: number }>(flatRows, {
            chunkSize: 50,
            concurrency: 2,
            workFn: async (chunk, chunkIndex) => {
                const posted = await client.post<{ value?: Array<{ id: number; testCase?: { id: number } }> }>(
                    `_apis/test/runs/${runId}/results?api-version=7.1`,
                    chunk,
                );
                const returned = posted?.value ?? [];
                // Map back to scenarios in order — ADO responds in the same order as the request.
                const startIdx = chunkIndex * 50;
                return returned.map((v, i) => ({ adoResultId: Number(v.id), scenarioIndex: rowSourceIndex[startIdx + i] }));
            },
            onChunkError: (err, _chunk, chunkIndex) => {
                warnings.push(`Batch ${chunkIndex + 1}: ${err.message.slice(0, 200)}`);
                logger.warn('result-batch failed', { chunkIndex, error: err.message });
            },
        });

        const created = bulkResults.ok.length;
        const failed = bulkResults.failed.length;

        // 10. Per-result attachments.
        let perResultUploaded = 0;
        let skippedTooLarge = 0;
        if (input.uploadPerResultAttachments) {
            // Group ok resultIds by scenarioIndex for upload attribution.
            const scenarioToResultIds = new Map<number, number[]>();
            for (const r of bulkResults.ok) {
                const arr = scenarioToResultIds.get(r.scenarioIndex) || [];
                arr.push(r.adoResultId);
                scenarioToResultIds.set(r.scenarioIndex, arr);
            }
            for (const [scenarioIdx, resultIds] of scenarioToResultIds) {
                const sc = resolved[scenarioIdx];
                if (!sc || sc.attachments.length === 0) continue;
                for (const resultId of resultIds) {
                    for (const attAbs of sc.attachments) {
                        const st = (() => { try { return fs.statSync(attAbs); } catch { return null; } })();
                        if (!st) continue;
                        if (st.size > input.maxAttachmentBytes) { skippedTooLarge++; continue; }
                        const fileName = path.basename(attAbs);
                        const ok = await uploadAttachment(
                            client,
                            `_apis/test/Runs/${runId}/Results/${resultId}/attachments?api-version=7.1`,
                            attAbs, fileName, `Attached to scenario "${sc.scenarioName}"`, input.maxAttachmentBytes, warnings,
                        );
                        if (ok) perResultUploaded++;
                    }
                }
            }
        }

        // 11. Run-level zip.
        let runZipUploaded = false;
        if (input.uploadRunZip) {
            let zipPath = findSiblingRunZip(loaded.jsonPath);
            const inlineZipPath = path.join(os.tmpdir(), `cs-qa-run-${runId}.zip`);
            if (!zipPath) {
                const testResultsDir = path.dirname(path.dirname(loaded.jsonPath));
                if (fs.existsSync(testResultsDir) && fs.statSync(testResultsDir).isDirectory()) {
                    const zipped = await inlineZipDir(testResultsDir, inlineZipPath);
                    if (zipped) zipPath = inlineZipPath;
                }
            }
            if (zipPath && fs.existsSync(zipPath)) {
                runZipUploaded = await uploadAttachment(
                    client,
                    `_apis/test/runs/${runId}/attachments?api-version=7.1`,
                    zipPath, path.basename(zipPath), 'CS Framework run archive', input.maxAttachmentBytes, warnings,
                );
            } else {
                warnings.push('uploadRunZip:true but no run zip found (framework did not finalize + `zip` binary unavailable for inline zip) — skipping.');
            }
            // Best-effort cleanup — a failing unlink must never fail the tool.
            try { if (fs.existsSync(inlineZipPath)) fs.unlinkSync(inlineZipPath); } catch { /* ignore */ }
        }

        // 12. Mark run Completed.
        try {
            await client.patch(`_apis/test/runs/${runId}?api-version=7.1`, { state: 'Completed' });
        } catch (e) {
            warnings.push(`PATCH /runs/${runId} state=Completed failed: ${(e as Error).message.slice(0, 200)} — run left in-progress. Complete manually via ADO UI.`);
        }

        // 13. Sync-back @RunId to feature files — non-fatal.
        let syncBack: RunIdSyncResult[] | undefined;
        if (input.syncBackTags) {
            try {
                const publishedTcIds = Array.from(new Set(resolved.flatMap((r) => r.testCaseIds)));
                syncBack = syncFeaturesAfterRunPublished(ctx.workspaceRoot, {
                    runId,
                    publishedTestCaseIds: publishedTcIds,
                    scanRoot: input.syncBackScanRoot,
                });
            } catch (e) {
                warnings.push(`sync-back @RunId failed: ${(e as Error).message.slice(0, 200)} — ADO run publish still succeeded.`);
            }
        }

        return {
            ok: true, dryRun: false,
            runId, runUrl,
            resolvedPlanId, resolvedSuiteId, resolvedConfigurationId,
            reportPath: loaded.jsonPath,
            scenariosFound: scenariosRaw.length,
            scenariosPublished,
            scenariosSkipped,
            scenarioMappings,
            results: { created, failed },
            attachments: { runZipUploaded, perResultUploaded, skippedTooLarge },
            warnings,
            syncBack: syncBack?.filter((r) => r.fileChanged || r.warnings.length > 0),
            note: `Published ${created}/${flatRows.length} result rows to ADO Test Run ${runId}${failed > 0 ? ` (${failed} row(s) failed — see warnings)` : ''}.`,
        };
    },
});

// =============================================================================
// Test hook — clears the module-level configuration cache between smoke tests.
// =============================================================================
export function _clearPublishRunCachesForTests(): void {
    configurationCache.clear();
}
