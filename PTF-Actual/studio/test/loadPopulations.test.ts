/** Populations with their own policy and start delay, custom curves, iterations per user, load changed during the run, WAN emulation. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { LoadEngine, UserPath } from '../src/load/engine';
import { LoadScenario, newScenario, validScenario } from '../src/load/scenario';
import { curveFromCsv, usersAt, validPolicy } from '../src/load/policy';
import { newRequest } from '../src/api/model';

const sc = (p: Partial<LoadScenario>): LoadScenario => ({ ...newScenario('t', 'test/p/api/a.collection.json'), thinkTime: { min: 0, max: 0 }, slas: [], ...p });
const V = { vars: {}, config: {}, env: {} };
const coll = { baseUrl: '', auth: { type: 'none' as const } };
/** A path that records which user started when, and runs quick iterations. */
const path = (log: Array<{ user: number; at: number }>, t0: () => number, ms = 20): UserPath => ({
    async start(index) { log.push({ user: index, at: Date.now() - t0() }); return { async iteration(measure, pause) { await measure('x', 'X', async () => { await new Promise((r) => setTimeout(r, ms)); return null; }); await pause(); }, async close() { /* */ } }; },
    async dispose() { /* */ },
});

test('custom curve: straight lines between points, from CSV', () => {
    const pts = curveFromCsv('second,users\n0,0\n10,20\n20,20\n30,5\n');
    assert.deepEqual(pts, [{ t: 0, users: 0 }, { t: 10, users: 20 }, { t: 20, users: 20 }, { t: 30, users: 5 }]);
    const p = { type: 'custom' as const, duration: 40, users: 20, points: pts };
    assert.equal(validPolicy(p), null);
    assert.deepEqual([0, 5, 10, 15, 25, 30, 35].map((t) => usersAt(p, t)), [0, 10, 20, 20, 13, 5, 5]);
    assert.match(validPolicy({ ...p, points: [{ t: 5, users: 1 }, { t: 2, users: 1 }] })!, /go up in time/);
});

test('a population with its own policy starts after its delay and stops when told; the others share the main policy', async () => {
    let start = 0;
    const main: Array<{ user: number; at: number }> = [], late: Array<{ user: number; at: number }> = [];
    const e = new LoadEngine({ scenario: sc({ policy: { type: 'constant', users: 2, duration: 3 } }), collection: coll, requests: [], values: V, rows: [], userPath: path(main, () => start),
        populations: [{ name: 'Late', share: 0, collection: coll, requests: [], values: V, userPath: path(late, () => start), policy: { type: 'constant', users: 3, duration: 10 }, startDelay: 1.5, stopAfter: 2.5 }] });
    start = Date.now();
    const r = await e.run();
    assert.equal(main.length, 2, 'main: its 2 users');
    assert.equal(late.length, 3, 'late: its own 3 users');
    assert.ok(late.every((x) => x.at >= 1400), `started after the delay: ${late.map((x) => x.at)}`);
    const tl = r.timeline;
    const at = (sec: number) => tl.find((x) => x.t === sec)?.users;
    assert.deepEqual([at(0), at(1), at(2)], [2, 5, 2], JSON.stringify(tl.map((x) => [x.t, x.users])));
    assert.throws(() => validScenario(sc({ populations: [{ name: 'x', share: 10, collection: 'test/p/api/a.collection.json', requests: [], policy: { type: 'custom', duration: 5, users: 1, points: [] } }] })), /policy of x: A custom curve needs/);
});

test('iterations per user: each user does its iterations and is not replaced; the run ends when all are done', async () => {
    let start = 0;
    const log: Array<{ user: number; at: number }> = [];
    const e = new LoadEngine({ scenario: sc({ policy: { type: 'constant', users: 3, duration: 30 }, iterationsPerUser: 4 }), collection: coll, requests: [], values: V, rows: [], userPath: path(log, () => start, 10) });
    start = Date.now();
    const r = await e.run();
    assert.equal(log.length, 3);
    assert.equal(r.iterations, 12);
    assert.equal(r.stopReason, 'completed');
    assert.ok(Date.now() - start < 10_000, 'ended long before the 30 s duration');
});

test('the load changed during the run follows at once', async () => {
    let start = 0;
    const log: Array<{ user: number; at: number }> = [];
    const e = new LoadEngine({ scenario: sc({ policy: { type: 'constant', users: 2, duration: 3 } }), collection: coll, requests: [], values: V, rows: [], userPath: path(log, () => start) });
    start = Date.now();
    setTimeout(() => e.adjust(3), 1000);
    setTimeout(() => e.adjust(0.5), 2000);
    const r = await e.run();
    const at = (sec: number) => r.timeline.find((x) => x.t === sec)?.users;
    assert.deepEqual([at(0), at(1), at(2)], [2, 6, 1], JSON.stringify(r.timeline.map((x) => [x.t, x.users])));
    assert.equal(e.loadFactor, 0.5);
});

test('WAN emulation: latency and bandwidth add to the response time; lost requests fail', async () => {
    const s = http.createServer((_q, r) => { r.end('x'.repeat(10_000)); });
    const port = await new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port)));
    try {
        const req = { ...newRequest('Page', 'page'), url: '/', checks: [] };
        const c = { baseUrl: `http://127.0.0.1:${port}`, auth: { type: 'none' as const } };
        const run = (wan?: { latencyMs?: number; bandwidthKbps?: number; lossPercent?: number }) => new LoadEngine({ scenario: sc({ policy: { type: 'constant', users: 1, duration: 1 }, ...(wan ? { wan } : {}) }), collection: c, requests: [req], values: V, rows: [] }).run();
        const plain = await run();
        const slow = await run({ latencyMs: 100, bandwidthKbps: 800 });   // 10 000 bytes at 800 kbit/s: 100 ms more
        const avg = (r: Awaited<ReturnType<typeof run>>) => r.transactions.find((t) => t.name === 'Page')!.avg;
        assert.ok(avg(slow) >= avg(plain) + 190, `${avg(plain)} → ${avg(slow)}`);
        const lossy = await run({ lossPercent: 100 });
        assert.ok(lossy.total.errors > 0 && lossy.total.errors === lossy.total.count, 'every request lost');
        assert.match(lossy.transactions[0].topErrors?.[0]?.message ?? JSON.stringify(lossy.transactions[0]), /WAN emulation: the request was lost/);
    } finally { s.close(); }
});
