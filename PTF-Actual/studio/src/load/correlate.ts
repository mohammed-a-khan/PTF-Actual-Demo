/**
 * Correlation by replay: a recorded user path (a HAR import, a collection) sends values the server made for the
 * recording (a session token, an order id, a CSRF token). Replayed, the server makes new ones and the recorded ones are
 * refused. The path is replayed twice: a value that differs between the two replays at the same place of a response (a
 * JSON field, a header, a cookie) is dynamic; a later request that sends a field of the same name with a fixed value is
 * a candidate: save the value from that response ({{name}}) and send it there. Applied, the path is replayed again,
 * until it runs clean (no candidates, every request passes).
 */
import type { ApiCollection, ApiRequest } from '../api/model';
import type { ApiResponse, TokenCache, Values } from '../api/send';
import { CookieJar } from '../api/cookies';
import { authorize, evaluateAll, extract, prepare, send } from '../api/send';
import type { Connection } from '../core/network';
import { candidate as worth, leaves } from '../api/har';

export interface ReplayStep { id: string; name: string; status: number; ok: boolean; error?: string; timeMs: number }
export interface CorrelationTarget { request: string; requestName: string; where: 'query' | 'header' | 'json' | 'form' | 'path'; field: string; current: string }
export interface CorrelationCandidate {
    /** The request whose response gives the value, and where in it ($.data.token, header Location, cookie sid). */
    from: string; fromName: string; source: 'json' | 'header' | 'cookie'; path: string;
    /** The name to save it as ({{name}}). */
    variable: string;
    /** The value in each replay (it changes). */
    samples: [string, string];
    to: CorrelationTarget[];
}

/** One replay of the requests in order, as one user: values saved by a request are used by the next ones. */
export async function replayOnce(c: ApiCollection, requests: ApiRequest[], values: Values, o: { connection?: Connection; timeoutMs?: number; readFile?: (rel: string) => Buffer } = {}): Promise<{ steps: ReplayStep[]; responses: Map<string, ApiResponse> }> {
    const saved: Record<string, string> = {};
    const tokens: TokenCache = new Map();
    const steps: ReplayStep[] = [];
    const responses = new Map<string, ApiResponse>();
    // One user: its own cookies, as in a load test.
    const jar = new CookieJar();
    for (const r of requests) {
        if (r.ws) continue;
        const v: Values = { ...values, vars: { ...values.vars, ...saved } };
        try {
            const p = await authorize(c, r, v, prepare(c, r, v, { readFile: o.readFile }), o.connection, tokens, o.timeoutMs ?? 30_000);
            if (p.missing.length) { steps.push({ id: r.id, name: r.name, status: 0, ok: false, error: `Not filled in: ${p.missing.join(', ')}`, timeMs: 0 }); continue; }
            const res = await send(p, o.connection, o.timeoutMs ?? 30_000, jar);
            responses.set(r.id, res);
            for (const x of extract(r.extract, res)) if (x.found && x.value !== undefined) saved[x.variable] = x.value;
            const failed = (await evaluateAll(r.checks.filter((ch) => ch.kind !== 'dbItems'), res, { ...v, readFile: o.readFile })).find((ch) => !ch.pass);
            const error = failed ? failed.message : !r.checks.length && res.status >= 400 ? `HTTP ${res.status}` : undefined;
            steps.push({ id: r.id, name: r.name, status: res.status, ok: !error, ...(error ? { error } : {}), timeMs: res.timeMs });
        } catch (e) { steps.push({ id: r.id, name: r.name, status: 0, ok: false, error: (e as Error).message.split('\n')[0], timeMs: 0 }); }
    }
    return { steps, responses };
}

