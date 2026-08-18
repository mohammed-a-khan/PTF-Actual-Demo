/**
 * cs_qa_sprint_ops — single verb-driven primitive covering the daily QA
 * sprint cycle without proliferating six separate tools. One entry point,
 * six verbs, discriminated-union input.
 *
 * Verbs:
 *   my-queue              → list QA-scoped stories assigned to me (or another
 *                            user) in the current iteration
 *   claim-story           → mark a story as being worked by QA
 *   post-checkpoint       → append a structured status comment on a WI
 *   summary               → sprint-scoped QA rollup (states, TCs, runs, cycle)
 *   link-work-items       → create typed links between arbitrary WIs
 *   find-tests-for-story  → reverse lookup story → TCs + local spec/feature files
 *
 * Design tenets:
 *   • Two-phase confirmation gate on mutating verbs (claim-story, post-checkpoint,
 *     link-work-items). The first invocation returns requiresConfirmation:true
 *     with a preview; retrying with confirmed:true executes.
 *   • Read-only verbs (my-queue, summary, find-tests-for-story) run
 *     immediately, no confirmation required.
 *   • All HTTP through AdoHttpClient — Retry-After honored, PAT redacted.
 *   • All WIQL through wiql() builder — apostrophe-safe.
 *   • All batching through bulkExecute for link-work-items when targets > 1.
 *   • All logging through createLogger (append-only audit JSONL).
 *   • On-prem safe — no cloud-only URL literals.
 */

import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { wiql } from './_helpers/wiql_builder';
import { bulkExecute } from './_helpers/bulk_batcher';
import { getResolvedCreds } from './ado_config_tool';

// ---------------------------------------------------------------------------
// Shared cred fields — every verb accepts explicit overrides that flow
// through the six-tier resolver in cs_qa_ado_config.
// ---------------------------------------------------------------------------

const credFields = {
    orgUrl: z.string().optional().describe('Explicit ADO org URL override. When omitted, resolves via cs_qa_ado_config cascade.'),
    project: z.string().optional().describe('Explicit ADO project override. When omitted, resolves via cs_qa_ado_config cascade.'),
    pat: z.string().optional().describe('Explicit PAT override. When omitted, resolves via cs_qa_ado_config cascade.'),
};

// ---------------------------------------------------------------------------
// Verb schemas
// ---------------------------------------------------------------------------

const MyQueueInput = z.object({
    verb: z.literal('my-queue'),
    assignedTo: z.string().optional().describe('User to filter by (email / display name / @Me). Default: current authenticated user via /_apis/connectionData.'),
    iterationPath: z.string().optional().describe('Iteration path filter. Default: current sprint auto-discovered from team settings.'),
    states: z.array(z.string()).optional().describe('WI states to include. Default: [New, Active, Ready for QA].'),
    workItemTypes: z.array(z.string()).optional().describe('WI types to include. Default: [User Story, Feature, Bug].'),
    limit: z.number().int().positive().max(500).default(50),
    team: z.string().optional().describe('Team name for iteration lookup. Default: project default team.'),
    ...credFields,
});

const ClaimStoryInput = z.object({
    verb: z.literal('claim-story'),
    storyId: z.number().int().positive().describe('Work item id to claim.'),
    assignTo: z.string().optional().describe('User to assign the WI to. Default: current authenticated user.'),
    state: z.string().default('Active').describe('State to set on claim. Default: Active.'),
    comment: z.string().optional().describe('History comment. Default: a neutral "Claimed by QA" line.'),
    confirmed: z.boolean().default(false).describe('Two-phase gate — set true on the second call to actually write.'),
    ...credFields,
});

const PostCheckpointInput = z.object({
    verb: z.literal('post-checkpoint'),
    workItemId: z.number().int().positive().describe('Target WI id.'),
    phase: z.enum(['analysis', 'drafting', 'automation', 'execution', 'blocked', 'signed-off']).optional(),
    summary: z.string().min(5).describe('Human-readable summary (min 5 chars). Body of the comment.'),
    blockers: z.array(z.string()).optional().describe('Bullet list of blockers.'),
    tcsCovered: z.array(z.number().int().positive()).optional().describe('Test case ids covered so far.'),
    openIssues: z.array(z.string()).optional().describe('Free-form open questions or defects.'),
    confirmed: z.boolean().default(false).describe('Two-phase gate — set true to actually write.'),
    ...credFields,
});

const SummaryInput = z.object({
    verb: z.literal('summary'),
    iterationPath: z.string().optional().describe('Iteration path scope. Default: current sprint.'),
    areaPath: z.string().optional().describe('Optional area-path narrowing.'),
    includeMetrics: z.boolean().default(true).describe('When true, also aggregates test-run pass/fail stats and cycle time.'),
    team: z.string().optional(),
    ...credFields,
});

const LinkTypeEnum = z.enum([
    'tested-by',
    'tests',
    'parent-child',
    'related',
    'duplicate-of',
    'predecessor',
    'successor',
    'affects',
    'affected-by',
]);

const LinkWorkItemsInput = z.object({
    verb: z.literal('link-work-items'),
    sourceId: z.number().int().positive(),
    targetIds: z.array(z.number().int().positive()).min(1),
    linkType: LinkTypeEnum,
    comment: z.string().optional(),
    confirmed: z.boolean().default(false),
    ...credFields,
});

