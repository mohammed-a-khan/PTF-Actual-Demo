/** Browser users: each a real browser; Core Web Vitals reported per page; the data row typed into recorded steps; through the proxy of the network settings. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { LoadEngine } from '../src/load/engine';
import { newScenario } from '../src/load/scenario';
import { loadPlaywright } from '../src/load/browserPath';
import { connection, DEFAULT_NETWORK } from '../src/core/network';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('browser users: Web Vitals per page, data rows typed, the proxy used', { timeout: 120_000 }, async (t) => {
    const root = process.env.CS_FRAMEWORK_PROJECT ?? '';
    try { if (!root || !fs.existsSync(path.join(root, 'node_modules'))) throw new Error('no project'); loadPlaywright(root); } catch { t.skip('Playwright of a project is needed: set CS_FRAMEWORK_PROJECT'); return; }
    const searched: string[] = [];
    const app = http.createServer((q, r) => {
        const u = new URL(q.url!, 'http://x');
        if (u.pathname === '/logo.png') { setTimeout(() => { r.writeHead(200, { 'Content-Type': 'image/png' }); r.end(PNG); }, 60); return; }
        if (u.pathname === '/search') { searched.push(u.searchParams.get('q') ?? ''); r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(`<h1>Results for ${u.searchParams.get('q')}</h1>`); return; }
        r.writeHead(200, { 'Content-Type': 'text/html' });
        r.end('<html><body><h1 id="t">Shop</h1><img src="/logo.png" width="400" height="300"><form action="/search"><input id="q" name="q"><button id="go">Go</button></form></body></html>');
    });
    const appPort = await new Promise<number>((res) => app.listen(0, '127.0.0.1', () => res((app.address() as net.AddressInfo).port)));
    // A forward proxy that records what went through it.
    const viaProxy: string[] = [];
    const proxy = http.createServer((q, r) => {
        viaProxy.push(String(q.url));
        const u = new URL(String(q.url));
        const up = http.request(u, { method: q.method, headers: q.headers }, (x) => { r.writeHead(x.statusCode ?? 502, x.headers); x.pipe(r); });
        q.pipe(up);
    });
    const proxyPort = await new Promise<number>((res) => proxy.listen(0, '127.0.0.1', () => res((proxy.address() as net.AddressInfo).port)));
    try {
        // The app is not 127.0.0.1 for the browser: "shop.test" exists only through the proxy (bypass lists keep localhost direct).
        const host = `shop.test:${appPort}`;
        const conn = connection({ ...DEFAULT_NETWORK, proxyMode: 'manual', proxyUrl: `http://127.0.0.1:${proxyPort}`, bypass: [] }, {});
        const def = { format: 'cs-studio-browser-path/1' as const, name: 'Search', startUrl: `http://${host}/`, browser: 'chromium' as const, signIn: [],
            actions: [{ type: 'fill', selector: '#q', value: '{{term}}' }, { type: 'click', selector: '#go' }] };
        const proxyHostMap = (q: http.IncomingMessage) => q; void proxyHostMap;
        // The proxy forwards shop.test to 127.0.0.1.
        proxy.removeAllListeners('request');
        proxy.on('request', (q, r) => {
            viaProxy.push(String(q.url));
            const u = new URL(String(q.url)); u.hostname = '127.0.0.1';
            const up = http.request(u, { method: q.method, headers: { ...q.headers, host: `127.0.0.1:${appPort}` } }, (x) => { r.writeHead(x.statusCode ?? 502, x.headers); x.pipe(r); });
            q.pipe(up);
        });
        const r = await new LoadEngine({ scenario: { ...newScenario('b', 'test/p/api/a.collection.json'), browserPath: 'test/p/load/s.browser.json', thinkTime: { min: 0, max: 0 }, slas: [], policy: { type: 'constant', users: 2, duration: 4 }, iterationsPerUser: 1, data: { mode: 'perUser', file: 'x.csv' } },
            collection: { baseUrl: '', auth: { type: 'none' } }, requests: [], values: { vars: {}, config: {}, env: {} }, rows: [{ term: 'books' }, { term: 'pens' }], connection: conn,
            browser: { def, projectRoot: root, headless: true } }).run();
        const names = r.transactions.map((x) => x.name);
        assert.ok(names.some((n) => n === 'Web vitals › LCP (largest contentful paint) › start page'), names.join(' | ') + JSON.stringify(r.transactions.map((x) => x.topErrors)));
        assert.ok(names.some((n) => n.startsWith('Web vitals › TTFB')) && names.some((n) => n.startsWith('Web vitals › CLS ×1000')));
        const lcp = r.transactions.find((x) => x.name === 'Web vitals › LCP (largest contentful paint) › start page')!;
        assert.ok(lcp.count === 2 && lcp.avg >= 50, `LCP waits for the image: ${lcp.avg} ms`);
        assert.ok(names.some((n) => n.startsWith('Web vitals › LCP (largest contentful paint) › 2. ')), 'the page after the click has its own vitals: ' + names.join(' | '));
        assert.deepEqual(searched.sort(), ['books', 'pens'], 'each user typed its own data row');
        assert.ok(viaProxy.some((u) => u.startsWith(`http://${host}/`)), 'the browser went through the proxy');
        assert.equal(r.total.errors, 0, JSON.stringify(r.transactions.filter((x) => x.errors).map((x) => [x.name, x.topErrors])));
    } finally { app.close(); proxy.close(); }
});
