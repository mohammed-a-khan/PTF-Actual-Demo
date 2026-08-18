/**
 * cs_qa_sprint_watcher — one-shot end-to-end sprint analysis.
 *
 * User invokes; tool pulls Stories + Features + Bugs from ADO for the target
 * iteration, walks each Story's TestedBy → TestCase relations, pulls the
 * latest test results for those TCs, computes a per-story readiness score,
 * and writes a morning-brief markdown report.
 *
 * Non-negotiables:
 *   - Every ADO endpoint really hit — no mocked returns.
 *   - All HTTP through AdoHttpClient (Retry-After honored, PAT redacted).
 *   - All batch fetches through bulkExecute (200-per-chunk, isolated).
 *   - WIQL through wiql() builder.
 *   - Sync-back respected (AC file check + @TestCaseId tag reads).
 *   - On-prem safe (orgUrl configured, never hardcoded).
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds, AdoHttpError } from './_helpers/ado_http_client';
import { bulkExecute } from './_helpers/bulk_batcher';
import { createLogger } from './_helpers/structured_logger';
import { wiql } from './_helpers/wiql_builder';
import { getResolvedCreds } from './ado_config_tool';

// =============================================================================
// Relation-name constants.
// =============================================================================

const REL_TESTED_BY_FORWARD = 'Microsoft.VSTS.Common.TestedBy-Forward';
const REL_TESTED_BY_REVERSE = 'Microsoft.VSTS.Common.TestedBy-Reverse';
const REL_HIERARCHY_FORWARD = 'System.LinkTypes.Hierarchy-Forward';
const REL_HIERARCHY_REVERSE = 'System.LinkTypes.Hierarchy-Reverse';

// =============================================================================
// Zod schemas.
// =============================================================================

const InputSchema = z.object({
    iterationPath: z.string().min(1).optional().describe('If omitted, auto-discover via ado_sprint_context (current iteration for the resolved team).'),
    team: z.string().optional(),
    project: z.string().min(1).optional(),
    orgUrl: z.string().url().optional(),
    pat: z.string().min(1).optional(),
    focus: z.enum(['coverage', 'defects', 'automation', 'all']).default('all'),
    outputPath: z.string().min(1).optional(),
    outputFormat: z.enum(['markdown', 'json', 'both']).default('markdown'),
    includeArchivedStories: z.boolean().default(false),
});
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
    ok: z.boolean(),
    iterationPath: z.string().optional(),
    storiesAnalyzed: z.number().default(0),
    reportPath: z.string().optional(),
    jsonPath: z.string().optional(),
    summary: z.object({
        totalStories: z.number(),
        readyToShip: z.number(),
        needsAttention: z.number(),
        blocked: z.number(),
        coverageGaps: z.number(),
        automationDebt: z.number(),
    }).optional(),
    warnings: z.array(z.string()).default([]),
    note: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

// =============================================================================
// Work-item / relation shapes.
// =============================================================================

interface WiRelation {
    rel: string;
    url: string;
    attributes?: Record<string, unknown>;
}

interface WorkItem {
    id: number;
    fields?: Record<string, unknown>;
    relations?: WiRelation[];
}

interface StorySynth {
    id: number;
    title: string;
    state: string;
    assignedTo: string;
    areaPath: string;
    iterationPath: string;
    priority: number | null;
    tags: string[];
    hasACs: boolean;
    acCount: number;
    acsCovered: number;
    uncoveredAcs: Array<{ index: number; tag: string; text: string }>;
    coveragePercent: number;
    linkedTCs: number[];
    automatedTCs: number[];
    manualTCs: number[];
    automationPercent: number;
    lastRunOutcome: 'Passed' | 'Failed' | 'NotRun' | 'Mixed';
    openBugs: Array<{ id: number; title: string; severity: string; state: string; assignedTo: string }>;
    blockers: Array<{ id: number; title: string; severity: string; assignedTo: string }>;
    regressions: Array<{ testCaseId: number; title: string; previousOutcome: string; currentOutcome: string }>;
    readinessScore: number;
    readinessReasons: string[];
    adoUrl: string;
}

interface TestCaseSynth {
    id: number;
    title: string;
    automationStatus: string;
    tags: string[];
    lastRunOutcomes: Array<{ runId: number; outcome: string; completedAt?: string }>;
    latestOutcome: string;
    previousOutcome: string | null;
    linkedStoryIds: number[];
}

interface BugSynth {
    id: number;
    title: string;
    severity: string;
    state: string;
    assignedTo: string;
    linkedStoryIds: number[];
}

// =============================================================================
// Utility helpers.
// =============================================================================

function readField<T = unknown>(fields: Record<string, unknown> | undefined, key: string): T | undefined {
    if (!fields) return undefined;
    return fields[key] as T | undefined;
}

function readStringField(fields: Record<string, unknown> | undefined, key: string, fallback = ''): string {
    const v = readField<unknown>(fields, key);
    if (v == null) return fallback;
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && v !== null && 'displayName' in (v as Record<string, unknown>)) {
        return String((v as { displayName?: string }).displayName ?? fallback);
    }
    return String(v);
}

function readAssignedTo(fields: Record<string, unknown> | undefined): string {
    const v = readField<unknown>(fields, 'System.AssignedTo');
    if (v == null) return '';
    if (typeof v === 'string') return v;
    const rec = v as { displayName?: string; uniqueName?: string; mailAddress?: string };
    return rec.displayName ?? rec.uniqueName ?? rec.mailAddress ?? '';
}

function parseTags(raw: unknown): string[] {
    if (typeof raw !== 'string') return [];
    return raw.split(';').map((t) => t.trim()).filter(Boolean);
}

function extractRelatedIdFromUrl(url: string): number | null {
    // .../_apis/wit/workItems/1234 → 1234
    const m = /\/workItems\/(\d+)(?:\?|$|\/)/i.exec(url);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
}

function buildWiUrl(orgUrl: string, project: string, id: number): string {
    return `${orgUrl.replace(/\/$/, '')}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
}

// =============================================================================
// AC checkpoint reading — respects sync-back.
// =============================================================================

interface AcCheckpoint {
    storyId: number;
    source: string;
    acs: Array<{ index: number; tag: string; text: string }>;
}

function readAcCheckpoint(workspaceRoot: string, storyId: number): AcCheckpoint | null {
    const p = path.join(workspaceRoot, '.cs-qa', 'run-state', `story-${storyId}-acs.json`);
    if (!fs.existsSync(p)) return null;
    try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as AcCheckpoint;
        if (!Array.isArray(raw.acs)) return null;
        return raw;
    } catch {
        return null;
    }
}

// Basic HTML-to-lines parser for AC fallback (matches ado_read_tool behavior).
function parseAcsFromHtml(html: string): Array<{ index: number; tag: string; text: string }> {
    if (!html || !html.trim()) return [];
    const withBreaks = html
        .replace(/<\s*(br|BR)\s*\/?>/g, '\n')
        .replace(/<\s*\/\s*(p|P|div|DIV|li|LI|tr|TR)\s*>/g, '\n')
        .replace(/<\s*(p|P|div|DIV|li|LI|tr|TR)[^>]*>/g, '\n');
    const stripped = withBreaks.replace(/<[^>]+>/g, '');
    const decoded = stripped
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, '\'');
    const lines = decoded.split(/\n+/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    // Strip leading numeric prefixes like "1." or "1)" so equal comparisons work.
    return lines.map((text, i) => ({ index: i + 1, tag: `ac${i + 1}`, text: text.replace(/^\s*\d+[\.)]\s*/, '') }));
}

