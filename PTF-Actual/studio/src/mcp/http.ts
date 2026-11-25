/**
 * The Studio is an MCP server itself: any MCP client (an assistant in an editor, a command-line agent, a chat app)
 * connects straight to it, with nothing in between, at
 *
 *     http://127.0.0.1:<Studio port>/mcp        Authorization: Bearer <the Studio's MCP token>
 *
 * Streamable HTTP transport of the Model Context Protocol (2025-06-18, 2025-03-26):
 *  - POST /mcp: a JSON-RPC message (or a batch). `initialize` starts a session, its id comes back in the
 *    Mcp-Session-Id header and goes with every later request. Notifications are answered 202. A tool call is
 *    answered as an event stream when the client accepts one: it may wait for the person's approval, so the
 *    stream keeps the connection alive meanwhile; otherwise as JSON.
 *  - DELETE /mcp ends the session; GET /mcp (a stream the server opens) is not offered (405).
 *  - A session idle for an hour ends by itself; its waiting approvals count as rejected.
 *
 * What a session can do is what the Studio's agents can do (studio_catalog / studio_call, the browser, tests_run,
 * the application code): each session is a conversation in the Agents screen, its calls are shown there, changes
 * wait for the person's approval card, the repository's agent policy and secret masking apply.
 *
 * Off until the person turns it on (Settings). Its own token (not the Studio's launch token): it opens /mcp only,
 * and can be renewed without touching the Studio's link. Localhost only; the Studio's Host / Origin checks apply.
 */
import { randomBytes, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ensurePrivateDir, writeFileAtomic } from '../core/paths';
import type { ToolDef } from '../agents/tools';

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];
const IDLE_MS = 60 * 60 * 1000;

/** The part of the agent host MCP sessions use. */
export interface McpHost {
    mcpRefusal(): string | null;
    mcpOpen(client: string): { id: string; title: string };
    mcpList(id: string): ToolDef[];
    mcpCall(id: string, name: string, args: unknown): Promise<{ text: string; isError: boolean }>;
    mcpClose(id: string): void;
}

export interface McpDeps {
    /** Where the MCP token is kept (the Studio's private keys folder). */
    keysDir: string;
    host: McpHost;
    enabled: () => boolean;
    version: string;
    log: (event: string, text: string, data?: Record<string, string | number | boolean | null>) => void;
}

interface Session { conversation: string; client: string; protocol: string; lastUsed: number }
type Msg = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The MCP token: made the first time, kept owner-readable only. */
export function mcpToken(keysDir: string, renew = false): string {
    const f = path.join(keysDir, 'mcp-token');
    if (!renew) { try { const t = fs.readFileSync(f, 'utf8').trim(); if (/^[A-Za-z0-9_-]{40,}$/.test(t)) return t; } catch { /* first time */ } }
    const t = randomBytes(32).toString('base64url');
    ensurePrivateDir(keysDir);
    writeFileAtomic(f, t, 0o600);
    return t;
}

