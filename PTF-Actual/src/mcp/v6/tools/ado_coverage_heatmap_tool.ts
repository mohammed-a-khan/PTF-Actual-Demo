/**
 * cs_qa_ado_coverage_heatmap — multi-dimensional coverage classifier keyed by
 * TAGS (not just AutomationStatus).
 *
 * Classifies every test case in the requested scope on TWO axes by default —
 * `automation` (automated / automation-in-progress / manual / quarantined / flaky)
 * and `type` (smoke / regression / e2e / integration / unit / api / perf /
 * security / a11y / uncategorized) — plus an optional `area` axis.
 *
 * Key differentiators vs. a one-dimensional AutomationStatus scan:
 *   - Reads BOTH ADO's System.Tags AND linked .feature-file tags (a scenario's
 *     @-tags become classification signals), so drift between the two systems
 *     surfaces in a dedicated `drift[]` array.
 *   - AutomationStatus is a FALLBACK — used only when NO explicit tag matches.
 *     Each TC classified via fallback is flagged (`fallbackCount` + the drift
 *     report highlights them).
 *   - No silent truncation. If you asked for 60 suites of test cases, you get
 *     all 60 in the output.
 *   - Priority recommendations point out the highest-ROI automation gaps
 *     ("10 regression TCs are manual").
 *   - Every list-fetch is cached via LruCache; batches of 200 IDs are fetched
 *     via bulkExecute with per-chunk isolation.
 *
 * Output formats: table (ASCII heatmap), json (structured), html (pastable).
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, AdoCreds, AdoHttpError } from './_helpers/ado_http_client';
import { LruCache } from './_helpers/ado_lru_cache';
import { bulkExecute } from './_helpers/bulk_batcher';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';
import {
    resolvePlan,
    resolveSuite,
    listAllSuitesInPlan,
    listTestCasesInSuite,
    collectNestedSuites,
    createCache,
    type ResolverCache,
} from './ado_name_resolver';

// =============================================================================
// Category dictionaries (defaults). Every value is normalized to lowercase and
// compared case-insensitively.
// =============================================================================

interface TagOverrides {
    automated: string[];
    automationInProgress: string[];
    quarantined: string[];
    flaky: string[];
    smoke: string[];
    regression: string[];
    e2e: string[];
    integration: string[];
    unit: string[];
    api: string[];
    perf: string[];
    security: string[];
    a11y: string[];
}

const DEFAULT_TAGS: TagOverrides = {
    automated: ['automated', 'ui-automation', 'api-automation'],
    automationInProgress: ['automation-in-progress', 'wip-automation', 'automation-wip'],
    quarantined: ['quarantined', 'quarantine'],
    flaky: ['flaky', 'flaky-test'],
    smoke: ['smoke'],
    regression: ['regression'],
    e2e: ['e2e', 'end-to-end'],
    integration: ['integration'],
    unit: ['unit'],
    api: ['api', 'api-contract'],
    perf: ['perf', 'performance'],
    security: ['security', 'sec'],
    a11y: ['a11y', 'accessibility'],
};

// =============================================================================
// Zod schemas.
// =============================================================================

const TagOverridesSchema = z.object({
    automated: z.array(z.string()).default(DEFAULT_TAGS.automated),
    automationInProgress: z.array(z.string()).default(DEFAULT_TAGS.automationInProgress),
    quarantined: z.array(z.string()).default(DEFAULT_TAGS.quarantined),
    flaky: z.array(z.string()).default(DEFAULT_TAGS.flaky),
    smoke: z.array(z.string()).default(DEFAULT_TAGS.smoke),
    regression: z.array(z.string()).default(DEFAULT_TAGS.regression),
    e2e: z.array(z.string()).default(DEFAULT_TAGS.e2e),
    integration: z.array(z.string()).default(DEFAULT_TAGS.integration),
    unit: z.array(z.string()).default(DEFAULT_TAGS.unit),
    api: z.array(z.string()).default(DEFAULT_TAGS.api),
    perf: z.array(z.string()).default(DEFAULT_TAGS.perf),
    security: z.array(z.string()).default(DEFAULT_TAGS.security),
    a11y: z.array(z.string()).default(DEFAULT_TAGS.a11y),
}).default(DEFAULT_TAGS);

const InputSchema = z.object({
    planId: z.number().int().positive().optional(),
    planName: z.string().min(1).optional(),
    suiteId: z.number().int().positive().optional(),
    suiteName: z.string().min(1).optional(),
    includeNestedSuites: z.boolean().default(true),
    axes: z.array(z.enum(['automation', 'type', 'area'])).default(['automation', 'type']),
    tagOverrides: TagOverridesSchema.optional(),
    scanFeatureFiles: z.boolean().default(true),
    scanRoot: z.string().min(1).optional(),
    output: z.enum(['table', 'json', 'html']).default('table'),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    pat: z.string().min(1).optional(),
});
type Input = z.infer<typeof InputSchema>;

const DriftSchema = z.object({
    testCaseId: z.number(),
    title: z.string(),
    adoTags: z.array(z.string()),
    featureTags: z.array(z.string()),
    mismatch: z.string(),
});

const TcListEntrySchema = z.object({ id: z.number(), title: z.string() });

const OutputSchema = z.object({
    ok: z.boolean(),
    scope: z.object({
        planId: z.number().optional(),
        suiteId: z.number().optional(),
        includeNestedSuites: z.boolean(),
        totalTestCases: z.number(),
        suitesEnumerated: z.number(),
    }),
    axes: z.array(z.string()),
    matrix: z.object({
        automation: z.record(z.string(), z.number()).optional(),
        type: z.record(z.string(), z.number()).optional(),
        area: z.record(z.string(), z.number()).optional(),
        cross: z.record(z.string(), z.record(z.string(), z.number())).optional(),
    }),
    fallbackCount: z.number(),
    drift: z.array(DriftSchema),
    testCasesByBucket: z.record(z.string(), z.array(TcListEntrySchema)),
    priorityRecommendations: z.array(z.string()),
    warnings: z.array(z.string()),
    ambiguous: z.boolean().optional(),
    ambiguousCandidates: z.array(z.object({ id: z.number(), name: z.string(), note: z.string().optional() })).optional(),
    rendered: z.string().optional(),
    note: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

// =============================================================================
// Feature-file scanning — collect @-tags per test-case ID.
// =============================================================================

function collectFeatureFilesRecursive(root: string): string[] {
    const out: string[] = [];
    const walk = (d: string, depth: number): void => {
        if (depth < 0) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const fp = path.join(d, e.name);
            if (e.isDirectory()) walk(fp, depth - 1);
            else if (e.isFile() && e.name.toLowerCase().endsWith('.feature')) out.push(fp);
        }
    };
    if (fs.existsSync(root)) {
        const st = fs.statSync(root);
        if (st.isDirectory()) walk(root, 10);
        else if (st.isFile() && root.toLowerCase().endsWith('.feature')) out.push(root);
    }
    return out.sort();
}

const TC_BRACED_RE = /^@TestCaseId:\{([^}]*)\}$/i;
const TC_BARE_RE = /^@TestCaseId:(\d+)$/i;

/**
 * Walk a `.feature` file's line stream and, for each scenario carrying a
 * @TestCaseId tag, collect the union of feature-level + scenario-level tags
 * (minus the tool-managed ones like @TestCaseId itself) as classification
 * signals. Normalized to lowercase with `@` stripped.
 */
