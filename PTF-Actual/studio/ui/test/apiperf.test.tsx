import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { apiRoute, httpUrlProblem, isChangedElsewhere, nameProblem, numOf, numProblem, restoredName, runnerRoute, verdictWords, versionOf, withBase } from '../src/apiperf-ui';

test('API requests address: the collection file, then the selected request', () => {
    assert.deepEqual(apiRoute(['api']), { file: null, request: null });
    assert.deepEqual(apiRoute(['api', 'test', 'shop', 'api', 'orders.collection.json']), { file: 'test/shop/api/orders.collection.json', request: null });
    assert.deepEqual(apiRoute(['api', 'test', 'shop', 'api', 'orders.collection.json', 'r1abc']), { file: 'test/shop/api/orders.collection.json', request: 'r1abc' });
    assert.deepEqual(apiRoute(['api-runner', 'x.collection.json']), { file: null, request: null }, 'another screen');
});

test('create dialogs: names of only spaces and addresses without a host are refused', () => {
    assert.equal(nameProblem('', 'scenario'), 'Give the scenario a name.');
    assert.equal(nameProblem('   ', 'scenario'), 'Give the scenario a name.');
    assert.equal(nameProblem(' Checkout ', 'scenario'), null);
    assert.ok(httpUrlProblem(''));
    assert.ok(httpUrlProblem('http://'));
    assert.ok(httpUrlProblem('https://'));
    assert.ok(httpUrlProblem('ftp://x.example'));
    assert.equal(httpUrlProblem('http://127.0.0.1:8080/v2'), null);
    assert.equal(httpUrlProblem(' https://api.example.com '), null);
});

test('saves carry the version read; a 409 is "changed elsewhere"', () => {
    assert.deepEqual(withBase({ a: 1 }, 'v1'), { a: 1, $studio: { base: 'v1' } });
    assert.deepEqual(withBase({ a: 1 }, 'v1', true), { a: 1, $studio: { base: 'v1', force: true } });
    assert.deepEqual(withBase({ a: 1 }, undefined), { a: 1 }, 'a new file has no version');
    assert.equal(versionOf({ file: 'x', version: 'abc' }), 'abc');
    assert.equal(versionOf({ file: 'x' }), undefined);
    assert.equal(isChangedElsewhere(Object.assign(new Error('Changed in another tab or by someone else'), { status: 409 })), true);
    assert.equal(isChangedElsewhere(Object.assign(new Error('bad'), { status: 400 })), false);
});

test('number fields: decimals, negatives, text and out-of-range numbers are said, never rounded', () => {
    const users = { label: 'Users', min: 1, max: 100000 };
    assert.equal(numProblem('2', users), null);
    assert.equal(numProblem('2.5', users), 'Users: no decimals; give a whole number from 1 to 100000.');
    assert.equal(numProblem('2,5', users), 'Users: no decimals; give a whole number from 1 to 100000.');
    assert.equal(numProblem('-3', users), 'Users: no negative numbers; give a whole number from 1 to 100000.');
    assert.equal(numProblem('abc', users), 'Users: numbers only; give a whole number from 1 to 100000.');
    assert.equal(numProblem('1e2', users), 'Users: numbers only; give a whole number from 1 to 100000.');
    assert.equal(numProblem('99999999', users), 'Users: a whole number from 1 to 100000 (not 99999999).');
    assert.equal(numProblem('', users), 'Users: give a whole number from 1 to 100000.');
    assert.equal(numProblem('', { ...users, optional: true }), null);
    assert.equal(numProblem('5.0', users), null, '5.0 is the whole number 5');
    // Seconds with milliseconds: up to 3 decimals.
    const t = { label: 'Timeout (seconds)', min: 0.1, max: 600, decimals: 3 };
    assert.equal(numProblem('2.5', t), null);
    assert.equal(numProblem('0.0005', t), 'Timeout (seconds): at most 3 decimals; give a number from 0.1 to 600.');
    assert.equal(numOf('2.5'), 2.5);
    assert.equal(numOf('2,5'), 2.5);
    assert.equal(numOf('x'), undefined);
});

test('a request restored again keeps one "(from …)" in its name', () => {
    const once = restoredName('New request', '11/25/2026, 5:24:30 AM');
    assert.equal(once, 'New request (from 11/25/2026, 5:24:30 AM)');
    const twice = restoredName(once, '11/25/2026, 6:00:00 AM');
    assert.equal(twice, 'New request (from 11/25/2026, 6:00:00 AM)');
    assert.equal(restoredName(`${twice} (from x)`, 'y'), 'New request (from y)');
    assert.equal(restoredName('Orders (v2)', 'y'), 'Orders (v2) (from y)', 'other brackets are kept');
});

test('runner addresses name the inner tab: a run link opens Past runs, a collection opens Run', () => {
    assert.deepEqual(runnerRoute(['api-runner', 'run', 'abc']), { tab: 'runs', file: null, runId: 'abc', compareWith: null });
    assert.deepEqual(runnerRoute(['api-runner', 'monitors']), { tab: 'monitors', file: null, runId: null, compareWith: null });
    assert.deepEqual(runnerRoute(['api-runner', 'runs']), { tab: 'runs', file: null, runId: null, compareWith: null });
    assert.deepEqual(runnerRoute(['api-runner', 'test', 'shop', 'api', 'o.collection.json']), { tab: 'run', file: 'test/shop/api/o.collection.json', runId: null, compareWith: null });
    assert.deepEqual(runnerRoute(['api-runner']), { tab: null, file: null, runId: null, compareWith: null });
});

test('compare: the arrow follows the number, the word says better or worse', () => {
    assert.equal(verdictWords('better', '+20%'), '▲ better', 'more throughput is better and went up');
    assert.equal(verdictWords('worse', '-30%'), '▼ worse');
    assert.equal(verdictWords('better', '−12%'), '▼ better');
    assert.equal(verdictWords('worse', '+683%'), '▲ worse');
    assert.equal(verdictWords('same', '+3%'), '≈ same');
});
