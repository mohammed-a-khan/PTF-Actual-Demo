import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { missingKeys, nodeCheck, usedConfigKeys } from '../src/doctor/doctor';

test('usedConfigKeys / missingKeys: keys the features and steps use that the environment does not set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    try {
        const w = (p: string, t: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); };
        w('test/shop/features/a.feature', 'Given I open "{config:BASE_URL}/login" as "{config:ADMIN_USER}"\n');
        w('test/shop/steps/s.steps.ts', "const t = config.get('ORDER_API_TIMEOUT'); CSConfigurationManager.getInstance().getNumber('RETRY_WAIT');\n");
        w('node_modules/x/y.ts', "config.get('IGNORED_KEY')\n");
        const used = usedConfigKeys(dir);
        assert.deepEqual([...used.keys()].sort(), ['ADMIN_USER', 'BASE_URL', 'ORDER_API_TIMEOUT', 'RETRY_WAIT']);
        assert.equal(used.get('ADMIN_USER'), 'test/shop/features/a.feature');
        assert.deepEqual(missingKeys(used, new Set(['BASE_URL', 'ADMIN_USER']), new Set(['RETRY_WAIT'])).map((m) => m.key), ['ORDER_API_TIMEOUT']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('nodeCheck: 20+ fine, 18 works, older refused', () => {
    assert.equal(nodeCheck('v22.1.0').level, 'ok');
    assert.equal(nodeCheck('v18.19.0').level, 'warning');
    assert.equal(nodeCheck('v16.20.0').level, 'error');
});

test('doctor route: checks per project/environment, an address that does not answer, hooks installed by the fix', async () => {
    const { createServer } = await import('../src/server/server');
    const { runGit } = await import('../src/git/run');
    const { SecretStore } = await import('../src/secrets/store');
    const { KeyFileProtector } = await import('../src/secrets/protector');
    const http = await import('http');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docr-'));
    const up = http.createServer((_q, r) => { r.statusCode = 401; r.end(); });
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
    try {
        const dir = path.join(tmp, 'shop-tests');
        await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        const w = (p: string, t: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); };
        w('config/shop/common/common.env', 'PROJECT=shop\n');
        w('config/shop/environments/qa.env', `BASE_URL=http://127.0.0.1:${(up.address() as { port: number }).port}\nAPI_BASE_URL=http://127.0.0.1:1\n`);
        w('test/shop/features/a.feature', 'Given I log in as "{config:QA_USER}"\n');
        const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
        const srv = createServer({ repoRoot: dir, store, userName: 'T', token: 'tk' });
        const call = async (method: string, url: string, payload?: unknown) => { const r = await srv.app.inject({ method: method as never, url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload: payload as never } : {}) }); return { status: r.statusCode, json: r.json() as any }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
        const d = await call('GET', '/api/doctor?project=shop&env=qa');
        assert.equal(d.status, 200, JSON.stringify(d.json));
        const by = (id: string) => d.json.checks.find((c: { id: string }) => c.id === id);
        assert.equal(by('framework').level, 'error', 'no framework in this repository');
        assert.equal(by('keys').level, 'warning');
        assert.match(by('keys').detail, /QA_USER \(test\/shop\/features\/a\.feature\)/);
        assert.equal(by('url-BASE_URL').level, 'ok', JSON.stringify(by('url-BASE_URL')));
        assert.equal(by('url-API_BASE_URL').level, 'error');
        assert.equal(by('hooks').fix.action, 'install-hooks');
        const fixed = await call('POST', '/api/doctor/fix', { action: 'install-hooks' });
        assert.equal(fixed.status, 200, JSON.stringify(fixed.json));
        assert.ok(fs.readFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), 'utf8').includes('cs-test-studio'));
        assert.equal((await call('GET', '/api/doctor?project=shop&env=qa')).json.checks.find((c: { id: string }) => c.id === 'hooks').level, 'ok');
        await srv.app.close();
    } finally { up.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
