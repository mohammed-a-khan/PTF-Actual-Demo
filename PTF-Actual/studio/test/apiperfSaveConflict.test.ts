/** Two tabs saving the same collection or load scenario: a save carries the version it read, and a save over a version changed meanwhile is refused (409) unless forced. Also: a new monitor needs a name; the load-shape curve without ramp-down. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createServer } from '../src/server/server';
import { SecretStore } from '../src/secrets/store';
import { KeyFileProtector } from '../src/secrets/protector';
import { runGit } from '../src/git/run';
import { newCollection, newRequest } from '../src/api/model';
import { newScenario } from '../src/load/scenario';
import { policyCurve } from '../src/load/policy';
import { CHANGED_ELSEWHERE, staleSave, takeSaveMeta } from '../src/api/store';

async function studio() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-conflict-'));
    const dir = path.join(tmp, 'repo');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    const w = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
    w('config/shop/common/common.env', 'PROJECT_NAME=shop\n');
    w('config/shop/environments/qa.env', 'ENVIRONMENT=qa\n');
    const c = { ...newCollection('Orders'), baseUrl: 'http://127.0.0.1:9', items: [{ ...newRequest('List'), id: 'r1', url: '/orders' }] };
    w('test/shop/api/orders.collection.json', JSON.stringify(c, null, 2) + '\n');
    w('test/shop/load/orders.load.json', JSON.stringify(newScenario('Orders load', 'test/shop/api/orders.collection.json'), null, 2) + '\n');
    const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
    const srv = createServer({ repoRoot: dir, store, userName: 'T', projectId: 'repo' });
    const headers = { authorization: `Bearer ${srv.token}` };
    const call = async (method: 'GET' | 'PUT', url: string, payload?: object) => { const r = await srv.app.inject({ method, url, headers, ...(payload ? { payload } : {}) }); return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : undefined }; };
    return { dir, call, close: async () => { await srv.app.close(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

test('collection: tab B saving over tab A\'s save gets 409 "Changed in another tab or by someone else"; Overwrite forces it', async () => {
    const s = await studio();
    try {
        const file = 'test/shop/api/orders.collection.json';
        const a = await s.call('GET', `/api/apiws/collection?file=${encodeURIComponent(file)}`);
        const b = await s.call('GET', `/api/apiws/collection?file=${encodeURIComponent(file)}`);
        assert.equal(a.status, 200);
        assert.match(a.json.version, /^[0-9a-f]{16}$/);
        assert.equal(a.json.version, b.json.version);
        // Tab A saves a new URL with the version it read: fine, and it gets the new version.
        const ca = { ...a.json.collection, baseUrl: 'http://127.0.0.1:1111' };
        const sa = await s.call('PUT', '/api/apiws/collection', { project: 'shop', file, collection: { ...ca, $studio: { base: a.json.version } } });
        assert.equal(sa.status, 200, JSON.stringify(sa.json));
        assert.notEqual(sa.json.version, a.json.version);
        assert.ok(!fs.readFileSync(path.join(s.dir, file), 'utf8').includes('$studio'), 'the version is not written into the file');
        // Tab B still has the old version: refused, the file keeps A's change.
        const cb = { ...b.json.collection, name: 'Orders B' };
        const sb = await s.call('PUT', '/api/apiws/collection', { project: 'shop', file, collection: { ...cb, $studio: { base: b.json.version } } });
        assert.equal(sb.status, 409);
        assert.equal(sb.json.error, CHANGED_ELSEWHERE);
        assert.match(fs.readFileSync(path.join(s.dir, file), 'utf8'), /1111/);
        // A saves again with the version it got back: fine.
        const sa2 = await s.call('PUT', '/api/apiws/collection', { project: 'shop', file, collection: { ...ca, description: 'x', $studio: { base: sa.json.version } } });
        assert.equal(sa2.status, 200, JSON.stringify(sa2.json));
        // Overwrite: B forces its version over it.
        const sb2 = await s.call('PUT', '/api/apiws/collection', { project: 'shop', file, collection: { ...cb, $studio: { base: b.json.version, force: true } } });
        assert.equal(sb2.status, 200, JSON.stringify(sb2.json));
        assert.match(fs.readFileSync(path.join(s.dir, file), 'utf8'), /Orders B/);
        // A save without a version (an older client) is not checked.
        assert.equal((await s.call('PUT', '/api/apiws/collection', { project: 'shop', file, collection: ca })).status, 200);
    } finally { await s.close(); }
});

test('load scenario: the second tab\'s stale save is refused (409), Reload gives the saved one, Overwrite forces', async () => {
    const s = await studio();
    try {
        const file = 'test/shop/load/orders.load.json';
        const a = await s.call('GET', `/api/load/scenario?file=${encodeURIComponent(file)}`);
        const b = await s.call('GET', `/api/load/scenario?file=${encodeURIComponent(file)}`);
        assert.equal(a.status, 200, JSON.stringify(a.json));
        assert.ok(a.json.version);
        const users3 = { ...a.json.scenario, policy: { ...a.json.scenario.policy, users: 3 } };
        const sa = await s.call('PUT', '/api/load/scenario', { project: 'shop', file, scenario: { ...users3, $studio: { base: a.json.version } } });
        assert.equal(sa.status, 200, JSON.stringify(sa.json));
        const run6 = { ...b.json.scenario, policy: { ...b.json.scenario.policy, duration: 600 } };
        const sb = await s.call('PUT', '/api/load/scenario', { project: 'shop', file, scenario: { ...run6, $studio: { base: b.json.version } } });
        assert.equal(sb.status, 409);
        assert.equal(sb.json.error, 'Changed in another tab or by someone else');
        // Reload: what tab B now reads is tab A's save (users 3), with its version.
        const again = await s.call('GET', `/api/load/scenario?file=${encodeURIComponent(file)}`);
        assert.equal(again.json.scenario.policy.users, 3);
        assert.equal(again.json.version, sa.json.version);
        const sf = await s.call('PUT', '/api/load/scenario', { project: 'shop', file, scenario: { ...run6, $studio: { base: b.json.version, force: true } } });
        assert.equal(sf.status, 200, JSON.stringify(sf.json));
        assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, file), 'utf8')).policy.duration, 600);
        assert.ok(!fs.readFileSync(path.join(s.dir, file), 'utf8').includes('$studio'));
    } finally { await s.close(); }
});

test('save meta: taken out of the item; a file deleted meanwhile is not a conflict', () => {
    assert.deepEqual(takeSaveMeta({ a: 1, $studio: { base: 'abc', force: true } }), { item: { a: 1 }, meta: { base: 'abc', force: true } });
    assert.deepEqual(takeSaveMeta({ a: 1 }), { item: { a: 1 }, meta: {} });
    assert.equal(staleSave(path.join(os.tmpdir(), 'cs-no-such-file.json'), { base: 'abc' }), null);
});

test('a new monitor without a name is refused (no name taken from the collection)', async () => {
    const s = await studio();
    try {
        const r = await s.call('PUT', '/api/apiws/monitors', { name: '  ', file: 'test/shop/api/orders.collection.json', env: 'qa', everyMinutes: 60, enabled: false });
        assert.equal(r.status, 400);
        assert.equal(r.json.error, 'Give the monitor a name.');
        const ok = await s.call('PUT', '/api/apiws/monitors', { name: 'Orders health', file: 'test/shop/api/orders.collection.json', env: 'qa', everyMinutes: 60, enabled: false });
        assert.equal(ok.status, 200, JSON.stringify(ok.json));
        assert.equal(ok.json.name, 'Orders health');
    } finally { await s.close(); }
});

test('load-shape curve: no ramp-down holds the users to the end, then drops (no slope over the last step)', () => {
    const c = policyCurve({ type: 'constant', users: 2, duration: 5, rampUp: 0, rampDown: 0 });
    assert.deepEqual(c.slice(-3), [{ t: 4, users: 2 }, { t: 5, users: 2 }, { t: 5, users: 0 }]);
    const ramp = policyCurve({ type: 'ramp', users: 10, duration: 20, rampUp: 5, rampDown: 5 });
    assert.equal(ramp.filter((x) => x.t === 20).length, 1, 'with a ramp-down the curve slopes to 0');
    const arrival = policyCurve({ type: 'arrival', users: 5, rate: 4, duration: 3 });
    assert.deepEqual(arrival.slice(-2).map((x) => [x.t, x.rate]), [[3, 4], [3, 0]]);
});
