/** Recording for load: a session recorded through the recording address becomes a collection (values correlated, pauses kept) that runs under load; recording again updates it. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { recordForLoad, mergeRecording } from '../src/load/recordLoad';
import { LoadEngine } from '../src/load/engine';
import { newScenario } from '../src/load/scenario';
import { allRequests } from '../src/api/model';

function app() {
    let n = 0;
    const tokens = new Set<string>();
    const s = http.createServer((q, r) => {
        let b = ''; q.on('data', (c) => (b += c));
        q.on('end', () => {
            const json = (st: number, o: unknown) => { r.writeHead(st, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
            if (q.url === '/api/login') { const t = `tok-${++n}-${Math.random().toString(36).slice(2, 8)}`; tokens.add(t); return json(200, { token: t }); }
            const auth = String(q.headers.authorization ?? '').replace('Bearer ', '');
            if (!tokens.has(auth)) return json(401, { error: 'sign in' });
            if (q.url === '/api/orders' && q.method === 'POST') return json(201, { orderId: `ord-${++n}${Math.random().toString(36).slice(2, 6)}` });
            if (q.url!.startsWith('/api/orders/ord-')) return json(200, { id: q.url!.split('/').pop(), ok: true });
            if (q.url === '/api/profile') return json(200, { name: 'qa' });
            json(404, {});
        });
    });
    return { s, listen: () => new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port))) };
}
const call = (url: string, method = 'GET', body?: string, token?: string) => new Promise<{ status: number; body: string }>((res, rej) => {
    const q = http.request(url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode ?? 0, body: b })); });
    q.on('error', rej); q.end(body);
});
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a recorded session becomes a load path: correlated values, recorded think times; it runs under load; recording again updates it', { timeout: 60_000 }, async () => {
    const a = app();
    const port = await a.listen();
    try {
        // The person (or the app, or the tests) works through the recording address.
        const rec = await recordForLoad(`http://127.0.0.1:${port}`);
        const login = JSON.parse((await call(`${rec.url}/api/login`, 'POST', '{"user":"qa"}')).body).token;
        await pause(300);
        const ord = JSON.parse((await call(`${rec.url}/api/orders`, 'POST', '{"item":"book"}', login)).body).orderId;
        await pause(200);
        await call(`${rec.url}/api/orders/${ord}`, 'GET', undefined, login);
        assert.equal(rec.count(), 3);
        const { collection: c, report } = await rec.stop({ name: 'Shop session' });
        const reqs = allRequests(c.items).map((x) => x.request);
        assert.equal(reqs.length, 3);
        assert.ok(report.correlations.length >= 2, JSON.stringify(report.correlations));
        assert.ok(reqs[1].headers.some((h) => /\{\{\w+\}\}/.test(h.value)), 'the token is a saved value, not the recorded one');
        assert.match(reqs[2].url, /\{\{\w+\}\}/, 'the order id too');
        assert.ok(reqs[0].recordedThinkMs! >= 250 && reqs[1].recordedThinkMs! >= 150, `${reqs[0].recordedThinkMs} ${reqs[1].recordedThinkMs}`);
        // Under load: every user signs in with its own token and reads its own order.
        const r = await new LoadEngine({ scenario: { ...newScenario('t', 'test/p/api/a.collection.json'), thinkTime: { min: 0, max: 0 }, slas: [], policy: { type: 'constant', users: 3, duration: 1 } },
            collection: { baseUrl: c.baseUrl, auth: c.auth }, requests: reqs, values: { vars: Object.fromEntries(c.variables.map((v) => [v.key, v.value])), config: {}, env: {} }, rows: [] }).run();
        assert.ok(r.total.count >= 6 && r.total.errors === 0, `${r.total.count} requests, ${r.total.errors} errors: ${JSON.stringify(r.transactions.map((t) => t.topErrors))}`);
        // Recorded again: the order body changed, the profile is new, reading the order is gone.
        const rec2 = await recordForLoad(`http://127.0.0.1:${port}`);
        const t2 = JSON.parse((await call(`${rec2.url}/api/login`, 'POST', '{"user":"qa"}')).body).token;
        await call(`${rec2.url}/api/orders`, 'POST', '{"item":"pen","qty":2}', t2);
        await call(`${rec2.url}/api/profile`, 'GET', undefined, t2);
        const again = await rec2.stop();
        const mine = { ...c, items: c.items.map((it) => (it.kind === 'request' && it.method === 'POST' && it.url.includes('orders') ? { ...it, checks: [{ kind: 'status' as const, value: '201' }], name: 'Place order' } : it)) };
        const m = mergeRecording(mine, again.collection);
        assert.deepEqual(m.report, { kept: [reqs[0].name], updated: ['Place order'], added: [allRequests(again.collection.items)[2].request.name], missing: [reqs[2].name] });
        const placed = allRequests(m.collection.items).map((x) => x.request).find((x) => x.name === 'Place order')!;
        assert.deepEqual(placed.checks, [{ kind: 'status', value: '201' }], 'checks written by hand are kept');
        assert.match(placed.body.text!, /"pen"/, 'the new body is taken');
    } finally { a.s.close(); }
});
