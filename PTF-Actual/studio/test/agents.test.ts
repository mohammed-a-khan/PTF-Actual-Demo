import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { locatorCode } from '../src/agents/browser';
import { isReadOnlyCall, studioTools, ToolDeps } from '../src/agents/tools';
import { AgentHost, DEFAULT_AGENT_SETTINGS } from '../src/agents/host';
import { convertScript } from '../src/recorder/convert';
import * as ts from 'typescript';

test('locatorCode: the code codegen writes; the recorder converts it back to the same selectors', () => {
    const specs = [
        { role: 'button', name: 'Sign in' }, { role: 'link', name: "O'Brien", exact: true }, { label: 'Country' }, { placeholder: 'Search', exact: true },
        { text: 'Orders', nth: 1 }, { testId: 'save' }, { css: '#main .row', nth: -1 }, { placeholder: 'Card number', frames: ['iframe[name="pay"]'] },
    ];
    const codes = specs.map(locatorCode);
    assert.equal(codes[0], "page.getByRole('button', { name: 'Sign in' })");
    assert.equal(codes[1], "page.getByRole('link', { name: 'O\\'Brien', exact: true })");
    assert.equal(codes[4], "page.getByText('Orders').nth(1)");
    assert.equal(codes[7], "page.locator('iframe[name=\"pay\"]').contentFrame().getByPlaceholder('Card number')");
    const script = `import { test } from '@playwright/test';\ntest('t', async ({ page }) => {\n${codes.map((c) => `  await ${c}.click();`).join('\n')}\n});`;
    const c = convertScript(ts, script);
    assert.deepEqual(c.warnings, []);
    assert.deepEqual(c.actions.map((a) => a.target!.selector), [
        'internal:role=button[name="Sign in"i]', 'internal:role=link[name="O\'Brien"s]', 'internal:label="Country"i', 'internal:attr=[placeholder="Search"s]',
        'internal:text="Orders"i >> nth=1', 'internal:testid=[data-testid="save"s]', '#main .row >> nth=-1', 'internal:attr=[placeholder="Card number"i]']);
    assert.deepEqual(c.actions[7].target!.frames, ['iframe[name="pay"]']);
    assert.throws(() => locatorCode({}), /Name the element/);
});

test('isReadOnlyCall: reads and previews run at once; changes need approval', () => {
    assert.equal(isReadOnlyCall('GET', '/api/runs', undefined), true);
    assert.equal(isReadOnlyCall('POST', '/api/recorder/preview', {}), true);
    assert.equal(isReadOnlyCall('POST', '/api/apiws/feature', { save: false }), true);
    assert.equal(isReadOnlyCall('POST', '/api/apiws/feature', { save: true }), false);
    assert.equal(isReadOnlyCall('PUT', '/api/file', {}), false);
    assert.equal(isReadOnlyCall('DELETE', '/api/load/scenario?file=x', undefined), false);
});

function deps(over: Partial<ToolDeps> = {}) {
    const calls: Array<[string, string, unknown]> = [];
    const asked: string[] = [];
    const d: ToolDeps = {
        repoRoot: '/repo', browser: {} as ToolDeps['browser'], context: () => ({ page: 'Database', connection: 'SHOP' }),
        call: async (m, u, b) => { calls.push([m, u, b]); return { status: 200, body: { ok: true } }; },
        approve: async (t) => { asked.push(t); return t.includes('DELETE') ? false : true; },
        changesNeedApproval: () => true, appsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'apps-')), ...over,
    };
    const tools = Object.fromEntries(studioTools(d).map((t) => [t.name, t]));
    return { d, tools, calls, asked };
}