// =============================================================================
// Feature-file scan — count which AC tags are actually implemented as
// @ac<n> or @ac<n>-* scenario tags anywhere under workspaceRoot/test/**.
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

const AC_TAG_RE = /^@ac(\d+)(?:-|$)/i;

function collectImplementedAcTags(workspaceRoot: string): Set<string> {
    const out = new Set<string>();
    const testRoot = path.join(workspaceRoot, 'test');
    const files = collectFeatureFilesRecursive(testRoot);
    for (const f of files) {
        let content: string;
        try { content = fs.readFileSync(f, 'utf-8'); } catch { continue; }
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!/^@\S/.test(trimmed)) continue;
            for (const t of trimmed.split(/\s+/)) {
                if (!t.startsWith('@')) continue;
                const m = AC_TAG_RE.exec(t);
                if (m) out.add(`ac${m[1]}`);
            }
        }
    }
    return out;
}

// =============================================================================
// ADO queries — WIQL for iteration, batch WI fetch, run fetching.
// =============================================================================

async function queryWorkItemIds(client: AdoHttpClient, iterationPath: string, includeArchived: boolean, warnings: string[]): Promise<number[]> {
    // WIQL for User Story + Feature + Bug in the iteration.
    const q = wiql().select(['[System.Id]']).from('WorkItems');
    const clause = q.where().in('[System.WorkItemType]', ['User Story', 'Feature', 'Bug', 'Requirement', 'Product Backlog Item']);
    clause.and().iteration(iterationPath);
    if (!includeArchived) {
        clause.and().notEquals('[System.State]', 'Removed');
    }
    const query = q.build();
    try {
        const res = await client.post<{ workItems?: Array<{ id: number }> }>(`_apis/wit/wiql?api-version=7.1`, { query });
        return (res.workItems ?? []).map((w) => Number(w.id)).filter((n) => Number.isFinite(n) && n > 0);
    } catch (e) {
        const err = e as AdoHttpError | Error;
        warnings.push(`WIQL query failed: ${err.message.slice(0, 250)}`);
        return [];
    }
}

