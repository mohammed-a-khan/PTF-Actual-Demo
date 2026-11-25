/**
 * Server tests over real HTTP on 127.0.0.1 (security checks need real Host/Origin headers).
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { createServer, StudioServer } from '../src/server/server';
import { SecretStore } from '../src/secrets/store';
import { KeyFileProtector } from '../src/secrets/protector';
import { runGit } from '../src/git/run';
import { ActivityLog } from '../src/core/activity';
import * as cp from 'child_process';

let tmp: string;
let srv: StudioServer;
let port: number;
let dir: string;
let store: SecretStore;
let activity: ActivityLog;

before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-studio-srv-'));
    dir = path.join(tmp, 'orders-tests');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    await runGit(['config', 'user.name', 'T'], { cwd: dir });
    await runGit(['config', 'user.email', 't@x.invalid'], { cwd: dir });
    store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
    activity = new ActivityLog(path.join(tmp, 'home'), () => store.knownSecrets().map((k) => k.value));
    srv = createServer({ repoRoot: dir, store, userName: 'T', activity });
    port = (await srv.listen(0)).port;
});
after(async () => { await srv.app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function call(method: string, url: string, opts: { body?: unknown; token?: string | null; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
        const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
        const headers: Record<string, string> = { ...(opts.headers ?? {}) };
        if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? srv.token}`;
        if (data) headers['content-type'] = 'application/json';
        const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json: any = text;
                try { json = JSON.parse(text); } catch { /* not json */ }
                resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

test('listens on loopback only', () => {
    const addr = srv.app.server.address();
    assert.ok(addr && typeof addr === 'object' && addr.address === '127.0.0.1');
});

test('token is required and checked', async () => {
    assert.equal((await call('GET', '/api/health', { token: null })).status, 401);
    assert.equal((await call('GET', '/api/health', { token: 'wrong' })).status, 401);
    const ok = await call('GET', '/api/health');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.projectId, 'orders-tests');
    assert.equal(ok.headers['cache-control'], 'no-store');
});

test('foreign Host (DNS rebinding) and foreign Origin are refused', async () => {
    assert.equal((await call('GET', '/api/health', { headers: { host: `evil.example:${port}` } })).status, 421);
    assert.equal((await call('GET', '/api/health', { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call('GET', '/api/health', { headers: { origin: `http://127.0.0.1:${port}` } })).status, 200);
    assert.equal((await call('GET', '/api/health', { headers: { host: `localhost:${port}` } })).status, 200);
});

test('secret values are write-only', async () => {
    const put = await call('PUT', '/api/secrets', { body: { name: 'QA_PASSWORD', value: 'bluehorse42', env: 'qa' } });
    assert.equal(put.status, 200);
    assert.ok(!JSON.stringify(put.json).includes('bluehorse42'));
    const list = await call('GET', '/api/secrets');
    assert.equal(list.json.length, 1);
    assert.equal(list.json[0].project, 'orders-tests');
    assert.ok(!JSON.stringify(list.json).includes('bluehorse42'));
    assert.equal((await call('PUT', '/api/secrets', { body: { name: 'bad name', value: 'x' } })).status, 400);
});

test('commit flow over the API: blocked by a stored secret, fixed by moving it, then committed', async () => {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'qa.env'), 'LOGIN_PASSWORD=bluehorse42\n');
    assert.equal((await call('POST', '/api/git/stage', { body: { paths: ['config/qa.env'] } })).status, 200);
    const blocked = await call('POST', '/api/git/commit', { body: { message: 'qa config' } });
    assert.equal(blocked.json.status, 'blocked');
    assert.equal(blocked.json.findings[0].ruleId, 'known-secret-value');
    assert.ok(!JSON.stringify(blocked.json).includes('bluehorse42'));

    const fix = await call('POST', '/api/scan/fix', { body: { action: 'move-to-store', finding: blocked.json.findings[0], name: 'QA_LOGIN_PASSWORD', env: 'qa' } });
    assert.equal(fix.status, 200, JSON.stringify(fix.json));
    assert.equal(fs.readFileSync(path.join(dir, 'config', 'qa.env'), 'utf8'), 'LOGIN_PASSWORD={env:QA_LOGIN_PASSWORD}\n');
    const done = await call('POST', '/api/git/commit', { body: { message: 'qa config' } });
    assert.equal(done.json.status, 'ok', JSON.stringify(done.json));
    const log = await call('GET', '/api/git/log?limit=5');
    assert.equal(log.json[0].subject, 'qa config');
});

test('input validation and path guard', async () => {
    assert.equal((await call('POST', '/api/git/stage', { body: { paths: [] } })).status, 400);
    assert.equal((await call('GET', '/api/git/diff?file=../../etc/passwd')).status, 400);
    assert.equal((await call('POST', '/api/scan/fix', { body: { action: 'nope' } })).status, 400);
    assert.equal((await call('POST', '/api/git/branch', { body: { name: 'bad..name' } })).status, 400, 'an invalid name is a bad request');
});

