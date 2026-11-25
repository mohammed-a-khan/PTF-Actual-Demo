import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

test('MCP: the Studio is the MCP server (Streamable HTTP at /mcp): off until turned on, its own token, sessions, approvals in the Studio, the policy applies', async () => {
    const { createServer } = await import('../src/server/server');
    const { runGit } = await import('../src/git/run');
    const { SecretStore } = await import('../src/secrets/store');
    const { KeyFileProtector } = await import('../src/secrets/protector');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mcp-'));
    const dir = path.join(tmp, 'shop-tests');
    const home = path.join(tmp, 'home');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    const w = (p: string, t: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); };
    w('config/shop/common/common.env', 'PROJECT=shop\n');
    w('config/shop/environments/dev.env', 'BASE_URL=http://localhost\n');
    w('test/shop/features/login.feature', 'Feature: Login\n  Scenario: Works\n    Given I log in\n');
    const store = new SecretStore(home, new KeyFileProtector(path.join(home, 'keys', 'secrets.key')));
    const srv = createServer({ repoRoot: dir, store, userName: 'T', token: 'studio-token', home });
    const { url } = await srv.listen(0);
    const base = new URL(url).origin;
    // The Studio's own API (the screens), with its launch token.
    const studio = async (method: string, p: string, b?: unknown) => (await fetch(base + p, { method, headers: { Authorization: 'Bearer studio-token', ...(b ? { 'Content-Type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined })).json() as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    // An MCP client: straight to /mcp.
    let token = '';
    let session = '';
    let n = 0;
    const mcp = async (method: string, params?: unknown, o: { sse?: boolean; notify?: boolean; sid?: string; tok?: string } = {}) => {
        const r = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: o.sse ? 'application/json, text/event-stream' : 'application/json', Authorization: `Bearer ${o.tok ?? token}`, ...(session || o.sid ? { 'Mcp-Session-Id': o.sid ?? session, 'MCP-Protocol-Version': '2025-06-18' } : {}) },
            body: JSON.stringify(o.notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++n, method, params }),
        });
        const text = await r.text();
        const ct = r.headers.get('content-type') ?? '';
        const data = ct.includes('text/event-stream') ? JSON.parse(text.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) : text ? JSON.parse(text) : null;
        return { status: r.status, sid: r.headers.get('mcp-session-id'), ct, data };
    };
    try {
        // Off until turned on in the Studio (Settings).
        assert.equal((await mcp('initialize', {}, { tok: 'x' })).status, 404);
        const on = await studio('PUT', '/api/mcp', { enabled: true });
        assert.deepEqual([on.enabled, on.url], [true, `${base}/mcp`]);
        token = on.token;
        assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
        assert.ok(fs.statSync(path.join(home, 'keys', 'mcp-token')).isFile());
        // Its own token: the Studio's launch token does not open /mcp; a wrong one is refused.
        assert.equal((await mcp('initialize', {}, { tok: 'studio-token' })).status, 401);

        const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Any MCP client', version: '1' } });
        assert.equal(init.status, 200);
        assert.deepEqual([init.data.result.protocolVersion, init.data.result.serverInfo.name, !!init.data.result.capabilities.tools], ['2025-06-18', 'cs-test-studio', true]);
        assert.match(init.sid ?? '', /^[0-9a-f]{32}$/);
        session = init.sid!;
        assert.equal((await mcp('notifications/initialized', undefined, { notify: true })).status, 202);
        const list = await mcp('tools/list');
        const names = list.data.result.tools.map((t: { name: string }) => t.name);
        for (const t of ['studio_catalog', 'studio_call', 'tests_run', 'browser_open']) assert.ok(names.includes(t), t);
        // Without a session: refused; an unknown session: 404 (the client initializes again).
        assert.equal((await mcp('tools/list', undefined, { sid: 'f'.repeat(32) })).status, 404);

        // The conversation in the Studio's Agents screen.
        const conv = (await studio('GET', '/api/agents/sessions')).sessions.find((s: { title: string }) => s.title === 'MCP: Any MCP client');
        assert.ok(conv);

        // A read: at once (JSON).
        const read = await mcp('tools/call', { name: 'studio_call', arguments: { method: 'GET', path: '/api/file', query: { path: 'test/shop/features/login.feature' } } });
        assert.equal(read.data.result.isError, false, read.data.result.content[0].text);
        const body = JSON.parse(read.data.result.content[0].text).body;
        const hash = (typeof body === 'string' ? JSON.parse(body) : body).hash as string;
        // Agents' and MCP's own routes are out of reach (the token stays in the Studio).
        assert.equal((await mcp('tools/call', { name: 'studio_call', arguments: { method: 'GET', path: '/api/mcp' } })).data.result.isError, true);

        // A change: an event stream that waits for the person's approval card.
        const pending = mcp('tools/call', { name: 'studio_call', arguments: { method: 'PUT', path: '/api/file', body: { path: 'test/shop/features/login.feature', content: 'Feature: Login\n  Scenario: Works again\n    Given I log in\n', expectedHash: hash } } }, { sse: true });
        const approval = async (k: number) => {
            for (let i = 0; i < 100; i++) {
                const a = (await studio('GET', `/api/agents/sessions/${conv.id}/events?after=0`)).events.filter((e: { type: string }) => e.type === 'approval')[k];
                if (a) return a as { id: string; title: string };
                await new Promise((r) => setTimeout(r, 50));
            }
            throw new Error('no approval card');
        };
        const a1 = await approval(0);
        assert.equal(a1.title, 'PUT /api/file');
        assert.doesNotMatch(fs.readFileSync(path.join(dir, 'test/shop/features/login.feature'), 'utf8'), /again/, 'nothing changed before the approval');
        await studio('POST', `/api/agents/sessions/${conv.id}/approvals/${a1.id}`, { decision: 'once' });
        const done = await pending;
        assert.match(done.ct, /text\/event-stream/);
        assert.equal(done.data.result.isError, false, done.data.result.content[0].text);
        assert.match(fs.readFileSync(path.join(dir, 'test/shop/features/login.feature'), 'utf8'), /Works again/);
        // Rejected: nothing written, the assistant is told.
        const rejected = mcp('tools/call', { name: 'studio_call', arguments: { method: 'PUT', path: '/api/file', body: { path: 'test/shop/features/new.feature', content: 'Feature: x\n', expectedHash: null } } }, { sse: true });
        await studio('POST', `/api/agents/sessions/${conv.id}/approvals/${(await approval(1)).id}`, { decision: 'reject' });
        assert.match((await rejected).data.result.content[0].text, /did not approve|not approved/i);
        assert.equal(fs.existsSync(path.join(dir, 'test/shop/features/new.feature')), false);

        // The repository's policy turns MCP clients off.
        w('.cs-studio/agents-policy.json', JSON.stringify({ mcp: false, note: 'Ask the QA lead.' }));
        const off = await mcp('tools/call', { name: 'studio_catalog', arguments: {} });
        assert.equal(off.data.result.isError, true);
        assert.match(off.data.result.content[0].text, /MCP clients are turned off in this repository \(\.cs-studio\/agents-policy\.json\)\. Ask the QA lead\./);
        fs.rmSync(path.join(dir, '.cs-studio'), { recursive: true });
        assert.equal((await mcp('nope/method')).data.error.code, -32601);
        assert.equal((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${token}` } })).status, 405);

        // The client ends the session: the conversation stays (closed), the session is gone.
        assert.equal((await fetch(`${base}/mcp`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': session } })).status, 204);
        assert.equal((await mcp('tools/list')).status, 404);
        assert.equal((await studio('GET', '/api/agents/sessions')).sessions.find((s: { id: string }) => s.id === conv.id)?.active, false);

        // Renewing the token locks the old one out.
        const renewed = await studio('POST', '/api/mcp/token');
        assert.notEqual(renewed.token, token);
        session = '';
        assert.equal((await mcp('initialize', { clientInfo: { name: 'x' } })).status, 401);
        token = renewed.token;
        assert.equal((await mcp('initialize', { clientInfo: { name: 'x' } })).status, 200);
        // Turned off again: gone.
        await studio('PUT', '/api/mcp', { enabled: false });
        session = '';
        assert.equal((await mcp('initialize', {})).status, 404);
    } finally {
        await srv.app.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
