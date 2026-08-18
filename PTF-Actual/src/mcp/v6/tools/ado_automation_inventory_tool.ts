/**
 * cs_qa_automation_inventory — rollup report of every ADO Test Case in a
 * plan/suite against its local automation status.
 *
 * Six buckets
 *   automatedTrue     ADO Automated  + local scenario exists  + not @pending
 *   automatedFalse    ADO Automated  + NO local scenario      OR local is @pending
 *   plannedTrue       ADO Planned    + local scenario exists   (AC coverage unclear)
 *   notAutomated      ADO NotAutomated + no local scenario
 *   orphanScenarios   local @TestCaseId:<n> whose TC doesn't appear in this ADO scope
 *   orphanAdoTcs      ADO TC with no @TestCaseId link in any local feature file
 *
 * Output format
 *   'table'  → columns-and-rows Markdown table string
 *   'json'   → the structured matrix (default)
 *   'html'   → self-contained HTML fragment (no external CSS/JS)
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { getResolvedCreds } from './ado_config_tool';
import {
    resolvePlan, resolveSuite, listTestCasesInSuite, listAllSuitesInPlan, collectNestedSuites,
    createCache, type ResolverCache, type SuiteRef,
} from './ado_name_resolver';
import { extractTestCaseIdsFromScenario } from './sync_feature_tags';

// ------------------------------------------------------------------------
// Schema.
// ------------------------------------------------------------------------

const InputSchema = z.object({
    planId: z.number().int().positive().optional(),
    planName: z.string().min(1).optional(),
    suiteId: z.number().int().positive().optional(),
    suiteName: z.string().min(1).optional(),
    includeNestedSuites: z.boolean().default(true),
    output: z.enum(['table', 'json', 'html']).default('json'),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    pat: z.string().min(1).optional(),
    /** Cap on how many TCs to inventory this invocation. */
    maxTestCases: z.number().int().positive().default(500),
    /** Where to scan for local feature files. */
    featuresRoot: z.string().optional(),
}).refine((v) => (v.planId ?? v.planName) !== undefined, { message: 'planId or planName required' });

// ------------------------------------------------------------------------
// Local feature-file scanner — one line per (feature file, scenario name,
// testCaseId, tags).
// ------------------------------------------------------------------------

interface LocalScenario {
    featurePath: string;    // workspace-relative
    scenarioName: string;
    scenarioLine: number;
    testCaseIds: number[];
    tags: string[];
    isPending: boolean;
}

const PENDING_TAG_RE = /^@(?:pending(?:-app-gap|-)?|skip)$/i;

function walkFeatureFiles(rootAbs: string, out: string[]): void {
    if (!fs.existsSync(rootAbs)) return;
    const st = fs.statSync(rootAbs);
    if (st.isFile()) { if (rootAbs.toLowerCase().endsWith('.feature')) out.push(rootAbs); return; }
    if (!st.isDirectory()) return;
    let entries: fs.Dirent[]; try { entries = fs.readdirSync(rootAbs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue;
        const fp = path.join(rootAbs, e.name);
        if (e.isDirectory()) walkFeatureFiles(fp, out);
        else if (e.isFile() && e.name.toLowerCase().endsWith('.feature')) out.push(fp);
    }
}

function parseFeatureScenarios(fp: string, workspaceRoot: string): LocalScenario[] {
    const relPath = path.relative(workspaceRoot, fp);
    let content: string; try { content = fs.readFileSync(fp, 'utf-8'); } catch { return []; }
    const lines = content.split('\n');
    const out: LocalScenario[] = [];
    let featureTags: string[] = [];
    let pending: string[] = [];
    let capturedFeature = false;
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (/^@\S/.test(trimmed)) {
            pending.push(...trimmed.split(/\s+/).filter((t) => t.startsWith('@')));
            continue;
        }
        if (/^Feature\s*:/.test(trimmed) && !capturedFeature) {
            featureTags = pending.slice(); pending = []; capturedFeature = true; continue;
        }
        const sc = /^(Scenario Outline|Scenario)\s*:\s*(.+)$/.exec(trimmed);
        if (sc) {
            const scenTags = pending.slice(); pending = [];
            const allTags = featureTags.concat(scenTags);
            const ids = extractTestCaseIdsFromScenario(allTags);
            const isPending = allTags.some((t) => PENDING_TAG_RE.test(t));
            out.push({
                featurePath: relPath.replace(/\\/g, '/'),
                scenarioName: sc[2].trim(),
                scenarioLine: i + 1,
                testCaseIds: ids,
                tags: allTags,
                isPending,
            });
        }
    }
    return out;
}