function scanFeatureFileTags(filePath: string): Map<number, Set<string>> {
    const out = new Map<number, Set<string>>();
    let content: string;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return out; }
    const lines = content.split(/\r?\n/);
    const featureTagBlock: string[] = [];
    let scenarioTagBlock: string[] = [];
    let sawFeature = false;
    for (const raw of lines) {
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (/^@\S/.test(trimmed)) {
            const tags = trimmed.split(/\s+/).filter((t) => t.startsWith('@'));
            if (!sawFeature) featureTagBlock.push(...tags);
            else scenarioTagBlock.push(...tags);
            continue;
        }
        if (/^Feature\s*:/.test(trimmed)) {
            sawFeature = true;
            continue;
        }
        if (/^(Scenario Outline|Scenario)\s*:/.test(trimmed)) {
            const scenarioTags = scenarioTagBlock.slice();
            scenarioTagBlock = [];
            // Extract TC ids from this scenario's tag block.
            const ids: number[] = [];
            for (const t of scenarioTags) {
                const brac = TC_BRACED_RE.exec(t);
                if (brac) {
                    for (const p of brac[1].split(',')) {
                        const n = Number(p.trim()); if (Number.isFinite(n) && n > 0) ids.push(n);
                    }
                    continue;
                }
                const bare = TC_BARE_RE.exec(t);
                if (bare) {
                    const n = Number(bare[1]); if (Number.isFinite(n) && n > 0) ids.push(n);
                }
            }
            if (ids.length === 0) continue;
            // Union feature + scenario tags, strip leading @, lowercase, skip tool-managed.
            const tagSet = new Set<string>();
            for (const t of [...featureTagBlock, ...scenarioTags]) {
                if (/^@TestCaseId:/i.test(t) || /^@TestPlanId:/i.test(t) || /^@TestSuiteId:/i.test(t) || /^@RunId:/i.test(t)) continue;
                tagSet.add(t.replace(/^@/, '').toLowerCase());
            }
            for (const id of ids) {
                const existing = out.get(id) || new Set<string>();
                for (const t of tagSet) existing.add(t);
                out.set(id, existing);
            }
            continue;
        }
        // Steps / other content — nothing more to do until next scenario.
    }
    return out;
}

