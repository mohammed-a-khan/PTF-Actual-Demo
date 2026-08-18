/**
 * cs_qa_flaky_signature_cluster — Cluster failures across N test runs by
 * normalized signature, then classify each cluster as retry-worthy (likely
 * flaky) vs deterministic-bug (fails every time).
 *
 * Input: paths[] pointing to `report-data.json` files. For each failing step
 * we extract:
 *   errorClass + top stack frame (path-stripped, line-stripped, number-masked)
 *     + selector (from step context) + normalized message
 * SHA-1 the canonical form → fingerprint. Cluster by fingerprint.
 *
 * Alternation-ratio heuristic:
 *   flakinessScore = 1 - (max(pass, fail) / totalRuns_of_test)
 * When testId of a cluster passes sometimes and fails other times, flakiness is
 * high — worth retrying. When it always fails, it's a real bug.
 *
 * Optional: file ONE ADO bug per cluster meeting minOccurrences (tag: flaky).
 * Delegates to cs_qa_ado_write:create-bug via a direct HTTP POST (uses
 * AdoHttpClient — never fetch directly). Deduplication: skips if an open bug
 * with tag `flaky-<fingerprint12>` already exists.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { wiql } from './_helpers/wiql_builder';
import { bulkExecute } from './_helpers/bulk_batcher';
import { createLogger } from './_helpers/structured_logger';
import { normalizeSignature, type RawFailure } from './_helpers/signature_normalizer';
import { getResolvedCreds } from './ado_config_tool';

interface ReportScenarioStep {
    keyword?: string;
    text?: string;
    status?: string;
    error?: string;
    errorMessage?: string;
    errorClass?: string;
    stack?: string;
    selector?: string;
}

interface ReportScenario {
    name?: string;
    id?: string;
    status?: string;
    tags?: unknown;
    steps?: ReportScenarioStep[];
    error?: string;
    stack?: string;
    errorClass?: string;
    selector?: string;
}

interface ReportSuite {
    totalScenarios?: number;
    passedScenarios?: number;
    failedScenarios?: number;
    scenarios?: ReportScenario[];
}

interface ReportData {
    suite?: ReportSuite;
    startedAt?: string;
    finishedAt?: string;
    runId?: string;
    // permissive
    [k: string]: unknown;
}

interface FailureRecord extends RawFailure {
    reportPath: string;
    scenarioName: string;
    scenarioId?: string;
}

interface ClusterState {
    fingerprint: string;
    canonical: string;
    errorClass: string;
    topFrame: string;
    selector?: string;
    rawMessage?: string;
    occurrences: number;
    /** Per-testId pass/fail counts across runs. Populated from all runs (including passes). */
    perTest: Map<string, { pass: number; fail: number }>;
    affectedTestIds: string[];
    firstSeen?: string;
    lastSeen?: string;
    reportPaths: string[];
}

function safeReadJson<T>(pathAbs: string): T | null {
    if (!fs.existsSync(pathAbs)) return null;
    try { return JSON.parse(fs.readFileSync(pathAbs, 'utf-8')) as T; }
    catch { return null; }
}

function extractFailures(report: ReportData, reportPath: string): FailureRecord[] {
    const out: FailureRecord[] = [];
    const scenarios = report.suite?.scenarios || [];
    for (const s of scenarios) {
        if ((s.status || '').toLowerCase() === 'passed') continue;
        // Find the first failing step, else the scenario-level error.
        const failingStep = (s.steps || []).find((st) => (st.status || '').toLowerCase() === 'failed');
        const errClass = failingStep?.errorClass || s.errorClass || guessClass(failingStep?.error || s.error || '');
        const message = failingStep?.errorMessage || failingStep?.error || s.error || '';
        const stack = failingStep?.stack || s.stack || (failingStep?.error && failingStep.error.includes('\n') ? failingStep.error : '') || '';
        const selector = failingStep?.selector || s.selector || extractSelectorFromText(message);
        out.push({
            reportPath,
            scenarioName: s.name || '(unnamed)',
            scenarioId: s.id,
            errorClass: errClass,
            message,
            stack,
            selector,
            testId: s.id || s.name,
            ts: report.finishedAt || report.startedAt,
        });
    }
    return out;
}

