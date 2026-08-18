import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient } from './_helpers/ado_http_client';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';

// Common Test Report Format (CTRF) exporter — https://ctrf.io
//
// Two sources:
//   - from-report-data — the framework's aggregator flat shape (report-data.json)
//   - from-ado-run     — fetch runId + results from ADO, normalize to CTRF
//
// CTRF status enum: passed | failed | skipped | pending | other
// Framework's richest shape (CSEnterpriseReporter) has:
//   passed | failed | skipped | pending | broken | flaky
// Mapping: broken -> failed ; flaky -> other (with tag @flaky preserved).

type CtrfStatus = 'passed' | 'failed' | 'skipped' | 'pending' | 'other';

interface CtrfTest {
    name: string;
    status: CtrfStatus;
    duration: number;
    message?: string;
    trace?: string;
    ai?: string;
    tags?: string[];
    suite?: string;
    filePath?: string;
    browser?: string;
    device?: string;
    screenshot?: string;
    attachments?: Array<{ name: string; contentType?: string; path?: string }>;
    extra?: Record<string, unknown>;
    start?: number;
    stop?: number;
}

interface CtrfEnvironment {
    appVersion?: string;
    buildNumber?: string;
    buildName?: string;
    branchName?: string;
    testEnvironment?: string;
    extra?: Record<string, unknown>;
}

interface CtrfSummary {
    tests: number;
    passed: number;
    failed: number;
    skipped: number;
    pending: number;
    other: number;
    start: number;
    stop: number;
    extra?: Record<string, unknown>;
}

interface CtrfReport {
    results: {
        tool: { name: string; version?: string };
        summary: CtrfSummary;
        tests: CtrfTest[];
        environment?: CtrfEnvironment;
    };
}

interface ReportDataScenario {
    name?: string;
    scenario?: string;
    status?: string;
    feature?: string;
    suite?: string;
    tags?: string[];
    duration?: number;
    startTime?: string | number | Date;
    endTime?: string | number | Date;
    error?: string | { message?: string; stack?: string; stackTrace?: string };
    filePath?: string;
    file?: string;
    steps?: Array<{ name?: string; status?: string; duration?: number; error?: unknown; screenshot?: string }>;
    screenshot?: string;
    browser?: string | { name?: string };
    device?: string | { model?: string };
    attachments?: Array<{ name?: string; type?: string; path?: string }>;
    id?: string;
}

interface ReportDataStats {
    totalScenarios?: number;
    total?: number;
    passed?: number;
    failed?: number;
    skipped?: number;
    pending?: number;
    broken?: number;
    flaky?: number;
}

interface FrameworkReportData {
    project?: string;
    environment?: string;
    executionTime?: string;
    duration?: number;
    stats?: ReportDataStats;
    scenarios?: ReportDataScenario[];
    artifacts?: unknown;
    parallel?: boolean;
    workers?: number;
    appVersion?: string;
    buildNumber?: string;
    buildName?: string;
    branchName?: string;
}

function mapStatus(raw: unknown): CtrfStatus {
    const s = String(raw ?? '').toLowerCase();
    if (s === 'passed' || s === 'pass' || s === 'success') return 'passed';
    if (s === 'failed' || s === 'fail' || s === 'broken') return 'failed';
    if (s === 'skipped' || s === 'skip') return 'skipped';
    if (s === 'pending' || s === 'notimplemented' || s === 'not-implemented') return 'pending';
    // flaky / inconclusive / anything else → other
    return 'other';
}

function toMillis(input: string | number | Date | undefined): number | undefined {
    if (input === undefined || input === null) return undefined;
    if (typeof input === 'number') return input;
    if (input instanceof Date) return input.getTime();
    const ms = Date.parse(String(input));
    return Number.isFinite(ms) ? ms : undefined;
}

function findPackageVersion(workspaceRoot: string): string {
    // Prefer the FRAMEWORK's package.json (consumer projects), then workspace pkg.
    const candidates = [
        path.resolve(workspaceRoot, 'node_modules/@mdakhan.mak/cs-playwright-test-framework/package.json'),
        path.resolve(workspaceRoot, 'package.json'),
    ];
    for (const c of candidates) {
        try {
            if (fs.existsSync(c)) {
                const pkg = JSON.parse(fs.readFileSync(c, 'utf-8')) as { version?: string };
                if (pkg.version) return pkg.version;
            }
        } catch { /* ignore */ }
    }
    return 'unknown';
}

