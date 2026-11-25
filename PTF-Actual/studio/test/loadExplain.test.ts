/**
 * Results in plain language: every number explained and rated (against the team's targets, else common guidance),
 * an overall status with a one-sentence answer, behaviour over time, risks and next steps; two runs compared with
 * what changed and whether it matters; both in the HTML report (the PDF prints it) and the comparison report.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { compareRuns, explainRun } from '../src/load/explain';
import { loadReportHtml } from '../src/load/report';
import { loadComparisonHtml } from '../src/load/reportDocs';
import { newScenario } from '../src/load/scenario';
import type { RunResult } from '../src/load/engine';
import type { LoadRunDetail } from '../src/load/runs';

/** A run at 50 users for 120 s: p95 as given, rising by `drift` ms per second at full load. */
function run(p95: number, o: { errors?: number; drift?: number; passed?: boolean; tx?: Array<[string, number]> } = {}): RunResult {
    const timeline = Array.from({ length: 120 }, (_, t) => ({ t, users: Math.min(50, (t + 1) * 5), requests: 100, errors: 0, avg: p95 / 2, p95: p95 + (o.drift ?? 0) * t }));
    const total = { count: 12000, errors: Math.round(120 * (o.errors ?? 0)), errorRate: o.errors ?? 0, avg: p95 / 2, p50: p95 / 2.5, p90: p95 * 0.8, p95, p99: p95 * 1.6, max: p95 * 3, throughput: 100 };
    return { state: 'finished', elapsed: 120, users: 0, requests: 12000, errors: total.errors, iterations: 6000, timeline,
        transactions: (o.tx ?? [['Search', p95], ['Pay', p95]]).map(([name, p]) => ({ id: name.toLowerCase(), name, count: 6000, errors: 0, errorRate: 0, avg: p / 2, min: 1, max: p * 3, p50: p / 2.5, p90: p * 0.8, p95: p, p99: p * 1.6, throughput: 50, topErrors: [] })),
        txTimeline: {}, populations: [], monitors: [], alerts: [], total, startedAt: '2026-11-20T10:00:00.000Z', endedAt: '2026-11-20T10:02:00.000Z', stopReason: 'completed',
        slas: [], passed: o.passed ?? true, histograms: { total: { b: [], count: 0, sum: 0, min: 0, max: 0 }, tx: {} } } as unknown as RunResult;
}
const sc = (slas = [] as RunResult['slas'][number]['sla'][]) => ({ ...newScenario('Checkout', 'test/p/api/a.collection.json'), policy: { type: 'constant' as const, users: 50, duration: 120 }, slas });

test('every number explained and rated; status and the plain answer', () => {
    const good = explainRun(run(450), sc());
    assert.equal(good.status, 'green');
    assert.match(good.answer, /^Yes\. The system handled 50 simultaneous users within commonly accepted response times, with 0\.0% errors\./);
    const p95 = good.metrics.find((m) => m.key === 'p95')!;
    assert.deepEqual([p95.value, p95.rating], ['450 ms', 'good']);
    assert.match(p95.meaning, /95 of every 100 requests finished within 450 ms; 1 user action in 20 waited longer/);
    assert.match(p95.basis, /under 1 s feels immediate/);
    assert.equal(good.behaviour.verdict, 'stable');
    // Against the team's own target, a 2.1 s p95 with errors: red, with the reasons and next steps.
    const r = run(2100, { errors: 3.2, passed: false });
    r.slas = [{ sla: { target: '*', p95: 1500 }, name: 'All requests', pass: false, level: 'fail', details: ['p95 2100 ms > 1500 ms'] }];
    const bad = explainRun(r, sc([{ target: '*', p95: 1500, errorRate: 1 }]));
    assert.equal(bad.status, 'red');
    assert.match(bad.answer, /^No\. It missed 1 agreed target \(All requests\) with 50 simultaneous users\./);
    const bp = bad.metrics.find((m) => m.key === 'p95')!;
    assert.deepEqual([bp.value, bp.rating, bp.basis], ['2.1 s', 'poor', 'your target: 1.5 s']);
    const be = bad.metrics.find((m) => m.key === 'errorRate')!;
    assert.deepEqual([be.rating, be.basis], ['critical', 'your target: at most 1%']);
    assert.match(be.meaning, /about 1 in 31 user actions would have shown an error/);
    assert.ok(bad.risks.some((x) => /Target missed: All requests — p95 2100 ms > 1500 ms/.test(x)));
    assert.ok(bad.recommendations.some((x) => /Fix the most frequent errors first/.test(x)));
    // Degrading at constant load: amber, with what it suggests.
    const drift = explainRun(run(400, { drift: 6 }), sc());
    assert.equal(drift.behaviour.verdict, 'degrading');
    assert.match(drift.behaviour.text, /resources running out \(memory, connections, queues\)/);
    assert.equal(drift.status, 'amber');
    assert.ok(drift.recommendations.some((x) => /longer test/.test(x)));
    assert.ok(good.glossary.some((g) => g.term.startsWith('Percentile')));
});

