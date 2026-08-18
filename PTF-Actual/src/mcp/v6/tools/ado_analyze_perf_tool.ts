/**
 * cs_qa_analyze_perf — parse a k6 (or generic percentile) perf-summary JSON,
 * compare against SLA thresholds, and optionally:
 *   - post an HTML verdict as a PR comment
 *   - open an ADO bug when regressions exceed the configured percent-slower
 *     threshold vs. a baseline run
 *
 * Regression severity mapping (deliberate — encoded in requirements):
 *   >50% slower vs baseline → Sev 1 (Critical)
 *   20-50% slower           → Sev 2 (High)
 *   10-20% slower           → Sev 3 (Medium)
 *   <10% slower             → informational, no bug
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';

const SlaSchema = z.object({
    p50MaxMs: z.number().positive().optional(),
    p95MaxMs: z.number().positive().optional(),
    p99MaxMs: z.number().positive().optional(),
    errorRateMaxPercent: z.number().min(0).max(100).optional(),
    throughputMinPerSecond: z.number().positive().optional(),
});

interface Stats {
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    errorRatePercent: number | null;
    throughputPerSecond: number | null;
    totalRequests: number | null;
}

/**
 * Parse k6 summary format. k6 --summary-export writes:
 *   { "metrics": {
 *       "http_req_duration": { "values": { "p(50)":..., "p(95)":..., "p(99)":..., "avg":..., "min":..., "max":... }, "type": "trend" },
 *       "http_req_failed":   { "values": { "rate":..., "passes":..., "fails":... }, "type": "rate" },
 *       "http_reqs":         { "values": { "count":..., "rate":... } },
 *       ...
 *   } }
 * Falls back to generic { p50, p95, p99, errorRate, throughput } shape.
 */
function parseStats(raw: Record<string, unknown>): Stats {
    const s: Stats = {
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
        errorRatePercent: null,
        throughputPerSecond: null,
        totalRequests: null,
    };
    const metrics = (raw.metrics as Record<string, { values?: Record<string, number>; type?: string }>) || null;
    if (metrics) {
        const dur = metrics.http_req_duration?.values || null;
        if (dur) {
            if (typeof dur['p(50)'] === 'number') s.p50Ms = dur['p(50)'];
            if (typeof dur['p(95)'] === 'number') s.p95Ms = dur['p(95)'];
            if (typeof dur['p(99)'] === 'number') s.p99Ms = dur['p(99)'];
        }
        const failed = metrics.http_req_failed?.values || null;
        if (failed && typeof failed.rate === 'number') s.errorRatePercent = failed.rate * 100;
        const reqs = metrics.http_reqs?.values || null;
        if (reqs) {
            if (typeof reqs.rate === 'number') s.throughputPerSecond = reqs.rate;
            if (typeof reqs.count === 'number') s.totalRequests = reqs.count;
        }
    }
    // Generic fallback for aggregators that emit a flat shape at the root.
    if (s.p50Ms === null && typeof raw.p50 === 'number') s.p50Ms = raw.p50 as number;
    if (s.p95Ms === null && typeof raw.p95 === 'number') s.p95Ms = raw.p95 as number;
    if (s.p99Ms === null && typeof raw.p99 === 'number') s.p99Ms = raw.p99 as number;
    if (s.errorRatePercent === null && typeof raw.errorRate === 'number') s.errorRatePercent = raw.errorRate as number;
    if (s.throughputPerSecond === null && typeof raw.throughput === 'number') s.throughputPerSecond = raw.throughput as number;
    return s;
}

interface SlaVerdict {
    metric: string;
    threshold: string;
    actual: string;
    pass: boolean;
}

