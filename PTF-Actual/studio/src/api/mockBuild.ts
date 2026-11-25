/**
 * Mock definitions made by the Studio: from a collection's saved examples (each request a route, its examples the
 * answers chosen by query / body), and recorded from real traffic (a proxy to the real service that keeps every
 * answer: replayed as a mock, with the answers that differed by query or body kept apart).
 */
import * as http from 'http';
import * as https from 'https';
import { allRequests, ApiCollection, ApiRequest } from './model';
import type { MockDefinition, MockResponse, MockRoute } from './mock';

/** The path of a request as a mock route: base URL and host removed, {{name}} and :name parts as {name}. */
export function routePath(url: string, baseUrl: string): string {
    let p = url.trim().replace(/\?.*$/, '');
    if (/^\{\{\s*baseUrl\s*\}\}/i.test(p)) p = p.replace(/^\{\{\s*baseUrl\s*\}\}/i, '');
    else p = p.replace(/^[a-z]+:\/\/[^/]+/i, '');
    const basePath = (() => { try { return new URL(baseUrl.replace(/\{[^}]*\}/g, 'x')).pathname.replace(/\/+$/, ''); } catch { return ''; } })();
    if (basePath && p.startsWith(basePath)) p = p.slice(basePath.length);
    if (!p.startsWith('/')) p = `/${p}`;
    return p.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, '{$1}').replace(/\/:([\w-]+)/g, '/{$1}').replace(/\/+$/, '') || '/';
}

