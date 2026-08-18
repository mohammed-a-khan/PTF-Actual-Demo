/**
 * cs_qa_dashboard_push — Push metrics + widget content to a dashboard.
 *
 * Two modes:
 *   1. ADO dashboard:
 *        GET  /_apis/wit/widgets/{id}?dashboardId=… (verify widget exists,
 *              capture existing settings/etag)
 *        PATCH /_apis/wit/widgets/{id}?dashboardId=… (Markdown widget contents
 *              live in `settings` as JSON-encoded string)
 *      NOTE: the WIT widgets endpoint is scoped to project + team. When teamId
 *      is provided we route through /{project}/{teamId}/_apis/... ; otherwise
 *      the default team is inferred by ADO from the project.
 *   2. Generic webhook: POST JSON to `webhookUrl` — non-ADO, uses global fetch.
 *
 * Payload example (composed by callers or auto-built here from DORA metrics):
 *   { title, dora, releaseGate, flakyClusters, a11yTrend }
 *
 * On-prem safe. No cloud host is hardcoded here — the orgUrl comes from
 * whatever getResolvedCreds returned (which may be an on-prem TFS install).
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { wiql } from './_helpers/wiql_builder';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';

const DashboardPayloadSchema = z.object({
    title: z.string().default('QA Signals'),
    dora: z.object({
        deploymentFrequencyPerDay: z.number().optional(),
        leadTimeMedianHours: z.number().optional(),
        changeFailureRatePercent: z.number().optional(),
        mttrMedianHours: z.number().optional(),
        windowDays: z.number().optional(),
    }).partial().optional(),
    releaseGate: z.object({
        verdict: z.enum(['proceed', 'warn', 'block']).optional(),
        overallScore: z.number().optional(),
        recentHistory: z.array(z.object({ ts: z.string(), verdict: z.string() })).optional(),
    }).partial().optional(),
    flakyClusters: z.object({
        totalClusters: z.number().optional(),
        totalFailures: z.number().optional(),
        top: z.array(z.object({ fingerprint: z.string(), occurrences: z.number(), errorClass: z.string() })).optional(),
    }).partial().optional(),
    a11yTrend: z.object({
        distinctIssues: z.number().optional(),
        levelBreakdown: z.record(z.string(), z.number()).optional(),
        newSinceLastRun: z.number().optional(),
    }).partial().optional(),
    extras: z.record(z.string(), z.any()).optional(),
});

type DashboardPayload = z.infer<typeof DashboardPayloadSchema>;

function renderMarkdown(p: DashboardPayload): string {
    const lines: string[] = [];
    lines.push(`# ${p.title || 'QA Signals'}`);
    lines.push(`*Updated: ${new Date().toISOString()}*`);
    lines.push('');
    if (p.dora) {
        lines.push('## DORA metrics');
        if (p.dora.windowDays) lines.push(`- Window: ${p.dora.windowDays} days`);
        if (p.dora.deploymentFrequencyPerDay !== undefined) lines.push(`- **Deployment frequency:** ${p.dora.deploymentFrequencyPerDay.toFixed(2)} / day`);
        if (p.dora.leadTimeMedianHours !== undefined) lines.push(`- **Lead time (median):** ${p.dora.leadTimeMedianHours.toFixed(1)} h`);
        if (p.dora.changeFailureRatePercent !== undefined) lines.push(`- **Change failure rate:** ${p.dora.changeFailureRatePercent.toFixed(1)}%`);
        if (p.dora.mttrMedianHours !== undefined) lines.push(`- **MTTR (median):** ${p.dora.mttrMedianHours.toFixed(1)} h`);
        lines.push('');
    }
    if (p.releaseGate) {
        lines.push('## Release gate');
        if (p.releaseGate.verdict) lines.push(`- Verdict: **${p.releaseGate.verdict}**`);
        if (p.releaseGate.overallScore !== undefined) lines.push(`- Score: **${p.releaseGate.overallScore}/100**`);
        if (p.releaseGate.recentHistory && p.releaseGate.recentHistory.length > 0) {
            lines.push('- Recent:');
            for (const h of p.releaseGate.recentHistory.slice(0, 10)) lines.push(`  - ${h.ts} → ${h.verdict}`);
        }
        lines.push('');
    }
    if (p.flakyClusters) {
        lines.push('## Flaky clusters');
        if (p.flakyClusters.totalClusters !== undefined) lines.push(`- Clusters: ${p.flakyClusters.totalClusters}`);
        if (p.flakyClusters.totalFailures !== undefined) lines.push(`- Total failures collapsed: ${p.flakyClusters.totalFailures}`);
        if (p.flakyClusters.top && p.flakyClusters.top.length > 0) {
            lines.push('- Top:');
            for (const t of p.flakyClusters.top.slice(0, 5)) lines.push(`  - \`${t.fingerprint.slice(0, 8)}\` ${t.errorClass} × ${t.occurrences}`);
        }
        lines.push('');
    }
    if (p.a11yTrend) {
        lines.push('## Accessibility');
        if (p.a11yTrend.distinctIssues !== undefined) lines.push(`- Distinct issues: ${p.a11yTrend.distinctIssues}`);
        if (p.a11yTrend.levelBreakdown) {
            const lb = p.a11yTrend.levelBreakdown;
            lines.push(`- Breakdown: A ${lb.A ?? 0} | AA ${lb.AA ?? 0} | AAA ${lb.AAA ?? 0} | best-practice ${lb['best-practice'] ?? 0}`);
        }
        if (p.a11yTrend.newSinceLastRun !== undefined) lines.push(`- New since last run: ${p.a11yTrend.newSinceLastRun}`);
        lines.push('');
    }
    return lines.join('\n');
}

// -----------------------------------------------------------------------------
// aggregate mode helpers.
// -----------------------------------------------------------------------------

interface AggregatePayload {
    coverage?: unknown;
    passRateTrend?: { runs: number; passRate: number | null; samples?: Array<{ ts: string; passRate: number }> };
    openBugs?: { total: number; bySeverity: Record<string, number> };
}

async function buildAggregate(
    workspaceRoot: string,
    opts: { orgUrl?: string; project?: string; pat?: string; iterationPath?: string; lastNRuns: number },
    warnings: string[],
): Promise<AggregatePayload> {
    const out: AggregatePayload = {};

    // Coverage rollup — load .cs-qa/source-model/coverage.json if present.
    const covPath = path.join(workspaceRoot, '.cs-qa', 'source-model', 'coverage.json');
    if (fs.existsSync(covPath)) {
        try { out.coverage = JSON.parse(fs.readFileSync(covPath, 'utf-8')); }
        catch (e) { warnings.push(`coverage.json parse failed: ${(e as Error).message}`); }
    }

    // Pass-rate trend — walk reports/test-results-*/reports/report-data.json.
    const reportsRoot = path.join(workspaceRoot, 'reports');
    if (fs.existsSync(reportsRoot)) {
        try {
            const runs = fs.readdirSync(reportsRoot, { withFileTypes: true })
                .filter((d) => d.isDirectory() && d.name.startsWith('test-results-'))
                .map((d) => {
                    const p = path.join(reportsRoot, d.name, 'reports', 'report-data.json');
                    if (!fs.existsSync(p)) return null;
                    let stat: fs.Stats;
                    try { stat = fs.statSync(p); } catch { return null; }
                    return { path: p, ts: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs };
                })
                .filter((x): x is { path: string; ts: string; mtimeMs: number } => !!x)
                .sort((a, b) => b.mtimeMs - a.mtimeMs)
                .slice(0, opts.lastNRuns);
            const samples: Array<{ ts: string; passRate: number }> = [];
            let totalTests = 0, totalPassed = 0;
            for (const r of runs) {
                try {
                    const j = JSON.parse(fs.readFileSync(r.path, 'utf-8')) as { total?: number; passed?: number; totalTests?: number; passedTests?: number; results?: { total?: number; passed?: number } };
                    const total = Number(j.total ?? j.totalTests ?? j.results?.total ?? 0);
                    const passed = Number(j.passed ?? j.passedTests ?? j.results?.passed ?? 0);
                    if (total > 0) {
                        totalTests += total; totalPassed += passed;
                        samples.push({ ts: r.ts, passRate: Number(((passed / total) * 100).toFixed(2)) });
                    }
                } catch (e) { warnings.push(`report-data.json parse failed at ${r.path}: ${(e as Error).message}`); }
            }
            out.passRateTrend = {
                runs: samples.length,
                passRate: totalTests > 0 ? Number(((totalPassed / totalTests) * 100).toFixed(2)) : null,
                samples,
            };
        } catch (e) { warnings.push(`reports scan failed: ${(e as Error).message}`); }
    }

    // Open bugs — WIQL count by severity for iteration.
    const credsRes = getResolvedCreds(workspaceRoot, { orgUrl: opts.orgUrl, project: opts.project, personalAccessToken: opts.pat });
    if (credsRes.creds) {
        try {
            const client = new AdoHttpClient(credsRes.creds);
            const q = wiql()
                .select(['[System.Id]', '[Microsoft.VSTS.Common.Severity]'])
                .from('WorkItems');
            const wb = q.where().equals('[System.WorkItemType]', 'Bug').and().notEquals('[System.State]', 'Closed');
            if (opts.iterationPath) wb.and().iteration(opts.iterationPath);
            const wiqlText = q.build();
            const res = await client.post<{ workItems?: Array<{ id: number }> }>(`_apis/wit/wiql?$top=500&api-version=7.1`, { query: wiqlText });
            const ids = (res.workItems || []).map((w) => w.id);
            const bySeverity: Record<string, number> = {};
            if (ids.length > 0) {
                for (let i = 0; i < ids.length; i += 200) {
                    const chunk = ids.slice(i, i + 200);
                    const wi = await client.get<{ value?: Array<{ fields?: Record<string, unknown> }> }>(
                        `_apis/wit/workitems?ids=${chunk.join(',')}&fields=Microsoft.VSTS.Common.Severity&api-version=7.0`,
                    );
                    for (const w of wi.value || []) {
                        const s = String(w.fields?.['Microsoft.VSTS.Common.Severity'] || '(unset)');
                        bySeverity[s] = (bySeverity[s] || 0) + 1;
                    }
                }
            }
            out.openBugs = { total: ids.length, bySeverity };
        } catch (e) { warnings.push(`open-bugs WIQL failed: ${(e as Error).message}`); }
    } else {
        warnings.push(`open-bugs: ADO creds unresolved (${credsRes.diagnostic}).`);
    }

    return out;
}

