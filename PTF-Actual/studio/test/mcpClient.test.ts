/**
 * The Studio's one MCP client (tool-server checks, API workspace MCP requests and load steps): servers that ask the
 * client something before answering (stdio and HTTP), answers in an event stream with a server request first, paging,
 * the session ended on close, refusals and crashes said plainly, and a round trip with the Studio's own MCP server.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { McpClient, parseMcpBody } from '../src/mcp/client';

test('event streams and batches', () => {
    assert.deepEqual(parseMcpBody('text/event-stream', 'event: message\ndata: {"jsonrpc":"2.0","method":"ping","id":"s1"}\n\ndata: {"jsonrpc":"2.0",\ndata: "id":1,"result":{}}\n\n'), [{ jsonrpc: '2.0', method: 'ping', id: 's1' }, { jsonrpc: '2.0', id: 1, result: {} }]);
    assert.deepEqual(parseMcpBody('application/json', '[{"id":1,"result":1},{"id":2,"result":2}]').length, 2);
});

test('stdio: the server asks for the client\'s folders before it answers; tools in pages; a crash says why', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-'));
    try {
        const f = path.join(tmp, 'srv.js');
        fs.writeFileSync(f, `
let buf = ''; let initId = null;
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdout.write('starting (a log line, not JSON)\\n');
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
  if (m.method === 'initialize') { initId = m.id; send({ jsonrpc: '2.0', id: 'ask-1', method: 'roots/list' }); }
  else if (m.id === 'ask-1') send({ jsonrpc: '2.0', id: initId, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'Asker', version: '3' } } });
  else if (m.method === 'tools/list') { const from = Number((m.params && m.params.cursor) || 0); send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 't' + from }, { name: 't' + (from + 1) }], ...(from < 2 ? { nextCursor: String(from + 2) } : {}) } }); }
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unknown tool ' + m.params.name } });
}});`);
        const c = await McpClient.connect({ kind: 'stdio', command: process.execPath, args: [f], cwd: tmp, env: process.env as Record<string, string> }, { timeoutMs: 10_000 });
        try {
            assert.deepEqual([c.serverLabel, c.server.protocol], ['Asker 3', '2025-03-26']);
            assert.deepEqual((await c.listTools()).map((t) => t.name), ['t0', 't1', 't2', 't3']);
            await assert.rejects(c.callTool('nope'), /Unknown tool nope/);
        } finally { await c.close(); }
        const crash = path.join(tmp, 'crash.js');
        fs.writeFileSync(crash, "process.stderr.write('no licence key\\n'); process.exit(2);");
        await assert.rejects(McpClient.connect({ kind: 'stdio', command: process.execPath, args: [crash], cwd: tmp, env: process.env as Record<string, string> }, { timeoutMs: 10_000 }), /stopped \(exit code 2\): no licence key/);
        await assert.rejects(McpClient.connect({ kind: 'stdio', command: path.join(tmp, 'missing'), cwd: tmp, env: process.env as Record<string, string> }, { timeoutMs: 10_000 }), /was not found on this computer/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('HTTP: a ping in the answer stream is answered, the session goes with each message and is ended on close', async () => {
    const log: string[] = [];
    let pinged = false;
    const srv = http.createServer((q, r) => {
        let b = ''; q.on('data', (d) => { b += d; }); q.on('end', () => {
            log.push(`${q.method} ${q.headers['mcp-session-id'] ?? '-'} ${q.headers['mcp-protocol-version'] ?? '-'} ${q.headers['x-team'] ?? '-'} ${b ? JSON.parse(b).method ?? `reply:${JSON.parse(b).id}` : ''}`);
            if (q.headers.authorization !== 'Bearer ok') { r.writeHead(401); r.end(); return; }
            if (q.method === 'DELETE') { r.writeHead(204); r.end(); return; }
            const m = JSON.parse(b);
            if (m.method === 'initialize') { r.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-1' }); r.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'Remote', version: '1' } } })); return; }
            if (m.id === 'p1') { pinged = true; r.writeHead(202); r.end(); return; }
            if (m.id === undefined) { r.writeHead(202); r.end(); return; }
            // tools/call: a progress notification and a ping first, then the answer.
            r.writeHead(200, { 'Content-Type': 'text/event-stream' });
            r.end([{ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }, { jsonrpc: '2.0', id: 'p1', method: 'ping' }, { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'done' }] } }].map((x) => `data: ${JSON.stringify(x)}\n\n`).join(''));
        });
    });
    const port = await new Promise<number>((res) => srv.listen(0, '127.0.0.1', () => res((srv.address() as net.AddressInfo).port)));
    try {
        const url = `http://127.0.0.1:${port}/mcp`;
        await assert.rejects(McpClient.connect({ kind: 'http', url, headers: { Authorization: 'Bearer bad' } }), /refused the credentials \(401\)/);
        const seen: string[] = [];
        const c = await McpClient.connect({ kind: 'http', url, headers: { Authorization: 'Bearer ok', 'X-Team': 'qa' } }, { onMessage: (m) => seen.push(String(m.method ?? 'answer')) });
        const r = await c.callTool('lookup', { id: 1 });
        assert.equal(r.content?.[0].text, 'done', 'the answer, not the ping');
        await new Promise((z) => setTimeout(z, 100));
        assert.ok(pinged, 'the ping was answered');
        assert.deepEqual(seen.filter((x) => x !== 'answer'), ['notifications/progress', 'ping']);
        await c.close();
        assert.deepEqual(log.slice(1), [
            'POST - 2025-06-18 qa initialize', 'POST sess-1 2025-06-18 qa notifications/initialized', 'POST sess-1 2025-06-18 qa tools/call', 'POST sess-1 2025-06-18 qa reply:p1', 'DELETE sess-1 2025-06-18 qa ',
        ]);
        await assert.rejects(McpClient.connect({ kind: 'http', url: 'ftp://x/mcp' }), /http\(s\)/);
    } finally { srv.close(); }
});

test('a round trip with the Studio\'s own MCP server', async () => {
    const { createServer } = await import('../src/server/server');
    const { runGit } = await import('../src/git/run');
    const { SecretStore } = await import('../src/secrets/store');
    const { KeyFileProtector } = await import('../src/secrets/protector');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-studio-'));
    const dir = path.join(tmp, 'repo'), home = path.join(tmp, 'home');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    fs.mkdirSync(path.join(dir, 'config/shop/environments'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config/shop/environments/dev.env'), 'BASE_URL=http://localhost\n');
    fs.mkdirSync(path.join(dir, 'test/shop/features'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test/shop/features/login.feature'), 'Feature: Login\n  Scenario: Works\n    Given I log in\n');
    const store = new SecretStore(home, new KeyFileProtector(path.join(home, 'keys', 'secrets.key')));
    const srv = createServer({ repoRoot: dir, store, userName: 'T', token: 'studio-token', home });
    const { url } = await srv.listen(0);
    try {
        const on = await (await fetch(new URL('/api/mcp', url), { method: 'PUT', headers: { Authorization: 'Bearer studio-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) })).json() as { url: string; token: string };
        const c = await McpClient.connect({ kind: 'http', url: on.url, headers: { Authorization: `Bearer ${on.token}` } }, { clientInfo: { name: 'Round trip', version: '1' } });
        try {
            assert.equal(c.server.name, 'cs-test-studio');
            assert.ok((await c.listTools()).some((t) => t.name === 'studio_call'));
            const r = await c.callTool('studio_call', { method: 'GET', path: '/api/file', query: { path: 'test/shop/features/login.feature' } });
            assert.equal(r.isError, false, r.content?.[0].text);
            assert.match(r.content?.[0].text ?? '', /Scenario: Works/);
        } finally { await c.close(); }
    } finally { await srv.app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
