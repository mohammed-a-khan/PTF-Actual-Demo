/**
 * cs_qa_a11y_scan_dedup — Consume axe-core violation JSON, fingerprint each
 * violation node by (ruleId, normalized selector, tag+class shape), dedupe
 * across runs. Reports distinct issues, WCAG A/AA/AAA breakdown, affected
 * pages, severity.
 *
 * Optionally files ONE ADO bug per WCAG-A or WCAG-AA fingerprint (only these
 * two levels — AAA is aspirational and best-practice is advisory). Dedupe:
 * skip if an open bug exists with tag `a11y-<fingerprint12>`.
 *
 * Input shape supports:
 *   - `violationsPath` — a file whose contents are either `{ violations: [...] }`
 *      (axe report top-level) or a raw array `[{...axe violation}]`
 *   - inline `violations[]`
 *   - `pageUrl` optional — attaches to the fingerprint's `pages` list
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { wiql } from './_helpers/wiql_builder';
import { bulkExecute } from './_helpers/bulk_batcher';
import { createLogger } from './_helpers/structured_logger';
import { dedupeViolations, type AxeViolation, type DedupedIssue } from './_helpers/axe_fingerprint';
import { getResolvedCreds } from './ado_config_tool';

function loadViolations(input: { violationsPath?: string; violations?: unknown[]; workspaceRoot: string }): { violations: AxeViolation[]; warning?: string } {
    if (input.violations && input.violations.length > 0) {
        return { violations: input.violations as AxeViolation[] };
    }
    if (!input.violationsPath) return { violations: [], warning: 'no violationsPath or violations[] supplied' };
    const abs = path.isAbsolute(input.violationsPath) ? input.violationsPath : path.join(input.workspaceRoot, input.violationsPath);
    if (!fs.existsSync(abs)) return { violations: [], warning: `violationsPath not found: ${abs}` };
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(abs, 'utf-8')); }
    catch (e) { return { violations: [], warning: `parse failed: ${(e as Error).message}` }; }
    if (Array.isArray(parsed)) return { violations: parsed as AxeViolation[] };
    if (parsed && typeof parsed === 'object') {
        const p = parsed as { violations?: unknown[]; results?: { violations?: unknown[] } };
        if (Array.isArray(p.violations)) return { violations: p.violations as AxeViolation[] };
        if (p.results && Array.isArray(p.results.violations)) return { violations: p.results.violations as AxeViolation[] };
    }
    return { violations: [], warning: 'no violations array found in file' };
}

async function findExistingA11yBug(client: AdoHttpClient, tag: string): Promise<number | null> {
    const q = wiql()
        .select(['[System.Id]'])
        .from('WorkItems')
        .where()
        .equals('[System.WorkItemType]', 'Bug')
        .and().tag(tag)
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

function pickSeverity(issue: DedupedIssue): '1 - Critical' | '2 - High' | '3 - Medium' | '4 - Low' {
    // Impact + WCAG level → ADO severity.
    if (issue.wcagLevel === 'A' && (issue.impact === 'critical' || issue.impact === 'serious')) return '1 - Critical';
    if (issue.wcagLevel === 'A' || issue.impact === 'critical') return '2 - High';
    if (issue.wcagLevel === 'AA' || issue.impact === 'serious') return '2 - High';
    if (issue.impact === 'moderate') return '3 - Medium';
    return '4 - Low';
}

async function createA11yBug(client: AdoHttpClient, issue: DedupedIssue, tag: string): Promise<number | null> {
    const escaped = (s: string): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `<pre>Accessibility issue (${issue.wcagLevel})
Rule:       ${escaped(issue.ruleId)}
Impact:     ${escaped(issue.impact)}
Selector:   ${escaped(issue.normalizedTarget)}
Tag shape:  ${escaped(issue.tagShape)}
Help:       ${escaped(issue.help)}
Help URL:   ${escaped(issue.helpUrl)}
Occurrences: ${issue.occurrences}
Pages:
${issue.pages.slice(0, 20).map((p) => '  - ' + escaped(p)).join('\n')}

Sample violating HTML:
${escaped(issue.firstHtml)}
</pre>`;
    const sev = pickSeverity(issue);
    const pri = sev === '1 - Critical' ? 1 : sev === '2 - High' ? 2 : sev === '3 - Medium' ? 3 : 4;
    const patch: Array<Record<string, unknown>> = [
        { op: 'add', path: '/fields/System.Title', value: `A11y ${issue.wcagLevel}: ${issue.ruleId} on ${issue.normalizedTarget.slice(0, 80)}` },
        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: html },
        { op: 'add', path: '/fields/Microsoft.VSTS.Common.Severity', value: sev },
        { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: pri },
        { op: 'add', path: '/fields/System.Tags', value: `accessibility; wcag-${issue.wcagLevel.toLowerCase()}; ${tag}` },
    ];
    try {
        const created = await client.post<{ id?: number }>(`_apis/wit/workitems/$Bug?api-version=7.0`, patch);
        return Number(created?.id || 0) || null;
    } catch {
        return null;
    }
}

registerPrimitive({
    name: 'cs_qa_a11y_scan_dedup',
    description: 'Fingerprint axe-core violation nodes by (ruleId, normalized selector, HTML tag+class shape) and dedupe across runs — one issue per fingerprint even if it fires 100× on the page. Reports distinct issues, WCAG A/AA/AAA breakdown, affected pages. Optionally files ONE ADO bug per WCAG-A/AA fingerprint (severity mapped from impact+level); dedupe against existing bugs by fingerprint tag. Example: cs_qa_a11y_scan_dedup violationsPath:"axe-report.json" pageUrl:"/checkout" fileBugs:true.',
    inputSchema: z.object({
        violationsPath: z.string().min(1).optional(),
        violations: z.array(z.record(z.string(), z.any())).optional(),
        pageUrl: z.string().min(1).optional(),
        fileBugs: z.boolean().default(false),
        includeLevels: z.array(z.enum(['A', 'AA', 'AAA', 'best-practice'])).default(['A', 'AA']).describe('Which WCAG levels to open bugs for (default: A + AA only).'),
        orgUrl: z.string().url().optional(),
        project: z.string().min(1).optional(),
        pat: z.string().min(1).optional(),
    }),
    outputSchema: z.object({
        ok: z.boolean(),
        totalViolationInstances: z.number(),
        distinctIssues: z.number(),
        levelBreakdown: z.record(z.string(), z.number()),
        dedupedIssues: z.array(z.object({
            fingerprint: z.string(),
            ruleId: z.string(),
            impact: z.string(),
            wcagLevel: z.enum(['A', 'AA', 'AAA', 'best-practice', 'unknown']),
            normalizedTarget: z.string(),
            tagShape: z.string(),
            help: z.string(),
            helpUrl: z.string(),
            firstHtml: z.string(),
            occurrences: z.number(),
            pages: z.array(z.string()),
        })).default([]),
        bugsFiled: z.array(z.object({ fingerprint: z.string(), bugId: z.number() })).default([]),
        bugsSkippedExisting: z.array(z.object({ fingerprint: z.string(), bugId: z.number() })).default([]),
        warnings: z.array(z.string()).default([]),
        note: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_a11y_scan_dedup', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        const { violations, warning } = loadViolations({
            violationsPath: input.violationsPath,
            violations: input.violations,
            workspaceRoot: ctx.workspaceRoot,
        });
        if (warning) warnings.push(warning);

        let instances = 0;
        for (const v of violations) instances += (v.nodes || []).length;

        const deduped = dedupeViolations(violations, input.pageUrl);
        const breakdown: Record<string, number> = { A: 0, AA: 0, AAA: 0, 'best-practice': 0, unknown: 0 };
        for (const d of deduped) breakdown[d.wcagLevel] = (breakdown[d.wcagLevel] || 0) + 1;

        const bugsFiled: Array<{ fingerprint: string; bugId: number }> = [];
        const bugsSkippedExisting: Array<{ fingerprint: string; bugId: number }> = [];
        if (input.fileBugs) {
            const eligible = deduped.filter((d) => input.includeLevels.includes(d.wcagLevel as 'A' | 'AA' | 'AAA' | 'best-practice'));
            if (eligible.length > 0) {
                const credsRes = getResolvedCreds(ctx.workspaceRoot, {
                    orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat,
                });
                if (!credsRes.creds) {
                    warnings.push(credsRes.diagnostic);
                } else {
                    const cfg: AdoCreds = credsRes.creds;
                    const client = new AdoHttpClient(cfg);
                    const results = await bulkExecute(eligible, {
                        chunkSize: 5,
                        concurrency: 2,
                        workFn: async (chunk) => {
                            const out: Array<{ fingerprint: string; bugId: number; skipped: boolean }> = [];
                            for (const issue of chunk) {
                                const tag = `a11y-${issue.fingerprint.slice(0, 12)}`;
                                const existing = await findExistingA11yBug(client, tag);
                                if (existing) {
                                    out.push({ fingerprint: issue.fingerprint, bugId: existing, skipped: true });
                                    continue;
                                }
                                const id = await createA11yBug(client, issue, tag);
                                if (id) out.push({ fingerprint: issue.fingerprint, bugId: id, skipped: false });
                            }
                            return out;
                        },
                        onChunkError: (err) => warnings.push(`a11y-bug chunk error: ${err.message}`),
                    });
                    for (const r of results.ok) {
                        if (r.skipped) bugsSkippedExisting.push({ fingerprint: r.fingerprint, bugId: r.bugId });
                        else bugsFiled.push({ fingerprint: r.fingerprint, bugId: r.bugId });
                    }
                }
            }
        }

        log.info('a11y dedup complete', {
            instances, distinct: deduped.length, filed: bugsFiled.length, skipped: bugsSkippedExisting.length,
        });

        return {
            ok: true,
            totalViolationInstances: instances,
            distinctIssues: deduped.length,
            levelBreakdown: breakdown,
            dedupedIssues: deduped,
            bugsFiled,
            bugsSkippedExisting,
            warnings,
            note: `${instances} violation instances collapsed into ${deduped.length} distinct fingerprints (A:${breakdown.A ?? 0}, AA:${breakdown.AA ?? 0}, AAA:${breakdown.AAA ?? 0}, best-practice:${breakdown['best-practice'] ?? 0}, unknown:${breakdown.unknown ?? 0}). Bugs filed: ${bugsFiled.length}; skipped existing: ${bugsSkippedExisting.length}.`,
        };
    },
});
