/**
 * Saved examples: kept with requests, carried to and from Postman's format (saved responses), and served by a mock
 * made from them (the answer chosen by query / body); mocks with several answers and stateful sequences; a mock
 * recorded from real traffic answers as the service did.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { importCollection } from '../src/api/collectionImport';
import { exportReport } from '../src/api/collectionExport';
import { allRequests, ApiCollection, ApiRequest, newCollection, newRequest } from '../src/api/model';
import { mockFromCollection, recordMock, routePath } from '../src/api/mockBuild';
import { startMock } from '../src/api/mock';

const get = (url: string, o: { method?: string; body?: string; headers?: Record<string, string> } = {}) => new Promise<{ status: number; body: string }>((res, rej) => {
    const q = http.request(url, { method: o.method ?? 'GET', headers: { ...(o.body ? { 'Content-Type': 'application/json' } : {}), ...(o.headers ?? {}) } }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode ?? 0, body: b })); });
    q.on('error', rej); q.end(o.body);
});

function collection(): ApiCollection {
    const c = { ...newCollection('Shop'), baseUrl: 'https://api.shop.test/v2' };
    const list: ApiRequest = { ...newRequest('List orders'), id: 'a', url: '/orders', examples: [
        { id: 'e1', name: 'All', status: 200, headers: { 'Content-Type': 'application/json' }, body: '[{"id":1},{"id":2}]' },
        { id: 'e2', name: 'Shipped only', status: 200, headers: { 'Content-Type': 'application/json' }, body: '[{"id":2}]', when: { query: { status: 'shipped' } } },
    ] };
    const one: ApiRequest = { ...newRequest('Get order'), id: 'b', url: '/orders/{{orderId}}', examples: [{ id: 'e3', name: 'Found', status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"id":"{{path.orderId}}","total":30}' }] };
    const create: ApiRequest = { ...newRequest('Create order'), id: 'c', method: 'POST', url: '{{baseUrl}}/orders', body: { mode: 'json', text: '{"item":"book"}' }, examples: [
        { id: 'e4', name: 'Created', status: 201, headers: { 'Content-Type': 'application/json' }, body: '{"id":3}' },
        { id: 'e5', name: 'Out of stock', status: 409, headers: { 'Content-Type': 'application/json' }, body: '{"error":"out of stock"}', when: { body: '{"item":"rare"}' } },
    ] };
    c.items = [list, one, create, { ...newRequest('No example'), id: 'd', url: '/health' }];
    return c;
}

test('examples: Postman round trip (saved responses with their original request)', () => {
    const c = collection();
    const pm = exportReport(c, {}).collection as { item: Array<{ response?: Array<{ name: string; code: number; originalRequest: { url: { query?: unknown[] } } }> }> };
    assert.equal(pm.item[0].response!.length, 2);
    assert.deepEqual(pm.item[0].response![1].originalRequest.url.query, [{ key: 'status', value: 'shipped' }]);
    const back = allRequests(importCollection(pm).collection.items).map((x) => x.request);
    const strip = (r: ApiRequest) => (r.examples ?? []).map(({ id: _id, ...e }) => e);
    for (let i = 0; i < 3; i++) assert.deepEqual(strip(back[i]), strip(c.items[i] as ApiRequest), back[i].name);
});

test('a mock from the examples answers each request with its example; several answers by query / body; sequences', async () => {
    assert.equal(routePath('/orders/{{orderId}}', 'https://api.shop.test/v2'), '/orders/{orderId}');
    assert.equal(routePath('{{baseUrl}}/orders?x=1', 'https://api.shop.test/v2'), '/orders');
    assert.equal(routePath('https://api.shop.test/v2/orders/:id', 'https://api.shop.test/v2'), '/orders/{id}');
    const { mock, warnings } = mockFromCollection(collection());
    assert.deepEqual(warnings, ['"No example" has no saved example: not in the mock.']);
    mock.routes.push({ method: 'GET', path: '/jobs/{id}', status: 202, body: { state: 'queued' }, sequence: true, responses: [{ status: 202, body: { state: 'running' } }, { status: 200, body: { state: 'done', id: '{{path.id}}' } }] });
    const m = await startMock(mock);
    try {
        assert.deepEqual(JSON.parse((await get(`${m.url}/orders`)).body), [{ id: 1 }, { id: 2 }]);
        assert.deepEqual(JSON.parse((await get(`${m.url}/orders?status=shipped`)).body), [{ id: 2 }]);
        assert.deepEqual(JSON.parse((await get(`${m.url}/orders/77`)).body), { id: '77', total: 30 });
        let r = await get(`${m.url}/orders`, { method: 'POST', body: '{"item":"book","qty":1}' });
        assert.deepEqual([r.status, JSON.parse(r.body)], [201, { id: 3 }]);
        r = await get(`${m.url}/orders`, { method: 'POST', body: '{"qty":1,"item":"rare"}' });
        assert.deepEqual([r.status, JSON.parse(r.body)], [409, { error: 'out of stock' }], 'JSON fields matched whatever their order');
        const states = [];
        for (let i = 0; i < 4; i++) states.push(JSON.parse((await get(`${m.url}/jobs/9`)).body));
        assert.deepEqual(states, [{ state: 'queued' }, { state: 'running' }, { state: 'done', id: '9' }, { state: 'done', id: '9' }]);
    } finally { await m.close(); }
    assert.throws(() => mockFromCollection({ ...newCollection('Empty'), items: [newRequest('x')] }), /has a saved example/);
});

test('a mock recorded from real traffic answers as the service did (answers by query and body kept apart)', async () => {
    const real = http.createServer((q, r) => {
        let b = ''; q.on('data', (c) => (b += c));
        q.on('end', () => {
            const u = new URL(q.url!, 'http://x');
            r.writeHead(u.pathname === '/api/missing' ? 404 : 200, { 'Content-Type': 'application/json', 'X-Real': 'yes' });
            r.end(JSON.stringify({ path: u.pathname, status: u.searchParams.get('status'), got: b ? JSON.parse(b) : null }));
        });
    });
    const port = await new Promise<number>((res) => real.listen(0, '127.0.0.1', () => res((real.address() as { port: number }).port)));
    try {
        const rec = await recordMock(`http://127.0.0.1:${port}/api`);
        const live = [await get(`${rec.url}/orders`), await get(`${rec.url}/orders?status=open`), await get(`${rec.url}/orders`, { method: 'POST', body: '{"a":1}' }), await get(`${rec.url}/missing`)];
        assert.equal(rec.count(), 4);
        const def = await rec.stop();
        assert.deepEqual(def.routes.map((r) => `${r.method} ${r.path} ${r.status} ${r.responses?.length ?? 0}`), ['GET /orders 200 1', 'POST /orders 200 0', 'GET /missing 404 0']);
        const m = await startMock(def);
        try {
            const again = [await get(`${m.url}/orders`), await get(`${m.url}/orders?status=open`), await get(`${m.url}/orders`, { method: 'POST', body: '{"a":1}' }), await get(`${m.url}/missing`)];
            assert.deepEqual(again.map((x) => [x.status, JSON.parse(x.body)]), live.map((x) => [x.status, JSON.parse(x.body)]));
        } finally { await m.close(); }
    } finally { real.close(); }
});

test('mock answers with request values stay valid JSON (quotes, line breaks, whole values, missing values)', async () => {
    const m = await startMock({ name: 'esc', port: 0, routes: [
        { method: 'POST', path: '/orders/{id}', status: 201, body: { id: '{{path.id}}', note: 'Got {{body.note}} for {{query.who}}', items: '{{body.items}}', absent: '{{body.nope}}' } },
        { method: 'GET', path: '/raw/{id}', status: 200, body: '{"id": {{path.id}}, "q": "{{query.q}}"}' },
    ] } as never);
    try {
        const r = await fetch(`${m.url}/orders/7?who=a%22b`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: 'say "hi"\nthen go', items: [1, 2] }) });
        const j = await r.json() as Record<string, unknown>;
        assert.deepEqual(j, { id: '7', note: 'Got say "hi"\nthen go for a"b', items: [1, 2], absent: null });
        const r2 = await fetch(`${m.url}/raw/5`);
        assert.equal(r2.headers.get('content-type'), 'application/json');
        assert.deepEqual(await r2.json(), { id: 5, q: null }); // a missing value is null, as in a JSON body
    } finally { await m.close(); }
});

test('a running mock takes a changed definition at once', async () => {
    const def = { name: 'hot', port: 0, routes: [{ method: 'GET', path: '/a', status: 200, body: { v: 1 } }] };
    const m = await startMock(def as never);
    try {
        assert.deepEqual(await (await fetch(`${m.url}/a`)).json(), { v: 1 });
        m.update({ ...def, routes: [{ method: 'GET', path: '/a', status: 201, body: { v: 2 }, fault: { kind: 'error', status: 503 } }] } as never);
        assert.equal((await fetch(`${m.url}/a`)).status, 503);
        assert.throws(() => m.update({ name: 'x', routes: 'no' } as never), /cannot run/);
        assert.equal((await fetch(`${m.url}/a`)).status, 503, 'a bad definition leaves the running one');
    } finally { await m.close(); }
});