/** The places of a response with a value: JSON fields, headers (Location, tokens), cookies. */
function places(res: ApiResponse | undefined): Map<string, { source: CorrelationCandidate['source']; path: string; key: string; value: string }> {
    const out = new Map<string, { source: CorrelationCandidate['source']; path: string; key: string; value: string }>();
    if (!res) return out;
    let json: unknown;
    try { json = JSON.parse(res.body); } catch { json = undefined; }
    if (json !== undefined) for (const l of leaves(json)) out.set(`json ${l.path}`, { source: 'json', path: l.path, key: l.key, value: l.value });
    for (const [k, v] of Object.entries(res.headers)) {
        if (/^set-cookie$/i.test(k)) {
            for (const part of String(v).split(/,(?=\s*[\w-]+=)/)) { const m = /^\s*([\w-]+)=([^;]*)/.exec(part); if (m) out.set(`cookie ${m[1]}`, { source: 'cookie', path: m[1], key: m[1], value: m[2] }); }
        } else if (/^(location|x-[\w-]*(token|id|session)[\w-]*|etag)$/i.test(k)) out.set(`header ${k.toLowerCase()}`, { source: 'header', path: k, key: k.replace(/^x-/i, ''), value: String(v) });
    }
    return out;
}

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A value that changed between the two replays is worth saving unless it is a time (every reply has its own), a flag
 * or a small count: changing is the evidence (an id need not have digits).
 */
const dynamic = (v: string) => v.length >= 4 && v.length <= 4096 && !/^(true|false|null)$/i.test(v)
    && !/^\d{4}-\d{2}-\d{2}|^\d{1,2}:\d{2}|^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4}/.test(v) && !/^\d{1,3}(\.\d+)?$/.test(v) && !/^1[5-9]\d{8,11}$/.test(v);

