/** The flow of a collection: values passed between requests, script jumps, the feature's scenarios, values nothing gives. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { collectionFlow } from '../src/api/flow';
import { toFeature } from '../src/api/feature';
import { ApiCollection, newCollection, newRequest } from '../src/api/model';

test('a collection as a flow, with the same scenarios as its feature', () => {
    const c: ApiCollection = { ...newCollection('Shop'), baseUrl: 'https://shop.test', variables: [{ key: 'region', value: 'eu' }] };
    c.items = [
        { ...newRequest('Login'), id: 'login', method: 'POST', url: '/login', extract: [{ variable: 'token', from: 'json', path: '$.token' }] },
        { ...newRequest('Create order'), id: 'create', method: 'POST', url: '/orders?r={{region}}', headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }], extract: [{ variable: 'orderId', from: 'json', path: '$.id' }] },
        { kind: 'folder', id: 'f', name: 'Checks', items: [
            { ...newRequest('Get order'), id: 'get', url: '/orders/{{orderId}}', headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }], scripts: { test: "if (pm.response.json().state !== 'done') postman.setNextRequest('Get order');" } },
        ] },
        { ...newRequest('Health'), id: 'health', url: '/health/{{probe}}' },
    ] as ApiCollection['items'];
    const f = collectionFlow(c);
    assert.deepEqual(f.nodes.map((n) => [n.id, n.column, n.row, n.scenario, n.folder]), [['login', 0, 0, 0, ''], ['create', 1, 0, 0, ''], ['get', 2, 0, 0, 'Checks'], ['health', 0, 1, 1, '']]);
    assert.deepEqual(f.edges.filter((e) => e.kind === 'value').map((e) => `${e.from}->${e.to}:${e.label}`), ['login->create:token', 'create->get:orderId', 'login->get:token']);
    assert.deepEqual(f.edges.filter((e) => e.kind === 'jump').map((e) => `${e.from}->${e.to}:${e.label}`), ['get->get:again']);
    assert.deepEqual(f.unresolved, [{ request: 'Health', name: 'probe' }]);
    assert.deepEqual(f.scenarios.map((s) => s.name), ['Login, then Create order, then Get order', 'Health']);
    // The same scenarios as the feature written from the collection.
    const scen = [...toFeature(c).text.matchAll(/Scenario: (.+)/g)].map((m) => m[1]);
    assert.deepEqual(scen, f.scenarios.map((s) => s.name));
});
