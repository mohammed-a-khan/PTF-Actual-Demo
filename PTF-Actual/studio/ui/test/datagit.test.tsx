import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import './support/browser-stub';
import { asciiDigits, charCount, plural, resolveRouteTab } from '../src/datagit-common';
import { tagNameProblem } from '../src/pages/Branches';
import { networkToSave, pacUrlProblem, proxyUrlProblem } from '../src/pages/NetworkSettings';
import { settingNameProblem } from '../src/pages/Environments';
import { webhookProblem } from '../src/pages/Notifications';
import { dbHome, parseDbRoute, queryNameDropped, queryNameProblem } from '../src/pages/Database';
import { variableGroupProblem } from '../src/pages/PipelineSecrets';
import { identityEmailProblem, identityNameProblem } from '../src/pages/Settings';
import type { NetworkSettings } from '../src/api';

test('words and counts: "1 day", characters as people count them, digits of other scripts', () => {
    assert.equal(plural(1, 'day'), '1 day');
    assert.equal(plural(3, 'day'), '3 days');
    assert.equal(charCount('v 订单😀'), 5);
    assert.equal(asciiDigits('١٢٣٤'), '1234');
    assert.equal(asciiDigits('۴۷۱۹'), '4719');
    assert.equal(asciiDigits('abc'), 'abc');
});

test('inline checks say what the server would refuse', () => {
    assert.match(tagNameProblem('-x', [], [])!, /must not start with "-"/);
    assert.match(tagNameProblem('bad-name', ['bad-name'], [])!, /branch is named/);
    assert.match(tagNameProblem('v1', [], ['v1'])!, /exists already/);
    assert.equal(tagNameProblem('订单', [], []), null);
    assert.equal(tagNameProblem('release/1.0', [], []), null);
    assert.match(proxyUrlProblem('http://' + 'a'.repeat(3000))!, /too long/);
    assert.equal(proxyUrlProblem('http://proxy.corp:8080'), null);
    assert.match(pacUrlProblem('')!, /PAC file address/);
    for (const k of ['   ', 'bad key!', '订单', '1ABC', 'A'.repeat(300)]) assert.ok(settingNameProblem(k), k);
    assert.equal(settingNameProblem('BASE_URL'), null);
    assert.match(webhookProblem('webhook', 'not a url')!, /Not a web address/);
    assert.equal(webhookProblem('webhook', 'https://example.invalid/hook'), null);
    assert.match(queryNameProblem('../../evil')!, /No "\/"/);
    assert.equal(queryNameProblem('active customers'), null);
});

test('network: a hidden, invalid proxy address goes back as saved, so Off and PAC save', () => {
    const saved: NetworkSettings = { proxyMode: 'off', proxyUrl: '', proxyUser: '', bypass: [], useSystemCerts: false, caFile: '', certsForTestRuns: true };
    const typed = { ...saved, proxyMode: 'off' as const, proxyUrl: 'http://' + 'a'.repeat(3000) };
    assert.equal(networkToSave(typed, saved).proxyUrl, '');
    assert.equal(networkToSave({ ...typed, proxyUrl: 'http://ok:1' }, saved).proxyUrl, 'http://ok:1');
    assert.equal(networkToSave({ ...typed, proxyMode: 'manual' }, saved).proxyUrl, typed.proxyUrl);
});

test('pipeline variable group: what is allowed, said as you type', () => {
    assert.equal(variableGroupProblem('{project}-{env}-secrets'), null);
    assert.match(variableGroupProblem('{bogus}-x')!, /\{bogus\} is not a placeholder/);
    assert.match(variableGroupProblem('订单-{env}')!, /"订" is not allowed: use Latin letters/);
    assert.match(variableGroupProblem('bad/name')!, /"\/" is not allowed/);
    assert.match(variableGroupProblem('x'.repeat(500))!, /at most 120 characters \(it has 500\)/);
    assert.match(variableGroupProblem('   ')!, /Give the variable group a name/);
    assert.match(variableGroupProblem('a{env')!, /on its own/);
});

test('git identity: the same limits as the server', () => {
    assert.equal(identityNameProblem('Ann 订单'), null);
    assert.match(identityNameProblem('x'.repeat(101))!, /at most 100 characters/);
    assert.match(identityNameProblem('Ann\u202Eevil')!, /direction marks/);
    assert.match(identityEmailProblem('')!, /Enter your email address/);
    assert.equal(identityEmailProblem('ann@lab.test'), null);
});

test('addresses: Database tabs are not query names; old query links still open; inner tabs fall back to a valid one', () => {
    assert.deepEqual(parseDbRoute(['history']), { kind: 'tabs', side: null, result: 'history', valid: false });
    assert.deepEqual(parseDbRoute(['saved']), { kind: 'tabs', side: 'saved', result: 'result', valid: true });
    assert.deepEqual(parseDbRoute(['objects', 'history']), { kind: 'tabs', side: 'objects', result: 'history', valid: true });
    assert.deepEqual(parseDbRoute(['q', 'test', 'shop', 'queries', 'a.sql']), { kind: 'query', file: 'test/shop/queries/a.sql' });
    assert.deepEqual(parseDbRoute(['test', 'shop', 'queries', 'a.sql']), { kind: 'query', file: 'test/shop/queries/a.sql', legacy: true });
    assert.equal(parseDbRoute(['bogus']).kind, 'tabs');
    assert.deepEqual(dbHome('saved', 'history'), ['db', 'saved', 'history']);
    assert.deepEqual(queryNameDropped('qa4 订单 😀'), ['😀']);
    assert.deepEqual(resolveRouteTab('recent', ['channels', 'recent'], 'channels'), { tab: 'recent', fix: false });
    assert.deepEqual(resolveRouteTab(undefined, ['channels', 'recent'], 'recent'), { tab: 'recent', fix: true });
    assert.deepEqual(resolveRouteTab('bogus', ['channels', 'recent'], 'recent'), { tab: 'channels', fix: true });
    assert.deepEqual(resolveRouteTab('log', ['channels', 'recent'], 'channels', { log: 'recent' }), { tab: 'recent', fix: true });
});
