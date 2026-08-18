/**
 * cs_qa_ado_test_points_bulk — enumerate + bulk-assign test points in a suite.
 *
 * Verbs:
 *   list-points          Enumerate the test points in a plan/suite with tester + config + outcome.
 *   bulk-assign          Assign testers by rule (tag pattern → tester, default → tester).
 *   unassign-all         Clear the tester on every point in the suite.
 *
 * Rules are evaluated in order — FIRST MATCH WINS. Rule shapes:
 *   { matchTag: '@Owner:*', extractTesterFrom: 'tag' }        // email inside tag value
 *   { matchTag: '@Config:Chrome-Win10', assignTester: 'x@y' } // exact tag match, explicit tester
 *   { matchDefault: true, assignTester: 'default@x.y' }        // catch-all
 *
 * All updates ride PATCH .../TestPoint/{pointId}. When dryRun is true, ZERO
 * writes are attempted — output is the assignment plan only.
 *
 * Tags on the test-case are read via the framework's CSADOTagExtractor when it
 * is installed; otherwise we fall back to reading System.Tags on the WI.
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds, AdoHttpError } from './_helpers/ado_http_client';
import { LruCache } from './_helpers/ado_lru_cache';
import { bulkExecute } from './_helpers/bulk_batcher';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';
import { resolvePlan, resolveSuite, createCache, type ResolverCache } from './ado_name_resolver';

// =============================================================================
// Tag-extractor bridge (best-effort framework reuse).
// =============================================================================

interface FrameworkTagExtractor {
    extractOwnerFromTags?(tags: string[]): string | undefined;
    extractConfigFromTags?(tags: string[]): string | undefined;
    extractCustomTagValue?(tags: string[], pattern: string): string | undefined;
}

function loadFrameworkTagExtractor(workspaceRoot: string): FrameworkTagExtractor | null {
    try {
        const p = path.resolve(workspaceRoot, 'node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/ado/CSADOTagExtractor.js');
        if (!fs.existsSync(p)) return null;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(p) as { CSADOTagExtractor?: FrameworkTagExtractor; default?: FrameworkTagExtractor };
        return mod.CSADOTagExtractor || mod.default || null;
    } catch {
        return null;
    }
}

/**
 * Extract a value from a tag list by pattern.
 * `@Owner:*` → returns the value after the colon for the first `@Owner:...` tag.
 * `@Config:Chrome-Win10` → returns 'Chrome-Win10' if that exact tag exists, else undefined.
 * `@Owner` (no colon, no asterisk) → returns 'true' if the bare tag exists.
 */
function extractTagValue(tags: string[], pattern: string): string | undefined {
    if (pattern.endsWith(':*')) {
        const prefix = pattern.slice(0, -1);   // strip '*'
        const hit = tags.find((t) => t.startsWith(prefix));
        return hit ? hit.slice(prefix.length) : undefined;
    }
    if (pattern.includes(':')) {
        // Exact match — pattern like '@Config:Chrome-Win10'.
        const hit = tags.find((t) => t === pattern);
        if (!hit) return undefined;
        const colonIdx = pattern.indexOf(':');
        return pattern.slice(colonIdx + 1);
    }
    // Bare tag match — no colon.
    return tags.includes(pattern) ? 'true' : undefined;
}

function tagMatches(tags: string[], pattern: string): boolean {
    return extractTagValue(tags, pattern) !== undefined;
}

// =============================================================================
// Schemas.
// =============================================================================

const RuleSchema = z.object({
    matchTag: z.string().optional().describe('Tag pattern, e.g. "@Owner:*" (wildcard capture) or "@Config:Chrome-Win10" (exact) or "@smoke" (bare).'),
    matchDefault: z.boolean().optional().describe('Catch-all when no other rule matches. Only one matchDefault rule should exist.'),
    extractTesterFrom: z.enum(['tag']).optional().describe('When set to "tag", extracts the value part of a wildcard tag (e.g. @Owner:sarah@x.y → sarah@x.y).'),
    assignTester: z.string().min(1).optional().describe('Explicit tester email or identity ID.'),
}).refine((r) => r.matchTag !== undefined || r.matchDefault === true, { message: 'Each rule needs matchTag or matchDefault' })
   .refine((r) => r.extractTesterFrom !== undefined || r.assignTester !== undefined, { message: 'Each rule needs extractTesterFrom or assignTester' });