async function batchFetchWorkItems(client: AdoHttpClient, ids: number[], warnings: string[]): Promise<Map<number, WorkItem>> {
    const out = new Map<number, WorkItem>();
    if (ids.length === 0) return out;
    const fields = [
        'System.Id',
        'System.Title',
        'System.State',
        'System.WorkItemType',
        'System.AssignedTo',
        'System.AreaPath',
        'System.IterationPath',
        'System.Tags',
        'System.CreatedDate',
        'System.ChangedDate',
        'Microsoft.VSTS.Common.Priority',
        'Microsoft.VSTS.Common.Severity',
        'Microsoft.VSTS.Common.AcceptanceCriteria',
        'Microsoft.VSTS.TCM.AutomationStatus',
        'Microsoft.VSTS.TCM.AutomatedTestName',
        'Microsoft.VSTS.TCM.AutomatedTestStorage',
        'Microsoft.VSTS.TCM.AutomatedTestId',
    ].join(',');
    const bulk = await bulkExecute<number, WorkItem>(ids, {
        chunkSize: 200,
        concurrency: 2,
        workFn: async (chunk) => {
            const csv = chunk.join(',');
            // $expand=relations gives us TestedBy links; note: fields and $expand cannot both be used with a comma-separated fields list — use $expand=all which returns fields plus relations.
            const data = await client.get<{ value?: WorkItem[] }>(
                `_apis/wit/workitems?ids=${csv}&fields=${fields}&api-version=7.1`,
            );
            const returned = data?.value ?? [];
            const byId = new Map<number, WorkItem>();
            for (const w of returned) byId.set(Number(w.id), w);
            return chunk.map((id) => byId.get(id) ?? { id });
        },
        onChunkError: (err, _chunk, chunkIndex) => {
            warnings.push(`workitems batch ${chunkIndex + 1} failed: ${err.message.slice(0, 200)}`);
        },
    });
    for (const w of bulk.ok) if (typeof w.id === 'number') out.set(w.id, w);
    return out;
}

async function batchFetchWorkItemsWithRelations(client: AdoHttpClient, ids: number[], warnings: string[]): Promise<Map<number, WorkItem>> {
    const out = new Map<number, WorkItem>();
    if (ids.length === 0) return out;
    // When $expand is used, ADO doesn't honor `fields` — you get all fields.
    // We batch smaller (100) because the per-item payload is heavier.
    const bulk = await bulkExecute<number, WorkItem>(ids, {
        chunkSize: 100,
        concurrency: 2,
        workFn: async (chunk) => {
            const csv = chunk.join(',');
            const data = await client.get<{ value?: WorkItem[] }>(
                `_apis/wit/workitems?ids=${csv}&$expand=relations&api-version=7.1`,
            );
            const returned = data?.value ?? [];
            const byId = new Map<number, WorkItem>();
            for (const w of returned) byId.set(Number(w.id), w);
            return chunk.map((id) => byId.get(id) ?? { id });
        },
        onChunkError: (err, _chunk, chunkIndex) => {
            warnings.push(`workitems (relations) batch ${chunkIndex + 1} failed: ${err.message.slice(0, 200)}`);
        },
    });
    for (const w of bulk.ok) if (typeof w.id === 'number') out.set(w.id, w);
    return out;
}

interface RunResult {
    id: number;
    testRun: { id: number; name?: string };
    testCase?: { id?: number | string };
    outcome: string;
    completedDate?: string;
    startedDate?: string;
}

async function fetchLatestResultsForTestCase(
    client: AdoHttpClient,
    testCaseId: number,
    warnings: string[],
): Promise<Array<{ runId: number; outcome: string; completedAt?: string }>> {
    // Cross-run TCM query: POST /_apis/test/results/query filtered by testCase ref.
    // We use the simpler `_apis/test/runs?api-version=7.1&$top=5` scoped to any
    // run that references this test case. ADO doesn't have a first-class "recent
    // runs for TC" endpoint on-prem; the results/query API is used instead.
    // Payload: { fields: ['Outcome','TestRun','CompletedDate'], testCaseReference: { id } }
    // On failure or unsupported, degrade gracefully.
    try {
        const body = {
            fields: ['Outcome', 'TestRun', 'CompletedDate', 'StartedDate'],
            testCaseReference: { id: testCaseId },
            $top: 5,
        };
        const res = await client.post<{ results?: RunResult[]; value?: RunResult[] }>(
            `_apis/test/results/query?api-version=7.1`,
            body,
        );
        const rows = res?.results ?? res?.value ?? [];
        const shaped: Array<{ runId: number; outcome: string; completedAt?: string }> = [];
        for (const r of rows) {
            const runId = Number(r.testRun?.id ?? 0);
            if (!runId) continue;
            shaped.push({ runId, outcome: r.outcome ?? 'Unspecified', completedAt: r.completedDate });
        }
        // Sort DESC by completedAt for consistent "latest first".
        shaped.sort((a, b) => {
            const da = a.completedAt ? Date.parse(a.completedAt) : 0;
            const db = b.completedAt ? Date.parse(b.completedAt) : 0;
            return db - da;
        });
        return shaped.slice(0, 5);
    } catch (e) {
        const err = e as AdoHttpError | Error;
        // Degraded — some on-prem instances don't expose /test/results/query.
        // We tolerate this without failing the whole tool.
        if (warnings.length < 5) warnings.push(`test-results query for TC ${testCaseId} unavailable: ${err.message.slice(0, 150)}`);
        return [];
    }
}

// =============================================================================
// Story synthesis — combine WI + relations + TC + results into StorySynth.
// =============================================================================