function scanLocalScenarios(workspaceRoot: string, featuresRoot?: string): LocalScenario[] {
    const roots = featuresRoot
        ? [path.isAbsolute(featuresRoot) ? featuresRoot : path.resolve(workspaceRoot, featuresRoot)]
        : [
            path.join(workspaceRoot, 'test'),
            path.join(workspaceRoot, 'tests'),
            path.join(workspaceRoot, 'e2e'),
            path.join(workspaceRoot, 'features'),
        ];
    const files: string[] = [];
    for (const r of roots) walkFeatureFiles(r, files);
    const seen = new Set<string>();
    const out: LocalScenario[] = [];
    for (const f of files) {
        if (seen.has(f)) continue; seen.add(f);
        out.push(...parseFeatureScenarios(f, workspaceRoot));
    }
    return out;
}

// ------------------------------------------------------------------------
// Output rendering.
// ------------------------------------------------------------------------

interface InventoryRow {
    testCaseId?: number;
    testCaseTitle?: string;
    localScenario?: string;
    featurePath?: string;
    automationStatus?: string;
    priority?: number;
    tags?: string[];
    reason?: string;
}

function toMarkdownTable(matrix: Record<string, InventoryRow[]>): string {
    const lines: string[] = [];
    for (const bucket of Object.keys(matrix)) {
        const rows = matrix[bucket];
        lines.push(`### ${bucket} (${rows.length})`);
        if (rows.length === 0) { lines.push(''); continue; }
        lines.push(`| TC ID | Title | Local Scenario | Status | Notes |`);
        lines.push(`|-------|-------|----------------|--------|-------|`);
        for (const r of rows) {
            lines.push(`| ${r.testCaseId ?? ''} | ${(r.testCaseTitle ?? '').slice(0, 60)} | ${(r.localScenario ?? '').slice(0, 60)} | ${r.automationStatus ?? ''} | ${r.reason ?? ''} |`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

function esc(s: string): string {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toHtml(matrix: Record<string, InventoryRow[]>, counts: Record<string, number>, scope: { planId?: number; suiteId?: number }): string {
    const rowsFor = (rows: InventoryRow[]): string => rows.map((r) => `<tr><td>${r.testCaseId ?? ''}</td><td>${esc(r.testCaseTitle ?? '')}</td><td>${esc(r.localScenario ?? '')}</td><td>${esc(r.automationStatus ?? '')}</td><td>${esc(r.reason ?? '')}</td></tr>`).join('');
    const bucketDiv = Object.keys(matrix).map((bucket) => `
<section><h2>${esc(bucket)} <small>(${matrix[bucket].length})</small></h2>
<table><thead><tr><th>TC ID</th><th>Title</th><th>Local Scenario</th><th>Status</th><th>Notes</th></tr></thead>
<tbody>${rowsFor(matrix[bucket])}</tbody></table></section>`).join('\n');
    return `<article><h1>Automation Inventory — plan ${esc(String(scope.planId ?? ''))}${scope.suiteId ? ' / suite ' + esc(String(scope.suiteId)) : ''}</h1>
<p><b>Counts</b>: ${Object.entries(counts).map(([k, v]) => `${esc(k)}=${v}`).join(', ')}</p>${bucketDiv}</article>`;
}

// ------------------------------------------------------------------------
// Registration.
// ------------------------------------------------------------------------

registerPrimitive({
    name: 'cs_qa_automation_inventory',
    description: 'Rollup report — every ADO Test Case in the given plan (optionally scoped to a suite + nested descendants) against its local automation status. Six buckets: automatedTrue (ADO Automated + local scenario present + not @pending), automatedFalse (ADO Automated but local missing or @pending), plannedTrue (ADO Planned + local present), notAutomated (ADO NotAutomated + no local), orphanScenarios (local @TestCaseId:<n> whose TC is missing in scope), orphanAdoTcs (ADO TC has no local link). Output: json (default), table (Markdown), or html.',
    inputSchema: InputSchema,
    outputSchema: z.object({
        ok: z.boolean(),
        scope: z.object({ planId: z.number().optional(), suiteId: z.number().optional(), includeNestedSuites: z.boolean().optional() }),
        matrix: z.record(z.string(), z.array(z.any())),
        counts: z.record(z.string(), z.number()),
        driftEntries: z.array(z.object({ tcId: z.number(), reason: z.string() })),
        priorityActions: z.array(z.string()),
        renderedTable: z.string().optional(),
        renderedHtml: z.string().optional(),
        warnings: z.array(z.string()),
        note: z.string().optional(),
        ambiguous: z.boolean().optional(),
        ambiguousCandidates: z.array(z.object({ id: z.number(), name: z.string(), note: z.string().optional() })).optional(),
    }),
    run: async (ctx, input) => {
        const logger = createLogger(ctx.invocationId, 'cs_qa_automation_inventory', { workspaceRoot: ctx.workspaceRoot });
        const emptyMatrix = {
            automatedTrue: [] as InventoryRow[],
            automatedFalse: [] as InventoryRow[],
            plannedTrue: [] as InventoryRow[],
            notAutomated: [] as InventoryRow[],
            orphanScenarios: [] as InventoryRow[],
            orphanAdoTcs: [] as InventoryRow[],
        };
        const emptyCounts = { automatedTrue: 0, automatedFalse: 0, plannedTrue: 0, notAutomated: 0, orphanScenarios: 0, orphanAdoTcs: 0 };

        const resolved = getResolvedCreds(ctx.workspaceRoot, { orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat });
        if (!resolved.creds) {
            return {
                ok: false, scope: {}, matrix: emptyMatrix, counts: emptyCounts,
                driftEntries: [], priorityActions: [],
                warnings: [], note: `ADO not configured — ${resolved.diagnostic}`,
            };
        }
        const cfg: AdoCreds = resolved.creds;
        const client = new AdoHttpClient(cfg);
        const cache: ResolverCache = createCache();
        const warnings: string[] = [];

        // Plan.
        const p = await resolvePlan(cfg, { planId: input.planId, planName: input.planName }, cache);
        warnings.push(...p.warnings);
        if (p.ambiguous) {
            return {
                ok: false, scope: {}, matrix: emptyMatrix, counts: emptyCounts,
                driftEntries: [], priorityActions: [],
                ambiguous: true, ambiguousCandidates: p.candidates,
                warnings, note: `Ambiguous planName — pick one from ambiguousCandidates and re-run with planId.`,
            };
        }
        if (p.resolved.length === 0) {
            return {
                ok: false, scope: {}, matrix: emptyMatrix, counts: emptyCounts,
                driftEntries: [], priorityActions: [],
                warnings, note: `Plan not found.`,
            };
        }
        const planId = p.resolved[0].id;

        // Suite (optional).
        let suiteIds: number[] | undefined;
        let scopeSuiteId: number | undefined;
        if (input.suiteId || input.suiteName) {
            const s = await resolveSuite(cfg, { planId, suiteId: input.suiteId, suiteName: input.suiteName }, cache);
            warnings.push(...s.warnings);
            if (s.ambiguous) {
                return {
                    ok: false, scope: { planId }, matrix: emptyMatrix, counts: emptyCounts,
                    driftEntries: [], priorityActions: [],
                    ambiguous: true, ambiguousCandidates: s.candidates,
                    warnings, note: `Ambiguous suiteName — pick from ambiguousCandidates and re-run with suiteId.`,
                };
            }
            if (s.resolved.length === 0) {
                return {
                    ok: false, scope: { planId }, matrix: emptyMatrix, counts: emptyCounts,
                    driftEntries: [], priorityActions: [],
                    warnings, note: `Suite not found in plan ${planId}.`,
                };
            }
            scopeSuiteId = s.resolved[0].id;
            if (input.includeNestedSuites) {
                const all = await listAllSuitesInPlan(cfg, planId, cache);
                const nested = collectNestedSuites(all, scopeSuiteId);
                suiteIds = nested.map((n: SuiteRef) => n.id);
            } else {
                suiteIds = [scopeSuiteId];
            }
        }
        // If no suite passed, enumerate every suite in the plan.
        if (!suiteIds) {
            const all = await listAllSuitesInPlan(cfg, planId, cache);
            suiteIds = all.map((n) => n.id);
        }

        // Collect TC IDs across the suite scope.
        const scopedTcIds = new Set<number>();
        for (const sid of suiteIds) {
            const cases = await listTestCasesInSuite(cfg, planId, sid, cache);
            for (const c of cases) scopedTcIds.add(c.id);
            if (scopedTcIds.size >= input.maxTestCases) break;
        }
        const scopedIdList = Array.from(scopedTcIds).slice(0, input.maxTestCases);
        if (scopedTcIds.size > input.maxTestCases) warnings.push(`Suite scope has ${scopedTcIds.size} TC(s); capped to ${input.maxTestCases}.`);

        // Batch fetch fields.
        const tcById = new Map<number, { title: string; automationStatus: string; automatedTestName: string; automatedTestStorage: string; priority: number; tags: string }>();
        for (let i = 0; i < scopedIdList.length; i += 200) {
            const chunk = scopedIdList.slice(i, i + 200);
            const r = await client.get<{ value?: Array<{ id?: number; fields?: Record<string, unknown> }> }>(
                `_apis/wit/workitems?ids=${chunk.join(',')}&fields=System.Id,System.Title,System.Tags,Microsoft.VSTS.Common.Priority,Microsoft.VSTS.TCM.AutomationStatus,Microsoft.VSTS.TCM.AutomatedTestName,Microsoft.VSTS.TCM.AutomatedTestStorage&api-version=7.0`,
            );
            for (const wi of (r?.value || [])) {
                const id = Number(wi.id || 0);
                if (id <= 0) continue;
                tcById.set(id, {
                    title: String(wi.fields?.['System.Title'] || `Test Case ${id}`),
                    automationStatus: String(wi.fields?.['Microsoft.VSTS.TCM.AutomationStatus'] || 'Not Automated'),
                    automatedTestName: String(wi.fields?.['Microsoft.VSTS.TCM.AutomatedTestName'] || ''),
                    automatedTestStorage: String(wi.fields?.['Microsoft.VSTS.TCM.AutomatedTestStorage'] || ''),
                    priority: Number(wi.fields?.['Microsoft.VSTS.Common.Priority'] || 2),
                    tags: String(wi.fields?.['System.Tags'] || ''),
                });
            }
        }

        // Local scenarios.
        const localScenarios = scanLocalScenarios(ctx.workspaceRoot, input.featuresRoot);
        // Index: tcId → scenarios linking to it
        const localByTcId = new Map<number, LocalScenario[]>();
        for (const ls of localScenarios) {
            for (const tid of ls.testCaseIds) {
                const arr = localByTcId.get(tid) ?? [];
                arr.push(ls); localByTcId.set(tid, arr);
            }
        }

        // Classify.
        const matrix = {
            automatedTrue: [] as InventoryRow[],
            automatedFalse: [] as InventoryRow[],
            plannedTrue: [] as InventoryRow[],
            notAutomated: [] as InventoryRow[],
            orphanScenarios: [] as InventoryRow[],
            orphanAdoTcs: [] as InventoryRow[],
        };
        const driftEntries: Array<{ tcId: number; reason: string }> = [];
        for (const [tcId, meta] of tcById.entries()) {
            const links = localByTcId.get(tcId) || [];
            const hasNonPending = links.some((l) => !l.isPending);
            const row: InventoryRow = {
                testCaseId: tcId, testCaseTitle: meta.title,
                automationStatus: meta.automationStatus,
                localScenario: links[0]?.scenarioName,
                featurePath: links[0]?.featurePath,
                priority: meta.priority,
                tags: meta.tags.split(/[,;]/).map((t) => t.trim()).filter(Boolean),
            };
            if (meta.automationStatus === 'Automated') {
                if (hasNonPending) matrix.automatedTrue.push(row);
                else {
                    row.reason = links.length === 0 ? 'ADO=Automated but no local @TestCaseId link' : 'local scenario carries @pending';
                    matrix.automatedFalse.push(row);
                    driftEntries.push({ tcId, reason: row.reason });
                }
            } else if (meta.automationStatus === 'Planned') {
                if (links.length > 0) matrix.plannedTrue.push(row);
                else { row.reason = 'ADO=Planned + no local scenario'; matrix.notAutomated.push(row); }
            } else {
                if (links.length === 0) { row.reason = 'ADO=NotAutomated + no local scenario'; matrix.notAutomated.push(row); }
                else {
                    row.reason = 'local scenario exists but ADO=NotAutomated';
                    matrix.automatedFalse.push(row);
                    driftEntries.push({ tcId, reason: row.reason });
                }
            }
        }

        // Orphans.
        // orphanScenarios: local @TestCaseId whose TC id is not in the ADO scope.
        for (const [tcId, links] of localByTcId.entries()) {
            if (tcById.has(tcId)) continue;
            for (const l of links) {
                matrix.orphanScenarios.push({
                    testCaseId: tcId,
                    localScenario: l.scenarioName,
                    featurePath: l.featurePath,
                    reason: 'local @TestCaseId points to a TC outside this ADO scope',
                });
            }
        }
        // orphanAdoTcs: automated ADO TCs with no local link — already caught in automatedFalse.
        // Add a distinct bucket for TCs whose AutomatedTestName is set but no local file matches.
        for (const [tcId, meta] of tcById.entries()) {
            if (!meta.automatedTestName) continue;
            const links = localByTcId.get(tcId) || [];
            if (links.length > 0) continue;
            matrix.orphanAdoTcs.push({
                testCaseId: tcId, testCaseTitle: meta.title, automationStatus: meta.automationStatus,
                reason: `AutomatedTestName="${meta.automatedTestName}" but no @TestCaseId:${tcId} in local features`,
            });
        }

        const counts = {
            automatedTrue: matrix.automatedTrue.length,
            automatedFalse: matrix.automatedFalse.length,
            plannedTrue: matrix.plannedTrue.length,
            notAutomated: matrix.notAutomated.length,
            orphanScenarios: matrix.orphanScenarios.length,
            orphanAdoTcs: matrix.orphanAdoTcs.length,
        };
        const priorityActions: string[] = [];
        if (counts.automatedFalse > 0) priorityActions.push(`Fix ${counts.automatedFalse} drift entr(ies) where ADO says Automated but local coverage is missing/pending.`);
        if (counts.notAutomated > 0) priorityActions.push(`${counts.notAutomated} TC(s) still need automation — run cs_qa_automate_manual per TC or cs_qa_automate_suite for the whole suite.`);
        if (counts.orphanScenarios > 0) priorityActions.push(`${counts.orphanScenarios} local scenario(s) reference TC IDs outside this scope — either move them or update the tag.`);
        if (counts.orphanAdoTcs > 0) priorityActions.push(`${counts.orphanAdoTcs} ADO TC(s) claim automation but no local feature has the matching @TestCaseId — likely stale ADO metadata or missing local file.`);

        logger.info('inventory-done', { counts, planId, suiteId: scopeSuiteId });

        let renderedTable: string | undefined;
        let renderedHtml: string | undefined;
        if (input.output === 'table') renderedTable = toMarkdownTable(matrix);
        else if (input.output === 'html') renderedHtml = toHtml(matrix, counts, { planId, suiteId: scopeSuiteId });

        return {
            ok: true,
            scope: { planId, suiteId: scopeSuiteId, includeNestedSuites: input.includeNestedSuites },
            matrix,
            counts,
            driftEntries,
            priorityActions,
            renderedTable,
            renderedHtml,
            warnings,
            note: `Inventoried ${tcById.size} TC(s) across ${suiteIds.length} suite(s) in plan ${planId}. Local scenarios scanned: ${localScenarios.length}.`,
        };
    },
});
