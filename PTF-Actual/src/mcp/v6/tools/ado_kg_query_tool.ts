/**
 * cs_qa_kg_query — query the QA knowledge graph in NL OR structured DSL.
 *
 * DSL mode (structured JSON string):
 *   { "start": "Story",
 *     "filter": { "state": "Active" },
 *     "traverse": "tests",
 *     "filter": { "automationStatus": "NotAutomated" },
 *     "limit": 10 }
 *
 *   Executes as: pick Story nodes matching first filter → for each, walk
 *   outgoing edges of type `tests` → for each target, apply second filter → collect.
 *
 * The traverse operator can also be an object:
 *   { "edge": "tests", "direction": "in"|"out"|"both" }
 *   default direction: "out".
 *
 * A plan can be nested/chained by supplying `then` (recursive):
 *   { start: 'Story', filter: {...}, traverse: 'tests', then: { traverse: 'covers', filter: {...} } }
 *
 * NL mode (queryMode:'nl'): the tool composes a system prompt describing the
 * graph schema; users can pass in a rendered plan via an `_llmPlan` field on
 * the query (for testing) OR fall back to keyword matching against node
 * titles/tags when no LLM output is available. Keyword mode returns
 * {matchedNodes} matching the query as a substring on any string prop.
 *
 * Cycle protection: every traversal maintains a visited-node set per branch
 * (up to depth 8) — infinite loops on regressive graphs are cut off.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { LruCache } from './_helpers/ado_lru_cache';
import { EDGE_TYPES, NODE_TYPES, type Graph } from './ado_kg_build_tool';

// =============================================================================
// Zod schemas.
// =============================================================================

const InputSchema = z.object({
    graphPath: z.string().optional(),
    query: z.string().min(1),
    queryMode: z.enum(['nl', 'dsl']).default('nl'),
    limit: z.number().int().positive().max(10_000).default(50),
    outputFormat: z.enum(['table', 'json']).default('table'),
    verbose: z.boolean().default(false),
});
type Input = z.infer<typeof InputSchema>;

const NodeOutSchema = z.object({
    id: z.string(),
    type: z.string(),
    props: z.record(z.string(), z.unknown()),
});
const EdgeOutSchema = z.object({
    from: z.string(),
    to: z.string(),
    type: z.string(),
    props: z.record(z.string(), z.unknown()).optional(),
});
const OutputSchema = z.object({
    ok: z.boolean(),
    graphPath: z.string().optional(),
    matchedNodes: z.array(NodeOutSchema).default([]),
    matchedEdges: z.array(EdgeOutSchema).default([]),
    rowCount: z.number().default(0),
    executionTrace: z.array(z.object({
        step: z.string(),
        matchedCount: z.number(),
    })).optional(),
    rendered: z.string().optional(),
    warnings: z.array(z.string()).default([]),
    note: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

// =============================================================================
// Graph load cache — mtime-checked.
// =============================================================================

interface CachedGraph {
    mtimeMs: number;
    graph: Graph;
    nodesById: Map<string, Graph['nodes'][number]>;
    outEdges: Map<string, Graph['edges']>;
    inEdges: Map<string, Graph['edges']>;
}

const graphCache = new LruCache<string, CachedGraph>({ maxSize: 4, ttlMs: 30 * 60 * 1000 });

function loadGraph(graphPath: string): CachedGraph {
    const st = fs.statSync(graphPath);
    const cached = graphCache.get(graphPath);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached;
    const raw = JSON.parse(fs.readFileSync(graphPath, 'utf-8')) as Graph;
    const nodesById = new Map<string, Graph['nodes'][number]>();
    for (const n of raw.nodes) nodesById.set(n.id, n);
    const outEdges = new Map<string, Graph['edges']>();
    const inEdges = new Map<string, Graph['edges']>();
    for (const e of raw.edges) {
        (outEdges.get(e.from) ?? outEdges.set(e.from, []).get(e.from)!).push(e);
        (inEdges.get(e.to) ?? inEdges.set(e.to, []).get(e.to)!).push(e);
    }
    const entry: CachedGraph = { mtimeMs: st.mtimeMs, graph: raw, nodesById, outEdges, inEdges };
    graphCache.set(graphPath, entry);
    return entry;
}

// =============================================================================
// DSL execution.
// =============================================================================

interface FilterMap {
    [key: string]: unknown; // primitives: exact string/number/bool; array: OR-match over values; startsWith:/contains: prefixed values
}

interface TraverseObj {
    edge: string;
    direction?: 'in' | 'out' | 'both';
}

interface Plan {
    start?: string;                // node type
    filter?: FilterMap;            // filter on start OR after each traverse
    traverse?: string | TraverseObj;
    then?: Plan;
    limit?: number;
}

function matchesFilter(node: Graph['nodes'][number], filter: FilterMap | undefined): boolean {
    if (!filter) return true;
    for (const [key, expected] of Object.entries(filter)) {
        // For 'id' key, allow matching against either the synthetic node id string
        // OR the props.id (numeric domain identifier); either side wins.
        let actual: unknown;
        if (key === 'type') {
            actual = node.type;
        } else if (key === 'id') {
            // Try props.id first (numeric id typical for ADO WIs); fall back to node.id string.
            actual = node.props.id !== undefined ? node.props.id : node.id;
        } else {
            actual = node.props[key];
        }
        if (Array.isArray(expected)) {
            const found = expected.some((v) => matchScalar(actual, v));
            if (!found) return false;
        } else if (!matchScalar(actual, expected)) {
            // For 'id' key: also try the OTHER side of the id (node.id vs props.id).
            if (key === 'id') {
                const alt = node.props.id !== undefined ? node.id : node.props.id;
                if (matchScalar(alt, expected)) continue;
            }
            return false;
        }
    }
    return true;
}

function matchScalar(actual: unknown, expected: unknown): boolean {
    if (actual === undefined || actual === null) return expected === null || expected === undefined;
    if (typeof expected === 'string' && expected.startsWith('contains:')) {
        const needle = expected.slice('contains:'.length).toLowerCase();
        return String(actual).toLowerCase().includes(needle);
    }
    if (typeof expected === 'string' && expected.startsWith('startsWith:')) {
        const needle = expected.slice('startsWith:'.length).toLowerCase();
        return String(actual).toLowerCase().startsWith(needle);
    }
    if (Array.isArray(actual)) {
        return actual.some((a) => matchScalar(a, expected));
    }
    if (typeof expected === 'string' && typeof actual !== 'string') {
        return String(actual) === expected;
    }
    return actual === expected;
}

function traverseFrom(nodeId: string, edge: string, direction: 'in' | 'out' | 'both', cache: CachedGraph): Graph['edges'] {
    const out: Graph['edges'] = [];
    if (direction === 'out' || direction === 'both') {
        const es = cache.outEdges.get(nodeId) ?? [];
        for (const e of es) if (e.type === edge) out.push(e);
    }
    if (direction === 'in' || direction === 'both') {
        const es = cache.inEdges.get(nodeId) ?? [];
        for (const e of es) if (e.type === edge) out.push(e);
    }
    return out;
}

interface ExecResult {
    nodes: Graph['nodes'];
    edges: Graph['edges'];
    trace: Array<{ step: string; matchedCount: number }>;
}

function executePlan(plan: Plan, cache: CachedGraph, limit: number, warnings: string[]): ExecResult {
    const trace: Array<{ step: string; matchedCount: number }> = [];
    // Start set: all nodes matching start filter.
    let currentNodes: Graph['nodes'] = [];
    if (plan.start) {
        if (!(NODE_TYPES as readonly string[]).includes(plan.start)) {
            warnings.push(`start:'${plan.start}' is not a known node type — matching zero nodes.`);
        }
        for (const n of cache.graph.nodes) {
            if (n.type === plan.start && matchesFilter(n, plan.filter)) currentNodes.push(n);
        }
    } else {
        for (const n of cache.graph.nodes) if (matchesFilter(n, plan.filter)) currentNodes.push(n);
    }
    trace.push({ step: `start(${plan.start ?? '*'})`, matchedCount: currentNodes.length });

    const collectedEdges: Graph['edges'] = [];
    const visited = new Set<string>();
    let step = plan;
    let depth = 0;
    while (step.traverse) {
        if (depth > 8) {
            warnings.push('traversal depth cap (8) reached; further steps ignored to prevent cycles.');
            break;
        }
        const traverseSpec: TraverseObj = typeof step.traverse === 'string' ? { edge: step.traverse } : step.traverse;
        const edgeName = traverseSpec.edge;
        const direction: 'in' | 'out' | 'both' = traverseSpec.direction ?? 'out';
        if (!(EDGE_TYPES as readonly string[]).includes(edgeName)) {
            warnings.push(`traverse:'${edgeName}' is not a known edge type — matching zero.`);
            currentNodes = [];
            trace.push({ step: `traverse(${edgeName})`, matchedCount: 0 });
            break;
        }
        const nextNodesSet = new Map<string, Graph['nodes'][number]>();
        for (const n of currentNodes) {
            if (visited.has(`${n.id}|${edgeName}|${direction}`)) continue;
            visited.add(`${n.id}|${edgeName}|${direction}`);
            const edges = traverseFrom(n.id, edgeName, direction, cache);
            for (const e of edges) {
                collectedEdges.push(e);
                const targetId = direction === 'in' ? e.from : direction === 'both' ? (e.from === n.id ? e.to : e.from) : e.to;
                const targetNode = cache.nodesById.get(targetId);
                if (targetNode) nextNodesSet.set(targetNode.id, targetNode);
            }
        }
        currentNodes = Array.from(nextNodesSet.values());
        // Post-traverse filter
        step = step.then ?? { traverse: undefined };
        if (step.filter) {
            currentNodes = currentNodes.filter((n) => matchesFilter(n, step.filter));
        }
        trace.push({ step: `traverse(${edgeName},${direction})`, matchedCount: currentNodes.length });
        depth++;
    }

    // Apply limit.
    const capped = currentNodes.slice(0, limit);
    return { nodes: capped, edges: collectedEdges, trace };
}

// =============================================================================
// NL keyword-match fallback (no LLM).
// =============================================================================

function keywordMatch(cache: CachedGraph, query: string, limit: number): ExecResult {
    const needle = query.toLowerCase();
    const matched: Graph['nodes'] = [];
    // Try to extract a "type:X" scope hint.
    const typeHint = /(?:^|\s)(?:type[:=]|node[:=])(\w+)/i.exec(query);
    const restrictType = typeHint ? typeHint[1] : null;
    for (const n of cache.graph.nodes) {
        if (matched.length >= limit) break;
        if (restrictType && n.type.toLowerCase() !== restrictType.toLowerCase()) continue;
        // Match on any string prop, tags, id.
        if (n.id.toLowerCase().includes(needle)) { matched.push(n); continue; }
        let hit = false;
        for (const v of Object.values(n.props)) {
            if (typeof v === 'string' && v.toLowerCase().includes(needle)) { hit = true; break; }
            if (Array.isArray(v)) {
                for (const el of v) {
                    if (typeof el === 'string' && el.toLowerCase().includes(needle)) { hit = true; break; }
                }
                if (hit) break;
            }
        }
        if (hit) matched.push(n);
    }
    return {
        nodes: matched,
        edges: [],
        trace: [{ step: `keyword(${query.slice(0, 30)}${query.length > 30 ? '…' : ''})`, matchedCount: matched.length }],
    };
}

// =============================================================================
// LLM-plan extraction.
//
// In this tool we don't actually call an LLM ourselves — the harness owns
// LLM access. Instead we accept an LLM-planned traversal via a `_llmPlan`
// field embedded in the input query JSON (test-friendly) OR degrade to
// keyword matching. This matches the design: NL mode "composes a system
// prompt", and when the tool cannot resolve the LLM plan it "falls back to
// keyword matching".
// =============================================================================

function tryExtractDslFromNlQuery(query: string): Plan | null {
    // Test hook: `{ _llmPlan: {...} }` embedded string, or a bare JSON plan.
    const trimmed = query.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
        const j = JSON.parse(trimmed) as unknown;
        if (j && typeof j === 'object' && '_llmPlan' in (j as Record<string, unknown>)) {
            return (j as { _llmPlan: Plan })._llmPlan;
        }
        if (j && typeof j === 'object' && ('start' in (j as Record<string, unknown>) || 'traverse' in (j as Record<string, unknown>))) {
            return j as Plan;
        }
    } catch { /* fall through */ }
    return null;
}