test('environments over the API: resolve with injected secrets, store a secret, create, compare', async () => {
    fs.mkdirSync(path.join(dir, 'config/orders/environments'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config/global.env'), 'BASE_URL=http://localhost\n');
    fs.writeFileSync(path.join(dir, 'config/orders/environments/qa.env'), 'BASE_URL=https://qa.example\nDB_PASSWORD=hunter2pw\n');
    const d = await call('GET', '/api/env');
    assert.deepEqual(d.json.projects, ['orders']);

    const before = await call('GET', '/api/env/resolve?project=orders&env=qa');
    assert.ok(before.json.problems.some((p: any) => p.code === 'literal-secret-in-config' && p.key === 'DB_PASSWORD'));
    assert.ok(!JSON.stringify(before.json).includes('hunter2pw'));

    const literal = await call('PUT', '/api/env/value', { body: { file: 'config/orders/environments/qa.env', key: 'DB_PASSWORD', value: 'other-pw' } });
    assert.equal(literal.status, 400);

    const sec = await call('POST', '/api/env/secret', { body: { file: 'config/orders/environments/qa.env', key: 'DB_PASSWORD', secretName: 'QA_DB_PASSWORD', value: 'hunter2pw', env: 'qa' } });
    assert.equal(sec.status, 200, JSON.stringify(sec.json));
    const after = await call('GET', '/api/env/resolve?project=orders&env=qa');
    const entry = after.json.entries.find((e: any) => e.key === 'DB_PASSWORD');
    assert.equal(entry.value, '••••••');
    assert.equal(entry.from.raw, '{env:QA_DB_PASSWORD}');
    assert.ok(!after.json.problems.some((p: any) => p.key === 'DB_PASSWORD'), 'secret is provided, no problem left');

    const created = await call('POST', '/api/env/create', { body: { project: 'orders', name: 'uat', copyFrom: 'qa' } });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    assert.equal((await call('PUT', '/api/env/value', { body: { file: 'config/orders/environments/uat.env', key: 'BASE_URL', value: 'https://uat.example' } })).status, 200);
    const uat = await call('GET', '/api/env/resolve?project=orders&env=uat');
    assert.ok(uat.json.problems.some((p: any) => p.code === 'missing-env-reference'), 'uat has no secret yet');
    const cmp = await call('GET', '/api/env/compare?project=orders&a=qa&b=uat');
    assert.ok(cmp.json.differences.some((x: any) => x.key === 'BASE_URL'));
    assert.equal((await call('GET', '/api/env/resolve?project=../x&env=qa')).status, 400);
    assert.equal((await call('PUT', '/api/env/value', { body: { file: 'src/a.env', key: 'A', value: '1' } })).status, 400);
});

test('activity log records actions without secret values', async () => {
    const res = await call('GET', '/api/activity?limit=50');
    assert.equal(res.status, 200);
    const actions = res.json.map((e: any) => e.action);
    for (const a of ['git.commit', 'secret-scan.blocked', 'secret-scan.fix', 'secret.set', 'env.secret', 'env.create', 'env.set']) assert.ok(actions.includes(a), a);
    const raw = fs.readdirSync(path.join(tmp, 'home', 'activity')).map((f) => fs.readFileSync(path.join(tmp, 'home', 'activity', f), 'utf8')).join('');
    for (const v of ['hunter2pw', 'bluehorse42']) assert.ok(!raw.includes(v), v);
});

test('activity log withholds details if a value slips into them', () => {
    const e = activity.record({ action: 'test', repo: dir, summary: 'oops bluehorse42' });
    assert.ok(!JSON.stringify(e).includes('bluehorse42'));
});

test('pipeline secrets over the API (simulated ADO)', async () => {
    const { createServer } = await import('../src/server/server');
    const calls: string[] = [];
    const groups: any[] = [];
    const transport = async (req: any) => {
        calls.push(`${req.method} ${new URL(req.url).pathname}`);
        const u = new URL(req.url);
        if (req.method === 'GET' && u.pathname.endsWith('/_apis/distributedtask/variablegroups')) return { status: 200, body: JSON.stringify({ value: groups }) };
        if (req.method === 'GET' && u.pathname.includes('/_apis/projects/')) return { status: 200, body: JSON.stringify({ id: 'p1' }) };
        if (req.method === 'POST') { const g = { ...JSON.parse(req.body), id: 1 }; groups.push(g); return { status: 200, body: JSON.stringify(g) }; }
        return { status: 404, body: '' };
    };
    fs.writeFileSync(path.join(dir, 'config/global.env'), 'BASE_URL=http://localhost\nADO_ORGANIZATION=acme\nADO_PROJECT=qa\n');
    // The token comes only from the user's own secret (Settings: "ADO token secret", default ADO_PAT),
    // never from a value the repository's configuration points at.
    store.set({ name: 'ADO_PAT' }, 'pat-1');
    const s2 = createServer({ repoRoot: dir, store, userName: 'T', adoTransport: transport, token: 'tok2' });
    const r1 = await s2.app.inject({ method: 'GET', url: '/api/pipeline/secrets?project=orders&env=qa&check=true', headers: { authorization: 'Bearer tok2' } });
    const d1 = r1.json();
    assert.equal(d1.adoChecked, true, JSON.stringify(d1));
    assert.equal(d1.variableGroup, 'orders-qa-secrets');
    const row = d1.rows.find((r: any) => r.name === 'QA_DB_PASSWORD');
    assert.deepEqual([row.local, row.inAdo], [true, 'missing']);
    const r2 = await s2.app.inject({ method: 'POST', url: '/api/pipeline/secrets/sync', headers: { authorization: 'Bearer tok2' }, payload: { project: 'orders', env: 'qa', names: ['QA_DB_PASSWORD'] } });
    assert.equal(r2.statusCode, 400, 'the user must confirm the host the values go to');
    assert.equal(d1.adoHost, 'dev.azure.com');
    const r2b = await s2.app.inject({ method: 'POST', url: '/api/pipeline/secrets/sync', headers: { authorization: 'Bearer tok2' }, payload: { project: 'orders', env: 'qa', names: ['QA_DB_PASSWORD'], confirmHost: 'evil.example.com' } });
    assert.equal(r2b.statusCode, 400);
    const r2c = await s2.app.inject({ method: 'POST', url: '/api/pipeline/secrets/sync', headers: { authorization: 'Bearer tok2' }, payload: { project: 'orders', env: 'qa', names: ['QA_DB_PASSWORD'], confirmHost: 'dev.azure.com' } });
    assert.equal(r2c.statusCode, 200, r2c.body);
    assert.deepEqual(r2c.json().sent, ['QA_DB_PASSWORD']);
    assert.deepEqual(groups[0].variables, { QA_DB_PASSWORD: { isSecret: true, value: 'hunter2pw' } });
    assert.ok(!r1.body.includes('hunter2pw') && !r2c.body.includes('hunter2pw'), 'values never in API responses');
    await s2.app.close();
});

test('test plans: scenarios become test cases in a suite and are tagged; steps sync (simulated ADO)', async () => {
    const { createServer } = await import('../src/server/server');
    const calls: Array<{ method: string; path: string; body?: string; type?: string }> = [];
    let next = 900;
    const transport = async (req: any) => {
        const u = new URL(req.url);
        calls.push({ method: req.method, path: u.pathname, body: req.body, type: req.headers?.['Content-Type'] });
        if (u.pathname.endsWith('/testplan/plans')) return { status: 200, body: JSON.stringify({ value: [{ id: 7, name: 'Release', state: 'Active', rootSuite: { id: 8 }, areaPath: 'qa', iteration: 'qa\\Sprint 2' }] }) };
        if (req.method === 'POST' && u.pathname.endsWith('/wit/workitems/$Test%20Case')) return { status: 200, body: JSON.stringify({ id: ++next }) };
        if (req.method === 'POST' && u.pathname.endsWith('/testplan/Plans/7/Suites/8/TestCase')) return { status: 200, body: '[]' };
        if (req.method === 'PATCH' && /\/wit\/workitems\/\d+$/.test(u.pathname)) return { status: 200, body: '{}' };
        if (u.pathname.endsWith('/testplan/Plans/7/Suites/8/TestPoint')) return { status: 200, body: JSON.stringify({ value: [
            { id: 1, testCaseReference: { id: 901, name: 'Add an item' }, configuration: { name: 'Chrome' }, results: { outcome: 'passed' } },
            { id: 2, testCaseReference: { id: 901, name: 'Add an item' }, configuration: { name: 'Edge' }, results: { outcome: 'unspecified' } },
            { id: 3, testCaseReference: { id: 950, name: 'Not automated' }, configuration: { name: 'Chrome' }, results: {} },
        ] }) };
        if (u.pathname.endsWith('/wit/workitemsbatch')) return { status: 200, body: JSON.stringify({ value: [] }) };
        return { status: 404, body: '' };
    };
    fs.writeFileSync(path.join(dir, 'config/global.env'), 'BASE_URL=http://localhost\nADO_ORGANIZATION=acme\nADO_PROJECT=qa\n');
    store.set({ name: 'ADO_PAT' }, 'pat-1');
    const feat = 'test/orders/features/basket.feature';
    fs.mkdirSync(path.join(dir, 'test/orders/features'), { recursive: true });
    const text = 'Feature: Basket\r\n\r\n  @smoke\r\n  Scenario: Add an item\r\n    When I add "mug"\r\n    Then the basket shows 1 item\r\n';
    fs.writeFileSync(path.join(dir, feat), text);
    const s5 = createServer({ repoRoot: dir, store, userName: 'T', adoTransport: transport, token: 'tok6' });
    const post = (url: string, payload: unknown) => s5.app.inject({ method: 'POST', url, headers: { authorization: 'Bearer tok6' }, payload: payload as object });
    const sc = { file: feat, line: 4, name: 'Add an item' };
    assert.equal((await post('/api/ado/testplans/7/suites/8/add-scenarios', { project: 'orders', env: 'qa', scenarios: [sc] })).statusCode, 400, 'needs confirmation');
    const r = await post('/api/ado/testplans/7/suites/8/add-scenarios', { project: 'orders', env: 'qa', scenarios: [sc], markAutomated: true, confirm: true });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().created, [{ id: 901, name: 'Add an item', file: feat }]);
    const create = calls.find((c) => c.method === 'POST' && c.path.endsWith('$Test%20Case'))!;
    assert.equal(create.type, 'application/json-patch+json');
    const ops = JSON.parse(create.body!);
    assert.equal(ops.find((o: any) => o.path === '/fields/System.IterationPath').value, 'qa\\Sprint 2');
    assert.equal(ops.find((o: any) => o.path === '/fields/Microsoft.VSTS.TCM.AutomatedTestStorage').value, feat);
    assert.ok(calls.some((c) => c.path.endsWith('/testplan/Plans/7/Suites/8/TestCase') && JSON.parse(c.body!)[0].workItem.id === 901));
    // The scenario carries the new id, and (no plan or suite configured or tagged) this plan and suite so its
    // results are published here; on its tag line; line endings kept
    assert.equal(fs.readFileSync(path.join(dir, feat), 'utf8'), text.replace('@smoke', '@smoke @TestCaseId:901 @TestPlanId:7 @TestSuiteId:8'));
    // Steps sync: only for the test case the scenario is tagged with, and confirmed
    assert.equal((await post('/api/ado/testcases/555/sync', { project: 'orders', env: 'qa', ...sc, confirm: true })).statusCode, 400);
    assert.equal((await post('/api/ado/testcases/901/sync', { project: 'orders', env: 'qa', ...sc })).statusCode, 400);
    const sy = await post('/api/ado/testcases/901/sync', { project: 'orders', env: 'qa', ...sc, confirm: true });
    assert.equal(sy.statusCode, 200, sy.body);
    assert.equal(sy.json().steps, 1);
    const patch = calls.find((c) => c.method === 'PATCH')!;
    assert.match(patch.path, /\/wit\/workitems\/901$/);
    assert.match(JSON.parse(patch.body!)[0].value, /When I add &amp;quot;mug&amp;quot;/);
    // A scenario that moved: refused, nothing created
    const before = calls.length;
    assert.equal((await post('/api/ado/testplans/7/suites/8/add-scenarios', { project: 'orders', env: 'qa', scenarios: [{ ...sc, line: 5 }], confirm: true })).statusCode, 400);
    assert.ok(!calls.slice(before).some((c) => c.method !== 'GET'));
    // A feature already aimed at this plan and suite: only the test case id is added
    const text2 = '@TestPlanId:7 @TestSuiteId:8\nFeature: Cart\n\n  Scenario: Empty the cart\n    When I empty it\n';
    const feat2 = 'test/orders/features/cart.feature';
    fs.writeFileSync(path.join(dir, feat2), text2);
    const r2 = await post('/api/ado/testplans/7/suites/8/add-scenarios', { project: 'orders', env: 'qa', scenarios: [{ file: feat2, line: 4, name: 'Empty the cart' }], confirm: true });
    assert.equal(r2.statusCode, 200, r2.body);
    assert.equal(fs.readFileSync(path.join(dir, feat2), 'utf8'), text2.replace('\n  Scenario: Empty', '\n  @TestCaseId:902\n  Scenario: Empty'));
    // Where each scenario's results go, as listed for the page
    const sc2 = await s5.app.inject({ method: 'GET', url: '/api/ado/testplans/scenarios?project=orders&env=qa', headers: { authorization: 'Bearer tok6' } });
    const byName = Object.fromEntries(sc2.json().scenarios.map((x: any) => [x.name, x]));
    assert.deepEqual([byName['Add an item'].plan, byName['Add an item'].planFrom, byName['Empty the cart'].suite, byName['Empty the cart'].suiteFrom], [7, 'scenario', 8, 'feature']);
    // The suite: each test point with its scenarios and where their results go; scenarios aimed here whose
    // test case is not in the suite (902 is not: nothing would be published for it)
    const pts = (await s5.app.inject({ method: 'GET', url: '/api/ado/testplans/7/suites/8/points?project=orders&env=qa', headers: { authorization: 'Bearer tok6' } })).json();
    assert.deepEqual(pts.publishing, { project: 'orders', env: 'qa', enabled: false, plan: null, suite: null, configuration: '', combines: false, chooses: false });
    assert.deepEqual(pts.points[0].scenarios.map((x: any) => [x.name, x.status]), [['Add an item', 'here']]);
    assert.deepEqual(pts.points[2].scenarios, []);
    assert.deepEqual(pts.missing.map((m: any) => [m.testCase, m.name]), [[902, 'Empty the cart']]);
    fs.rmSync(path.join(dir, feat2));
    await s5.app.close();
    fs.rmSync(path.join(dir, 'test/orders/features/basket.feature'));
});

test('encoded paths cannot skip the token check (regression)', async () => {
    for (const p of ['/%61pi/health', '/%61pi/secrets', '/api%2Fhealth', '/%41PI/health', '/%2561pi/health', '/api/../api/health']) {
        const r = await call('GET', p, { token: null });
        // Either refused, or (for paths that are not API routes after one decode) the UI page itself.
        const isApiData = typeof r.json === 'object' && r.json !== null && !('error' in r.json);
        assert.ok(!isApiData, `${p} returned API data without a token (status ${r.status})`);
        assert.ok(!JSON.stringify(r.json).includes('repoRoot') && !JSON.stringify(r.json).includes('QA_PASSWORD'), p);
    }
});

test('stage one change by its id (as the UI does)', async () => {
    const f = path.join(dir, 'hunk.txt');
    fs.writeFileSync(f, Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n');
    cp.execFileSync('git', ['add', 'hunk.txt'], { cwd: dir });
    cp.execFileSync('git', ['commit', '-qm', 'hunk base'], { cwd: dir });
    fs.writeFileSync(f, ['first', ...Array.from({ length: 30 }, (_, i) => `line ${i}`), 'last'].join('\n') + '\n');
    const h = await call('GET', '/api/git/hunks?file=hunk.txt&staged=false');
    assert.equal(h.json.hunks.length, 2);
    const r = await call('POST', '/api/git/hunks', { body: { file: 'hunk.txt', ids: [h.json.hunks[0].id] } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const staged = cp.execFileSync('git', ['diff', '--cached'], { cwd: dir, encoding: 'utf8' });
    assert.ok(staged.includes('+first') && !staged.includes('+last'));
    const stale = await call('POST', '/api/git/hunks', { body: { file: 'hunk.txt', ids: ['0'.repeat(32)] } });
    assert.equal(stale.status, 400);
    assert.equal(stale.json.code, 'stale-hunk');
    cp.execFileSync('git', ['reset', '-q'], { cwd: dir });
    cp.execFileSync('git', ['checkout', '--', 'hunk.txt'], { cwd: dir });
});

test('create a step definition for an undefined step (plan, create, save, now defined)', async () => {
    fs.mkdirSync(path.join(dir, 'test/orders/features'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'test/orders/steps'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test/orders/steps/cart.steps.ts'), "import { CSBDDStepDef } from '@mdakhan.mak/cs-playwright-test-framework/bdd';\n\nexport class CartSteps {\n    @CSBDDStepDef('I open the cart')\n    async openCart(): Promise<void> {}\n}\n");
    const feature = 'Feature: Cart\n  Scenario: add\n    Given I open the cart\n    When I add 2 "Pens" to the cart\n';
    fs.writeFileSync(path.join(dir, 'test/orders/features/cart.feature'), feature);
    const diag = await call('POST', '/api/lang/diagnostics', { body: { path: 'test/orders/features/cart.feature', content: feature } });
    const undef = diag.json.diagnostics.find((d: any) => d.source === 'Steps');
    assert.equal(undef.fix, 'create-step');
    const plan = await call('POST', '/api/lang/steps/plan', { body: { path: 'test/orders/features/cart.feature', content: feature, line: 4 } });
    assert.equal(plan.status, 200, JSON.stringify(plan.json));
    assert.equal(plan.json.pattern, 'I add {int} {string} to the cart');
    assert.equal(plan.json.targets[0].file, 'test/orders/steps/cart.steps.ts');
    assert.equal(plan.json.targets[0].recommended, true);
    // Only .ts step files the framework would load; nothing outside the project.
    const bad = await call('POST', '/api/lang/steps/create', { body: { path: 'test/orders/features/cart.feature', content: feature, line: 4, target: 'test/orders/helpers.ts' } });
    assert.equal(bad.status, 400);
    const out = await call('POST', '/api/lang/steps/create', { body: { path: 'test/orders/features/cart.feature', content: feature, line: 4, target: '../x.steps.ts' } });
    assert.equal(out.status, 400);
    const r = await call('POST', '/api/lang/steps/create', { body: { path: 'test/orders/features/cart.feature', content: feature, line: 4, target: 'test/orders/steps/cart.steps.ts' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    // The server does not write: the UI saves through the normal (conflict-checked) save.
    assert.ok(!fs.readFileSync(path.join(dir, 'test/orders/steps/cart.steps.ts'), 'utf8').includes('I add {int}'));
    const saved = await call('PUT', '/api/file', { body: { path: r.json.file, content: r.json.content, expectedHash: r.json.baseHash } });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const after = await call('POST', '/api/lang/diagnostics', { body: { path: 'test/orders/features/cart.feature', content: feature } });
    assert.deepEqual(after.json.diagnostics.filter((d: any) => d.source === 'Steps'), []);
});

test('run evidence over the API, report files served from the results folder, trace opened with the project Playwright', async () => {
    const { fakeRun } = await import('./evidence.test');
    const { TestRunner } = await import('../src/run/runner');
    const reportDir = fakeRun(dir);
    // A finished run whose results are that report (as the runner records it).
    const runsFile = path.join(dir, '.git', 'cs-studio', 'runs.json');
    const existing = fs.existsSync(runsFile) ? JSON.parse(fs.readFileSync(runsFile, 'utf8')) : [];
    void TestRunner;
    const id = 'ev-run-1';
    const marker = path.join(tmp, 'trace-opened.txt');
    const cli = path.join(dir, 'node_modules', 'playwright-core', 'cli.js');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, `require('fs').writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join('|'));`);
    fs.mkdirSync(path.dirname(runsFile), { recursive: true });
    fs.writeFileSync(runsFile, JSON.stringify([{ id, request: { project: 'orders', env: 'qa' }, command: [], state: 'failed', startedAt: '2026-11-19T08:30:43Z', endedAt: '2026-11-19T08:30:48Z', secretNames: [],
        summary: { total: 2, passed: 1, failed: 1, skipped: 0, duration: 1, scenarios: [], reportDir, hasHtml: true } }, ...(Array.isArray(existing) ? existing : [])]));
    const { createServer } = await import('../src/server/server');
    const s2 = createServer({ repoRoot: dir, store, userName: 'T', token: 'tok3' });
    const auth = { authorization: 'Bearer tok3' };
    const list = (await s2.app.inject({ method: 'GET', url: '/api/runs', headers: auth })).json();
    const run = list.find((r: any) => r.id === id);
    assert.equal(run.reportIndex, 'reports/index.html');
    const ev = (await s2.app.inject({ method: 'GET', url: `/api/runs/${id}/evidence`, headers: auth })).json();
    const fail = ev.scenarios[1];
    assert.equal(fail.failedStep.error, 'heading is "Hello", expected "Goodbye"');
    // The report page and the files it links with ../ are reachable under the same key.
    const base = `/report/${id}/${run.reportKey}/`;
    assert.equal((await s2.app.inject({ method: 'GET', url: base + 'reports/index.html' })).statusCode, 200);
    const old = await s2.app.inject({ method: 'GET', url: base + 'index.html' });
    assert.equal(old.statusCode, 302);
    assert.equal(old.headers.location, base + 'reports/index.html');
    const img = await s2.app.inject({ method: 'GET', url: base + fail.failedStep.screenshot.file });
    assert.equal(img.statusCode, 200);
    fs.writeFileSync(path.join(dir, 'outside-report.txt'), 'NOT-FOR-THE-REPORT-ROUTE');
    for (const probe of ['../../../../outside-report.txt', '..%2F..%2F..%2F..%2Foutside-report.txt', '%2e%2e/%2e%2e/%2e%2e/%2e%2e/outside-report.txt']) {
        const r = await s2.app.inject({ method: 'GET', url: base + probe });
        assert.ok(!r.body.includes('NOT-FOR-THE-REPORT-ROUTE'), probe);
    }
    assert.equal((await s2.app.inject({ method: 'GET', url: `/report/${id}/wrongkey/reports/index.html` })).statusCode, 404);
    // Open trace: only a trace of this run, with the project's Playwright.
    const bad = await s2.app.inject({ method: 'POST', url: `/api/runs/${id}/trace`, headers: auth, payload: { file: '../../secret.zip' } });
    assert.equal(bad.statusCode, 400);
    const ok = await s2.app.inject({ method: 'POST', url: `/api/runs/${id}/trace`, headers: auth, payload: { file: fail.files[0].file } });
    assert.equal(ok.statusCode, 200, ok.body);
    for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
    const args = fs.readFileSync(marker, 'utf8').split('|');
    assert.equal(args[0], 'show-trace');
    assert.equal(fs.realpathSync(args[1]), fs.realpathSync(path.join(path.dirname(reportDir), fail.files[0].file)));
    await s2.app.close();
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
});

test('network settings over the API: off by default, empty fields allowed, password write-only', async () => {
    const { createServer } = await import('../src/server/server');
    const home = path.join(tmp, 'net-home');
    const s3 = createServer({ repoRoot: dir, store, userName: 'T', token: 'tok4', home });
    const auth = { authorization: 'Bearer tok4' };
    const get = async () => (await s3.app.inject({ method: 'GET', url: '/api/settings', headers: auth })).json();
    const first = await get();
    assert.equal(first.network.proxyMode, 'off');
    const r = await s3.app.inject({ method: 'PUT', url: '/api/settings/network', headers: auth, payload: { proxyMode: 'environment', proxyUrl: '', proxyUser: '', caFile: '' } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().network.proxyMode, 'environment');
    const bad = await s3.app.inject({ method: 'PUT', url: '/api/settings/network', headers: auth, payload: { proxyMode: 'manual', proxyUrl: 'not a url' } });
    assert.equal(bad.statusCode, 400);
    const pw = await s3.app.inject({ method: 'PUT', url: '/api/settings/network/password', headers: auth, payload: { password: 'pr0xy-Secret!' } });
    assert.equal(pw.statusCode, 200);
    assert.equal(pw.json().networkInfo.hasProxyPassword, true);
    assert.ok(!pw.body.includes('pr0xy-Secret!') && !JSON.stringify(await get()).includes('pr0xy-Secret!'), 'the password is never returned');
    assert.ok(!fs.readFileSync(path.join(home, 'settings.json'), 'utf8').includes('pr0xy-Secret!'), 'not in the settings file');
    await s3.app.inject({ method: 'PUT', url: '/api/settings/network/password', headers: auth, payload: { password: null } });
    assert.equal((await get()).networkInfo.hasProxyPassword, false);
    await s3.app.close();
});

test('pipelines: starting a run needs explicit confirmation; report files need the run key', async () => {
    const r = await call('POST', '/api/ado/pipelines/2/run', { body: { branch: 'main' } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Confirm/);
    for (const u of ['/pipeline-report/162/x/..%2F..%2F..%2F..%2Fetc%2Fpasswd', '/pipeline-report/abc/def/x']) {
        const res = await call('GET', u, { token: null });
        assert.ok(!JSON.stringify(res.json ?? '').includes('root:'), u);
        assert.notEqual(res.status, 200, u);
    }
    const leak = await call('GET', '/pipeline-report/162/0123456789abcdef0123456789abcdef/index.html', { token: null });
    assert.equal(leak.status, 404);
});

test('a large build-and-deploy pipeline through the API: stages, artifacts by stage, published test runs', async () => {
    const { createServer } = await import('../src/server/server');
    fs.writeFileSync(path.join(dir, 'config/global.env'), 'BASE_URL=http://localhost\nADO_ORGANIZATION=acme\nADO_PROJECT=qa\n');
    store.set({ name: 'ADO_PAT' }, 'pat-1');
    const timeline = [
        { id: 'b', type: 'Stage', name: 'Build', state: 'completed', result: 'succeeded', order: 1, attempt: 1, previousAttempts: [] },
        { id: 'bj', parentId: 'b', type: 'Job', name: 'Compile', state: 'completed', result: 'succeeded', order: 1 },
        { id: 't1', type: 'Stage', name: 'Test DEV', state: 'completed', result: 'failed', order: 2, attempt: 2, previousAttempts: [{}] },
        { id: 't1j', parentId: 't1', type: 'Job', name: 'Run UI tests', state: 'completed', result: 'failed', order: 1 },
        { id: 'q', type: 'Stage', name: 'Deploy QA', state: 'pending', order: 3, attempt: 1, previousAttempts: [] },
        { id: 'qc', parentId: 'q', type: 'Checkpoint', name: 'Checkpoint', state: 'inProgress', order: 1 },
        { id: 'qa', parentId: 'qc', type: 'Checkpoint.Approval', name: 'Checkpoint.Approval', state: 'inProgress', order: 1 },
    ];
    const transport = async (req: { url: string; method: string }) => {
        const u = new URL(req.url);
        if (u.pathname.endsWith('/_apis/build/builds/77')) return { status: 200, body: JSON.stringify({ id: 77, buildNumber: '2026.77', status: 'inProgress', sourceBranch: 'refs/heads/main', reason: 'individualCI', definition: { id: 5, name: 'platform-cd' } }) };
        if (u.pathname.endsWith('/_apis/build/builds/77/timeline')) return { status: 200, body: JSON.stringify({ records: timeline }) };
        if (u.pathname.endsWith('/_apis/build/builds/77/artifacts')) return { status: 200, body: JSON.stringify({ value: [
            { name: 'drop', source: 'bj', resource: { type: 'PipelineArtifact', properties: { artifactsize: String(4 * 1024 ** 3) } } },
            { name: 'ui-results', source: 't1j', resource: { type: 'PipelineArtifact', properties: { artifactsize: '2000000' } } }] }) };
        if (u.pathname.endsWith('/_apis/test/runs')) return { status: 200, body: JSON.stringify({ value: [{ id: 9, name: 'API tests', state: 'Completed', totalTests: 40, passedTests: 38, unanalyzedTests: 2, pipelineReference: { stageReference: { stageName: 'Test_DEV' } } }] }) };
        return { status: 404, body: '' };
    };
    const s4 = createServer({ repoRoot: dir, store, userName: 'T', adoTransport: transport, token: 'tok5' });
    const r = await s4.app.inject({ method: 'GET', url: '/api/ado/pipelines/runs/77?project=orders&env=qa', headers: { authorization: 'Bearer tok5' } });
    assert.equal(r.statusCode, 200, r.body);
    const d = r.json();
    assert.deepEqual(d.stages.map((s: any) => [s.name, s.waiting, s.retried, s.attempt]), [['Build', false, false, 1], ['Test DEV', false, true, 2], ['Deploy QA', true, false, 1]]);
    assert.deepEqual(d.artifacts.map((a: any) => [a.name, a.stage, a.candidate]), [['drop', 'Build', false], ['ui-results', 'Test DEV', true]]);
    assert.deepEqual(d.publishedTestRuns.map((t: any) => [t.name, t.failed, t.stage]), [['API tests', 2, 'Test_DEV']]);
    await s4.app.close();
});

test('visual review: lists snapshots, serves only their images, approves the last screenshot', async () => {
    const { png, visualFixture } = await import('./visual-fixtures');
    const vdir = 'test/visual-ai';
    visualFixture(dir, vdir, 'basket', { baseline: png(2, 2, [0, 128, 0]), actual: png(2, 2, [200, 0, 0]), result: { passed: false, verdict: 'visual_change', message: 'Looks different' } });
    const list = await call('GET', '/api/visual');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.snapshots.map((s: any) => `${s.name}:${s.status}`), ['basket:changed']);
    const img = await call('GET', `/api/visual/image?path=${encodeURIComponent(`${vdir}/actual/basket.png`)}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers['content-type'], 'image/png');
    for (const bad of [`${vdir}/../../.git/config`, 'package.json', `${vdir}/baseline/basket.pixel-hash`, '/etc/passwd']) {
        assert.equal((await call('GET', `/api/visual/image?path=${encodeURIComponent(bad)}`)).status, 400, bad);
    }
    const seen = list.json.snapshots[0].actualSha;
    assert.equal((await call('POST', '/api/visual/approve', { body: { dir: 'test', name: 'basket', actualSha: seen } })).status, 400, 'not a review folder');
    assert.equal((await call('POST', '/api/visual/approve', { body: { dir: vdir, name: '../basket', actualSha: seen } })).status, 400);
    assert.equal((await call('POST', '/api/visual/approve', { body: { dir: vdir, name: 'basket' } })).status, 400, 'what was seen is required');
    assert.equal((await call('POST', '/api/visual/approve', { body: { dir: vdir, name: 'basket', actualSha: '0'.repeat(64) } })).status, 409, 'a newer run than what was seen');
    // An image that is a link out of the repository is not served
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-out-'));
    fs.writeFileSync(path.join(outside, 'private.png'), 'x');
    fs.symlinkSync(path.join(outside, 'private.png'), path.join(dir, vdir, 'actual', 'leak.png'));
    assert.equal((await call('GET', `/api/visual/image?path=${encodeURIComponent(`${vdir}/actual/leak.png`)}`)).status, 400);
    fs.rmSync(path.join(dir, vdir, 'actual', 'leak.png'));
    fs.rmSync(outside, { recursive: true, force: true });
    const ok = await call('POST', '/api/visual/approve', { body: { dir: vdir, name: 'basket', actualSha: seen } });
    assert.equal(ok.status, 200);
    assert.deepEqual((await call('GET', '/api/visual')).json.snapshots.map((s: any) => `${s.name}:${s.status}`), ['basket:same']);
    const a11y = await call('GET', '/api/accessibility');
    assert.equal(a11y.status, 200);
    assert.deepEqual(a11y.json.checks, []);
    fs.rmSync(path.join(dir, 'test'), { recursive: true, force: true });
});

test('API mocks: from an OpenAPI document, saved in the project, started, its requests logged, stopped', async () => {
    fs.mkdirSync(path.join(dir, 'config/orders/environments'), { recursive: true });
    const spec = { openapi: '3.0.3', info: { title: 'Orders' }, servers: [{ url: 'https://orders.example/v1' }], paths: { '/orders/{id}': { get: { operationId: 'getOrder', responses: { 200: { content: { 'application/json': { example: { id: 1, status: 'open' } } } } } } } } };
    const made = await call('POST', '/api/mocks/from-openapi', { body: { text: JSON.stringify(spec) } });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const mock = made.json.mock;
    assert.deepEqual(mock.routes.map((r: { method: string; path: string }) => `${r.method} ${r.path}`), ['GET /v1/orders/{id}']);
    mock.routes[0].body = { id: '{{path.id}}', status: 'open' };
    mock.routes.push({ method: 'GET', path: '/v1/health', status: 200, body: 'ok', fault: { kind: 'error', status: 503 } });
    const file = 'test/orders/mocks/orders.mock.json';
    assert.equal((await call('PUT', '/api/mocks/file', { body: { project: 'orders', file, mock } })).status, 200);
    assert.equal((await call('PUT', '/api/mocks/file', { body: { project: 'orders', file: 'config/orders/x.mock.json', mock } })).status, 400, 'only under test/<project>/mocks');
    assert.equal((await call('PUT', '/api/mocks/file', { body: { project: 'orders', file: 'test/orders/mocks/../../../evil.mock.json', mock } })).status, 400);
    assert.equal((await call('PUT', '/api/mocks/file', { body: { project: 'orders', file, mock: { name: 'x', routes: [{ method: 'FETCH', path: 'x', status: 1 }] } } })).status, 400, 'a definition with problems is refused');
    const listed = await call('GET', '/api/mocks?project=orders');
    assert.deepEqual(listed.json.mocks.map((m: { file: string; routes: number }) => [m.file, m.routes]), [[file, 2]]);
    const started = await call('POST', '/api/mocks/start', { body: { project: 'orders', file } });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const get = (u: string) => new Promise<{ status: number; text: string }>((resolve) => http.get(u, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, text: t })); }));
    assert.deepEqual(await get(`${started.json.url}/v1/orders/42`), { status: 200, text: '{"id":"42","status":"open"}' });
    assert.equal((await get(`${started.json.url}/v1/health`)).status, 503, 'the fault');
    const log = await call('GET', `/api/mocks/log?project=orders&file=${encodeURIComponent(file)}`);
    assert.deepEqual(log.json.log.map((e: { path: string; status: number; fault?: string }) => `${e.path} ${e.status} ${e.fault ?? ''}`.trim()), ['/v1/orders/42 200', '/v1/health 503 error']);
    assert.ok((await call('GET', '/api/mocks?project=orders')).json.mocks[0].url, 'listed as running');
    assert.equal((await call('POST', '/api/mocks/stop', { body: { project: 'orders', file } })).json.stopped, true);
    assert.equal((await call('GET', `/api/mocks/log?project=orders&file=${encodeURIComponent(file)}`)).json.running, false);
    assert.equal((await call('DELETE', `/api/mocks/file?project=orders&file=${encodeURIComponent(file)}`)).json.removed, true);
    assert.ok(!fs.existsSync(path.join(dir, file)));
});

test('reports: old framework reports are repaired when served (chart code needs exports; video without crossorigin)', async () => {
    const { repairFrameworkReport } = await import('../src/server/server');
    const html = '<head><!-- Custom Chart Library (embedded) -->\n    <script>\n"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.CSChart = void 0;\n</script></head>'
        + '<video controls width="100%" style="x" crossorigin="anonymous"><source src="../videos/a.webm"></video>';
    const out = repairFrameworkReport(html);
    assert.ok(out.includes('<script>var exports = {};</script><script>'));
    assert.ok(!out.includes('crossorigin'));
    assert.equal(repairFrameworkReport(out), out, 'repairing twice changes nothing');
    assert.equal(repairFrameworkReport('<p>plain</p>'), '<p>plain</p>');
});

test('QA6: a secret value of only spaces is refused with a message', async () => {
    for (const value of ['   ', '\t \n']) {
        const r = await call('PUT', '/api/secrets', { body: { name: 'QA6_SPACES', value } });
        assert.equal(r.status, 400);
        assert.match(r.json.error ?? r.json.message ?? JSON.stringify(r.json), /only spaces/);
    }
    assert.equal((await call('GET', '/api/secrets')).json.some((s: { name: string }) => s.name === 'QA6_SPACES'), false);
    // A value with spaces around real text is kept as typed.
    assert.equal((await call('PUT', '/api/secrets', { body: { name: 'QA6_SPACES', value: ' pw ' } })).status, 200);
    await call('DELETE', '/api/secrets?name=QA6_SPACES');
});

test('QA6: a commit names the branch the screen showed; another branch checked out is refused', async () => {
    const st = (await call('GET', '/api/git/status')).json;
    fs.writeFileSync(path.join(dir, 'qa6-branch.txt'), 'x\n');
    await call('POST', '/api/git/stage', { body: { paths: ['qa6-branch.txt'] } });
    const wrong = await call('POST', '/api/git/commit', { body: { message: 'qa6', expectBranch: 'some-other-branch' } });
    assert.equal(wrong.status, 200);
    assert.equal(wrong.json.status, 'rejected');
    assert.match(wrong.json.message, new RegExp(`This tab shows some-other-branch but ${st.branch} is checked out now`));
    const ok = await call('POST', '/api/git/commit', { body: { message: 'qa6', expectBranch: st.branch } });
    assert.equal(ok.json.status, 'ok');
});

test('QA6: fetch answers with what arrived; abort with nothing running says so', async () => {
    const f = await call('POST', '/api/git/fetch');
    assert.equal(f.status, 200);
    assert.equal(f.json.ok, true);
    assert.equal(f.json.newCommits, 0);
    assert.deepEqual(f.json.updated, []);
    const a = await call('POST', '/api/git/operation/abort');
    assert.equal(a.status, 200);
    assert.equal(a.json.message, 'Nothing is in progress.');
    assert.equal((await call('POST', '/api/git/pull/autostash', { body: { action: 'undo' } })).status, 400);
    assert.equal((await call('POST', '/api/git/pull/autostash', { body: { action: 'nope' } })).status, 400);
});
