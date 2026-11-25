/**
 * Protocol servers for tests: an AMQP 1.0 broker (rhea, SASL PLAIN RootManageSharedAccessKey / k3y=) and an MCP
 * server over streamable HTTP (tools "add", tools/list).
 */
import * as http from 'http';
import * as net from 'net';
import type * as RheaNs from 'rhea';
// rhea's module is a container object (its methods on the prototype): required as it is, not as a namespace copy.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rhea: typeof RheaNs = require('rhea');

/** A broker: messages sent to an address go to the receivers of that address (queue semantics: one each). */
export async function broker(): Promise<{ port: number; close: () => void; received: string[] }> {
    const c = rhea.create_container({ id: 'lab-broker' });
    c.sasl_server_mechanisms.enable_plain((u: string, p: string) => u === 'RootManageSharedAccessKey' && p === 'k3y=');
    const receivers = new Map<string, RheaNs.Sender[]>();
    const received: string[] = [];
    c.on('sender_open', (ctx) => { const a = ctx.sender!.source.address; receivers.set(a, [...(receivers.get(a) ?? []), ctx.sender!]); ctx.sender!.set_source({ address: a }); });
    c.on('receiver_open', (ctx) => ctx.receiver!.set_target({ address: ctx.receiver!.target.address }));
    c.on('sender_close', (ctx) => { const a = ctx.sender!.source.address; receivers.set(a, (receivers.get(a) ?? []).filter((s) => s !== ctx.sender)); });
    const gone = (ctx: RheaNs.EventContext) => { for (const [a, l] of receivers) receivers.set(a, l.filter((s) => s.connection !== ctx.connection)); };
    c.on('disconnected', gone); c.on('connection_close', gone);
    c.on('message', (ctx) => {
        const a = ctx.receiver!.target.address;
        received.push(`${a}${ctx.message.subject ? `#${ctx.message.subject}` : ''}`);
        const l = receivers.get(a) ?? [];
        if (!l.length) return;
        const s = l.shift()!; l.push(s);
        s.send(ctx.message);
    });
    const server = c.listen({ port: 0, host: '127.0.0.1' }) as unknown as net.Server;
    await new Promise((r) => server.once('listening', r));
    return { port: (server.address() as net.AddressInfo).port, close: () => server.close(), received };
}

/** An MCP server (streamable HTTP): initialize with a session, tools/list, tools/call "add" (answered as an event stream). */
export async function mcpServer(): Promise<{ url: string; close: () => void; sessions: Set<string>; deleted: string[] }> {
    const sessions = new Set<string>(), deleted: string[] = [];
    const s = http.createServer((q, r) => {
        if (q.method === 'DELETE') { deleted.push(String(q.headers['mcp-session-id'])); r.writeHead(200); r.end(); return; }
        let b = '';
        q.on('data', (c) => (b += c));
        q.on('end', () => {
            const m = JSON.parse(b);
            if (m.method === 'initialize') {
                const id = `s${sessions.size + 1}`; sessions.add(id);
                r.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': id });
                r.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'lab-tools', version: '1.2' } } }));
                return;
            }
            if (!sessions.has(String(q.headers['mcp-session-id']))) { r.writeHead(400); r.end('no session'); return; }
            if (m.method === 'notifications/initialized') { r.writeHead(202); r.end(); return; }
            if (m.method === 'tools/list') { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'add' }] } })); return; }
            if (m.method === 'tools/call' && m.params.name === 'add') {
                r.writeHead(200, { 'Content-Type': 'text/event-stream' });
                r.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`);
                setTimeout(() => r.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(m.params.arguments.a + m.params.arguments.b) }] } })}\n\n`), 15);
                return;
            }
            r.writeHead(200, { 'Content-Type': 'application/json' });
            r.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Unknown method ${m.method}` } }));
        });
    });
    await new Promise<void>((res) => s.listen(0, '127.0.0.1', res));
    return { url: `http://127.0.0.1:${(s.address() as net.AddressInfo).port}/mcp`, close: () => s.close(), sessions, deleted };
}

