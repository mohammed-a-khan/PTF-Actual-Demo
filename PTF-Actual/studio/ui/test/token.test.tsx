import { calls } from './support/token-setup';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { api, hasToken } from '../src/api';

const ls = (globalThis as unknown as { localStorage: Storage }).localStorage;

test('the start key is kept for the whole browser (a second tab works) and removed from the address bar', () => {
    assert.equal(hasToken(), true);
    assert.equal(ls.getItem('cs-studio-token'), 'launch1');
    // The key is gone from the address, the deep link after it stays.
    assert.deepEqual(calls.replaced, ['/#/quality/causes']);
});

test('a key the server rejects (a new launch) is dropped and the start-link page is shown', async () => {
    const g = globalThis as Record<string, unknown>;
    const old = g.fetch;
    // Another 401 (not about the Studio key) changes nothing.
    g.fetch = async () => new Response(JSON.stringify({ error: 'The server refused the credentials (401).' }), { status: 401 });
    await assert.rejects(api.health());
    assert.equal(ls.getItem('cs-studio-token'), 'launch1');
    assert.equal(calls.reloads, 0);
    g.fetch = async () => new Response(JSON.stringify({ error: 'Missing or invalid Studio token. Open the Studio from the link printed when it started.' }), { status: 401 });
    await assert.rejects(api.health());
    assert.equal(ls.getItem('cs-studio-token'), null);
    assert.equal(calls.reloads, 1);
    assert.equal(hasToken(), false);
    g.fetch = old;
});
