/**
 * cs_qa_ado_trace — bidirectional traceability.
 *
 * Verbs (discriminated Zod union):
 *   link-forward            Requirement/Story/Task → target work items
 *   link-backward           Bug/Result → TCs (+ optional story)
 *   link-tc-to-story        Story → TC (TestedBy on the story)
 *   link-bug-to-tc          Bug → TC (TestedBy-Reverse on the bug)
 *   find-orphans            TCs in scope not linked to any Story/Requirement
 *   find-uncovered          Requirements/Stories/Features with no linked TC
 *   auto-link-on-failure    Bug + failing TC (+ optional story) chained helper
 *
 * Every write:
 *   - fetches existing relations first
 *   - skips duplicates (idempotent)
 *   - uses AdoHttpClient (Retry-After honored, PAT-redacted errors)
 *   - never crashes sync-back — feature-tag write is best-effort
 *
 * Uses:
 *   - AdoHttpClient (transport)
 *   - LruCache (relation fetches per invocation)
 *   - WiqlQuery (find-uncovered)
 *   - bulkExecute (find-orphans / find-uncovered relation batches)
 *   - getResolvedCreds (6-tier config cascade)
 *   - resolvePlan / resolveSuite (name-based scope filter)
 *   - syncFeaturesAfterTraceLink (feature-file sync-back)
 *   - createLogger (per-invocation audit)
 */
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, AdoHttpError, type AdoCreds } from './_helpers/ado_http_client';
import { LruCache } from './_helpers/ado_lru_cache';
import { bulkExecute } from './_helpers/bulk_batcher';
import { wiql } from './_helpers/wiql_builder';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';
import { resolvePlan, resolveSuite, createCache, type ResolverCache, listTestCasesInSuite } from './ado_name_resolver';
import { syncFeaturesAfterTraceLink, type TraceLinkForSync, type TraceLinkSyncResult } from './sync_feature_tags';

// =============================================================================
// Relation-name constants (ADO REST vocabulary).
// =============================================================================

const REL = {
    /** Story/Requirement → Test Case (test coverage). */
    TESTED_BY_FORWARD: 'Microsoft.VSTS.Common.TestedBy-Forward',
    /** Test Case / Bug → Story/Requirement (reverse of TestedBy). */
    TESTED_BY_REVERSE: 'Microsoft.VSTS.Common.TestedBy-Reverse',
    /** Parent → Child (hierarchy). */
    CHILD: 'System.LinkTypes.Hierarchy-Forward',
    /** Child → Parent (hierarchy). */
    PARENT: 'System.LinkTypes.Hierarchy-Reverse',
    /** Generic related. */
    RELATED: 'System.LinkTypes.Related',
} as const;

function relationForForwardVerb(relation: 'TestedBy' | 'Child' | 'Related'): string {
    if (relation === 'TestedBy') return REL.TESTED_BY_FORWARD;
    if (relation === 'Child') return REL.CHILD;
    return REL.RELATED;
}

// =============================================================================
// Zod schemas.
// =============================================================================

const LinkForwardSchema = z.object({
    verb: z.literal('link-forward'),
    sourceId: z.number().int().positive(),
    sourceType: z.enum(['Requirement', 'Story', 'Task']).describe('Advisory — informs sync-back; does not affect the ADO endpoint.'),
    targetIds: z.array(z.number().int().positive()).min(1),
    relation: z.enum(['TestedBy', 'Child', 'Related']).default('TestedBy'),
    syncBackTags: z.boolean().default(true),
    syncBackScanRoot: z.string().optional(),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    personalAccessToken: z.string().min(1).optional(),
});

const LinkBackwardSchema = z.object({
    verb: z.literal('link-backward'),
    bugId: z.number().int().positive(),
    testCaseIds: z.array(z.number().int().positive()).min(1),
    storyId: z.number().int().positive().optional(),
    syncBackTags: z.boolean().default(true),
    syncBackScanRoot: z.string().optional(),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    personalAccessToken: z.string().min(1).optional(),
});