// =============================================================================
// Classification — automation / type / area.
// =============================================================================

interface Classified {
    testCaseId: number;
    title: string;
    adoTags: string[];
    featureTags: string[];
    /** Union of ADO tags + feature-file tags, all lowercase. */
    allTags: Set<string>;
    automation: string;
    type: string;
    area: string;
    /** True when automation was classified from AutomationStatus (no matching tag). */
    fallback: boolean;
    /** Convenience — the AutomationStatus value from ADO for the drift report. */
    automationStatus: string;
    /** ADO System.AreaPath — used for area axis derivation. */
    areaPath?: string;
}

function classifyAutomation(tagSet: Set<string>, tags: TagOverrides, automationStatus: string): { value: string; fallback: boolean } {
    const has = (list: string[]): boolean => list.some((t) => tagSet.has(t.toLowerCase()));
    if (has(tags.automated)) return { value: 'automated', fallback: false };
    if (has(tags.automationInProgress)) return { value: 'automation-in-progress', fallback: false };
    if (has(tags.quarantined)) return { value: 'quarantined', fallback: false };
    if (has(tags.flaky)) return { value: 'flaky', fallback: false };
    // Fallback to AutomationStatus.
    const s = String(automationStatus || '').toLowerCase();
    if (s === 'automated') return { value: 'automated (fallback)', fallback: true };
    return { value: 'manual (fallback)', fallback: true };
}

function classifyType(tagSet: Set<string>, tags: TagOverrides): string {
    const priority: Array<[string, string[]]> = [
        ['smoke', tags.smoke],
        ['regression', tags.regression],
        ['e2e', tags.e2e],
        ['integration', tags.integration],
        ['unit', tags.unit],
        ['api', tags.api],
        ['perf', tags.perf],
        ['security', tags.security],
        ['a11y', tags.a11y],
    ];
    for (const [label, list] of priority) {
        if (list.some((t) => tagSet.has(t.toLowerCase()))) return label;
    }
    return 'uncategorized';
}

/**
 * area derivation:
 * 1. If any tag matches pattern `<prefix>-*` where prefix is >=3 chars alpha, use `<prefix>`.
 * 2. Else fall back to the last non-root segment of System.AreaPath.
 * 3. Else `uncategorized`.
 */
function classifyArea(tagSet: Set<string>, areaPath: string | undefined): string {
    for (const t of tagSet) {
        const m = /^([a-z]{3,})-[a-z0-9]/i.exec(t);
        if (m) return m[1].toLowerCase();
    }
    if (areaPath) {
        const parts = areaPath.split(/[\\/]+/).filter(Boolean);
        if (parts.length > 1) return parts[parts.length - 1].toLowerCase();
        if (parts.length === 1) return parts[0].toLowerCase();
    }
    return 'uncategorized';
}

function parseAdoTags(rawTags: string | undefined): string[] {
    if (!rawTags) return [];
    return rawTags.split(';').map((t) => t.trim()).filter(Boolean);
}

// =============================================================================
// Suite + test-case enumeration.
// =============================================================================

const workItemCache = new LruCache<string, WorkItemPayload>({ maxSize: 5000, ttlMs: 5 * 60 * 1000 });

interface WorkItemPayload {
    id: number;
    fields: {
        'System.Id'?: number;
        'System.Title'?: string;
        'System.Tags'?: string;
        'System.AreaPath'?: string;
        'System.IterationPath'?: string;
        'Microsoft.VSTS.TCM.AutomationStatus'?: string;
        'Microsoft.VSTS.TCM.AutomatedTestName'?: string;
    };
}

