/**
 * API and Performance, round 6: a bad collection link is a 404 in words (no paths, no ENOENT); requests with the same
 * name numbered in collection order in comparisons, reports, service levels and JUnit (testcase names unique); one
 * better / worse / same rule; the report's per-second line over the whole run; an empty address said in words.
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
import { newScenario, checkSlas } from '../src/load/scenario';
import { compareRuns as compareApiRuns, runnerJUnit, runnerReport, type RunnerJob } from '../src/api/runner';
import { compareRuns as compareLoadRuns } from '../src/load/explain';
import { loadReportHtml } from '../src/load/report';
import { changeVerdict, timeTicks } from '../src/load/labels';
import { send } from '../src/api/send';
import type { RunResult } from '../src/load/engine';
import type { LoadRunDetail } from '../src/load/runs';

async function studio() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-apiperf6-'));
    const dir = path.join(tmp, 'repo');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    const w = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
    w('config/shop/common/common.env', 'PROJECT_NAME=shop\n');
    w('config/shop/environments/qa.env', 'ENVIRONMENT=qa\n');
    const c = { ...newCollection('Orders'), baseUrl: 'http://127.0.0.1:9', items: [{ ...newRequest('List'), id: 'r1', url: '/orders' }] };
    w('test/shop/api/orders.collection.json', JSON.stringify(c, null, 2) + '\n');
    w('test/shop/api/broken.collection.json', '{ not json');
    const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
    const srv = createServer({ repoRoot: dir, store, userName: 'T', projectId: 'repo' });
    const headers = { authorization: `Bearer ${srv.token}` };
    const call = async (url: string) => { const r = await srv.app.inject({ method: 'GET', url, headers }); return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : undefined }; };
    return { tmp, call, close: async () => { await srv.app.close(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

test('a bad collection link is a 404 in words, without this computer\'s paths; a good one opens', async () => {
    const s = await studio();
    try {
        const q = (f: string) => `/api/apiws/collection?file=${encodeURIComponent(f)}`;
        const gone = await s.call(q('test/shop/api/nope.collection.json'));
        assert.equal(gone.status, 404);
        assert.match(gone.json.error, /There is no API collection test\/shop\/api\/nope\.collection\.json/);
        assert.doesNotMatch(gone.json.error, /ENOENT|open '|\/tmp\/|cs-apiperf6/);
        const broken = await s.call(q('test/shop/api/broken.collection.json'));
        assert.equal(broken.status, 400);
        assert.doesNotMatch(broken.json.error, /\/tmp\/|cs-apiperf6/);
        const ok = await s.call(q('test/shop/api/orders.collection.json'));
        assert.equal(ok.status, 200);
        assert.equal(ok.json.collection.name, 'Orders');
        assert.equal((await s.call(q('../etc/passwd'))).status, 400);
    } finally { await s.close(); }
});

function loadRun(tx: Array<{ id: string; name: string; p95: number; errorRate: number; count?: number }>): RunResult {
    const total = { count: 6, errors: 2, errorRate: 33.3, avg: 8, p50: 2, p90: 19, p95: 19.3, p99: 19.3, max: 19.3, throughput: 1.2 };
    const timeline = [0, 1, 2, 3, 4, 5].map((t) => ({ t, users: 2, requests: t % 2 ? 0 : 2, errors: 0, avg: 5, p95: 8 }));
    return { elapsed: 5.1, timeline, total, passed: false, slas: [], alerts: [], populations: [{ name: 'Main', share: 100, users: 2 }], monitors: [], iterations: 4, users: 0, startedAt: '2026-11-25T13:27:38Z', endedAt: '2026-11-25T13:27:43Z', stopReason: 'completed',
        txTimeline: { r1: [{ t: 0, n: 2, e: 0, avg: 19, p95: 19 }, { t: 3, n: 2, e: 0, avg: 4, p95: 7 }], r2: [{ t: 1, n: 2, e: 2, avg: 1.6, p95: 1.9 }] },
        transactions: tx.map((t) => ({ ...t, count: t.count ?? 4, errors: Math.round((t.errorRate / 100) * (t.count ?? 4)), avg: t.p95 / 2, min: 1, max: t.p95 * 2, p50: t.p95 / 2, p90: t.p95, p99: t.p95, throughput: (t.count ?? 4) / 5.1, topErrors: t.errorRate ? [{ message: 'refused', count: 2, samples: [] }] : [], ...(t.errorRate ? {} : { phases: { blocked: 2.66, dns: 0, connect: 1.64, tls: 0, send: 0.16, wait: 3.05, download: 0.55 }, phaseCount: 4 }) })) } as unknown as RunResult;
}
const qa3 = () => loadRun([{ id: 'r1', name: 'New request', p95: 19.3, errorRate: 0 }, { id: 'r2', name: 'New request', p95: 1.9, errorRate: 100, count: 2 }]);

test('load: requests with the same name are numbered in collection order in Compare, the report and the service levels', () => {
    const a = qa3(), b = qa3();
    const c = compareLoadRuns(a, b, { a: 'A', b: 'B' });
    // Compare sorts by what changed; the numbers still follow the collection (r1 = /hello = (1)).
    assert.equal(c.transactions.find((t) => t.id === 'r1')!.label, 'New request (1)');
    assert.equal(c.transactions.find((t) => t.id === 'r2')!.label, 'New request (2)');
    const run = { id: 'x', name: 'QA3 perf', project: 'shop', env: 'qa', scenario: 'test/shop/load/q.load.json', startedAt: a.startedAt, state: 'finished', definition: newScenario('QA3 perf', 'test/shop/api/q.collection.json'), result: a } as unknown as LoadRunDetail;
    const html = loadReportHtml(run);
    const rows = [...html.matchAll(/<td>(New request[^<]*)<\/td>/g)].map((m) => m[1]);
    assert.ok(rows.includes('New request (1)') && rows.includes('New request (2)'), rows.join(', '));
    assert.ok(!rows.includes('New request'), 'never unnumbered');
    // Where the time goes: a row for each (the one that never got an answer says so).
    assert.match(html, /<h2>Where the time goes<\/h2>[\s\S]*New request \(1\)[\s\S]*New request \(2\)<\/td><td colspan="7"[^>]*>No HTTP exchange completed/);
    // The per-transaction chart says its average, the table's "Per second".
    assert.match(html, /New request \(1\): response time \(ms\) and requests per second \(on average 0\.78 per second\)/);
    // Time-axis labels once each.
    for (const svg of html.match(/<svg[\s\S]*?<\/svg>/g) ?? []) {
        const labels = [...svg.matchAll(/>(\d+:\d\d)<\/text>/g)].map((m) => m[1]);
        assert.equal(new Set(labels).size, labels.length, labels.join(' '));
    }
    const sl = checkSlas([{ target: 'r2', errorRate: 1 }], a.transactions, a.total);
    assert.equal(sl[0].name, 'New request (2)');
});

test('compare and trends share one rule: a p95 that drops is better; 5.8 ms is the same on both', () => {
    const a = loadRun([{ id: 'r1', name: 'X', p95: 400, errorRate: 0 }]), b = loadRun([{ id: 'r1', name: 'X', p95: 300, errorRate: 0 }]);
    (a.total as { p95: number }).p95 = 400; (b.total as { p95: number }).p95 = 300;
    const c = compareLoadRuns(a, b, { a: 'A', b: 'B' });
    assert.equal(c.metrics.find((m) => m.label.startsWith('95th'))!.verdict, 'better');
    assert.equal(c.transactions[0].verdict, changeVerdict(400, 300, 'time').verdict);
    (a.total as { p95: number }).p95 = 25.1; (b.total as { p95: number }).p95 = 19.3;
    assert.equal(compareLoadRuns(a, b, { a: 'A', b: 'B' }).metrics.find((m) => m.label.startsWith('95th'))!.verdict, changeVerdict(25.1, 19.3, 'time').verdict);
    assert.equal(changeVerdict(25.1, 19.3, 'time').verdict, 'same');
    assert.deepEqual(timeTicks(0, 5), [0, 2, 4, 5]);
});

const step = (iteration: number, requestId: string, url: string, passed: boolean) => ({ iteration, requestId, name: 'New request', method: 'GET', url, status: passed ? 200 : undefined, timeMs: 1, passed, checks: [] });
const job = (id: string, steps: ReturnType<typeof step>[]) => ({ id, name: 'C', project: 'shop', env: 'qa', startedAt: '2026-11-25T00:00:00Z', iterations: 1, state: 'finished', summary: { requests: steps.length, passed: 0, failed: 0, checks: 0, checksPassed: 0, avgMs: 1 }, steps } as unknown as RunnerJob);

test('runner: same names numbered in run order in JUnit (unique testcases), the report and Compare', () => {
    const j = job('a', [step(1, 'r1', 'http://127.0.0.1:47395/hello', true), step(1, 'r2', 'http://127.0.0.1:47398/', false), step(1, 'r2', 'http://127.0.0.1:47398/', false)]);
    const xml = runnerJUnit(j);
    const names = [...xml.matchAll(/<testcase [^>]*name="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(names, ['New request (1)', 'New request (2)', 'New request (2) — run 2']);
    assert.match(runnerReport(j), /<td>New request \(1\)<\/td>[\s\S]*<td>New request \(2\)<\/td>/);
    const c = compareApiRuns(j, job('b', [step(1, 'r1', 'http://127.0.0.1:47395/hello', true), step(1, 'r2', 'http://127.0.0.1:47398/', true)]));
    assert.equal(c.rows.find((r) => r.requestId === 'r1')!.label, 'New request (1)');
    assert.equal(c.rows.find((r) => r.requestId === 'r2')!.label, 'New request (2)');
});

test('a request with no address at all is said in words (not "Not a valid URL: ")', async () => {
    await assert.rejects(send({ method: 'GET', url: '', headers: {}, missing: [] }, undefined, 2000), /No address to send to/);
});