const bodyOf = (text: string | undefined, ct: string): unknown => {
    if (text === undefined || text === '') return undefined;
    if (/json/i.test(ct) || /^\s*[[{]/.test(text)) { try { return JSON.parse(text); } catch { /* text */ } }
    return text;
};

/** A mock from the examples of a collection's requests: the first example is the route's answer, the others answer the requests they were saved for. */
export function mockFromCollection(c: ApiCollection, name?: string): { mock: MockDefinition; warnings: string[] } {
    const warnings: string[] = [];
    const routes: MockRoute[] = [];
    for (const { request: r } of allRequests(c.items)) {
        if (r.ws) continue;
        const ex = r.examples ?? [];
        if (!ex.length) { warnings.push(`"${r.name}" has no saved example: not in the mock.`); continue; }
        const path = routePath(r.url, c.baseUrl);
        const answer = (e: NonNullable<ApiRequest['examples']>[number]) => {
            const ct = Object.entries(e.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
            const headers = Object.fromEntries(Object.entries(e.headers ?? {}).filter(([k]) => !/^(content-length|transfer-encoding|connection|date|keep-alive|content-encoding)$/i.test(k)));
            return { status: e.status, ...(Object.keys(headers).length ? { headers } : {}), ...(e.body !== undefined ? { body: bodyOf(e.body, ct) } : {}) };
        };
        // Examples saved for particular requests first (so the general one does not hide them).
        const specific = ex.filter((e) => e.when?.query && Object.keys(e.when.query).length || e.when?.body);
        const general = ex.find((e) => !specific.includes(e)) ?? ex[0];
        const responses: MockResponse[] = specific.filter((e) => e !== general).map((e) => ({ name: e.name, when: { ...(e.when?.query ? { query: e.when.query } : {}), ...(e.when?.body ? { body: e.when.body } : {}) }, ...answer(e) }));
        const dup = routes.find((x) => x.method === r.method && x.path === path);
        if (dup) { dup.responses = [...(dup.responses ?? []), ...responses]; warnings.push(`"${r.name}": same route as "${dup.name}" (${r.method} ${path}); its examples were added there.`); continue; }
        routes.push({ name: r.name, method: r.method, path, ...answer(general), ...(responses.length ? { responses } : {}) });
    }
    if (!routes.length) throw new Error('No request of this collection has a saved example: send a request and use "Save as example" first.');
    return { mock: { name: name || `${c.name} mock`, routes, source: `collection ${c.name}` }, warnings };
}

export interface MockRecorder { url: string; port: number; count: () => number; stop: () => Promise<MockDefinition> }

/**
 * A recording proxy: requests sent to it go to the real service; each answer is kept. Stopped, it gives a mock
 * definition: one route per method and path (ids in the path kept as recorded), the answers that differed by query
 * or body as answers for those requests.
 */
export function recordMock(target: string, o: { name?: string; agentFor?: (url: string) => http.Agent | undefined; ca?: string | string[] } = {}): Promise<MockRecorder> {
    let base: URL;
    try { base = new URL(target); } catch { return Promise.reject(new Error('The address needs a host after http:// or https://, e.g. https://api.example.com.')); }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return Promise.reject(new Error('Record from an http:// or https:// address.'));
    if (!base.hostname) return Promise.reject(new Error('The address needs a host after http:// or https://, e.g. https://api.example.com.'));
    const seen: Array<{ method: string; path: string; query: Record<string, string>; reqBody: string; status: number; headers: Record<string, string>; body: string }> = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const inBody = Buffer.concat(chunks);
            // The service's address with its path (http://host/api + /orders → http://host/api/orders).
            const u = new URL(`${base.pathname.replace(/\/+$/, '')}${req.url ?? '/'}`, base.origin);
            const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/^(host|connection|accept-encoding)$/i.test(k))) as Record<string, string>;
            const out = (u.protocol === 'https:' ? https : http).request(u, { method: req.method, headers: { ...headers, host: u.host }, agent: o.agentFor?.(u.href), ...(o.ca ? { ca: o.ca } : {}) }, (up) => {
                const got: Buffer[] = [];
                up.on('data', (c: Buffer) => got.push(c));
                up.on('end', () => {
                    const body = Buffer.concat(got);
                    const hs = Object.fromEntries(Object.entries(up.headers).filter(([k]) => !/^(content-length|transfer-encoding|connection|date|keep-alive)$/i.test(k)).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]));
                    res.writeHead(up.statusCode ?? 502, hs);
                    res.end(body);
                    if (seen.length < 2000) seen.push({ method: (req.method ?? 'GET').toUpperCase(), path: new URL(req.url ?? '/', 'http://x').pathname, query: Object.fromEntries(u.searchParams), reqBody: inBody.toString('utf8'), status: up.statusCode ?? 0, headers: hs, body: body.toString('utf8') });
                });
            });
            out.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `Recording: ${e.message}` })); });
            out.end(inBody);
        });
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as { port: number }).port;
            resolve({
                url: `http://127.0.0.1:${port}`, port, count: () => seen.length,
                stop: () => new Promise<MockDefinition>((done) => server.close(() => {
                    const routes: MockRoute[] = [];
                    for (const x of seen) {
                        const ct = x.headers['content-type'] ?? '';
                        const answer = { status: x.status, headers: Object.fromEntries(Object.entries(x.headers).filter(([k]) => !/^(content-encoding|set-cookie)$/i.test(k))), body: bodyOf(x.body, ct) };
                        const r = routes.find((y) => y.method === x.method && y.path === x.path);
                        if (!r) { routes.push({ name: `${x.method} ${x.path}`, method: x.method, path: x.path, ...answer, _q: x.query, _b: x.reqBody } as MockRoute); continue; }
                        const first = r as MockRoute & { _q: Record<string, string>; _b: string };
                        const sameAsFirst = JSON.stringify(first._q) === JSON.stringify(x.query) && first._b === x.reqBody;
                        const when = { ...(Object.keys(x.query).length ? { query: x.query } : {}), ...(x.reqBody ? { body: x.reqBody } : {}) };
                        // A later answer to the same request: kept as the latest; to another request: an answer for it.
                        if (sameAsFirst) Object.assign(r, answer);
                        else if (Object.keys(when).length) { const k = JSON.stringify(when); r.responses = [...(r.responses ?? []).filter((y) => JSON.stringify(y.when) !== k), { when, ...answer }]; }
                    }
                    for (const r of routes) { delete (r as { _q?: unknown })._q; delete (r as { _b?: unknown })._b; }
                    done({ name: o.name || `${base.host} (recorded)`, routes, source: `recorded from ${base.origin}${base.pathname === '/' ? '' : base.pathname}` });
                })),
            });
        });
    });
}