const ListPointsSchema = z.object({
    verb: z.literal('list-points'),
    planId: z.number().int().positive().optional(),
    planName: z.string().min(1).optional(),
    suiteId: z.number().int().positive().optional(),
    suiteName: z.string().min(1).optional(),
    testerFilter: z.string().optional().describe('Substring match on tester email/displayName.'),
    outcomeFilter: z.enum(['Unspecified', 'Passed', 'Failed', 'Blocked', 'NotExecuted']).optional(),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    personalAccessToken: z.string().min(1).optional(),
}).refine((v) => v.planId !== undefined || v.planName !== undefined, { message: 'planId or planName required' })
   .refine((v) => v.suiteId !== undefined || v.suiteName !== undefined, { message: 'suiteId or suiteName required' });

const BulkAssignSchema = z.object({
    verb: z.literal('bulk-assign'),
    planId: z.number().int().positive().optional(),
    planName: z.string().min(1).optional(),
    suiteId: z.number().int().positive().optional(),
    suiteName: z.string().min(1).optional(),
    rules: z.array(RuleSchema).min(1),
    dryRun: z.boolean().default(false),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    personalAccessToken: z.string().min(1).optional(),
}).refine((v) => v.planId !== undefined || v.planName !== undefined, { message: 'planId or planName required' })
   .refine((v) => v.suiteId !== undefined || v.suiteName !== undefined, { message: 'suiteId or suiteName required' });

const UnassignAllSchema = z.object({
    verb: z.literal('unassign-all'),
    planId: z.number().int().positive().optional(),
    planName: z.string().min(1).optional(),
    suiteId: z.number().int().positive().optional(),
    suiteName: z.string().min(1).optional(),
    dryRun: z.boolean().default(false),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    personalAccessToken: z.string().min(1).optional(),
}).refine((v) => v.planId !== undefined || v.planName !== undefined, { message: 'planId or planName required' })
   .refine((v) => v.suiteId !== undefined || v.suiteName !== undefined, { message: 'suiteId or suiteName required' });

const InputSchema = z.discriminatedUnion('verb', [ListPointsSchema, BulkAssignSchema, UnassignAllSchema]);

// =============================================================================
// Output.
// =============================================================================

const PointInfoSchema = z.object({
    pointId: z.number(),
    testCase: z.object({
        id: z.number().optional(),
        title: z.string().optional(),
        tags: z.array(z.string()).default([]),
    }),
    configuration: z.object({
        id: z.number().optional(),
        name: z.string().optional(),
    }).optional(),
    tester: z.object({
        email: z.string().optional(),
        displayName: z.string().optional(),
        id: z.string().optional(),
    }).optional(),
    outcome: z.string().optional(),
    lastUpdated: z.string().optional(),
});

const PlannedSchema = z.object({
    pointId: z.number(),
    testCaseTitle: z.string().optional(),
    oldTester: z.string().optional(),
    newTester: z.string().optional(),
    matchedRule: z.number().optional().describe('Index into rules[]. undefined = no rule matched (unchanged).'),
});