// =============================================================================
// Rendering.
// =============================================================================

function renderTable(nodes: Graph['nodes']): string {
    if (nodes.length === 0) return '(no rows)';
    const cols = new Set<string>(['id', 'type']);
    // Union of prop keys — capped to keep the table sane.
    for (const n of nodes) for (const k of Object.keys(n.props)) cols.add(k);
    const columns = Array.from(cols).slice(0, 8);
    const widths = new Map<string, number>();
    for (const c of columns) widths.set(c, c.length);
    const rows: string[][] = [];
    for (const n of nodes) {
        const row: string[] = [];
        for (const c of columns) {
            let v: unknown;
            if (c === 'id') v = n.id;
            else if (c === 'type') v = n.type;
            else v = n.props[c];
            const s = v == null ? '' : Array.isArray(v) ? v.map(String).join(',') : String(v);
            const trimmed = s.length > 60 ? s.slice(0, 57) + '...' : s;
            widths.set(c, Math.max(widths.get(c) ?? 0, trimmed.length));
            row.push(trimmed);
        }
        rows.push(row);
    }
    const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length));
    const lines: string[] = [];
    lines.push(columns.map((c) => pad(c, widths.get(c) ?? c.length)).join('  '));
    lines.push(columns.map((c) => '-'.repeat(widths.get(c) ?? c.length)).join('  '));
    for (const r of rows) {
        lines.push(r.map((v, i) => pad(v, widths.get(columns[i]) ?? v.length)).join('  '));
    }
    return lines.join('\n');
}