function normalizeFromReportData(data: FrameworkReportData, toolVersion: string): CtrfReport {
    const scenarios = data.scenarios ?? [];
    const executionMs = toMillis(data.executionTime) ?? Date.now();
    const totalDuration = Number(data.duration ?? 0);
    const startMs = executionMs - totalDuration;
    const stopMs = executionMs;
    const tests: CtrfTest[] = scenarios.map((s) => {
        const status = mapStatus(s.status);
        const rawStart = toMillis(s.startTime);
        const rawStop = toMillis(s.endTime);
        const errorText = typeof s.error === 'string' ? s.error : (s.error?.message);
        const traceText = typeof s.error === 'object' && s.error ? (s.error.stack ?? s.error.stackTrace) : undefined;
        const tagsClean = (s.tags ?? []).map((t) => String(t).trim()).filter((t) => t.length > 0);
        // Preserve the original framework status if we down-coded a rich variant.
        const originalStatus = String(s.status ?? '').toLowerCase();
        if ((originalStatus === 'broken' || originalStatus === 'flaky') && !tagsClean.includes(`@${originalStatus}`)) {
            tagsClean.push(`@${originalStatus}`);
        }
        const extra: Record<string, unknown> = {};
        if (s.id) extra.scenarioId = s.id;
        // Preserve ADO test-case linkage from tags (@TestCaseId:{n1,n2}) — CTRF-consumers
        // (like the CTRF-CLI GitHub PR reporter) use `extra.adoTestCaseId` conventionally.
        for (const t of tagsClean) {
            const m = /^@TestCaseId:(?:\{([^}]+)\}|(\d+))/.exec(t);
            if (m) {
                const ids = (m[1] ?? m[2]).split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));
                if (ids.length === 1) extra.adoTestCaseId = ids[0];
                else if (ids.length > 1) extra.adoTestCaseIds = ids;
            }
        }
        const attachments = (s.attachments ?? []).map((a) => ({
            name: String(a.name ?? path.basename(String(a.path ?? 'attachment'))),
            contentType: a.type,
            path: a.path,
        }));
        const browserStr = typeof s.browser === 'string' ? s.browser : s.browser?.name;
        const deviceStr = typeof s.device === 'string' ? s.device : s.device?.model;
        const test: CtrfTest = {
            name: s.name ?? s.scenario ?? 'Unnamed scenario',
            status,
            duration: Number(s.duration ?? 0),
            message: errorText,
            trace: traceText,
            tags: tagsClean.length > 0 ? tagsClean : undefined,
            suite: s.suite ?? s.feature,
            filePath: s.filePath ?? s.file,
            browser: browserStr,
            device: deviceStr,
            screenshot: s.screenshot,
            attachments: attachments.length > 0 ? attachments : undefined,
            extra: Object.keys(extra).length > 0 ? extra : undefined,
            start: rawStart,
            stop: rawStop,
        };
        return test;
    });
    // Summary — prefer the framework's stats block when present, otherwise recount.
    const counts = { passed: 0, failed: 0, skipped: 0, pending: 0, other: 0 };
    for (const t of tests) counts[t.status]++;
    const summary: CtrfSummary = {
        tests: tests.length,
        passed: counts.passed,
        failed: counts.failed,
        skipped: counts.skipped,
        pending: counts.pending,
        other: counts.other,
        start: startMs,
        stop: stopMs,
        extra: data.stats ? { frameworkStats: data.stats } : undefined,
    };
    const environment: CtrfEnvironment | undefined = (data.environment || data.appVersion || data.buildNumber || data.branchName)
        ? {
            testEnvironment: data.environment,
            appVersion: data.appVersion,
            buildNumber: data.buildNumber,
            buildName: data.buildName,
            branchName: data.branchName,
            extra: data.project ? { project: data.project, parallel: data.parallel, workers: data.workers } : undefined,
        }
        : undefined;
    return {
        results: {
            tool: { name: 'cs-playwright-test-framework', version: toolVersion },
            summary,
            tests,
            environment,
        },
    };
}

function validateCtrf(report: CtrfReport): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!report.results) errors.push('missing results block');
    if (!report.results?.tool?.name) errors.push('missing results.tool.name');
    if (!report.results?.summary) errors.push('missing results.summary');
    else {
        const s = report.results.summary;
        for (const f of ['tests', 'passed', 'failed', 'skipped', 'pending', 'other', 'start', 'stop'] as const) {
            if (typeof s[f] !== 'number') errors.push(`summary.${f} not a number`);
        }
    }
    if (!Array.isArray(report.results?.tests)) errors.push('results.tests must be an array');
    else {
        report.results.tests.forEach((t, i) => {
            if (!t.name) errors.push(`tests[${i}].name missing`);
            if (!['passed', 'failed', 'skipped', 'pending', 'other'].includes(t.status)) errors.push(`tests[${i}].status invalid`);
            if (typeof t.duration !== 'number') errors.push(`tests[${i}].duration not a number`);
        });
    }
    return { ok: errors.length === 0, errors };
}

