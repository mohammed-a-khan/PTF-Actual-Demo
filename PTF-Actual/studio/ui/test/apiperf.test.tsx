import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { apiRoute, httpUrlProblem, nameProblem } from '../src/apiperf-ui';

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