async function enumerateTestCases(
    client: AdoHttpClient,
    cfg: AdoCreds,
    planId: number,
    suiteId: number | undefined,
    includeNested: boolean,
    resolverCache: ResolverCache,
    warnings: string[],
    logger: { info: (m: string, x?: Record<string, unknown>) => void; warn: (m: string, x?: Record<string, unknown>) => void },
): Promise<{ testCaseIds: Set<number>; suitesTouched: number }> {
    const ids = new Set<number>();
    const suitesTouched: number[] = [];
    if (suiteId !== undefined) {
        // Scoped to a suite — expand nested if requested.
        const all = await listAllSuitesInPlan(cfg, planId, resolverCache);
        const targetSuites = includeNested ? collectNestedSuites(all, suiteId) : [{ id: suiteId, name: '', parentSuiteId: undefined }];
        for (const s of targetSuites) {
            suitesTouched.push(s.id);
            const cases = await listTestCasesInSuite(cfg, planId, s.id, resolverCache);
            for (const c of cases) ids.add(c.id);
        }
    } else {
        // Whole plan — walk every suite.
        const all = await listAllSuitesInPlan(cfg, planId, resolverCache);
        for (const s of all) {
            suitesTouched.push(s.id);
            const cases = await listTestCasesInSuite(cfg, planId, s.id, resolverCache);
            for (const c of cases) ids.add(c.id);
        }
    }
    logger.info('enumerated', { planId, suiteId, suites: suitesTouched.length, testCases: ids.size });
    if (suitesTouched.length === 0) warnings.push('No suites found in scope — the plan/suite may be empty or the API returned no rows.');
    return { testCaseIds: ids, suitesTouched: suitesTouched.length };
}

async function batchFetchWorkItems(
    client: AdoHttpClient,
    ids: number[],
    warnings: string[],
): Promise<Map<number, WorkItemPayload>> {
    const out = new Map<number, WorkItemPayload>();
    // Hit cache first.
    const toFetch: number[] = [];
    for (const id of ids) {
        const hit = workItemCache.get(String(id));
        if (hit) out.set(id, hit);
        else toFetch.push(id);
    }
    if (toFetch.length === 0) return out;
    const fields = 'System.Id,System.Title,System.Tags,System.AreaPath,System.IterationPath,Microsoft.VSTS.TCM.AutomationStatus,Microsoft.VSTS.TCM.AutomatedTestName';
    const bulk = await bulkExecute<number, WorkItemPayload>(toFetch, {
        chunkSize: 200,
        concurrency: 2,
        workFn: async (chunk) => {
            const csv = chunk.join(',');
            const data = await client.get<{ value?: WorkItemPayload[] }>(
                `_apis/wit/workitems?ids=${csv}&fields=${fields}&api-version=7.1`,
            );
            const returned = data?.value ?? [];
            const byId = new Map<number, WorkItemPayload>();
            for (const w of returned) byId.set(w.id, w);
            // Preserve INPUT order in the output array (bulkExecute contract:
            // one Out per In in the same order).
            return chunk.map((id) => byId.get(id) ?? { id, fields: {} });
        },
        onChunkError: (err, _chunk, chunkIndex) => {
            warnings.push(`workitems batch ${chunkIndex + 1} failed: ${err.message.slice(0, 200)}`);
        },
    });
    for (const w of bulk.ok) {
        out.set(w.id, w);
        workItemCache.set(String(w.id), w);
    }
    return out;
}

// =============================================================================
// Renderers.
// =============================================================================

function renderTable(matrix: {
    axes: string[];
    automation?: Map<string, number>;
    type?: Map<string, number>;
    area?: Map<string, number>;
    cross?: Map<string, Map<string, number>>;
    totalTestCases: number;
}): string {
    const lines: string[] = [];
    lines.push(`Total test cases: ${matrix.totalTestCases}`);
    lines.push('');
    if (matrix.cross && matrix.axes[0] && matrix.axes[1]) {
        const rowAxis = matrix.axes[0];
        const colAxis = matrix.axes[1];
        const columnLabels = Array.from(matrix.cross.values())
            .flatMap((m) => Array.from(m.keys()));
        const cols = Array.from(new Set(columnLabels));
        cols.sort();
        const rows = Array.from(matrix.cross.keys()); rows.sort();
        const headerLeft = `${rowAxis} \\ ${colAxis}`;
        const rowLabelWidth = Math.max(headerLeft.length, ...rows.map((r) => r.length));
        const colWidth = Math.max(6, ...cols.map((c) => c.length));
        const totalWidth = Math.max(6, String(matrix.totalTestCases).length + 3);
        const pad = (s: string, w: number, right = false): string => right ? s.padStart(w) : s.padEnd(w);
        const header = [pad(headerLeft, rowLabelWidth), ...cols.map((c) => pad(c, colWidth, true)), pad('total', totalWidth, true)].join('  ');
        lines.push(header);
        lines.push('-'.repeat(header.length));
        for (const r of rows) {
            const inner = matrix.cross.get(r) || new Map();
            let rowTotal = 0;
            const cells = cols.map((c) => {
                const v = inner.get(c) ?? 0;
                rowTotal += v;
                return pad(String(v), colWidth, true);
            });
            lines.push([pad(r, rowLabelWidth), ...cells, pad(`(${rowTotal})`, totalWidth, true)].join('  '));
        }
        lines.push('');
    }
    for (const axis of matrix.axes) {
        const m = axis === 'automation' ? matrix.automation : axis === 'type' ? matrix.type : matrix.area;
        if (!m) continue;
        lines.push(`Axis: ${axis}`);
        const entries = Array.from(m.entries()); entries.sort((a, b) => b[1] - a[1]);
        for (const [k, v] of entries) lines.push(`  ${k}: ${v}`);
        lines.push('');
    }
    return lines.join('\n');
}

