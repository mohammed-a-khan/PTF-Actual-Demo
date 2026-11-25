/**
 * Scenarios of a generated feature: a request is in the scenario of the requests whose saved values it uses; a
 * request using values saved in two scenarios joins them into one (in their order), so every value is there.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scenarioGroups } from '../src/api/feature';
import { ApiRequest, newRequest } from '../src/api/model';

const r = (id: string, url: string, saves: string[] = []): { request: ApiRequest } => ({ request: { ...newRequest(id, id), url, extract: saves.map((v) => ({ from: 'body' as const, path: `$.${v}`, variable: v })) } as ApiRequest });

test('scenario groups: chains, independent requests, and a request joining two chains', () => {
    const items = [r('login', '/login', ['token']), r('catalog', '/catalog', ['sku']), r('free', '/health'), r('me', '/me?t={{token}}'), r('buy', '/buy/{{sku}}?t={{token}}', ['order']), r('track', '/orders/{{order}}')];
    const names = scenarioGroups({ auth: { type: 'none' } }, items).map((g) => g.map((x) => x.request.name));
    assert.deepEqual(names, [['login', 'me', 'catalog', 'buy', 'track'], ['free']]);
    // Without the joining request: three scenarios.
    assert.deepEqual(scenarioGroups({ auth: { type: 'none' } }, items.slice(0, 4)).map((g) => g.map((x) => x.request.name)), [['login', 'me'], ['catalog'], ['free']]);
});