interface WorkItemBundle {
    workItems: Map<number, WorkItem>;
    workItemsWithRelations: Map<number, WorkItem>;
    testCaseFields: Map<number, WorkItem>;
    testCaseResults: Map<number, Array<{ runId: number; outcome: string; completedAt?: string }>>;
    bugsById: Map<number, WorkItem>;
    bugTestedByTc: Map<number, number[]>; // bugId -> [tcId,...]
}

function classifyTypeFromWi(wi: WorkItem): string {
    return String(readStringField(wi.fields, 'System.WorkItemType', 'Unknown'));
}

function synthesizeStory(
    story: WorkItem,
    bundle: WorkItemBundle,
    workspaceRoot: string,
    implementedAcTags: Set<string>,
    orgUrl: string,
    project: string,
): StorySynth {
    const id = Number(story.id);
    const relations = story.relations ?? [];
    const tcIds = relations
        .filter((r) => r.rel === REL_TESTED_BY_FORWARD)
        .map((r) => extractRelatedIdFromUrl(r.url))
        .filter((n): n is number => n !== null);

    // AC computation.
    const checkpoint = readAcCheckpoint(workspaceRoot, id);
    const acHtml = readStringField(story.fields, 'Microsoft.VSTS.Common.AcceptanceCriteria');
    const acs = checkpoint?.acs ?? parseAcsFromHtml(acHtml);
    const uncoveredAcs = acs.filter((a) => !implementedAcTags.has(a.tag));
    const acCount = acs.length;
    const acsCovered = acCount - uncoveredAcs.length;
    const coveragePercent = acCount === 0 ? 0 : Math.round((acsCovered / acCount) * 100);

    // TC automation split.
    const automated: number[] = [];
    const manual: number[] = [];
    const testCaseResults = new Map<number, string>();
    const testCasePrevious = new Map<number, string | null>();
    for (const tcId of tcIds) {
        const tc = bundle.testCaseFields.get(tcId);
        const status = readStringField(tc?.fields, 'Microsoft.VSTS.TCM.AutomationStatus');
        if (status === 'Automated') automated.push(tcId);
        else manual.push(tcId);
        const results = bundle.testCaseResults.get(tcId) ?? [];
        testCaseResults.set(tcId, results[0]?.outcome ?? 'NotRun');
        testCasePrevious.set(tcId, results[1]?.outcome ?? null);
    }
    const automationPercent = tcIds.length === 0 ? 0 : Math.round((automated.length / tcIds.length) * 100);

    // Latest run outcome (aggregate across TCs).
    let outcomes: string[] = [];
    for (const tcId of tcIds) outcomes.push(testCaseResults.get(tcId) ?? 'NotRun');
    outcomes = outcomes.filter((o) => o && o !== 'Unspecified');
    let lastRunOutcome: StorySynth['lastRunOutcome'] = 'NotRun';
    if (outcomes.length === 0) lastRunOutcome = 'NotRun';
    else {
        const hasPass = outcomes.some((o) => o === 'Passed');
        const hasFail = outcomes.some((o) => o === 'Failed');
        if (hasPass && hasFail) lastRunOutcome = 'Mixed';
        else if (hasFail) lastRunOutcome = 'Failed';
        else if (hasPass) lastRunOutcome = 'Passed';
        else lastRunOutcome = 'NotRun';
    }

    // Regressions — was Passed previously, Failed now.
    const regressions: StorySynth['regressions'] = [];
    for (const tcId of tcIds) {
        const cur = testCaseResults.get(tcId);
        const prev = testCasePrevious.get(tcId);
        if (cur === 'Failed' && prev === 'Passed') {
            const tc = bundle.testCaseFields.get(tcId);
            regressions.push({
                testCaseId: tcId,
                title: readStringField(tc?.fields, 'System.Title', `(tc ${tcId})`),
                previousOutcome: prev,
                currentOutcome: cur,
            });
        }
    }

    // Bugs — walk bugTestedByTc: bug B links to TC T; if T is in this story's tcIds, associate the bug.
    // Also include bugs with direct hierarchy (Story is parent of Bug) — checked via bug.relations.
    const bugMap = bundle.bugsById;
    const openBugs: StorySynth['openBugs'] = [];
    const blockers: StorySynth['blockers'] = [];
    const seenBugs = new Set<number>();
    for (const [bugId, bug] of bugMap) {
        const bugTcIds = bundle.bugTestedByTc.get(bugId) ?? [];
        const bugParentRelation = (bug.relations ?? []).find((r) => r.rel === REL_HIERARCHY_REVERSE);
        const parentId = bugParentRelation ? extractRelatedIdFromUrl(bugParentRelation.url) : null;
        const linksToTc = bugTcIds.some((t) => tcIds.includes(t));
        const parentIsStory = parentId === id;
        if (!linksToTc && !parentIsStory) continue;
        if (seenBugs.has(bugId)) continue;
        seenBugs.add(bugId);
        const bState = readStringField(bug.fields, 'System.State');
        const bSeverity = readStringField(bug.fields, 'Microsoft.VSTS.Common.Severity', 'Unspecified');
        const bTitle = readStringField(bug.fields, 'System.Title', `(bug ${bugId})`);
        const bAssignedTo = readAssignedTo(bug.fields);
        const isOpen = bState !== 'Closed' && bState !== 'Resolved' && bState !== 'Removed' && bState !== 'Done';
        if (!isOpen) continue;
        openBugs.push({ id: bugId, title: bTitle, severity: bSeverity, state: bState, assignedTo: bAssignedTo });
        if (/^1\b|^2\b|^Sev\s*1|^Sev\s*2|Critical|Blocker/i.test(bSeverity)) {
            blockers.push({ id: bugId, title: bTitle, severity: bSeverity, assignedTo: bAssignedTo });
        }
    }

    // Readiness score = coverage×0.3 + automation×0.2 + latestPass×0.3 + noBlockers×0.2
    const coverageFrac = acCount === 0 ? (tcIds.length > 0 ? 1.0 : 0.5) : (acsCovered / acCount);
    const automationFrac = tcIds.length === 0 ? 0 : (automated.length / tcIds.length);
    const latestPassFrac =
        lastRunOutcome === 'Passed' ? 1.0
            : lastRunOutcome === 'Mixed' ? 0.5
                : lastRunOutcome === 'NotRun' ? 0.0
                    : 0.0; // Failed
    const noBlockersFrac = blockers.length === 0 ? 1.0 : 0.0;
    const readinessScore = coverageFrac * 0.3 + automationFrac * 0.2 + latestPassFrac * 0.3 + noBlockersFrac * 0.2;
    const readinessReasons: string[] = [];
    readinessReasons.push(`coverage ${Math.round(coverageFrac * 100)}%`);
    readinessReasons.push(`automation ${Math.round(automationFrac * 100)}%`);
    readinessReasons.push(`latest-run ${lastRunOutcome}`);
    readinessReasons.push(blockers.length === 0 ? 'no Sev1/Sev2 blockers' : `${blockers.length} blocker(s)`);

    return {
        id,
        title: readStringField(story.fields, 'System.Title', `(story ${id})`),
        state: readStringField(story.fields, 'System.State'),
        assignedTo: readAssignedTo(story.fields),
        areaPath: readStringField(story.fields, 'System.AreaPath'),
        iterationPath: readStringField(story.fields, 'System.IterationPath'),
        priority: (() => { const v = readField<number>(story.fields, 'Microsoft.VSTS.Common.Priority'); return typeof v === 'number' ? v : null; })(),
        tags: parseTags(readField(story.fields, 'System.Tags')),
        hasACs: acCount > 0,
        acCount,
        acsCovered,
        uncoveredAcs,
        coveragePercent,
        linkedTCs: tcIds,
        automatedTCs: automated,
        manualTCs: manual,
        automationPercent,
        lastRunOutcome,
        openBugs,
        blockers,
        regressions,
        readinessScore: Math.round(readinessScore * 1000) / 1000,
        readinessReasons,
        adoUrl: buildWiUrl(orgUrl, project, id),
    };
}