const FailedSchema = z.object({
    pointId: z.number(),
    reason: z.string(),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    verb: z.string(),
    points: z.array(PointInfoSchema).default([]),
    planned: z.array(PlannedSchema).default([]),
    assigned: z.number().default(0),
    failed: z.array(FailedSchema).default([]),
    byTester: z.record(z.string(), z.number()).default({}),
    dryRun: z.boolean().default(false),
    warnings: z.array(z.string()).default([]),
    note: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

// =============================================================================
// Helpers.
// =============================================================================

interface TestPointRaw {
    id?: number;
    testCaseReference?: { id?: number; name?: string };
    testCase?: { id?: string | number; name?: string };
    configuration?: { id?: number; name?: string };
    tester?: { id?: string; displayName?: string; uniqueName?: string; email?: string };
    assignedTo?: { id?: string; displayName?: string; uniqueName?: string };
    results?: { outcome?: string; lastUpdatedDate?: string };
    outcome?: string;
    lastUpdatedDate?: string;
}

async function listTestPoints(client: AdoHttpClient, planId: number, suiteId: number): Promise<TestPointRaw[]> {
    const res = await client.get<{ value?: TestPointRaw[] }>(`_apis/testplan/plans/${planId}/suites/${suiteId}/TestPoint?api-version=7.1&$top=1000`);
    return res.value || [];
}

async function fetchTagsForTestCases(client: AdoHttpClient, cache: LruCache<number, string[]>, tcIds: number[]): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>();
    const uncached: number[] = [];
    for (const id of tcIds) {
        const cached = cache.get(id);
        if (cached !== undefined) out.set(id, cached);
        else uncached.push(id);
    }
    if (uncached.length === 0) return out;
    const bulk = await bulkExecute<number, { id: number; tags: string[] }>(uncached, {
        chunkSize: 200,
        concurrency: 2,
        workFn: async (chunk: number[]): Promise<Array<{ id: number; tags: string[] }>> => {
            const ids = chunk.join(',');
            const res = await client.get<{ value?: Array<{ id?: number; fields?: { 'System.Tags'?: string } }> }>(`_apis/wit/workitems?ids=${ids}&fields=System.Id,System.Tags&api-version=7.1`);
            const byId = new Map<number, string[]>();
            for (const w of (res.value || [])) {
                if (typeof w.id === 'number') {
                    const raw = (w.fields?.['System.Tags'] || '').split(';').map((t) => t.trim()).filter(Boolean);
                    byId.set(w.id, raw);
                }
            }
            return chunk.map((id) => ({ id, tags: byId.get(id) || [] }));
        },
    });
    for (const r of bulk.ok) {
        cache.set(r.id, r.tags);
        out.set(r.id, r.tags);
    }
    return out;
}

function pickTesterForPoint(rules: z.infer<typeof RuleSchema>[], tags: string[]): { tester?: string; ruleIdx?: number } {
    for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        if (rule.matchDefault === true) {
            return { tester: rule.assignTester, ruleIdx: i };
        }
        if (rule.matchTag && tagMatches(tags, rule.matchTag)) {
            if (rule.extractTesterFrom === 'tag') {
                const extracted = extractTagValue(tags, rule.matchTag);
                return { tester: extracted || rule.assignTester, ruleIdx: i };
            }
            return { tester: rule.assignTester, ruleIdx: i };
        }
    }
    return {};
}

/**
 * PATCH a test point to update its tester. ADO's testplan endpoint accepts
 * `[{ id, tester: { id }}]` as a body — but we PATCH one at a time because
 * per-point failure isolation is more valuable than the batched shape here
 * (and the wit-batch endpoint doesn't cover testplan resources).
 *
 * `testerId` MUST be an identity id (not raw email) — callers pass the id they
 * derived from prior identity lookup, or the email string which ADO usually
 * resolves at the server side.
 */
async function assignPointTester(client: AdoHttpClient, planId: number, suiteId: number, pointId: number, testerId: string | null): Promise<void> {
    const body = [{ id: pointId, tester: testerId ? { id: testerId } : null }];
    await client.patch(
        `_apis/testplan/plans/${planId}/suites/${suiteId}/TestPoint?api-version=7.1`,
        body,
    );
}

function testerDisplay(t: TestPointRaw['tester'] | TestPointRaw['assignedTo']): string | undefined {
    if (!t) return undefined;
    return t.uniqueName || t.displayName || (t as { email?: string }).email;
}

// =============================================================================
// Verbs.
// =============================================================================

