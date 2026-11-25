/**
 * "Where does this value come from": every value a collection uses ({{name}}, {config:KEY}, {env:NAME}) with the
 * scope that gives it, the value it has now, the scopes it hides (shadowed), the requests that use it and the
 * requests / scripts that set it. Scopes for {{name}}, highest first: saved in this session (by a response or a
 * script), the collection's variables, the scripts' globals. {config:KEY} is the project's configuration for the
 * environment; {env:NAME} a Studio secret or an environment variable of the machine.
 */
import { allRequests, ApiCollection, ApiRequest } from './model';
import type { Values } from './send';

export type ScopeName = 'saved' | 'collection' | 'global' | 'config' | 'secret' | 'missing';

export interface ScopeEntry {
    ref: string;
    name: string;
    from: ScopeName;
    value?: string;
    /** Lower scopes that also have this name (the value they would give). */
    shadowed: Array<{ from: ScopeName; value: string }>;
    usedBy: string[];
    setBy: string[];
    secret: boolean;
}

const REF = /\{\{\s*([\w.-]+)\s*\}\}|\{config:([\w.-]+)\}|\{env:([\w.-]+)\}/g;

function textsOf(r: ApiRequest): string[] {
    const kv = (a?: Array<{ key: string; value: string; enabled?: boolean }>) => (a ?? []).filter((x) => x.enabled !== false).flatMap((x) => [x.key, x.value]);
    const a = r.auth as unknown as Record<string, unknown>;
    return [r.url, ...kv(r.query), ...kv(r.headers), r.body.text ?? '', ...kv(r.body.form), ...(r.body.parts ?? []).map((p) => JSON.stringify(p)),
        ...Object.values(a).filter((x): x is string => typeof x === 'string'), ...(r.ws?.steps ?? []).map((s) => JSON.stringify(s)), ...(r.checks ?? []).map((c) => JSON.stringify(c))];
}

/** Names a script sets: pm.environment / collectionVariables / variables / globals .set('name', …). */
export function scriptSets(code: string | undefined): Array<{ name: string; global: boolean }> {
    const out: Array<{ name: string; global: boolean }> = [];
    for (const m of (code ?? '').matchAll(/pm\.(environment|collectionVariables|variables|globals)\.set\(\s*(['"`])([\w.-]+)\2/g)) out.push({ name: m[3], global: m[1] === 'globals' });
    for (const m of (code ?? '').matchAll(/postman\.set(Environment|Global)Variable\(\s*(['"`])([\w.-]+)\2/g)) out.push({ name: m[3], global: m[1] === 'Global' });
    return out;
}

export function variableScopes(c: Pick<ApiCollection, 'baseUrl' | 'variables' | 'items' | 'auth' | 'scripts'>, v: Values, saved: Record<string, string>, globals: Record<string, string>, secretNames: string[] = []): ScopeEntry[] {
    const map = new Map<string, ScopeEntry>();
    const entry = (ref: string, name: string): ScopeEntry => {
        let e = map.get(ref);
        if (!e) { e = { ref, name, from: 'missing', shadowed: [], usedBy: [], setBy: [], secret: false }; map.set(ref, e); }
        return e;
    };
    const scan = (text: string, by: string) => {
        for (const m of text.matchAll(REF)) {
            const e = m[1] ? entry(`{{${m[1]}}}`, m[1]) : m[2] ? entry(`{config:${m[2]}}`, m[2]) : entry(`{env:${m[3]}}`, m[3]);
            if (!e.usedBy.includes(by)) e.usedBy.push(by);
        }
    };
    scan(c.baseUrl, 'Base URL');
    for (const x of c.variables) if (x.enabled !== false) scan(x.value, `Variable ${x.key}`);
    scan(Object.values(c.auth as unknown as Record<string, unknown>).filter((x): x is string => typeof x === 'string').join(' '), 'Collection auth');
    const reqs = allRequests(c.items).map((x) => x.request);
    for (const r of reqs) {
        for (const t of textsOf(r)) scan(t, r.name);
        for (const e of r.extract ?? []) { const s = entry(`{{${e.variable}}}`, e.variable); if (!s.setBy.includes(`${r.name} (saved from the response)`)) s.setBy.push(`${r.name} (saved from the response)`); }
        for (const s of [...scriptSets(r.scripts?.pre), ...scriptSets(r.scripts?.test)]) entry(`{{${s.name}}}`, s.name).setBy.push(`${r.name} (script${s.global ? ', global' : ''})`);
    }
    for (const s of [...scriptSets(c.scripts?.pre), ...scriptSets(c.scripts?.test)]) entry(`{{${s.name}}}`, s.name).setBy.push(`Collection script${s.global ? ' (global)' : ''}`);
    for (const x of c.variables) if (x.enabled !== false) entry(`{{${x.key}}}`, x.key);
    for (const k of Object.keys(saved)) entry(`{{${k}}}`, k);
    for (const k of Object.keys(globals)) entry(`{{${k}}}`, k);
    const secrets = new Set(secretNames);
    for (const e of map.values()) {
        if (e.ref.startsWith('{config:')) {
            if (e.name in v.config) { e.from = 'config'; e.value = v.config[e.name]; }
        } else if (e.ref.startsWith('{env:')) {
            const x = v.env[e.name];
            if (x !== undefined) { e.from = 'secret'; e.value = x; e.secret = secrets.has(e.name); }
        } else {
            const layers: Array<[ScopeName, string | undefined]> = [
                ['saved', saved[e.name]],
                ['collection', c.variables.some((x) => x.enabled !== false && x.key === e.name) ? v.vars[e.name] : undefined],
                ['global', globals[e.name]],
            ];
            const have = layers.filter((l): l is [ScopeName, string] => l[1] !== undefined);
            if (have.length) { e.from = have[0][0]; e.value = have[0][1]; e.shadowed = have.slice(1).map(([from, value]) => ({ from, value })); }
            e.secret = c.variables.some((x) => x.key === e.name && x.secret);
        }
    }
    const order: Record<ScopeName, number> = { missing: 0, saved: 1, collection: 2, global: 3, config: 4, secret: 5 };
    return [...map.values()].sort((a, b) => order[a.from] - order[b.from] || a.name.localeCompare(b.name));
}
