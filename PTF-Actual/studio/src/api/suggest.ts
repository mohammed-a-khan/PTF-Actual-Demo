/**
 * Checks suggested from a response (no AI needed): the status, the content type, a JSON schema of the body as it is
 * now (types and the fields always present), the values that look stable (ids, codes, flags, enums; not times, tokens
 * or counters that change between runs), list sizes, and the headers worth keeping an eye on. The person picks which
 * to keep.
 */
import type { ApiCheck } from './model';
import type { ApiResponse } from './send';

export interface Suggestion { check: ApiCheck; why: string; selected: boolean }

type J = unknown;
const isObj = (v: J): v is Record<string, J> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A JSON schema of a value (draft-07): types, required fields (those in every element of a list), nested. */
export function schemaOf(v: J, depth = 0): Record<string, unknown> {
    if (depth > 8) return {};
    if (v === null) return { type: 'null' };
    if (Array.isArray(v)) {
        if (!v.length) return { type: 'array' };
        const items = v.slice(0, 50);
        if (items.every(isObj)) {
            const keys = [...new Set(items.flatMap((o) => Object.keys(o as object)))];
            const props = Object.fromEntries(keys.map((k) => {
                const vals = items.map((o) => (o as Record<string, J>)[k]).filter((x) => x !== undefined);
                const types = [...new Set(vals.map((x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x === 'number' ? (Number.isInteger(x) ? 'integer' : 'number') : typeof x)))];
                const s = schemaOf(vals.find((x) => x !== null) ?? null, depth + 1);
                return [k, types.length > 1 ? { ...s, type: types.map((t) => (t === 'integer' && types.includes('number') ? 'number' : t)).filter((t, i, a) => a.indexOf(t) === i) } : s];
            }));
            return { type: 'array', items: { type: 'object', required: keys.filter((k) => items.every((o) => (o as Record<string, J>)[k] !== undefined)), properties: props } };
        }
        return { type: 'array', items: schemaOf(items[0], depth + 1) };
    }
    if (isObj(v)) return { type: 'object', required: Object.keys(v), properties: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, schemaOf(x, depth + 1)])) };
    if (typeof v === 'number') return { type: Number.isInteger(v) ? 'integer' : 'number' };
    if (typeof v === 'string') {
        if (/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v)) return { type: 'string', format: 'date-time' };
        if (/^\d{4}-\d\d-\d\d$/.test(v)) return { type: 'string', format: 'date' };
        if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v)) return { type: 'string', format: 'email' };
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return { type: 'string', format: 'uuid' };
        return { type: 'string' };
    }
    return { type: typeof v };
}

/** A value that changes between runs (time, token, generated id, counter). */
const volatile = (key: string, v: J) => typeof v === 'string' && (/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d/.test(v) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v) || /^ey[A-Za-z0-9_-]{10,}\./.test(v) || v.length > 80)
    || /(^|_)(time|timestamp|date|created|updated|modified|expires?|token|nonce|signature|etag|requestid|traceid|correlationid)(_|$)/i.test(key.replace(/([a-z])([A-Z])/g, '$1_$2'))
    || (typeof v === 'number' && /(count|total|size|length|elapsed|duration|ms|seconds)$/i.test(key));

const path = (base: string, k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `${base}.${k}` : `${base}['${k.replace(/'/g, "\\'")}']`);

export function suggestChecks(r: Pick<ApiResponse, 'status' | 'headers' | 'body'>, existing: ApiCheck[] = []): Suggestion[] {
    const out: Suggestion[] = [];
    const has = (c: ApiCheck) => existing.some((e) => e.kind === c.kind && (e.target ?? '') === (c.target ?? '') && (e.value ?? '') === (c.value ?? ''));
    const add = (check: ApiCheck, why: string, selected = true) => { if (!has(check) && !out.some((x) => JSON.stringify(x.check) === JSON.stringify(check))) out.push({ check, why, selected }); };
    add({ kind: 'status', value: String(r.status) }, 'The status it answered');
    const ct = (r.headers['content-type'] ?? '').split(';')[0].trim();
    if (ct) add({ kind: 'headerContains', target: 'Content-Type', value: ct }, 'The type of the body');
    let j: J;
    try { j = JSON.parse(r.body); } catch { j = undefined; }
    if (j === undefined) {
        if (r.body.trim()) add({ kind: 'bodyContains', value: r.body.trim().slice(0, 40).split('\n')[0] }, 'The start of the body', false);
        return out;
    }
    add({ kind: 'schema', schema: JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', ...schemaOf(j) }, null, 2) }, 'The shape of the body (types, fields always present), as it is now');
    // Stable values and list sizes, two levels deep.
    const walk = (v: J, p: string, depth: number) => {
        if (depth > 2 || out.length > 40) return;
        if (Array.isArray(v)) { add({ kind: 'jsonEquals', target: `${p}.length`, value: String(v.length) }, `The list has ${v.length} item${v.length === 1 ? '' : 's'} now`, false); if (v.length && isObj(v[0])) walk(v[0], `${p}[0]`, depth + 1); return; }
        if (!isObj(v)) return;
        for (const [k, x] of Object.entries(v)) {
            const q = path(p, k);
            if (x === null || isObj(x) || Array.isArray(x)) { if (x !== null) walk(x, q, depth + 1); continue; }
            if (volatile(k, x)) { add({ kind: 'jsonExists', target: q }, `${k} changes between runs: only that it is there`, depth === 0); continue; }
            const stable = typeof x === 'boolean' || (typeof x === 'string' && x.length <= 40) || (typeof x === 'number' && /(^id$|Id$|_id$|code|status|type|version|level|tier)/i.test(k));
            if (stable) add({ kind: 'jsonEquals', target: q, value: String(x) }, `${k} is ${JSON.stringify(x)}`, depth === 0 && /(status|state|type|code|success|ok|currency|name)$/i.test(k));
            else add({ kind: 'jsonExists', target: q }, `${k} is there`, false);
        }
    };
    walk(j, '$', 0);
    return out;
}
