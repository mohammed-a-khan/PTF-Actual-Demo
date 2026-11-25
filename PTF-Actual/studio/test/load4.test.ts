import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { monitorChecks, Monitors, parseSelector, promValue, validMonitor } from '../src/load/monitor';
import { LoadEngine, UserPath } from '../src/load/engine';
import { Histogram } from '../src/load/metrics';
import { mergeRuns } from '../src/load/merge';
import { LoadRuns, LoadRunDetail } from '../src/load/runs';
import { newScenario, validScenario, LoadScenario } from '../src/load/scenario';
import { wsAsResponse, wsExchange } from '../src/api/ws';
import { newCollection, newRequest, validCollection } from '../src/api/model';
import { toFeature } from '../src/api/feature';
import { exportCollection } from '../src/api/collectionExport';
import { CollectionRunner } from '../src/api/runner';

const sc = (p: Partial<LoadScenario>): LoadScenario => ({ ...newScenario('t', 'test/p/api/a.collection.json'), thinkTime: { min: 0, max: 0 }, slas: [], ...p });
const V = { vars: {}, config: {}, env: {} };
const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));

test('Prometheus text: selectors with labels, sums over series, comments and odd values', () => {
    const text = `# HELP http_requests_total Requests\n# TYPE http_requests_total counter\nhttp_requests_total{method="GET",status="200"} 1027\nhttp_requests_total{method="POST",status="500"} 3 1700000000000\nhttp_requests_total{method="GET",status="500"} 4\nnode_load1 0.42\nweird{a="x\\"y"} 7\nnan_metric NaN\n`;
    assert.equal(promValue(text, 'node_load1'), 0.42);
    assert.equal(promValue(text, 'http_requests_total'), 1034);
    assert.equal(promValue(text, 'http_requests_total{status="500"}'), 7);
    assert.equal(promValue(text, 'http_requests_total{status!="500", method="GET"}'), 1027);
    assert.equal(promValue(text, 'weird{a="x\\"y"}'), 7);
    assert.equal(promValue(text, 'nan_metric'), null);
    assert.equal(promValue(text, 'missing_metric'), null);
    assert.equal(parseSelector('bad metric'), null);
    assert.throws(() => promValue(text, 'a{b=c}'), /not a metric name/);
    assert.match(validMonitor({ name: 'x', kind: 'json', url: 'http://h/m' })!, /JSON path/);
    assert.equal(validMonitor({ name: 'x', kind: 'prometheus', url: '{config:METRICS_URL}', metric: 'up' }), null);
    assert.throws(() => validScenario({ ...newScenario('s', 'test/p/api/a.collection.json'), monitors: [{ name: 'x', kind: 'json', url: 'ftp://h' }] }), /monitor x: the URL/);
});

test('monitors: Prometheus counter as a rate, JSON value scaled, errors kept, maximum checked; the generator always', async () => {
    let n = 0;
    const s = http.createServer((req, res) => {
        n++;
        if (req.url === '/metrics') { res.end(`requests_total ${n * 100}\n`); return; }
        if (req.url === '/cpu') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ measurements: [{ value: 0.85 }] })); return; }
        res.statusCode = 503; res.end();
    });
    const port = await listen(s);
    try {
        const m = new Monitors([
            { name: 'Requests', kind: 'prometheus', url: `http://127.0.0.1:${port}/metrics`, metric: 'requests_total', rate: true, unit: '/s' },
            { name: 'App CPU', kind: 'json', url: '{config:BASE}/cpu', path: '$.measurements[0].value', scale: 100, unit: '%', max: 80 },
            { name: 'Down', kind: 'json', url: `http://127.0.0.1:${port}/nope`, path: '$.x' },
        ], { vars: {}, config: { BASE: `http://127.0.0.1:${port}` }, env: {} }, undefined);
        await m.sample(0); await m.sample(2);
        const [cpu, mem, delay, rq, app, down] = m.snapshot();
        assert.equal(delay.name, 'Load generator delay'); assert.equal(delay.unit, 'ms');
        assert.equal(cpu.name, 'Load generator CPU'); assert.equal(cpu.points.length, 2); assert.ok(mem.points[0].v > 0 && mem.points[0].v <= 100);
        assert.equal(rq.points.length, 1, 'a rate needs two samples'); assert.ok(rq.points[0].v > 0);
        assert.deepEqual(app.points.map((p) => p.v), [85, 85]);
        assert.equal(down.error, 'HTTP 503'); assert.equal(down.points.length, 0);
        assert.deepEqual(monitorChecks(m.snapshot()).map((c) => [c.name, c.pass, c.details[0]]), [['Monitor App CPU', false, 'highest 85 % > 80 %']]);
        m.close();
    } finally { s.close(); }
});

