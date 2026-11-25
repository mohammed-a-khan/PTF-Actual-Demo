/**
 * Distributed load tests: two load generator agents (each a worker thread here) run their parts of the users,
 * started together; the controller shows their numbers added up while running, their health and zones, and the
 * exact merged result at the end. A wrong token or a generator that cannot be reached stops the test before it starts.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { createAgent } from '../src/load/agent';
import { mergeLive, runDistributed } from '../src/load/controller';
import { validGenerator } from '../src/load/generators';
import { LoadRuns } from '../src/load/runs';
import { newScenario, validScenario } from '../src/load/scenario';
import { newRequest } from '../src/api/model';
import type { Snapshot } from '../src/load/engine';

const WORKER = ['worker.ts', 'worker.js'].map((f) => path.join(__dirname, '..', 'src', 'load', f)).find((f) => fs.existsSync(f))!;
const listen = (s: net.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));
const TOKEN = 'lab-agent-token-0123456789';

test('generator definitions: address, zone, token only as a reference', () => {
    assert.equal(validGenerator({ name: 'eu-1', url: 'https://gen1.lab:4720', zone: 'eu-west', token: '{env:LOADGEN_TOKEN}' }), null);
    assert.match(validGenerator({ name: 'eu-1', url: 'https://gen1.lab:4720', token: 'plain-secret' })!, /not the token itself/);
    assert.match(validGenerator({ name: 'eu-1', url: 'gen1:4720', token: '{env:X}' })!, /http\(s\):\/\/host:port/);
    assert.throws(() => validScenario({ ...newScenario('x', 'test/p/api/a.collection.json'), generators: [{ name: 'a', url: 'http://a:1', token: '{env:T}' }, { name: 'a', url: 'http://b:1', token: '{env:T}' }] }), /same name/);
    const s = (n: number, users: number, p95: number) => ({ state: 'running', elapsed: n, users, requests: 10, errors: 1, iterations: 5, timeline: [{ t: 0, users, requests: 10, errors: 1, avg: 50, p95 }], transactions: [], txTimeline: {}, populations: [], monitors: [{ name: 'CPU', unit: '%', points: [] }], alerts: [],
        total: { count: 10, errors: 1, errorRate: 10, avg: 50, p50: 40, p90: 60, p95, p99: p95, max: p95, throughput: 5 } }) as unknown as Snapshot;
    const m = mergeLive([{ name: 'eu', s: s(3, 4, 100) }, { name: 'us', s: s(4, 6, 300) }])!;
    assert.deepEqual([m.users, m.total.count, m.total.errorRate, m.total.p95, m.total.throughput, m.elapsed, m.timeline[0].users], [10, 20, 10, 300, 10, 4, 10]);
    assert.deepEqual(m.monitors.map((x) => x.name), ['CPU (eu)', 'CPU (us)']);
});

test('two generators run one test; live numbers added up; health and zones; merged result', { timeout: 60_000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-'));
    let hits = 0;
    const app = http.createServer((q, r) => { hits++; setTimeout(() => r.end('ok'), 5); });
    const appPort = await listen(app);
    const agents = [createAgent({ token: TOKEN, dir: path.join(tmp, 'a1'), workerFile: WORKER, zone: 'eu-west', version: 't' }), createAgent({ token: TOKEN, dir: path.join(tmp, 'a2'), workerFile: WORKER, zone: 'us-east', version: 't' })];
    const ports = await Promise.all(agents.map(listen));
    try {
        // The agent's own checks.
        const health = await fetch(`http://127.0.0.1:${ports[0]}/health`, { headers: { authorization: 'Bearer nope' } });
        assert.equal(health.status, 401);
        const h = await (await fetch(`http://127.0.0.1:${ports[0]}/health`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { busy: boolean; zone: string };
        assert.deepEqual([h.busy, h.zone], [false, 'eu-west']);
        assert.throws(() => createAgent({ token: 'short', dir: tmp, workerFile: WORKER }), /at least 16/);

        const sc = { ...newScenario('Spread', 'test/p/api/a.collection.json'), thinkTime: { min: 0, max: 0 }, slas: [{ target: '*', p95: 2000 }], policy: { type: 'constant' as const, users: 4, duration: 3 },
            generators: [{ name: 'gen-eu', url: `http://127.0.0.1:${ports[0]}`, zone: 'eu-west', token: '{env:LOADGEN_TOKEN}' }, { name: 'gen-us', url: `http://127.0.0.1:${ports[1]}`, zone: 'us-east', token: '{env:LOADGEN_TOKEN}' }] };
        validScenario(sc);
        const input = { scenario: sc, collection: { baseUrl: `http://127.0.0.1:${appPort}`, auth: { type: 'none' as const } }, requests: [{ ...newRequest('Home', 'home'), url: '/', checks: [] }], values: { vars: {}, config: {}, env: { LOADGEN_TOKEN: TOKEN } }, rows: [] };
        const runs = new LoadRuns(path.join(tmp, 'ctl'), WORKER);
        const lives: Snapshot[] = [];
        const info = runs.startDistributed({ scenarioFile: 'test/p/load/spread.load.json', project: 'p', env: 'qa', definition: sc,
            run: (cb) => runDistributed({ generators: sc.generators, scenarioFile: 'test/p/load/spread.load.json', project: 'p', env: 'qa', definition: sc, input, values: input.values, leadSeconds: 1, pollMs: 300 }, { live: (s) => { lives.push(s); cb.live(s); }, done: cb.done }) });
        let d = runs.get(info.id)!;
        for (let i = 0; i < 100 && d.state !== 'finished' && d.state !== 'error'; i++) { await new Promise((r) => setTimeout(r, 200)); d = runs.get(info.id)!; }
        assert.equal(d.state, 'finished', d.message);
        const r = d.result!;
        assert.deepEqual(d.generators!.map((g) => [g.name, g.zone, g.state]), [['gen-eu', 'eu-west', 'finished'], ['gen-us', 'us-east', 'finished']]);
        assert.ok(lives.some((s) => s.users === 4), `live users added up: ${lives.map((s) => s.users).join(',')}`);
        assert.equal(r.total.count, hits, 'every request of both generators is in the result');
        assert.ok(r.part === undefined && r.passed, JSON.stringify(r.slas));
        assert.ok(r.monitors.some((m) => /part 2/.test(m.name)), 'each generator\'s own CPU kept');
        // Stopped on both; then a wrong token and an unreachable generator stop the test before it starts.
        const bad = { ...input, values: { ...input.values, env: { LOADGEN_TOKEN: 'wrong-token-0123456789' } } };
        const r2 = await new Promise<string | undefined>((res) => runDistributed({ generators: sc.generators, scenarioFile: 'x', project: 'p', env: 'qa', definition: sc, input: bad, values: bad.values }, { live: () => {}, done: (_r, m) => res(m) }));
        assert.match(r2 ?? '', /Not started: gen-eu \(http:\/\/127\.0\.0\.1:\d+\) cannot be reached: the agent refused the token/);
        const gone = [{ name: 'gen-x', url: 'http://127.0.0.1:1', token: '{env:LOADGEN_TOKEN}' }];
        const r3 = await new Promise<string | undefined>((res) => runDistributed({ generators: gone, scenarioFile: 'x', project: 'p', env: 'qa', definition: sc, input, values: input.values }, { live: () => {}, done: (_r, m) => res(m) }));
        assert.match(r3 ?? '', /gen-x .* cannot be reached/);
        const noToken = await new Promise<string | undefined>((res) => runDistributed({ generators: sc.generators, scenarioFile: 'x', project: 'p', env: 'qa', definition: sc, input, values: { vars: {}, config: {}, env: {} } }, { live: () => {}, done: (_r, m) => res(m) }));
        assert.match(noToken ?? '', /its token is not set \(\{env:LOADGEN_TOKEN\}\)/);
    } finally { app.close(); agents.forEach((a) => a.close()); fs.rmSync(tmp, { recursive: true, force: true }); }
});
