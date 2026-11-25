import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CATALOG, diffTools, listServers, markReviewed, missingFor, parseImport, recordCheck, resolveServer, saveServer, sdkConfig, serverProblem, testServer, TEAM_FILE, ToolServer } from '../src/agents/toolServers';

/** A tiny MCP server over stdio (newline-delimited JSON-RPC): two tools. */
function fakeServer(dir: string, o: { crash?: boolean } = {}): string {
    const f = path.join(dir, 'fake-mcp.js');
    fs.writeFileSync(f, `
${o.crash ? "process.stderr.write('could not start: missing setting\\\\n'); process.exit(3);" : ''}
let buf = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'Fake shop tools', version: '2.1' } } });
    else if (m.method === 'tools/list') {
      // The tools: from FAKE_TOOLS (a file the test changes) or two; a page of two at a time.
      const all = process.env.FAKE_TOOLS ? JSON.parse(require('fs').readFileSync(process.env.FAKE_TOOLS, 'utf8')) : [{ name: 'order_lookup', description: 'Find an order (' + (process.env.SHOP_KEY ? 'key set' : 'no key') + ')', inputSchema: { type: 'object' } }, { name: 'order_cancel', description: 'Cancel an order', inputSchema: { type: 'object' } }];
      const from = Number((m.params && m.params.cursor) || 0);
      send({ jsonrpc: '2.0', id: m.id, result: { tools: all.slice(from, from + 2), ...(from + 2 < all.length ? { nextCursor: String(from + 2) } : {}) } });
    }
  }
});
`);
    return f;
}

test('tool servers: what can be saved (secrets only as references, no shell, https away from this computer)', () => {
    const ok: ToolServer = { kind: 'stdio', command: 'npx', args: ['-y', 'x'] };
    assert.equal(serverProblem('shop-tools', ok), null);
    assert.match(serverProblem('Shop', ok)!, /Name/);
    assert.match(serverProblem('shop', { ...ok, command: 'npx; rm' })!, /no shell characters/);
    assert.match(serverProblem('shop', { ...ok, env: { API_TOKEN: 'abc123' } })!, /API_TOKEN holds a secret: write it as \{secret:NAME\}/);
    assert.equal(serverProblem('shop', { ...ok, env: { API_TOKEN: '{secret:SHOP_KEY}', REGION: 'eu' } }), null);
    assert.match(serverProblem('gh', { kind: 'http', url: 'https://x.example.com/mcp', headers: { Authorization: 'Bearer plain-value' } })!, /Authorization holds a secret/);
    assert.equal(serverProblem('gh', { kind: 'http', url: 'https://x.example.com/mcp', headers: { Authorization: 'Bearer {secret:GH_TOKEN}' } }), null);
    assert.match(serverProblem('gh', { kind: 'http', url: 'http://x.example.com/mcp' })!, /must use https/);
    assert.equal(serverProblem('local', { kind: 'http', url: 'http://127.0.0.1:9000/mcp' }), null);
    assert.match(serverProblem('x1', { kind: 'other' } as never)!, /Kind/);
    // The ready entries all make servers that can be saved.
    const v: Record<string, Record<string, string>> = { postgres: { connection: 'shop/dev/MAIN' }, 'azure-devops': { organization: 'contoso' }, github: { token: 'GH_TOKEN' } };
    for (const c of CATALOG) assert.equal(serverProblem(c.id, c.make(v[c.id] ?? {})), null, c.id);
});