// =============================================================================
// Report rendering.
// =============================================================================

function renderMarkdown(iterationPath: string, stories: StorySynth[], focus: Input['focus'], warnings: string[]): string {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
    const sortById = (a: StorySynth, b: StorySynth): number => a.id - b.id;
    const readyToShip = stories.filter((s) => s.readinessScore >= 0.9).slice().sort(sortById);
    const needsAttention = stories.filter((s) => s.readinessScore >= 0.5 && s.readinessScore < 0.9)
        .slice()
        .sort((a, b) => a.readinessScore - b.readinessScore);
    const blocked = stories.filter((s) => s.blockers.length > 0).slice().sort(sortById);
    const coverageGaps = stories.filter((s) => s.acCount > 0 && s.acsCovered < s.acCount).slice().sort(sortById);
    const automationDebt = stories.filter((s) => s.linkedTCs.length > 0 && s.automationPercent < 80).slice().sort(sortById);
    const regressions = stories.filter((s) => s.regressions.length > 0).slice().sort(sortById);
    const byState = stories.reduce<Record<string, number>>((acc, s) => {
        const k = s.state || '(unspecified)';
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
    }, {});

    const lines: string[] = [];
    lines.push(`# Sprint watcher — ${iterationPath}`);
    lines.push('');
    lines.push(`Generated: ${now}  \\  Focus: ${focus}  \\  Stories: ${stories.length}`);
    lines.push('');

    // Section: Sprint status
    lines.push('## Sprint status');
    lines.push('');
    lines.push(`| Metric | Count |`);
    lines.push(`|---|---|`);
    lines.push(`| Total stories | ${stories.length} |`);
    for (const [state, n] of Object.entries(byState).sort()) {
        lines.push(`| State: ${state} | ${n} |`);
    }
    lines.push(`| Ready to ship (>= 0.90) | ${readyToShip.length} |`);
    lines.push(`| Needs attention (0.50 - 0.89) | ${needsAttention.length} |`);
    lines.push(`| Blocked (Sev1/Sev2 open) | ${blocked.length} |`);
    lines.push('');

    if (focus === 'all' || focus === 'coverage' || focus === 'automation' || focus === 'defects') {
        // Section: Ready to ship
        lines.push('## Ready to ship');
        lines.push('');
        if (readyToShip.length === 0) {
            lines.push('_None yet._');
        } else {
            lines.push('| Story | Title | Score | Coverage | Automation | Last run |');
            lines.push('|---|---|---|---|---|---|');
            for (const s of readyToShip) {
                lines.push(`| [${s.id}](${s.adoUrl}) | ${escapeCell(s.title)} | ${s.readinessScore.toFixed(2)} | ${s.coveragePercent}% | ${s.automationPercent}% | ${s.lastRunOutcome} |`);
            }
        }
        lines.push('');

        // Section: Needs attention
        lines.push('## Needs attention');
        lines.push('');
        if (needsAttention.length === 0) {
            lines.push('_None._');
        } else {
            lines.push('| Story | Title | Score | Reasons |');
            lines.push('|---|---|---|---|');
            for (const s of needsAttention) {
                lines.push(`| [${s.id}](${s.adoUrl}) | ${escapeCell(s.title)} | ${s.readinessScore.toFixed(2)} | ${escapeCell(s.readinessReasons.join('; '))} |`);
            }
        }
        lines.push('');
    }

    if (focus === 'all' || focus === 'defects') {
        // Section: Blocked
        lines.push('## Blocked (open Sev1/Sev2 bugs)');
        lines.push('');
        if (blocked.length === 0) {
            lines.push('_None._');
        } else {
            for (const s of blocked) {
                lines.push(`### Story [${s.id}](${s.adoUrl}) — ${s.title}`);
                lines.push('');
                lines.push('| Bug | Severity | State | Assigned to |');
                lines.push('|---|---|---|---|');
                for (const b of s.blockers) {
                    lines.push(`| ${b.id} | ${escapeCell(b.severity)} | (open) | ${escapeCell(b.assignedTo)} |`);
                }
                lines.push('');
            }
        }
    }

    if (focus === 'all' || focus === 'coverage') {
        // Section: Coverage gaps
        lines.push('## Coverage gaps');
        lines.push('');
        if (coverageGaps.length === 0) {
            lines.push('_None — every AC covered._');
        } else {
            for (const s of coverageGaps) {
                lines.push(`### Story [${s.id}](${s.adoUrl}) — ${s.title}`);
                lines.push('');
                lines.push(`ACs covered: ${s.acsCovered}/${s.acCount} (${s.coveragePercent}%)`);
                lines.push('');
                lines.push('Uncovered ACs:');
                for (const ac of s.uncoveredAcs) {
                    lines.push(`- \`@${ac.tag}\` — ${escapeCell(ac.text)}`);
                }
                lines.push('');
            }
        }
    }

    if (focus === 'all' || focus === 'automation') {
        // Section: Automation debt
        lines.push('## Automation debt');
        lines.push('');
        if (automationDebt.length === 0) {
            lines.push('_None — every story >= 80% automated._');
        } else {
            for (const s of automationDebt) {
                lines.push(`### Story [${s.id}](${s.adoUrl}) — ${s.title}`);
                lines.push('');
                lines.push(`Automation: ${s.automatedTCs.length}/${s.linkedTCs.length} (${s.automationPercent}%)`);
                if (s.manualTCs.length > 0) {
                    lines.push('');
                    lines.push('Manual TCs:');
                    for (const tcId of s.manualTCs) lines.push(`- TC ${tcId}`);
                }
                lines.push('');
            }
        }
    }

    if (focus === 'all' || focus === 'defects') {
        // Section: Recent regressions
        lines.push('## Recent regressions');
        lines.push('');
        if (regressions.length === 0) {
            lines.push('_None — no TC flipped from Passed to Failed._');
        } else {
            for (const s of regressions) {
                lines.push(`### Story [${s.id}](${s.adoUrl}) — ${s.title}`);
                lines.push('');
                lines.push('| Test case | Title | Previous | Current |');
                lines.push('|---|---|---|---|');
                for (const r of s.regressions) {
                    lines.push(`| ${r.testCaseId} | ${escapeCell(r.title)} | ${r.previousOutcome} | ${r.currentOutcome} |`);
                }
                lines.push('');
            }
        }
    }

    if (warnings.length > 0) {
        lines.push('## Warnings');
        lines.push('');
        for (const w of warnings) lines.push(`- ${escapeCell(w)}`);
        lines.push('');
    }

    return lines.join('\n');
}