const FindTestsForStoryInput = z.object({
    verb: z.literal('find-tests-for-story'),
    storyId: z.number().int().positive(),
    includeLocalFiles: z.boolean().default(true).describe('Scan test/**/*.feature and test/**/*.spec.ts for @LinkedStory:<id> / @story-<id> markers.'),
    includeAdoTcs: z.boolean().default(true).describe('Follow TestedBy-Forward links on the story to enumerate ADO Test Cases.'),
    localScanRoot: z.string().optional().describe('Root dir for local scan. Default: <workspaceRoot>/test.'),
    ...credFields,
});

const InputSchema = z.discriminatedUnion('verb', [
    MyQueueInput,
    ClaimStoryInput,
    PostCheckpointInput,
    SummaryInput,
    LinkWorkItemsInput,
    FindTestsForStoryInput,
]);
type Input = z.infer<typeof InputSchema>;

// ---------------------------------------------------------------------------
// Output schemas — one union per verb keeps the surface honest.
// ---------------------------------------------------------------------------

const QueueItem = z.object({
    id: z.number(),
    title: z.string(),
    type: z.string(),
    state: z.string(),
    priority: z.number().nullable(),
    tags: z.array(z.string()),
    url: z.string(),
    assignedTo: z.string().nullable(),
});

const AdoTcRef = z.object({
    id: z.number(),
    title: z.string(),
    url: z.string(),
    state: z.string(),
});

const LocalScenario = z.object({
    path: z.string(),
    scenarios: z.array(z.string()),
});

const LocalSpec = z.object({
    path: z.string(),
    tests: z.array(z.string()),
});

