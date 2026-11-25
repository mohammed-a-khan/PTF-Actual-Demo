/**
 * Load user paths with logic: Init / Actions / End, transactions, loops, if, switch, try, wait until (polling), delay,
 * JavaScript, fork, rendezvous, queues between populations, generated values, next data row; per-request think time.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { LoadEngine } from '../src/load/engine';
import { LoadScenario, newScenario } from '../src/load/scenario';
import { logicProblems, PathLogic, PathShared } from '../src/load/logic';
import { ApiRequest, newRequest } from '../src/api/model';

const sc = (p: Partial<LoadScenario>): LoadScenario => ({ ...newScenario('t', 'test/p/api/a.collection.json'), thinkTime: { min: 0, max: 0 }, slas: [], ...p });
const V = { vars: {}, config: {}, env: {} };
const req = (id: string, url: string, extra: Partial<ApiRequest> = {}): ApiRequest => ({ ...newRequest(id, id), url, checks: [], ...extra });

function app() {
    const log: string[] = [];
    const jobs = new Map<string, number>();
    let order = 0;
    const s = http.createServer((q, r) => {
        let b = ''; q.on('data', (c) => (b += c));
        q.on('end', () => {
            const u = new URL(q.url!, 'http://x');
            log.push(`${q.method} ${u.pathname}${u.search}`);
            const json = (st: number, o: unknown) => { r.writeHead(st, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
            if (u.pathname === '/login') return json(200, { token: `t-${u.searchParams.get('u')}` });
            if (u.pathname === '/item') return json(q.headers.authorization?.startsWith('Bearer t-') ? 200 : 401, { ok: true });
            if (u.pathname === '/order') { const id = `o-${++order}`; jobs.set(id, 0); return json(201, { id, kind: order % 2 ? 'big' : 'small' }); }
            if (u.pathname.startsWith('/job/')) { const id = u.pathname.slice(5); const n = (jobs.get(id) ?? 0) + 1; jobs.set(id, n); return json(200, { state: n >= 3 ? 'done' : 'running' }); }
            if (u.pathname === '/approve') return json(200, { approved: u.searchParams.get('id') });
            if (u.pathname === '/fail') return json(500, { error: 'boom' });
            if (u.pathname === '/logout') return json(200, {});
            return json(200, { path: u.pathname });
        });
    });
    return { s, log, listen: () => new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port))) };
}

test('logic of a user path runs as written, with transactions, polling, rendezvous and queues between populations', { timeout: 60_000 }, async () => {
    const a = app();
    const port = await a.listen();
    try {
        const reqs = [
            req('login', '/login?u={{user}}', { extract: [{ variable: 'token', from: 'json', path: '$.token' }] }),
            req('item', '/item?n={{loopIndex}}&c={{cnt}}', { headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }], checks: [{ kind: 'status', value: '200' }] }),
            req('order', '/order', { method: 'POST', extract: [{ variable: 'orderId', from: 'json', path: '$.id' }, { variable: 'kind', from: 'json', path: '$.kind' }] }),
            req('job', '/job/{{orderId}}', { extract: [{ variable: 'state', from: 'json', path: '$.state' }] }),
            req('big', '/big'), req('small', '/small'),
            req('fail', '/fail', { checks: [{ kind: 'status', value: '200' }] }),
            req('recover', '/recover?why={{lastError}}'),
            req('logout', '/logout'),
            req('approve', '/approve?id={{toApprove}}'),
            req('par1', '/par1'), req('par2', '/par2'),
        ];
        const buyer: PathLogic = {
            init: [{ kind: 'request', id: 'login' }],
            actions: [
                { kind: 'generate', into: 'cnt', type: 'counter', start: 100 },
                { kind: 'transaction', name: 'Buy', steps: [
                    { kind: 'loop', count: 2, steps: [{ kind: 'request', id: 'item' }] },
                    { kind: 'request', id: 'order' },
                    { kind: 'if', condition: 'last.status === 201', then: [{ kind: 'js', code: 'vars.note = "created " + vars.orderId;' }] },
                ] },
                // Values saved in an earlier iteration stay: start the polling from scratch.
                { kind: 'js', code: "vars.state = '';" },
                { kind: 'waitUntil', condition: "vars.state === 'done'", steps: [{ kind: 'request', id: 'job' }], everyMs: 20, timeoutMs: 5000 },
                { kind: 'switch', value: 'vars.kind', cases: [{ equals: 'big', steps: [{ kind: 'request', id: 'big' }] }], default: [{ kind: 'request', id: 'small' }] },
                { kind: 'try', steps: [{ kind: 'request', id: 'fail' }], catch: [{ kind: 'request', id: 'recover' }] },
                { kind: 'fork', branches: [[{ kind: 'request', id: 'par1' }], [{ kind: 'request', id: 'par2' }]] },
                { kind: 'queuePut', queue: 'orders', value: '{{orderId}}' },
                { kind: 'rendezvous', name: 'all-buyers', users: 2, timeoutMs: 3000 },
                { kind: 'delay', ms: 10 },
            ],
            end: [{ kind: 'request', id: 'logout' }],
        };
        const approver: PathLogic = { actions: [
            { kind: 'queueTake', queue: 'orders', into: 'toApprove', timeoutMs: 3000 },
            { kind: 'request', id: 'approve', think: { min: 0, max: 5 } },
        ] };
        assert.deepEqual(logicProblems(buyer, new Set(reqs.map((r) => r.id))), []);
        assert.deepEqual(logicProblems({ actions: [{ kind: 'request', id: 'nope' }, { kind: 'loop', steps: [] }, { kind: 'fork', branches: [[]] }, { kind: 'js', code: 'if (' }] }, new Set(['x'])),
            ['Actions › 1: no request nope in the collection', 'Actions › 2: a loop needs a count or a condition', 'Actions › 3: fork needs at least two branches', 'Actions › 4: Unexpected token \'}\'']);
        const coll = { baseUrl: `http://127.0.0.1:${port}`, auth: { type: 'none' as const } };
        const rows = [{ user: 'ann' }, { user: 'bob' }, { user: 'cy' }];
        const engine = new LoadEngine({
            scenario: sc({ policy: { type: 'constant', users: 3, duration: 2 }, logic: buyer, data: { mode: 'perUser', file: 'x.csv' } }),
            collection: coll, requests: reqs, values: V, rows,
            populations: [{ name: 'Approvers', share: 34, collection: coll, requests: reqs, values: V, logic: approver }],
        });
        const r = await engine.run();
        const tx = Object.fromEntries(r.transactions.map((t) => [t.name.replace(/^(Main|Approvers) › /, ''), t]));
        const n = (p: string) => a.log.filter((l) => l.startsWith(p)).length;
        // 2 buyers (66%) and 1 approver.
        assert.deepEqual(r.populations.map((p) => p.name), ['Main', 'Approvers']);
        const orders = n('POST /order');
        assert.ok(orders >= 2, `orders: ${orders}`);
        assert.equal(n('GET /login'), 2, 'Init once per buyer');
        const logins = a.log.filter((l) => l.startsWith('GET /login?u=')).map((l) => l.slice(13));
        assert.equal(new Set(logins).size, 2, 'per-user data rows: each buyer its own row');
        assert.ok(logins.every((u) => ['ann', 'bob', 'cy'].includes(u)));
        // Iterations that reached the switch completed the polling (the last ones may be stopped part way at the end).
        const reached = n('GET /big') + n('GET /small');
        assert.ok(reached >= 1 && reached <= orders);
        assert.ok(n('GET /item') >= 2 * orders && n('GET /item') <= 2 * orders + 2, 'loop twice per iteration');
        assert.ok(a.log.includes('GET /item?n=0&c=100') && a.log.includes('GET /item?n=1&c=100'), 'loop index and counter');
        for (const id of a.log.filter((l) => l.startsWith('GET /job/')).map((l) => l.slice(9)).filter((v, i, all) => all.indexOf(v) === i).slice(0, reached))
            assert.ok(a.log.filter((l) => l === `GET /job/${id}`).length <= 3, 'polled until done, not after');
        assert.ok(n('GET /job/') >= 3 * reached, 'polled until done (3 times each)');
        assert.equal(n('GET /recover?why=Status%20is%20200'), n('GET /fail'), 'catch got the error');
        assert.equal(n('GET /par1'), n('GET /par2'));
        assert.equal(n('GET /logout'), 2, 'End once per buyer');
        assert.ok(n('GET /approve?id=o-') >= 1, 'approver took orders from the queue');
        assert.ok(a.log.filter((l) => l.startsWith('GET /approve?id=')).every((l) => /id=o-\d+$/.test(l)), 'a real order id each time');
        assert.ok(tx.Buy && tx.Buy.count === orders && tx.Buy.errors === 0, JSON.stringify(tx.Buy));
        if (process.env.CS_LOGIC_LOG) console.log(JSON.stringify({ orders, reached, big: n('GET /big'), small: n('GET /small'), jobs: n('GET /job/'), approve: n('GET /approve'), tx: Object.keys(tx) }));
        assert.equal(tx['fail'].errors, tx['fail'].count, 'the failure inside try is still counted');
        assert.ok(tx.Buy.avg >= tx['order'].avg, 'the transaction takes the time of its steps');
    } finally { a.s.close(); }
});

test('rendezvous: users wait for each other (a number or a share), time out alone, are released when the run stops', async () => {
    let active = 4, stopped = false;
    const s = new PathShared(() => active, () => stopped);
    const t0 = Date.now();
    const a = s.rendezvous('r', { users: 2 }, 2000);
    await new Promise((r) => setTimeout(r, 50));
    const b = s.rendezvous('r', { users: 2 }, 2000);
    assert.deepEqual(await Promise.all([a, b]), ['released', 'released']);
    assert.ok(Date.now() - t0 >= 50);
    assert.equal(await s.rendezvous('lonely', { users: 3 }, 50), 'timeout');
    const p = [s.rendezvous('half', { percent: 50 }, 2000), s.rendezvous('half', { percent: 50 }, 2000)];
    assert.deepEqual(await Promise.all(p), ['released', 'released'], '50% of 4 users');
    active = 10;
    const w = s.rendezvous('stop', { users: 10 }, 5000);
    stopped = true; s.releaseAll();
    assert.equal(await w, 'released');
    assert.equal(s.released.get('r'), 1);
    s.put('q', 'v1');
    assert.equal(await s.take('q', 10), 'v1');
    assert.equal(await s.take('q', 20), null);
    assert.deepEqual([s.counter('c', 5), s.counter('c', 5)], [5, 6]);
});