test('tool servers: team file in the repository, personal file in the Studio home (same name: the personal one), secrets and connections filled in only in memory', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ts-'));
    const repo = path.join(tmp, 'repo');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(repo);
    try {
        saveServer(repo, home, 'team', 'playwright', CATALOG.find((c) => c.id === 'playwright')!.make({}));
        saveServer(repo, home, 'team', 'shop-db', CATALOG.find((c) => c.id === 'postgres')!.make({ connection: 'shop/dev/MAIN' }));
        saveServer(repo, home, 'personal', 'shop-db', { kind: 'stdio', command: 'node', args: ['db.js'], env: { DB_PASSWORD: '{secret:MY_DB_PASS}' }, changes: false });
        const team = JSON.parse(fs.readFileSync(path.join(repo, TEAM_FILE), 'utf8'));
        assert.deepEqual(Object.keys(team.servers), ['playwright', 'shop-db']);
        assert.deepEqual(team.servers['shop-db'].args, ['-y', '@modelcontextprotocol/server-postgres', '{db:shop/dev/MAIN}']);
        const all = listServers(repo, home);
        assert.deepEqual(all.map((x) => `${x.name}:${x.scope}`), ['playwright:team', 'shop-db:personal']);
        const personalDir = path.join(home, 'mcp-servers');
        assert.equal(fs.readdirSync(personalDir).length, 1);
        if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(personalDir, fs.readdirSync(personalDir)[0])).mode & 0o777, 0o600);
        assert.throws(() => saveServer(repo, home, 'team', 'bad', { kind: 'stdio', command: 'x', env: { PASSWORD: 'p' } }), /holds a secret/);
        assert.throws(() => saveServer(repo, home, 'personal', 'nope', null), /No personal server nope/);

        const secrets: Record<string, string> = { MY_DB_PASS: 's3cret' };
        const secret = (n: string) => secrets[n];
        const db = (ref: string) => (ref === 'shop/dev/MAIN' ? 'postgresql://app:pw@db:5432/shop' : null);
        const pg = CATALOG.find((c) => c.id === 'postgres')!.make({ connection: 'shop/dev/MAIN' });
        assert.deepEqual(missingFor(pg, secret, db), []);
        assert.deepEqual(missingFor(pg, secret, () => null), ['connection shop/dev/MAIN']);
        assert.deepEqual(missingFor(pg, secret, () => { throw new Error('The password is encrypted\nmore'); }), ['connection shop/dev/MAIN: The password is encrypted']);
        assert.deepEqual(missingFor(all[1].server, () => undefined, db), ['secret MY_DB_PASS']);
        assert.equal(resolveServer(pg, secret, db).args![2], 'postgresql://app:pw@db:5432/shop');
        assert.equal(resolveServer(all[1].server, secret, db).env!.DB_PASSWORD, 's3cret');
        assert.match(fs.readFileSync(path.join(repo, TEAM_FILE), 'utf8') + fs.readFileSync(path.join(personalDir, fs.readdirSync(personalDir)[0]), 'utf8'), /^(?![\s\S]*(s3cret|app:pw))/, 'no values in the files');

        // The runtime's entries.
        assert.deepEqual(sdkConfig({ kind: 'http', url: 'https://x.example.com/mcp', headers: { A: 'b' }, tools: ['one'] }, repo, {}), { type: 'http', url: 'https://x.example.com/mcp', headers: { A: 'b' }, tools: ['one'] });
        const local = sdkConfig({ kind: 'stdio', command: 'node', args: ['a.js'], env: { X: '1' } }, repo, { PATH: '/bin' });
        assert.deepEqual([local.type, local.command, local.args, local.env, local.workingDirectory, local.tools], ['local', 'node', ['a.js'], { PATH: '/bin', X: '1' }, repo, ['*']]);

        saveServer(repo, home, 'personal', 'shop-db', null);
        assert.equal(listServers(repo, home).find((x) => x.name === 'shop-db')!.scope, 'team');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('tool servers: Test starts the server, lists its tools and stops it; a server that fails says why', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ts-'));
    try {
        const env = { ...process.env, SHOP_KEY: 'k' } as Record<string, string>;
        const r = await testServer({ kind: 'stdio', command: process.execPath, args: [fakeServer(tmp)] }, tmp, env, 20_000);
        assert.equal(r.ok, true, r.error);
        assert.equal(r.server, 'Fake shop tools 2.1');
        assert.deepEqual(r.tools.map((t) => t.name), ['order_lookup', 'order_cancel']);
        assert.match(r.tools[0].description, /key set/);
        const bad = fs.mkdtempSync(path.join(tmp, 'bad-'));
        const f = await testServer({ kind: 'stdio', command: process.execPath, args: [fakeServer(bad, { crash: true })] }, tmp, env, 20_000);
        assert.equal(f.ok, false);
        assert.match(f.error ?? '', /missing setting/);
        const none = await testServer({ kind: 'stdio', command: path.join(tmp, 'no-such-program') }, tmp, env, 20_000);
        assert.equal(none.ok, false);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('tool servers through the Studio: add from the ready list or your own, missing secrets, Test, the policy, remove; agents\' sessions get them', async () => {
    const { createServer } = await import('../src/server/server');
    const { SecretStore } = await import('../src/secrets/store');
    const { KeyFileProtector } = await import('../src/secrets/protector');
    const { writeFakeCopilotSdk } = await import('./fakeCopilot');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ts-'));
    const dir = path.join(tmp, 'shop-tests');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'config', 'shop', 'environments'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'config', 'shop', 'common'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'shop', 'common', 'common.env'), 'PROJECT=shop\nDB_MAIN_TYPE=postgresql\nDB_MAIN_HOST=db.local\nDB_MAIN_PORT=5432\nDB_MAIN_DATABASE=shop\nDB_MAIN_USERNAME=app\nDB_MAIN_PASSWORD=pw\n');
    fs.writeFileSync(path.join(dir, 'config', 'shop', 'environments', 'dev.env'), 'BASE_URL=http://localhost\n');
    writeFakeCopilotSdk(path.join(home, 'agents-runtime'));
    const store = new SecretStore(home, new KeyFileProtector(path.join(home, 'keys', 'secrets.key')));
    const srv = createServer({ repoRoot: dir, store, userName: 'T', token: 't', home });
    const { url } = await srv.listen(0);
    const base = new URL(url).origin;
    const call = async (method: string, p: string, b?: unknown) => {
        const r = await fetch(base + p, { method, headers: { Authorization: 'Bearer t', ...(b ? { 'Content-Type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
        return { status: r.status, body: await r.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    try {
        let v = (await call('GET', '/api/agents/tool-servers')).body;
        assert.deepEqual(v.catalog.map((c: { id: string }) => c.id), CATALOG.map((c) => c.id));
        assert.ok(!('make' in v.catalog[0]));
        assert.deepEqual(v.servers, []);
        assert.deepEqual(v.connections.map((c: { value: string }) => c.value), ['shop/dev/MAIN']);

        // From the ready list: for the team (in the repository).
        v = (await call('PUT', '/api/agents/tool-servers', { scope: 'team', name: 'shop-db', from: 'postgres', values: { connection: 'shop/dev/MAIN' } })).body;
        assert.ok(fs.existsSync(path.join(dir, TEAM_FILE)));
        assert.deepEqual(v.servers.map((x: { name: string; missing: string[]; allowed: boolean }) => [x.name, x.missing, x.allowed]), [['shop-db', [], true]]);
        assert.match((await call('PUT', '/api/agents/tool-servers', { scope: 'team', name: 'x2', from: 'postgres', values: {} })).body.error, /Studio connection: required/);
        assert.match((await call('PUT', '/api/agents/tool-servers', { scope: 'personal', name: 'gh', from: 'github', values: { token: 'plain-value' } })).body.error, /name of a Studio secret/);
        // A secret by name, missing until it is saved in the Studio.
        v = (await call('PUT', '/api/agents/tool-servers', { scope: 'personal', name: 'github', from: 'github', values: { token: 'GH_TOKEN' } })).body;
        assert.deepEqual(v.servers.find((x: { name: string }) => x.name === 'github').missing, ['secret GH_TOKEN']);
        assert.match((await call('POST', '/api/agents/tool-servers/github/test')).body.error, /Missing: secret GH_TOKEN/);
        // Your own server: a literal key is refused; a reference is kept.
        const own = { kind: 'stdio', command: process.execPath, args: [fakeServer(tmp)], env: { SHOP_KEY: 'literal' }, changes: true };
        assert.match((await call('PUT', '/api/agents/tool-servers', { scope: 'personal', name: 'shop-tools', server: own })).body.error, /SHOP_KEY holds a secret/);
        store.setStudio('SHOP_KEY', 'from-the-studio');
        v = (await call('PUT', '/api/agents/tool-servers', { scope: 'personal', name: 'shop-tools', server: { ...own, env: { SHOP_KEY: '{secret:SHOP_KEY}' } } })).body;
        const t = (await call('POST', '/api/agents/tool-servers/shop-tools/test')).body;
        assert.deepEqual([t.ok, t.tools.map((x: { name: string }) => x.name), /key set/.test(t.tools[0].description)], [true, ['order_lookup', 'order_cancel'], true]);
        assert.equal((await call('GET', '/api/agents/tool-servers')).body.servers.find((x: { name: string }) => x.name === 'shop-tools').state.known.length, 2);

        // Agents' sessions get the allowed servers, secrets filled in.
        const created = await call('POST', '/api/agents/sessions', { title: 'Check orders' });
        assert.equal(created.status, 200, JSON.stringify(created.body));
        const cfg = (global as any).__fakeCopilot.lastConfig; // eslint-disable-line @typescript-eslint/no-explicit-any
        assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ['shop-db', 'shop-tools']); // github: its secret is missing
        assert.equal(cfg.mcpServers['shop-tools'].env.SHOP_KEY, 'from-the-studio');
        assert.equal(cfg.mcpServers['shop-db'].args[2], 'postgresql://app:pw@db.local:5432/shop');
        // Even with MCP calls set to "allow": a server that can change things asks; a read-only one does not.
        await call('PUT', '/api/agents/settings', { settings: { approvals: { files: 'ask', shell: 'ask', mcp: 'auto', studio: 'ask', urls: 'ask' } } });
        await call('POST', '/api/agents/sessions', { title: 'Again' });
        const cfg2 = (global as any).__fakeCopilot.lastConfig; // eslint-disable-line @typescript-eslint/no-explicit-any
        assert.deepEqual(await cfg2.onPermissionRequest({ kind: 'mcp', serverName: 'shop-db', toolName: 'query' }), { kind: 'approve-once' });
        let answered = false;
        const asking = cfg2.onPermissionRequest({ kind: 'mcp', serverName: 'shop-tools', toolName: 'order_cancel', args: { id: 7 } }).then((r: unknown) => { answered = true; return r; });
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(answered, false, 'waits for the person');
        const sessions = (await call('GET', '/api/agents/sessions')).body.sessions;
        const again = sessions.find((s: { title: string }) => s.title === 'Again');
        const card = (await call('GET', `/api/agents/sessions/${again.id}/events?after=0`)).body.events.find((e: { type: string }) => e.type === 'approval');
        assert.equal(card.title, 'Use shop-tools tool order_cancel');
        await call('POST', `/api/agents/sessions/${again.id}/approvals/${card.id}`, { decision: 'reject' });
        assert.equal((await asking).kind, 'reject');

        // The repository's policy: only some servers, or none.
        fs.mkdirSync(path.join(dir, '.cs-studio'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.cs-studio', 'agents-policy.json'), JSON.stringify({ toolServers: ['shop-db'] }));
        assert.deepEqual((await call('GET', '/api/agents/tool-servers')).body.servers.map((x: { name: string; allowed: boolean }) => `${x.name}:${x.allowed}`), ['github:false', 'shop-db:true', 'shop-tools:false']);
        await call('POST', '/api/agents/sessions', { title: 'Policy' });
        assert.deepEqual(Object.keys((global as any).__fakeCopilot.lastConfig.mcpServers), ['shop-db']); // eslint-disable-line @typescript-eslint/no-explicit-any
        fs.writeFileSync(path.join(dir, '.cs-studio', 'agents-policy.json'), JSON.stringify({ toolServers: false }));
        await call('POST', '/api/agents/sessions', { title: 'None' });
        assert.equal((global as any).__fakeCopilot.lastConfig.mcpServers, undefined); // eslint-disable-line @typescript-eslint/no-explicit-any
        assert.equal((await call('GET', '/api/agents/tool-servers')).body.policy, false);

        // Remove.
        v = (await call('DELETE', '/api/agents/tool-servers/shop-tools?scope=personal')).body;
        assert.deepEqual(v.servers.map((x: { name: string }) => x.name), ['github', 'shop-db']);
        assert.match((await call('DELETE', '/api/agents/tool-servers/shop-tools?scope=personal')).body.error, /No personal server/);
    } finally {
        await srv.app.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('tool servers: a pasted configuration (mcpServers, servers, one entry): keys become secret references, placeholders too', () => {
    const a = parseImport(JSON.stringify({ mcpServers: {
        'Orders API': { command: 'npx', args: ['-y', '@example/orders-mcp@1.2.0'], env: { ORDERS_API_KEY: 'k-123', REGION: 'eu' } },
        remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer abc' } },
    } }));
    assert.deepEqual(a.map((x) => x.name), ['orders-api', 'remote']);
    assert.deepEqual(a[0].server.env, { ORDERS_API_KEY: '{secret:ORDERS_API_KEY}', REGION: 'eu' });
    assert.deepEqual(a[0].secrets, [{ secret: 'ORDERS_API_KEY', where: 'environment ORDERS_API_KEY', value: 'k-123' }]);
    assert.equal(a[1].server.headers!.Authorization, 'Bearer {secret:REMOTE_AUTHORIZATION}');
    assert.equal(a[1].secrets[0].value, 'abc');
    assert.deepEqual(a.map((x) => x.problem), [null, null]);
    // VS Code's mcp.json with an input placeholder: a secret the person adds.
    const v = parseImport('{ "servers": { "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer ${input:github_token}" } } }, "inputs": [] }');
    assert.deepEqual([v[0].server.headers!.Authorization, v[0].secrets[0].secret, v[0].secrets[0].value], ['Bearer {secret:GITHUB_TOKEN}', 'GITHUB_TOKEN', undefined]);
    // One bare entry: named after its package; trailing commas forgiven.
    const one = parseImport('{ "command": "npx", "args": ["-y", "@playwright/mcp@latest"], }');
    assert.equal(one[0].name, 'playwright');
    assert.equal(parseImport('{"command": "npx", "args": ["-y", "@example/orders-mcp@1.2.0"]}')[0].name, 'orders');
    assert.equal(parseImport('{"x": {"command": "uvx", "args": ["mcp-server-time"]}}')[0].name, 'x');
    assert.match(parseImport('{"mcpServers": {"bad": {"command": "rm -rf /; x"}}}')[0].problem!, /shell/);
    assert.throws(() => parseImport('not json'), /Not JSON/);
    assert.throws(() => parseImport('{"a": 1}'), /No MCP server found/);
});

test('tool servers: checks compared with the last review (added, removed, parameters changed, version)', () => {
    const t = (name: string, schema = 'a') => ({ name, description: name, schema });
    assert.deepEqual(diffTools([t('a'), t('b')], [t('b', 'z'), t('c')]), { added: ['c'], removed: ['a'], changed: ['b'] });
    let st = recordCheck({}, { ok: true, tools: [t('a'), t('b')], server: 'S 1.0', ms: 1 }, 'T1');
    assert.equal(st.diff, undefined, 'the first check is the baseline');
    st = recordCheck(st, { ok: false, tools: [], error: 'down', ms: 1 }, 'T2');
    assert.deepEqual([st.ok, st.known!.length, st.error], [false, 2, 'down'], 'a failed check keeps what was known');
    st = recordCheck(st, { ok: true, tools: [t('a'), t('b', 'new'), t('c')], server: 'S 1.1', ms: 1 }, 'T3');
    assert.deepEqual([st.diff!.added, st.diff!.removed, st.diff!.changed, st.diff!.fromServer, st.diff!.toServer], [['c'], [], ['b'], 'S 1.0', 'S 1.1']);
    // Still against the review: a later check adds up.
    st = recordCheck(st, { ok: true, tools: [t('b', 'new'), t('c')], server: 'S 1.1', ms: 1 }, 'T4');
    assert.deepEqual([st.diff!.added, st.diff!.removed], [['c'], ['a']]);
    st = markReviewed(st);
    assert.equal(st.diff, undefined);
    assert.equal(recordCheck(st, { ok: true, tools: [t('b', 'new'), t('c')], server: 'S 1.1', ms: 1 }).diff, undefined);
    // Listed tools only: the runtime gets exactly those; none listed: all, new ones included.
    assert.deepEqual(sdkConfig({ kind: 'stdio', command: 'x', tools: ['a'] }, '/', {}).tools, ['a']);
    assert.deepEqual(sdkConfig({ kind: 'stdio', command: 'x', tools: [] }, '/', {}).tools, []);
});

test('tool servers managed in the Studio: paste, turn off, choose tools, list changes found by a check or a session, review, edit', async () => {
    const { createServer } = await import('../src/server/server');
    const { SecretStore } = await import('../src/secrets/store');
    const { KeyFileProtector } = await import('../src/secrets/protector');
    const { writeFakeCopilotSdk } = await import('./fakeCopilot');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ts-'));
    const dir = path.join(tmp, 'repo');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(dir, { recursive: true });
    writeFakeCopilotSdk(path.join(home, 'agents-runtime'));
    const toolsFile = path.join(tmp, 'tools.json');
    const tool = (name: string, props: Record<string, unknown> = {}) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: props } });
    fs.writeFileSync(toolsFile, JSON.stringify([tool('order_lookup'), tool('order_cancel'), tool('order_refund')]));
    process.env.FAKE_TOOLS = toolsFile;
    const store = new SecretStore(home, new KeyFileProtector(path.join(home, 'keys', 'secrets.key')));
    store.setStudio('UNUSED', 'x');
    const srv = createServer({ repoRoot: dir, store, userName: 'T', token: 't', home });
    const { url } = await srv.listen(0);
    const base = new URL(url).origin;
    const call = async (method: string, p: string, b?: unknown) => {
        const r = await fetch(base + p, { method, headers: { Authorization: 'Bearer t', ...(b ? { 'Content-Type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
        return { status: r.status, body: await r.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const row = async (n: string) => (await call('GET', '/api/agents/tool-servers')).body.servers.find((x: { name: string }) => x.name === n);
    try {
        // Paste the configuration from a server's documentation: the key goes to the Studio secrets.
        const text = JSON.stringify({ mcpServers: { shop: { command: process.execPath, args: [fakeServer(tmp)], env: { SHOP_API_KEY: 'pasted-key' } } } });
        const pv = (await call('POST', '/api/agents/tool-servers/import', { scope: 'team', text })).body;
        assert.deepEqual(pv.servers.map((s: { name: string; secrets: unknown[] }) => [s.name, s.secrets]), [['shop', [{ secret: 'SHOP_API_KEY', where: 'environment SHOP_API_KEY', fromPaste: true, saved: false }]]]);
        assert.equal(fs.existsSync(path.join(dir, TEAM_FILE)), false, 'a preview writes nothing');
        const added = (await call('POST', '/api/agents/tool-servers/import', { scope: 'team', text, apply: true })).body;
        assert.deepEqual(added.added, ['shop']);
        assert.equal(store.getStudio('SHOP_API_KEY'), 'pasted-key');
        assert.doesNotMatch(fs.readFileSync(path.join(dir, TEAM_FILE), 'utf8'), /pasted-key/);
        assert.match((await call('POST', '/api/agents/tool-servers/import', { scope: 'team', text, apply: true })).body.error, /already/);

        // Check: three tools (two pages); the first check is the baseline.
        const c1 = (await call('POST', '/api/agents/tool-servers/shop/test')).body;
        assert.deepEqual([c1.ok, c1.tools.map((t: { name: string }) => t.name), c1.diff], [true, ['order_lookup', 'order_cancel', 'order_refund'], null]);

        // Only some tools: the session gets exactly those.
        await call('PATCH', '/api/agents/tool-servers/shop', { scope: 'team', tools: ['order_lookup', 'order_cancel'] });
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, TEAM_FILE), 'utf8')).servers.shop.tools, ['order_cancel', 'order_lookup']);
        await call('POST', '/api/agents/sessions', { title: 'S1' });
        const fake = (global as any).__fakeCopilot; // eslint-disable-line @typescript-eslint/no-explicit-any
        assert.deepEqual(fake.lastConfig.mcpServers.shop.tools, ['order_cancel', 'order_lookup']);
        assert.equal(fake.lastConfig.mcpServers.shop.env.SHOP_API_KEY, 'pasted-key');
        // Off: kept, not given to agents.
        await call('PATCH', '/api/agents/tool-servers/shop', { scope: 'team', enabled: false });
        await call('POST', '/api/agents/sessions', { title: 'S2' });
        assert.equal(fake.lastConfig.mcpServers, undefined);
        assert.equal((await row('shop')).server.enabled, false);
        await call('PATCH', '/api/agents/tool-servers/shop', { scope: 'team', enabled: true });

        // The server changes: a tool added, one gone, one with new parameters.
        fs.writeFileSync(toolsFile, JSON.stringify([tool('order_lookup', { id: { type: 'string' } }), tool('order_cancel'), tool('order_export')]));
        const c2 = (await call('POST', '/api/agents/tool-servers/shop/test')).body;
        assert.deepEqual([c2.diff.added, c2.diff.removed, c2.diff.changed], [['order_export'], ['order_refund'], ['order_lookup']]);
        // The new tool is off (only the listed ones run) until turned on.
        await call('POST', '/api/agents/sessions', { title: 'S3' });
        assert.deepEqual(fake.lastConfig.mcpServers.shop.tools, ['order_cancel', 'order_lookup']);
        await call('POST', '/api/agents/tool-servers/shop/reviewed', { scope: 'team' });
        assert.equal((await row('shop')).state.diff, null);

        // All tools again: new ones included from now on.
        await call('PATCH', '/api/agents/tool-servers/shop', { scope: 'team', tools: null });
        await call('POST', '/api/agents/sessions', { title: 'S4' });
        assert.deepEqual(fake.lastConfig.mcpServers.shop.tools, ['*']);

        // A session sees a different number of tools: the Studio checks again by itself.
        fs.writeFileSync(toolsFile, JSON.stringify([tool('order_lookup', { id: { type: 'string' } }), tool('order_cancel'), tool('order_export'), tool('order_notes')]));
        const h = fake.handlers[fake.handlers.length - 1];
        h({ type: 'session.mcp_server_tools_loaded', data: { serverName: 'shop', toolCount: 4 } });
        let r: any; // eslint-disable-line @typescript-eslint/no-explicit-any
        for (let i = 0; i < 100; i++) { r = await row('shop'); if (r.state.diff) break; await new Promise((x) => setTimeout(x, 50)); }
        assert.deepEqual(r.state.diff.added, ['order_notes']);
        assert.equal(r.state.session.toolCount, 4);
        // A server failing in a session: kept for the screen, said in the conversation.
        h({ type: 'session.mcp_server_status_changed', data: { serverName: 'shop', status: 'failed', error: 'spawn failed' } });
        r = await row('shop');
        assert.deepEqual([r.state.session.status, r.state.session.error], ['failed', 'spawn failed']);
        const s4 = (await call('GET', '/api/agents/sessions')).body.sessions.find((x: { title: string }) => x.title === 'S4');
        const info = (await call('GET', `/api/agents/sessions/${s4.id}/events?after=0`)).body.events.filter((e: { type: string }) => e.type === 'info').map((e: { text: string }) => e.text);
        assert.ok(info.some((t: string) => /Tool server shop could not start: spawn failed/.test(t)), JSON.stringify(info));

        // Edit (and rename): the settings kept, the old name gone.
        const cur = (await row('shop')).server;
        const ed = (await call('PUT', '/api/agents/tool-servers', { scope: 'team', name: 'shop-orders', editing: 'shop', server: { ...cur, description: 'Orders' } })).body;
        assert.deepEqual(ed.servers.map((x: { name: string }) => x.name), ['shop-orders']);
        assert.equal(ed.servers[0].server.description, 'Orders');
        // Check all.
        const all = (await call('POST', '/api/agents/tool-servers/check')).body;
        assert.equal(all.servers[0].state.known.length, 4);
    } finally {
        delete process.env.FAKE_TOOLS;
        await srv.app.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