function renderAggregateMarkdown(agg: AggregatePayload): string {
    const lines: string[] = ['# Quality snapshot', ''];
    lines.push(`*Generated: ${new Date().toISOString()}*`);
    lines.push('');
    if (agg.coverage && typeof agg.coverage === 'object') {
        const c = agg.coverage as { endpoints?: { coveragePercent?: number }; screens?: { coveragePercent?: number }; entities?: { coveragePercent?: number }; validators?: { coveragePercent?: number } };
        lines.push('## Source coverage');
        lines.push('');
        lines.push('| Facet | % |');
        lines.push('|---|---|');
        if (c.endpoints?.coveragePercent !== undefined) lines.push(`| Endpoints | ${c.endpoints.coveragePercent}% |`);
        if (c.screens?.coveragePercent !== undefined) lines.push(`| Screens | ${c.screens.coveragePercent}% |`);
        if (c.entities?.coveragePercent !== undefined) lines.push(`| Entities | ${c.entities.coveragePercent}% |`);
        if (c.validators?.coveragePercent !== undefined) lines.push(`| Validators | ${c.validators.coveragePercent}% |`);
        lines.push('');
    } else {
        lines.push('_(coverage.json not present — run cs_qa_source_coverage to enable this section)_');
        lines.push('');
    }
    if (agg.passRateTrend) {
        lines.push('## Pass-rate trend');
        lines.push('');
        lines.push(`- Runs sampled: ${agg.passRateTrend.runs}`);
        lines.push(`- Aggregate pass rate: ${agg.passRateTrend.passRate ?? 'n/a'}%`);
        if (agg.passRateTrend.samples && agg.passRateTrend.samples.length > 0) {
            lines.push('- Per-run:');
            for (const s of agg.passRateTrend.samples.slice(0, 10)) lines.push(`  - ${s.ts} → ${s.passRate}%`);
        }
        lines.push('');
    }
    if (agg.openBugs) {
        lines.push('## Open bugs');
        lines.push('');
        lines.push(`- Total: ${agg.openBugs.total}`);
        lines.push('- By severity:');
        for (const [k, v] of Object.entries(agg.openBugs.bySeverity)) lines.push(`  - ${k}: ${v}`);
        lines.push('');
    }
    return lines.join('\n');
}