function escapeCell(s: string): string {
    return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

// =============================================================================
// Iteration path auto-discovery — re-uses ado_sprint_context path when
// available via getPrimitive, but avoids a circular import by inlining a
// minimal fetch of "current iteration".
// =============================================================================

async function autoDiscoverIterationPath(client: AdoHttpClient, project: string, team: string | undefined, warnings: string[]): Promise<string | null> {
    // Try to resolve default team when not provided.
    let resolvedTeam = team;
    if (!resolvedTeam) {
        try {
            const proj = await client.get<{ defaultTeam?: { name?: string } }>(
                `_apis/projects/${encodeURIComponent(project)}?api-version=7.1`,
                { scopeToProject: false },
            );
            resolvedTeam = proj?.defaultTeam?.name;
        } catch (e) {
            const err = e as AdoHttpError | Error;
            warnings.push(`default-team resolve failed: ${err.message.slice(0, 200)}`);
        }
    }
    if (!resolvedTeam) return null;
    try {
        const iterationUrl = `${encodeURIComponent(project)}/${encodeURIComponent(resolvedTeam)}/_apis/work/teamsettings/iterations?api-version=7.1&$timeframe=current`;
        const data = await client.get<{ value?: Array<{ path?: string; name?: string }> }>(
            iterationUrl,
            { scopeToProject: false },
        );
        const first = data?.value?.[0];
        return first?.path ?? null;
    } catch (e) {
        const err = e as AdoHttpError | Error;
        warnings.push(`iteration auto-discovery failed: ${err.message.slice(0, 200)}`);
        return null;
    }
}

// =============================================================================
// Registration.
// =============================================================================

registerPrimitive<Input, Output>({
    name: 'cs_qa_sprint_watcher',
    description:
        'One-shot end-to-end sprint analysis. Pulls Stories/Features/Bugs from the target iteration, walks TestedBy relations to Test Cases, fetches latest run outcomes, and computes per-story readiness scores. Writes a morning-brief markdown report (default: .cs-qa/reports/sprint-YYYY-MM-DD.md) covering: Sprint status, Ready to ship, Needs attention, Blocked, Coverage gaps, Automation debt, Recent regressions. Focus filter (coverage/defects/automation/all). Iteration auto-discovered via team default when omitted.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input): Promise<Output> => {
        const logger = createLogger(ctx.invocationId, 'cs_qa_sprint_watcher', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];

        // Resolve creds.
        const credsResult = getResolvedCreds(ctx.workspaceRoot, {
            orgUrl: input.orgUrl,
            project: input.project,
            personalAccessToken: input.pat,
        });
        if (!credsResult.creds) {
            logger.error('ADO not configured', { note: credsResult.diagnostic });
            return { ok: false, warnings: [credsResult.diagnostic], note: 'ADO not configured', storiesAnalyzed: 0 };
        }
        const cfg: AdoCreds = credsResult.creds;
        const client = new AdoHttpClient(cfg);

        // Determine iteration path.
        let iterationPath = input.iterationPath;
        if (!iterationPath) {
            iterationPath = (await autoDiscoverIterationPath(client, cfg.project, input.team, warnings)) ?? undefined;
        }
        if (!iterationPath) {
            logger.error('iteration not resolved');
            return { ok: false, warnings: [...warnings, 'Could not resolve iteration path (none provided and auto-discovery failed).'], note: 'iteration missing', storiesAnalyzed: 0 };
        }
        logger.info('iteration resolved', { iterationPath });

        // 1. WIQL query.
        const allIds = await queryWorkItemIds(client, iterationPath, input.includeArchivedStories, warnings);
        logger.info('wiql returned', { count: allIds.length, iterationPath });
        if (allIds.length === 0) {
            // Empty iteration — still render a clean report.
            const md = renderMarkdown(iterationPath, [], input.focus, warnings);
            const outputPath = writeReport(ctx.workspaceRoot, input, md, [], iterationPath);
            return {
                ok: true,
                iterationPath,
                storiesAnalyzed: 0,
                reportPath: outputPath.markdown,
                jsonPath: outputPath.json,
                summary: {
                    totalStories: 0, readyToShip: 0, needsAttention: 0, blocked: 0, coverageGaps: 0, automationDebt: 0,
                },
                warnings,
                note: 'iteration empty',
            };
        }

        // 2. Batch-fetch WI fields.
        const workItems = await batchFetchWorkItems(client, allIds, warnings);

        // 3. Partition by type.
        const storyLike: number[] = [];
        const bugIds: number[] = [];
        for (const [id, wi] of workItems) {
            const t = classifyTypeFromWi(wi);
            if (t === 'User Story' || t === 'Product Backlog Item' || t === 'Requirement' || t === 'Feature') storyLike.push(id);
            else if (t === 'Bug') bugIds.push(id);
        }
        logger.info('partitioned', { stories: storyLike.length, bugs: bugIds.length });

        // 4. Batch-fetch stories WITH relations (for TestedBy links).
        const storiesWithRelations = await batchFetchWorkItemsWithRelations(client, storyLike, warnings);

        // 5. Batch-fetch bugs WITH relations (for TestedBy-Reverse + Parent).
        // `batchFetchWorkItemsWithRelations` already returns a Map<number, WorkItem>,
        // so pass it directly to downstream — copying into a second Map was a redundant
        // pass that also risked drifting from bugsWithRelations if either side mutated.
        const bugsWithRelations = await batchFetchWorkItemsWithRelations(client, bugIds, warnings);

        // 6. Collect all TC ids from story relations.
        const tcIdSet = new Set<number>();
        for (const [, wi] of storiesWithRelations) {
            for (const r of (wi.relations ?? [])) {
                if (r.rel === REL_TESTED_BY_FORWARD) {
                    const id = extractRelatedIdFromUrl(r.url);
                    if (id !== null) tcIdSet.add(id);
                }
            }
        }
        // Include TCs referenced by bugs' TestedBy-Reverse relations.
        const bugTestedByTc = new Map<number, number[]>();
        for (const [bugId, wi] of bugsWithRelations) {
            const linked: number[] = [];
            for (const r of (wi.relations ?? [])) {
                if (r.rel === REL_TESTED_BY_REVERSE || r.rel === REL_TESTED_BY_FORWARD) {
                    const id = extractRelatedIdFromUrl(r.url);
                    if (id !== null) linked.push(id);
                }
            }
            bugTestedByTc.set(bugId, linked);
            for (const t of linked) tcIdSet.add(t);
        }
        const tcIds = Array.from(tcIdSet);
        logger.info('tcs enumerated', { count: tcIds.length });

        // 7. Batch-fetch TC fields.
        const testCaseFields = await batchFetchWorkItems(client, tcIds, warnings);

        // 8. Fetch latest results per TC (bounded parallelism to avoid overload).
        const resultsMap = new Map<number, Array<{ runId: number; outcome: string; completedAt?: string }>>();
        const resultsBulk = await bulkExecute<number, { tcId: number; rows: Array<{ runId: number; outcome: string; completedAt?: string }> }>(
            tcIds,
            {
                chunkSize: 1,
                concurrency: 6,
                workFn: async (chunk) => {
                    const out: Array<{ tcId: number; rows: Array<{ runId: number; outcome: string; completedAt?: string }> }> = [];
                    for (const tcId of chunk) {
                        const rows = await fetchLatestResultsForTestCase(client, tcId, warnings);
                        out.push({ tcId, rows });
                    }
                    return out;
                },
                onChunkError: (err, chunk) => {
                    warnings.push(`results fetch for TC ${chunk[0]} failed: ${err.message.slice(0, 150)}`);
                },
            },
        );
        for (const { tcId, rows } of resultsBulk.ok) resultsMap.set(tcId, rows);

        // 9. Scan feature files for implemented AC tags.
        const implementedAcTags = collectImplementedAcTags(ctx.workspaceRoot);

        // 10. Synthesize per-story.
        const bundle: WorkItemBundle = {
            workItems,
            workItemsWithRelations: storiesWithRelations,
            testCaseFields,
            testCaseResults: resultsMap,
            bugsById: bugsWithRelations,
            bugTestedByTc,
        };
        const stories: StorySynth[] = [];
        for (const [id, wi] of storiesWithRelations) {
            const t = classifyTypeFromWi(wi);
            if (t === 'Bug') continue;
            stories.push(synthesizeStory(wi, bundle, ctx.workspaceRoot, implementedAcTags, cfg.orgUrl, cfg.project));
        }
        stories.sort((a, b) => a.id - b.id);

        // 11. Render + write.
        const md = renderMarkdown(iterationPath, stories, input.focus, warnings);
        const outputPath = writeReport(ctx.workspaceRoot, input, md, stories, iterationPath);

        const summary = {
            totalStories: stories.length,
            readyToShip: stories.filter((s) => s.readinessScore >= 0.9).length,
            needsAttention: stories.filter((s) => s.readinessScore >= 0.5 && s.readinessScore < 0.9).length,
            blocked: stories.filter((s) => s.blockers.length > 0).length,
            coverageGaps: stories.filter((s) => s.acCount > 0 && s.acsCovered < s.acCount).length,
            automationDebt: stories.filter((s) => s.linkedTCs.length > 0 && s.automationPercent < 80).length,
        };
        logger.info('sprint watcher complete', { iterationPath, ...summary });

        return {
            ok: true,
            iterationPath,
            storiesAnalyzed: stories.length,
            reportPath: outputPath.markdown,
            jsonPath: outputPath.json,
            summary,
            warnings,
        };
    },
});

