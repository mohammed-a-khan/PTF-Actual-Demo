import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runConfigsChange } from '../src/server/server';

test('the activity log says what a save of the saved runs did (not "Saved 0 run configuration(s)")', () => {
    const a = { name: 'Smoke', request: { project: 'p', env: 'qa' } };
    const b = { name: 'Nightly', request: { project: 'p', env: 'qa' } };
    assert.equal(runConfigsChange([], [a]), 'Saved run added: "Smoke"');
    assert.equal(runConfigsChange([a, b], [b]), 'Saved run deleted: "Smoke"');
    assert.equal(runConfigsChange([a], []), 'Saved run deleted: "Smoke"');
    assert.equal(runConfigsChange([a], [{ ...a, request: { project: 'p', env: 'uat' } }]), 'Saved run replaced: "Smoke"');
    assert.equal(runConfigsChange([a], [b]), 'Saved run added: "Nightly"; Saved run deleted: "Smoke"');
    assert.match(runConfigsChange([a], [a]), /unchanged/);
});

test('saved runs and the quality gate: a second tab is refused (409), Overwrite (force) saves; the gate takes whole numbers only', async () => {
    const { createServer } = await import('../src/server/server');
    const { runGit } = await import('../src/git/run');
    const { SecretStore } = await import('../src/secrets/store');
    const { KeyFileProtector } = await import('../src/secrets/protector');
    const { ActivityLog } = await import('../src/core/activity');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa5t-'));
    try {
        const dir = path.join(tmp, 'shop-tests');
        await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        const w = (p: string, t: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); };
        w('config/shop/common/common.env', 'PROJECT=shop\n');
        w('config/shop/environments/qa.env', 'BASE_URL=http://localhost\n');
        const home = path.join(tmp, 'home');
        const store = new SecretStore(home, new KeyFileProtector(path.join(home, 'keys', 'secrets.key')));
        const srv = createServer({ repoRoot: dir, store, userName: 'T', token: 'tk', activity: new ActivityLog(home) });
        const call = async (method: string, url: string, payload?: unknown) => { const r = await srv.app.inject({ method: method as never, url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload: payload as never } : {}) }); return { status: r.statusCode, json: r.json() as any }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
        const cfg = (name: string) => ({ name, request: { project: 'shop', env: 'qa' } });

        // Saved runs: both tabs read the same version; A saves, B's save is refused, B's Overwrite saves.
        const v0 = (await call('GET', '/api/run-configs')).json.version;
        const a = await call('PUT', '/api/run-configs', { configs: [cfg('A')], version: v0 });
        assert.equal(a.status, 200);
        const b = await call('PUT', '/api/run-configs', { configs: [cfg('B')], version: v0 });
        assert.equal(b.status, 409);
        assert.match(b.json.error, /another tab/);
        const forced = await call('PUT', '/api/run-configs', { configs: [cfg('B')], version: v0, force: true });
        assert.equal(forced.status, 200);
        assert.deepEqual(forced.json.configs.map((c: { name: string }) => c.name), ['B']);
        const del = await call('PUT', '/api/run-configs', { configs: [], version: forced.json.version });
        assert.equal(del.status, 200);
        const log = (await call('GET', '/api/activity')).json as Array<{ action: string; summary: string }>;
        const runLog = log.filter((e) => e.action === 'run.configs').map((e) => e.summary);
        assert.ok(runLog.includes('Saved run deleted: "B"'), runLog.join(' | '));
        assert.ok(runLog.includes('Saved run added: "A"'), runLog.join(' | '));
        assert.ok(!runLog.some((x) => /Saved 0/.test(x)));

        // The quality gate: its version comes with the report; a stale save is refused, force overwrites.
        const q0 = (await call('GET', '/api/quality')).json;
        assert.equal(typeof q0.settingsVersion, 'string');
        const g = { noNewFailures: true, ignoreQuarantined: true, maxFlaky: null };
        const ga = await call('PUT', '/api/quality/gate', { ...g, minPassRate: 10, version: q0.settingsVersion });
        assert.equal(ga.status, 200, JSON.stringify(ga.json));
        assert.equal(ga.json.minPassRate, 10);
        const gb = await call('PUT', '/api/quality/gate', { ...g, minPassRate: 20, version: q0.settingsVersion });
        assert.equal(gb.status, 409, 'the second tab is refused, not saved over the first');
        assert.equal((await call('GET', '/api/quality')).json.settings.minPassRate, 10);
        const gf = await call('PUT', '/api/quality/gate', { ...g, minPassRate: 20, version: q0.settingsVersion, force: true });
        assert.equal(gf.status, 200);
        assert.equal((await call('GET', '/api/quality')).json.settings.minPassRate, 20);
        // Not rounded: 12.5 and a fractional flaky limit are refused with a message.
        const frac = await call('PUT', '/api/quality/gate', { ...g, minPassRate: 12.5 });
        assert.equal(frac.status, 400);
        assert.match(frac.json.error, /whole number from 0 to 100/);
        assert.equal((await call('PUT', '/api/quality/gate', { ...g, minPassRate: 50, maxFlaky: 1.5 })).status, 400);
        assert.equal((await call('PUT', '/api/quality/gate', { ...g, minPassRate: 150 })).status, 400);
        assert.equal((await call('GET', '/api/quality')).json.settings.minPassRate, 20, 'nothing refused was saved');
        // A caller that sends no version saves as before.
        assert.equal((await call('PUT', '/api/quality/gate', { ...g, minPassRate: 0 })).status, 200);
        await srv.app.close();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