function evaluateSlas(stats: Stats, sla?: z.infer<typeof SlaSchema>): SlaVerdict[] {
    const out: SlaVerdict[] = [];
    if (!sla) return out;
    if (sla.p50MaxMs !== undefined) out.push({
        metric: 'p50', threshold: `< ${sla.p50MaxMs}ms`,
        actual: stats.p50Ms === null ? 'n/a' : `${stats.p50Ms.toFixed(1)}ms`,
        pass: stats.p50Ms !== null && stats.p50Ms < sla.p50MaxMs,
    });
    if (sla.p95MaxMs !== undefined) out.push({
        metric: 'p95', threshold: `< ${sla.p95MaxMs}ms`,
        actual: stats.p95Ms === null ? 'n/a' : `${stats.p95Ms.toFixed(1)}ms`,
        pass: stats.p95Ms !== null && stats.p95Ms < sla.p95MaxMs,
    });
    if (sla.p99MaxMs !== undefined) out.push({
        metric: 'p99', threshold: `< ${sla.p99MaxMs}ms`,
        actual: stats.p99Ms === null ? 'n/a' : `${stats.p99Ms.toFixed(1)}ms`,
        pass: stats.p99Ms !== null && stats.p99Ms < sla.p99MaxMs,
    });
    if (sla.errorRateMaxPercent !== undefined) out.push({
        metric: 'error rate', threshold: `< ${sla.errorRateMaxPercent}%`,
        actual: stats.errorRatePercent === null ? 'n/a' : `${stats.errorRatePercent.toFixed(2)}%`,
        pass: stats.errorRatePercent !== null && stats.errorRatePercent < sla.errorRateMaxPercent,
    });
    if (sla.throughputMinPerSecond !== undefined) out.push({
        metric: 'throughput', threshold: `> ${sla.throughputMinPerSecond} req/s`,
        actual: stats.throughputPerSecond === null ? 'n/a' : `${stats.throughputPerSecond.toFixed(2)} req/s`,
        pass: stats.throughputPerSecond !== null && stats.throughputPerSecond > sla.throughputMinPerSecond,
    });
    return out;
}

interface RegressionRow {
    metric: string;
    baseline: number;
    current: number;
    deltaPercent: number;
    severity: '1 - Critical' | '2 - High' | '3 - Medium' | 'info';
}

function computeRegressions(current: Stats, baseline: Stats, thresholdPct: number): RegressionRow[] {
    const out: RegressionRow[] = [];
    const check = (label: string, cur: number | null, base: number | null): void => {
        if (cur === null || base === null || base === 0) return;
        const delta = ((cur - base) / base) * 100;
        if (delta < thresholdPct) return;
        let severity: RegressionRow['severity'] = 'info';
        if (delta > 50) severity = '1 - Critical';
        else if (delta >= 20) severity = '2 - High';
        else if (delta >= 10) severity = '3 - Medium';
        out.push({ metric: label, baseline: base, current: cur, deltaPercent: delta, severity });
    };
    check('p50', current.p50Ms, baseline.p50Ms);
    check('p95', current.p95Ms, baseline.p95Ms);
    check('p99', current.p99Ms, baseline.p99Ms);
    // Error rate: increase is bad.
    if (current.errorRatePercent !== null && baseline.errorRatePercent !== null && baseline.errorRatePercent > 0) {
        const delta = ((current.errorRatePercent - baseline.errorRatePercent) / baseline.errorRatePercent) * 100;
        if (delta >= thresholdPct) {
            let severity: RegressionRow['severity'] = 'info';
            if (delta > 50) severity = '1 - Critical';
            else if (delta >= 20) severity = '2 - High';
            else if (delta >= 10) severity = '3 - Medium';
            out.push({ metric: 'error rate', baseline: baseline.errorRatePercent, current: current.errorRatePercent, deltaPercent: delta, severity });
        }
    }
    // Throughput: decrease is bad.
    if (current.throughputPerSecond !== null && baseline.throughputPerSecond !== null && baseline.throughputPerSecond > 0) {
        const delta = ((baseline.throughputPerSecond - current.throughputPerSecond) / baseline.throughputPerSecond) * 100;
        if (delta >= thresholdPct) {
            let severity: RegressionRow['severity'] = 'info';
            if (delta > 50) severity = '1 - Critical';
            else if (delta >= 20) severity = '2 - High';
            else if (delta >= 10) severity = '3 - Medium';
            out.push({ metric: 'throughput', baseline: baseline.throughputPerSecond, current: current.throughputPerSecond, deltaPercent: delta, severity });
        }
    }
    return out;
}

function composeHtmlReport(stats: Stats, sla: SlaVerdict[], regressions: RegressionRow[]): string {
    const slaRows = sla.map((v) => `<tr><td>${v.metric}</td><td>${v.threshold}</td><td>${v.actual}</td><td>${v.pass ? 'PASS' : 'FAIL'}</td></tr>`).join('');
    const regRows = regressions.map((r) => `<tr><td>${r.metric}</td><td>${r.baseline.toFixed(2)}</td><td>${r.current.toFixed(2)}</td><td>${r.deltaPercent.toFixed(1)}%</td><td>${r.severity}</td></tr>`).join('');
    return `<div>
<h2>Performance verdict</h2>
<h3>Current metrics</h3>
<ul>
<li>p50: ${stats.p50Ms === null ? 'n/a' : stats.p50Ms.toFixed(1) + 'ms'}</li>
<li>p95: ${stats.p95Ms === null ? 'n/a' : stats.p95Ms.toFixed(1) + 'ms'}</li>
<li>p99: ${stats.p99Ms === null ? 'n/a' : stats.p99Ms.toFixed(1) + 'ms'}</li>
<li>error rate: ${stats.errorRatePercent === null ? 'n/a' : stats.errorRatePercent.toFixed(2) + '%'}</li>
<li>throughput: ${stats.throughputPerSecond === null ? 'n/a' : stats.throughputPerSecond.toFixed(2) + ' req/s'}</li>
<li>total requests: ${stats.totalRequests === null ? 'n/a' : stats.totalRequests}</li>
</ul>
${sla.length > 0 ? `<h3>SLA verdict</h3><table><thead><tr><th>Metric</th><th>Threshold</th><th>Actual</th><th>Verdict</th></tr></thead><tbody>${slaRows}</tbody></table>` : ''}
${regressions.length > 0 ? `<h3>Regressions vs baseline</h3><table><thead><tr><th>Metric</th><th>Baseline</th><th>Current</th><th>Delta</th><th>Severity</th></tr></thead><tbody>${regRows}</tbody></table>` : ''}
</div>`;
}

