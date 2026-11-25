/**
 * What a run says: spikes, error bursts, throughput drops, the capacity knee, monitors that moved with the
 * response times, where the time goes, what the errors mean, and the narrative summary.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { runInsights } from '../src/load/insights';
import { loadReportHtml } from '../src/load/report';
import { loadSummaryMarkdown } from '../src/load/pipeline';
import { newScenario } from '../src/load/scenario';
import type { RunResult } from '../src/load/engine';

/** A ramp from 1 to 20 users over 200 s: throughput grows to 10 users (100/s), then stays; response times climb. */
function rampRun(): RunResult {
    const timeline = Array.from({ length: 200 }, (_, t) => {
        const users = 1 + Math.floor(t / 10);
        const requests = Math.min(users, 10) * 10;
        let p95 = users <= 10 ? 100 : 100 + (users - 10) * 60;
        let errors = 0;
        if (t >= 50 && t < 54) p95 = 2400;                 // a spike at 0:50
        if (t >= 150 && t < 155) errors = Math.round(requests * 0.3); // an error burst at 2:30
        return { t, users, requests, errors, avg: p95 / 2, p95 };
    });
    const tx = { id: 'pay', name: 'Pay', count: 15000, errors: 150, errorRate: 1, avg: 300, min: 5, max: 4000, p50: 200, p90: 600, p95: 700, p99: 1500, throughput: 75,
        phases: { blocked: 1, dns: 0, connect: 2, tls: 3, send: 1, wait: 280, download: 13 }, phaseCount: 15000,
        topErrors: [{ message: 'HTTP 503', count: 150, samples: [{ t: 150.4, response: { status: 503, timeMs: 30, headers: {} } }] }] };
    return {
        state: 'finished', elapsed: 200, users: 0, requests: 15000, errors: 150, iterations: 7000, timeline, transactions: [tx, { ...tx, id: 'home', name: 'Home', p95: 120, topErrors: [], errors: 0, errorRate: 0, phases: undefined, phaseCount: undefined }],
        txTimeline: {}, populations: [], alerts: [],
        monitors: [{ name: 'DB CPU', unit: '%', points: timeline.filter((s) => s.t % 5 === 0).map((s) => ({ t: s.t, v: 20 + s.p95 / 50 })) }, { name: 'Load generator CPU', unit: '%', points: timeline.filter((s) => s.t % 5 === 0).map((s) => ({ t: s.t, v: 30 + ((s.t * 13) % 7) })), generator: true }],
        total: { count: 15000, errors: 150, errorRate: 1, avg: 300, p50: 200, p90: 600, p95: 700, p99: 1500, max: 4000, throughput: 75 },
        startedAt: '2026-11-23T10:00:00.000Z', endedAt: '2026-11-23T10:03:20.000Z', stopReason: 'completed',
        slas: [{ sla: { target: '*', p95: 500 }, name: 'All requests', pass: false, level: 'fail', details: ['p95 700 ms > 500 ms'] }], passed: false,
        histograms: { total: { b: [], count: 0, sum: 0, min: 0, max: 0 }, tx: {} },
    } as unknown as RunResult;
}

test('insights: spike, error burst, capacity knee, correlated monitor, waiting for the server, 503s, narrative', () => {
    const x = runInsights(rampRun());
    const titles = x.insights.map((i) => i.title);
    assert.ok(titles.some((t) => /^Response times jumped at 0:50–0:54$/.test(t)), titles.join(' | '));
    assert.ok(titles.some((t) => /^Errors burst at 2:30–2:35$/.test(t)), titles.join(' | '));
    const cap = x.insights.find((i) => i.kind === 'capacity')!;
    assert.match(cap.title, /^Capacity reached at about 1[01] users$/);
    assert.match(cap.detail, /about 100 requests\/s/);
    assert.ok(x.insights.some((i) => i.title === 'DB CPU rose with the response times' && i.severity === 'warning'));
    assert.ok(!titles.some((t) => /Load generator CPU/.test(t)), 'an unrelated monitor is not blamed');
    assert.match(x.insights.find((i) => /of the time is/.test(i.title))!.title, /^9\d% of the time is waiting for the server to answer$/);
    assert.match(x.insights.find((i) => /HTTP 503/.test(i.title))!.detail, /First seen at 2:30\. Likely: the server or a gateway in front of it was overloaded or unavailable\./);
    assert.ok(titles.includes('Pay is the slowest by far'));
    assert.match(x.summary, /^The run failed: 15,000 requests in 200 s \(75\.0\/s\), 1\.00% errors, 95% under 700 ms\. It missed All requests \(p95 700 ms > 500 ms\)\./);
    assert.match(x.summary, /The monitors point at where to look first\./);
});

test('insights in the report and the pipeline summary; a quiet run has none to raise', () => {
    const r = rampRun();
    const d = { id: 'x', scenario: 'test/p/load/x.load.json', name: 'Ramp', project: 'p', env: 'qa', startedAt: r.startedAt, state: 'finished' as const, maxUsers: 20, duration: 200, definition: newScenario('Ramp', 'test/p/api/a.collection.json'), result: r };
    assert.match(loadReportHtml(d), /<h2>What the run says<\/h2><p>The run failed:/);
    assert.match(loadSummaryMarkdown(d), /\nThe run failed: 15,000 requests/);
    const quiet = { ...r, timeline: r.timeline.map((s) => ({ ...s, users: 5, requests: 50, errors: 0, p95: 100 + (s.t % 3) })), transactions: [{ ...r.transactions[1] }], monitors: [], slas: [], passed: true, total: { ...r.total, errorRate: 0 } } as RunResult;
    const q = runInsights(quiet);
    assert.deepEqual(q.insights.filter((i) => i.severity !== 'info').map((i) => i.title), []);
    assert.match(q.summary, /^The run passed/);
});
