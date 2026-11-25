import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { execFileSync } from 'child_process';
import { newScenario, checkSlas, LoadScenario } from '../src/load/scenario';
import { LoadEngine, UserPath } from '../src/load/engine';
import { mergeRuns } from '../src/load/merge';
import { loadReportHtml, loadReportXlsx } from '../src/load/report';
import { newRequest } from '../src/api/model';
import type { LoadRunDetail } from '../src/load/runs';

const sc = (p: Partial<LoadScenario>): LoadScenario => ({ ...newScenario('t', 'test/p/api/a.collection.json'), thinkTime: { min: 0, max: 0 }, slas: [], ...p });

test('arrival rate: iterations start evenly spaced (not in bursts), however the clock ticks', async () => {
    const starts: number[] = [];
    const path: UserPath = {
        async start() { return { async iteration(measure) { starts.push(performance.now()); await measure('x', 'X', async () => { await new Promise((r) => setTimeout(r, 5)); return null; }); }, async close() { /* */ } }; },
        async dispose() { /* */ },
    };
    const r = await new LoadEngine({ scenario: sc({ policy: { type: 'arrival', rate: 25, users: 20, duration: 2 } }), collection: { baseUrl: '', auth: { type: 'none' } }, requests: [], values: { vars: {}, config: {}, env: {} }, rows: [], userPath: path }).run();
    assert.ok(r.iterations >= 46 && r.iterations <= 51, `${r.iterations} iterations`);
    assert.equal(r.dropped, 0);
    assert.equal(r.due, r.iterations);
    // 25 per second: one every 40 ms. Bursts (several at once, then a gap) would give gaps near 0 and near 100 ms.
    const gaps = starts.slice(1).map((t, i) => t - starts[i]).slice(2);
    const close = gaps.filter((g) => Math.abs(g - 40) <= 12).length;
    assert.ok(close / gaps.length >= 0.9, `gaps ${gaps.map((g) => Math.round(g)).join(',')}`);
    assert.ok(Math.min(...gaps) >= 20, `the shortest gap is ${Math.min(...gaps).toFixed(1)} ms`);
});

test('dropped iterations as a service level: met, missed, and not applicable outside an arrival-rate run', async () => {
    const path = (ms: number): UserPath => ({
        async start() { return { async iteration(measure) { await measure('x', 'X', async () => { await new Promise((r) => setTimeout(r, ms)); return null; }); }, async close() { /* */ } }; },
        async dispose() { /* */ },
    });
    const run = (users: number, ms: number) => new LoadEngine({ scenario: sc({ policy: { type: 'arrival', rate: 20, users, duration: 1.5 }, slas: [{ target: '*', dropped: 5 }] }), collection: { baseUrl: '', auth: { type: 'none' } }, requests: [], values: { vars: {}, config: {}, env: {} }, rows: [], userPath: path(ms) }).run();
    const ok = await run(20, 10);
    assert.equal(ok.passed, true, JSON.stringify(ok.slas));
    assert.match(ok.slas[0].details[0], /^dropped 0 of \d+ iterations \(0\.00%\) ≤ 5%$/);
    const busy = await run(2, 400);
    assert.equal(busy.passed, false);
    assert.match(busy.slas[0].details[0], /^dropped \d+ of \d+ iterations \(\d+\.\d\d%\) > 5%$/);
    assert.equal((busy.dropped ?? 0) + busy.iterations, busy.due, 'every iteration that came due either ran or was dropped');
    // A closed model has no dropped iterations: the service level cannot be met.
    const closed = checkSlas([{ target: '*', dropped: 1 }], [], { errorRate: 0, avg: 1, p95: 1 });
    assert.deepEqual([closed[0].pass, closed[0].details], [false, ['dropped iterations: only an arrival-rate run has them']]);
});

