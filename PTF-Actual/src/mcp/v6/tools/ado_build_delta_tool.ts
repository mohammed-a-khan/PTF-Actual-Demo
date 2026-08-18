/**
 * cs_qa_ado_build_delta — "what changed on <branch> since the last successful build?"
 *
 * Resolves a build (by id, or "latest successful" for a definition + branch),
 * pulls its commits + linked work items, and optionally diffs against the
 * previous successful build for the same definition+branch. Optional test-run
 * expansion highlights regression candidates: tests that failed in this build
 * but passed in the previous run.
 *
 * Read-only tool. All calls go through AdoHttpClient (Retry-After honored,
 * PAT redacted from errors). LruCache short-circuits repeated GETs during a
 * single invocation. bulkExecute drives the test-run breakdown for large runs.
 */
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { LruCache } from './_helpers/ado_lru_cache';
import { bulkExecute } from './_helpers/bulk_batcher';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';

// =============================================================================
// Types.
// =============================================================================

interface BuildDef {
    id?: number;
    name?: string;
}

interface Build {
    id?: number;
    buildNumber?: string;
    definition?: BuildDef;
    sourceBranch?: string;
    sourceVersion?: string;
    requestedFor?: { displayName?: string; uniqueName?: string };
    requestedBy?: { displayName?: string; uniqueName?: string };
    startTime?: string;
    finishTime?: string;
    status?: string;
    result?: string;
    _links?: { web?: { href?: string } };
}

interface Change {
    id?: string;
    author?: { displayName?: string; uniqueName?: string };
    message?: string;
    timestamp?: string;
}

interface WorkItemRef {
    id?: number;
    url?: string;
}

interface WorkItemFull {
    id?: number;
    fields?: {
        'System.Title'?: string;
        'System.WorkItemType'?: string;
        'System.State'?: string;
    };
    url?: string;
}

interface TestRun {
    id?: number;
    name?: string;
    state?: string;
    buildConfiguration?: { id?: number };
    totalTests?: number;
    passedTests?: number;
    incompleteTests?: number;
    unanalyzedTests?: number;
}

interface TestResult {
    id?: number;
    testCase?: { id?: string; name?: string };
    testCaseTitle?: string;
    outcome?: string;
    state?: string;
    testCaseReferenceId?: number;
}

// =============================================================================
// Zod.
// =============================================================================

const InputSchema = z.object({
    definitionId: z.number().int().positive().optional(),
    definitionName: z.string().min(1).optional().describe('Definition name; supports wildcards like "*login*" — matches contains-case-insensitive.'),
    branchName: z.string().default('main').describe('Branch filter for "latest successful" lookup. Ignored when buildId is passed.'),
    buildId: z.number().int().positive().optional().describe('Explicit build; when omitted, resolves to latest succeeded for definition+branch.'),
    compareToPreviousSuccess: z.boolean().default(true),
    includeTestResults: z.boolean().default(false),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    personalAccessToken: z.string().min(1).optional(),
}).refine((v) => v.definitionId !== undefined || v.definitionName !== undefined || v.buildId !== undefined, {
    message: 'One of definitionId, definitionName, or buildId is required.',
});