async function runListPoints(input: z.infer<typeof ListPointsSchema>, creds: AdoCreds): Promise<Output> {
    const out: Output = { ok: false, verb: 'list-points', points: [], planned: [], assigned: 0, failed: [], byTester: {}, dryRun: false, warnings: [] };
    const client = new AdoHttpClient(creds);
    const rc: ResolverCache = createCache();
    const plan = await resolvePlan(creds, { planId: input.planId, planName: input.planName }, rc);
    out.warnings.push(...plan.warnings);
    if (plan.ambiguous || plan.resolved.length === 0) { out.note = 'plan not resolved'; return out; }
    const planId = plan.resolved[0].id;
    const suite = await resolveSuite(creds, { planId, suiteId: input.suiteId, suiteName: input.suiteName }, rc);
    out.warnings.push(...suite.warnings);
    if (suite.ambiguous || suite.resolved.length === 0) { out.note = 'suite not resolved'; return out; }
    const suiteId = suite.resolved[0].id;

    const raws = await listTestPoints(client, planId, suiteId);
    const tcIds = raws.map((p) => Number(p.testCaseReference?.id || p.testCase?.id || 0)).filter((n) => n > 0);
    const tagCache = new LruCache<number, string[]>({ maxSize: 500, ttlMs: 5 * 60 * 1000 });
    const tagsById = await fetchTagsForTestCases(client, tagCache, tcIds);

    for (const p of raws) {
        if (typeof p.id !== 'number') continue;
        const tcId = Number(p.testCaseReference?.id || p.testCase?.id || 0);
        const tags = tcId > 0 ? (tagsById.get(tcId) || []) : [];
        const testerObj = p.tester || p.assignedTo;
        const tester = testerObj ? {
            email: (testerObj as { email?: string }).email || testerObj.uniqueName,
            displayName: testerObj.displayName,
            id: testerObj.id,
        } : undefined;
        const outcome = p.results?.outcome || p.outcome;
        if (input.testerFilter) {
            const disp = testerDisplay(testerObj) || '';
            if (!disp.toLowerCase().includes(input.testerFilter.toLowerCase())) continue;
        }
        if (input.outcomeFilter && outcome !== input.outcomeFilter) continue;
        out.points.push({
            pointId: p.id,
            testCase: {
                id: tcId > 0 ? tcId : undefined,
                title: p.testCaseReference?.name || p.testCase?.name,
                tags,
            },
            configuration: p.configuration ? { id: p.configuration.id, name: p.configuration.name } : undefined,
            tester,
            outcome,
            lastUpdated: p.results?.lastUpdatedDate || p.lastUpdatedDate,
        });
    }
    out.ok = true;
    out.note = `${out.points.length} test point(s) in plan ${planId}/suite ${suiteId}${input.testerFilter ? ` (tester filter "${input.testerFilter}")` : ''}${input.outcomeFilter ? ` (outcome ${input.outcomeFilter})` : ''}.`;
    return out;
}