// =============================================================================
// Report file writer.
// =============================================================================

function writeReport(workspaceRoot: string, input: Input, md: string, stories: StorySynth[], iterationPath: string): { markdown?: string; json?: string } {
    const today = new Date().toISOString().slice(0, 10);
    const defaultBase = path.join(workspaceRoot, '.cs-qa', 'reports', `sprint-${today}.md`);
    const outputBase = input.outputPath ? path.resolve(workspaceRoot, input.outputPath) : defaultBase;
    fs.mkdirSync(path.dirname(outputBase), { recursive: true });
    const out: { markdown?: string; json?: string } = {};
    const wantMd = input.outputFormat === 'markdown' || input.outputFormat === 'both';
    const wantJson = input.outputFormat === 'json' || input.outputFormat === 'both';
    if (wantMd) {
        const mdPath = outputBase.endsWith('.md') ? outputBase : outputBase.replace(/\.[^.]+$/, '.md');
        fs.writeFileSync(mdPath, md, 'utf-8');
        out.markdown = mdPath;
    }
    if (wantJson) {
        const jsonPath = outputBase.endsWith('.json') ? outputBase : outputBase.replace(/\.[^.]+$/, '.json');
        fs.writeFileSync(jsonPath, JSON.stringify({ iterationPath, generatedAt: new Date().toISOString(), stories }, null, 2), 'utf-8');
        out.json = jsonPath;
    }
    return out;
}
