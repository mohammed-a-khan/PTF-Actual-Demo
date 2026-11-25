import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { apiRoute, routeTabState, splitTab, withTab } from '../src/apiperf-ui';
import { changeVerdict, sameNameLabels, timeTicks } from '../../src/load/labels';

test('inner tabs in the address: "~tab" is the last segment, never part of the item', () => {
    assert.deepEqual(splitTab(['perf', 'test', 'shop', 'load', 'x.load.json', '~load']), { rest: ['perf', 'test', 'shop', 'load', 'x.load.json'], tab: 'load' });
    assert.deepEqual(splitTab(['perf-runs', 'abc']), { rest: ['perf-runs', 'abc'], tab: null });
    assert.deepEqual(withTab(['perf-runs', 'abc', '~tx'], 'charts'), ['perf-runs', 'abc', '~charts']);
    assert.deepEqual(apiRoute(['api', 'test', 'shop', 'api', 'o.collection.json', 'r1', '~headers']), { file: 'test/shop/api/o.collection.json', request: 'r1' });
    assert.deepEqual(apiRoute(['api', 'test', 'shop', 'api', 'o.collection.json', '~variables']), { file: 'test/shop/api/o.collection.json', request: null });
});

test('inner tab: the address wins; a bare or unknown tab is corrected in place to the tab shown', () => {
    const base = ['perf-runs', 'r1'], tabs = ['summary', 'charts', 'tx'];
    assert.deepEqual(routeTabState(['perf-runs', 'r1', '~tx'], base, 'charts', tabs), { shown: 'tx', fix: null, fromRoute: 'tx' });
    assert.deepEqual(routeTabState(['perf-runs', 'r1'], base, 'charts', tabs), { shown: 'charts', fix: ['perf-runs', 'r1', '~charts'], fromRoute: null });
    assert.deepEqual(routeTabState(['perf-runs', 'r1', '~nope'], base, 'zzz', tabs), { shown: 'summary', fix: ['perf-runs', 'r1', '~summary'], fromRoute: null });
    // Another item in the address (not yet shown): nothing is rewritten.
    assert.equal(routeTabState(['perf-runs', 'r2', '~tx'], base, 'charts', tabs).fix, null);
    assert.equal(routeTabState(['perf-runs', 'r1'], null, 'charts', tabs).fix, null, 'no address while loading');
    // A tab the item does not have (a run still going has no Summary).
    assert.equal(routeTabState(['perf-runs', 'r1', '~summary'], base, 'summary', [false, 'charts', 'tx']).shown, 'charts');
});

test('requests with the same name are numbered in collection order, everywhere the same', () => {
    const l = sameNameLabels([{ id: 'b', name: 'New request' }, { id: 'a', name: 'New request' }, { id: 'c', name: 'Login' }], ['a', 'b', 'c']);
    assert.equal(l.get('a'), 'New request (1)');
    assert.equal(l.get('b'), 'New request (2)');
    assert.equal(l.get('c'), 'Login');
    // Without an order: the order of the list (the order the requests ran).
    const r = sameNameLabels([{ id: 'x', name: 'A' }, { id: 'y', name: 'A' }]);
    assert.deepEqual([r.get('x'), r.get('y')], ['A (1)', 'A (2)']);
});

test('one rule for better / worse / same (Trends and Compare agree)', () => {
    // p95 25.1 ms → 19.3 ms: −23% but only 5.8 ms: about the same on both screens.
    assert.equal(changeVerdict(25.1, 19.3, 'time').verdict, 'same');
    assert.equal(changeVerdict(400, 300, 'time').verdict, 'better');
    assert.equal(changeVerdict(300, 400, 'time').verdict, 'worse');
    assert.equal(changeVerdict(1, 1.2, 'rate').verdict, 'better');
    assert.equal(changeVerdict(1, 1.05, 'rate').verdict, 'same');
    assert.equal(changeVerdict(1, 2, 'errorRate').verdict, 'worse');
    assert.equal(changeVerdict(1, 1.05, 'errorRate').verdict, 'same');
});

test('time axis: whole seconds, no second skipped, none twice', () => {
    assert.deepEqual(timeTicks(0, 5), [0, 2, 4, 5]);
    assert.deepEqual(timeTicks(0, 3), [0, 1, 2, 3]);
    for (const [a, b] of [[0, 5], [0, 7], [0, 300], [1, 2], [0, 3601]]) {
        const t = timeTicks(a, b);
        assert.equal(new Set(t).size, t.length);
        assert.ok(t.every((x) => Number.isInteger(x) && x >= a && x <= b), `${a}-${b}: ${t}`);
        assert.ok(t.length <= 6);
    }
});