function renderHtml(matrix: {
    axes: string[];
    automation?: Map<string, number>;
    type?: Map<string, number>;
    area?: Map<string, number>;
    cross?: Map<string, Map<string, number>>;
    totalTestCases: number;
    fallbackCount: number;
    driftCount: number;
    recommendations: string[];
}): string {
    const parts: string[] = [];
    parts.push('<div class="cs-coverage-heatmap">');
    parts.push(`<p><b>Total test cases:</b> ${matrix.totalTestCases} &nbsp; <b>Fallback-classified:</b> ${matrix.fallbackCount} &nbsp; <b>Drift entries:</b> ${matrix.driftCount}</p>`);
    if (matrix.cross && matrix.axes[0] && matrix.axes[1]) {
        const rowAxis = matrix.axes[0], colAxis = matrix.axes[1];
        const cols = Array.from(new Set(Array.from(matrix.cross.values()).flatMap((m) => Array.from(m.keys())))); cols.sort();
        const rows = Array.from(matrix.cross.keys()); rows.sort();
        parts.push('<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-family:monospace;">');
        parts.push(`<tr><th>${escapeHtml(rowAxis)} \\ ${escapeHtml(colAxis)}</th>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}<th>total</th></tr>`);
        for (const r of rows) {
            const inner = matrix.cross.get(r) || new Map<string, number>();
            let rowTotal = 0;
            const cells = cols.map((c) => { const v = inner.get(c) ?? 0; rowTotal += v; return `<td style="text-align:right">${v}</td>`; });
            parts.push(`<tr><th style="text-align:left">${escapeHtml(r)}</th>${cells.join('')}<td style="text-align:right"><b>${rowTotal}</b></td></tr>`);
        }
        parts.push('</table>');
    }
    if (matrix.recommendations.length > 0) {
        parts.push('<h4>Priority recommendations</h4><ul>');
        for (const r of matrix.recommendations) parts.push(`<li>${escapeHtml(r)}</li>`);
        parts.push('</ul>');
    }
    parts.push('</div>');
    return parts.join('\n');
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// =============================================================================
// Recommendation heuristics.
// =============================================================================

function recommend(items: Classified[]): string[] {
    const out: string[] = [];
    // 1. Highest-ROI: manual regression.
    const manualRegression = items.filter((c) => c.automation.startsWith('manual') && c.type === 'regression');
    if (manualRegression.length > 0) {
        out.push(`${manualRegression.length} regression TC(s) are manual — highest-ROI automation bucket.`);
    }
    // 2. Fallback pollution.
    const fallbackCount = items.filter((c) => c.fallback).length;
    if (fallbackCount > 0) {
        out.push(`${fallbackCount} TC(s) classified via AutomationStatus fallback — add explicit tags (e.g. @automated, @regression) for reliability.`);
    }
    // 3. Quarantine size.
    const quarantined = items.filter((c) => c.automation === 'quarantined');
    if (quarantined.length > 5) {
        out.push(`${quarantined.length} TC(s) currently quarantined — investigate and un-quarantine or delete.`);
    }
    // 4. Flaky rate.
    const flaky = items.filter((c) => c.automation === 'flaky');
    if (flaky.length > 0) {
        out.push(`${flaky.length} TC(s) tagged @flaky — stabilize before they mask real regressions.`);
    }
    // 5. Uncategorized type — testing coverage blind spot.
    const uncatType = items.filter((c) => c.type === 'uncategorized');
    if (uncatType.length > 0) {
        out.push(`${uncatType.length} TC(s) have no type tag (smoke/regression/e2e/…) — add a coverage-taxonomy tag so future planning can slice by it.`);
    }
    return out;
}

// =============================================================================
// Registration.
// =============================================================================

registerPrimitive<Input, Output>({
    name: 'cs_qa_ado_coverage_heatmap',
    description:
        'MULTI-DIMENSIONAL coverage heatmap keyed by TAGS (not just AutomationStatus). ' +
        'Classifies every test case in the requested scope on two axes by default — automation ' +
        '(automated/in-progress/manual/quarantined/flaky) and type (smoke/regression/e2e/integration/unit/api/perf/security/a11y/uncategorized) — plus optional area axis. ' +
        'Reads BOTH ADO System.Tags AND linked .feature-file tags; explicit tags take precedence, AutomationStatus is FALLBACK only (flagged). ' +
        'Drift entries surface where ADO tags disagree with feature-file tags. ' +
        'Priority recommendations point to the highest-ROI automation gaps. ' +
        'Output: table (ASCII heatmap), json (structured), or html (pastable). No silent truncation — every TC in scope is included.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input): Promise<Output> => {
        const logger = createLogger(ctx.invocationId, 'cs_qa_ado_coverage_heatmap', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        const tags = { ...DEFAULT_TAGS, ...(input.tagOverrides ?? {}) };

        // Resolve creds.
        const creds = getResolvedCreds(ctx.workspaceRoot, { orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat });
        if (!creds.creds) {
            return {
                ok: false,
                scope: { includeNestedSuites: input.includeNestedSuites, totalTestCases: 0, suitesEnumerated: 0 },
                axes: input.axes, matrix: {},
                fallbackCount: 0, drift: [], testCasesByBucket: {}, priorityRecommendations: [],
                warnings: [creds.diagnostic],
                note: 'ADO not configured',
            };
        }
        const cfg = creds.creds;
        const client = new AdoHttpClient(cfg);
        const resolverCache: ResolverCache = createCache();

        // Resolve plan.
        const defaultPlanId = creds.trace.defaultTestPlanId.value != null ? Number(creds.trace.defaultTestPlanId.value) : undefined;
        const defaultSuiteId = creds.trace.defaultTestSuiteId.value != null ? Number(creds.trace.defaultTestSuiteId.value) : undefined;
        const planInput = { planId: input.planId ?? defaultPlanId, planName: input.planName };
        if (!planInput.planId && !planInput.planName) {
            return {
                ok: false,
                scope: { includeNestedSuites: input.includeNestedSuites, totalTestCases: 0, suitesEnumerated: 0 },
                axes: input.axes, matrix: {}, fallbackCount: 0, drift: [], testCasesByBucket: {},
                priorityRecommendations: [],
                warnings: ['planId (or planName) required — none provided and config has no defaultTestPlanId.'],
                note: 'planId missing',
            };
        }
        const plan = await resolvePlan(cfg, planInput, resolverCache);
        warnings.push(...plan.warnings);
        if (plan.ambiguous) {
            return {
                ok: false,
                scope: { includeNestedSuites: input.includeNestedSuites, totalTestCases: 0, suitesEnumerated: 0 },
                axes: input.axes, matrix: {}, fallbackCount: 0, drift: [], testCasesByBucket: {}, priorityRecommendations: [],
                warnings, ambiguous: true, ambiguousCandidates: plan.candidates ?? [],
                note: 'plan name ambiguous — pick an id',
            };
        }
        if (plan.resolved.length === 0) {
            return {
                ok: false,
                scope: { includeNestedSuites: input.includeNestedSuites, totalTestCases: 0, suitesEnumerated: 0 },
                axes: input.axes, matrix: {}, fallbackCount: 0, drift: [], testCasesByBucket: {}, priorityRecommendations: [],
                warnings: [...warnings, `plan not found: ${input.planId ?? input.planName}`],
                note: 'plan not found',
            };
        }
        const planId = plan.resolved[0].id;

        // Resolve suite (optional).
        let suiteId: number | undefined = input.suiteId ?? defaultSuiteId;
        if (!suiteId && input.suiteName) {
            const suite = await resolveSuite(cfg, { planId, suiteName: input.suiteName }, resolverCache);
            warnings.push(...suite.warnings);
            if (suite.ambiguous) {
                return {
                    ok: false,
                    scope: { planId, includeNestedSuites: input.includeNestedSuites, totalTestCases: 0, suitesEnumerated: 0 },
                    axes: input.axes, matrix: {}, fallbackCount: 0, drift: [], testCasesByBucket: {}, priorityRecommendations: [],
                    warnings, ambiguous: true, ambiguousCandidates: suite.candidates ?? [],
                    note: 'suite name ambiguous — pick an id',
                };
            }
            if (suite.resolved.length > 0) suiteId = suite.resolved[0].id;
        }

        // Enumerate TCs.
        let tcIds: Set<number> = new Set();
        let suitesEnumerated = 0;
        try {
            const enumerated = await enumerateTestCases(client, cfg, planId, suiteId, input.includeNestedSuites, resolverCache, warnings, logger);
            tcIds = enumerated.testCaseIds;
            suitesEnumerated = enumerated.suitesTouched;
        } catch (e) {
            const err = e as AdoHttpError | Error;
            return {
                ok: false,
                scope: { planId, suiteId, includeNestedSuites: input.includeNestedSuites, totalTestCases: 0, suitesEnumerated: 0 },
                axes: input.axes, matrix: {}, fallbackCount: 0, drift: [], testCasesByBucket: {}, priorityRecommendations: [],
                warnings: [...warnings, `enumerate failed: ${err.message.slice(0, 300)}`],
                note: 'enumerate failed',
            };
        }

        if (tcIds.size === 0) {
            return {
                ok: true,
                scope: { planId, suiteId, includeNestedSuites: input.includeNestedSuites, totalTestCases: 0, suitesEnumerated },
                axes: input.axes, matrix: {}, fallbackCount: 0, drift: [], testCasesByBucket: {}, priorityRecommendations: [],
                warnings: [...warnings, 'No test cases found in scope — matrix is empty.'],
                note: 'no test cases in scope',
            };
        }

        // Fetch WI fields (batched 200 per call).
        const wiMap = await batchFetchWorkItems(client, Array.from(tcIds), warnings);

        // Scan feature files if enabled.
        const featureTagsById: Map<number, Set<string>> = new Map();
        if (input.scanFeatureFiles) {
            const root = input.scanRoot ?? path.join(ctx.workspaceRoot, 'test');
            const files = collectFeatureFilesRecursive(root);
            for (const f of files) {
                const scanned = scanFeatureFileTags(f);
                for (const [id, set] of scanned) {
                    const existing = featureTagsById.get(id) || new Set<string>();
                    for (const t of set) existing.add(t);
                    featureTagsById.set(id, existing);
                }
            }
            logger.info('feature-file scan complete', { files: files.length, tcMapped: featureTagsById.size });
        }

        // Classify each TC.
        const classified: Classified[] = [];
        for (const id of tcIds) {
            const wi = wiMap.get(id);
            const title = wi?.fields['System.Title'] ?? `(test case ${id})`;
            const adoTagsRaw = wi?.fields['System.Tags'];
            const adoTags = parseAdoTags(adoTagsRaw);
            const adoTagsLower = new Set(adoTags.map((t) => t.toLowerCase()));
            const featureTagSet = featureTagsById.get(id) ?? new Set<string>();
            const all = new Set<string>();
            for (const t of adoTagsLower) all.add(t);
            for (const t of featureTagSet) all.add(t);
            const automationStatus = wi?.fields['Microsoft.VSTS.TCM.AutomationStatus'] ?? '';
            const areaPath = wi?.fields['System.AreaPath'];
            const auto = classifyAutomation(all, tags, automationStatus);
            const type = classifyType(all, tags);
            const area = classifyArea(all, areaPath);
            classified.push({
                testCaseId: id,
                title,
                adoTags,
                featureTags: Array.from(featureTagSet),
                allTags: all,
                automation: auto.value,
                type,
                area,
                fallback: auto.fallback,
                automationStatus,
                areaPath,
            });
        }

        // Drift detection — ADO tags vs feature tags.
        const drift: z.infer<typeof DriftSchema>[] = [];
        for (const c of classified) {
            const mismatches: string[] = [];
            // Automation state mismatch.
            const hasAutomatedInFeatures = c.featureTags.some((t) => tags.automated.some((v) => v.toLowerCase() === t));
            const hasAutomatedInAdo = c.adoTags.some((t) => tags.automated.some((v) => v.toLowerCase() === t.toLowerCase()));
            const adoAutomationStatus = String(c.automationStatus || '').toLowerCase();
            if (hasAutomatedInFeatures && !hasAutomatedInAdo && adoAutomationStatus !== 'automated') {
                mismatches.push('automation state (@automated in .feature but ADO says not automated)');
            }
            if (!hasAutomatedInFeatures && hasAutomatedInAdo) {
                mismatches.push('automation state (ADO tagged automated but .feature has no @automated tag)');
            }
            // Type-tag divergence.
            const featureTypeTags = new Set(c.featureTags.filter((t) => (['smoke','regression','e2e','integration','unit','api','perf','security','a11y'] as const).includes(t as never)));
            const adoTypeTags = new Set(c.adoTags.map((t) => t.toLowerCase()).filter((t) => (['smoke','regression','e2e','integration','unit','api','perf','security','a11y'] as const).includes(t as never)));
            if (featureTypeTags.size > 0 && adoTypeTags.size > 0) {
                const overlap = Array.from(featureTypeTags).some((t) => adoTypeTags.has(t));
                if (!overlap) mismatches.push(`type-tag mismatch (feature: [${Array.from(featureTypeTags).join(',')}] vs ADO: [${Array.from(adoTypeTags).join(',')}])`);
            }
            if (mismatches.length > 0) {
                drift.push({
                    testCaseId: c.testCaseId,
                    title: c.title,
                    adoTags: c.adoTags,
                    featureTags: c.featureTags,
                    mismatch: mismatches.join('; '),
                });
            }
        }

        // Aggregate matrix.
        const automationMap = new Map<string, number>();
        const typeMap = new Map<string, number>();
        const areaMap = new Map<string, number>();
        const crossMap = new Map<string, Map<string, number>>();
        const buckets: Record<string, Array<{ id: number; title: string }>> = {};
        const wantsAutomation = input.axes.includes('automation');
        const wantsType = input.axes.includes('type');
        const wantsArea = input.axes.includes('area');

        for (const c of classified) {
            if (wantsAutomation) automationMap.set(c.automation, (automationMap.get(c.automation) ?? 0) + 1);
            if (wantsType) typeMap.set(c.type, (typeMap.get(c.type) ?? 0) + 1);
            if (wantsArea) areaMap.set(c.area, (areaMap.get(c.area) ?? 0) + 1);
            // Cross-tab: first two axes.
            if (input.axes.length >= 2) {
                const rowKey = c[input.axes[0]] as string;
                const colKey = c[input.axes[1]] as string;
                let inner = crossMap.get(rowKey);
                if (!inner) { inner = new Map(); crossMap.set(rowKey, inner); }
                inner.set(colKey, (inner.get(colKey) ?? 0) + 1);
                const bucket = `${rowKey}::${colKey}`;
                if (!buckets[bucket]) buckets[bucket] = [];
                buckets[bucket].push({ id: c.testCaseId, title: c.title });
            } else if (input.axes.length === 1) {
                const rowKey = c[input.axes[0]] as string;
                if (!buckets[rowKey]) buckets[rowKey] = [];
                buckets[rowKey].push({ id: c.testCaseId, title: c.title });
            }
        }

        const fallbackCount = classified.filter((c) => c.fallback).length;
        const recommendations = recommend(classified);

        // Build matrix payload.
        const mapToRecord = (m: Map<string, number>): Record<string, number> => {
            const out: Record<string, number> = {}; for (const [k, v] of m) out[k] = v; return out;
        };
        const crossToRecord = (m: Map<string, Map<string, number>>): Record<string, Record<string, number>> => {
            const out: Record<string, Record<string, number>> = {}; for (const [k, v] of m) out[k] = mapToRecord(v); return out;
        };

        const matrix: Output['matrix'] = {};
        if (wantsAutomation) matrix.automation = mapToRecord(automationMap);
        if (wantsType) matrix.type = mapToRecord(typeMap);
        if (wantsArea) matrix.area = mapToRecord(areaMap);
        if (input.axes.length >= 2) matrix.cross = crossToRecord(crossMap);

        // Rendered.
        let rendered: string | undefined;
        if (input.output === 'table') {
            rendered = renderTable({
                axes: input.axes,
                automation: wantsAutomation ? automationMap : undefined,
                type: wantsType ? typeMap : undefined,
                area: wantsArea ? areaMap : undefined,
                cross: input.axes.length >= 2 ? crossMap : undefined,
                totalTestCases: classified.length,
            });
        } else if (input.output === 'html') {
            rendered = renderHtml({
                axes: input.axes,
                automation: wantsAutomation ? automationMap : undefined,
                type: wantsType ? typeMap : undefined,
                area: wantsArea ? areaMap : undefined,
                cross: input.axes.length >= 2 ? crossMap : undefined,
                totalTestCases: classified.length,
                fallbackCount,
                driftCount: drift.length,
                recommendations,
            });
        }

        return {
            ok: true,
            scope: { planId, suiteId, includeNestedSuites: input.includeNestedSuites, totalTestCases: classified.length, suitesEnumerated },
            axes: input.axes,
            matrix,
            fallbackCount,
            drift,
            testCasesByBucket: buckets,
            priorityRecommendations: recommendations,
            warnings,
            rendered,
            note: `Classified ${classified.length} test case(s) across ${input.axes.length} axis/axes. Fallback: ${fallbackCount}. Drift: ${drift.length}.`,
        };
    },
});

// =============================================================================
// Test hook.
// =============================================================================
export function _clearCoverageHeatmapCachesForTests(): void {
    workItemCache.clear();
}
