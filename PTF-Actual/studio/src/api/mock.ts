/**
 * API mocks: mirror of the framework's api/mock/CSApiMock.ts (keep the two in step: a mock runs the same in the Studio
 * and in a test). See there for the definition (<name>.mock.json), the faults and the {{path.x}} / {{query.x}} /
 * {{body.x}} values.
 */
import * as http from 'http';

export type MockFaultKind = 'none' | 'delay' | 'error' | 'drop' | 'malformed';

export interface MockFault {
    kind: MockFaultKind;
    /** The share of requests it applies to, 0–100 (default 100). */
    rate?: number;
    /** delay: how long before answering (ms). */
    delayMs?: number;
    /** error: the status answered (default 503) and its body. */
    status?: number;
    body?: string;
}

export interface MockRoute {
    method: string;
    /** /orders/{id}: a {name} part matches one path segment. */
    path: string;
    status: number;
    headers?: Record<string, string>;
    /** The body: JSON (an object, a list…) or text. */
    body?: unknown;
    /** Wait before every answer (ms), a network's usual time. */
    delayMs?: number;
    fault?: MockFault;
    /** Off: the route is not served (the fallback answers). */
    enabled?: boolean;
    name?: string;
    /** Other answers, chosen by the request: the first whose "when" matches (else the route's own answer). */
    responses?: MockResponse[];
    /** Stateful: the answers in turn, one per request (1st request: the route's own answer, then each of responses; the last repeats). */
    sequence?: boolean;
}

/** An answer of a route for some requests: query parameters, headers (any case), body (text it contains, or JSON fields it has). */
export interface MockResponse {
    name?: string;
    when?: { query?: Record<string, string>; headers?: Record<string, string>; body?: string };
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
}

/** The request matches "when": every query parameter and header given has that value; the body contains the text or has the JSON fields. */
export function mockWhenMatches(when: MockResponse['when'], req: { query: URLSearchParams; headers: Record<string, string | string[] | undefined>; text: string; json: unknown }): boolean {
    if (!when) return true;
    for (const [k, v] of Object.entries(when.query ?? {})) if (req.query.get(k) !== v) return false;
    for (const [k, v] of Object.entries(when.headers ?? {})) { const h = req.headers[k.toLowerCase()]; if ((Array.isArray(h) ? h.join(', ') : h) !== v) return false; }
    if (when.body !== undefined && when.body !== '') {
        let want: unknown;
        try { want = JSON.parse(when.body); } catch { want = undefined; }
        const has = (a: unknown, b: unknown): boolean => {
            if (b === null || typeof b !== 'object') return a === b;
            if (!a || typeof a !== 'object') return false;
            if (Array.isArray(b)) return Array.isArray(a) && b.every((x, i) => has(a[i], x));
            return Object.entries(b as Record<string, unknown>).every(([k, x]) => has((a as Record<string, unknown>)[k], x));
        };
        if (want !== undefined && typeof want === 'object' ? !has(req.json, want) : !req.text.includes(when.body)) return false;
    }
    return true;
}

export interface MockDefinition {
    name: string;
    /** The port to listen on (0 or none: any free port). */
    port?: number;
    routes: MockRoute[];
    /** The status of a request no route matches (default 404). */
    fallbackStatus?: number;
    /** Where it came from (an OpenAPI file of the repository), for the reader. */
    source?: string;
}

export interface MockLogEntry { at: string; method: string; path: string; status: number; route?: string; fault?: MockFaultKind; ms: number }

