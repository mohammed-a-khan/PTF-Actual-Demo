/**
 * QA round 5 (data / source control screens): two tabs saving the same saved query, the same setting or the same
 * secret are refused (409) instead of silently overwriting; a refusal says the version saved now (Keep editing) and
 * force saves over it (Overwrite). Push and Rename say the plain reason (no remote; the name is taken).
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
import { checkVersion, StaleSaveError } from '../src/core/version';
import { checkUnchanged, currentValue } from '../src/env/edit';

async function studio() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-saves5-'));
    const dir = path.join(tmp, 'repo');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    const w = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
    w('config/shop/common/common.env', 'PROJECT_NAME=shop\nAPPLICATION_NAME=ORDERS\n');
    w('config/shop/environments/qa.env', 'ENVIRONMENT=qa\n');
    w('test/shop/queries/orders.sql', 'select 1\n');
    const home = path.join(tmp, 'home');
    const store = new SecretStore(home, new KeyFileProtector(path.join(home, 'keys', 'secrets.key')));
    store.set({ name: 'SETUP', project: 'repo' }, 'x');
    const s = createServer({ repoRoot: dir, store, userName: 'T', projectId: 'repo', home });
    const auth = { authorization: `Bearer ${s.token}` };
    const call = async (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) => {
        const r = await s.app.inject({ method, url, headers: auth, ...(payload !== undefined ? { payload: payload as object } : {}) });
        return { status: r.statusCode, json: r.json() as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    return { s, dir, call, done: async () => { await s.app.close(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

test('checkVersion: force skips the check; a refusal carries the version saved now', () => {
    assert.doesNotThrow(() => checkVersion('old', 'abc', true));
    assert.throws(() => checkVersion('old', 'abc'), (e: unknown) => e instanceof StaleSaveError && e.current === 'abc');
});

test('saved query: a stale tab is refused with the current version; Keep editing (that version) and Overwrite (force) save', async () => {
    const t = await studio();
    try {
        const file = 'test/shop/queries/orders.sql';
        const r = await t.call('GET', `/api/db/query-file?file=${encodeURIComponent(file)}`);
        const v0 = r.json.version as string;
        assert.ok(v0);
        const a = await t.call('PUT', '/api/db/query-file', { project: 'shop', file, text: 'select 1 -- from A\n', version: v0 });
        assert.equal(a.status, 200, JSON.stringify(a.json));
        assert.notEqual(a.json.version, v0);
        const b = await t.call('PUT', '/api/db/query-file', { project: 'shop', file, text: 'select 1 -- from B\n', version: v0 });
        assert.equal(b.status, 409);
        assert.equal(b.json.code, 'stale');
        assert.equal(b.json.version, a.json.version, 'the refusal says the version saved now');
        assert.equal(fs.readFileSync(path.join(t.dir, file), 'utf8'), 'select 1 -- from A\n');
        // Keep editing: the next save sends the version from the refusal and goes through.
        const b2 = await t.call('PUT', '/api/db/query-file', { project: 'shop', file, text: 'select 1 -- from B\n', version: b.json.version });
        assert.equal(b2.status, 200);
        // Overwrite: force over a stale version.
        const c = await t.call('PUT', '/api/db/query-file', { project: 'shop', file, text: 'select 2\n', version: v0, force: true });
        assert.equal(c.status, 200);
        assert.equal(fs.readFileSync(path.join(t.dir, file), 'utf8'), 'select 2\n');
        // Deleted in another tab: a save with the old version is refused, not silently written again.
        await t.call('DELETE', `/api/db/query-file?file=${encodeURIComponent(file)}&confirm=true`);
        const d = await t.call('PUT', '/api/db/query-file', { project: 'shop', file, text: 'select 3\n', version: c.json.version });
        assert.equal(d.status, 409);
        assert.equal(fs.existsSync(path.join(t.dir, file)), false);
        // No version (a script): saved as before.
        assert.equal((await t.call('PUT', '/api/db/query-file', { project: 'shop', file, text: 'select 4\n' })).status, 200);
    } finally { await t.done(); }
});

test('environment setting: a change from a tab that showed an older value is refused; force saves; delete too', async () => {
    const t = await studio();
    try {
        const file = 'config/shop/common/common.env';
        const a = await t.call('PUT', '/api/env/value', { file, key: 'APPLICATION_NAME', value: 'ORDERS_A', was: 'ORDERS' });
        assert.equal(a.status, 200, JSON.stringify(a.json));
        const b = await t.call('PUT', '/api/env/value', { file, key: 'APPLICATION_NAME', value: 'ORDERS_B', was: 'ORDERS' });
        assert.equal(b.status, 409);
        assert.equal(b.json.code, 'stale');
        assert.match(b.json.error, /APPLICATION_NAME in config\/shop\/common\/common\.env changed in another tab/);
        assert.equal(currentValue(t.dir, file, 'APPLICATION_NAME'), 'ORDERS_A');
        assert.equal((await t.call('PUT', '/api/env/value', { file, key: 'APPLICATION_NAME', value: 'ORDERS_B', was: 'ORDERS', force: true })).status, 200);
        assert.equal(currentValue(t.dir, file, 'APPLICATION_NAME'), 'ORDERS_B');
        // A new setting the screen did not see (null) that another tab added meanwhile.
        await t.call('PUT', '/api/env/value', { file, key: 'NEW_ONE', value: 'x', was: null });
        assert.equal((await t.call('PUT', '/api/env/value', { file, key: 'NEW_ONE', value: 'y', was: null })).status, 409);
        // Secret reference over a changed value; delete of a changed value.
        assert.equal((await t.call('POST', '/api/env/secret', { file, key: 'APPLICATION_NAME', secretName: 'APP_NAME', value: 's', was: 'ORDERS' })).status, 409);
        assert.equal((await t.call('DELETE', `/api/env/value?file=${encodeURIComponent(file)}&key=APPLICATION_NAME&was=ORDERS`)).status, 409);
        assert.equal((await t.call('DELETE', `/api/env/value?file=${encodeURIComponent(file)}&key=APPLICATION_NAME&was=ORDERS_B`)).status, 200);
        assert.equal(currentValue(t.dir, file, 'APPLICATION_NAME'), null);
        // No "was" (a script): saved as before.
        assert.doesNotThrow(() => checkUnchanged(t.dir, file, 'APPLICATION_NAME', undefined));
    } finally { await t.done(); }
});

test('secrets: Add of a name added elsewhere, and Replace of one deleted elsewhere, are refused; without expect saved', async () => {
    const t = await studio();
    try {
        assert.equal((await t.call('PUT', '/api/secrets', { name: 'QA5_TMP', value: 'one', expect: 'new' })).status, 200);
        const again = await t.call('PUT', '/api/secrets', { name: 'QA5_TMP', value: 'two', expect: 'new' });
        assert.equal(again.status, 409);
        assert.match(again.json.error, /QA5_TMP was added in another tab/);
        assert.equal((await t.call('PUT', '/api/secrets', { name: 'QA5_TMP', value: 'two', expect: 'existing' })).status, 200);
        await t.call('DELETE', '/api/secrets?name=QA5_TMP');
        const gone = await t.call('PUT', '/api/secrets', { name: 'QA5_TMP', value: 'three', expect: 'existing' });
        assert.equal(gone.status, 409);
        assert.match(gone.json.error, /deleted in another tab/);
        assert.equal((await t.call('GET', '/api/secrets')).json.some((x: { name: string }) => x.name === 'QA5_TMP'), false);
        assert.equal((await t.call('PUT', '/api/secrets', { name: 'QA5_TMP', value: 'three' })).status, 200);
    } finally { await t.done(); }
});

test('notifications, pipeline and network: force saves over a stale version (Overwrite)', async () => {
    const t = await studio();
    try {
        const p0 = (await t.call('GET', '/api/pipeline/settings')).json.version;
        await t.call('PUT', '/api/pipeline/settings', { variableGroup: 'team-a', version: p0 });
        const stale = await t.call('PUT', '/api/pipeline/settings', { variableGroup: 'team-b', version: p0 });
        assert.equal(stale.status, 409);
        assert.ok(stale.json.version);
        assert.equal((await t.call('PUT', '/api/pipeline/settings', { variableGroup: 'team-b', version: stale.json.version })).status, 200);
        assert.equal((await t.call('PUT', '/api/pipeline/settings', { variableGroup: 'team-c', version: p0, force: true })).status, 200);
        const n0 = (await t.call('GET', '/api/notifications')).json.version;
        await t.call('PUT', '/api/notifications', { channels: [], webhooks: {}, version: n0 });
        assert.equal((await t.call('PUT', '/api/notifications', { channels: [{ id: 'chana1', name: 'A', kind: 'webhook', when: 'failures', enabled: true }], webhooks: { chana1: 'http://127.0.0.1:9/a' }, version: 'old' })).status, 409);
        assert.equal((await t.call('PUT', '/api/notifications', { channels: [{ id: 'chana1', name: 'A', kind: 'webhook', when: 'failures', enabled: true }], webhooks: { chana1: 'http://127.0.0.1:9/a' }, version: 'old', force: true })).status, 200);
        const net = (await t.call('GET', '/api/settings')).json;
        assert.equal((await t.call('PUT', '/api/settings/network', { ...net.network, proxyMode: 'environment', version: 'old' })).status, 409);
        assert.equal((await t.call('PUT', '/api/settings/network', { ...net.network, proxyMode: 'environment', version: 'old', force: true })).status, 200);
    } finally { await t.done(); }
});

test('push with no remote says so (before any secret scan); rename onto an existing branch gives no "switch to it" advice', async () => {
    const t = await studio();
    try {
        await runGit(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'add', '-A'], { cwd: t.dir });
        await runGit(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'one'], { cwd: t.dir });
        await runGit(['branch', 'other'], { cwd: t.dir });
        const p = await t.call('POST', '/api/git/push', {});
        assert.equal(p.json.status, 'rejected');
        assert.match(p.json.message, /no remote to push to/);
        const tag = await t.call('POST', '/api/git/tags/push', { name: 'v1' });
        assert.equal(tag.status, 400);
        assert.match(tag.json.error, /no remote to push to/);
        const r = await t.call('POST', '/api/git/branch/rename', { from: 'other', to: 'main' });
        assert.notEqual(r.status, 200);
        assert.match(r.json.error, /exists already: choose another name\.$/);
    } finally { await t.done(); }
});