registerPrimitive({
    name: 'cs_qa_analyze_perf',
    description: 'Parse a k6 perf-summary.json (or generic percentile JSON), evaluate against SLA thresholds, and optionally compare vs a baseline for regressions. Can post the verdict as a PR comment and open an ADO bug on regressions (severity mapped: >50%=Sev1, 20-50%=Sev2, 10-20%=Sev3). Bug creation is gated by two-phase confirmation (call once without `confirmed`, get preview, retry with `confirmed:true`).',
    inputSchema: z.object({
        resultPath: z.string().min(1),
        slaThresholds: SlaSchema.optional(),
        baselineResultPath: z.string().optional(),
        regressionThresholdPercent: z.number().min(0).max(1000).default(10),
        createBugOnFailure: z.boolean().default(false),
        linkToPrId: z.number().int().positive().optional(),
        repositoryId: z.string().optional(),
        dryRun: z.boolean().default(false),
        orgUrl: z.string().url().optional(),
        project: z.string().min(1).optional(),
        pat: z.string().min(1).optional(),
    }),
    outputSchema: z.object({
        ok: z.boolean(),
        verdict: z.enum(['pass', 'fail', 'no-sla']).optional(),
        stats: z.record(z.string(), z.union([z.number(), z.null()])).optional(),
        slaVerdicts: z.array(z.object({ metric: z.string(), threshold: z.string(), actual: z.string(), pass: z.boolean() })).default([]),
        regressions: z.array(z.object({ metric: z.string(), baseline: z.number(), current: z.number(), deltaPercent: z.number(), severity: z.string() })).default([]),
        bugId: z.number().optional(),
        prCommentPosted: z.boolean().default(false),
        warnings: z.array(z.string()).default([]),
        note: z.string().optional(),
        requiresConfirmation: z.boolean().optional(),
        destructive: z.boolean().optional(),
        confirmationHint: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_analyze_perf', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        const resolved = path.isAbsolute(input.resultPath) ? input.resultPath : path.join(ctx.workspaceRoot, input.resultPath);
        if (!fs.existsSync(resolved)) return { ok: false, slaVerdicts: [], regressions: [], prCommentPosted: false, warnings, note: `Result file not found: ${resolved}` };
        let currentRaw: Record<string, unknown>;
        try { currentRaw = JSON.parse(fs.readFileSync(resolved, 'utf-8')); }
        catch (e) { return { ok: false, slaVerdicts: [], regressions: [], prCommentPosted: false, warnings, note: `Failed to parse result JSON: ${(e as Error).message}` }; }
        const stats = parseStats(currentRaw);

        const slaVerdicts = evaluateSlas(stats, input.slaThresholds);
        const slaFailed = slaVerdicts.some((v) => !v.pass);
        const verdict: 'pass' | 'fail' | 'no-sla' = slaVerdicts.length === 0 ? 'no-sla' : slaFailed ? 'fail' : 'pass';

        let regressions: RegressionRow[] = [];
        if (input.baselineResultPath) {
            const baselineResolved = path.isAbsolute(input.baselineResultPath) ? input.baselineResultPath : path.join(ctx.workspaceRoot, input.baselineResultPath);
            if (!fs.existsSync(baselineResolved)) warnings.push(`Baseline file not found: ${baselineResolved}`);
            else {
                try {
                    const baselineRaw = JSON.parse(fs.readFileSync(baselineResolved, 'utf-8')) as Record<string, unknown>;
                    const baselineStats = parseStats(baselineRaw);
                    regressions = computeRegressions(stats, baselineStats, input.regressionThresholdPercent);
                } catch (e) {
                    warnings.push(`Baseline parse failed: ${(e as Error).message}`);
                }
            }
        }
        log.info('analysis complete', { verdict, regressions: regressions.length });

        const statsRecord: Record<string, number | null> = {
            p50Ms: stats.p50Ms, p95Ms: stats.p95Ms, p99Ms: stats.p99Ms,
            errorRatePercent: stats.errorRatePercent, throughputPerSecond: stats.throughputPerSecond,
            totalRequests: stats.totalRequests,
        };

        if (input.dryRun) {
            return {
                ok: true, verdict, stats: statsRecord,
                slaVerdicts, regressions,
                prCommentPosted: false, warnings,
                note: `Dry-run — verdict=${verdict}, regressions=${regressions.length}. Would ${input.createBugOnFailure && (slaFailed || regressions.some((r) => r.severity !== 'info')) ? 'open a bug' : 'skip bug creation'}${input.linkToPrId ? ` and post PR comment on #${input.linkToPrId}` : ''}.`,
            };
        }

        let bugId: number | undefined;
        let prCommentPosted = false;

        if (input.linkToPrId || (input.createBugOnFailure && (slaFailed || regressions.some((r) => r.severity !== 'info')))) {
            const credsRes = getResolvedCreds(ctx.workspaceRoot, {
                orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat,
            });
            if (!credsRes.creds) {
                warnings.push(credsRes.diagnostic);
                return { ok: true, verdict, stats: statsRecord, slaVerdicts, regressions, prCommentPosted: false, warnings, note: 'Analysis complete; ADO write skipped (creds missing).' };
            }
            const cfg: AdoCreds = credsRes.creds;
            const client = new AdoHttpClient(cfg);
            const htmlReport = composeHtmlReport(stats, slaVerdicts, regressions);

            if (input.linkToPrId && input.repositoryId) {
                try {
                    await client.post(`_apis/git/repositories/${input.repositoryId}/pullrequests/${input.linkToPrId}/threads?api-version=7.0`, {
                        comments: [{ content: htmlReport, commentType: 'text' }],
                        status: 'active',
                    });
                    prCommentPosted = true;
                } catch (e) {
                    warnings.push(`PR comment post failed: ${(e as Error).message}`);
                }
            } else if (input.linkToPrId && !input.repositoryId) {
                warnings.push('linkToPrId set but repositoryId missing — PR comment skipped.');
            }

            if (input.createBugOnFailure && (slaFailed || regressions.some((r) => r.severity !== 'info'))) {
                const topSeverity = regressions.reduce<'1 - Critical' | '2 - High' | '3 - Medium' | '4 - Low'>((acc, r) => {
                    if (r.severity === 'info') return acc;
                    const sevMap: Record<string, number> = { '1 - Critical': 1, '2 - High': 2, '3 - Medium': 3, '4 - Low': 4 };
                    return sevMap[r.severity] < sevMap[acc] ? (r.severity as typeof acc) : acc;
                }, slaFailed ? '2 - High' : '3 - Medium');
                if ((input as { confirmed?: boolean }).confirmed !== true) {
                    return {
                        ok: true, verdict, stats: statsRecord,
                        slaVerdicts, regressions,
                        prCommentPosted, warnings,
                        requiresConfirmation: true,
                        destructive: true,
                        confirmationHint: `Open ADO bug (Sev ${topSeverity}) for perf regression in ${cfg.project}? No write performed. Retry the SAME call with confirmed:true (added at the top level).`,
                        note: 'requires confirmation — retry with confirmed:true',
                    } as never;
                }
                const patch: Array<Record<string, unknown>> = [
                    { op: 'add', path: '/fields/System.Title', value: `Perf regression: ${regressions[0]?.metric || 'SLA failure'} — ${topSeverity}` },
                    { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: htmlReport },
                    { op: 'add', path: '/fields/Microsoft.VSTS.Common.Severity', value: topSeverity },
                    { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: topSeverity === '1 - Critical' ? 1 : topSeverity === '2 - High' ? 2 : 3 },
                    { op: 'add', path: '/fields/System.Tags', value: 'performance; regression' },
                ];
                try {
                    const created = await client.post<{ id?: number }>(`_apis/wit/workitems/$Bug?api-version=7.0`, patch);
                    bugId = Number(created.id || 0);
                } catch (e) {
                    warnings.push(`Bug creation failed: ${(e as Error).message}`);
                }
            }
        }

        return {
            ok: true, verdict, stats: statsRecord,
            slaVerdicts, regressions,
            bugId, prCommentPosted, warnings,
            note: `verdict=${verdict}; SLA fails=${slaVerdicts.filter((v) => !v.pass).length}; regressions=${regressions.length}${bugId ? `; bug #${bugId} created` : ''}${prCommentPosted ? '; PR comment posted' : ''}.`,
        };
    },
});