test('studio_call: the screens\' API in-process; changes approved by the person; agents cannot reach the agent API', async () => {
    const { tools, calls, asked } = deps();
    assert.deepEqual(await tools.studio_context.handler({}), { page: 'Database', connection: 'SHOP' });
    await tools.studio_call.handler({ method: 'GET', path: '/api/runs', query: { limit: 5, x: undefined } });
    assert.deepEqual(calls[0], ['GET', '/api/runs?limit=5', undefined]);
    assert.deepEqual(asked, [], 'reading needs no approval');
    await tools.studio_call.handler({ method: 'PUT', path: '/api/file', body: { path: 'a.ts', content: 'x' } });
    assert.equal(asked[0], 'PUT /api/file');
    assert.equal(await tools.studio_call.handler({ method: 'DELETE', path: '/api/load/scenario', query: { file: 'x' } }), 'The person did not approve this change.');
    assert.equal(calls.length, 2, 'a rejected change is not made');
    // A database query that only reads runs without approval.
    await tools.studio_call.handler({ method: 'POST', path: '/api/db/query', body: { sql: 'SELECT * FROM orders' } });
    assert.equal(asked.length, 2);
    await tools.studio_call.handler({ method: 'POST', path: '/api/db/query', body: { sql: 'DELETE FROM orders WHERE id = 1' } });
    assert.equal(asked[2], 'POST /api/db/query');
    await assert.rejects(() => tools.studio_call.handler({ method: 'POST', path: '/api/agents/sessions', body: {} }), /not available to agents/);
    await assert.rejects(() => tools.studio_call.handler({ method: 'GET', path: '/etc/passwd' }), /Only Studio API paths/);
    await assert.rejects(() => tools.studio_call.handler({ method: 'GET', path: '/api/../x' }), /Only Studio API paths/);
});

test('studio_catalog: areas, calls of an area, search, types', async () => {
    const { tools } = deps();
    const areas = await tools.studio_catalog.handler({}) as { areas: Record<string, number> };
    for (const a of ['git', 'runs', 'apiws', 'load', 'db', 'recorder', 'env', 'ado']) assert.ok(areas.areas[a] > 0, a);
    assert.ok(!('agents' in areas.areas));
    const db = await tools.studio_catalog.handler({ area: 'db', search: 'query' }) as Array<{ call: string; method: string; path: string }>;
    assert.ok(db.some((c) => c.call === 'dbQuery' && c.method === 'POST' && c.path === '/api/db/query'));
    assert.match(String(await tools.studio_catalog.handler({ type: 'ApiCheck' })), /kind: ApiCheckKind/);
});

test('app code: only inside the checkout; search and read', async () => {
    const { tools, d } = deps();
    const repo = path.join(d.appsDir, 'shop-app');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'orders.ts'), 'export const route = "/orders";\nconst msg = "Order created";\n');
    execFileSync('git', ['init', '-q'], { cwd: repo }); execFileSync('git', ['add', '.'], { cwd: repo });
    assert.match(String(await tools.app_code_search.handler({ folder: 'shop-app', pattern: 'Order created' })), /src\/orders\.ts:2:/);
    assert.match(String(await tools.app_code_read.handler({ folder: 'shop-app', file: 'src/orders.ts' })), /1: export const route/);
    assert.match(String(await tools.app_code_read.handler({ folder: 'shop-app', file: 'src' })), /orders\.ts/);
    await assert.rejects(() => tools.app_code_read.handler({ folder: 'shop-app', file: '../../etc/passwd' }), /Not in the checked out/);
    await assert.rejects(() => tools.app_code_read.handler({ folder: '../x', file: 'a' }), /Not in the checked out/);
    await assert.rejects(() => tools.app_code_checkout.handler({ url: 'file:///etc' }), /https:\/\/ or SSH/);
});

test('agent settings: validated, saved, defaults', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
    const host = new AgentHost({ repoRoot: home, home, browser: {} as never, secret: () => undefined, call: async () => ({ status: 200, body: {} }), projects: () => [], log: () => {} });
    assert.deepEqual(host.settings(), DEFAULT_AGENT_SETTINGS);
    await assert.rejects(() => host.saveSettings({ ...DEFAULT_AGENT_SETTINGS, provider: 'custom', custom: { type: 'azure', baseUrl: 'ftp://x' }, model: 'gpt' }), /endpoint address/);
    await assert.rejects(() => host.saveSettings({ ...DEFAULT_AGENT_SETTINGS, provider: 'custom', custom: { type: 'azure', baseUrl: 'https://x.openai.azure.com/openai/v1' }, model: 'auto' }), /model or deployment/);
    await host.saveSettings({ ...DEFAULT_AGENT_SETTINGS, provider: 'custom', custom: { type: 'azure', baseUrl: 'https://x.openai.azure.com/openai/v1' }, model: 'gpt-5', approvals: { ...DEFAULT_AGENT_SETTINGS.approvals, files: 'auto' } });
    assert.equal(host.settings().model, 'gpt-5');
    assert.equal(host.settings().approvals.files, 'auto');
    assert.equal(host.settings().approvals.shell, 'ask');
});

