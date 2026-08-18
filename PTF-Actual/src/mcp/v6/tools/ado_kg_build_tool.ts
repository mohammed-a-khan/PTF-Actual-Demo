/**
 * cs_qa_kg_build — build a persistent knowledge graph of QA state.
 *
 * Walks:
 *   - ADO stories/features/bugs in scope (iteration or all)
 *   - ADO test cases linked via TestedBy relations
 *   - ADO test runs + results
 *   - Git log (commit range) with changed files
 *   - Local .feature files → FeatureFile + Scenario nodes
 *
 * Emits a typed graph { nodes[], edges[], meta } and persists to
 * `.cs-qa/kg/graph.json` (or a custom path).
 *
 * Node types:
 *   Story, Feature, Bug, TestCase, Run, Result, Commit, Deploy, Owner,
 *   FeatureFile, Scenario
 *
 * Edge types (all typed, all directed):
 *   Story --tests--> TestCase
 *   TestCase --covers--> Scenario
 *   Bug --found_in--> Run
 *   Bug --regresses--> TestCase
 *   Result --for--> TestCase
 *   Result --in--> Run
 *   Run --executed--> TestCase
 *   Commit --touches--> FeatureFile
 *   Commit --touches--> Scenario
 *   Deploy --includes--> Commit
 *   Story --owned_by--> Owner
 *   TestCase --owned_by--> Owner
 *   Bug --owned_by--> Owner
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds, AdoHttpError } from './_helpers/ado_http_client';
import { bulkExecute } from './_helpers/bulk_batcher';
import { createLogger } from './_helpers/structured_logger';
import { wiql } from './_helpers/wiql_builder';
import { getResolvedCreds } from './ado_config_tool';
import { extractTestCaseIdsFromScenario } from './sync_feature_tags';

// =============================================================================
// Node + edge type constants.
// =============================================================================

export const NODE_TYPES = [
    'Story', 'Feature', 'Bug', 'TestCase', 'Run', 'Result',
    'Commit', 'Deploy', 'Owner', 'FeatureFile', 'Scenario',
] as const;

export type NodeType = typeof NODE_TYPES[number];

export const EDGE_TYPES = [
    'tests', 'covers', 'found_in', 'regresses', 'for', 'in', 'executed',
    'touches', 'includes', 'owned_by',
] as const;

export type EdgeType = typeof EDGE_TYPES[number];

const REL_TESTED_BY_FORWARD = 'Microsoft.VSTS.Common.TestedBy-Forward';
const REL_TESTED_BY_REVERSE = 'Microsoft.VSTS.Common.TestedBy-Reverse';

// =============================================================================
// Node shape schemas — permissive on extra fields (Zod passthrough style via
// z.object without strict), because different node types carry different data.
// =============================================================================

const NodeSchema = z.object({
    id: z.string(),          // synthetic — e.g. "Story:1234", "Commit:abc123"
    type: z.enum(NODE_TYPES),
    props: z.record(z.string(), z.unknown()),
});
type Node = z.infer<typeof NodeSchema>;

const EdgeSchema = z.object({
    from: z.string(),
    to: z.string(),
    type: z.enum(EDGE_TYPES),
    props: z.record(z.string(), z.unknown()).optional(),
});
type Edge = z.infer<typeof EdgeSchema>;

const GraphSchema = z.object({
    nodes: z.array(NodeSchema),
    edges: z.array(EdgeSchema),
    meta: z.object({
        builtAt: z.string(),
        scope: z.record(z.string(), z.unknown()),
        stats: z.record(z.string(), z.number()),
    }),
});
export type Graph = z.infer<typeof GraphSchema>;

// =============================================================================
// Input.
// =============================================================================

const ScopeSchema = z.object({
    iterationPath: z.string().min(1).optional().describe('Iteration path filter for ADO WIs. Default: current iteration for the resolved team.'),
    planIds: z.array(z.number().int().positive()).optional().describe('Test plan ids whose runs to walk. Default: none (skip runs).'),
    commitRange: z.string().optional().describe('Git commit range (e.g. main..HEAD or abc..def). Default: last 90 days.'),
    featureRoot: z.string().optional().describe('Root path scanned for .feature files. Default: workspaceRoot/test.'),
    team: z.string().optional(),
}).default({});

const InputSchema = z.object({
    scope: ScopeSchema,
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    pat: z.string().min(1).optional(),
    persist: z.boolean().default(true),
    outputPath: z.string().min(1).optional(),
    verbose: z.boolean().default(false),
});
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
    ok: z.boolean(),
    graphPath: z.string().optional(),
    stats: z.object({
        stories: z.number(),
        features: z.number(),
        bugs: z.number(),
        testCases: z.number(),
        runs: z.number(),
        results: z.number(),
        commits: z.number(),
        deploys: z.number(),
        owners: z.number(),
        featureFiles: z.number(),
        scenarios: z.number(),
        edges: z.number(),
    }),
    warnings: z.array(z.string()).default([]),
    note: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

// =============================================================================
// Small helpers.
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

function readAssignedTo(fields: Record<string, unknown> | undefined): { displayName: string; email: string } {
    const v = readField<unknown>(fields, 'System.AssignedTo');
    if (v == null) return { displayName: '', email: '' };
    if (typeof v === 'string') return { displayName: v, email: v.includes('@') ? v : '' };
    const rec = v as { displayName?: string; uniqueName?: string; mailAddress?: string };
    return {
        displayName: rec.displayName ?? rec.uniqueName ?? '',
        email: rec.mailAddress ?? rec.uniqueName ?? '',
    };
}

function parseTags(raw: unknown): string[] {
    if (typeof raw !== 'string') return [];
    return raw.split(';').map((t) => t.trim()).filter(Boolean);
}

function extractRelatedIdFromUrl(url: string): number | null {
    const m = /\/workItems\/(\d+)(?:\?|$|\/)/i.exec(url);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
}

function buildWiUrl(orgUrl: string, project: string, id: number): string {
    return `${orgUrl.replace(/\/$/, '')}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
}

// =============================================================================
// Graph state accumulator — dedupes nodes and edges as they arrive.
// =============================================================================

class GraphAccum {
    private nodes = new Map<string, Node>();
    private edgeKeys = new Set<string>();
    private edgeList: Edge[] = [];
    public warnings: string[] = [];

    upsertNode(type: NodeType, key: string | number, props: Record<string, unknown>): string {
        const id = `${type}:${key}`;
        const existing = this.nodes.get(id);
        if (existing) {
            // Merge — new props win when defined.
            existing.props = { ...existing.props, ...props };
            return id;
        }
        this.nodes.set(id, { id, type, props });
        return id;
    }

    addEdge(from: string, to: string, type: EdgeType, props?: Record<string, unknown>): void {
        const key = `${from}|${type}|${to}`;
        if (this.edgeKeys.has(key)) return;
        this.edgeKeys.add(key);
        this.edgeList.push({ from, to, type, props });
    }

    hasNode(type: NodeType, key: string | number): boolean {
        return this.nodes.has(`${type}:${key}`);
    }

    countByType(type: NodeType): number {
        let c = 0;
        for (const n of this.nodes.values()) if (n.type === type) c++;
        return c;
    }

    toGraph(scope: Record<string, unknown>): Graph {
        const stats: Record<string, number> = {};
        for (const t of NODE_TYPES) stats[t.toLowerCase()] = this.countByType(t);
        stats.edges = this.edgeList.length;
        return {
            nodes: Array.from(this.nodes.values()).sort((a, b) => a.id.localeCompare(b.id)),
            edges: this.edgeList.slice().sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.type.localeCompare(b.type)),
            meta: {
                builtAt: new Date().toISOString(),
                scope,
                stats,
            },
        };
    }
}

// =============================================================================
// ADO fetches.
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

async function queryIterationWorkItemIds(client: AdoHttpClient, iterationPath: string, warnings: string[]): Promise<number[]> {
    const q = wiql().select(['[System.Id]']).from('WorkItems');
    const clause = q.where().in('[System.WorkItemType]', ['User Story', 'Feature', 'Bug', 'Requirement', 'Product Backlog Item']);
    clause.and().iteration(iterationPath);
    const query = q.build();
    try {
        const res = await client.post<{ workItems?: Array<{ id: number }> }>(`_apis/wit/wiql?api-version=7.1`, { query });
        return (res.workItems ?? []).map((w) => Number(w.id)).filter((n) => Number.isFinite(n) && n > 0);
    } catch (e) {
        const err = e as AdoHttpError | Error;
        warnings.push(`WIQL iteration query failed: ${err.message.slice(0, 250)}`);
        return [];
    }
}

async function batchFetchWorkItemsWithRelations(client: AdoHttpClient, ids: number[], warnings: string[]): Promise<Map<number, WorkItem>> {
    const out = new Map<number, WorkItem>();
    if (ids.length === 0) return out;
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
            warnings.push(`WI batch ${chunkIndex + 1} failed: ${err.message.slice(0, 200)}`);
        },
    });
    for (const w of bulk.ok) if (typeof w.id === 'number') out.set(w.id, w);
    return out;
}

interface RunEntry {
    id: number;
    name?: string;
    state?: string;
    startedDate?: string;
    completedDate?: string;
    plan?: { id?: string | number };
    build?: { id?: string | number };
    owner?: { displayName?: string; uniqueName?: string };
}

async function listRunsForPlan(client: AdoHttpClient, planId: number, warnings: string[]): Promise<RunEntry[]> {
    try {
        const res = await client.get<{ value?: RunEntry[] }>(`_apis/test/runs?planId=${planId}&api-version=7.1&$top=200`);
        return res?.value ?? [];
    } catch (e) {
        const err = e as AdoHttpError | Error;
        warnings.push(`runs list for plan ${planId} failed: ${err.message.slice(0, 200)}`);
        return [];
    }
}

interface ResultEntry {
    id: number;
    testRun?: { id?: string | number };
    testCase?: { id?: string | number };
    outcome?: string;
    durationInMs?: number;
    errorMessage?: string;
    completedDate?: string;
}

async function listResultsForRun(client: AdoHttpClient, runId: number, warnings: string[]): Promise<ResultEntry[]> {
    try {
        const res = await client.get<{ value?: ResultEntry[] }>(`_apis/test/runs/${runId}/results?api-version=7.1&$top=1000`);
        return res?.value ?? [];
    } catch (e) {
        const err = e as AdoHttpError | Error;
        warnings.push(`results for run ${runId} failed: ${err.message.slice(0, 200)}`);
        return [];
    }
}

interface BuildEntry {
    id: number;
    buildNumber?: string;
    status?: string;
    result?: string;
    queueTime?: string;
    startTime?: string;
    finishTime?: string;
    sourceVersion?: string;
    requestedFor?: { displayName?: string; uniqueName?: string };
    project?: { name?: string };
}

async function listRecentBuilds(client: AdoHttpClient, warnings: string[]): Promise<BuildEntry[]> {
    try {
        const res = await client.get<{ value?: BuildEntry[] }>(`_apis/build/builds?api-version=7.1&$top=50`);
        return res?.value ?? [];
    } catch (e) {
        const err = e as AdoHttpError | Error;
        // Only warn if it's not a "not found/unavailable" — many on-prem ADOs restrict this endpoint.
        warnings.push(`build history unavailable: ${err.message.slice(0, 150)}`);
        return [];
    }
}

// =============================================================================
// Git walking.
// =============================================================================

interface CommitEntry {
    sha: string;
    author: string;
    email: string;
    date: string;
    message: string;
    changedFiles: string[];
}

function runGit(args: string[], cwd: string, timeoutMs = 15000): { stdout: string; stderr: string; code: number } {
    const r = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: timeoutMs, shell: false, maxBuffer: 20 * 1024 * 1024 });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

function walkGitLog(cwd: string, commitRange: string | undefined, warnings: string[]): CommitEntry[] {
    // If not a git repo, degrade to [].
    const check = runGit(['rev-parse', '--is-inside-work-tree'], cwd);
    if (check.code !== 0) {
        warnings.push('not a git repo — Commit nodes will be empty');
        return [];
    }
    const args = ['log', '--format=%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%s', '--name-only'];
    if (commitRange) {
        args.push(commitRange);
    } else {
        args.push('--since=90 days ago');
    }
    const r = runGit(args, cwd, 30000);
    if (r.code !== 0) {
        if (r.stderr.trim()) warnings.push(`git log failed: ${r.stderr.trim().slice(0, 200)}`);
        return [];
    }
    const out: CommitEntry[] = [];
    // Records are separated by \x1e. Each record: <sha>\x1f<name>\x1f<email>\x1f<isoDate>\x1f<subject>\n<file>\n<file>...
    const records = r.stdout.split('\x1e').map((s) => s.trim()).filter(Boolean);
    for (const rec of records) {
        const nlIdx = rec.indexOf('\n');
        const head = nlIdx === -1 ? rec : rec.slice(0, nlIdx);
        const files = nlIdx === -1 ? [] : rec.slice(nlIdx + 1).split('\n').map((s) => s.trim()).filter(Boolean);
        const parts = head.split('\x1f');
        if (parts.length < 5) continue;
        out.push({
            sha: parts[0],
            author: parts[1],
            email: parts[2],
            date: parts[3],
            message: parts[4],
            changedFiles: files,
        });
    }
    return out;
}

// =============================================================================
// Feature-file scanning.
// =============================================================================

interface ScenarioEntry {
    featureFile: string;         // absolute path
    name: string;
    tags: string[];
    linkedTestCaseIds: number[];
    backgroundSteps: string[];
    whenSteps: string[];
    thenSteps: string[];
    lineNumber: number;
}

interface FeatureFileEntry {
    path: string;                 // absolute path
    feature: string;
    scenarioCount: number;
    linkedTestCaseIds: number[];
    scenarios: ScenarioEntry[];
}

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

function parseFeatureFile(filePath: string): FeatureFileEntry | null {
    let content: string;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
    const lines = content.split(/\r?\n/);
    let featureTitle = '';
    let featureLevelTags: string[] = [];
    let pendingTags: string[] = [];
    let inBackground = false;
    let backgroundSteps: string[] = [];
    let currentScenario: ScenarioEntry | null = null;
    let currentStepGroup: 'given' | 'when' | 'then' | null = null;
    const scenarios: ScenarioEntry[] = [];

    const finalizeScenario = (): void => {
        if (currentScenario) scenarios.push(currentScenario);
        currentScenario = null;
        currentStepGroup = null;
    };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('#')) continue;
        if (/^@\S/.test(trimmed)) {
            const tags = trimmed.split(/\s+/).filter((t) => t.startsWith('@'));
            pendingTags.push(...tags);
            continue;
        }
        const featureMatch = /^Feature\s*:\s*(.*)$/i.exec(trimmed);
        if (featureMatch) {
            featureTitle = featureMatch[1].trim();
            featureLevelTags = pendingTags.slice();
            pendingTags = [];
            continue;
        }
        if (/^Background\s*:/i.test(trimmed)) {
            finalizeScenario();
            inBackground = true;
            backgroundSteps = [];
            pendingTags = [];
            continue;
        }
        const scenMatch = /^(Scenario Outline|Scenario)\s*:\s*(.*)$/i.exec(trimmed);
        if (scenMatch) {
            finalizeScenario();
            inBackground = false;
            const scenarioTags = pendingTags.slice();
            pendingTags = [];
            const linkedIds = extractTestCaseIdsFromScenario([...featureLevelTags, ...scenarioTags]);
            currentScenario = {
                featureFile: filePath,
                name: scenMatch[2].trim(),
                tags: [...featureLevelTags, ...scenarioTags].map((t) => t.replace(/^@/, '')),
                linkedTestCaseIds: linkedIds,
                backgroundSteps: backgroundSteps.slice(),
                whenSteps: [],
                thenSteps: [],
                lineNumber: i + 1,
            };
            currentStepGroup = 'given';
            continue;
        }
        // Steps
        const stepMatch = /^(Given|When|Then|And|But|\*)\s+(.*)$/i.exec(trimmed);
        if (stepMatch) {
            const kw = stepMatch[1].toLowerCase();
            const stepBody = trimmed; // include keyword
            if (inBackground) {
                backgroundSteps.push(stepBody);
                continue;
            }
            if (!currentScenario) continue;
            if (kw === 'when') currentStepGroup = 'when';
            else if (kw === 'then') currentStepGroup = 'then';
            else if (kw === 'given') currentStepGroup = 'given';
            // and/but/* → whatever the previous keyword was
            if (currentStepGroup === 'when') currentScenario.whenSteps.push(stepBody);
            else if (currentStepGroup === 'then') currentScenario.thenSteps.push(stepBody);
            else if (currentStepGroup === 'given') {
                // Given steps are effectively background per-scenario — carry them in backgroundSteps.
                currentScenario.backgroundSteps.push(stepBody);
            }
            continue;
        }
    }
    finalizeScenario();

    const linkedIds = new Set<number>();
    for (const s of scenarios) for (const id of s.linkedTestCaseIds) linkedIds.add(id);
    return {
        path: filePath,
        feature: featureTitle,
        scenarioCount: scenarios.length,
        linkedTestCaseIds: Array.from(linkedIds),
        scenarios,
    };
}

// =============================================================================
// Iteration path auto-discovery — same shape as sprint watcher.
// =============================================================================

async function autoDiscoverIterationPath(client: AdoHttpClient, project: string, team: string | undefined, warnings: string[]): Promise<string | null> {
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
        const data = await client.get<{ value?: Array<{ path?: string; name?: string }> }>(
            `${encodeURIComponent(project)}/${encodeURIComponent(resolvedTeam)}/_apis/work/teamsettings/iterations?api-version=7.1&$timeframe=current`,
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
// Main builder.
// =============================================================================

registerPrimitive<Input, Output>({
    name: 'cs_qa_kg_build',
    description:
        'Build a persistent knowledge graph of QA state. Walks ADO Stories/Features/Bugs + linked Test Cases + Runs/Results, local Git history (Commit nodes), local .feature files (FeatureFile + Scenario nodes), and Owners. Emits typed nodes (11 types) + edges (10 types) and persists to .cs-qa/kg/graph.json (or custom path). Every source is really walked — empty data yields empty node arrays, never omitted.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input): Promise<Output> => {
        const logger = createLogger(ctx.invocationId, 'cs_qa_kg_build', { workspaceRoot: ctx.workspaceRoot });
        const g = new GraphAccum();

        const credsResult = getResolvedCreds(ctx.workspaceRoot, {
            orgUrl: input.orgUrl,
            project: input.project,
            personalAccessToken: input.pat,
        });

        const scope: Record<string, unknown> = {};

        // === ADO leg ===
        let adoEnabled = false;
        let cfg: AdoCreds | null = null;
        let client: AdoHttpClient | null = null;
        let iterationPath: string | null = null;
        if (credsResult.creds) {
            adoEnabled = true;
            cfg = credsResult.creds;
            client = new AdoHttpClient(cfg);
            iterationPath = input.scope.iterationPath ?? null;
            if (!iterationPath) {
                iterationPath = await autoDiscoverIterationPath(client, cfg.project, input.scope.team, g.warnings);
            }
            scope.iterationPath = iterationPath;
        } else {
            g.warnings.push(`ADO not configured — skipping ADO leg: ${credsResult.diagnostic}`);
            scope.iterationPath = null;
        }

        // === ADO WIQL + WI walk ===
        let storyLikeIds: number[] = [];
        let bugIds: number[] = [];
        let storyWiMap = new Map<number, WorkItem>();
        let bugWiMap = new Map<number, WorkItem>();
        let testCaseIdSet = new Set<number>();
        if (adoEnabled && cfg && client && iterationPath) {
            const allIds = await queryIterationWorkItemIds(client, iterationPath, g.warnings);
            const allWi = await batchFetchWorkItemsWithRelations(client, allIds, g.warnings);
            for (const [id, wi] of allWi) {
                const t = readStringField(wi.fields, 'System.WorkItemType', 'Unknown');
                if (t === 'User Story' || t === 'Product Backlog Item' || t === 'Requirement') { storyLikeIds.push(id); storyWiMap.set(id, wi); }
                else if (t === 'Feature') { storyLikeIds.push(id); storyWiMap.set(id, wi); }
                else if (t === 'Bug') { bugIds.push(id); bugWiMap.set(id, wi); }
            }
            // Collect TC ids from relations.
            for (const [, wi] of storyWiMap) {
                for (const r of (wi.relations ?? [])) {
                    if (r.rel === REL_TESTED_BY_FORWARD) {
                        const id = extractRelatedIdFromUrl(r.url);
                        if (id !== null) testCaseIdSet.add(id);
                    }
                }
            }
            for (const [, wi] of bugWiMap) {
                for (const r of (wi.relations ?? [])) {
                    if (r.rel === REL_TESTED_BY_REVERSE || r.rel === REL_TESTED_BY_FORWARD) {
                        const id = extractRelatedIdFromUrl(r.url);
                        if (id !== null) testCaseIdSet.add(id);
                    }
                }
            }
            logger.info('ado work items collected', { stories: storyLikeIds.length, bugs: bugIds.length, tcs: testCaseIdSet.size });
        }

        // === ADO TC fields ===
        const tcIds = Array.from(testCaseIdSet);
        const tcWiMap = adoEnabled && cfg && client && tcIds.length > 0
            ? await batchFetchWorkItemsWithRelations(client, tcIds, g.warnings)
            : new Map<number, WorkItem>();

        // === Populate Story / Feature / Bug / TestCase nodes + Owner nodes + edges ===
        const orgUrl = cfg?.orgUrl ?? '';
        const project = cfg?.project ?? '';
        for (const [id, wi] of storyWiMap) {
            const t = readStringField(wi.fields, 'System.WorkItemType', 'Story');
            const nodeType: NodeType = t === 'Feature' ? 'Feature' : 'Story';
            const nid = g.upsertNode(nodeType, id, {
                id,
                title: readStringField(wi.fields, 'System.Title'),
                state: readStringField(wi.fields, 'System.State'),
                iterationPath: readStringField(wi.fields, 'System.IterationPath'),
                areaPath: readStringField(wi.fields, 'System.AreaPath'),
                assignedTo: readAssignedTo(wi.fields).displayName,
                priority: readField(wi.fields, 'Microsoft.VSTS.Common.Priority') ?? null,
                tags: parseTags(readField(wi.fields, 'System.Tags')),
                adoUrl: orgUrl && project ? buildWiUrl(orgUrl, project, id) : '',
            });
            const owner = readAssignedTo(wi.fields);
            if (owner.email || owner.displayName) {
                const ownerKey = owner.email || owner.displayName;
                const oid = g.upsertNode('Owner', ownerKey, { email: owner.email, displayName: owner.displayName });
                g.addEdge(nid, oid, 'owned_by');
            }
            // Story --tests--> TestCase edges from relations
            for (const r of (wi.relations ?? [])) {
                if (r.rel === REL_TESTED_BY_FORWARD) {
                    const tcId = extractRelatedIdFromUrl(r.url);
                    if (tcId !== null) {
                        const tcNid = g.upsertNode('TestCase', tcId, { id: tcId });
                        g.addEdge(nid, tcNid, 'tests');
                    }
                }
            }
        }
        for (const [id, wi] of bugWiMap) {
            const nid = g.upsertNode('Bug', id, {
                id,
                title: readStringField(wi.fields, 'System.Title'),
                state: readStringField(wi.fields, 'System.State'),
                severity: readStringField(wi.fields, 'Microsoft.VSTS.Common.Severity'),
                assignedTo: readAssignedTo(wi.fields).displayName,
                tags: parseTags(readField(wi.fields, 'System.Tags')),
                createdAt: readStringField(wi.fields, 'System.CreatedDate'),
                resolvedAt: readStringField(wi.fields, 'Microsoft.VSTS.Common.ResolvedDate'),
                adoUrl: orgUrl && project ? buildWiUrl(orgUrl, project, id) : '',
            });
            const owner = readAssignedTo(wi.fields);
            if (owner.email || owner.displayName) {
                const ownerKey = owner.email || owner.displayName;
                const oid = g.upsertNode('Owner', ownerKey, { email: owner.email, displayName: owner.displayName });
                g.addEdge(nid, oid, 'owned_by');
            }
            // Bug --regresses--> TestCase (via TestedBy-Reverse or -Forward on the bug)
            for (const r of (wi.relations ?? [])) {
                if (r.rel === REL_TESTED_BY_REVERSE || r.rel === REL_TESTED_BY_FORWARD) {
                    const tcId = extractRelatedIdFromUrl(r.url);
                    if (tcId !== null) {
                        const tcNid = g.upsertNode('TestCase', tcId, { id: tcId });
                        g.addEdge(nid, tcNid, 'regresses');
                    }
                }
            }
            // Bug --found_in--> Run (via tag "found-in-run-<id>")
            const tags = parseTags(readField(wi.fields, 'System.Tags'));
            for (const t of tags) {
                const m = /^found-in-run-(\d+)$/i.exec(t);
                if (m) {
                    const runId = Number(m[1]);
                    const runNid = g.upsertNode('Run', runId, { id: runId });
                    g.addEdge(nid, runNid, 'found_in');
                }
            }
        }
        // TC fields + Owner.
        for (const [id, wi] of tcWiMap) {
            const nid = g.upsertNode('TestCase', id, {
                id,
                title: readStringField(wi.fields, 'System.Title'),
                automationStatus: readStringField(wi.fields, 'Microsoft.VSTS.TCM.AutomationStatus'),
                automatedTestName: readStringField(wi.fields, 'Microsoft.VSTS.TCM.AutomatedTestName'),
                automatedTestStorage: readStringField(wi.fields, 'Microsoft.VSTS.TCM.AutomatedTestStorage'),
                tags: parseTags(readField(wi.fields, 'System.Tags')),
                planId: null, // set below when plan is walked
                suiteId: null,
                adoUrl: orgUrl && project ? buildWiUrl(orgUrl, project, id) : '',
            });
            const owner = readAssignedTo(wi.fields);
            if (owner.email || owner.displayName) {
                const ownerKey = owner.email || owner.displayName;
                const oid = g.upsertNode('Owner', ownerKey, { email: owner.email, displayName: owner.displayName });
                g.addEdge(nid, oid, 'owned_by');
            }
        }

        // === Runs + Results ===
        const planIds: number[] = input.scope.planIds && input.scope.planIds.length > 0 ? input.scope.planIds : [];
        if (adoEnabled && cfg && client && planIds.length > 0) {
            for (const planId of planIds) {
                const runs = await listRunsForPlan(client, planId, g.warnings);
                for (const r of runs) {
                    const runId = Number(r.id);
                    const runNid = g.upsertNode('Run', runId, {
                        id: runId,
                        name: r.name ?? '',
                        state: r.state ?? '',
                        startedAt: r.startedDate ?? '',
                        completedAt: r.completedDate ?? '',
                        ownedBy: r.owner?.displayName ?? r.owner?.uniqueName ?? '',
                        planId,
                        buildId: r.build?.id ? Number(r.build.id) : null,
                        adoUrl: orgUrl && project ? `${orgUrl.replace(/\/$/, '')}/${encodeURIComponent(project)}/_testManagement/runs?runId=${runId}&_a=runCharts` : '',
                    });
                    if (r.owner?.displayName || r.owner?.uniqueName) {
                        const key = r.owner.uniqueName || r.owner.displayName || '';
                        const oid = g.upsertNode('Owner', key, { email: r.owner.uniqueName ?? '', displayName: r.owner.displayName ?? '' });
                        g.addEdge(runNid, oid, 'owned_by');
                    }
                    // Fetch results
                    const results = await listResultsForRun(client, runId, g.warnings);
                    for (const res of results) {
                        const resultId = Number(res.id);
                        const tcId = res.testCase?.id ? Number(res.testCase.id) : null;
                        const resNid = g.upsertNode('Result', `${runId}-${resultId}`, {
                            id: resultId,
                            runId,
                            testCaseId: tcId,
                            outcome: res.outcome ?? 'Unspecified',
                            durationMs: res.durationInMs ?? null,
                            errorMessage: res.errorMessage ?? '',
                        });
                        g.addEdge(resNid, runNid, 'in');
                        if (tcId !== null && Number.isFinite(tcId)) {
                            const tcNid = g.upsertNode('TestCase', tcId, { id: tcId });
                            g.addEdge(resNid, tcNid, 'for');
                            g.addEdge(runNid, tcNid, 'executed');
                        }
                    }
                }
            }
        }

        // === Deploys (from ADO builds — every build is a Deploy candidate). ===
        // On-prem may restrict; degrade silently.
        let builds: BuildEntry[] = [];
        if (adoEnabled && cfg && client) {
            builds = await listRecentBuilds(client, g.warnings);
        }
        for (const b of builds) {
            const buildId = Number(b.id);
            const dNid = g.upsertNode('Deploy', buildId, {
                buildId,
                environment: b.project?.name ?? '',
                deployedAt: b.finishTime ?? b.startTime ?? b.queueTime ?? '',
                deployedBy: b.requestedFor?.displayName ?? b.requestedFor?.uniqueName ?? '',
                commitSha: b.sourceVersion ?? '',
                status: b.result ?? b.status ?? '',
            });
            if (b.requestedFor?.displayName || b.requestedFor?.uniqueName) {
                const key = b.requestedFor.uniqueName || b.requestedFor.displayName || '';
                const oid = g.upsertNode('Owner', key, { email: b.requestedFor.uniqueName ?? '', displayName: b.requestedFor.displayName ?? '' });
                g.addEdge(dNid, oid, 'owned_by');
            }
            if (b.sourceVersion) {
                // Deploy --includes--> Commit (we may or may not have the Commit node yet — will be linked once commits are walked; upsert Commit stub).
                const cNid = g.upsertNode('Commit', b.sourceVersion, { sha: b.sourceVersion });
                g.addEdge(dNid, cNid, 'includes');
            }
        }

        // === Git commits ===
        const commits = walkGitLog(ctx.workspaceRoot, input.scope.commitRange, g.warnings);
        for (const c of commits) {
            const cNid = g.upsertNode('Commit', c.sha, {
                sha: c.sha,
                author: c.author,
                email: c.email,
                date: c.date,
                message: c.message,
                changedFiles: c.changedFiles,
            });
            if (c.email || c.author) {
                const ownerKey = c.email || c.author;
                const oid = g.upsertNode('Owner', ownerKey, { email: c.email, displayName: c.author });
                g.addEdge(cNid, oid, 'owned_by');
            }
        }

        // === Feature files + scenarios ===
        const featureRoot = input.scope.featureRoot ? path.resolve(ctx.workspaceRoot, input.scope.featureRoot) : path.join(ctx.workspaceRoot, 'test');
        const featureFiles = collectFeatureFilesRecursive(featureRoot);
        const scenariosByFile = new Map<string, FeatureFileEntry>();
        for (const f of featureFiles) {
            const parsed = parseFeatureFile(f);
            if (!parsed) continue;
            scenariosByFile.set(f, parsed);
            const relPath = path.relative(ctx.workspaceRoot, f) || f;
            const ffNid = g.upsertNode('FeatureFile', relPath, {
                path: relPath,
                feature: parsed.feature,
                scenarioCount: parsed.scenarioCount,
                linkedTestCaseIds: parsed.linkedTestCaseIds,
            });
            for (const sc of parsed.scenarios) {
                const scNid = g.upsertNode('Scenario', `${relPath}::${sc.name}::${sc.lineNumber}`, {
                    featureFile: relPath,
                    name: sc.name,
                    tags: sc.tags,
                    linkedTestCaseIds: sc.linkedTestCaseIds,
                    backgroundSteps: sc.backgroundSteps,
                    whenSteps: sc.whenSteps,
                    thenSteps: sc.thenSteps,
                    lineNumber: sc.lineNumber,
                });
                // TestCase --covers--> Scenario  (edge attributed to the TC; direction: TC covers this scenario)
                for (const tcId of sc.linkedTestCaseIds) {
                    const tcNid = g.upsertNode('TestCase', tcId, { id: tcId });
                    g.addEdge(tcNid, scNid, 'covers');
                }
                // No direct edge from FeatureFile→Scenario type in the spec — scenarios reference their file via props.
            }
        }

        // === Commit --touches--> FeatureFile + Scenario ===
        // Build a map from relative feature-file path -> scenario nodes for quick lookup.
        const featureRelToNode = new Map<string, string>();
        const scenariosByFileRel = new Map<string, ScenarioEntry[]>();
        for (const [absPath, entry] of scenariosByFile) {
            const rel = path.relative(ctx.workspaceRoot, absPath) || absPath;
            featureRelToNode.set(normalizePath(rel), `FeatureFile:${rel}`);
            scenariosByFileRel.set(normalizePath(rel), entry.scenarios);
        }
        for (const c of commits) {
            for (const cf of c.changedFiles) {
                const norm = normalizePath(cf);
                if (!norm.toLowerCase().endsWith('.feature')) continue;
                const ffNodeId = featureRelToNode.get(norm);
                if (!ffNodeId) continue;
                g.addEdge(`Commit:${c.sha}`, ffNodeId, 'touches');
                // Finer-grained: also touch each scenario in the file (we don't have per-commit diffs to know which changed, so we conservatively link every scenario in the touched file).
                const scList = scenariosByFileRel.get(norm) ?? [];
                for (const sc of scList) {
                    const scNodeId = `Scenario:${norm.replace(/\\/g, '/')}::${sc.name}::${sc.lineNumber}`;
                    // Use the same key format used by upsertNode above (which used relPath, not normalized) — recompute:
                    const relForKey = path.relative(ctx.workspaceRoot, sc.featureFile) || sc.featureFile;
                    const finalScKey = `Scenario:${relForKey}::${sc.name}::${sc.lineNumber}`;
                    void scNodeId;
                    g.addEdge(`Commit:${c.sha}`, finalScKey, 'touches');
                }
            }
        }

        // Build final graph.
        scope.commitRange = input.scope.commitRange ?? '(last 90 days)';
        scope.featureRoot = featureRoot;
        scope.planIds = planIds;
        const graph = g.toGraph(scope);

        // Persist if requested.
        let graphPath: string | undefined;
        if (input.persist) {
            const outPath = input.outputPath
                ? path.resolve(ctx.workspaceRoot, input.outputPath)
                : path.join(ctx.workspaceRoot, '.cs-qa', 'kg', 'graph.json');
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, JSON.stringify(graph, null, 2), 'utf-8');
            graphPath = outPath;
        }

        const stats = {
            stories: g.countByType('Story'),
            features: g.countByType('Feature'),
            bugs: g.countByType('Bug'),
            testCases: g.countByType('TestCase'),
            runs: g.countByType('Run'),
            results: g.countByType('Result'),
            commits: g.countByType('Commit'),
            deploys: g.countByType('Deploy'),
            owners: g.countByType('Owner'),
            featureFiles: g.countByType('FeatureFile'),
            scenarios: g.countByType('Scenario'),
            edges: graph.edges.length,
        };
        logger.info('kg build complete', stats);
        return {
            ok: true,
            graphPath,
            stats,
            warnings: g.warnings,
        };
    },
});

function normalizePath(p: string): string {
    return p.replace(/\\/g, '/');
}

export { GraphAccum as _GraphAccumForTests };
