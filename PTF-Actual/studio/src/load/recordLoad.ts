/**
 * Recording for load tests: a recording address in front of the service (the app, a browser or the BDD tests are
 * pointed at it); every exchange goes through and is kept with its timing. Stopped, the recording is a HAR file that
 * becomes a collection the HAR import's way (values to correlate found, the pauses kept as recorded think times).
 * A user path recorded again updates its collection: requests matched by method and path keep their checks and saved
 * values, changed ones get the new headers and body, new ones are added, missing ones are listed.
 */
import * as http from 'http';
import * as https from 'https';
import { importHar, HarOptions } from '../api/har';
import { allRequests, ApiCollection, ApiItem, ApiRequest } from '../api/model';

interface Exchange { started: number; time: number; method: string; url: string; reqHeaders: Record<string, string>; reqBody: string; status: number; statusText: string; resHeaders: Record<string, string>; resBody: string }

export interface LoadRecorder { url: string; count: () => number; stop: (o?: HarOptions) => Promise<{ har: string } & ReturnType<typeof importHar>> }

export function recordForLoad(target: string, o: { agentFor?: (url: string) => http.Agent | undefined; ca?: string | string[] } = {}): Promise<LoadRecorder> {
    const base = new URL(target);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return Promise.reject(new Error('Record from an http:// or https:// address.'));
    const seen: Exchange[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const started = Date.now();
            const inBody = Buffer.concat(chunks);
            const u = new URL(`${base.pathname.replace(/\/+$/, '')}${req.url ?? '/'}`, base.origin);
            const reqHeaders = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/^(host|connection|accept-encoding|content-length)$/i.test(k)).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]));
            const out = (u.protocol === 'https:' ? https : http).request(u, { method: req.method, headers: { ...reqHeaders, host: u.host }, agent: o.agentFor?.(u.href), ...(o.ca ? { ca: o.ca } : {}) }, (up) => {
                const got: Buffer[] = [];
                up.on('data', (c: Buffer) => got.push(c));
                up.on('end', () => {
                    const body = Buffer.concat(got);
                    const hs = Object.fromEntries(Object.entries(up.headers).filter(([k]) => !/^(content-length|transfer-encoding|connection|keep-alive)$/i.test(k)).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]));
                    res.writeHead(up.statusCode ?? 502, hs);
                    res.end(body);
                    if (seen.length < 5000) seen.push({ started, time: Date.now() - started, method: (req.method ?? 'GET').toUpperCase(), url: u.href, reqHeaders, reqBody: inBody.toString('utf8'), status: up.statusCode ?? 0, statusText: up.statusMessage ?? '', resHeaders: hs, resBody: body.toString('utf8') });
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
                url: `http://127.0.0.1:${port}`, count: () => seen.length,
                stop: (opts = {}) => new Promise((done, fail) => server.close(() => {
                    const har = JSON.stringify({ log: { version: '1.2', creator: { name: 'CS Test Studio', version: '1' }, entries: seen.map((x) => ({
                        startedDateTime: new Date(x.started).toISOString(), time: x.time,
                        request: { method: x.method, url: x.url, httpVersion: 'HTTP/1.1', headers: Object.entries(x.reqHeaders).map(([name, value]) => ({ name, value })), queryString: [], cookies: [], headersSize: -1, bodySize: x.reqBody.length,
                            ...(x.reqBody ? { postData: { mimeType: x.reqHeaders['content-type'] ?? 'text/plain', text: x.reqBody } } : {}) },
                        response: { status: x.status, statusText: x.statusText, httpVersion: 'HTTP/1.1', headers: Object.entries(x.resHeaders).map(([name, value]) => ({ name, value })), cookies: [], content: { size: x.resBody.length, mimeType: x.resHeaders['content-type'] ?? '', text: x.resBody }, redirectURL: '', headersSize: -1, bodySize: x.resBody.length },
                        cache: {}, timings: { send: 0, wait: x.time, receive: 0 },
                    })) } });
                    try { done({ har, ...importHar(har, { pages: true, ...opts }) }); } catch (e) { fail(e); }
                })),
            });
        });
    });
}

const keyOf = (r: ApiRequest) => `${r.method} ${r.url.replace(/\{\{[\w.-]+\}\}/g, '{}').replace(/\/\d+(?=\/|$)/g, '/{}')}`;

export interface MergeReport { kept: string[]; updated: string[]; added: string[]; missing: string[] }

/**
 * A user path recorded again: requests of the new recording matched to the collection's by method and path (ids and
 * {{values}} in the path seen as the same); a match keeps its id, name, checks and saved values and takes the new
 * headers, query and body; new ones are added at the end; the collection's requests the recording no longer has
 * stay (listed as missing) so nothing written by hand is lost.
 */
export function mergeRecording(existing: ApiCollection, recorded: ApiCollection): { collection: ApiCollection; report: MergeReport } {
    const report: MergeReport = { kept: [], updated: [], added: [], missing: [] };
    const fresh = allRequests(recorded.items).map((x) => x.request);
    const used = new Set<ApiRequest>();
    const replace = (items: ApiItem[]): ApiItem[] => items.map((it) => {
        if (it.kind === 'folder') return { ...it, items: replace(it.items) };
        const m = fresh.find((f) => !used.has(f) && keyOf(f) === keyOf(it));
        if (!m) { report.missing.push(it.name); return it; }
        used.add(m);
        const same = JSON.stringify([m.headers, m.query, m.body]) === JSON.stringify([it.headers, it.query, it.body]);
        (same ? report.kept : report.updated).push(it.name);
        return same ? it : { ...it, headers: m.headers, query: m.query, body: m.body, ...(m.recordedThinkMs !== undefined ? { recordedThinkMs: m.recordedThinkMs } : {}) };
    });
    const items = replace(existing.items);
    const added = fresh.filter((f) => !used.has(f));
    for (const a of added) report.added.push(a.name);
    // Values the new recording correlates that the collection does not have yet.
    const vars = [...existing.variables, ...recorded.variables.filter((v) => !existing.variables.some((e) => e.key === v.key))];
    return { collection: { ...existing, variables: vars, items: [...items, ...added] }, report };
}