const LinkTcToStorySchema = z.object({
    verb: z.literal('link-tc-to-story'),
    testCaseId: z.number().int().positive(),
    storyId: z.number().int().positive(),
    syncBackTags: z.boolean().default(true),
    syncBackScanRoot: z.string().optional(),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    personalAccessToken: z.string().min(1).optional(),
});

const LinkBugToTcSchema = z.object({
    verb: z.literal('link-bug-to-tc'),
    bugId: z.number().int().positive(),
    testCaseId: z.number().int().positive(),
    syncBackTags: z.boolean().default(true),
    syncBackScanRoot: z.string().optional(),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    personalAccessToken: z.string().min(1).optional(),
});

const FindOrphansSchema = z.object({
    verb: z.literal('find-orphans'),
    planId: z.number().int().positive().optional(),
    planName: z.string().min(1).optional(),
    suiteId: z.number().int().positive().optional(),
    suiteName: z.string().min(1).optional(),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    personalAccessToken: z.string().min(1).optional(),
});

const FindUncoveredSchema = z.object({
    verb: z.literal('find-uncovered'),
    iterationPath: z.string().optional(),
    areaPath: z.string().optional(),
    workItemType: z.enum(['User Story', 'Requirement', 'Feature']).default('User Story'),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    personalAccessToken: z.string().min(1).optional(),
});

const AutoLinkOnFailureSchema = z.object({
    verb: z.literal('auto-link-on-failure'),
    bugId: z.number().int().positive(),
    failingTestCaseId: z.number().int().positive(),
    storyId: z.number().int().positive().optional(),
    syncBackTags: z.boolean().default(true),
    syncBackScanRoot: z.string().optional(),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    personalAccessToken: z.string().min(1).optional(),
});

const InputSchema = z.discriminatedUnion('verb', [
    LinkForwardSchema, LinkBackwardSchema, LinkTcToStorySchema, LinkBugToTcSchema,
    FindOrphansSchema, FindUncoveredSchema, AutoLinkOnFailureSchema,
]);

// =============================================================================
// Output schemas.
// =============================================================================

const LinkOpSchema = z.object({
    from: z.number(),
    to: z.number(),
    relation: z.string(),
    reason: z.string().optional(),
});

const OrphanSchema = z.object({
    id: z.number(),
    title: z.string().optional(),
    area: z.string().optional(),
    iter: z.string().optional(),
});

