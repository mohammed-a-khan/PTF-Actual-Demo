import './support/browser-stub';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { groupSlug, problemGroups, tabFor } from '../src/pages/Health';

const GROUPS = ['This computer', 'Repository', 'cart / qa'];

test('Health tabs have friendly addresses, and the old keys still open them', () => {
    assert.deepEqual(GROUPS.map(groupSlug), ['this-computer', 'repository', 'cart-qa']);
    assert.equal(tabFor('repository', GROUPS), 'repository');
    assert.equal(tabFor('this-computer', GROUPS), 'this-computer');
    assert.equal(tabFor('g:This computer', GROUPS), 'this-computer', 'old key');
    assert.equal(tabFor('g:Repository', GROUPS), 'repository', 'old key');
    assert.equal(tabFor('project', GROUPS), 'cart-qa', 'old key of the project tab');
    assert.equal(tabFor('nope', GROUPS), 'problems', 'an unknown tab shows what needs attention');
    assert.equal(tabFor('problems', GROUPS), 'problems');
});

test('"Needs attention": one heading per group, errors first', () => {
    const c = (id: string, group: string, level: 'error' | 'warning') => ({ id, group, level });
    const out = problemGroups([c('w1', 'cart / qa', 'warning'), c('e0', 'This computer', 'error'), c('w2', 'cart / qa', 'warning'), c('w3', 'Repository', 'warning'), c('e1', 'cart / qa', 'error')]);
    assert.deepEqual(out.map((g) => g.group), ['cart / qa', 'This computer', 'Repository'], 'groups with an error first (in the order found), then warnings only');
    assert.deepEqual(out[0].list.map((x) => x.id), ['e1', 'w1', 'w2'], 'errors before warnings in a group');
    assert.equal(out.reduce((n, g) => n + g.list.length, 0), 5, 'every problem once');
});
