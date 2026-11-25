/**
 * Whole-file saves from a screen that read them earlier (two tabs): the save of a stale tab is refused with 409
 * instead of silently dropping what the other tab saved. And the limits on the Git identity.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createServer } from '../src/server/server';
import { SecretStore } from '../src/secrets/store';
import { KeyFileProtector } from '../src/secrets/protector';
import { runGit } from '../src/git/run';
import { identityProblem } from '../src/git/identity';
import { checkVersion, contentVersion, StaleSaveError } from '../src/core/version';

async function studio() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-saves-'));
    const dir = path.join(tmp, 'repo');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    const w = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
    w('config/shop/common/common.env', 'PROJECT_NAME=shop\n');
    w('config/shop/environments/qa.env', 'ENVIRONMENT=qa\n');
    const home = path.join(tmp, 'home');
    const store = new SecretStore(home, new KeyFileProtector(path.join(home, 'keys', 'secrets.key')));
    store.set({ name: 'SETUP', project: 'repo' }, 'x'); // the store exists: webhook addresses can be kept
    const s = createServer({ repoRoot: dir, store, userName: 'T', projectId: 'repo', home });
    const auth = { authorization: `Bearer ${s.token}` };
    const call = async (method: 'GET' | 'PUT', url: string, payload?: unknown) => {
        const r = await s.app.inject({ method, url, headers: auth, ...(payload !== undefined ? { payload: payload as object } : {}) });
        return { status: r.statusCode, json: r.json() as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    return { s, dir, call, done: async () => { await s.app.close(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

test('versions: the same content gives the same version; a stale one is refused, none is accepted', () => {
    assert.equal(contentVersion({ a: 1 }), contentVersion({ a: 1 }));
    assert.notEqual(contentVersion({ a: 1 }), contentVersion({ a: 2 }));
    assert.doesNotThrow(() => checkVersion(undefined, 'abc'));
    assert.doesNotThrow(() => checkVersion('abc', 'abc'));
    assert.throws(() => checkVersion('old', 'abc'), (e: unknown) => e instanceof StaleSaveError && e.statusCode === 409 && /another tab/.test(e.message));
});

test('notifications: a save from a tab that read an older version is refused (409), the other tab\'s channel stays', async () => {
    const t = await studio();
    try {
        const first = await t.call('GET', '/api/notifications');
        assert.equal(first.status, 200);
        const v0 = first.json.version as string;
        assert.ok(v0);
        // Tab A adds a channel.
        const a = await t.call('PUT', '/api/notifications', { channels: [{ id: 'chana1', name: 'From tab A', kind: 'webhook', when: 'failures', enabled: true }], webhooks: { chana1: 'http://127.0.0.1:9/a' }, version: v0 });
        assert.equal(a.status, 200, JSON.stringify(a.json));
        assert.notEqual(a.json.version, v0);
        // Tab B still shows what it read before A saved.
        const b = await t.call('PUT', '/api/notifications', { channels: [{ id: 'chanb1', name: 'From tab B', kind: 'webhook', when: 'always', enabled: true }], webhooks: { chanb1: 'http://127.0.0.1:9/b' }, version: v0 });
        assert.equal(b.status, 409);
        assert.equal(b.json.code, 'stale');
        assert.match(b.json.error, /Changed in another tab or by someone else: reload to see it/);
        const now = await t.call('GET', '/api/notifications');
        assert.deepEqual(now.json.channels.map((c: { name: string }) => c.name), ['From tab A']);
        // After a reload (the current version), B's save goes through.
        const b2 = await t.call('PUT', '/api/notifications', { channels: [...now.json.channels.map(({ hasWebhook: _h, ...c }: { hasWebhook: boolean }) => c), { id: 'chanb1', name: 'From tab B', kind: 'webhook', when: 'always', enabled: true }], webhooks: { chanb1: 'http://127.0.0.1:9/b' }, version: now.json.version });
        assert.equal(b2.status, 200, JSON.stringify(b2.json));
        assert.equal(b2.json.channels.length, 2);
    } finally { await t.done(); }
});

test('pipeline variable group: stale save refused; unknown placeholders, non-Latin letters and too long refused', async () => {
    const t = await studio();
    try {
        const g = await t.call('GET', '/api/pipeline/settings');
        const v0 = g.json.version as string;
        assert.equal(g.json.variableGroup, '{project}-{env}-secrets');
        const a = await t.call('PUT', '/api/pipeline/settings', { variableGroup: 'team-{env}', version: v0 });
        assert.equal(a.status, 200);
        assert.equal(a.json.variableGroup, 'team-{env}');
        const b = await t.call('PUT', '/api/pipeline/settings', { variableGroup: 'other-{env}', version: v0 });
        assert.equal(b.status, 409);
        assert.equal((await t.call('GET', '/api/pipeline/settings')).json.variableGroup, 'team-{env}');
        assert.match((await t.call('PUT', '/api/pipeline/settings', { variableGroup: '{bogus}-x' })).json.error, /\{bogus\} is not a placeholder/);
        assert.match((await t.call('PUT', '/api/pipeline/settings', { variableGroup: '订单-{env}' })).json.error, /Latin letters/);
        assert.match((await t.call('PUT', '/api/pipeline/settings', { variableGroup: 'x'.repeat(500) })).json.error, /at most 120 characters \(it has 500\)/);
        assert.match((await t.call('PUT', '/api/pipeline/settings', { variableGroup: 'bad/name' })).json.error, /cannot contain/);
    } finally { await t.done(); }
});

test('network settings: a stale tab\'s save is refused (409)', async () => {
    const t = await studio();
    try {
        const v0 = (await t.call('GET', '/api/settings')).json.networkVersion as string;
        assert.ok(v0);
        const a = await t.call('PUT', '/api/settings/network', { proxyMode: 'manual', proxyUrl: 'http://proxy.corp:8080', proxyUser: '', useSystemCerts: false, caFile: '', certsForTestRuns: true, version: v0 });
        assert.equal(a.status, 200, JSON.stringify(a.json));
        const b = await t.call('PUT', '/api/settings/network', { proxyMode: 'off', proxyUrl: '', proxyUser: '', useSystemCerts: false, caFile: '', certsForTestRuns: true, version: v0 });
        assert.equal(b.status, 409);
        assert.equal((await t.call('GET', '/api/settings')).json.network.proxyMode, 'manual');
    } finally { await t.done(); }
});

test('git identity: name at most 100 characters, no control or bidi-override characters, email required', async () => {
    assert.equal(identityProblem('Ann Tester', 'ann@lab.test'), null);
    assert.equal(identityProblem('订单 测试 😀', 'ann@lab.test'), null, 'any script');
    assert.equal(identityProblem('x'.repeat(100), 'ann@lab.test'), null);
    assert.match(identityProblem('x'.repeat(101), 'ann@lab.test')!, /at most 100 characters \(it has 101\)/);
    assert.match(identityProblem('Ann‮evil', 'ann@lab.test')!, /direction marks/);
    assert.match(identityProblem('Ann\tTester', 'ann@lab.test')!, /line breaks, tabs/);
    assert.match(identityProblem('Ann', '')!, /Enter your email address/);
    assert.match(identityProblem('Ann', 'not-an-email')!, /valid email/);
    assert.match(identityProblem('Ann <x>', 'ann@lab.test')!, /< or >/);
    assert.match(identityProblem('   ', 'ann@lab.test')!, /Enter your name/);
    const t = await studio();
    try {
        const put = (name: string, email: string) => t.call('PUT', '/api/settings/git-identity', { name, email, scope: 'repository' });
        const long = await put('x'.repeat(500), 'ann@lab.test');
        assert.equal(long.status, 400);
        assert.match(long.json.error, /at most 100 characters \(it has 500\)/);
        assert.equal((await put('Ann‮evil', 'ann@lab.test')).status, 400);
        assert.match((await put('Ann', '')).json.error, /Enter your email address/);
        const ok = await put('Ann Tester', 'ann@lab.test');
        assert.equal(ok.status, 200);
        assert.equal(ok.json.name, 'Ann Tester');
        assert.equal((await runGit(['config', '--local', '--get', 'user.name'], { cwd: t.dir })).stdout.trim(), 'Ann Tester');
    } finally { await t.done(); }
});