function buildWidgetPath(project: string, teamId: string | undefined, widgetId: string, dashboardId: string): string {
    // ADO widget REST is scoped to project + team. When teamId is omitted, ADO
    // routes to the project's default team via the /_apis endpoint; but the
    // widgets API specifically requires team scope, so if not supplied we fall
    // back to a "well-known" path that many on-prem installs accept.
    const q = new URLSearchParams({ dashboardId, 'api-version': '7.1-preview.2' });
    if (teamId) {
        // scopeToProject prepends `${orgUrl}/${project}` — we want team AFTER project.
        return `${encodeURIComponent(teamId)}/_apis/dashboard/dashboards/${dashboardId}/widgets/${widgetId}?api-version=7.1-preview.2`;
    }
    // Fallback: /_apis/wit/widgets/{id}
    return `_apis/dashboard/dashboards/${dashboardId}/widgets/${widgetId}?${q.toString()}`;
}

registerPrimitive({
    name: 'cs_qa_dashboard_push',
    description: 'Push metrics + widget content to a dashboard. Two modes — ado: PATCH an ADO Markdown widget (verifies via GET first, preserves settings shape); webhook: POST JSON to a webhook URL. Payload can carry DORA, release-gate history, flaky cluster count, and a11y trend blocks — the tool renders Markdown for the ADO mode. Example: cs_qa_dashboard_push mode:"ado" dashboardId:"abc" widgetId:"def" teamId:"team-guid" payload:{title:"Nightly",dora:{...}}',
    inputSchema: z.object({
        mode: z.enum(['ado', 'webhook', 'aggregate']),
        dashboardId: z.string().min(1).optional(),
        widgetId: z.string().min(1).optional(),
        teamId: z.string().min(1).optional().describe('ADO team id. Required by widget REST — when omitted, tool tries the project-scoped fallback path.'),
        webhookUrl: z.string().url().optional(),
        payload: DashboardPayloadSchema.optional(),
        orgUrl: z.string().url().optional(),
        project: z.string().min(1).optional(),
        pat: z.string().min(1).optional(),
        iterationPath: z.string().optional().describe('aggregate mode — used to filter open-bug counts by iteration.'),
        lastNRuns: z.number().int().positive().max(50).default(10).describe('aggregate mode — number of recent runs to include in pass-rate trend.'),
    }).refine((v) => {
        if (v.mode === 'ado') return !!v.dashboardId && !!v.widgetId && !!v.payload;
        if (v.mode === 'webhook') return !!v.webhookUrl && !!v.payload;
        // aggregate mode: needs nothing extra — everything is discovered locally + from ADO.
        return true;
    }, { message: 'ado mode needs dashboardId+widgetId+payload; webhook mode needs webhookUrl+payload; aggregate mode reads from local files + ADO.' }),
    outputSchema: z.object({
        ok: z.boolean(),
        mode: z.string(),
        target: z.string(),
        widgetContentBytes: z.number().optional(),
        httpStatus: z.number().optional(),
        webhookResponseSnippet: z.string().optional(),
        warnings: z.array(z.string()).default([]),
        note: z.string().optional(),
        aggregate: z.object({
            coverage: z.unknown().optional(),
            passRateTrend: z.object({ runs: z.number(), passRate: z.number().nullable(), samples: z.array(z.object({ ts: z.string(), passRate: z.number() })).optional() }).optional(),
            openBugs: z.object({ total: z.number(), bySeverity: z.record(z.string(), z.number()) }).optional(),
            markdownPath: z.string().optional(),
            iterationPath: z.string().optional(),
        }).optional(),
    }),
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_dashboard_push', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];

        if (input.mode === 'aggregate') {
            const agg = await buildAggregate(ctx.workspaceRoot, {
                orgUrl: input.orgUrl, project: input.project, pat: input.pat,
                iterationPath: input.iterationPath, lastNRuns: input.lastNRuns,
            }, warnings);
            const mdPath = path.join(ctx.workspaceRoot, '.cs-qa', 'dashboard', 'aggregate.md');
            try {
                fs.mkdirSync(path.dirname(mdPath), { recursive: true });
                fs.writeFileSync(mdPath, renderAggregateMarkdown(agg), 'utf-8');
            } catch (e) {
                warnings.push(`aggregate.md write failed: ${(e as Error).message}`);
            }
            log.info('aggregate built', { coverage: !!agg.coverage, passRate: agg.passRateTrend?.passRate, openBugs: agg.openBugs?.total });
            return {
                ok: true,
                mode: 'aggregate',
                target: mdPath,
                widgetContentBytes: Buffer.byteLength(renderAggregateMarkdown(agg), 'utf-8'),
                warnings,
                note: `aggregate: coverage=${agg.coverage ? 'yes' : 'no'}, passRate(${agg.passRateTrend?.runs ?? 0}runs)=${agg.passRateTrend?.passRate ?? 'n/a'}, openBugs=${agg.openBugs?.total ?? 'n/a'}. Markdown at ${mdPath}. Return aggregate JSON can be fed to a follow-up push-widget call.`,
                aggregate: { ...agg, markdownPath: mdPath, iterationPath: input.iterationPath },
            };
        }

        if (input.mode === 'webhook') {
            const md = renderMarkdown(input.payload!);
            const body = { markdown: md, payload: input.payload };
            const res = await fetch(input.webhookUrl!, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const text = await res.text().catch(() => '');
            log.info('webhook push', { url: input.webhookUrl, status: res.status });
            return {
                ok: res.ok,
                mode: 'webhook',
                target: input.webhookUrl!,
                widgetContentBytes: Buffer.byteLength(md, 'utf-8'),
                httpStatus: res.status,
                webhookResponseSnippet: text.slice(0, 200),
                warnings,
                note: `Webhook POST → ${res.status} ${res.ok ? 'ok' : 'FAILED'}`,
            };
        }

        // mode === 'ado'
        const credsRes = getResolvedCreds(ctx.workspaceRoot, {
            orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat,
        });
        if (!credsRes.creds) {
            return {
                ok: false, mode: 'ado', target: '(no target — creds missing)',
                warnings: [credsRes.diagnostic],
                note: 'ADO not configured — cannot PATCH widget.',
            };
        }
        const cfg: AdoCreds = credsRes.creds;
        const client = new AdoHttpClient(cfg);
        const md = renderMarkdown(input.payload!);
        const widgetPath = buildWidgetPath(cfg.project, input.teamId, input.widgetId!, input.dashboardId!);

        // Verify widget exists (GET first — captures existing shape).
        let existing: Record<string, unknown> | null = null;
        try {
            existing = await client.get<Record<string, unknown>>(widgetPath);
        } catch (e) {
            warnings.push(`widget GET failed: ${(e as Error).message}`);
            // Fall through — try PATCH anyway with minimal shape.
        }

        // Markdown widget settings shape (ADO): { name: "Markdown", settings: JSON.stringify({content: "..."}), ...}
        const settingsJson = JSON.stringify({ content: md });
        const patchBody: Record<string, unknown> = {
            ...(existing || {}),
            name: (existing && (existing.name as string)) || 'Markdown',
            contributionId: (existing && (existing.contributionId as string)) || 'ms.vss-dashboards-web.Microsoft.VisualStudioOnline.Dashboards.MarkdownWidget',
            settings: settingsJson,
            settingsVersion: (existing && (existing.settingsVersion as unknown)) || { major: 1, minor: 0, patch: 0 },
        };
        let httpStatus: number | undefined;
        try {
            await client.patch(widgetPath, patchBody);
            httpStatus = 200;
        } catch (e) {
            warnings.push(`widget PATCH failed: ${(e as Error).message}`);
            // AdoHttpError carries the status code
            const err = e as { status?: number };
            httpStatus = err?.status;
        }
        log.info('ado widget push', { widgetId: input.widgetId, status: httpStatus });
        return {
            ok: httpStatus === 200 || httpStatus === 204,
            mode: 'ado',
            target: `dashboard=${input.dashboardId} widget=${input.widgetId}${input.teamId ? ' team=' + input.teamId : ''}`,
            widgetContentBytes: Buffer.byteLength(settingsJson, 'utf-8'),
            httpStatus,
            warnings,
            note: httpStatus === 200 || httpStatus === 204
                ? `ADO Markdown widget updated (${Buffer.byteLength(md, 'utf-8')} bytes of Markdown).`
                : `ADO widget update failed — see warnings.`,
        };
    },
});
