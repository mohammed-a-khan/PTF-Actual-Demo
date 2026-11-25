/**
 * The flow of a collection, as a picture of how its requests depend on each other: each request a node, an edge for
 * every value one request saves (from its response, or a message) and a later one uses ({{name}}), an edge for each
 * jump a script makes (setNextRequest), and the scenarios the framework feature will have (requests that pass values
 * stay together). Laid out left to right by dependency depth.
 */
import { allRequests, ApiCollection, ApiRequest } from './model';
import { requestUses, scenarioGroups } from './feature';

export interface FlowNode { id: string; name: string; method: string; folder: string; scenario: number; column: number; row: number; saves: string[]; uses: string[] }
export interface FlowEdge { from: string; to: string; kind: 'value' | 'jump' | 'order'; label: string }
export interface Flow { nodes: FlowNode[]; edges: FlowEdge[]; scenarios: Array<{ index: number; name: string; requests: string[] }>; unresolved: Array<{ request: string; name: string }> }

const savesOf = (r: ApiRequest) => [...r.extract.map((e) => e.variable.trim()), ...(r.ws?.steps ?? []).map((s) => s.save?.variable?.trim() ?? ''),
    ...[...`${r.scripts?.test ?? ''}\n${r.scripts?.pre ?? ''}`.matchAll(/pm\.(?:environment|collectionVariables|variables|globals)\.set\(\s*['"`]([\w.-]+)['"`]/g)].map((m) => m[1])].filter(Boolean);

export function collectionFlow(c: ApiCollection): Flow {
    const all = allRequests(c.items);
    const groups = scenarioGroups(c, all);
    const scenarioOf = new Map<string, number>();
    groups.forEach((g, i) => g.forEach((x) => scenarioOf.set(x.request.id, i)));
    const collectionVars = new Set(c.variables.filter((v) => v.enabled !== false).map((v) => v.key));
    const edges: FlowEdge[] = [];
    const unresolved: Flow['unresolved'] = [];
    const lastSaver = new Map<string, string>();
    const depth = new Map<string, number>();
    const nodes: FlowNode[] = all.map(({ request: r, folders }) => {
        const uses = [...new Set(requestUses(r, c))];
        let d = 0;
        for (const n of uses) {
            const from = lastSaver.get(n);
            if (from) { edges.push({ from, to: r.id, kind: 'value', label: n }); d = Math.max(d, (depth.get(from) ?? 0) + 1); }
            else if (!collectionVars.has(n)) unresolved.push({ request: r.name, name: n });
        }
        depth.set(r.id, d);
        const saves = [...new Set(savesOf(r))];
        for (const s of saves) lastSaver.set(s, r.id);
        return { id: r.id, name: r.name, method: r.ws ? (r.ws.protocol ?? 'websocket') : r.method, folder: folders.join(' / '), scenario: scenarioOf.get(r.id) ?? -1, column: d, row: 0, saves, uses };
    });
    // Jumps of scripts (postman.setNextRequest / pm.execution.setNextRequest).
    const byName = new Map(all.map((x) => [x.request.name, x.request.id]));
    for (const { request: r } of all) {
        for (const m of `${r.scripts?.pre ?? ''}\n${r.scripts?.test ?? ''}`.matchAll(/setNextRequest\(\s*(['"`])([^'"`]+)\1\s*\)/g)) {
            const to = byName.get(m[2]);
            if (to) edges.push({ from: r.id, to, kind: 'jump', label: to === r.id ? 'again' : 'next' });
        }
    }
    // Order within a scenario where no value links two neighbours.
    for (const g of groups) for (let i = 1; i < g.length; i++) {
        const a = g[i - 1].request.id, b = g[i].request.id;
        if (!edges.some((e) => e.to === b && e.kind === 'value')) edges.push({ from: a, to: b, kind: 'order', label: '' });
    }
    // Rows: in each column, in collection order.
    const rows = new Map<number, number>();
    for (const n of nodes) { n.row = rows.get(n.column) ?? 0; rows.set(n.column, n.row + 1); }
    return { nodes, edges, unresolved, scenarios: groups.map((g, i) => ({ index: i, name: g.length > 1 ? g.map((x) => x.request.name).join(', then ') : g[0].request.name, requests: g.map((x) => x.request.id) })) };
}