const SyncBackFileSchema = z.object({
    filePath: z.string(),
    fileChanged: z.boolean(),
    scenariosPatched: z.number(),
    tagsAdded: z.number(),
    warnings: z.array(z.string()),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    verb: z.string(),
    linksAdded: z.array(LinkOpSchema).default([]),
    linksSkipped: z.array(LinkOpSchema).default([]),
    orphans: z.array(OrphanSchema).optional(),
    uncovered: z.array(OrphanSchema).optional(),
    syncBack: z.array(SyncBackFileSchema).default([]),
    warnings: z.array(z.string()).default([]),
    note: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

// =============================================================================
// Small helpers.
// =============================================================================

function emptyOutput(verb: string): Output {
    return { ok: false, verb, linksAdded: [], linksSkipped: [], syncBack: [], warnings: [], note: '' };
}

interface WiRelation {
    rel: string;
    url: string;
    attributes?: Record<string, unknown>;
}

interface WiWithRelations {
    id?: number;
    fields?: Record<string, unknown>;
    relations?: WiRelation[];
}

function extractIdFromRelationUrl(url: string): number | null {
    const m = /\/workItems\/(\d+)(?:\?|$)/i.exec(url);
    return m ? Number(m[1]) : null;
}

function makeWiUrl(orgUrl: string, id: number): string {
    return `${orgUrl.replace(/\/$/, '')}/_apis/wit/workItems/${id}`;
}

/**
 * Fetch a work item with relations. Uses the LRU when available (5min TTL is
 * intentionally short — during a single tool run the relation set is stable).
 */
async function getWorkItemWithRelations(
    client: AdoHttpClient,
    cache: LruCache<number, WiWithRelations>,
    id: number,
): Promise<WiWithRelations> {
    const cached = cache.get(id);
    if (cached) return cached;
    const wi = await client.get<WiWithRelations>(`_apis/wit/workitems/${id}?api-version=7.1&$expand=relations`);
    cache.set(id, wi);
    return wi;
}

/**
 * Add relations on a source work item via JSON-Patch. Skips relations already
 * present (idempotent). Returns per-target added/skipped pairs.
 *
 * The JSON-Patch shape for adding a relation is:
 *   [{ op: "add", path: "/relations/-", value: { rel, url } }, ...]
 */
async function addRelations(
    client: AdoHttpClient,
    cache: LruCache<number, WiWithRelations>,
    orgUrl: string,
    sourceId: number,
    targets: Array<{ id: number; rel: string }>,
): Promise<{ added: Array<{ from: number; to: number; relation: string }>; skipped: Array<{ from: number; to: number; relation: string; reason: string }> }> {
    const added: Array<{ from: number; to: number; relation: string }> = [];
    const skipped: Array<{ from: number; to: number; relation: string; reason: string }> = [];

    const source = await getWorkItemWithRelations(client, cache, sourceId);
    const existing = new Set<string>();
    for (const r of source.relations || []) {
        const rid = extractIdFromRelationUrl(String(r.url || ''));
        if (rid !== null) existing.add(`${r.rel}::${rid}`);
    }

    const patchOps: Array<Record<string, unknown>> = [];
    const willBeAdded: Array<{ id: number; rel: string }> = [];
    for (const t of targets) {
        if (existing.has(`${t.rel}::${t.id}`)) {
            skipped.push({ from: sourceId, to: t.id, relation: t.rel, reason: 'already linked' });
            continue;
        }
        patchOps.push({ op: 'add', path: '/relations/-', value: { rel: t.rel, url: makeWiUrl(orgUrl, t.id) } });
        willBeAdded.push(t);
    }
    if (patchOps.length === 0) return { added, skipped };

    try {
        await client.patch<WiWithRelations>(`_apis/wit/workitems/${sourceId}?api-version=7.1`, patchOps);
        // Cache stale — evict so future reads in the same invocation get fresh.
        cache.delete(sourceId);
        for (const t of willBeAdded) added.push({ from: sourceId, to: t.id, relation: t.rel });
    } catch (e) {
        const msg = e instanceof AdoHttpError ? `${e.status}: ${e.bodySnippet}` : (e as Error).message;
        for (const t of willBeAdded) skipped.push({ from: sourceId, to: t.id, relation: t.rel, reason: `patch failed: ${msg}` });
    }
    return { added, skipped };
}

// =============================================================================
// Verbs.
// =============================================================================

async function runLinkForward(input: z.infer<typeof LinkForwardSchema>, creds: AdoCreds, workspaceRoot: string): Promise<Output> {
    const out = emptyOutput('link-forward');
    const client = new AdoHttpClient(creds);
    const cache = new LruCache<number, WiWithRelations>({ maxSize: 200, ttlMs: 5 * 60 * 1000 });
    const rel = relationForForwardVerb(input.relation);
    const result = await addRelations(client, cache, creds.orgUrl, input.sourceId, input.targetIds.map((id) => ({ id, rel })));
    out.linksAdded = result.added.map((a) => ({ from: a.from, to: a.to, relation: a.relation }));
    out.linksSkipped = result.skipped.map((s) => ({ from: s.from, to: s.to, relation: s.relation, reason: s.reason }));
    out.ok = out.linksAdded.length + out.linksSkipped.length === input.targetIds.length;
    out.note = `${out.linksAdded.length}/${input.targetIds.length} link(s) added to WI ${input.sourceId} (${input.sourceType}) with relation ${input.relation}; ${out.linksSkipped.length} skipped.`;

    // Sync-back: for TestedBy links, if we linked TC targets to a Story/Requirement,
    // tag their feature scenarios with @LinkedStory or @LinkedRequirement.
    if (input.syncBackTags && input.relation === 'TestedBy' && out.linksAdded.length > 0) {
        try {
            const kind: 'story' | 'requirement' = input.sourceType === 'Requirement' ? 'requirement' : 'story';
            const links: TraceLinkForSync[] = out.linksAdded.map((l) => ({ testCaseId: l.to, targetId: input.sourceId, kind }));
            const results = syncFeaturesAfterTraceLink(workspaceRoot, links, input.syncBackScanRoot);
            out.syncBack = toOutputSyncBack(results);
        } catch (e) {
            out.warnings.push(`sync-back failed: ${(e as Error).message.slice(0, 200)}`);
        }
    }
    return out;
}

async function runLinkBackward(input: z.infer<typeof LinkBackwardSchema>, creds: AdoCreds, workspaceRoot: string): Promise<Output> {
    const out = emptyOutput('link-backward');
    const client = new AdoHttpClient(creds);
    const cache = new LruCache<number, WiWithRelations>({ maxSize: 200, ttlMs: 5 * 60 * 1000 });

    // Bug → TCs (TestedBy-Reverse points from the Bug back to each TC that exercises the failure).
    const tcTargets = input.testCaseIds.map((id) => ({ id, rel: REL.TESTED_BY_REVERSE }));
    const tcRes = await addRelations(client, cache, creds.orgUrl, input.bugId, tcTargets);
    out.linksAdded.push(...tcRes.added.map((a) => ({ from: a.from, to: a.to, relation: a.relation })));
    out.linksSkipped.push(...tcRes.skipped.map((s) => ({ from: s.from, to: s.to, relation: s.relation, reason: s.reason })));

    if (input.storyId !== undefined) {
        // Bug → Story (Parent hierarchy).
        const storyRes = await addRelations(client, cache, creds.orgUrl, input.bugId, [{ id: input.storyId, rel: REL.PARENT }]);
        out.linksAdded.push(...storyRes.added.map((a) => ({ from: a.from, to: a.to, relation: a.relation })));
        out.linksSkipped.push(...storyRes.skipped.map((s) => ({ from: s.from, to: s.to, relation: s.relation, reason: s.reason })));
    }

    out.ok = out.linksAdded.length > 0 || (input.testCaseIds.length > 0 && out.linksSkipped.length === input.testCaseIds.length + (input.storyId !== undefined ? 1 : 0));
    out.note = `Bug ${input.bugId} linked to ${out.linksAdded.filter((l) => l.relation === REL.TESTED_BY_REVERSE).length}/${input.testCaseIds.length} TC(s)${input.storyId ? ` and story ${input.storyId}` : ''}. Added=${out.linksAdded.length}, Skipped=${out.linksSkipped.length}.`;

    if (input.syncBackTags && input.storyId !== undefined && out.linksAdded.length > 0) {
        try {
            const links: TraceLinkForSync[] = input.testCaseIds.map((tc) => ({ testCaseId: tc, targetId: input.storyId!, kind: 'story' as const }));
            const results = syncFeaturesAfterTraceLink(workspaceRoot, links, input.syncBackScanRoot);
            out.syncBack = toOutputSyncBack(results);
        } catch (e) {
            out.warnings.push(`sync-back failed: ${(e as Error).message.slice(0, 200)}`);
        }
    }
    return out;
}

async function runLinkTcToStory(input: z.infer<typeof LinkTcToStorySchema>, creds: AdoCreds, workspaceRoot: string): Promise<Output> {
    const out = emptyOutput('link-tc-to-story');
    const client = new AdoHttpClient(creds);
    const cache = new LruCache<number, WiWithRelations>({ maxSize: 200, ttlMs: 5 * 60 * 1000 });
    // TestedBy-Forward on Story → TC.
    const res = await addRelations(client, cache, creds.orgUrl, input.storyId, [{ id: input.testCaseId, rel: REL.TESTED_BY_FORWARD }]);
    out.linksAdded = res.added.map((a) => ({ from: a.from, to: a.to, relation: a.relation }));
    out.linksSkipped = res.skipped.map((s) => ({ from: s.from, to: s.to, relation: s.relation, reason: s.reason }));
    out.ok = out.linksAdded.length + out.linksSkipped.length === 1;
    out.note = out.linksAdded.length === 1
        ? `Story ${input.storyId} now tested by TC ${input.testCaseId}.`
        : `Story ${input.storyId} → TC ${input.testCaseId}: ${out.linksSkipped[0]?.reason || 'no change'}.`;

    if (input.syncBackTags && out.linksAdded.length > 0) {
        try {
            const links: TraceLinkForSync[] = [{ testCaseId: input.testCaseId, targetId: input.storyId, kind: 'story' }];
            const results = syncFeaturesAfterTraceLink(workspaceRoot, links, input.syncBackScanRoot);
            out.syncBack = toOutputSyncBack(results);
        } catch (e) {
            out.warnings.push(`sync-back failed: ${(e as Error).message.slice(0, 200)}`);
        }
    }
    return out;
}

async function runLinkBugToTc(input: z.infer<typeof LinkBugToTcSchema>, creds: AdoCreds, workspaceRoot: string): Promise<Output> {
    const out = emptyOutput('link-bug-to-tc');
    const client = new AdoHttpClient(creds);
    const cache = new LruCache<number, WiWithRelations>({ maxSize: 200, ttlMs: 5 * 60 * 1000 });
    // TestedBy-Reverse on Bug → TC.
    const res = await addRelations(client, cache, creds.orgUrl, input.bugId, [{ id: input.testCaseId, rel: REL.TESTED_BY_REVERSE }]);
    out.linksAdded = res.added.map((a) => ({ from: a.from, to: a.to, relation: a.relation }));
    out.linksSkipped = res.skipped.map((s) => ({ from: s.from, to: s.to, relation: s.relation, reason: s.reason }));
    out.ok = out.linksAdded.length + out.linksSkipped.length === 1;
    out.note = out.linksAdded.length === 1
        ? `Bug ${input.bugId} → TC ${input.testCaseId} (TestedBy-Reverse) added.`
        : `Bug ${input.bugId} → TC ${input.testCaseId}: ${out.linksSkipped[0]?.reason || 'no change'}.`;

    if (input.syncBackTags && out.linksAdded.length > 0) {
        // Bug link on its own doesn't yield a @LinkedRequirement / @LinkedStory tag —
        // the bug isn't a story/req. We do NOT sync-back for link-bug-to-tc.
        out.syncBack = [];
    }
    return out;
}

async function runFindOrphans(input: z.infer<typeof FindOrphansSchema>, creds: AdoCreds): Promise<Output> {
    const out = emptyOutput('find-orphans');
    const client = new AdoHttpClient(creds);
    const resolverCache: ResolverCache = createCache();

    // Resolve scope.
    let planId: number | undefined;
    let suiteId: number | undefined;
    if (input.planId !== undefined || input.planName !== undefined) {
        const plan = await resolvePlan(creds, { planId: input.planId, planName: input.planName }, resolverCache);
        out.warnings.push(...plan.warnings);
        if (plan.ambiguous || plan.resolved.length === 0) {
            out.note = 'plan not resolved';
            return out;
        }
        planId = plan.resolved[0].id;
    }
    if (planId !== undefined && (input.suiteId !== undefined || input.suiteName !== undefined)) {
        const suite = await resolveSuite(creds, { planId, suiteId: input.suiteId, suiteName: input.suiteName }, resolverCache);
        out.warnings.push(...suite.warnings);
        if (suite.ambiguous || suite.resolved.length === 0) {
            out.note = 'suite not resolved';
            return out;
        }
        suiteId = suite.resolved[0].id;
    }

    // Enumerate test cases in scope.
    let tcIds: number[] = [];
    if (planId !== undefined && suiteId !== undefined) {
        const cases = await listTestCasesInSuite(creds, planId, suiteId, resolverCache);
        tcIds = cases.map((c) => c.id);
    } else if (planId !== undefined) {
        // Enumerate root of the plan.
        try {
            const p = await client.get<{ rootSuite?: { id?: number } }>(`_apis/testplan/plans/${planId}?api-version=7.1`);
            const rootId = p.rootSuite?.id;
            if (rootId) {
                const cases = await listTestCasesInSuite(creds, planId, rootId, resolverCache);
                tcIds = cases.map((c) => c.id);
            }
        } catch (e) {
            out.warnings.push(`root-suite lookup failed: ${(e as Error).message.slice(0, 200)}`);
            return out;
        }
    } else {
        // Project-wide WIQL for Test Case work items.
        try {
            const q = wiql().select(['[System.Id]', '[System.Title]']).from('WorkItems').where().equals('[System.WorkItemType]', 'Test Case').done().build();
            const wRes = await client.post<{ workItems?: Array<{ id: number }> }>(`_apis/wit/wiql?api-version=7.1`, { query: q });
            tcIds = (wRes.workItems || []).map((w) => w.id).filter(Boolean);
        } catch (e) {
            out.warnings.push(`project-wide WIQL failed: ${(e as Error).message.slice(0, 200)}`);
            return out;
        }
    }
    if (tcIds.length === 0) {
        out.ok = true;
        out.orphans = [];
        out.note = 'No test cases in scope.';
        return out;
    }

    // Batch-fetch WI relations + fields (200 per chunk).
    const orphans: Array<{ id: number; title?: string; area?: string; iter?: string }> = [];
    const bulk = await bulkExecute<number, WiWithRelations>(tcIds, {
        chunkSize: 200,
        concurrency: 2,
        workFn: async (chunk: number[]): Promise<WiWithRelations[]> => {
            const ids = chunk.join(',');
            const res = await client.get<{ value?: WiWithRelations[] }>(`_apis/wit/workitems?ids=${ids}&fields=System.Id,System.Title,System.AreaPath,System.IterationPath&$expand=relations&api-version=7.1`);
            const byId = new Map<number, WiWithRelations>();
            for (const w of (res.value || [])) if (typeof w.id === 'number') byId.set(w.id, w);
            return chunk.map((id) => byId.get(id) || { id });
        },
        onChunkError: (err) => { out.warnings.push(`chunk failed: ${err.message.slice(0, 200)}`); },
    });
    for (const wi of bulk.ok) {
        const relations = wi.relations || [];
        const hasCoverage = relations.some((r) => r.rel === REL.TESTED_BY_REVERSE || r.rel === REL.TESTED_BY_FORWARD || r.rel === REL.PARENT);
        if (!hasCoverage && typeof wi.id === 'number') {
            const fields = (wi.fields || {}) as Record<string, unknown>;
            orphans.push({
                id: wi.id,
                title: (fields['System.Title'] as string) || undefined,
                area: (fields['System.AreaPath'] as string) || undefined,
                iter: (fields['System.IterationPath'] as string) || undefined,
            });
        }
    }
    out.orphans = orphans;
    out.ok = true;
    out.note = `${orphans.length} orphan TC(s) of ${tcIds.length} in scope.`;
    return out;
}

async function runFindUncovered(input: z.infer<typeof FindUncoveredSchema>, creds: AdoCreds): Promise<Output> {
    const out = emptyOutput('find-uncovered');
    const client = new AdoHttpClient(creds);

    // WIQL for the requested type in scope.
    const q = wiql().select(['[System.Id]', '[System.Title]', '[System.AreaPath]', '[System.IterationPath]']).from('WorkItems');
    const clauseBuilder = q.where().equals('[System.WorkItemType]', input.workItemType);
    if (input.iterationPath) clauseBuilder.and().iteration(input.iterationPath);
    if (input.areaPath) clauseBuilder.and().areaPathUnder(input.areaPath);
    const query = q.build();

    let ids: number[] = [];
    try {
        const wRes = await client.post<{ workItems?: Array<{ id: number }> }>(`_apis/wit/wiql?api-version=7.1`, { query });
        ids = (wRes.workItems || []).map((w) => w.id).filter(Boolean);
    } catch (e) {
        out.warnings.push(`WIQL failed: ${(e as Error).message.slice(0, 200)}`);
        return out;
    }
    if (ids.length === 0) {
        out.ok = true;
        out.uncovered = [];
        out.note = `No ${input.workItemType} work items in scope.`;
        return out;
    }

    const uncovered: Array<{ id: number; title?: string; area?: string; iter?: string }> = [];
    const bulk = await bulkExecute<number, WiWithRelations>(ids, {
        chunkSize: 200,
        concurrency: 2,
        workFn: async (chunk: number[]): Promise<WiWithRelations[]> => {
            const idsCsv = chunk.join(',');
            const res = await client.get<{ value?: WiWithRelations[] }>(`_apis/wit/workitems?ids=${idsCsv}&fields=System.Id,System.Title,System.AreaPath,System.IterationPath&$expand=relations&api-version=7.1`);
            const byId = new Map<number, WiWithRelations>();
            for (const w of (res.value || [])) if (typeof w.id === 'number') byId.set(w.id, w);
            return chunk.map((id) => byId.get(id) || { id });
        },
        onChunkError: (err) => { out.warnings.push(`chunk failed: ${err.message.slice(0, 200)}`); },
    });
    for (const wi of bulk.ok) {
        const relations = wi.relations || [];
        const hasCoverage = relations.some((r) => r.rel === REL.TESTED_BY_FORWARD);
        if (!hasCoverage && typeof wi.id === 'number') {
            const fields = (wi.fields || {}) as Record<string, unknown>;
            uncovered.push({
                id: wi.id,
                title: (fields['System.Title'] as string) || undefined,
                area: (fields['System.AreaPath'] as string) || undefined,
                iter: (fields['System.IterationPath'] as string) || undefined,
            });
        }
    }
    out.uncovered = uncovered;
    out.ok = true;
    out.note = `${uncovered.length} uncovered ${input.workItemType} of ${ids.length} in scope.`;
    return out;
}

async function runAutoLinkOnFailure(input: z.infer<typeof AutoLinkOnFailureSchema>, creds: AdoCreds, workspaceRoot: string): Promise<Output> {
    // Chain link-backward + optional link-tc-to-story.
    const combined = emptyOutput('auto-link-on-failure');
    const back = await runLinkBackward({
        verb: 'link-backward',
        bugId: input.bugId,
        testCaseIds: [input.failingTestCaseId],
        storyId: input.storyId,
        syncBackTags: input.syncBackTags,
        syncBackScanRoot: input.syncBackScanRoot,
    }, creds, workspaceRoot);
    combined.linksAdded.push(...back.linksAdded);
    combined.linksSkipped.push(...back.linksSkipped);
    combined.warnings.push(...back.warnings);
    combined.syncBack.push(...back.syncBack);

    if (input.storyId !== undefined) {
        const tcStory = await runLinkTcToStory({
            verb: 'link-tc-to-story',
            testCaseId: input.failingTestCaseId,
            storyId: input.storyId,
            syncBackTags: input.syncBackTags,
            syncBackScanRoot: input.syncBackScanRoot,
        }, creds, workspaceRoot);
        combined.linksAdded.push(...tcStory.linksAdded);
        combined.linksSkipped.push(...tcStory.linksSkipped);
        combined.warnings.push(...tcStory.warnings);
        // Merge sync-back — dedupe by filePath.
        const byPath = new Map<string, z.infer<typeof SyncBackFileSchema>>();
        for (const s of combined.syncBack) byPath.set(s.filePath, s);
        for (const s of tcStory.syncBack) {
            const cur = byPath.get(s.filePath);
            if (cur) {
                cur.fileChanged = cur.fileChanged || s.fileChanged;
                cur.scenariosPatched = Math.max(cur.scenariosPatched, s.scenariosPatched);
                cur.tagsAdded += s.tagsAdded;
                cur.warnings.push(...s.warnings);
            } else {
                byPath.set(s.filePath, s);
            }
        }
        combined.syncBack = Array.from(byPath.values());
    }
    combined.ok = combined.linksAdded.length > 0 || combined.linksSkipped.length > 0;
    combined.note = `auto-link: ${combined.linksAdded.length} added, ${combined.linksSkipped.length} skipped.`;
    return combined;
}

function toOutputSyncBack(results: TraceLinkSyncResult[]): z.infer<typeof SyncBackFileSchema>[] {
    return results
        .filter((r) => r.fileChanged || r.warnings.length > 0)
        .map((r) => ({
            filePath: r.filePath,
            fileChanged: r.fileChanged,
            scenariosPatched: r.scenariosPatched,
            tagsAdded: r.tagsAdded,
            warnings: r.warnings,
        }));
}

// =============================================================================
// Register.
// =============================================================================

registerPrimitive({
    name: 'cs_qa_ado_trace',
    description: 'Bidirectional traceability graph — Requirement → Story → Task → TC → Result → Bug. Verbs: link-forward (Story/Req → targets), link-backward (Bug → TCs/Story), link-tc-to-story, link-bug-to-tc, find-orphans (TCs w/o Story link), find-uncovered (Stories/Reqs/Features w/o TC link), auto-link-on-failure (bug + failing TC + optional story). Every write is idempotent — existing relations are skipped, not duplicated. Sync-back appends @LinkedRequirement:<n> / @LinkedStory:<n> tags to .feature scenarios; sync-back failure never fails the ADO write.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const logger = createLogger(ctx.invocationId, 'cs_qa_ado_trace', { workspaceRoot: ctx.workspaceRoot });
        const resolved = getResolvedCreds(ctx.workspaceRoot, {
            orgUrl: input.orgUrl,
            project: input.project,
            personalAccessToken: input.personalAccessToken,
        });
        if (!resolved.creds) {
            logger.warn('ado-not-configured', { diagnostic: resolved.diagnostic });
            return { ok: false, verb: input.verb, linksAdded: [], linksSkipped: [], syncBack: [], warnings: [resolved.diagnostic], note: 'ADO not configured.' };
        }
        const creds = resolved.creds;
        try {
            if (input.verb === 'link-forward') return await runLinkForward(input, creds, ctx.workspaceRoot);
            if (input.verb === 'link-backward') return await runLinkBackward(input, creds, ctx.workspaceRoot);
            if (input.verb === 'link-tc-to-story') return await runLinkTcToStory(input, creds, ctx.workspaceRoot);
            if (input.verb === 'link-bug-to-tc') return await runLinkBugToTc(input, creds, ctx.workspaceRoot);
            if (input.verb === 'find-orphans') return await runFindOrphans(input, creds);
            if (input.verb === 'find-uncovered') return await runFindUncovered(input, creds);
            if (input.verb === 'auto-link-on-failure') return await runAutoLinkOnFailure(input, creds, ctx.workspaceRoot);
            return { ok: false, verb: (input as { verb: string }).verb, linksAdded: [], linksSkipped: [], syncBack: [], warnings: ['unknown verb'], note: 'unknown verb' };
        } catch (e) {
            const msg = (e as Error).message;
            logger.error('trace-failed', { error: msg });
            return { ok: false, verb: input.verb, linksAdded: [], linksSkipped: [], syncBack: [], warnings: [msg], note: 'trace failed' };
        }
    },
});