test('the agents\' catalog is generated from the screens\' API client (up to date)', () => {
    // From the Studio folder (the tests also run compiled, from dist/test).
    let dir = __dirname;
    while (!fs.existsSync(path.join(dir, 'scripts', 'gen-agent-catalog.js'))) dir = path.dirname(dir);
    const out = execFileSync(process.execPath, [path.join(dir, 'scripts', 'gen-agent-catalog.js'), '--check'], { encoding: 'utf8' });
    assert.match(out, /up to date/);
});

import { applyPolicy, guardTools } from '../src/agents/host';
import { hostAllowed } from '../src/agents/tools';

test('policy: personal settings within the repository policy (stricter only)', () => {
    const s = { ...DEFAULT_AGENT_SETTINGS, approvals: { ...DEFAULT_AGENT_SETTINGS.approvals, files: 'auto' as const, shell: 'auto' as const } };
    const r = applyPolicy(s, { approvals: { files: 'ask', shell: 'deny', studio: 'ask' } });
    assert.deepEqual([r.settings.approvals.files, r.settings.approvals.shell, r.settings.approvals.studio], ['ask', 'deny', 'ask']);
    assert.deepEqual(r.problems, []);
    assert.match(applyPolicy(s, { enabled: false }).problems[0], /turned off/);
    assert.match(applyPolicy(s, { providers: ['custom'] }).problems[0], /own model endpoints only/);
    assert.match(applyPolicy({ ...s, model: 'gpt-4o' }, { models: ['gpt-5-mini', 'auto'] }).problems[0], /gpt-4o is not allowed/);
    assert.match(applyPolicy({ ...s, provider: 'custom', model: 'gpt', custom: { type: 'azure', baseUrl: 'https://evil.example.com/v1' } }, { customEndpoints: ['https://contoso.openai.azure.com'] }).problems[0], /evil\.example\.com\/v1 is not allowed/);
    assert.deepEqual(applyPolicy(s, null).settings, s);
});

test('policy: blocked tools and areas; browser hosts; secret values masked in what tools return', async () => {
    assert.equal(hostAllowed('app.qa.contoso.com', ['*.contoso.com']), true);
    assert.equal(hostAllowed('contoso.com', ['*.contoso.com']), true);
    assert.equal(hostAllowed('evil.com', ['*.contoso.com', 'localhost']), false);
    assert.equal(hostAllowed('anything', []), true);
    const { d } = deps();
    const tools = guardTools(studioTools({ ...d, blockedAreas: ['git', 'secrets'], allowedHosts: ['localhost'], context: () => ({ note: 'password is S3cr3t-Value' }) }), { blockedTools: ['app_code_checkout'] }, (t) => t.split('S3cr3t-Value').join('••••'));
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.ok(!byName.app_code_checkout, 'blocked tool not offered');
    assert.equal(await byName.studio_context.handler({}), JSON.stringify({ note: 'password is ••••' }, null, 1));
    // A failure reaches the agent with its reason (masked), as a failed result.
    assert.deepEqual(await byName.studio_call.handler({ method: 'GET', path: '/api/git/status' }), { textResultForLlm: 'Error: The repository\'s agent policy does not let agents use git in the Studio.', resultType: 'failure' });
    const open = await byName.browser_open.handler({ url: 'https://evil.com/' }) as { textResultForLlm: string; resultType: string };
    assert.equal(open.resultType, 'failure'); assert.match(open.textResultForLlm, /^Error: .*does not let agents open evil\.com/);
    const leaky = guardTools([{ name: 'x', description: '', parameters: {}, handler: async () => { throw new Error('login failed for S3cr3t-Value'); } }], {}, (t) => t.split('S3cr3t-Value').join('••••'));
    assert.deepEqual(await leaky[0].handler({}), { textResultForLlm: 'Error: login failed for ••••', resultType: 'failure' });
    const cat = JSON.parse(String(await byName.studio_catalog.handler({}))) as { areas: Record<string, number> };
    assert.ok(!('git' in cat.areas) && !('secrets' in cat.areas) && 'runs' in cat.areas);
});

