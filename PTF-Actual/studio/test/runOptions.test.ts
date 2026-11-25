import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildArgs, runEnvOf } from '../src/run/runner';

test('run options: retries as --retry, device, window and this run\'s values as configuration; bad values refused', () => {
    const base = { project: 'shop', env: 'qa' };
    assert.deepEqual(buildArgs({ ...base, retries: 2 }), ['--project=shop', '--env=qa', '--retry=2']);
    assert.deepEqual(buildArgs({ ...base, retries: 0 }), ['--project=shop', '--env=qa', '--retry=0'], '0 is sent: it wins over RETRY_COUNT');
    assert.throws(() => buildArgs({ ...base, retries: 9 }), /0 to 5/);
    assert.deepEqual(runEnvOf({ ...base, device: 'iPhone 15', viewport: { width: 1280, height: 720 }, variables: { BASE_URL: 'https://qa2.example.test', FEATURE_X: 'true' } }),
        { BROWSER_DEVICE: 'iPhone 15', BROWSER_VIEWPORT_WIDTH: '1280', BROWSER_VIEWPORT_HEIGHT: '720', BASE_URL: 'https://qa2.example.test', FEATURE_X: 'true' });
    assert.throws(() => buildArgs({ ...base, device: 'x; rm -rf /' }), /device/);
    assert.throws(() => buildArgs({ ...base, viewport: { width: 10, height: 720 } }), /200 to 7680/);
    assert.throws(() => buildArgs({ ...base, variables: { 'base-url': 'x' } }), /not a configuration key/);
    assert.throws(() => buildArgs({ ...base, variables: { NODE_OPTIONS: '--require x' } }), /cannot be set per run/);
    assert.throws(() => buildArgs({ ...base, variables: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`K${i}`, 'v'])) }), /At most 40/);
});

test('runs against a protected environment need a confirmation; run configurations are shared in the repository', async () => {
    const { createServer } = await import('../src/server/server');
    const { runGit } = await import('../src/git/run');
    const { SecretStore } = await import('../src/secrets/store');
    const { KeyFileProtector } = await import('../src/secrets/protector');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runopt-'));
    try {
        const dir = path.join(tmp, 'shop-tests');
        await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        const w = (p: string, t: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); };
        w('config/shop/common/common.env', 'PROJECT=shop\n');
        w('config/shop/environments/qa.env', 'BASE_URL=http://localhost\n');
        w('config/shop/environments/prod.env', 'BASE_URL=https://shop.example.test\n');
        w('config/shop/environments/uat.env', 'BASE_URL=https://uat.example.test\nSTUDIO_PROTECTED=true\n');
        const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
        const srv = createServer({ repoRoot: dir, store, userName: 'T', token: 'tk' });
        const call = async (method: string, url: string, payload?: unknown) => { const r = await srv.app.inject({ method: method as never, url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload: payload as never } : {}) }); return { status: r.statusCode, json: r.json() as any }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
        const prod = await call('POST', '/api/runs', { project: 'shop', env: 'prod', tags: '@smoke' });
        assert.equal(prod.status, 409);
        assert.equal(prod.json.code, 'run-protected');
        assert.match(prod.json.error, /production/);
        const uat = await call('POST', '/api/runs', { project: 'shop', env: 'uat' });
        assert.equal(uat.status, 409, 'STUDIO_PROTECTED=true in the environment');
        assert.equal((await call('POST', '/api/runs', { project: 'shop', env: 'qa', variables: { PATH: 'x' } })).status, 400);
        assert.deepEqual((await call('GET', '/api/run-configs')).json, { configs: [], file: '.cs-studio/run-configurations.json' });
        const saved = await call('PUT', '/api/run-configs', { configs: [{ name: 'Smoke on QA (mobile)', request: { project: 'shop', env: 'qa', tags: '@smoke', device: 'Pixel 7', retries: 1, debug: { steps: true } } }] });
        assert.equal(saved.status, 200, JSON.stringify(saved.json));
        assert.deepEqual(saved.json.configs[0].request, { project: 'shop', env: 'qa', tags: '@smoke', device: 'Pixel 7', retries: 1 }, 'debug settings are not saved');
        assert.ok(fs.existsSync(path.join(dir, '.cs-studio/run-configurations.json')));
        assert.equal((await call('PUT', '/api/run-configs', { configs: [{ name: 'A', request: { project: 'shop', env: 'qa' } }, { name: 'a', request: { project: 'shop', env: 'qa' } }] })).status, 400, 'names are unique');
        assert.equal((await call('PUT', '/api/run-configs', { configs: [{ name: 'B', request: { project: 'shop', env: 'qa', retries: 99 } }] })).status, 400);
        await srv.app.close();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
