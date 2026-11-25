/**
 * API and Performance, round 7: the Compare verdict follows its own table (any key measure worse beyond the shared
 * threshold is a regression, named in the answer; the reports say the same); runs of different scenarios are not
 * compared (a readable reason, never a verdict); the Excel summary shows local dates and times like the other reports.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createServer } from '../src/server/server';
import { SecretStore } from '../src/secrets/store';
import { KeyFileProtector } from '../src/secrets/protector';
import { runGit } from '../src/git/run';
import { newScenario } from '../src/load/scenario';
import { compareRuns } from '../src/load/explain';
import { differentScenarios, loadComparisonHtml } from '../src/load/reportDocs';
import { loadReportXlsx } from '../src/load/report';
import type { RunResult } from '../src/load/engine';
import type { LoadRunDetail } from '../src/load/runs';

/** A finished run with these totals (the QA7 e2e load runs: 4:27:03 PM and 4:32:53 PM). */
function result(total: { avg: number; p50: number; p9x: number; errorRate: number; throughput: number; count: number }, startedAt: string): RunResult {
    const t = { count: total.count, errors: Math.round((total.errorRate / 100) * total.count), errorRate: total.errorRate, avg: total.avg, p50: total.p50, p90: total.p9x, p95: total.p9x, p99: total.p9x, max: total.p9x, throughput: total.throughput };
    const timeline = [0, 1, 2, 3].map((s) => ({ t: s, users: 2, requests: 1, errors: 0, avg: total.avg, p95: total.p9x }));
    return { elapsed: 4, timeline, total: t, passed: false, slas: [], alerts: [], populations: [], monitors: [], iterations: 2, users: 0, startedAt, endedAt: startedAt, stopReason: 'completed',
        // The one transaction fails in both runs (as in the QA run): "fails in both runs", not a slowdown.
        transactions: [{ id: 'r1', name: 'Post err', count: 2, errors: 2, errorRate: 100, avg: 300, min: 300, max: 333, p50: 305, p90: 333, p95: 333, p99: 333, throughput: 0.5, topErrors: [] }] } as unknown as RunResult;
}
const runA = () => result({ avg: 159, p50: 3, p9x: 315, errorRate: 50, throughput: 1.0, count: 4 }, '2026-11-25T16:27:03.000Z');
const runB = () => result({ avg: 213, p50: 305.31, p9x: 333, errorRate: 33.333333333333336, throughput: 1.5, count: 6 }, '2026-11-25T16:32:53.000Z');
const detail = (id: string, scenario: string, name: string, r: RunResult): LoadRunDetail => ({ id, scenario, name, project: 'shop', env: 'qa', startedAt: r.startedAt, state: 'finished', maxUsers: 2, duration: 4,
    passed: r.passed, summary: { requests: r.total.count, errorRate: r.total.errorRate, avg: r.total.avg, p95: r.total.p95, throughput: r.total.throughput },
    definition: newScenario(name, 'test/shop/api/q.collection.json'), result: r } as unknown as LoadRunDetail);

test('compare: Average +34% and Median +10077% worse is never "No meaningful change"', () => {
    const c = compareRuns(runA(), runB(), { a: 'Run A', b: 'Run B' });
    const m = (label: string) => c.metrics.find((x) => x.label === label)!;
    // The rows, exactly as the QA saw them.
    assert.equal(m('Average response time').change, '+34%');
    assert.equal(m('Average response time').verdict, 'worse');
    assert.equal(m('Median (p50)').change, '+10077%');
    assert.equal(m('Median (p50)').verdict, 'worse');
    assert.equal(m('95th percentile (p95)').verdict, 'same');
    assert.equal(m('Throughput').verdict, 'better');
    assert.equal(m('Error rate').verdict, 'better');
    // The verdict follows them: not green, says it is worse and which measures.
    assert.notEqual(c.status, 'green');
    assert.equal(c.status, 'red', 'more than 25% slower on average and in the median');
    assert.match(c.headline, /^RED — Run B is worse than Run A$/);
    assert.doesNotMatch(c.answer, /No meaningful change|within normal variation/);
    assert.match(c.answer, /the average response time went from 159 ms to 213 ms \(\+34%\)/);
    assert.match(c.answer, /the median response time went from 3 ms to 305 ms \(\+10077%\)/);
    assert.match(c.answer, /Better: errors, throughput\./);
});