test('two runs compared: what got worse, by how much, and whether it matters', () => {
    const a = run(500, { tx: [['Search', 300], ['Pay', 600], ['Old step', 100]] }), b = run(720, { tx: [['Search', 310], ['Pay', 1100], ['New step', 90]] });
    const c = compareRuns(a, b, { a: 'Run A', b: 'Run B' });
    assert.equal(c.status, 'red');
    assert.equal(c.headline, 'RED — Run B is worse than Run A');
    assert.match(c.answer, /^Performance regressed: the 95th percentile went from 500 ms to 720 ms \(\+44%\); 1 transaction got slower\./);
    const p95 = c.metrics.find((m) => m.label.startsWith('95th'))!;
    assert.deepEqual([p95.change, p95.verdict, p95.meaning], ['+44%', 'worse', 'Users waited 44% longer.']);
    assert.deepEqual(c.transactions.map((t) => [t.name, t.verdict]), [['Pay', 'worse'], ['Search', 'same'], ['Old step', 'gone'], ['New step', 'new']]);
    assert.ok(c.findings.includes('Pay got slower: 95% within 1.1 s instead of 600 ms (+83%).'));
    assert.ok(c.notes.some((n) => /±10%/.test(n)));
    const same = compareRuns(a, run(520, { tx: [['Search', 305], ['Pay', 610], ['Old step', 100]] }), { a: 'A', b: 'B' });
    assert.deepEqual([same.status, same.answer], ['green', 'No meaningful change: response times, throughput and errors are within normal variation of A.']);
    const faster = compareRuns(a, run(300, { tx: [['Search', 200], ['Pay', 350], ['Old step', 100]] }), { a: 'A', b: 'B' });
    assert.match(faster.answer, /^Performance improved: the 95th percentile went from 500 ms to 300 ms \(-40%\)/);
});

test('the reports carry it: executive summary first, technical details after; the comparison verdict', () => {
    const d = (r: RunResult, id: string): LoadRunDetail => ({ id, scenario: 'test/p/load/c.load.json', name: 'Checkout', project: 'p', env: 'qa', startedAt: r.startedAt, state: 'finished', maxUsers: 50, duration: 120, definition: sc(), result: r });
    const html = loadReportHtml(d(run(450), 'a'));
    const exec = html.indexOf('<h2>Executive summary</h2>'), tech = html.indexOf('Technical details');
    assert.ok(exec > 0 && tech > exec, 'executive summary before the technical details');
    assert.match(html, /<div class="badge" style="background:#1a7f37">GREEN<\/div>/);
    assert.match(html, /<td>95th percentile \(p95\)<\/td><td><b>450 ms<\/b><\/td><td><span class="r-good">Good<\/span><\/td>/);
    assert.match(html, /<h3>Recommended next steps<\/h3>/);
    const cmp = loadComparisonHtml([d(run(500), 'a'), d(run(720, { tx: [['Search', 500], ['Pay', 1100]] }), 'b')]);
    assert.match(cmp, /<h2>Verdict<\/h2><div class="status" style="border-color:#cf222e">/);
    assert.match(cmp, /<td class="v-worse">\+44% <small>▲ worse<\/small><\/td><td>Users waited 44% longer\.<\/td>/);
});

test('compare: every time measure uses one rule (10% and 20 ms); a big % of a few ms says why it is "same"', () => {
    // avg 2.5 → 7.5 ms (+200%, 5 ms): same; p95 5 → 15 ms (+200%, 10 ms): same; p99 8 → 24 ms (+200%, 16 ms): same.
    const c = compareRuns(run(5), run(15), { a: 'A', b: 'B' });
    for (const k of ['Average response time', 'Median (p50)', '90th percentile (p90)', '95th percentile (p95)', '99th percentile (p99)']) {
        const m = c.metrics.find((x) => x.label === k)!;
        assert.equal(m.verdict, 'same', k);
        assert.match(m.meaning, /^About the same: \+\d+(\.\d)? ms is under 20 ms \(normal variation\)\.$/, k);
    }
    // The same % with more than 20 ms: worse for every time measure alike.
    const d = compareRuns(run(500), run(1500), { a: 'A', b: 'B' });
    for (const m of d.metrics.filter((x) => /response time|p\d\d|p50/.test(x.label))) assert.equal(m.verdict, 'worse', m.label);
});