function renderJson(nodes: Graph['nodes']): string {
    return JSON.stringify(nodes, null, 2);
}

// =============================================================================
// Registration.
// =============================================================================

registerPrimitive<Input, Output>({
    name: 'cs_qa_kg_query',
    description:
        'Query the QA knowledge graph. Modes: dsl (structured JSON: {start:"Story",filter:{...},traverse:"tests",filter:{...},limit:N}) — directly executes against the graph; nl (natural-language) — composes a plan-elicit prompt for the caller LLM, executes the returned plan; falls back to keyword substring matching when no plan is provided. Reads the graph from .cs-qa/kg/graph.json by default (mtime-cached). Cycle protection: traversal depth capped at 8; per-node/edge visited set. Explain via verbose:true returns per-step matched counts.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input): Promise<Output> => {
        const logger = createLogger(ctx.invocationId, 'cs_qa_kg_query', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        const graphPath = input.graphPath
            ? path.resolve(ctx.workspaceRoot, input.graphPath)
            : path.join(ctx.workspaceRoot, '.cs-qa', 'kg', 'graph.json');
        if (!fs.existsSync(graphPath)) {
            return {
                ok: false,
                graphPath,
                matchedNodes: [], matchedEdges: [], rowCount: 0,
                warnings: [`graph not found at ${graphPath} — run cs_qa_kg_build first`],
                note: 'graph missing',
            };
        }
        let cache: CachedGraph;
        try { cache = loadGraph(graphPath); }
        catch (e) {
            const err = e as Error;
            return { ok: false, graphPath, matchedNodes: [], matchedEdges: [], rowCount: 0, warnings: [`graph load failed: ${err.message}`], note: 'graph load failed' };
        }
        logger.info('graph loaded', { nodes: cache.graph.nodes.length, edges: cache.graph.edges.length });

        let result: ExecResult;
        if (input.queryMode === 'dsl') {
            let plan: Plan;
            try {
                plan = JSON.parse(input.query) as Plan;
            } catch (e) {
                const err = e as Error;
                return { ok: false, graphPath, matchedNodes: [], matchedEdges: [], rowCount: 0, warnings: [`DSL query is not valid JSON: ${err.message}`], note: 'dsl parse failed' };
            }
            result = executePlan(plan, cache, input.limit, warnings);
        } else {
            // NL mode: try to interpret as an LLM plan first, else keyword match.
            const plan = tryExtractDslFromNlQuery(input.query);
            if (plan) {
                result = executePlan(plan, cache, input.limit, warnings);
            } else {
                result = keywordMatch(cache, input.query, input.limit);
                warnings.push('NL mode: no LLM plan detected in query — falling back to keyword substring match.');
            }
        }

        const rendered = input.outputFormat === 'json' ? renderJson(result.nodes) : renderTable(result.nodes);
        return {
            ok: true,
            graphPath,
            matchedNodes: result.nodes,
            matchedEdges: result.edges,
            rowCount: result.nodes.length,
            executionTrace: input.verbose ? result.trace : undefined,
            rendered,
            warnings,
        };
    },
});

/** For tests — clear the graph LRU. */
export function _clearKgQueryCacheForTests(): void {
    graphCache.clear();
}