test('compare: every key measure counts (average, median, p95, errors, throughput), each named; noise alone stays green', () => {
    // Both pass their targets (a failing run B is red on its own).
    const base = () => ({ ...result({ avg: 400, p50: 300, p9x: 800, errorRate: 0, throughput: 10, count: 100 }, '2026-11-25T10:00:00Z'), passed: true, transactions: [] }) as RunResult;
    const g = compareRuns(base(), base(), { a: 'A', b: 'B' });
    assert.equal(g.status, 'green');
    assert.match(g.answer, /No meaningful change/);
    const cases: Array<[string, (r: RunResult) => void, RegExp]> = [
        ['average', (r) => { (r.total as { avg: number }).avg = 460; }, /the average response time went from/],
        ['median', (r) => { (r.total as { p50: number }).p50 = 345; }, /the median response time went from/],
        ['p95', (r) => { (r.total as { p95: number }).p95 = 900; }, /the 95th percentile went from/],
        ['errors', (r) => { (r.total as { errorRate: number }).errorRate = 0.5; }, /errors went from/],
        ['throughput', (r) => { (r.total as { throughput: number }).throughput = 8.5; }, /throughput fell from 10\.0\/s to 8\.5\/s \(-15%\)/],
    ];
    for (const [what, worsen, said] of cases) {
        const b = base(); worsen(b);
        const c = compareRuns(base(), b, { a: 'A', b: 'B' });
        assert.equal(c.status, 'amber', what);
        assert.match(c.headline, /is worse than/, what);
        assert.match(c.answer, said, what);
    }
    // Under the shared threshold (9%): still the same.
    const small = base(); (small.total as { avg: number }).avg = 436;
    assert.equal(compareRuns(base(), small, { a: 'A', b: 'B' }).status, 'green');
});

test('compare reports say what the screen says', () => {
    const a = detail('a1', 'test/shop/load/e2e.load.json', 'QA7 e2e load', runA()), b = detail('b1', 'test/shop/load/e2e.load.json', 'QA7 e2e load', runB());
    const html = loadComparisonHtml([a, b]);
    assert.doesNotMatch(html, /No meaningful change/);
    assert.match(html, />RED<\/div>/);
    assert.match(html, /Performance regressed: the average response time went from 159 ms to 213 ms \(\+34%\); the median response time went from 3 ms to 305 ms \(\+10077%\)/);
});

test('runs of different scenarios: refused with readable names, never compared', async () => {
    const a = detail('20261125161238-gmd3cw', 'test/shop/load/qa3.load.json', 'QA3 perf', runA());
    const b = detail('20261125163253-c9l4t0', 'test/shop/load/e2e.load.json', 'QA7 e2e load', runB());
    const why = differentScenarios([a, b]);
    assert.ok(why);
    assert.match(why!, /^Different scenarios — not comparable: the run of "QA3 perf" \(.+\) and the run of "QA7 e2e load" \(.+\)/);
    assert.doesNotMatch(why!, /gmd3cw|c9l4t0/, 'names, not ids');
    assert.equal(differentScenarios([a, { ...a, id: 'x' }]), null);
    assert.throws(() => loadComparisonHtml([a, b]), /Different scenarios — not comparable/);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-apiperf7-'));
    const dir = path.join(tmp, 'repo');
    try {
        await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        const runsDir = path.join(dir, '.git', 'cs-studio', 'load-runs');
        fs.mkdirSync(runsDir, { recursive: true });
        const a2 = detail('20261125162703-3nzfx1', b.scenario, b.name, runA());
        for (const d of [a, b, a2]) fs.writeFileSync(path.join(runsDir, `${d.id}.json`), JSON.stringify(d));
        const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
        const srv = createServer({ repoRoot: dir, store, userName: 'T', projectId: 'repo' });
        const headers = { authorization: `Bearer ${srv.token}` };
        try {
            const get = async (url: string) => { const r = await srv.app.inject({ method: 'GET', url, headers }); return { status: r.statusCode, body: r.body }; };
            const cross = await get(`/api/load/compare?a=${a.id}&b=${b.id}`);
            assert.equal(cross.status, 400);
            assert.match(JSON.parse(cross.body).error, /Different scenarios — not comparable/);
            const rep = await get(`/api/load/compare/report?ids=${a.id},${b.id}&format=html`);
            assert.equal(rep.status, 400);
            assert.equal((await get(`/api/load/compare?a=${b.id}&b=${b.id}`)).status, 400, 'the same run twice');
            const ok = await get(`/api/load/compare?a=${a2.id}&b=${b.id}`);
            assert.equal(ok.status, 200);
            assert.equal(JSON.parse(ok.body).comparison.status, 'red');
        } finally { await srv.app.close(); }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the Excel summary shows the start and end in local date and time, like the other reports', () => {
    const d = detail('x', 'test/shop/load/e2e.load.json', 'QA7 e2e load', runA());
    const sheet = execFileSync('python3', ['-c', 'import sys,zipfile,io; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(z.read("xl/worksheets/sheet1.xml").decode())'], { input: loadReportXlsx(d) }).toString();
    assert.ok(sheet.includes(new Date('2026-11-25T16:27:03.000Z').toLocaleString()), 'local time');
    assert.doesNotMatch(sheet, /2026-11-25T16:27:03/);
});