const LinkResult = z.object({
    sourceId: z.number(),
    targetId: z.number(),
    rel: z.string(),
    ok: z.boolean(),
    warnings: z.array(z.string()),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    verb: z.string(),
    requiresConfirmation: z.boolean().optional(),
    destructive: z.boolean().optional(),
    confirmationHint: z.string().optional(),
    preview: z.record(z.string(), z.unknown()).optional(),

    // my-queue
    items: z.array(QueueItem).optional(),
    aggregate: z.object({
        byState: z.record(z.string(), z.number()),
        byType: z.record(z.string(), z.number()),
        count: z.number(),
    }).optional(),
    iterationUsed: z.string().nullable().optional(),
    assigneeUsed: z.string().nullable().optional(),

    // claim-story
    claimed: z.object({
        id: z.number(),
        previousState: z.string().nullable(),
        newState: z.string(),
        previousAssignee: z.string().nullable(),
        newAssignee: z.string(),
        url: z.string(),
    }).optional(),

    // post-checkpoint
    checkpoint: z.object({
        workItemId: z.number(),
        phase: z.string().nullable(),
        commentPreview: z.string(),
        tagApplied: z.string().nullable(),
        url: z.string(),
    }).optional(),

    // summary
    summary: z.object({
        iteration: z.string().nullable(),
        storyCounts: z.record(z.string(), z.number()),
        tcCounts: z.record(z.string(), z.number()),
        runStats: z.object({
            passed: z.number(),
            failed: z.number(),
            other: z.number(),
            runCount: z.number(),
        }).nullable(),
        cycleTimeDays: z.number().nullable(),
        coveragePercent: z.number().nullable(),
        blockers: z.array(z.object({ id: z.number(), title: z.string(), state: z.string() })),
    }).optional(),

    // link-work-items
    links: z.array(LinkResult).optional(),

    // find-tests-for-story
    story: z.object({ id: z.number(), title: z.string() }).optional(),
    adoTestCases: z.array(AdoTcRef).optional(),
    localFeatures: z.array(LocalScenario).optional(),
    localSpecs: z.array(LocalSpec).optional(),

    warnings: z.array(z.string()).default([]),
    note: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

// ---------------------------------------------------------------------------
// Friendly link name → ADO relation type mapping. Central so we can grep for
// every relation the tool understands.
// ---------------------------------------------------------------------------

const LINK_REL_MAP: Record<z.infer<typeof LinkTypeEnum>, string> = {
    'tested-by': 'Microsoft.VSTS.Common.TestedBy-Forward',
    'tests': 'Microsoft.VSTS.Common.TestedBy-Reverse',
    'parent-child': 'System.LinkTypes.Hierarchy-Forward',
    'related': 'System.LinkTypes.Related',
    'duplicate-of': 'System.LinkTypes.Duplicate-Forward',
    'predecessor': 'System.LinkTypes.Dependency-Reverse',
    'successor': 'System.LinkTypes.Dependency-Forward',
    'affects': 'Microsoft.VSTS.Common.Affects-Forward',
    'affected-by': 'Microsoft.VSTS.Common.Affects-Reverse',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ConnectionDataShape {
    authenticatedUser?: {
        id?: string;
        uniqueName?: string;
        displayName?: string;
        descriptor?: string;
    };
}

async function whoAmI(client: AdoHttpClient): Promise<string | null> {
    try {
        const data = await client.get<ConnectionDataShape>(
            `_apis/connectionData?api-version=7.1`,
            { scopeToProject: false },
        );
        const u = data.authenticatedUser;
        if (!u) return null;
        return u.uniqueName || u.displayName || null;
    } catch {
        return null;
    }
}

interface IterationShape {
    id: string;
    name: string;
    path: string;
    attributes?: { startDate?: string; finishDate?: string; timeFrame?: string };
}

async function resolveDefaultTeam(client: AdoHttpClient, project: string): Promise<string | null> {
    try {
        const data = await client.get<{ defaultTeam?: { name?: string } }>(
            `_apis/projects/${encodeURIComponent(project)}?api-version=7.1`,
            { scopeToProject: false },
        );
        return data?.defaultTeam?.name ?? null;
    } catch {
        return null;
    }
}

async function fetchCurrentIteration(client: AdoHttpClient, project: string, team: string): Promise<IterationShape | null> {
    try {
        const data = await client.get<{ value?: IterationShape[] }>(
            `${encodeURIComponent(project)}/${encodeURIComponent(team)}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=7.1`,
            { scopeToProject: false },
        );
        const arr = data?.value ?? [];
        return arr.length > 0 ? arr[0] : null;
    } catch {
        return null;
    }
}

async function resolveIterationPath(client: AdoHttpClient, project: string, teamHint: string | undefined, explicit: string | undefined): Promise<{ path: string | null; name: string | null }> {
    if (explicit) return { path: explicit, name: explicit };
    const team = teamHint || (await resolveDefaultTeam(client, project));
    if (!team) return { path: null, name: null };
    const iter = await fetchCurrentIteration(client, project, team);
    if (!iter) return { path: null, name: null };
    return { path: iter.path, name: iter.name };
}

interface WiFieldsShape {
    id: number;
    url?: string;
    fields?: Record<string, unknown>;
    relations?: Array<{ rel: string; url: string; attributes?: Record<string, unknown> }>;
}

async function fetchWorkItems(client: AdoHttpClient, ids: number[], fields: string[], expand?: 'relations'): Promise<WiFieldsShape[]> {
    if (ids.length === 0) return [];
    const out: WiFieldsShape[] = [];
    // ADO caps batches at 200; keep chunks small enough that expand=relations
    // does not blow the response cap.
    const chunkSize = expand ? 100 : 200;
    for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const body: Record<string, unknown> = { ids: chunk, fields };
        if (expand) { delete body.fields; body['$expand'] = expand; }
        try {
            const data = await client.post<{ value?: WiFieldsShape[] }>(
                `_apis/wit/workitemsbatch?api-version=7.1`,
                body,
            );
            for (const v of (data.value || [])) out.push(v);
        } catch {
            // fall through — batched call may throw on partial permission issues
        }
    }
    return out;
}

async function runWiql(client: AdoHttpClient, query: string, top?: number): Promise<number[]> {
    const suffix = top && top > 0 ? `&$top=${top}` : '';
    try {
        const res = await client.post<{ workItems?: Array<{ id: number }> }>(
            `_apis/wit/wiql?api-version=7.0${suffix}`,
            { query },
        );
        return (res.workItems || []).map((w) => w.id);
    } catch {
        return [];
    }
}

function extractText(fields: Record<string, unknown> | undefined, key: string): string {
    if (!fields) return '';
    const v = fields[key];
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v === 'object' && v !== null && 'displayName' in v) return String((v as { displayName?: unknown }).displayName ?? '');
    return String(v);
}

function extractNumber(fields: Record<string, unknown> | undefined, key: string): number | null {
    if (!fields) return null;
    const v = fields[key];
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function splitTags(s: string): string[] {
    return s.split(/;\s*/).map((t) => t.trim()).filter(Boolean);
}

function joinTags(tags: string[]): string {
    return Array.from(new Set(tags.map((t) => t.trim()).filter(Boolean))).join('; ');
}

function htmlEscape(s: string): string {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildCheckpointHtml(input: z.infer<typeof PostCheckpointInput>): string {
    const parts: string[] = [];
    const badge = input.phase ? `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:#0366d6;color:#fff;font-size:12px;font-weight:600">QA · ${htmlEscape(input.phase)}</span>` : `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:#586069;color:#fff;font-size:12px;font-weight:600">QA checkpoint</span>`;
    parts.push(`<p>${badge} — <b>${htmlEscape(new Date().toISOString().replace('T', ' ').replace(/\..*$/, 'Z'))}</b></p>`);
    parts.push(`<p>${htmlEscape(input.summary)}</p>`);
    if (input.tcsCovered && input.tcsCovered.length > 0) {
        parts.push(`<p><b>Test cases covered</b>: ${input.tcsCovered.map((id) => `#${id}`).join(', ')}</p>`);
    }
    if (input.blockers && input.blockers.length > 0) {
        parts.push(`<p><b>Blockers</b></p><ul>${input.blockers.map((b) => `<li>${htmlEscape(b)}</li>`).join('')}</ul>`);
    }
    if (input.openIssues && input.openIssues.length > 0) {
        parts.push(`<p><b>Open questions</b></p><ul>${input.openIssues.map((b) => `<li>${htmlEscape(b)}</li>`).join('')}</ul>`);
    }
    return parts.join('\n');
}

async function safeGetWiFields(client: AdoHttpClient, id: number, fields: string[]): Promise<Record<string, unknown> | null> {
    try {
        const fieldsQs = fields.map(encodeURIComponent).join(',');
        const data = await client.get<{ fields?: Record<string, unknown> }>(
            `_apis/wit/workitems/${id}?fields=${fieldsQs}&api-version=7.0`,
        );
        return data.fields ?? {};
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Local file scanners for find-tests-for-story
// ---------------------------------------------------------------------------

function walkFiles(root: string, matcher: RegExp, out: string[] = []): string[] {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const abs = path.join(root, e.name);
        if (e.isDirectory()) {
            if (/^(node_modules|dist|build|coverage|reports|test-results|\.git|\.cs-qa)$/i.test(e.name)) continue;
            walkFiles(abs, matcher, out);
        } else if (e.isFile() && matcher.test(e.name)) {
            out.push(abs);
        }
    }
    return out;
}

function scanFeatureFile(filePath: string, storyId: number): string[] {
    let text: string;
    try { text = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
    const wanted = [
        new RegExp(`@LinkedStory:${storyId}\\b`),
        new RegExp(`@story-${storyId}\\b`),
        new RegExp(`@story:${storyId}\\b`),
    ];
    if (!wanted.some((r) => r.test(text))) return [];
    const lines = text.split(/\r?\n/);
    const scenarios: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*Scenario(?:\s+Outline)?\s*:\s*(.+?)\s*$/.exec(lines[i]);
        if (!m) continue;
        // Confirm this scenario carries the tag (either directly above or via feature-level tag).
        const tagsAbove: string[] = [];
        for (let j = i - 1; j >= 0; j--) {
            const t = lines[j].trim();
            if (t === '') continue;
            if (t.startsWith('@')) { tagsAbove.push(...t.split(/\s+/).filter((s) => s.startsWith('@'))); continue; }
            break;
        }
        // Feature-level tags — walk from top to Feature: line
        const featureIdx = lines.findIndex((l) => /^Feature:/.test(l.trim()));
        const featureTags: string[] = [];
        for (let j = 0; j < featureIdx; j++) {
            const t = lines[j].trim();
            if (t.startsWith('@')) featureTags.push(...t.split(/\s+/).filter((s) => s.startsWith('@')));
        }
        const all = [...tagsAbove, ...featureTags];
        const carriesTag = all.some((t) => wanted.some((r) => r.test(t)));
        if (carriesTag) scenarios.push(m[1]);
    }
    return scenarios;
}

function scanSpecFile(filePath: string, storyId: number): string[] {
    let text: string;
    try { text = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
    const wanted = new RegExp(`(?:@LinkedStory:${storyId}\\b|@story-${storyId}\\b|@story:${storyId}\\b|LinkedStory\\s*[:=]\\s*['"\`]?${storyId}\\b|storyId\\s*[:=]\\s*${storyId}\\b)`);
    if (!wanted.test(text)) return [];
    const tests: string[] = [];
    const rx = /(?:test|it|describe)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) tests.push(m[1]);
    return tests;
}

// ---------------------------------------------------------------------------
// Verb implementations
// ---------------------------------------------------------------------------

async function runMyQueue(input: z.infer<typeof MyQueueInput>, creds: AdoCreds, warnings: string[]): Promise<Output> {
    const client = new AdoHttpClient(creds);
    const assignee = input.assignedTo || (await whoAmI(client)) || null;
    const iter = await resolveIterationPath(client, creds.project, input.team, input.iterationPath);
    if (!iter.path) warnings.push('Could not resolve current iteration path — falling back to all iterations.');
    const states = input.states && input.states.length > 0 ? input.states : ['New', 'Active', 'Ready for QA'];
    const types = input.workItemTypes && input.workItemTypes.length > 0 ? input.workItemTypes : ['User Story', 'Feature', 'Bug'];

    const q = wiql()
        .select(['[System.Id]', '[System.Title]', '[System.State]', '[System.WorkItemType]', '[System.Tags]', '[Microsoft.VSTS.Common.Priority]', '[System.AssignedTo]'])
        .from('WorkItems');
    const wb = q.where().in('[System.WorkItemType]', types);
    wb.and().in('[System.State]', states);
    if (iter.path) wb.and().equals('[System.IterationPath]', iter.path);
    if (assignee) {
        if (/^@me$/i.test(assignee)) wb.and().raw('[System.AssignedTo] = @Me');
        else wb.and().equals('[System.AssignedTo]', assignee);
    }
    q.orderBy('[System.ChangedDate]', 'DESC');
    const query = q.build();
    const ids = await runWiql(client, query, input.limit);
    const wis = await fetchWorkItems(client, ids, [
        'System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.Tags',
        'Microsoft.VSTS.Common.Priority', 'System.AssignedTo',
    ]);

    const byState: Record<string, number> = {};
    const byType: Record<string, number> = {};
    const items = wis.map((w) => {
        const state = extractText(w.fields, 'System.State');
        const type = extractText(w.fields, 'System.WorkItemType');
        byState[state] = (byState[state] || 0) + 1;
        byType[type] = (byType[type] || 0) + 1;
        return {
            id: w.id,
            title: extractText(w.fields, 'System.Title'),
            type,
            state,
            priority: extractNumber(w.fields, 'Microsoft.VSTS.Common.Priority'),
            tags: splitTags(extractText(w.fields, 'System.Tags')),
            url: w.url || `${creds.orgUrl}/${encodeURIComponent(creds.project)}/_workitems/edit/${w.id}`,
            assignedTo: extractText(w.fields, 'System.AssignedTo') || null,
        };
    });

    return {
        ok: true,
        verb: 'my-queue',
        items,
        aggregate: { byState, byType, count: items.length },
        iterationUsed: iter.name,
        assigneeUsed: assignee,
        warnings,
        note: `Found ${items.length} work item(s) matching iteration=${iter.name || 'any'} assignee=${assignee || 'any'}.`,
    };
}

async function runClaimStory(input: z.infer<typeof ClaimStoryInput>, creds: AdoCreds, warnings: string[]): Promise<Output> {
    const client = new AdoHttpClient(creds);
    const currentFields = await safeGetWiFields(client, input.storyId, ['System.State', 'System.AssignedTo', 'System.Title']);
    if (currentFields === null) {
        return {
            ok: false, verb: 'claim-story',
            warnings: [...warnings, `Work item ${input.storyId} not found (or PAT lacks read permission).`],
            note: `Cannot claim WI ${input.storyId} — it does not exist or is not accessible.`,
        };
    }
    const previousState = extractText(currentFields, 'System.State') || null;
    const previousAssignee = extractText(currentFields, 'System.AssignedTo') || null;
    const assignee = input.assignTo || (await whoAmI(client));
    if (!assignee) {
        return {
            ok: false, verb: 'claim-story',
            warnings: [...warnings, 'Could not resolve current user via /_apis/connectionData and no assignTo provided.'],
            note: 'Provide assignTo:<email> to specify the QA owner explicitly.',
        };
    }
    const commentText = input.comment || 'Claimed by QA — beginning analysis.';

    if (!input.confirmed) {
        return {
            ok: true,
            verb: 'claim-story',
            requiresConfirmation: true,
            destructive: true,
            confirmationHint: `About to claim WI #${input.storyId}: state ${previousState || '(none)'} → ${input.state}, assignee ${previousAssignee || '(unassigned)'} → ${assignee}. Retry with confirmed:true to write.`,
            preview: {
                workItemId: input.storyId,
                title: extractText(currentFields, 'System.Title'),
                previousState,
                newState: input.state,
                previousAssignee,
                newAssignee: assignee,
                commentPreview: commentText,
            },
            warnings,
        };
    }

    const patch: Array<Record<string, unknown>> = [
        { op: 'add', path: '/fields/System.AssignedTo', value: assignee },
        { op: 'add', path: '/fields/System.State', value: input.state },
        { op: 'add', path: '/fields/System.History', value: commentText },
    ];
    try {
        const res = await client.patch<{ id: number; url: string }>(`_apis/wit/workitems/${input.storyId}?api-version=7.0`, patch);
        return {
            ok: true,
            verb: 'claim-story',
            claimed: {
                id: res.id,
                previousState,
                newState: input.state,
                previousAssignee,
                newAssignee: assignee,
                url: res.url,
            },
            warnings,
            note: `Claimed WI #${res.id} — ${previousState || '(none)'} → ${input.state}.`,
        };
    } catch (e) {
        return {
            ok: false, verb: 'claim-story', warnings: [...warnings, `Claim failed: ${(e as Error).message.slice(0, 300)}`],
            note: `ADO PATCH rejected the claim on WI #${input.storyId}.`,
        };
    }
}

async function runPostCheckpoint(input: z.infer<typeof PostCheckpointInput>, creds: AdoCreds, warnings: string[]): Promise<Output> {
    const client = new AdoHttpClient(creds);
    const currentFields = await safeGetWiFields(client, input.workItemId, ['System.Title', 'System.Tags', 'System.State']);
    if (currentFields === null) {
        return {
            ok: false, verb: 'post-checkpoint',
            warnings: [...warnings, `Work item ${input.workItemId} not found or inaccessible.`],
            note: `Cannot post a checkpoint on WI ${input.workItemId} — it does not exist or is not accessible.`,
        };
    }
    const html = buildCheckpointHtml(input);
    const currentTags = splitTags(extractText(currentFields, 'System.Tags'));
    const phaseTag = input.phase ? `qa-checkpoint:${input.phase}` : null;
    // Strip any prior qa-checkpoint:<phase> tag so the WI carries only the newest.
    const scrubbed = currentTags.filter((t) => !/^qa-checkpoint:/i.test(t));
    if (phaseTag) scrubbed.push(phaseTag);
    const nextTags = joinTags(scrubbed);

    if (!input.confirmed) {
        return {
            ok: true,
            verb: 'post-checkpoint',
            requiresConfirmation: true,
            destructive: true,
            confirmationHint: `About to append a QA checkpoint comment to WI #${input.workItemId}${input.phase ? ` and set tag ${phaseTag}` : ''}. Retry with confirmed:true to write.`,
            preview: {
                workItemId: input.workItemId,
                title: extractText(currentFields, 'System.Title'),
                phase: input.phase ?? null,
                summaryPreview: input.summary.slice(0, 200),
                blockersCount: (input.blockers || []).length,
                tcsCoveredCount: (input.tcsCovered || []).length,
                openIssuesCount: (input.openIssues || []).length,
                tagToAdd: phaseTag,
                previousTags: currentTags,
                nextTags: splitTags(nextTags),
            },
            warnings,
        };
    }

    const patch: Array<Record<string, unknown>> = [
        { op: 'add', path: '/fields/System.History', value: html },
    ];
    if (phaseTag) patch.push({ op: 'add', path: '/fields/System.Tags', value: nextTags });
    try {
        const res = await client.patch<{ id: number; url: string }>(`_apis/wit/workitems/${input.workItemId}?api-version=7.0`, patch);
        return {
            ok: true,
            verb: 'post-checkpoint',
            checkpoint: {
                workItemId: res.id,
                phase: input.phase ?? null,
                commentPreview: input.summary.slice(0, 200),
                tagApplied: phaseTag,
                url: res.url,
            },
            warnings,
            note: `Checkpoint posted on WI #${res.id}${input.phase ? ` (${input.phase})` : ''}.`,
        };
    } catch (e) {
        return {
            ok: false, verb: 'post-checkpoint',
            warnings: [...warnings, `Checkpoint post failed: ${(e as Error).message.slice(0, 300)}`],
            note: `ADO PATCH rejected the checkpoint on WI #${input.workItemId}.`,
        };
    }
}

async function runSummary(input: z.infer<typeof SummaryInput>, creds: AdoCreds, warnings: string[]): Promise<Output> {
    const client = new AdoHttpClient(creds);
    const iter = await resolveIterationPath(client, creds.project, input.team, input.iterationPath);
    if (!iter.path) warnings.push('Could not resolve iteration path — summary will be empty.');

    // 1. Story counts (stories + features + bugs) by state
    const storyCounts: Record<string, number> = {};
    const tcCounts: Record<string, number> = {};
    const blockers: Array<{ id: number; title: string; state: string }> = [];
    let cycleTimeDays: number | null = null;
    let coveragePercent: number | null = null;
    let runStats: { passed: number; failed: number; other: number; runCount: number } | null = null;

    if (iter.path) {
        const storyQ = wiql()
            .select(['[System.Id]', '[System.Title]', '[System.State]', '[System.WorkItemType]', '[System.Tags]', '[Microsoft.VSTS.Common.ActivatedDate]', '[Microsoft.VSTS.Common.ClosedDate]'])
            .from('WorkItems');
        const swb = storyQ.where()
            .in('[System.WorkItemType]', ['User Story', 'Feature', 'Bug'])
            .and().equals('[System.IterationPath]', iter.path);
        if (input.areaPath) swb.and().areaPathUnder(input.areaPath);
        storyQ.orderBy('[System.Id]', 'ASC');
        const storyIds = await runWiql(client, storyQ.build(), 500);
        const stories = await fetchWorkItems(client, storyIds, [
            'System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.Tags',
            'Microsoft.VSTS.Common.ActivatedDate', 'Microsoft.VSTS.Common.ClosedDate',
        ]);
        const cycleDurations: number[] = [];
        for (const s of stories) {
            const state = extractText(s.fields, 'System.State') || 'Unknown';
            storyCounts[state] = (storyCounts[state] || 0) + 1;
            const tags = splitTags(extractText(s.fields, 'System.Tags'));
            if (tags.some((t) => /^qa-checkpoint:blocked$/i.test(t)) || /block(ed|er)/i.test(state)) {
                blockers.push({ id: s.id, title: extractText(s.fields, 'System.Title'), state });
            }
            const activated = extractText(s.fields, 'Microsoft.VSTS.Common.ActivatedDate');
            const closed = extractText(s.fields, 'Microsoft.VSTS.Common.ClosedDate');
            if (activated && closed) {
                const a = Date.parse(activated);
                const c = Date.parse(closed);
                if (Number.isFinite(a) && Number.isFinite(c) && c > a) cycleDurations.push((c - a) / (1000 * 60 * 60 * 24));
            }
        }
        if (cycleDurations.length > 0) cycleTimeDays = Math.round((cycleDurations.reduce((s, v) => s + v, 0) / cycleDurations.length) * 10) / 10;

        // 2. Test case counts (designed / automated / manual)
        const tcQ = wiql()
            .select(['[System.Id]', '[System.State]', '[Microsoft.VSTS.TCM.AutomationStatus]'])
            .from('WorkItems');
        const twb = tcQ.where()
            .equals('[System.WorkItemType]', 'Test Case')
            .and().equals('[System.IterationPath]', iter.path);
        if (input.areaPath) twb.and().areaPathUnder(input.areaPath);
        const tcIds = await runWiql(client, tcQ.build(), 500);
        const tcs = await fetchWorkItems(client, tcIds, ['System.Id', 'System.State', 'Microsoft.VSTS.TCM.AutomationStatus']);
        let designed = 0;
        let automated = 0;
        for (const t of tcs) {
            designed += 1;
            const auto = extractText(t.fields, 'Microsoft.VSTS.TCM.AutomationStatus');
            if (/^automated$/i.test(auto)) automated += 1;
        }
        tcCounts['designed'] = designed;
        tcCounts['automated'] = automated;
        tcCounts['manual'] = Math.max(0, designed - automated);
        if (designed > 0) coveragePercent = Math.round((automated / designed) * 1000) / 10;

        // 3. Run stats — enumerate test runs whose iteration matches (best effort)
        if (input.includeMetrics) {
            try {
                const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
                const to = new Date().toISOString();
                const runsRes = await client.get<{ value?: Array<{ id: number; passedTests?: number; totalTests?: number; iteration?: string }> }>(
                    `_apis/test/runs?minLastUpdatedDate=${encodeURIComponent(from)}&maxLastUpdatedDate=${encodeURIComponent(to)}&api-version=7.0`,
                );
                const runs = (runsRes.value || []).filter((r) => !r.iteration || r.iteration === iter.path || r.iteration === iter.name);
                let passed = 0; let failed = 0; let other = 0;
                for (const r of runs) {
                    const total = Number(r.totalTests || 0);
                    const p = Number(r.passedTests || 0);
                    passed += p;
                    failed += Math.max(0, total - p);
                    if (total === 0) other += 1;
                }
                runStats = { passed, failed, other, runCount: runs.length };
            } catch {
                warnings.push('Could not fetch test-run stats — test-runs endpoint returned an error.');
            }
        }
    }

    return {
        ok: true,
        verb: 'summary',
        summary: {
            iteration: iter.name,
            storyCounts,
            tcCounts,
            runStats,
            cycleTimeDays,
            coveragePercent,
            blockers,
        },
        warnings,
        note: `Iteration=${iter.name || 'unresolved'} · stories=${Object.values(storyCounts).reduce((s, v) => s + v, 0)} · TCs=${tcCounts['designed'] || 0}${coveragePercent !== null ? ` · automation=${coveragePercent}%` : ''}.`,
    };
}

async function runLinkWorkItems(input: z.infer<typeof LinkWorkItemsInput>, creds: AdoCreds, warnings: string[]): Promise<Output> {
    const client = new AdoHttpClient(creds);
    const rel = LINK_REL_MAP[input.linkType];
    const orgBase = creds.orgUrl.replace(/\/$/, '');

    if (!input.confirmed) {
        return {
            ok: true,
            verb: 'link-work-items',
            requiresConfirmation: true,
            destructive: true,
            confirmationHint: `About to create ${input.targetIds.length} '${input.linkType}' (${rel}) link(s) from WI #${input.sourceId}. Retry with confirmed:true to write.`,
            preview: {
                sourceId: input.sourceId,
                targetIds: input.targetIds,
                linkType: input.linkType,
                rel,
                commentPreview: input.comment || null,
            },
            warnings,
        };
    }

    // Bulk-apply via bulkExecute — chunks of 20 per patch batch keeps
    // individual PATCH bodies well under any reasonable size cap.
    const bulk = await bulkExecute<number, z.infer<typeof LinkResult>>(input.targetIds, {
        chunkSize: 20,
        concurrency: 4,
        workFn: async (chunk) => {
            const results: z.infer<typeof LinkResult>[] = [];
            for (const targetId of chunk) {
                const localWarnings: string[] = [];
                const patch: Array<Record<string, unknown>> = [
                    {
                        op: 'add', path: '/relations/-',
                        value: {
                            rel,
                            url: `${orgBase}/_apis/wit/workitems/${targetId}`,
                            attributes: input.comment ? { comment: input.comment } : {},
                        },
                    },
                ];
                try {
                    await client.patch<{ id: number }>(`_apis/wit/workitems/${input.sourceId}?api-version=7.0`, patch);
                    results.push({ sourceId: input.sourceId, targetId, rel, ok: true, warnings: localWarnings });
                } catch (e) {
                    const msg = (e as Error).message.slice(0, 200);
                    if (/RelationAlreadyExists|already exists/i.test(msg)) {
                        localWarnings.push('link already exists — no-op');
                        results.push({ sourceId: input.sourceId, targetId, rel, ok: true, warnings: localWarnings });
                    } else {
                        localWarnings.push(msg);
                        results.push({ sourceId: input.sourceId, targetId, rel, ok: false, warnings: localWarnings });
                    }
                }
            }
            return results;
        },
        onChunkError: (err, chunk, idx) => {
            warnings.push(`Chunk ${idx} of ${chunk.length} targets failed wholesale: ${err.message.slice(0, 200)}`);
        },
    });

    const results = [...bulk.ok];
    for (const f of bulk.failed) {
        results.push({ sourceId: input.sourceId, targetId: f.item, rel, ok: false, warnings: [f.error.message.slice(0, 200)] });
    }

    const okCount = results.filter((r) => r.ok).length;
    return {
        ok: true,
        verb: 'link-work-items',
        links: results,
        warnings,
        note: `Created ${okCount}/${results.length} '${input.linkType}' link(s) from WI #${input.sourceId}.`,
    };
}

async function runFindTestsForStory(input: z.infer<typeof FindTestsForStoryInput>, creds: AdoCreds, warnings: string[], workspaceRoot: string): Promise<Output> {
    const client = new AdoHttpClient(creds);
    const storyFieldsRaw = await safeGetWiFields(client, input.storyId, ['System.Title']);
    if (storyFieldsRaw === null) {
        return {
            ok: false, verb: 'find-tests-for-story',
            warnings: [...warnings, `Work item ${input.storyId} not found or inaccessible.`],
            note: `Cannot enumerate tests for WI ${input.storyId} — story does not exist or is not accessible.`,
        };
    }
    const storyTitle = extractText(storyFieldsRaw, 'System.Title');

    let adoTestCases: z.infer<typeof AdoTcRef>[] = [];
    if (input.includeAdoTcs) {
        try {
            const storyExpanded = await client.get<WiFieldsShape>(`_apis/wit/workitems/${input.storyId}?$expand=relations&api-version=7.0`);
            const relations = storyExpanded.relations || [];
            const tcIds: number[] = [];
            for (const r of relations) {
                if (r.rel === 'Microsoft.VSTS.Common.TestedBy-Forward') {
                    const m = /workitems\/(\d+)/i.exec(r.url);
                    if (m) tcIds.push(Number(m[1]));
                }
            }
            if (tcIds.length > 0) {
                const tcWis = await fetchWorkItems(client, tcIds, ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType']);
                adoTestCases = tcWis.filter((w) => /^Test Case$/i.test(extractText(w.fields, 'System.WorkItemType'))).map((w) => ({
                    id: w.id,
                    title: extractText(w.fields, 'System.Title'),
                    url: w.url || `${creds.orgUrl}/${encodeURIComponent(creds.project)}/_workitems/edit/${w.id}`,
                    state: extractText(w.fields, 'System.State'),
                }));
            }
        } catch (e) {
            warnings.push(`ADO relations lookup failed: ${(e as Error).message.slice(0, 200)}`);
        }
    }

    const localFeatures: z.infer<typeof LocalScenario>[] = [];
    const localSpecs: z.infer<typeof LocalSpec>[] = [];
    if (input.includeLocalFiles) {
        const root = input.localScanRoot || path.join(workspaceRoot, 'test');
        if (fs.existsSync(root)) {
            const featureFiles = walkFiles(root, /\.feature$/i);
            for (const f of featureFiles) {
                const scenarios = scanFeatureFile(f, input.storyId);
                if (scenarios.length > 0) localFeatures.push({ path: f, scenarios });
            }
            const specFiles = walkFiles(root, /\.spec\.(ts|js)$/i);
            for (const f of specFiles) {
                const tests = scanSpecFile(f, input.storyId);
                if (tests.length > 0) localSpecs.push({ path: f, tests });
            }
        } else {
            warnings.push(`Local scan root does not exist: ${root}`);
        }
    }

    return {
        ok: true,
        verb: 'find-tests-for-story',
        story: { id: input.storyId, title: storyTitle },
        adoTestCases,
        localFeatures,
        localSpecs,
        warnings,
        note: `Story #${input.storyId}: ${adoTestCases.length} ADO test case(s), ${localFeatures.length} feature file(s), ${localSpecs.length} spec file(s).`,
    };
}

// ---------------------------------------------------------------------------
// Register the primitive
// ---------------------------------------------------------------------------

registerPrimitive<Input, Output>({
    name: 'cs_qa_sprint_ops',
    description:
        'One verb-driven primitive for QA sprint operations. Verbs: my-queue (list QA-scoped stories assigned to me / another user in the current iteration — read-only), claim-story (assign a story to a QA owner + move to Active + write history — TWO-PHASE gated), post-checkpoint (append a structured phase-tagged status comment to any WI — TWO-PHASE gated), summary (sprint QA rollup: story states, TC design/automation counts, test-run pass/fail, average cycle time, blockers — read-only), link-work-items (bulk-apply a typed link — tested-by / tests / parent-child / related / duplicate-of / predecessor / successor / affects / affected-by — from one source WI to many targets, TWO-PHASE gated), find-tests-for-story (reverse lookup: enumerate ADO Test Cases via TestedBy-Forward AND local .feature / .spec.ts files carrying @LinkedStory:<id> / @story-<id> markers — read-only). All ADO HTTP flows through AdoHttpClient (Retry-After honored, PAT redacted). All WIQL flows through the apostrophe-safe wiql() builder. Bulk link writes chunk through bulkExecute for failure isolation. On-prem safe.',
    inputSchema: InputSchema as unknown as z.ZodType<Input>,
    outputSchema: OutputSchema as unknown as z.ZodType<Output>,
    run: async (ctx, rawInput) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_sprint_ops', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        // Re-parse defensively so zod defaults land even when a caller invokes
        // the primitive directly (bypassing the runtime's schema pass — e.g.
        // smoke tests or the odd programmatic caller).
        const parsedInput = InputSchema.safeParse(rawInput);
        if (!parsedInput.success) {
            return {
                ok: false,
                verb: (rawInput as { verb?: string } | null)?.verb ?? 'unknown',
                warnings: [`Invalid input: ${parsedInput.error.message.slice(0, 400)}`],
                note: 'Zod schema rejected the input payload.',
            } as Output;
        }
        const input = parsedInput.data;

        // Resolve creds once — every verb needs them.
        const resolved = getResolvedCreds(ctx.workspaceRoot, {
            orgUrl: input.orgUrl,
            project: input.project,
            personalAccessToken: input.pat,
        });
        if (!resolved.creds) {
            log.warn('creds-unresolved', { diagnostic: resolved.diagnostic });
            return {
                ok: false,
                verb: input.verb,
                warnings: [resolved.diagnostic],
                note: `ADO not configured for this workspace. ${resolved.diagnostic}`,
            } as Output;
        }
        const creds: AdoCreds = resolved.creds;

        try {
            let result: Output;
            switch (input.verb) {
                case 'my-queue':
                    result = await runMyQueue(input, creds, warnings);
                    break;
                case 'claim-story':
                    result = await runClaimStory(input, creds, warnings);
                    break;
                case 'post-checkpoint':
                    result = await runPostCheckpoint(input, creds, warnings);
                    break;
                case 'summary':
                    result = await runSummary(input, creds, warnings);
                    break;
                case 'link-work-items':
                    result = await runLinkWorkItems(input, creds, warnings);
                    break;
                case 'find-tests-for-story':
                    result = await runFindTestsForStory(input, creds, warnings, ctx.workspaceRoot);
                    break;
                default: {
                    // Discriminated union — exhaustive at compile time. Runtime guard for safety.
                    const exhaustive: never = input;
                    void exhaustive;
                    result = { ok: false, verb: 'unknown', warnings: ['unknown verb'], note: 'unreachable' } as Output;
                }
            }
            log.info('verb-complete', { verb: input.verb, ok: result.ok, requiresConfirmation: result.requiresConfirmation === true });
            return result;
        } catch (e) {
            const msg = (e as Error).message.slice(0, 400);
            log.error('verb-crashed', { verb: input.verb, error: msg });
            return {
                ok: false,
                verb: input.verb,
                warnings: [msg],
                note: `Verb ${input.verb} threw: ${msg}`,
            } as Output;
        }
    },
});