async function fetchAdoRunResults(cfg: { orgUrl: string; project: string; pat: string }, runId: number): Promise<{ run: Record<string, unknown>; results: Array<Record<string, unknown>> }> {
    const client = new AdoHttpClient(cfg);
    const run = await client.get<Record<string, unknown>>(`_apis/test/runs/${runId}?api-version=7.0`);
    // Pagination: /_apis/test/runs/{id}/results has $top/$skip; loop till empty.
    const all: Array<Record<string, unknown>> = [];
    let skip = 0;
    const top = 200;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const page = await client.get<{ value?: Array<Record<string, unknown>> }>(
            `_apis/test/runs/${runId}/results?api-version=7.0&$top=${top}&$skip=${skip}`,
        );
        const batch = page.value ?? [];
        if (batch.length === 0) break;
        for (const r of batch) all.push(r);
        if (batch.length < top) break;
        skip += batch.length;
        if (skip > 10_000) break; // safety valve
    }
    return { run, results: all };
}

function normalizeFromAdoRun(run: Record<string, unknown>, results: Array<Record<string, unknown>>, toolVersion: string): CtrfReport {
    // ADO Test.Run outcome enum: Passed, Failed, NotExecuted, NotApplicable, Blocked, Warning, Aborted, Inconclusive
    const outcomeMap: Record<string, CtrfStatus> = {
        passed: 'passed',
        failed: 'failed',
        notexecuted: 'skipped',
        notapplicable: 'skipped',
        blocked: 'other',
        warning: 'other',
        aborted: 'failed',
        inconclusive: 'other',
    };
    const tests: CtrfTest[] = results.map((r) => {
        const rawOutcome = String(r.outcome ?? '').toLowerCase();
        const status: CtrfStatus = outcomeMap[rawOutcome] ?? 'other';
        const start = toMillis(r.startedDate as string) ?? 0;
        const stop = toMillis(r.completedDate as string) ?? 0;
        const testCase = (r.testCase as { id?: string | number; name?: string } | undefined) ?? {};
        const errorMessage = (r.errorMessage as string) || undefined;
        const stackTrace = (r.stackTrace as string) || undefined;
        const extra: Record<string, unknown> = {
            adoResultId: r.id,
            adoRunId: (r.testRun as { id?: string | number } | undefined)?.id,
            adoTestCaseId: testCase.id ? Number(testCase.id) : undefined,
        };
        return {
            name: (r.testCaseTitle as string) || testCase.name || `Result ${r.id}`,
            status,
            duration: Number(r.durationInMs ?? Math.max(0, stop - start)),
            message: errorMessage,
            trace: stackTrace,
            start: start || undefined,
            stop: stop || undefined,
            extra,
        };
    });
    const counts = { passed: 0, failed: 0, skipped: 0, pending: 0, other: 0 };
    for (const t of tests) counts[t.status]++;
    const startedDate = toMillis(run.startedDate as string) ?? Date.now();
    const completedDate = toMillis(run.completedDate as string) ?? Date.now();
    return {
        results: {
            tool: { name: 'cs-playwright-test-framework', version: toolVersion },
            summary: {
                tests: tests.length,
                ...counts,
                start: startedDate,
                stop: completedDate,
                extra: { adoRunId: run.id, adoRunName: run.name, adoPlanId: (run.plan as { id?: string | number } | undefined)?.id },
            },
            tests,
            environment: {
                buildNumber: (run.build as { name?: string } | undefined)?.name,
                testEnvironment: 'ado',
                extra: { adoRunId: run.id },
            },
        },
    };
}