export function registerMcp(app: FastifyInstance, d: McpDeps) {
    const sessions = new Map<string, Session>();
    const close = (id: string, why: string) => {
        const s = sessions.get(id);
        if (!s) return;
        sessions.delete(id);
        d.host.mcpClose(s.conversation);
        d.log('agent.mcp', `An MCP client's session ended (${why}): ${s.client}`, {});
    };
    const sweep = setInterval(() => { const now = Date.now(); for (const [id, s] of sessions) if (now - s.lastUsed > IDLE_MS) close(id, 'idle'); }, 5 * 60 * 1000);
    sweep.unref();
    app.addHook('onClose', async () => { clearInterval(sweep); for (const id of [...sessions.keys()]) close(id, 'the Studio stopped'); });

    const authorized = (req: FastifyRequest) => {
        const auth = String(req.headers.authorization ?? '');
        const given = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7) : '');
        const want = Buffer.from(mcpToken(d.keysDir));
        return given.length === want.length && timingSafeEqual(given, want);
    };
    const rpcError = (id: Msg['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

    /** One request of a session (initialize is handled before). */
    const answer = async (m: Msg, sid: string, s: Session): Promise<object | null> => {
        const isRequest = m.id !== undefined && m.id !== null;
        switch (m.method) {
            case 'notifications/initialized': case 'notifications/cancelled': return null;
            case 'ping': return { jsonrpc: '2.0', id: m.id, result: {} };
            case 'tools/list': {
                const refused = d.host.mcpRefusal();
                if (refused) return rpcError(m.id, -32603, refused);
                return { jsonrpc: '2.0', id: m.id, result: { tools: d.host.mcpList(s.conversation).map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) } };
            }
            case 'tools/call': {
                const r = await d.host.mcpCall(s.conversation, String(m.params?.name ?? ''), m.params?.arguments ?? {})
                    .catch((e: Error) => ({ text: e.message.split('\n')[0], isError: true }));
                return { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: r.text }], isError: r.isError } };
            }
            default:
                void sid;
                return isRequest ? rpcError(m.id, -32601, `Method not found: ${m.method}`) : null;
        }
    };

    app.route({
        method: ['POST', 'GET', 'DELETE'],
        url: '/mcp',
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
            if (!d.enabled()) return reply.code(404).send({ error: 'The Studio\'s MCP server is off: turn it on in the Studio (Settings → Assistants over MCP).' });
            if (!authorized(req)) return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'Missing or invalid MCP token (Studio Settings → Assistants over MCP).' });
            const sid = String(req.headers['mcp-session-id'] ?? '');
            if (req.method === 'GET') return reply.code(405).header('Allow', 'POST, DELETE').send({ error: 'This server does not open a stream: send requests with POST.' });
            if (req.method === 'DELETE') {
                if (!sessions.has(sid)) return reply.code(404).send({ error: 'No such session.' });
                close(sid, 'the client ended it');
                return reply.code(204).send();
            }
            const body = req.body as Msg | Msg[] | undefined;
            const msgs = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
            if (!msgs.length || msgs.some((m) => !m || typeof m !== 'object' || m.jsonrpc !== '2.0')) return reply.code(400).send(rpcError(null, -32600, 'Invalid JSON-RPC message.'));

            // initialize: a new session (and its conversation in the Agents screen).
            const init = msgs.find((m) => m.method === 'initialize');
            if (init) {
                if (msgs.length > 1) return reply.code(400).send(rpcError(init.id, -32600, 'initialize must be sent alone.'));
                const client = String(init.params?.clientInfo?.name ?? 'MCP client').slice(0, 60);
                let conv: { id: string; title: string };
                try { conv = d.host.mcpOpen(client); } catch (e) { return reply.code(403).send(rpcError(init.id, -32603, (e as Error).message)); }
                const asked = String(init.params?.protocolVersion ?? '');
                const protocol = MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
                const id = randomBytes(16).toString('hex');
                sessions.set(id, { conversation: conv.id, client, protocol, lastUsed: Date.now() });
                return reply.header('Mcp-Session-Id', id).send({
                    jsonrpc: '2.0', id: init.id,
                    result: {
                        protocolVersion: protocol,
                        capabilities: { tools: { listChanged: false } },
                        serverInfo: { name: 'cs-test-studio', title: 'CS Test Studio', version: d.version },
                        instructions: 'CS Test Studio for this repository. studio_catalog lists what the Studio can do (tests, runs, API requests, databases, recorder, Azure DevOps, Git…) and studio_call does it; browser_* drive the Studio browser; tests_run runs features with the framework. The person sees every call in the Studio and approves changes there.',
                    },
                });
            }
            const s = sessions.get(sid);
            if (!sid) return reply.code(400).send(rpcError(null, -32600, 'Mcp-Session-Id header missing: send initialize first.'));
            if (!s) return reply.code(404).send(rpcError(null, -32001, 'Session not found (it ended): initialize again.'));
            const pv = req.headers['mcp-protocol-version'];
            if (pv && !MCP_PROTOCOL_VERSIONS.includes(String(pv)) && pv !== '2024-11-05') return reply.code(400).send(rpcError(null, -32600, `Unsupported MCP-Protocol-Version ${pv}.`));
            s.lastUsed = Date.now();

            const requests = msgs.filter((m) => m.id !== undefined && m.id !== null);
            if (!requests.length) { await Promise.all(msgs.map((m) => answer(m, sid, s))); return reply.code(202).send(); }

            // A tool call can wait for the person: as an event stream (kept alive) when the client takes one.
            const streams = /text\/event-stream/.test(String(req.headers.accept ?? '')) && requests.some((m) => m.method === 'tools/call');
            if (!streams) {
                const out = (await Promise.all(msgs.map((m) => answer(m, sid, s)))).filter(Boolean);
                s.lastUsed = Date.now();
                return reply.header('Mcp-Session-Id', sid).send(Array.isArray(body) ? out : out[0]);
            }
            reply.hijack();
            const res = reply.raw;
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'Mcp-Session-Id': sid });
            const alive = setInterval(() => { if (!res.writableEnded) res.write(': waiting\n\n'); }, 15_000);
            try {
                await Promise.all(msgs.map(async (m) => {
                    const a = await answer(m, sid, s);
                    if (a && !res.writableEnded) res.write(`event: message\ndata: ${JSON.stringify(a)}\n\n`);
                }));
            } finally {
                clearInterval(alive);
                s.lastUsed = Date.now();
                if (!res.writableEnded) res.end();
            }
        },
    });

    return { sessions: () => [...sessions.values()].map((s) => ({ client: s.client, conversation: s.conversation, lastUsed: new Date(s.lastUsed).toISOString() })) };
}