test('the load generator\'s own delay: a blocked event loop is measured and the run is flagged as overloaded', async () => {
    const block = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* busy */ } };
    const tick = () => new Promise((r) => setTimeout(r, 30));
    const quiet = new Monitors([], { vars: {}, config: {}, env: {} }, undefined);
    for (let i = 0; i < 3; i++) { await tick(); await quiet.sample(i); }
    assert.equal(quiet.overload(), null);
    quiet.close();

    const m = new Monitors([], { vars: {}, config: {}, env: {} }, undefined);
    await tick();
    for (let i = 0; i < 3; i++) { block(180); await tick(); await m.sample(i); }
    const delay = m.snapshot().find((x) => x.name === 'Load generator delay')!;
    assert.ok(delay.points.length >= 2 && delay.points.every((p) => p.v >= 100), JSON.stringify(delay.points));
    assert.match(m.overload() ?? '', /The load generator was overloaded \(.*timers up to \d+(\.\d)? ms late\)/);
    m.close();
});

const counting = (log: number[]): UserPath => ({
    async start(index) { log.push(index); return { async iteration(measure, pause) { await measure('x', 'X', async () => { await new Promise((r) => setTimeout(r, 2)); return null; }); await pause(); }, async close() { /* */ } }; },
    async dispose() { /* */ },
});