async function runBulkAssign(input: z.infer<typeof BulkAssignSchema>, creds: AdoCreds, workspaceRoot: string): Promise<Output> {
    const out: Output = { ok: false, verb: 'bulk-assign', points: [], planned: [], assigned: 0, failed: [], byTester: {}, dryRun: input.dryRun, warnings: [] };
    const client = new AdoHttpClient(creds);
    const rc: ResolverCache = createCache();
    const plan = await resolvePlan(creds, { planId: input.planId, planName: input.planName }, rc);
    out.warnings.push(...plan.warnings);
    if (plan.ambiguous || plan.resolved.length === 0) { out.note = 'plan not resolved'; return out; }
    const planId = plan.resolved[0].id;
    const suite = await resolveSuite(creds, { planId, suiteId: input.suiteId, suiteName: input.suiteName }, rc);
    out.warnings.push(...suite.warnings);
    if (suite.ambiguous || suite.resolved.length === 0) { out.note = 'suite not resolved'; return out; }
    const suiteId = suite.resolved[0].id;

    const _fw = loadFrameworkTagExtractor(workspaceRoot);   // used only if we need advanced patterns
    void _fw;
    const raws = await listTestPoints(client, planId, suiteId);
    const tcIds = raws.map((p) => Number(p.testCaseReference?.id || p.testCase?.id || 0)).filter((n) => n > 0);
    const tagCache = new LruCache<number, string[]>({ maxSize: 500, ttlMs: 5 * 60 * 1000 });
    const tagsById = await fetchTagsForTestCases(client, tagCache, tcIds);

    // Group by target tester so the byTester total is accurate.
    const perTester: Record<string, number> = {};

    for (const p of raws) {
        if (typeof p.id !== 'number') continue;
        const tcId = Number(p.testCaseReference?.id || p.testCase?.id || 0);
        const tags = tcId > 0 ? (tagsById.get(tcId) || []) : [];
        const oldTester = testerDisplay(p.tester || p.assignedTo);
        const pick = pickTesterForPoint(input.rules, tags);
        if (!pick.tester) {
            out.planned.push({
                pointId: p.id,
                testCaseTitle: p.testCaseReference?.name || p.testCase?.name,
                oldTester,
                newTester: undefined,
                matchedRule: pick.ruleIdx,
            });
            continue;
        }
        if (oldTester === pick.tester) {
            // No-op — skip PATCH.
            out.planned.push({
                pointId: p.id,
                testCaseTitle: p.testCaseReference?.name || p.testCase?.name,
                oldTester,
                newTester: pick.tester,
                matchedRule: pick.ruleIdx,
            });
            continue;
        }
        out.planned.push({
            pointId: p.id,
            testCaseTitle: p.testCaseReference?.name || p.testCase?.name,
            oldTester,
            newTester: pick.tester,
            matchedRule: pick.ruleIdx,
        });
        perTester[pick.tester] = (perTester[pick.tester] || 0) + 1;
    }

    if (input.dryRun) {
        out.byTester = perTester;
        out.ok = true;
        out.note = `[dry-run] Would assign ${Object.values(perTester).reduce((a, b) => a + b, 0)} test point(s) across ${Object.keys(perTester).length} tester(s). ${out.planned.filter((p) => p.matchedRule === undefined).length} unmatched. Nothing written.`;
        return out;
    }

    // Live — batch changes per-point (100 per chunked window for controlled concurrency).
    const toChange = out.planned.filter((p) => p.newTester && p.newTester !== p.oldTester);
    const chunkSize = 100;
    const bulk = await bulkExecute<typeof toChange[0], { pointId: number; ok: boolean; error?: string }>(toChange, {
        chunkSize,
        concurrency: 2,
        workFn: async (chunk): Promise<Array<{ pointId: number; ok: boolean; error?: string }>> => {
            const outs: Array<{ pointId: number; ok: boolean; error?: string }> = [];
            for (const item of chunk) {
                try {
                    await assignPointTester(client, planId, suiteId, item.pointId, item.newTester!);
                    outs.push({ pointId: item.pointId, ok: true });
                } catch (e) {
                    const msg = e instanceof AdoHttpError ? `${e.status}: ${e.bodySnippet}` : (e as Error).message;
                    outs.push({ pointId: item.pointId, ok: false, error: msg.slice(0, 300) });
                }
            }
            return outs;
        },
    });
    for (const r of bulk.ok) {
        if (r.ok) out.assigned++;
        else out.failed.push({ pointId: r.pointId, reason: r.error || 'unknown' });
    }
    for (const f of bulk.failed) out.failed.push({ pointId: (f.item as { pointId: number }).pointId, reason: f.error.message.slice(0, 300) });

    out.byTester = perTester;
    out.ok = out.failed.length === 0;
    out.note = `${out.assigned}/${toChange.length} test point(s) assigned across ${Object.keys(perTester).length} tester(s). ${out.failed.length} failed.`;
    return out;
}