/** The fields a request sends with a fixed value (not a {{name}} already): query, headers, JSON body, form, path segments. */
function fields(r: ApiRequest): CorrelationTarget[] {
    const out: CorrelationTarget[] = [];
    const fixed = (v: string) => !!v && !/\{\{|\{(config|env):/.test(v);
    for (const q of r.query) if (q.enabled !== false && fixed(q.value)) out.push({ request: r.id, requestName: r.name, where: 'query', field: q.key, current: q.value });
    for (const h of r.headers) if (h.enabled !== false && fixed(h.value)) out.push({ request: r.id, requestName: r.name, where: 'header', field: h.key, current: h.value });
    if (r.body.mode === 'form') for (const f of r.body.form ?? []) if (f.enabled !== false && fixed(f.value)) out.push({ request: r.id, requestName: r.name, where: 'form', field: f.key, current: f.value });
    if (r.body.mode === 'json' && r.body.text) {
        let j: unknown;
        try { j = JSON.parse(r.body.text); } catch { j = undefined; }
        if (j !== undefined) for (const l of leaves(j)) if (fixed(l.value)) out.push({ request: r.id, requestName: r.name, where: 'json', field: l.path, current: l.value });
    }
    // /orders/ORD-123/items: a path segment that looks like an id.
    r.url.split('?')[0].split('/').forEach((seg, i) => { if (fixed(seg) && worth(seg)) out.push({ request: r.id, requestName: r.name, where: 'path', field: String(i), current: seg }); });
    return out;
}

/**
 * Candidates from two replays: a value that changed between them at the same place of a response, and a later
 * request that sends a field of the same name (or, in its path, a segment as long as the value) with a fixed value.
 */
export function findCandidates(requests: ApiRequest[], run1: Map<string, ApiResponse>, run2: Map<string, ApiResponse>): CorrelationCandidate[] {
    const usedVars = new Set(requests.flatMap((r) => r.extract.map((e) => e.variable)));
    const taken = new Set<string>(); // a target field is given to one value only (the nearest earlier one)
    // From the last request back (a target goes to the nearest earlier value); each response's fields in their order.
    const groups: CorrelationCandidate[][] = [];
    for (let i = requests.length - 1; i >= 0; i--) {
        const r = requests[i];
        const mine: CorrelationCandidate[] = [];
        groups.unshift(mine);
        const a = places(run1.get(r.id)), b = places(run2.get(r.id));
        for (const [k, x] of a) {
            const y = b.get(k);
            if (!y || y.value === x.value || !dynamic(x.value) || !dynamic(y.value)) continue;
            // Already saved by this request.
            if (r.extract.some((e) => e.from === x.source && e.path === x.path)) continue;
            const to: CorrelationTarget[] = [];
            for (const later of requests.slice(i + 1)) {
                for (const f of fields(later)) {
                    const id = `${f.request}|${f.where}|${f.field}`;
                    if (taken.has(id)) continue;
                    const fieldKey = f.where === 'json' ? (/([\w-]+)(\[\d+\])*$/.exec(f.field)?.[1] ?? '') : f.field;
                    const byName = f.where !== 'path' && norm(fieldKey) === norm(x.key) || (f.where === 'header' && /authorization/i.test(f.field) && /token/i.test(x.key) && /^Bearer\s/i.test(f.current));
                    const byShape = f.where === 'path' && f.current.length === x.value.length && /^[\w-]+$/.test(x.value);
                    if (byName || byShape) { to.push(f); taken.add(id); }
                }
            }
            if (!to.length) continue;
            const base = x.key.replace(/[^\w]/g, '_').replace(/^(\d)/, '_$1') || 'value';
            let variable = base;
            for (let n = 2; usedVars.has(variable); n++) variable = `${base}${n}`;
            usedVars.add(variable);
            mine.push({ from: r.id, fromName: r.name, source: x.source, path: x.path, variable, samples: [x.value, y.value], to });
        }
    }
    return groups.flat();
}

/** The candidates applied to the collection: the value saved from its response, sent by the later requests. */
export function applyCandidates(c: ApiCollection, chosen: CorrelationCandidate[], all: (c: ApiCollection) => ApiRequest[]): { collection: ApiCollection; changed: number } {
    const copy = JSON.parse(JSON.stringify(c)) as ApiCollection;
    const byId = new Map(all(copy).map((r) => [r.id, r]));
    let changed = 0;
    for (const k of chosen) {
        const from = byId.get(k.from);
        if (!from) continue;
        if (!from.extract.some((e) => e.variable === k.variable)) from.extract.push({ from: k.source, path: k.path, variable: k.variable });
        const ref = `{{${k.variable}}}`;
        for (const t of k.to) {
            const r = byId.get(t.request);
            if (!r) continue;
            if (t.where === 'query') { const q = r.query.find((x) => x.key === t.field); if (q) { q.value = ref; changed++; } }
            else if (t.where === 'header') { const h = r.headers.find((x) => x.key === t.field); if (h) { h.value = /^Bearer\s/i.test(h.value) ? `Bearer ${ref}` : ref; changed++; } }
            else if (t.where === 'form') { const f = (r.body.form ?? []).find((x) => x.key === t.field); if (f) { f.value = ref; changed++; } }
            else if (t.where === 'path') { const parts = r.url.split('?'); const segs = parts[0].split('/'); segs[Number(t.field)] = ref; parts[0] = segs.join('/'); r.url = parts.join('?'); changed++; }
            else if (t.where === 'json' && r.body.text) {
                try {
                    const j = JSON.parse(r.body.text);
                    // Set the field at the path: the value becomes "{{name}}" (a string field) or {{name}} (a number).
                    const keys = [...t.field.matchAll(/\.([\w-]+)|\[(\d+)\]/g)].map((m) => (m[1] !== undefined ? m[1] : Number(m[2])));
                    let cur: any = j; // eslint-disable-line @typescript-eslint/no-explicit-any
                    for (const key of keys.slice(0, -1)) cur = cur?.[key];
                    const last = keys[keys.length - 1];
                    if (cur && last !== undefined && cur[last] !== undefined) {
                        const isNum = typeof cur[last] === 'number';
                        // A number field: a marker string, replaced by the bare {{name}} once written out.
                        const marker = `__cs_correlate_${k.variable}__`;
                        cur[last] = isNum ? marker : ref;
                        r.body.text = JSON.stringify(j, null, 2).split(`"${marker}"`).join(ref);
                        changed++;
                    }
                } catch { /* not JSON */ }
            }
        }
    }
    return { collection: copy, changed };
}
