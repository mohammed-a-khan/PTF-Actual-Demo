import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { collectionNameProblem, collectionSlug, splitUrlQuery } from '../src/components/collectionName';

test('collection names: the file each gives (same as the server), and names refused', () => {
    assert.equal(collectionSlug('Orders API'), 'orders-api');
    assert.equal(collectionSlug('Café Ünïcode'), 'cafe-unicode');
    assert.match(collectionSlug('طلبات'), /^api-[0-9a-z]+$/);
    assert.notEqual(collectionSlug('طلبات'), collectionSlug('订单'), 'two non-Latin names do not share a file');
    assert.equal(collectionSlug('طلبات'), 'api-18ebmk7', 'the same code as the server');
    const taken = [{ file: 'test/shop/api/orders-api.collection.json', name: 'Orders API' }];
    assert.equal(collectionNameProblem('   ', 'shop', taken), 'Give the collection a name.');
    assert.equal(collectionNameProblem('x'.repeat(201), 'shop', taken), 'At most 200 characters.');
    assert.equal(collectionNameProblem('orders api', 'shop', taken), 'A collection "orders api" exists in shop.');
    assert.match(collectionNameProblem('Orders-API!', 'shop', taken)!, /orders-api\.collection\.json exists/);
    assert.equal(collectionNameProblem('Payments', 'shop', taken), null);
    assert.equal(collectionNameProblem('Orders API', 'shop', taken, 'test/shop/api/orders-api.collection.json'), null, 'its own name');
});

test('a query typed in the URL moves to Params', () => {
    assert.equal(splitUrlQuery('/items', []), null);
    assert.deepEqual(splitUrlQuery('/items?q=a b&x=%3Cy%3E&t={{tok}}&flag', [{ key: 'a', value: '1' }]), { url: '/items', query: [{ key: 'a', value: '1' }, { key: 'q', value: 'a b' }, { key: 'x', value: '<y>' }, { key: 't', value: '{{tok}}' }, { key: 'flag', value: '' }] });
});
