import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { apiRequestRoute, numProblem, runnerRoute, runnerRunRoute } from '../src/apiperf-ui';
import { fittedTicks } from '../src/components/LineChart';

test('runner: the run compared with is in the address (a reload keeps the comparison)', () => {
    assert.deepEqual(runnerRunRoute('abc', 'def'), ['api-runner', 'run', 'abc', '~compare.def']);
    assert.deepEqual(runnerRunRoute('abc', null), ['api-runner', 'run', 'abc']);
    assert.deepEqual(runnerRoute(runnerRunRoute('abc', 'def')), { tab: 'runs', file: null, runId: 'abc', compareWith: 'def' });
    assert.deepEqual(runnerRoute(['api-runner', 'run', 'abc', '~compare.']), { tab: 'runs', file: null, runId: 'abc', compareWith: null });
    assert.deepEqual(runnerRoute(['api-runner', 'run', 'abc', '~other']), { tab: 'runs', file: null, runId: 'abc', compareWith: null });
});

test('history: "Open the request" opens the request that was sent, not only its collection', () => {
    assert.deepEqual(apiRequestRoute('test/shop/api/o.collection.json', 'r1'), ['api', 'test', 'shop', 'api', 'o.collection.json', 'r1']);
    assert.deepEqual(apiRequestRoute('test/shop/api/o.collection.json'), ['api', 'test', 'shop', 'api', 'o.collection.json']);
});

test('an optional number field with only spaces says so (it is not taken as empty)', () => {
    const retries = { label: 'Retries', min: 0, max: 10, optional: true };
    assert.equal(numProblem('   ', retries), 'Retries: only spaces; leave it empty or give a whole number from 0 to 10.');
    assert.equal(numProblem('', retries), null);
    assert.equal(numProblem(' 3 ', retries), null);
    assert.equal(numProblem('   ', { ...retries, optional: false }), 'Retries: give a whole number from 0 to 10.');
});

test('chart x axis: long labels are thinned so they never overlap', () => {
    // Trends at 1024 px: 9 runs, "#n hh:mm AM" labels, a 300 px wide plot.
    const x0 = 1, x1 = 9, iw = 300, pad = 40;
    const px = (t: number) => pad + ((t - x0) / (x1 - x0)) * iw;
    const fx = (t: number) => `#${t} 04:39 AM`;
    const ticks = fittedTicks(x0, x1, iw, px, fx);
    assert.ok(ticks.length >= 2 && ticks[0] === 1, ticks.join());
    const w = (t: number) => fx(t).length * 6.4 + 4;
    const box = (t: number) => (t <= x0 ? [px(t), px(t) + w(t)] : t >= x1 ? [px(t) - w(t), px(t)] : [px(t) - w(t) / 2, px(t) + w(t) / 2]);
    for (let i = 1; i < ticks.length; i++) assert.ok(box(ticks[i])[0] > box(ticks[i - 1])[1], `${ticks[i - 1]} and ${ticks[i]} overlap`);
    // Short labels on a wide plot: up to 6.
    assert.ok(fittedTicks(0, 60, 600, (t) => 40 + t * 10, (t) => `${t}s`).length >= 5);
});
