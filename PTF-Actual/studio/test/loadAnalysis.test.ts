/**
 * Analysis of load runs: exact statistics over a range (without ramp-up / ramp-down), the steady part, monitors
 * against response times, runs on one time axis, a baseline and the regression gate, distributed parts merged
 * exactly per interval.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { correlateMonitors, overlay, pearson, rangeStats, regression, steadyRange, validGate } from '../src/load/analysis';
import { RunMetrics } from '../src/load/metrics';
import { LoadEngine, RunResult } from '../src/load/engine';
import { LoadRuns } from '../src/load/runs';
import { mergeRuns } from '../src/load/merge';
import { newScenario, validScenario } from '../src/load/scenario';
import { newRequest } from '../src/api/model';

/** Metrics of a run: response time `ms(t)` for 10 requests a second over `secs` seconds. */
function metricsOf(secs: number, ms: (t: number) => number, window = 5) {
    const m = new RunMetrics(0, window);
    for (let t = 0; t < secs * 1000; t += 100) m.record('a', 'A', ms(t), null, t, 1);
    m.finish();
    return m;
}

test('range statistics are exact (the intervals\' histograms) and leave out the ramp', () => {
    // A slow start (first 5 s), then steady at 100 ms.
    const m = metricsOf(20, (t) => (t < 5000 ? 900 : 100 + (t % 7)));
    const all = rangeStats(m.intervals, 0, 20, { a: 'Pay' });
    const steady = rangeStats(m.intervals, 5, 20, { a: 'Pay' });
    assert.equal(all.exact, true);
    assert.deepEqual([all.intervals, all.total.count, steady.intervals, steady.total.count, steady.seconds], [4, 200, 3, 150, 15]);
    assert.ok(all.total.p95 >= 890 && steady.total.p95 < 110, `${all.total.p95} / ${steady.total.p95}`);
    assert.equal(steady.tx[0].name, 'Pay');
    assert.equal(steady.total.throughput, 10);
    // The range snaps to whole intervals inside it.
    assert.deepEqual([rangeStats(m.intervals, 3, 17).from, rangeStats(m.intervals, 3, 17).to], [5, 15]);
});

test('steady part, correlation, overlay, gate definitions', () => {
    const timeline = Array.from({ length: 30 }, (_, t) => ({ t, users: Math.min(10, t + 1, 30 - t), requests: 10, errors: 0, avg: 100, p95: 100 + t * 3 }));
    const intervals = Array.from({ length: 6 }, (_, k) => ({ t0: k * 5, t1: k * 5 + 5 })) as never;
    assert.deepEqual(steadyRange({ timeline, intervals }), { from: 10, to: 20 });
    assert.equal(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1);
    const monitors = [
        { name: 'DB CPU', unit: '%', points: timeline.map((s) => ({ t: s.t + 0.2, v: 20 + s.t * 2 })) },
        { name: 'Disk', unit: '%', points: timeline.map((s) => ({ t: s.t, v: 50 + ((s.t * 7) % 3) })) },
        { name: 'Few', unit: '', points: [{ t: 1, v: 1 }] },
    ];
    const c = correlateMonitors({ timeline, monitors } as never);
    assert.deepEqual(c.map((x) => [x.monitor, x.strength]), [['DB CPU', 'strong'], ['Disk', c[1].strength]]);
    assert.equal(c[0].r, 1);
    assert.ok(Math.abs(c[1].r) < 0.4);
    const o = overlay([{ id: 'x', label: 'X', result: { timeline } }, { id: 'y', label: 'Y', result: { timeline: timeline.slice(0, 3) } }], 'users');
    assert.deepEqual(o.map((s) => [s.id, s.points.length, s.points[2].v]), [['x', 30, 3], ['y', 3, 3]]);
    assert.match(validGate({})!, /at least one limit/);
    assert.equal(validGate({ p95Percent: 10 }), null);
    assert.throws(() => validScenario({ ...newScenario('x', 'test/p/api/a.collection.json'), regression: { p95Percent: -1 } }), /regression gate's p95Percent/);
});

test('a baseline run and the regression gate; parts of a distributed run merged exactly per interval', async () => {
    let slow = false;
    const app = http.createServer((q, r) => setTimeout(() => r.end('ok'), slow ? 60 : 5));
    const port = await new Promise<number>((res) => app.listen(0, '127.0.0.1', () => res((app.address() as net.AddressInfo).port)));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-'));
    try {
        const sc = { ...newScenario('Shop', 'test/p/api/a.collection.json'), thinkTime: { min: 0, max: 0 }, slas: [], slaInterval: 1, policy: { type: 'constant' as const, users: 2, duration: 3 }, regression: { p95Percent: 50, errorRatePoints: 1 } };
        const run = () => new LoadEngine({ scenario: sc, collection: { baseUrl: `http://127.0.0.1:${port}`, auth: { type: 'none' } }, requests: [{ ...newRequest('Home', 'home'), url: '/', checks: [] }], values: { vars: {}, config: {}, env: {} }, rows: [] }).run();
        const base = await run();
        slow = true;
        const now = await run();
        const g = regression(now, base, sc.regression);
        assert.equal(g.pass, false);
        assert.match(g.details.join(' '), /All requests: p95 [\d.]+ → [\d.]+ ms \(\+\d+% > 50%\)/);
        assert.equal(regression(base, base, sc.regression).pass, true);
        // Kept runs: a baseline per scenario.
        const runs = new LoadRuns(dir, 'unused');
        const detail = (r: RunResult) => ({ scenario: 'test/p/load/shop.load.json', name: 'Shop', project: 'p', env: 'dev', startedAt: r.startedAt, maxUsers: 2, duration: 3, definition: sc, result: r }) as never;
        const a = runs.importRun(detail(base));
        assert.throws(() => runs.setBaseline('nope', true), /finished run/);
        runs.setBaseline(a.id, true);
        assert.equal(runs.baselineOf('test/p/load/shop.load.json'), a.id);
        assert.deepEqual(runs.list().map((x) => [x.id, x.baseline ?? false]), [[a.id, true]]);
        runs.setBaseline(a.id, false);
        assert.equal(runs.baselineOf('test/p/load/shop.load.json'), null);
        // Two parts of one run: the merged interval percentiles are those of all the requests together.
        const p1 = { ...base, part: { index: 0, of: 2 } }, p2 = { ...now, part: { index: 1, of: 2 } };
        const merged = mergeRuns([detail(p1), detail(p2)] as never) as unknown as { result: RunResult };
        const i0 = merged.result.intervals!.find((i) => i.t0 === 1)!;
        const fast = base.intervals!.find((i) => i.t0 === 1)!, slowI = now.intervals!.find((i) => i.t0 === 1)!;
        assert.equal(i0.total.count, fast.total.count + slowI.total.count);
        assert.ok(i0.total.p95 >= Math.min(fast.total.p95, slowI.total.p95) && i0.total.p95 <= Math.max(fast.total.p95, slowI.total.p95));
        assert.ok(i0.h, 'histograms kept for later analysis');
    } finally { app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