test('audit: a finished conversation from disk: files it changed, transcript with approvals and usage; remove deletes its history', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-audit-'));
    const host = new AgentHost({ repoRoot: home, home, browser: {} as never, secret: () => undefined, call: async () => ({ status: 200, body: {} }), projects: () => [], log: () => {} });
    const id = 'studio-abc-123456';
    const usage = { calls: 3, inputTokens: 1200, outputTokens: 300, cost: 0, model: 'gpt-x' };
    fs.writeFileSync(path.join(home, 'agent-sessions.json'), JSON.stringify([{ id, title: 'Login story', createdAt: '2026-11-21T08:00:00.000Z', model: 'gpt-x', changes: ['test/a.feature', 'test/b.ts'], usage }]));
    const at = Date.parse('2026-11-21T08:01:00Z');
    const ev = [
        { type: 'user', text: 'Automate the login', seq: 1, at },
        { type: 'tool-start', id: 't1', tool: 'browser_open', args: '{"url":"http://app"}', seq: 2, at },
        { type: 'tool-end', id: 't1', ok: true, result: 'ok', seq: 3, at },
        { type: 'approval', id: 'a1', title: 'Save the test "Login"', detail: 'test/a.feature (new)\n```x```', kind: 'code', seq: 4, at },
        { type: 'approval-done', id: 'a1', decision: 'once', seq: 5, at },
        { type: 'assistant', text: 'Saved and passed.', seq: 6, at },
    ];
    fs.mkdirSync(path.join(home, 'agent-events'));
    fs.writeFileSync(path.join(home, 'agent-events', `${id}.jsonl`), ev.map((e) => JSON.stringify(e)).join('\n'));

    assert.deepEqual(host.changes(id), ['test/a.feature', 'test/b.ts']);
    const r = host.events(id);
    assert.equal(r.events.length, 6); assert.equal(r.changes, 2); assert.equal(r.usage?.calls, 3);
    const md = host.transcript(id);
    assert.match(md, /^# Login story/);
    assert.match(md, /Model calls: 3, tokens in\/out: 1200\/300/);
    assert.match(md, /## Files changed\n\n- test\/a\.feature\n- test\/b\.ts/);
    assert.match(md, /### Person \(2026-11-21 08:01:00\)\n\nAutomate the login/);
    assert.match(md, /Tool \*\*browser_open\*\* done/);
    assert.match(md, /\*\*Approval asked:\*\* Save the test "Login"/);
    assert.ok(!/```x```/.test(md), 'a fence inside a detail cannot break the transcript');
    assert.match(md, /\*\*Answer:\*\* approved/);
    assert.throws(() => host.transcript('nope'), /No such agent session/);

    await host.remove(id);
    assert.equal(host.list().length, 0);
    assert.ok(!fs.existsSync(path.join(home, 'agent-events', `${id}.jsonl`)));
    fs.rmSync(home, { recursive: true, force: true });
});

test('changes: files from the request (path/file) and the answer (file/feature/files); outside the repository and .git ignored', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ch-'));
    const host = new AgentHost({ repoRoot: home, home, browser: {} as never, secret: () => undefined, call: async () => ({ status: 200, body: {} }), projects: () => [], log: () => {} });
    const s = { changes: new Set<string>(), id: 'x', title: 't', createdAt: '2026-01-01', usage: {} } as never as { changes: Set<string> };
    const h = host as unknown as { changedBy: (s: unknown, m: string, u: string, b: unknown, a: unknown) => void };
    h.changedBy(s, 'GET', '/api/file?path=test/read.ts', undefined, {});
    h.changedBy(s, 'PUT', '/api/file?path=test/q.ts', { path: 'test/b.ts' }, {});
    h.changedBy(s, 'PUT', '/api/apiws/collection', { name: 'x' }, { file: 'test/api/x.collection.json' });
    h.changedBy(s, 'POST', '/api/recorder/save', {}, { feature: 'test/f.feature', files: [{ path: 'test/p.ts' }, 'test/d.json'] });
    h.changedBy(s, 'PUT', '/api/file', { path: '../outside.ts' }, { file: path.join(home, '.git', 'config') });
    assert.deepEqual([...s.changes].sort(), ['test/api/x.collection.json', 'test/b.ts', 'test/d.json', 'test/f.feature', 'test/p.ts', 'test/q.ts']);
    fs.rmSync(home, { recursive: true, force: true });
});