test('where the time goes: DNS, connect, wait and download per transaction; kept-alive connections reconnect no more; merged by weight', async () => {
    const s = http.createServer((q, r) => {
        setTimeout(() => { r.writeHead(200, { 'Content-Type': 'text/plain' }); r.write('x'.repeat(2000)); setTimeout(() => r.end('y'), q.url === '/slow' ? 60 : 20); }, q.url === '/slow' ? 80 : 30);
    });
    await new Promise<void>((res) => s.listen(0, '127.0.0.1', () => res()));
    const port = (s.address() as { port: number }).port;
    try {
        const reqs = [{ ...newRequest('Fast', 'fast'), url: '/fast' }, { ...newRequest('Slow', 'slow'), url: '/slow' }];
        const r = await new LoadEngine({ scenario: sc({ policy: { type: 'constant', users: 2, duration: 1.5 } }), collection: { baseUrl: `http://localhost:${port}`, auth: { type: 'none' } }, requests: reqs, values: { vars: {}, config: {}, env: {} }, rows: [] }).run();
        const tx = Object.fromEntries(r.transactions.map((t) => [t.id, t]));
        for (const [id, wait, download] of [['fast', 30, 20], ['slow', 80, 60]] as const) {
            const p = tx[id].phases!;
            assert.ok(p, `${id}: no phases`);
            assert.equal(tx[id].phaseCount, tx[id].count);
            assert.ok(p.wait >= wait - 2 && p.wait <= wait + 25, `${id} wait ${p.wait}`);
            assert.ok(p.download >= download - 2 && p.download <= download + 25, `${id} download ${p.download}`);
            assert.equal(p.tls, 0, 'http: no TLS');
            // The phases add up to the measured time (the rest: checks, saved values).
            const sum = Object.values(p).reduce((a, b) => a + b, 0);
            assert.ok(sum <= tx[id].avg + 1 && sum >= tx[id].avg * 0.8, `${id}: phases ${sum} vs average ${tx[id].avg}`);
        }
        // Each user connects once (kept alive): connecting is a small share of the average.
        assert.ok(tx.fast.phases!.connect < 2, `connect ${tx.fast.phases!.connect}`);

        // Two parts merged: the phase averages weighted by each part's number of exchanges.
        const part = (n: number, wait: number, index: number) => ({ ...r, part: { index, of: 2 }, transactions: [{ ...tx.fast, count: n, phaseCount: n, phases: { ...tx.fast.phases!, wait } }], histograms: { total: r.histograms.total, tx: { fast: r.histograms.tx.fast } } });
        const detail = (x: ReturnType<typeof part>): LoadRunDetail => ({ id: 'a', scenario: 's', name: 'n', project: 'p', env: 'dev', startedAt: x.startedAt, state: 'finished', maxUsers: 2, duration: 1.5, definition: sc({}), result: x } as LoadRunDetail);
        const merged = mergeRuns([detail(part(30, 10, 0)), detail(part(10, 50, 1))]);
        const m = merged.result!.transactions.find((t) => t.id === 'fast')!;
        assert.equal(m.phaseCount, 40);
        assert.equal(m.phases!.wait, 20);
        // In the reports.
        const html = loadReportHtml(merged);
        assert.match(html, /<h2>Where the time goes<\/h2><table><tr><th>Transaction<\/th><th>Waiting for a connection<\/th>/);
        assert.match(html, /<td>Fast<\/td>(<td>[\d.]+<\/td>){5}<td>20<\/td>/);
        const sheets = execFileSync('python3', ['-c', 'import sys,zipfile,io; print(zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())).read("xl/workbook.xml").decode())'], { input: loadReportXlsx(merged) }).toString();
        assert.match(sheets, /name="Where the time goes"/);
    } finally { s.close(); }
});

test('the load generator overloaded during a run: the result says so', async () => {
    const block = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* busy */ } };
    const path: UserPath = {
        async start() { return { async iteration(measure) { await measure('x', 'X', async () => { block(150); await new Promise((r) => setTimeout(r, 5)); return null; }); }, async close() { /* */ } }; },
        async dispose() { /* */ },
    };
    const r = await new LoadEngine({ scenario: sc({ policy: { type: 'constant', users: 1, duration: 2.5 }, monitorEvery: 0.5 }), collection: { baseUrl: '', auth: { type: 'none' } }, requests: [], values: { vars: {}, config: {}, env: {} }, rows: [], userPath: path }).run();
    assert.match(r.overload ?? '', /The load generator was overloaded \(.*timers up to [\d.]+ ms late/);
});

test('each virtual user has its own connection, kept for its iteration and opened again at the next (a new visit)', async () => {
    let connections = 0;
    const perConnection = new Map<unknown, number>();
    const s = http.createServer((q, r) => { perConnection.set(q.socket, (perConnection.get(q.socket) ?? 0) + 1); r.writeHead(200, { 'Content-Type': 'text/plain' }); r.end('ok'); });
    s.on('connection', () => { connections++; });
    await new Promise<void>((res) => s.listen(0, '127.0.0.1', () => res()));
    const port = (s.address() as { port: number }).port;
    try {
        const reqs = ['a', 'b', 'c'].map((n) => ({ ...newRequest(n, n), url: `/${n}` }));
        const r = await new LoadEngine({ scenario: sc({ policy: { type: 'constant', users: 3, duration: 1 }, pacing: 100 }), collection: { baseUrl: `http://127.0.0.1:${port}`, auth: { type: 'none' } }, requests: reqs, values: { vars: {}, config: {}, env: {} }, rows: [] }).run();
        assert.ok(r.iterations >= 6, `${r.iterations} iterations`);
        // One connection per user per iteration (three requests on it), not one shared pool for every user.
        assert.ok(Math.abs(connections - r.iterations) <= 3, `${connections} connections for ${r.iterations} iterations`);
        assert.ok([...perConnection.values()].filter((n) => n === 3).length >= r.iterations - 3, JSON.stringify([...perConnection.values()]));
        // The connect time is now part of what each iteration measures.
        assert.ok((r.transactions.find((t) => t.id === 'a')!.phases!.connect) > 0);
        assert.equal(r.transactions.find((t) => t.id === 'b')!.phases!.connect, 0, 'the second request reuses the connection');
    } finally { s.close(); }
});