const OutputSchema = z.object({
    ok: z.boolean(),
    build: z.object({
        id: z.number().optional(),
        buildNumber: z.string().optional(),
        definitionName: z.string().optional(),
        branch: z.string().optional(),
        commit: z.string().optional(),
        startedBy: z.string().optional(),
        startedAt: z.string().optional(),
        finishedAt: z.string().optional(),
        durationMinutes: z.number().optional(),
        result: z.string().optional(),
        url: z.string().optional(),
    }).optional(),
    changes: z.array(z.object({
        commitId: z.string().optional(),
        author: z.string().optional(),
        message: z.string().optional(),
        timestamp: z.string().optional(),
    })).default([]),
    linkedWorkItems: z.array(z.object({
        id: z.number(),
        title: z.string().optional(),
        type: z.string().optional(),
        state: z.string().optional(),
        url: z.string().optional(),
    })).default([]),
    delta: z.object({
        previousBuildId: z.number(),
        previousBuildNumber: z.string().optional(),
        commitsAdded: z.array(z.string()).default([]),
        commitsRemoved: z.array(z.string()).default([]),
        workItemsAdded: z.array(z.number()).default([]),
    }).optional(),
    testResults: z.object({
        runs: z.number(),
        passed: z.number(),
        failed: z.number(),
        regressionCandidates: z.array(z.object({
            testCaseId: z.number().optional(),
            title: z.string().optional(),
            previousOutcome: z.string(),
            currentOutcome: z.string(),
        })).default([]),
    }).optional(),
    warnings: z.array(z.string()).default([]),
    note: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

// =============================================================================
// Helpers.
// =============================================================================

function normalizeBranch(ref: string): string {
    // ADO's queries want the FULL ref (refs/heads/main); short names are courtesy.
    if (ref.startsWith('refs/')) return ref;
    return `refs/heads/${ref}`;
}

function durationMinutes(start?: string, finish?: string): number | undefined {
    if (!start || !finish) return undefined;
    const s = Date.parse(start);
    const f = Date.parse(finish);
    if (Number.isNaN(s) || Number.isNaN(f)) return undefined;
    return Math.max(0, Math.round(((f - s) / 60000) * 10) / 10);
}

async function resolveDefinitionId(client: AdoHttpClient, cache: LruCache<string, unknown>, definitionId?: number, definitionName?: string): Promise<{ id?: number; name?: string; warnings: string[] }> {
    if (definitionId !== undefined) return { id: definitionId, warnings: [] };
    if (!definitionName) return { warnings: ['Neither definitionId nor definitionName provided.'] };
    const cacheKey = `def::${definitionName}`;
    const cached = cache.get(cacheKey) as { value?: Array<{ id?: number; name?: string }> } | undefined;
    const list = cached ?? await client.get<{ value?: Array<{ id?: number; name?: string }> }>(`_apis/build/definitions?api-version=7.1&name=${encodeURIComponent(definitionName)}`);
    if (!cached) cache.set(cacheKey, list);
    const defs = list.value || [];
    if (defs.length === 0) {
        // Wildcard fallback — sometimes the "?name=" filter is exact; try contains.
        if (definitionName.includes('*')) {
            const bare = definitionName.replace(/\*/g, '').toLowerCase();
            const allKey = `def::__all__`;
            const cachedAll = cache.get(allKey) as { value?: Array<{ id?: number; name?: string }> } | undefined;
            const all = cachedAll ?? await client.get<{ value?: Array<{ id?: number; name?: string }> }>(`_apis/build/definitions?api-version=7.1`);
            if (!cachedAll) cache.set(allKey, all);
            const contains = (all.value || []).filter((d) => (d.name || '').toLowerCase().includes(bare));
            if (contains.length === 1) return { id: contains[0].id, name: contains[0].name, warnings: [] };
            if (contains.length > 1) return { warnings: [`Definition name "${definitionName}" matched ${contains.length} definitions — pass definitionId or a more specific pattern.`] };
        }
        return { warnings: [`No build definition found for "${definitionName}".`] };
    }
    if (defs.length > 1) return { warnings: [`Definition name "${definitionName}" matched ${defs.length} definitions — pass definitionId.`] };
    return { id: defs[0].id, name: defs[0].name, warnings: [] };
}

async function getLatestSuccessful(client: AdoHttpClient, definitionId: number, branch: string): Promise<Build | null> {
    const url = `_apis/build/builds?api-version=7.1&definitions=${definitionId}&branchName=${encodeURIComponent(normalizeBranch(branch))}&statusFilter=completed&resultFilter=succeeded&$top=1&queryOrder=finishTimeDescending`;
    const res = await client.get<{ value?: Build[] }>(url);
    return (res.value || [])[0] || null;
}

async function getBuild(client: AdoHttpClient, buildId: number): Promise<Build> {
    return await client.get<Build>(`_apis/build/builds/${buildId}?api-version=7.1`);
}

async function getBuildChanges(client: AdoHttpClient, buildId: number): Promise<Change[]> {
    const res = await client.get<{ value?: Change[] }>(`_apis/build/builds/${buildId}/changes?api-version=7.1&$top=200`);
    return res.value || [];
}

async function getBuildWorkItems(client: AdoHttpClient, buildId: number): Promise<WorkItemRef[]> {
    const res = await client.get<{ value?: WorkItemRef[] }>(`_apis/build/builds/${buildId}/workitems?api-version=7.1&$top=200`);
    return res.value || [];
}

async function fetchWorkItemBatch(client: AdoHttpClient, ids: number[]): Promise<WorkItemFull[]> {
    if (ids.length === 0) return [];
    // ADO batch endpoint via POST /wit/workitemsbatch — accepts 200 per call.
    const body = {
        ids,
        fields: ['System.Id', 'System.Title', 'System.WorkItemType', 'System.State'],
    };
    const res = await client.post<{ value?: WorkItemFull[] }>(`_apis/wit/workitemsbatch?api-version=7.1`, body);
    return res.value || [];
}

async function getPreviousSuccessful(client: AdoHttpClient, definitionId: number, branch: string, beforeFinishTime: string): Promise<Build | null> {
    const url = `_apis/build/builds?api-version=7.1&definitions=${definitionId}&branchName=${encodeURIComponent(normalizeBranch(branch))}&statusFilter=completed&resultFilter=succeeded&$top=1&queryOrder=finishTimeDescending&maxFinishTime=${encodeURIComponent(new Date(Date.parse(beforeFinishTime) - 1000).toISOString())}`;
    const res = await client.get<{ value?: Build[] }>(url);
    return (res.value || [])[0] || null;
}

async function fetchTestRunsForBuild(client: AdoHttpClient, buildId: number): Promise<TestRun[]> {
    const res = await client.get<{ value?: TestRun[] }>(`_apis/test/runs?api-version=7.1&buildIds=${buildId}&$top=200`);
    return res.value || [];
}

async function fetchTestResultsForRun(client: AdoHttpClient, runId: number, outcomes?: string): Promise<TestResult[]> {
    const q = outcomes ? `&outcomes=${encodeURIComponent(outcomes)}` : '';
    const res = await client.get<{ value?: TestResult[] }>(`_apis/test/runs/${runId}/results?api-version=7.1${q}&$top=500`);
    return res.value || [];
}

// =============================================================================
// Registration.
// =============================================================================

registerPrimitive({
    name: 'cs_qa_ado_build_delta',
    description: 'Report what changed in a build: resolves a build (by id, or latest-successful for a definition+branch), pulls commits + linked work items, optionally diffs against the previous successful build, and optionally expands test-run results to highlight regression candidates (tests that failed in this build but passed in the previous one). Read-only — no ADO writes.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const logger = createLogger(ctx.invocationId, 'cs_qa_ado_build_delta', { workspaceRoot: ctx.workspaceRoot });
        const resolved = getResolvedCreds(ctx.workspaceRoot, {
            orgUrl: input.orgUrl,
            project: input.project,
            personalAccessToken: input.personalAccessToken,
        });
        const out: Output = { ok: false, changes: [], linkedWorkItems: [], warnings: [], note: '' };
        if (!resolved.creds) {
            out.warnings.push(resolved.diagnostic);
            out.note = 'ADO not configured.';
            return out;
        }
        const creds: AdoCreds = resolved.creds;
        const client = new AdoHttpClient(creds);
        const cache = new LruCache<string, unknown>({ maxSize: 50, ttlMs: 5 * 60 * 1000 });
        try {
            // 1. Resolve the target build.
            let build: Build | null = null;
            let definitionId: number | undefined;
            let definitionName: string | undefined = input.definitionName;
            if (input.buildId !== undefined) {
                build = await getBuild(client, input.buildId);
                definitionId = build?.definition?.id;
                definitionName = build?.definition?.name;
            } else {
                const def = await resolveDefinitionId(client, cache, input.definitionId, input.definitionName);
                out.warnings.push(...def.warnings);
                if (!def.id) {
                    out.note = 'Could not resolve build definition.';
                    return out;
                }
                definitionId = def.id;
                definitionName = def.name || input.definitionName;
                build = await getLatestSuccessful(client, definitionId, input.branchName);
                if (!build) {
                    out.note = `No successful build found for definition ${definitionId} on branch ${input.branchName}.`;
                    return out;
                }
            }
            if (!build || build.id === undefined) {
                out.note = 'Build lookup returned nothing.';
                return out;
            }

            out.build = {
                id: build.id,
                buildNumber: build.buildNumber,
                definitionName: definitionName || build.definition?.name,
                branch: build.sourceBranch,
                commit: build.sourceVersion,
                startedBy: build.requestedFor?.displayName || build.requestedBy?.displayName,
                startedAt: build.startTime,
                finishedAt: build.finishTime,
                durationMinutes: durationMinutes(build.startTime, build.finishTime),
                result: build.result,
                url: build._links?.web?.href,
            };

            // 2. Changes + linked work items in parallel.
            const [changes, wiRefs] = await Promise.all([
                getBuildChanges(client, build.id),
                getBuildWorkItems(client, build.id),
            ]);
            out.changes = changes.map((c) => ({
                commitId: c.id,
                author: c.author?.displayName || c.author?.uniqueName,
                message: c.message,
                timestamp: c.timestamp,
            }));

            // 3. Expand linked WI ids to titles / types / states via workitemsbatch.
            const wiIds = wiRefs.map((r) => r.id).filter((n): n is number => typeof n === 'number' && n > 0);
            const fullWis = wiIds.length > 0 ? await fetchWorkItemBatch(client, wiIds.slice(0, 200)) : [];
            const byId = new Map<number, WorkItemFull>();
            for (const w of fullWis) if (typeof w.id === 'number') byId.set(w.id, w);
            out.linkedWorkItems = wiIds.map((id) => {
                const w = byId.get(id);
                return {
                    id,
                    title: w?.fields?.['System.Title'],
                    type: w?.fields?.['System.WorkItemType'],
                    state: w?.fields?.['System.State'],
                    url: w?.url,
                };
            });

            // 4. Optional: delta vs previous successful build.
            let previousBuild: Build | null = null;
            if (input.compareToPreviousSuccess && definitionId !== undefined && build.finishTime) {
                previousBuild = await getPreviousSuccessful(client, definitionId, build.sourceBranch?.replace(/^refs\/heads\//, '') || input.branchName, build.finishTime);
                if (previousBuild && previousBuild.id !== undefined && previousBuild.id !== build.id) {
                    const [prevChanges, prevWis] = await Promise.all([
                        getBuildChanges(client, previousBuild.id),
                        getBuildWorkItems(client, previousBuild.id),
                    ]);
                    const prevCommitIds = new Set((prevChanges || []).map((c) => c.id || '').filter(Boolean));
                    const curCommitIds = new Set(changes.map((c) => c.id || '').filter(Boolean));
                    const prevWiIds = new Set((prevWis || []).map((w) => w.id).filter((n): n is number => typeof n === 'number'));
                    const curWiIds = new Set(wiIds);
                    out.delta = {
                        previousBuildId: previousBuild.id,
                        previousBuildNumber: previousBuild.buildNumber,
                        commitsAdded: Array.from(curCommitIds).filter((c) => !prevCommitIds.has(c)),
                        commitsRemoved: Array.from(prevCommitIds).filter((c) => !curCommitIds.has(c)),
                        workItemsAdded: Array.from(curWiIds).filter((id) => !prevWiIds.has(id)),
                    };
                } else if (previousBuild && previousBuild.id === build.id) {
                    out.warnings.push('Previous successful build resolved to same id — no delta.');
                } else {
                    out.warnings.push('No previous successful build found for delta.');
                }
            }

            // 5. Optional: test results + regression candidates.
            if (input.includeTestResults) {
                const runs = await fetchTestRunsForBuild(client, build.id);
                let passed = 0;
                let failed = 0;
                // Aggregate failed cases in current build.
                const currentFailedByTcId = new Map<number, TestResult>();
                const batches = await bulkExecute<TestRun, TestResult[]>(runs, {
                    chunkSize: 1,
                    concurrency: 4,
                    workFn: async (chunk: TestRun[]): Promise<TestResult[][]> => {
                        const run = chunk[0];
                        if (typeof run.id !== 'number') return [[]];
                        const results = await fetchTestResultsForRun(client, run.id, 'Failed');
                        return [results];
                    },
                    onChunkError: (err) => { out.warnings.push(`test-run fetch failed: ${err.message.slice(0, 200)}`); },
                });
                for (const run of runs) {
                    passed += run.passedTests || 0;
                    failed += Math.max(0, (run.totalTests || 0) - (run.passedTests || 0) - (run.incompleteTests || 0) - (run.unanalyzedTests || 0));
                }
                for (const set of batches.ok) {
                    for (const r of set) {
                        const tcId = r.testCaseReferenceId || Number(r.testCase?.id || 0);
                        if (tcId > 0) currentFailedByTcId.set(tcId, r);
                    }
                }
                // Regression candidates require previous build's test results.
                const regressionCandidates: Array<{ testCaseId?: number; title?: string; previousOutcome: string; currentOutcome: string }> = [];
                if (previousBuild && previousBuild.id !== undefined && currentFailedByTcId.size > 0) {
                    const prevRuns = await fetchTestRunsForBuild(client, previousBuild.id);
                    const prevPassedTcIds = new Set<number>();
                    const prevBatches = await bulkExecute<TestRun, TestResult[]>(prevRuns, {
                        chunkSize: 1,
                        concurrency: 4,
                        workFn: async (chunk: TestRun[]): Promise<TestResult[][]> => {
                            const run = chunk[0];
                            if (typeof run.id !== 'number') return [[]];
                            const results = await fetchTestResultsForRun(client, run.id, 'Passed');
                            return [results];
                        },
                        onChunkError: (err) => { out.warnings.push(`prev test-run fetch failed: ${err.message.slice(0, 200)}`); },
                    });
                    for (const set of prevBatches.ok) {
                        for (const r of set) {
                            const tcId = r.testCaseReferenceId || Number(r.testCase?.id || 0);
                            if (tcId > 0) prevPassedTcIds.add(tcId);
                        }
                    }
                    for (const [tcId, r] of currentFailedByTcId) {
                        if (prevPassedTcIds.has(tcId)) {
                            regressionCandidates.push({
                                testCaseId: tcId,
                                title: r.testCaseTitle || r.testCase?.name,
                                previousOutcome: 'Passed',
                                currentOutcome: r.outcome || 'Failed',
                            });
                        }
                    }
                }
                out.testResults = {
                    runs: runs.length,
                    passed,
                    failed,
                    regressionCandidates,
                };
            }

            out.ok = true;
            out.note = `Build ${build.buildNumber || build.id}: ${out.changes.length} change(s), ${out.linkedWorkItems.length} linked WI(s)${out.delta ? `, delta vs #${out.delta.previousBuildNumber || out.delta.previousBuildId} (${out.delta.commitsAdded.length} new commits, ${out.delta.workItemsAdded.length} new WIs)` : ''}${out.testResults ? `, ${out.testResults.runs} test-run(s), ${out.testResults.regressionCandidates.length} regression candidate(s)` : ''}.`;
            return out;
        } catch (e) {
            const msg = (e as Error).message;
            logger.error('build-delta-failed', { error: msg });
            out.warnings.push(msg);
            out.note = 'build-delta failed';
            return out;
        }
    },
});
