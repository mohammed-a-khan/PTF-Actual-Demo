/** HTTP/2 (one session per user, requests multiplexed) and a page's resources loaded as a browser does, through the user's cache. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import * as http2 from 'http2';
import { AgentPool, sendWith } from '../src/api/send';
import { BrowserCache, loadResources, pageResources } from '../src/load/resources';
import { LoadEngine } from '../src/load/engine';
import { newScenario } from '../src/load/scenario';
import { newRequest } from '../src/api/model';

test('HTTP/2: answers decoded, redirects followed, one session for a user\'s requests', async () => {
    let sessions = 0;
    const s = http2.createServer();
    s.on('session', () => sessions++);
    s.on('stream', (st, h) => {
        if (h[':path'] === '/old') { st.respond({ ':status': 302, location: '/new' }); st.end(); return; }
        st.respond({ ':status': 200, 'content-type': 'application/json' });
        st.end(JSON.stringify({ path: h[':path'], method: h[':method'], auth: h.authorization ?? null }));
    });
    const port = await new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port)));
    const pool = new AgentPool();
    try {
        const p = (u: string, m = 'GET') => ({ method: m, url: `http://127.0.0.1:${port}${u}`, headers: { Authorization: 'Bearer h2' }, missing: [] });
        const a = await sendWith(p('/a?x=1'), { http2: true }, undefined, 5000, undefined, pool);
        assert.deepEqual([a.status, a.httpVersion, a.json], [200, '2', { path: '/a?x=1', method: 'GET', auth: 'Bearer h2' }]);
        const b = await sendWith(p('/old'), { http2: true }, undefined, 5000, undefined, pool);
        assert.deepEqual([b.status, (b.json as { path: string }).path, b.redirects.length], [200, '/new', 1]);
        const c = await sendWith(p('/old'), { http2: true, followRedirects: false }, undefined, 5000, undefined, pool);
        assert.equal(c.status, 302);
        await Promise.all([1, 2, 3].map((i) => sendWith(p(`/p${i}`, 'POST'), { http2: true }, undefined, 5000, undefined, pool)));
        assert.equal(sessions, 1, 'every request of the user on one HTTP/2 session');
    } finally { pool.close(); s.close(); }
});

test('a page\'s resources: same-site only, six at a time, the cache honoured (fresh, revalidated, not stored)', async () => {
    const html = `<html><head><base href="/shop/"><link rel="stylesheet" href="app.css"><link rel="icon" href="/favicon.ico"><script src="app.js"></script>
        <script src="https://cdn.other.test/x.js"></script></head><body><img src="logo.png"><img src="data:image/png;base64,AA=="><img src="/missing.png"></body></html>`;
    const urls = pageResources(html, 'http://site.test/shop/index.html');
    assert.deepEqual([...urls].sort(), ['http://site.test/favicon.ico', 'http://site.test/missing.png', 'http://site.test/shop/app.css', 'http://site.test/shop/app.js', 'http://site.test/shop/logo.png']);
    const hits: string[] = [];
    const s = http.createServer((q, r) => {
        hits.push(`${q.url}${q.headers['if-none-match'] ? ' (if-none-match)' : ''}`);
        if (q.url === '/shop/index.html') { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(html); return; }
        if (q.url === '/shop/app.css') { r.writeHead(200, { 'Cache-Control': 'max-age=600' }); r.end('body{}'); return; }
        if (q.url === '/shop/app.js') { if (q.headers['if-none-match'] === '"v1"') { r.writeHead(304, { ETag: '"v1"' }); r.end(); return; } r.writeHead(200, { ETag: '"v1"', 'Cache-Control': 'no-cache' }); r.end('x()'); return; }
        if (q.url === '/shop/logo.png' || q.url === '/favicon.ico') { r.writeHead(200, { 'Cache-Control': 'no-store' }); r.end('png'); return; }
        r.writeHead(404); r.end();
    });
    const port = await new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port)));
    try {
        const cache = new BrowserCache();
        const get = async (u: string, h: Record<string, string>) => { const x = await sendWith({ method: 'GET', url: u.replace('site.test', `127.0.0.1:${port}`), headers: h, missing: [] }, undefined, undefined, 5000); return { status: x.status, headers: x.headers, size: x.size }; };
        const first = await loadResources(urls, cache, get);
        assert.deepEqual([first.requested, first.fromCache, first.notModified, first.failed], [5, 0, 0, ['404 /missing.png']]);
        const again = await loadResources(urls, cache, get);
        assert.deepEqual([again.requested, again.fromCache, again.notModified], [4, 1, 1], 'css fresh from the cache; js revalidated (304); images not stored');
        assert.ok(hits.includes('/shop/app.js (if-none-match)'));
        // Under load: the page's time includes its resources; a failed resource fails the page.
        hits.length = 0;
        const page = { ...newRequest('Home', 'home'), url: '/shop/index.html', checks: [{ kind: 'status' as const, value: '200' }], settings: { resources: true } };
        const r = await new LoadEngine({ scenario: { ...newScenario('t', 'test/p/api/a.collection.json'), thinkTime: { min: 0, max: 0 }, slas: [], policy: { type: 'constant', users: 1, duration: 1 }, iterationsPerUser: 2 },
            collection: { baseUrl: `http://127.0.0.1:${port}`, auth: { type: 'none' } }, requests: [page], values: { vars: {}, config: {}, env: {} }, rows: [] }).run();
        assert.equal(hits.filter((h) => h === '/shop/app.css').length, 1, 'the returning user takes the style sheet from its cache');
        assert.equal(hits.filter((h) => h.startsWith('/shop/app.js')).length, 2);
        assert.equal(r.transactions[0].errors, 2, 'the missing image fails the page each time');
        assert.match(r.transactions[0].topErrors![0].message, /1 resource failed: 404 \/missing\.png/);
    } finally { s.close(); }
});
