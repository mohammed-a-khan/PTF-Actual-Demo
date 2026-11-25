/** Monitors: a collection run on a schedule while the Studio is open; an alert to a webhook (address kept as a Studio secret) on failure or on a change; the runs kept as history. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { createServer } from '../src/server/server';
import { SecretStore } from '../src/secrets/store';
import { KeyFileProtector } from '../src/secrets/protector';
import { runGit } from '../src/git/run';
import { newCollection, newRequest } from '../src/api/model';

test('a monitor runs on its schedule, alerts on failure and on recovery, keeps its runs', async () => {
    process.env.CS_STUDIO_MONITOR_TICK_MS = '150';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mon-'));
    let healthy = false;
    const app = http.createServer((_q, r) => { r.writeHead(healthy ? 200 : 503); r.end('{}'); });
    const alerts: Array<{ text: string }> = [];
    const hook = http.createServer((q, r) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { alerts.push(JSON.parse(b)); r.writeHead(200); r.end('1'); }); });
    const listen = (s: http.Server) => new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port)));
    const [port, hookPort] = [await listen(app), await listen(hook)];
    const dir = path.join(tmp, 'repo');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    const w = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
    w('config/shop/common/common.env', 'PROJECT_NAME=shop\n');
    w('config/shop/environments/qa.env', 'ENVIRONMENT=qa\n');
    const c = { ...newCollection('Health'), baseUrl: `http://127.0.0.1:${port}`, items: [{ ...newRequest('Ping'), id: 'p', url: '/health' }] };
    w('test/shop/api/health.collection.json', JSON.stringify(c));
    const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
    const srv = createServer({ repoRoot: dir, store, userName: 'T', projectId: 'repo' });
    store.set({ name: 'TEAMS_WEBHOOK', project: 'repo' }, `http://127.0.0.1:${hookPort}/hook`);
    const auth = { authorization: `Bearer ${srv.token}` };
    const until = async (ok: () => boolean | Promise<boolean>, ms = 8000) => { for (let t = 0; t < ms; t += 50) { if (await ok()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail('timed out'); };
    try {
        let r = await srv.app.inject({ method: 'PUT', url: '/api/apiws/monitors', headers: auth, payload: { name: 'Shop health', file: 'test/shop/api/health.collection.json', env: 'qa', everyMinutes: 1 } });
        assert.equal(r.statusCode, 400, 'at least every 5 minutes');
        r = await srv.app.inject({ method: 'PUT', url: '/api/apiws/monitors', headers: auth, payload: { name: 'Shop health', file: 'test/shop/api/health.collection.json', env: 'qa', everyMinutes: 15, webhookSecret: 'TEAMS_WEBHOOK', alertOn: 'change' } });
        assert.equal(r.statusCode, 200, r.body);
        const id = r.json().id;
        const mon = async () => (await srv.app.inject({ method: 'GET', url: '/api/apiws/monitors', headers: auth })).json().monitors[0];
        // Due at once (never ran): runs, fails; no alert on the first result with "on change".
        await until(async () => !!(await mon()).last);
        let m = await mon();
        assert.deepEqual([m.last.passed, m.last.failed], [false, 1]);
        assert.equal(alerts.length, 0);
        // Not due again for 15 minutes; run now after a fix: recovered → alert.
        healthy = true;
        r = await srv.app.inject({ method: 'POST', url: `/api/apiws/monitors/${id}/run`, headers: auth });
        assert.equal(r.statusCode, 200, r.body);
        await until(() => alerts.length === 1);
        assert.match(alerts[0].text, /^✅ Shop health recovered: 1\/1 requests passed \(qa\)\./);
        await until(async () => !!(await mon()).last.alert);
        m = await mon();
        assert.equal(m.last.alert, 'Alert sent (200).');
        // On failure: every failed run alerts.
        await srv.app.inject({ method: 'PUT', url: '/api/apiws/monitors', headers: auth, payload: { id, name: 'Shop health', file: 'test/shop/api/health.collection.json', env: 'qa', everyMinutes: 15, webhookSecret: 'TEAMS_WEBHOOK', alertOn: 'failure' } });
        healthy = false;
        await srv.app.inject({ method: 'POST', url: `/api/apiws/monitors/${id}/run`, headers: auth });
        await until(() => alerts.length === 2);
        assert.match(alerts[1].text, /^❌ Shop health failed: 1 of 1 requests \(qa\)\. Ping/);
        // History: its runs.
        const runs = (await srv.app.inject({ method: 'GET', url: `/api/apiws/monitors/${id}/runs`, headers: auth })).json().runs;
        assert.equal(runs.length, 3);
        assert.deepEqual(runs.map((x: { summary: { passed: number } }) => x.summary.passed), [0, 1, 0]);
    } finally { delete process.env.CS_STUDIO_MONITOR_TICK_MS; await srv.app.close(); app.close(); hook.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