export interface RunningMock {
    url: string; port: number; log: MockLogEntry[]; close: () => Promise<void>;
    /** Apply a changed definition to the running mock at once (routes, answers, faults; not its port). */
    update: (d: MockDefinition) => void;
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

/** A definition's problems (empty: it can run). */
export function mockProblems(d: MockDefinition): string[] {
    const out: string[] = [];
    if (!d || typeof d !== 'object') return ['Not a mock definition.'];
    if (!Array.isArray(d.routes)) out.push('"routes" is not a list.');
    if (d.port !== undefined && (!Number.isInteger(d.port) || d.port < 0 || d.port > 65535)) out.push(`port ${d.port}: 0–65535.`);
    (Array.isArray(d.routes) ? d.routes : []).forEach((r, i) => {
        const at = `Route ${i + 1}`;
        if (!METHODS.includes(String(r?.method).toLowerCase())) out.push(`${at}: the method "${r?.method}" is not an HTTP method.`);
        if (typeof r?.path !== 'string' || !r.path.startsWith('/')) out.push(`${at}: the path starts with /.`);
        if (!Number.isInteger(r?.status) || r.status < 100 || r.status > 599) out.push(`${at}: the status ${r?.status} is not an HTTP status.`);
        const f = r?.fault;
        if (f && !['none', 'delay', 'error', 'drop', 'malformed'].includes(f.kind)) out.push(`${at}: the fault "${f.kind}" is unknown (none, delay, error, drop, malformed).`);
        if (f?.rate !== undefined && (typeof f.rate !== 'number' || f.rate < 0 || f.rate > 100)) out.push(`${at}: the fault's rate is a share 0–100.`);
        if (r?.responses !== undefined && !Array.isArray(r.responses)) out.push(`${at}: "responses" is not a list.`);
        (Array.isArray(r?.responses) ? r.responses : []).forEach((x, j) => { if (!Number.isInteger(x?.status) || x.status < 100 || x.status > 599) out.push(`${at}, answer ${j + 1}: the status ${x?.status} is not an HTTP status.`); });
    });
    return out;
}

/** A path template as a pattern: /orders/{id} → its parts. */
function matcher(template: string): { re: RegExp; names: string[] } {
    const names: string[] = [];
    const src = template.replace(/\/+$/, '').split('/').map((seg) => {
        const m = /^\{([^}]+)\}$/.exec(seg);
        if (m) { names.push(m[1]); return '([^/]+)'; }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    return { re: new RegExp(`^${src || ''}/?$`), names };
}

type MockReq = { path: Record<string, string>; query: URLSearchParams; body: unknown };
const TEMPLATE = /\{\{\s*(path|query|body)\.([\w.-]+)\s*\}\}/g;
function lookup(where: string, name: string, req: MockReq): unknown {
    if (where === 'path') return req.path[name];
    if (where === 'query') return req.query.get(name) ?? undefined;
    let v: unknown = req.body;
    for (const k of name.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
    return v;
}
const asText = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/** {{path.id}}, {{query.q}}, {{body.a.b}} of the request in a text body. A value the request does not have is empty. */
export function fillText(text: string, req: MockReq): string {
    return text.replace(TEMPLATE, (_m, where: string, name: string) => asText(lookup(where, name, req)));
}

/**
 * A text body written as JSON with values in it ({"id": {{path.id}}, "name": "{{query.name}}"}): each value fits where
 * it stands. Inside quotes it is escaped; outside, a number or true/false/null stays as it is, other text is quoted,
 * and a value the request does not have is null.
 */
export function fillJsonText(text: string, req: MockReq): string {
    let out = '', inStr = false;
    for (let i = 0; i < text.length;) {
        TEMPLATE.lastIndex = i;
        const m = text[i] === '{' && text[i + 1] === '{' ? new RegExp(TEMPLATE.source, 'y').exec(text.slice(i)) : null;
        if (m) {
            const v = lookup(m[1], m[2], req);
            // "{{query.x}}" (the whole string) for a value the request does not have: null, as in a JSON body.
            if (inStr && v === undefined && out.endsWith('"') && text[i + m[0].length] === '"') { out = out.slice(0, -1) + 'null'; inStr = false; i += m[0].length + 1; continue; }
            if (inStr) out += JSON.stringify(asText(v)).slice(1, -1);
            else if (v === undefined || v === null) out += 'null';
            else if (typeof v === 'string') out += /^-?\d+(\.\d+)?$|^(true|false|null)$/.test(v) ? v : JSON.stringify(v);
            else out += JSON.stringify(v);
            i += m[0].length; continue;
        }
        const ch = text[i];
        if (inStr && ch === '\\') { out += ch + (text[i + 1] ?? ''); i += 2; continue; }
        if (ch === '"') inStr = !inStr;
        out += ch; i++;
    }
    return out;
}

/**
 * The same in a JSON body, filled value by value so the answer stays valid JSON: quotes and line breaks in a value
 * are escaped; a string that is only "{{body.items}}" takes the value as it is (a number, a list, an object), or
 * null when the request does not have it.
 */
export function fillJson(body: unknown, req: MockReq): unknown {
    if (typeof body === 'string') {
        const whole = /^\{\{\s*(path|query|body)\.([\w.-]+)\s*\}\}$/.exec(body.trim());
        if (whole) { const v = lookup(whole[1], whole[2], req); return v === undefined ? null : v; }
        return fillText(body, req);
    }
    if (Array.isArray(body)) return body.map((x) => fillJson(x, req));
    if (body && typeof body === 'object') return Object.fromEntries(Object.entries(body).map(([k, v]) => [fillText(k, req), fillJson(v, req)]));
    return body;
}

/** Start a mock. Its URL is http://127.0.0.1:<port> (this computer only). */
export function startMock(d: MockDefinition, o: { host?: string; onRequest?: (e: MockLogEntry) => void; random?: () => number } = {}): Promise<RunningMock> {
    const problems = mockProblems(d);
    if (problems.length) return Promise.reject(new Error(`The mock "${d?.name}" cannot run: ${problems.join(' ')}`));
    const build = (x: MockDefinition) => x.routes.filter((r) => r.enabled !== false).map((r) => ({ r, m: matcher(r.path), method: r.method.toUpperCase(), calls: 0 }));
    let routes = build(d);
    let fallbackStatus = d.fallbackStatus;
    const random = o.random ?? Math.random;
    const log: MockLogEntry[] = [];
    const sockets = new Set<import('net').Socket>();
    const server = http.createServer((req, res) => {
        const t0 = Date.now();
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => { if (chunks.reduce((n, x) => n + x.length, 0) < 1_000_000) chunks.push(c); });
        req.on('end', () => {
            const u = new URL(req.url ?? '/', 'http://mock');
            const method = (req.method ?? 'GET').toUpperCase();
            let hit: (typeof routes)[number] | undefined, params: Record<string, string> = {};
            for (const x of routes) {
                if (x.method !== method && !(method === 'HEAD' && x.method === 'GET')) continue;
                const m = x.m.re.exec(u.pathname);
                if (m) { hit = x; params = Object.fromEntries(x.m.names.map((n, i) => [n, decodeURIComponent(m[i + 1])])); break; }
            }
            const done = (status: number, fault?: MockFaultKind) => {
                const e: MockLogEntry = { at: new Date().toISOString(), method, path: u.pathname + u.search, status, ...(hit ? { route: hit.r.name ?? `${hit.method} ${hit.r.path}` } : {}), ...(fault && fault !== 'none' ? { fault } : {}), ms: Date.now() - t0 };
                if (log.length >= 1000) log.shift();
                log.push(e);
                o.onRequest?.(e);
            };
            if (!hit) {
                const st = fallbackStatus ?? 404;
                res.writeHead(st, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `No mock route for ${method} ${u.pathname}` }));
                return done(st);
            }
            const route = hit.r;
            const text = Buffer.concat(chunks).toString('utf8');
            let body: unknown = text;
            try { body = text ? JSON.parse(text) : undefined; } catch { /* text */ }
            // The answer: in turn (stateful), or the first of the responses whose "when" matches, or the route's own.
            const n = hit.calls++;
            const extra = Array.isArray(route.responses) ? route.responses : [];
            const chosen: MockResponse | undefined = route.sequence
                ? (n === 0 || !extra.length ? undefined : extra[Math.min(n - 1, extra.length - 1)])
                : extra.find((x) => mockWhenMatches(x.when, { query: u.searchParams, headers: req.headers, text, json: body }));
            const r = chosen ? { ...route, status: chosen.status, headers: chosen.headers, body: chosen.body } : route;
            const f = r.fault && r.fault.kind !== 'none' && random() * 100 < (r.fault.rate ?? 100) ? r.fault : null;
            const answer = () => {
                if (f?.kind === 'drop') { req.socket.destroy(); return done(0, 'drop'); }
                if (f?.kind === 'error') {
                    const st = f.status ?? 503;
                    res.writeHead(st, { 'Content-Type': 'application/json' });
                    res.end(f.body ?? JSON.stringify({ error: 'Mock fault: an error' }));
                    return done(st, 'error');
                }
                const isText = typeof r.body === 'string';
                const vals = { path: params, query: u.searchParams, body };
                const out = r.body === undefined ? '' : isText ? (/^\s*[[{]/.test(r.body as string) ? fillJsonText(r.body as string, vals) : fillText(r.body as string, vals)) : JSON.stringify(fillJson(r.body, vals));
                // A text body that is JSON once filled ({"id": {{path.id}}}) is sent as JSON.
                const looksJson = isText && /^\s*[[{]/.test(out) && (() => { try { JSON.parse(out); return true; } catch { return false; } })();
                // 204 and 304 have no body, so no content type either.
                const noBody = r.status === 204 || r.status === 304;
                const headers: Record<string, string> = { ...(r.body !== undefined && !noBody ? { 'Content-Type': isText && !looksJson ? 'text/plain' : 'application/json' } : {}), ...(r.headers ?? {}) };
                res.writeHead(r.status, headers);
                if (f?.kind === 'malformed') { res.end(out.slice(0, Math.max(1, Math.floor(out.length / 2))) || '{'); return done(r.status, 'malformed'); }
                res.end(method === 'HEAD' || noBody ? undefined : out);
                done(r.status, f?.kind);
            };
            const wait = (r.delayMs ?? 0) + (f?.kind === 'delay' ? f.delayMs ?? 3000 : 0);
            if (wait > 0) setTimeout(answer, Math.min(wait, 300_000)); else answer();
        });
    });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    return new Promise((resolve, reject) => {
        server.once('error', (e: NodeJS.ErrnoException) => reject(e.code === 'EADDRINUSE' ? new Error(`Port ${d.port} is in use: choose another for the mock "${d.name}" (or 0 for any).`) : e));
        server.listen(d.port ?? 0, o.host ?? '127.0.0.1', () => {
            const port = (server.address() as { port: number }).port;
            resolve({
                url: `http://127.0.0.1:${port}`, port, log,
                update: (nd) => {
                    const p = mockProblems(nd);
                    if (p.length) throw new Error(`The mock "${nd?.name}" cannot run: ${p.join(' ')}`);
                    routes = build(nd); fallbackStatus = nd.fallbackStatus;
                },
                close: () => new Promise<void>((res2) => { for (const s of sockets) s.destroy(); server.close(() => res2()); }),
            });
        });
    });
}

type J = Record<string, any>;

/** A mock from an OpenAPI 3 / Swagger 2 document (an object): each operation's success response. */
export function mockFromOpenApi(doc: J, name?: string): { mock: MockDefinition; warnings: string[] } {
    const warnings: string[] = [];
    if (!doc || typeof doc !== 'object' || !doc.paths || (!doc.openapi && !doc.swagger)) throw new Error('This is not an OpenAPI (3.x) or Swagger (2.0) document.');
    const v2 = !!doc.swagger;
    const ref = (x: J | undefined, depth = 0): J | undefined => {
        if (!x || depth > 20) return x;
        if (typeof x.$ref === 'string') {
            let cur: J | undefined = doc;
            for (const p of x.$ref.replace(/^#\//, '').split('/').map((s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~'))) cur = cur?.[p];
            return ref(cur, depth + 1);
        }
        return x;
    };
    const sample = (schema: J | undefined, depth = 0): unknown => {
        const s = ref(schema);
        if (!s || depth > 6) return null;
        if (s.example !== undefined) return s.example;
        if (s.default !== undefined) return s.default;
        if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
        if (s.allOf) return Object.assign({}, ...s.allOf.map((x: J) => sample(x, depth + 1)).filter((x: unknown) => x && typeof x === 'object'));
        if (s.oneOf || s.anyOf) return sample((s.oneOf ?? s.anyOf)[0], depth + 1);
        const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== 'null') : s.type ?? (s.properties ? 'object' : s.items ? 'array' : 'string');
        if (type === 'object') return Object.fromEntries(Object.entries(s.properties ?? {}).slice(0, 50).map(([k, p]) => [k, sample(p as J, depth + 1)]));
        if (type === 'array') return [sample(s.items, depth + 1)];
        if (type === 'integer' || type === 'number') return s.minimum ?? 1;
        if (type === 'boolean') return true;
        const f = s.format ?? '';
        return f === 'date' ? '2024-01-31' : f === 'date-time' ? '2024-01-31T12:00:00Z' : f === 'email' ? 'user@example.com' : f === 'uuid' ? '00000000-0000-0000-0000-000000000000' : f === 'uri' ? 'https://example.com' : 'string';
    };
    // The base path of the first server (/api/v1): routes are served under it.
    let base = '';
    if (v2) base = String(doc.basePath ?? '');
    else { try { base = new URL(String(doc.servers?.[0]?.url ?? '/'), 'http://x').pathname; } catch { base = ''; } }
    base = base.replace(/\{[^}]+\}/g, 'v').replace(/\/+$/, '');
    const routes: MockRoute[] = [];
    for (const [p, item] of Object.entries(doc.paths as J)) {
        const pi = ref(item as J) ?? {};
        for (const m of METHODS) {
            const op = pi[m] as J | undefined;
            if (!op) continue;
            const codes = Object.keys(op.responses ?? {});
            const ok = codes.find((c) => /^2\d\d$/.test(c)) ?? codes.find((c) => c === 'default');
            const res = ok ? ref(op.responses[ok]) ?? {} : {};
            let body: unknown;
            if (v2) body = res.examples?.['application/json'] ?? (res.schema ? sample(res.schema) : undefined);
            else {
                const ct = Object.keys(res.content ?? {}).find((k) => /json/i.test(k)) ?? Object.keys(res.content ?? {})[0];
                const media = ct ? res.content[ct] : undefined;
                if (media) {
                    const ex = media.example ?? (media.examples ? (ref(Object.values(media.examples as J)[0] as J) as J)?.value : undefined);
                    body = ex !== undefined ? ex : sample(media.schema);
                    if (!/json/i.test(ct) && typeof body !== 'string') body = body === undefined ? '' : String(body);
                }
            }
            const status = ok && ok !== 'default' ? Number(ok) : 200;
            routes.push({ name: String(op.operationId || op.summary || `${m.toUpperCase()} ${p}`).slice(0, 120), method: m.toUpperCase(), path: `${base}${p}`, status, ...(body !== undefined && status !== 204 ? { body } : {}), fault: { kind: 'none' } });
        }
    }
    if (!routes.length) warnings.push('The document has no operations.');
    // Literal paths before ones with {parts}: /orders/new before /orders/{id}.
    routes.sort((a, b) => (a.path.split('{').length - b.path.split('{').length));
    return { mock: { name: name || String(doc.info?.title ?? 'API'), port: 0, routes, source: undefined }, warnings };
}