test('distributed: each part runs its share of the users with its own user numbers; merged results add up exactly', async () => {
    const runPart = async (index: number) => {
        const users: number[] = [];
        const r = await new LoadEngine({ scenario: sc({ policy: { type: 'constant', users: 7, duration: 1 }, slas: [{ target: '*', errorRate: 0 }] }), collection: { baseUrl: '', auth: { type: 'none' } }, requests: [], values: V, rows: [], userPath: counting(users), part: { index, of: 3 } }).run();
        return { users, r };
    };
    const parts = await Promise.all([0, 1, 2].map(runPart));
    assert.deepEqual(parts.map((p) => p.users.length), [3, 2, 2], '7 users in 3 parts');
    assert.deepEqual(parts.flatMap((p) => p.users).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6], 'user numbers do not overlap');
    assert.ok(parts.every((p) => p.r.histograms.total.count === p.r.total.count && p.r.part));
    const details = parts.map((p, i): LoadRunDetail => ({ id: `p${i}`, scenario: 'test/p/load/s.load.json', name: 'S', project: 'p', env: 'dev', startedAt: p.r.startedAt, state: 'finished', maxUsers: 7, duration: 1, definition: sc({ policy: { type: 'constant', users: 7, duration: 1 }, slas: [{ target: '*', errorRate: 0 }] }), result: p.r }));
    const m = mergeRuns(details);
    const sum = parts.reduce((n, p) => n + p.r.total.count, 0);
    assert.equal(m.result!.total.count, sum); assert.equal(m.result!.transactions[0].count, sum);
    const h = new Histogram(); for (const p of parts) h.merge(Histogram.load(p.r.histograms.total));
    assert.equal(m.result!.total.p95, Math.round(h.percentile(95) * 10) / 10);
    assert.equal(m.result!.iterations, parts.reduce((n, p) => n + p.r.iterations, 0));
    assert.ok(m.result!.timeline.some((s) => s.users === 7), 'users of the parts add up per second');
    assert.equal(m.result!.passed, true); assert.equal(m.message, 'Merged from 3 parts.');
    assert.throws(() => mergeRuns([details[0], details[0]]), /given twice/);
    assert.throws(() => mergeRuns([details[0], { ...details[1], name: 'Other' }]), /not of the same scenario/);
    // Imported into the Studio's runs like a local run.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-'));
    try {
        const runs = new LoadRuns(dir, 'nope.js');
        const info = runs.importRun(m);
        assert.equal(runs.list()[0].id, info.id); assert.equal(runs.get(info.id)!.result!.total.count, sum);
        assert.throws(() => runs.importRun({ name: 'x' } as unknown as LoadRunDetail), /not the results file/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** A small WebSocket server: answers "login" with a token and "order <token>" with an order id. */
function wsServer(): Promise<{ port: number; close: () => void; seen: { auth?: string } }> {
    const seen: { auth?: string } = {};
    const s = http.createServer();
    s.on('upgrade', (req, sock) => {
        seen.auth = req.headers.authorization;
        const key = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
        const out = (t: string) => { const b = Buffer.from(t); sock.write(Buffer.concat([Buffer.from(b.length < 126 ? [0x81, b.length] : [0x81, 126, b.length >> 8, b.length & 255]), b])); };
        let buf = Buffer.alloc(0);
        sock.on('data', (d: Buffer) => {
            buf = Buffer.concat([buf, d]);
            while (buf.length >= 6) {
                const op = buf[0] & 15; let len = buf[1] & 127, off = 2;
                if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
                if (buf.length < off + 4 + len) return;
                const mask = buf.subarray(off, off + 4); const data = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((x, i) => x ^ mask[i % 4]));
                buf = buf.subarray(off + 4 + len);
                if (op === 8) { sock.end(Buffer.from([0x88, 0])); return; }
                const t = data.toString();
                out(JSON.stringify({ type: 'ack', got: t }));
                if (t === 'login') out(JSON.stringify({ type: 'token', token: 'tk-42' }));
                if (t.startsWith('order ')) out(JSON.stringify({ type: 'order', id: t === 'order tk-42' ? 'ORD-1' : 'DENIED' }));
            }
        });
        sock.on('error', () => { /* client gone */ });
    });
    return listen(s).then((port) => ({ port, close: () => s.close(), seen }));
}

test('WebSocket: send, expect, save a value and use it; headers sent; failures say which step', async () => {
    const w = await wsServer();
    try {
        const steps = [{ kind: 'send' as const, text: 'login' }, { kind: 'expect' as const, text: '"token"', save: { path: '$.token', variable: 'tok' } }, { kind: 'send' as const, text: 'order {{tok}}' }, { kind: 'expect' as const, text: 'ORD-' }];
        const t0 = Date.now();
        const r = await wsExchange({ url: `http://127.0.0.1:${w.port}/ws`, headers: { Authorization: 'Bearer abc', 'Content-Type': 'x' } }, steps, V, 3000);
        assert.ok(Date.now() - t0 < 1000, `the exchange took ${Date.now() - t0} ms (connect must not wait for the timeout)`);
        assert.equal(r.error, undefined, r.error);
        assert.equal(w.seen.auth, 'Bearer abc');
        assert.deepEqual(r.saved, { tok: 'tk-42' });
        assert.deepEqual(r.steps.map((s) => s.pass), [true, true, true, true]);
        assert.ok(r.log.some((l) => l.dir === 'out' && l.text === 'order tk-42'));
        const shown = wsAsResponse(r, steps);
        assert.equal(shown.response.status, 101); assert.ok(shown.response.body.includes('→') && shown.checks.every((c) => c.pass));
        const bad = await wsExchange({ url: `ws://127.0.0.1:${w.port}/ws`, headers: {} }, [{ kind: 'send', text: 'hello' }, { kind: 'expect', text: 'never', timeoutMs: 300 }], V);
        assert.equal(bad.steps[1].pass, false); assert.match(bad.error!, /No message containing "never" within 300 ms/);
        assert.equal(wsAsResponse(bad, [{ kind: 'send', text: 'hello' }, { kind: 'expect', text: 'never' }]).checks[1].pass, false);
        const missing = await wsExchange({ url: `ws://127.0.0.1:${w.port}/ws`, headers: {} }, [{ kind: 'send', text: '{{nope}}' }], V);
        assert.match(missing.error!, /Not filled in: \{\{nope\}\}/);
        const refused = await wsExchange({ url: 'ws://127.0.0.1:1/ws', headers: {} }, [], V, 2000);
        assert.equal(refused.connected, false); assert.match(refused.error!, /Could not connect/);
        assert.match((await wsExchange({ url: 'ftp://x', headers: {} }, [], V)).error!, /ws:\/\/ or wss:\/\//);
    } finally { w.close(); }
});

test('WebSocket requests: in the collection runner and load tests; left out of features and exports', async () => {
    const w = await wsServer();
    try {
        const c = newCollection('WS');
        c.baseUrl = `http://127.0.0.1:${w.port}`;
        const req = { ...newRequest('Order over WS', 'ws1'), url: '/ws', checks: [], ws: { steps: [{ kind: 'send' as const, text: 'login' }, { kind: 'expect' as const, text: 'token', save: { path: '$.token', variable: 'tok' } }, { kind: 'send' as const, text: 'order {{tok}}' }, { kind: 'expect' as const, text: 'ORD-1' }] } };
        c.items.push(req);
        assert.doesNotThrow(() => validCollection(c));
        assert.throws(() => validCollection({ ...c, items: [{ ...req, ws: { steps: [{ kind: 'shout', text: 'x' }] } }] }), /WebSocket steps/);
        const runner = new CollectionRunner();
        const job = runner.start({ collection: c, file: 'test/p/api/ws.collection.json', project: 'p', env: 'dev', requests: [req], values: V, rows: [], iterations: 2, delayMs: 0, stopOnFailure: false, timeoutMs: 3000, mask: (t) => t });
        for (let i = 0; i < 100 && runner.get(job.id)!.state === 'running'; i++) await new Promise((r) => setTimeout(r, 20));
        const j = runner.get(job.id)!;
        assert.deepEqual(j.steps.map((s) => [s.method, s.status, s.passed]), [['WS', 101, true], ['WS', 101, true]]);
        const load = await new LoadEngine({ scenario: sc({ policy: { type: 'constant', users: 3, duration: 1 } }), collection: { baseUrl: c.baseUrl, auth: { type: 'none' } }, requests: [req], values: V, rows: [] }).run();
        assert.ok(load.total.count >= 3 && load.total.errors === 0, `${load.total.count} exchanges, ${load.total.errors} errors`);
        const f = toFeature(c);
        assert.ok(!f.text.includes('/ws') && f.warnings.some((x) => /WebSocket exchanges are not written/.test(x)));
        // A framework with WebSocket steps: the exchange as steps (connect, send, expect + save, close).
        const g = toFeature(c, { wsSteps: true });
        assert.ok(!g.warnings.some((x) => /WebSocket/.test(x)), g.warnings.join(' | '));
        const ws = g.text.split('\n').map((l) => l.trim()).filter((l) => /WebSocket/.test(l));
        assert.deepEqual(ws, [
            'When user connects to WebSocket "/ws"',
            'And user sends WebSocket message "login"',
            'Then user should receive a WebSocket message containing "token" within 30 seconds',
            'And user saves "$.token" of the WebSocket message as "tok"',
            'And user sends WebSocket message "order {{tok}}"',
            'And user should receive a WebSocket message containing "ORD-1" within 30 seconds',
            'And user closes the WebSocket',
        ]);
        assert.deepEqual((exportCollection(c) as { item: unknown[] }).item, []);
    } finally { w.close(); }
});