function guessClass(msg: string): string {
    const m = msg.match(/^([A-Z][A-Za-z]*Error|[A-Z][A-Za-z]*Failure):/);
    if (m) return m[1];
    if (/timed?\s*out/i.test(msg)) return 'TimeoutError';
    if (/element.*not\s*found|no\s*element.*match|locator.*not.*visible/i.test(msg)) return 'ElementNotFoundError';
    if (/expected.*to.*(?:equal|contain|match|be)/i.test(msg)) return 'AssertionError';
    return 'Error';
}

function extractSelectorFromText(msg: string): string | undefined {
    if (!msg) return undefined;
    // Attempt common playwright / locator patterns first.
    const patterns: RegExp[] = [
        /waiting for (?:selector|locator)\s+["']([^"']+)["']/i,
        /locator\(["']([^"']+)["']\)/,
        /getByRole\(([^)]+)\)/,
        /getBy\w+\(["']([^"']+)["']\)/,
        /xpath=([^\s,'"]+)/i,
        /css=([^\s,'"]+)/i,
    ];
    for (const re of patterns) {
        const m = msg.match(re);
        if (m) return m[1];
    }
    return undefined;
}

function extractScenarioPassSummary(report: ReportData): { passedIds: string[]; failedIds: string[] } {
    const passedIds: string[] = [];
    const failedIds: string[] = [];
    for (const s of report.suite?.scenarios || []) {
        const id = s.id || s.name || '';
        if (!id) continue;
        if ((s.status || '').toLowerCase() === 'passed') passedIds.push(id);
        else failedIds.push(id);
    }
    return { passedIds, failedIds };
}

async function findExistingFlakyBug(client: AdoHttpClient, tagFingerprint: string): Promise<number | null> {
    const q = wiql()
        .select(['[System.Id]'])
        .from('WorkItems')
        .where()
        .equals('[System.WorkItemType]', 'Bug')
        .and().tag(tagFingerprint)
        .and().notEquals('[System.State]', 'Closed')
        .done()
        .build();
    try {
        const res = await client.post<{ workItems?: Array<{ id: number }> }>(`_apis/wit/wiql?api-version=7.1`, { query: q });
        const first = (res.workItems || [])[0];
        return first ? first.id : null;
    } catch {
        return null;
    }
}

async function createFlakyBug(client: AdoHttpClient, cluster: ClusterState, tagFingerprint: string): Promise<number | null> {
    const escaped = (s: string): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `<pre>Flaky signature cluster
Fingerprint: ${cluster.fingerprint}
Error class: ${escaped(cluster.errorClass)}
Top frame:   ${escaped(cluster.topFrame)}
${cluster.selector ? `Selector:    ${escaped(cluster.selector)}\n` : ''}Message:     ${escaped(cluster.rawMessage || '(empty)')}

Occurrences: ${cluster.occurrences}
Affected tests (${cluster.affectedTestIds.length}):
${cluster.affectedTestIds.slice(0, 20).map((t) => '  - ' + escaped(t)).join('\n')}
First seen: ${cluster.firstSeen || '(unknown)'}
Last seen:  ${cluster.lastSeen || '(unknown)'}
</pre>`;
    const patch: Array<Record<string, unknown>> = [
        { op: 'add', path: '/fields/System.Title', value: `Flaky cluster: ${cluster.errorClass} — ${cluster.topFrame.slice(0, 80)}` },
        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: html },
        { op: 'add', path: '/fields/Microsoft.VSTS.Common.Severity', value: '3 - Medium' },
        { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: 3 },
        { op: 'add', path: '/fields/System.Tags', value: `flaky; ${tagFingerprint}` },
    ];
    try {
        const created = await client.post<{ id?: number }>(`_apis/wit/workitems/$Bug?api-version=7.0`, patch);
        return Number(created?.id || 0) || null;
    } catch {
        return null;
    }
}

registerPrimitive({
    name: 'cs_qa_flaky_signature_cluster',
    description: 'Cluster failures across N test runs by normalized failure signature (errorClass + top stack frame + selector + normalized message → SHA-1). Flakiness score derived from alternation ratio (pass sometimes / fail other times = high flakiness; always fail = deterministic bug). Consumes report-data.json paths; optionally files ONE ADO bug per cluster meeting minOccurrences, dedupe against existing bugs by fingerprint tag. Example: cs_qa_flaky_signature_cluster paths:["reports/run-1/reports/report-data.json","reports/run-2/reports/report-data.json"] minOccurrences:3 fileBugs:true.',
    inputSchema: z.object({
        paths: z.array(z.string().min(1)).min(1).describe('One or more report-data.json paths (absolute or relative to workspace).'),
        minOccurrences: z.number().int().min(1).default(3),
        fileBugs: z.boolean().default(false),
        orgUrl: z.string().url().optional(),
        project: z.string().min(1).optional(),
        pat: z.string().min(1).optional(),
    }),
    outputSchema: z.object({
        ok: z.boolean(),
        totalReports: z.number(),
        totalFailures: z.number(),
        clusters: z.array(z.object({
            fingerprint: z.string(),
            canonical: z.string(),
            errorClass: z.string(),
            topFrame: z.string(),
            selector: z.string().optional(),
            rawMessage: z.string().optional(),
            occurrences: z.number(),
            affectedTestIds: z.array(z.string()),
            flakinessScore: z.number(),
            failureRatePercent: z.number(),
            suggestedCause: z.enum(['retry-worthy-flake', 'deterministic-bug', 'insufficient-data']),
            firstSeen: z.string().optional(),
            lastSeen: z.string().optional(),
            reportPaths: z.array(z.string()),
        })).default([]),
        bugsFiled: z.array(z.object({ fingerprint: z.string(), bugId: z.number() })).default([]),
        bugsSkippedExisting: z.array(z.object({ fingerprint: z.string(), bugId: z.number() })).default([]),
        warnings: z.array(z.string()).default([]),
        note: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_flaky_signature_cluster', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        const allFailures: FailureRecord[] = [];
        const perTestCounts = new Map<string, { pass: number; fail: number }>();

        let readCount = 0;
        for (const p of input.paths) {
            const abs = path.isAbsolute(p) ? p : path.join(ctx.workspaceRoot, p);
            const data = safeReadJson<ReportData>(abs);
            if (!data) { warnings.push(`could not read ${abs}`); continue; }
            readCount++;
            const { passedIds, failedIds } = extractScenarioPassSummary(data);
            for (const id of passedIds) {
                const c = perTestCounts.get(id) || { pass: 0, fail: 0 };
                c.pass++;
                perTestCounts.set(id, c);
            }
            for (const id of failedIds) {
                const c = perTestCounts.get(id) || { pass: 0, fail: 0 };
                c.fail++;
                perTestCounts.set(id, c);
            }
            for (const f of extractFailures(data, abs)) allFailures.push(f);
        }

        const clusters = new Map<string, ClusterState>();
        for (const f of allFailures) {
            const sig = normalizeSignature(f);
            const existing = clusters.get(sig.fingerprint);
            if (existing) {
                existing.occurrences++;
                if (f.testId && !existing.affectedTestIds.includes(f.testId)) existing.affectedTestIds.push(f.testId);
                if (!existing.reportPaths.includes(f.reportPath)) existing.reportPaths.push(f.reportPath);
                if (f.ts) {
                    if (!existing.firstSeen || f.ts < existing.firstSeen) existing.firstSeen = f.ts;
                    if (!existing.lastSeen || f.ts > existing.lastSeen) existing.lastSeen = f.ts;
                }
            } else {
                clusters.set(sig.fingerprint, {
                    fingerprint: sig.fingerprint,
                    canonical: sig.canonical,
                    errorClass: sig.parts.errorClass,
                    topFrame: sig.parts.topFrame,
                    selector: sig.parts.selector,
                    rawMessage: sig.parts.rawMessage,
                    occurrences: 1,
                    perTest: new Map(),
                    affectedTestIds: f.testId ? [f.testId] : [],
                    firstSeen: f.ts,
                    lastSeen: f.ts,
                    reportPaths: [f.reportPath],
                });
            }
        }

        // Compute flakinessScore + failure rate per cluster.
        const clusterOut = Array.from(clusters.values()).map((c) => {
            let totalRuns = 0, totalFails = 0, altSum = 0, altN = 0;
            for (const tid of c.affectedTestIds) {
                const counts = perTestCounts.get(tid);
                if (!counts) continue;
                const tRuns = counts.pass + counts.fail;
                totalRuns += tRuns;
                totalFails += counts.fail;
                if (tRuns > 0) {
                    altSum += 1 - Math.max(counts.pass, counts.fail) / tRuns;
                    altN++;
                }
            }
            const flakinessScore = altN === 0 ? 0 : altSum / altN;
            const failureRatePercent = totalRuns === 0 ? 0 : (totalFails / totalRuns) * 100;
            let suggestedCause: 'retry-worthy-flake' | 'deterministic-bug' | 'insufficient-data' = 'insufficient-data';
            if (totalRuns >= 2) {
                suggestedCause = flakinessScore >= 0.25 ? 'retry-worthy-flake' : 'deterministic-bug';
            }
            return {
                fingerprint: c.fingerprint,
                canonical: c.canonical,
                errorClass: c.errorClass,
                topFrame: c.topFrame,
                selector: c.selector,
                rawMessage: c.rawMessage,
                occurrences: c.occurrences,
                affectedTestIds: c.affectedTestIds,
                flakinessScore: Number(flakinessScore.toFixed(3)),
                failureRatePercent: Number(failureRatePercent.toFixed(2)),
                suggestedCause,
                firstSeen: c.firstSeen,
                lastSeen: c.lastSeen,
                reportPaths: c.reportPaths,
                _raw: c,
            };
        }).sort((a, b) => b.occurrences - a.occurrences);

        const bugsFiled: Array<{ fingerprint: string; bugId: number }> = [];
        const bugsSkippedExisting: Array<{ fingerprint: string; bugId: number }> = [];

        if (input.fileBugs) {
            const toFile = clusterOut.filter((c) => c.occurrences >= input.minOccurrences);
            if (toFile.length > 0) {
                const credsRes = getResolvedCreds(ctx.workspaceRoot, {
                    orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat,
                });
                if (!credsRes.creds) {
                    warnings.push(credsRes.diagnostic);
                } else {
                    const cfg: AdoCreds = credsRes.creds;
                    const client = new AdoHttpClient(cfg);
                    const results = await bulkExecute(toFile, {
                        chunkSize: 5,
                        concurrency: 2,
                        workFn: async (chunk) => {
                            const out: Array<{ fingerprint: string; bugId: number; skipped: boolean }> = [];
                            for (const c of chunk) {
                                const tag = `flaky-${c.fingerprint.slice(0, 12)}`;
                                const existing = await findExistingFlakyBug(client, tag);
                                if (existing) {
                                    out.push({ fingerprint: c.fingerprint, bugId: existing, skipped: true });
                                    continue;
                                }
                                const id = await createFlakyBug(client, c._raw, tag);
                                if (id) out.push({ fingerprint: c.fingerprint, bugId: id, skipped: false });
                            }
                            return out;
                        },
                        onChunkError: (err) => { warnings.push(`flaky-bug chunk error: ${err.message}`); },
                    });
                    for (const r of results.ok) {
                        if (r.skipped) bugsSkippedExisting.push({ fingerprint: r.fingerprint, bugId: r.bugId });
                        else bugsFiled.push({ fingerprint: r.fingerprint, bugId: r.bugId });
                    }
                }
            }
        }

        log.info('clustering complete', { totalFailures: allFailures.length, clusters: clusterOut.length });

        // Strip _raw before returning (schema doesn't allow it).
        const clean = clusterOut.map(({ _raw: _r, ...rest }) => rest);

        return {
            ok: true,
            totalReports: readCount,
            totalFailures: allFailures.length,
            clusters: clean,
            bugsFiled,
            bugsSkippedExisting,
            warnings,
            note: `Read ${readCount}/${input.paths.length} reports; ${allFailures.length} failures collapsed into ${clean.length} clusters. Bugs filed: ${bugsFiled.length}; skipped existing: ${bugsSkippedExisting.length}.`,
        };
    },
});