registerPrimitive({
    name: 'cs_qa_ctrf_export',
    description: 'Export test results to the Common Test Report Format (CTRF) — https://ctrf.io. Verbs: from-report-data (read a framework report-data.json flat aggregate and write CTRF JSON), from-ado-run (fetch ADO test run + results, normalize to CTRF). Output validates against the CTRF schema (required fields present) before write. Status maps framework rich enum to CTRF: broken->failed, flaky->other (@flaky tag preserved), pass/fail/skip/pending flow through.',
    inputSchema: z.discriminatedUnion('verb', [
        z.object({
            verb: z.literal('from-report-data'),
            reportDataPath: z.string().min(1).describe('Path to a framework report-data.json file (absolute or workspace-relative).'),
            outputPath: z.string().min(1).describe('Where to write the CTRF JSON. Extension auto-inferred; ".ctrf.json" recommended by CTRF convention but ".json" also accepted.'),
            appendGitContext: z.boolean().default(false).describe('When true, augment environment with git branch (best-effort; skipped if git unavailable).'),
        }),
        z.object({
            verb: z.literal('from-ado-run'),
            runId: z.number().int().positive(),
            outputPath: z.string().min(1),
            orgUrl: z.string().url().optional(),
            project: z.string().min(1).optional(),
        }),
    ]),
    outputSchema: z.object({
        ok: z.boolean(),
        verb: z.string(),
        writtenPath: z.string().optional(),
        sizeBytes: z.number().optional(),
        summary: z.record(z.string(), z.any()).optional(),
        validation: z.object({ ok: z.boolean(), errors: z.array(z.string()) }).optional(),
        note: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const logger = createLogger(ctx.invocationId, 'cs_qa_ctrf_export', { workspaceRoot: ctx.workspaceRoot });
        const toolVersion = findPackageVersion(ctx.workspaceRoot);

        const resolveOutputPath = (raw: string): string => path.isAbsolute(raw) ? raw : path.resolve(ctx.workspaceRoot, raw);

        if (input.verb === 'from-report-data') {
            const src = path.isAbsolute(input.reportDataPath) ? input.reportDataPath : path.resolve(ctx.workspaceRoot, input.reportDataPath);
            if (!fs.existsSync(src)) {
                return { ok: false, verb: input.verb, note: `report-data.json not found at ${src}` };
            }
            let raw: FrameworkReportData;
            try {
                raw = JSON.parse(fs.readFileSync(src, 'utf-8')) as FrameworkReportData;
            } catch (e) {
                return { ok: false, verb: input.verb, note: `Failed to parse ${src}: ${(e as Error).message}` };
            }
            const report = normalizeFromReportData(raw, toolVersion);
            // Best-effort git branch enrichment.
            if (input.appendGitContext && report.results.environment) {
                try {
                    const headFile = path.join(ctx.workspaceRoot, '.git', 'HEAD');
                    if (fs.existsSync(headFile)) {
                        const head = fs.readFileSync(headFile, 'utf-8').trim();
                        const m = /^ref:\s+refs\/heads\/(.+)$/.exec(head);
                        if (m && !report.results.environment.branchName) report.results.environment.branchName = m[1];
                    }
                } catch { /* best-effort */ }
            }
            const validation = validateCtrf(report);
            if (!validation.ok) {
                logger.error('CTRF validation failed', { errors: validation.errors });
                return { ok: false, verb: input.verb, validation, note: `CTRF validation failed: ${validation.errors.slice(0, 3).join('; ')}` };
            }
            const out = resolveOutputPath(input.outputPath);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            const json = JSON.stringify(report, null, 2);
            fs.writeFileSync(out, json, 'utf-8');
            logger.info('CTRF written', { path: out, tests: report.results.summary.tests });
            return {
                ok: true,
                verb: input.verb,
                writtenPath: out,
                sizeBytes: Buffer.byteLength(json, 'utf-8'),
                summary: report.results.summary as unknown as Record<string, unknown>,
                validation,
                note: `CTRF ${report.results.summary.tests} test(s) → ${out}`,
            };
        }

        // from-ado-run
        const resolved = getResolvedCreds(ctx.workspaceRoot, { orgUrl: input.orgUrl, project: input.project });
        if (!resolved.creds) {
            return { ok: false, verb: input.verb, note: resolved.diagnostic };
        }
        try {
            const { run, results } = await fetchAdoRunResults(resolved.creds, input.runId);
            const report = normalizeFromAdoRun(run, results, toolVersion);
            const validation = validateCtrf(report);
            if (!validation.ok) {
                return { ok: false, verb: input.verb, validation, note: `CTRF validation failed: ${validation.errors.slice(0, 3).join('; ')}` };
            }
            const out = resolveOutputPath(input.outputPath);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            const json = JSON.stringify(report, null, 2);
            fs.writeFileSync(out, json, 'utf-8');
            logger.info('CTRF written from ADO run', { path: out, runId: input.runId, tests: report.results.summary.tests });
            return {
                ok: true,
                verb: input.verb,
                writtenPath: out,
                sizeBytes: Buffer.byteLength(json, 'utf-8'),
                summary: report.results.summary as unknown as Record<string, unknown>,
                validation,
                note: `ADO run ${input.runId}: ${report.results.summary.tests} result(s) → ${out}`,
            };
        } catch (e) {
            logger.error('ADO run export failed', { error: (e as Error).message, runId: input.runId });
            return { ok: false, verb: input.verb, note: `Failed to export ADO run ${input.runId}: ${(e as Error).message}` };
        }
    },
});

// Exports for smoke tests.
export const _ctrfInternalsForTests = { mapStatus, normalizeFromReportData, normalizeFromAdoRun, validateCtrf };
