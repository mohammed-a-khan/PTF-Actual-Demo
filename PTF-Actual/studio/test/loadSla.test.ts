/**
 * Service levels: p90 / p95 / p99 / average / errors / throughput, a warning level besides the failing one, checked
 * over the run or over every interval (exact interval percentiles; an interval failing raises an alert while
 * running), reusable profiles (load/sla/*.sla.json).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { RunMetrics } from '../src/load/metrics';
import { checkSlas, intervalBreaches, newScenario, Sla, validScenario, validSla, validSlaProfile } from '../src/load/scenario';
import { applySlaProfile } from '../src/load/prepare';
import { LoadEngine } from '../src/load/engine';
import { newRequest } from '../src/api/model';

test('levels: warning and failing levels, throughput at least, p90 / p99; checked definitions', () => {
    const total = { count: 1000, errorRate: 0.5, avg: 300, p90: 600, p95: 800, p99: 1500, throughput: 40 };
    const [a, b, c] = checkSlas([
        { target: '*', p95: 1000, warn: { p95: 700 } },
        { target: '*', p99: 1200, errorRate: 1, throughput: 30, warn: { throughput: 50 } },
        { target: '*', p90: 700, avg: 400, throughput: 20 },
    ], [], total);
    assert.deepEqual([a.level, a.pass, a.details], ['warning', true, ['p95 800 ms > 700 ms (warning)']]);
    assert.deepEqual([b.level, b.pass], ['fail', false]);
    assert.deepEqual(b.details, ['p99 1500 ms > 1200 ms', 'errors 0.50% ≤ 1%', 'throughput 40.0/s < 50/s (warning)']);
    assert.deepEqual([c.level, c.details], ['pass', ['average 300 ms ≤ 400 ms', 'p90 600 ms ≤ 700 ms', 'throughput 40.0/s ≥ 20/s']]);
    assert.match(validSla({ target: '*', p95: 500, warn: { p95: 900 } })!, /warning p95 is beyond/);
    assert.match(validSla({ target: '*', throughput: 50, warn: { throughput: 20 } })!, /warning throughput is beyond/);
    assert.match(validSla({ target: '*', per: 'minute' as never })!, /per run or per interval/);
    assert.throws(() => validScenario({ ...newScenario('x', 'test/p/api/a.collection.json'), slaProfile: '../x.sla.json' }), /service-level profile/);
    assert.throws(() => validSlaProfile({ format: 'cs-studio-sla/1', name: 'x', slas: [{ target: '*', p95: -1 }] }), /p95 is a number/);
});

test('intervals: exact percentiles per interval; a level per interval fails where an interval misses it', () => {
    const intervals: Array<{ t0: number; t1: number }> = [];
    const m = new RunMetrics(0, 2, (i) => intervals.push(i));
    // 0–2 s fast; 2–4 s slow; 4–5 s (half an interval) fast.
    for (let t = 0; t < 5000; t += 10) m.record('pay', 'Pay', t >= 2000 && t < 4000 ? 900 + (t % 100) : 100 + (t % 50), t >= 2000 && t < 2100 ? 'HTTP 500' : null, t, 3);
    m.finish();
    assert.deepEqual(m.intervals.map((i) => [i.t0, i.t1, i.total.count]), [[0, 2, 200], [2, 4, 200], [4, 5, 100]]);
    assert.equal(intervals.length, 3, 'each interval is reported when it closes');
    assert.ok(m.intervals[1].tx.pay.p95 >= 990 && m.intervals[0].tx.pay.p95 < 160, JSON.stringify(m.intervals.map((i) => i.tx.pay.p95)));
    assert.equal(m.intervals[1].total.errorRate, 5);
    assert.equal(m.intervals[0].total.throughput, 100);
    const slas: Sla[] = [{ target: 'pay', p95: 500, warn: { p95: 140 }, per: 'interval' }, { target: '*', errorRate: 2, per: 'interval' }];
    const [p, e] = checkSlas(slas, [{ id: 'pay', name: 'Pay', count: 500, errorRate: 2, avg: 400, p95: 990 }], { count: 500, errorRate: 2, avg: 400, p95: 990 }, { intervals: m.intervals });
    assert.equal(p.level, 'fail');
    assert.deepEqual(p.intervals!.map((i) => [i.t0, i.level]), [[0, 'warning'], [2, 'fail'], [4, 'warning']].filter(([t]) => t === 2 || m.intervals.find((i) => i.t0 === t)!.tx.pay.p95 > 140));
    assert.match(p.details[0], /of 3 intervals met it; 1 failed/);
    assert.deepEqual([e.level, e.intervals!.map((i) => i.t0)], ['fail', [2]]);
    const br = intervalBreaches(slas, m.intervals[1], () => 'Pay').map((b) => [b.level, b.message]);
    assert.equal(br.length, 2);
    assert.match(br[0][1], /^Pay at 2–4 s: p95 99\d(\.\d)? ms > 500 ms$/);
    assert.deepEqual(br[1], ['fail', 'All requests at 2–4 s: errors 5.00% > 2%']);
});

test('a profile adds its levels; under load an interval failing raises a critical alert and fails the run', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sla-'));
    try {
        fs.mkdirSync(path.join(repo, 'test/p/load/sla'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'test/p/load/sla/web.sla.json'), JSON.stringify({ format: 'cs-studio-sla/1', name: 'Web', interval: 1, slas: [{ target: '*', p95: 150, per: 'interval' }, { target: '*', errorRate: 5 }] }));
        const sc = applySlaProfile(repo, { ...newScenario('Shop', 'test/p/api/a.collection.json'), slaProfile: 'test/p/load/sla/web.sla.json', slas: [{ target: 'home', avg: 1000 }] });
        assert.deepEqual([sc.slas.length, sc.slaInterval], [3, 1]);
        assert.throws(() => applySlaProfile(repo, { ...sc, slaProfile: 'test/p/load/sla/none.sla.json' }), /does not exist/);
        let started = 0;
        const app = http.createServer((q, r) => { if (!started) started = Date.now(); setTimeout(() => r.end('ok'), Date.now() - started > 1500 ? 250 : 5); });
        const port = await new Promise<number>((res) => app.listen(0, '127.0.0.1', () => res((app.address() as net.AddressInfo).port)));
        try {
            const r = await new LoadEngine({ scenario: { ...sc, thinkTime: { min: 0, max: 0 }, policy: { type: 'constant', users: 2, duration: 4 } },
                collection: { baseUrl: `http://127.0.0.1:${port}`, auth: { type: 'none' } }, requests: [{ ...newRequest('Home', 'home'), url: '/', checks: [] }], values: { vars: {}, config: {}, env: {} }, rows: [] }).run();
            const interval = r.slas.find((s) => s.sla.per === 'interval')!;
            assert.equal(interval.level, 'fail');
            assert.ok(interval.intervals!.every((i) => i.t0 >= 1), JSON.stringify(interval.intervals));
            assert.equal(r.slas.find((s) => s.sla.errorRate !== undefined)!.level, 'pass');
            assert.equal(r.passed, false);
            const crit = r.alerts.filter((a) => a.source === 'sla:*' && a.level === 'critical');
            assert.ok(crit.length >= 1 && /All requests at \d+–\d+ s: p95 [\d.]+ ms > 150 ms/.test(crit[0].message), JSON.stringify(r.alerts));
            assert.ok((r.intervals ?? []).length >= 3);
        } finally { app.close(); }
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
