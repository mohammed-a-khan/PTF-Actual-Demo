/**
 * API and Performance, round 5: two tabs saving the same mock (409, Overwrite forces it); whole numbers refused when
 * they are not whole (mocks, load scenarios, runner, monitors, request settings) with the reason, never rounded;
 * a bad scenario link said without this computer's paths; comparisons paired by the request, not its name, and a
 * request that fails every time not "the same"; the compare arrow follows the number.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createServer } from '../src/server/server';
import { SecretStore } from '../src/secrets/store';
import { KeyFileProtector } from '../src/secrets/protector';
import { runGit } from '../src/git/run';
import { newCollection, newRequest } from '../src/api/model';
import { newScenario } from '../src/load/scenario';
import { validPolicy } from '../src/load/policy';
import { mockProblems } from '../src/api/mock';
import { compareRuns as compareApiRuns, type RunnerJob } from '../src/api/runner';
import { compareRuns as compareLoadRuns } from '../src/load/explain';
import { verdictText } from '../src/load/reportDocs';
import type { RunResult } from '../src/load/engine';

async function studio() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-apiperf5-'));
    const dir = path.join(tmp, 'repo');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    const w = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
    w('config/shop/common/common.env', 'PROJECT_NAME=shop\n');
    w('config/shop/environments/qa.env', 'ENVIRONMENT=qa\n');
    const c = { ...newCollection('Orders'), baseUrl: 'http://127.0.0.1:9', items: [{ ...newRequest('List'), id: 'r1', url: '/orders' }] };
    w('test/shop/api/orders.collection.json', JSON.stringify(c, null, 2) + '\n');
    w('test/shop/load/orders.load.json', JSON.stringify(newScenario('Orders load', 'test/shop/api/orders.collection.json'), null, 2) + '\n');
    w('test/shop/mocks/pets.mock.json', JSON.stringify({ name: 'Pets', port: 0, routes: [{ method: 'GET', path: '/pets', status: 200, body: [] }] }, null, 2) + '\n');
    const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
    const srv = createServer({ repoRoot: dir, store, userName: 'T', projectId: 'repo' });
    const headers = { authorization: `Bearer ${srv.token}` };
    const call = async (method: 'GET' | 'PUT' | 'POST', url: string, payload?: object) => { const r = await srv.app.inject({ method, url, headers, ...(payload ? { payload } : {}) }); return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : undefined }; };
    return { dir, tmp, call, close: async () => { await srv.app.close(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

test('mock: tab B saving over tab A\'s save gets 409; Overwrite forces it; the version is not written into the file', async () => {
    const s = await studio();
    try {
        const file = 'test/shop/mocks/pets.mock.json';
        const q = `/api/mocks/file?project=shop&file=${encodeURIComponent(file)}`;
        const a = await s.call('GET', q), b = await s.call('GET', q);
        assert.equal(a.status, 200);
        assert.match(a.json.version, /^[0-9a-f]{16}$/);
        const sa = await s.call('PUT', '/api/mocks/file', { project: 'shop', file, mock: { ...a.json.mock, port: 47394, $studio: { base: a.json.version } } });
        assert.equal(sa.status, 200, JSON.stringify(sa.json));
        assert.ok(sa.json.version && sa.json.version !== a.json.version);
        assert.ok(!fs.readFileSync(path.join(s.dir, file), 'utf8').includes('$studio'));
        const sb = await s.call('PUT', '/api/mocks/file', { project: 'shop', file, mock: { ...b.json.mock, port: 47395, $studio: { base: b.json.version } } });
        assert.equal(sb.status, 409);
        assert.equal(sb.json.error, 'Changed in another tab or by someone else');
        assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, file), 'utf8')).port, 47394, 'A\'s change is kept');
        const sb2 = await s.call('PUT', '/api/mocks/file', { project: 'shop', file, mock: { ...b.json.mock, port: 47395, $studio: { base: b.json.version, force: true } } });
        assert.equal(sb2.status, 200);
        assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, file), 'utf8')).port, 47395);
        // A mock that is not there: 404 in words.
        const gone = await s.call('GET', `/api/mocks/file?project=shop&file=${encodeURIComponent('test/shop/mocks/nope.mock.json')}`);
        assert.equal(gone.status, 404);
        assert.doesNotMatch(gone.json.error, /ENOENT|\/tmp\//);
    } finally { await s.close(); }
});

test('mock numbers: a decimal port or delay is refused with the reason (not "0–65535")', async () => {
    const r = (patch: object, route: object = {}) => mockProblems({ name: 'x', routes: [{ method: 'GET', path: '/a', status: 200, ...route }], ...patch } as never);
    assert.deepEqual(r({ port: 47393 }), []);
    assert.match(r({ port: 47393.5 }).join(' '), /Port: a whole number from 0 to 65535, not a decimal/);
    assert.match(r({}, { delayMs: 2.5 }).join(' '), /delay \(ms\) is a whole number/);
    assert.match(r({}, { fault: { kind: 'delay', delayMs: 10.5 } }).join(' '), /fault's delay/);
    assert.match(r({}, { fault: { kind: 'error', rate: 50.5 } }).join(' '), /share of requests/);
    const s = await studio();
    try {
        const file = 'test/shop/mocks/pets.mock.json';
        const a = await s.call('GET', `/api/mocks/file?project=shop&file=${encodeURIComponent(file)}`);
        const bad = await s.call('PUT', '/api/mocks/file', { project: 'shop', file, mock: { ...a.json.mock, routes: [{ ...a.json.mock.routes[0], delayMs: 2.5 }] } });
        assert.equal(bad.status, 400);
        assert.match(bad.json.error, /whole number/);
    } finally { await s.close(); }
});

test('load scenario numbers: 2.5 users or 4.5 s is refused (said), not saved and rounded; a bad link is a 404 without paths', async () => {
    assert.match(validPolicy({ type: 'constant', users: 2.5, duration: 10 }) ?? '', /Users: a whole number \(not 2\.5\)/);
    assert.match(validPolicy({ type: 'constant', users: 2, duration: 4.5 }) ?? '', /Run for \(seconds\): a whole number/);
    assert.equal(validPolicy({ type: 'arrival', users: 5, duration: 10, rate: 0.5 }), null, 'a rate may have decimals');
    const s = await studio();
    try {
        const file = 'test/shop/load/orders.load.json';
        const a = await s.call('GET', `/api/load/scenario?file=${encodeURIComponent(file)}`);
        const before = fs.readFileSync(path.join(s.dir, file), 'utf8');
        for (const sc of [
            { ...a.json.scenario, policy: { ...a.json.scenario.policy, users: 2.5 } },
            { ...a.json.scenario, timeout: 2.5 },
            { ...a.json.scenario, thinkTime: { min: 0.5, max: 1 } },
        ]) {
            const r = await s.call('PUT', '/api/load/scenario', { project: 'shop', file, scenario: sc });
            assert.equal(r.status, 400, JSON.stringify(sc));
        }
        assert.equal(fs.readFileSync(path.join(s.dir, file), 'utf8'), before, 'nothing written');
        const nope = await s.call('GET', `/api/load/scenario?file=${encodeURIComponent('test/shop/load/nope.load.json')}`);
        assert.equal(nope.status, 404);
        assert.match(nope.json.error, /There is no load scenario test\/shop\/load\/nope\.load\.json/);
        assert.doesNotMatch(nope.json.error, /ENOENT|open '|\/tmp\//);
    } finally { await s.close(); }
});

test('runner, monitors, pipeline and request settings refuse decimals instead of rounding', async () => {
    const s = await studio();
    try {
        const coll = JSON.parse(fs.readFileSync(path.join(s.dir, 'test/shop/api/orders.collection.json'), 'utf8'));
        const run = await s.call('POST', '/api/apiws/runs', { project: 'shop', env: 'qa', file: 'test/shop/api/orders.collection.json', collection: coll, iterations: 2.5, delayMs: 0, stopOnFailure: false });
        assert.equal(run.status, 400);
        assert.equal(run.json.error, 'Iterations: a whole number from 1 to 1000 (no decimals).');
        const mon = await s.call('PUT', '/api/apiws/monitors', { name: 'M', file: 'test/shop/api/orders.collection.json', env: 'qa', everyMinutes: 7.5, enabled: false, alertOn: 'failure' });
        assert.equal(mon.status, 400);
        assert.match(mon.json.error, /Every \(minutes\): a whole number from 5 to 10080 \(no decimals\)/);
        const pipe = await s.call('POST', '/api/load/pipeline', { file: 'test/shop/load/orders.load.json', generators: 2.5 });
        assert.equal(pipe.status, 400);
        assert.match(pipe.json.error, /Load generators: a whole number from 1 to 50/);
        const withDelay = { ...coll, items: [{ ...coll.items[0], settings: { retries: 1, retryDelayMs: 100.5 } }] };
        const save = await s.call('PUT', '/api/apiws/collection', { project: 'shop', file: 'test/shop/api/orders.collection.json', collection: withDelay });
        assert.equal(save.status, 400);
        assert.match(save.json.error, /retry delay is a whole number/);
    } finally { await s.close(); }
});

const step = (iteration: number, requestId: string, url: string, passed: boolean) => ({ iteration, requestId, name: 'New request', method: 'GET', url, status: passed ? 200 : undefined, timeMs: 1, passed, checks: [] });
const job = (id: string, steps: ReturnType<typeof step>[]) => ({ id, name: 'C', env: 'qa', startedAt: '2026-11-25T00:00:00Z', summary: { requests: steps.length, passed: 0, failed: 0, checks: 0, checksPassed: 0, avgMs: 1 }, steps } as unknown as RunnerJob);

test('runner comparison: two requests with the same name are paired by request, and told apart by place and URL', () => {
    const a = job('a', [step(1, 'r1', 'http://127.0.0.1:47391/hello', false), step(1, 'r2', 'http://127.0.0.1:47398/hello', true)]);
    const b = job('b', [step(1, 'r1', 'http://127.0.0.1:47391/hello', true), step(1, 'r2', 'http://127.0.0.1:47398/hello', false)]);
    const c = compareApiRuns(a, b);
    const r1 = c.rows.find((r) => r.requestId === 'r1')!, r2 = c.rows.find((r) => r.requestId === 'r2')!;
    assert.equal(r1.change, 'fixed');
    assert.equal(r2.change, 'broke');
    assert.equal(r1.position, 1); assert.equal(r2.position, 2);
    assert.match(r1.url!, /47391/); assert.match(r2.url!, /47398/);
});

function loadRun(tx: Array<{ id: string; name: string; p95: number; errorRate: number }>, throughput = 100): RunResult {
    const total = { count: 1000, errors: 0, errorRate: 0, avg: 50, p50: 40, p90: 80, p95: 100, p99: 150, max: 300, throughput };
    return { elapsed: 60, timeline: [], total, passed: true,
        transactions: tx.map((t) => ({ ...t, count: 100, errors: Math.round(t.errorRate), avg: t.p95 / 2, min: 1, max: t.p95 * 2, p50: t.p95 / 2, p90: t.p95, p99: t.p95, throughput: 10, topErrors: [] })) } as unknown as RunResult;
}

test('load comparison: transactions paired by id (2 named alike stay 2); one failing every time is worse, not "same"', () => {
    const a = loadRun([{ id: 'r1', name: 'New request', p95: 10, errorRate: 0 }, { id: 'r2', name: 'New request', p95: 10, errorRate: 0 }]);
    const b = loadRun([{ id: 'r1', name: 'New request', p95: 11, errorRate: 0 }, { id: 'r2', name: 'New request', p95: 2, errorRate: 100 }], 120);
    const c = compareLoadRuns(a, b, { a: 'A', b: 'B' });
    assert.equal(c.transactions.length, 2);
    assert.equal(c.transactions.find((t) => t.id === 'r1')!.verdict, 'same');
    const bad = c.transactions.find((t) => t.id === 'r2')!;
    assert.equal(bad.verdict, 'worse');
    assert.match(bad.why ?? '', /errors 0\.0% → 100%/);
    // Throughput +20% is better, and it went up: ▲ better.
    // Failing every time in both runs: "fails in both runs", not "≈ same".
    const both = compareLoadRuns(b, b, { a: 'B', b: 'B2' }).transactions.find((t) => t.id === 'r2')!;
    assert.equal(both.verdict, 'failing');
    assert.match(both.why ?? '', /fails in both runs: 100% errors/);
    const thr = c.metrics.find((m) => m.label === 'Throughput')!;
    assert.equal(thr.verdict, 'better');
    assert.equal(verdictText(thr.verdict, thr.change), '▲ better');
    assert.equal(verdictText('worse', '-30%'), '▼ worse');
    assert.equal(verdictText('same', '+2%'), '≈ same');
});