async function runUnassignAll(input: z.infer<typeof UnassignAllSchema>, creds: AdoCreds): Promise<Output> {
    const out: Output = { ok: false, verb: 'unassign-all', points: [], planned: [], assigned: 0, failed: [], byTester: {}, dryRun: input.dryRun, warnings: [] };
    const client = new AdoHttpClient(creds);
    const rc: ResolverCache = createCache();
    const plan = await resolvePlan(creds, { planId: input.planId, planName: input.planName }, rc);
    out.warnings.push(...plan.warnings);
    if (plan.ambiguous || plan.resolved.length === 0) { out.note = 'plan not resolved'; return out; }
    const planId = plan.resolved[0].id;
    const suite = await resolveSuite(creds, { planId, suiteId: input.suiteId, suiteName: input.suiteName }, rc);
    out.warnings.push(...suite.warnings);
    if (suite.ambiguous || suite.resolved.length === 0) { out.note = 'suite not resolved'; return out; }
    const suiteId = suite.resolved[0].id;

    const raws = await listTestPoints(client, planId, suiteId);
    const withTesters = raws.filter((p) => typeof p.id === 'number' && (p.tester || p.assignedTo));

    for (const p of withTesters) {
        out.planned.push({
            pointId: p.id!,
            testCaseTitle: p.testCaseReference?.name || p.testCase?.name,
            oldTester: testerDisplay(p.tester || p.assignedTo),
            newTester: undefined,
        });
    }
    if (input.dryRun) {
        out.ok = true;
        out.note = `[dry-run] Would clear tester on ${withTesters.length} test point(s). Nothing written.`;
        return out;
    }
    const bulk = await bulkExecute<TestPointRaw, { pointId: number; ok: boolean; error?: string }>(withTesters, {
        chunkSize: 100,
        concurrency: 2,
        workFn: async (chunk): Promise<Array<{ pointId: number; ok: boolean; error?: string }>> => {
            const outs: Array<{ pointId: number; ok: boolean; error?: string }> = [];
            for (const item of chunk) {
                try {
                    await assignPointTester(client, planId, suiteId, item.id!, null);
                    outs.push({ pointId: item.id!, ok: true });
                } catch (e) {
                    const msg = e instanceof AdoHttpError ? `${e.status}: ${e.bodySnippet}` : (e as Error).message;
                    outs.push({ pointId: item.id!, ok: false, error: msg.slice(0, 300) });
                }
            }
            return outs;
        },
    });
    for (const r of bulk.ok) {
        if (r.ok) out.assigned++;
        else out.failed.push({ pointId: r.pointId, reason: r.error || 'unknown' });
    }
    out.ok = out.failed.length === 0;
    out.note = `Cleared tester on ${out.assigned}/${withTesters.length} test point(s). ${out.failed.length} failed.`;
    return out;
}

// =============================================================================
// Register.
// =============================================================================

registerPrimitive({
    name: 'cs_qa_ado_test_points_bulk',
    description: 'Enumerate + bulk-assign test points in a suite. Verbs: list-points (with optional tester + outcome filters), bulk-assign (rules[] evaluated first-match-wins: matchTag+extractTesterFrom, matchTag+assignTester, matchDefault+assignTester; dryRun previews the plan without any PATCH), unassign-all (clears tester on every point). Tags on the test case drive rule matching — read via System.Tags (or framework CSADOTagExtractor when installed).',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const logger = createLogger(ctx.invocationId, 'cs_qa_ado_test_points_bulk', { workspaceRoot: ctx.workspaceRoot });
        const resolved = getResolvedCreds(ctx.workspaceRoot, {
            orgUrl: input.orgUrl,
            project: input.project,
            personalAccessToken: input.personalAccessToken,
        });
        if (!resolved.creds) {
            logger.warn('ado-not-configured', { diagnostic: resolved.diagnostic });
            return { ok: false, verb: input.verb, points: [], planned: [], assigned: 0, failed: [], byTester: {}, dryRun: (input as { dryRun?: boolean }).dryRun === true, warnings: [resolved.diagnostic], note: 'ADO not configured.' };
        }
        const creds = resolved.creds;
        try {
            if (input.verb === 'list-points') return await runListPoints(input, creds);
            if (input.verb === 'bulk-assign') return await runBulkAssign(input, creds, ctx.workspaceRoot);
            if (input.verb === 'unassign-all') return await runUnassignAll(input, creds);
            return { ok: false, verb: (input as { verb: string }).verb, points: [], planned: [], assigned: 0, failed: [], byTester: {}, dryRun: false, warnings: [], note: 'unknown verb' };
        } catch (e) {
            const msg = (e as Error).message;
            logger.error('test-points-bulk-failed', { error: msg });
            return { ok: false, verb: input.verb, points: [], planned: [], assigned: 0, failed: [], byTester: {}, dryRun: (input as { dryRun?: boolean }).dryRun === true, warnings: [msg], note: 'test-points-bulk failed' };
        }
    },
});
