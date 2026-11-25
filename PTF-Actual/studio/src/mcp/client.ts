/**
 * The Studio's one MCP client, for everything that talks to a Model Context Protocol server: checking an agents' tool
 * server (Agents → Tool servers), MCP requests and load steps in the API workspace, and the tests of the Studio's
 * own MCP server. Two transports:
 *  - streamable HTTP (http(s)://…/mcp): each message a POST; the answer as JSON or an event stream (which may carry
 *    notifications and requests from the server first); the session id from initialize goes with every later
 *    message, with the negotiated protocol version; the session is ended (DELETE) on close. The company network
 *    settings (proxy, trusted certificates) apply.
 *  - stdio: the server is a program; one JSON message per line both ways.
 * Requests from the server are answered: ping, and roots/list (none); anything else "not supported", so a server
 * waiting for an answer never hangs the client.
 */
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as http from 'http';
import * as https from 'https';

export const MCP_CLIENT_VERSION = '2025-06-18';
export type McpMessage = Record<string, unknown> & { jsonrpc?: string; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };

export type McpTarget =
    | { kind: 'http'; url: string; headers?: Record<string, string>; agent?: http.Agent; ca?: string | Buffer | Array<string | Buffer> }
    | { kind: 'stdio'; command: string; args?: string[]; cwd: string; env: Record<string, string> };

export class McpError extends Error {
    constructor(message: string, readonly code?: number, readonly status?: number) { super(message); }
}

interface Transport {
    /** Send a message; for HTTP the messages that came back with it (stdio: none, they arrive on their own). */
    send(m: McpMessage, timeoutMs: number): Promise<McpMessage[]>;
    close(): Promise<void>;
    /** stdio: what the program wrote to its error output (the last part). */
    readonly stderr?: string;
}

/** The messages in an HTTP answer: a JSON message or batch, or an event stream of them. */
export function parseMcpBody(contentType: string, text: string): McpMessage[] {
    const out: McpMessage[] = [];
    if (/text\/event-stream/i.test(contentType)) {
        for (const ev of text.split(/\r?\n\r?\n/)) {
            const d = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
            if (d.trim()) try { const j = JSON.parse(d); out.push(...(Array.isArray(j) ? j : [j])); } catch { /* not JSON */ }
        }
    } else if (text.trim()) {
        const j = JSON.parse(text);
        out.push(...(Array.isArray(j) ? j : [j]));
    }
    return out;
}

function httpTransport(t: Extract<McpTarget, { kind: 'http' }>, state: { session?: string; protocol: string }): Transport {
    const u = new URL(t.url);
    if (!/^https?:$/.test(u.protocol)) throw new McpError(`An MCP server address is http(s)://…/mcp (streamable HTTP); got ${t.url}.`);
    const request = (method: 'POST' | 'DELETE', m: McpMessage | null, timeoutMs: number) => new Promise<McpMessage[]>((resolve, reject) => {
        const data = m ? Buffer.from(JSON.stringify(m)) : undefined;
        const req = (u.protocol === 'https:' ? https : http).request(u, {
            method, ...(t.agent ? { agent: t.agent } : {}), ...(t.ca ? { ca: t.ca } : {}),
            headers: { ...(t.headers ?? {}), Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': state.protocol,
                ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {}), ...(state.session ? { 'Mcp-Session-Id': state.session } : {}) },
        }, (res) => {
            const got: Buffer[] = [];
            res.on('data', (b: Buffer) => got.push(b));
            res.on('error', reject);
            res.on('end', () => {
                if (res.headers['mcp-session-id']) state.session = String(res.headers['mcp-session-id']);
                const status = res.statusCode ?? 0, text = Buffer.concat(got).toString('utf8');
                let msgs: McpMessage[] = [];
                try { msgs = parseMcpBody(String(res.headers['content-type'] ?? ''), text); } catch { /* not JSON */ }
                if (status === 401 || status === 403) return reject(new McpError(`The server refused the credentials (${status}).`, undefined, status));
                if (status === 404 && state.session && m?.method !== 'initialize') return reject(new McpError('The server ended the session (404): connect again.', undefined, 404));
                if (status >= 400 && !msgs.length) return reject(new McpError(`The server answered ${status}${text.trim() ? `: ${text.trim().slice(0, 200)}` : ''}.`, undefined, status));
                resolve(msgs);
            });
        });
        req.setTimeout(timeoutMs, () => req.destroy(new McpError(`No answer within ${Math.round(timeoutMs / 1000)} s.`)));
        req.on('error', reject);
        req.end(data);
    });
    return {
        send: (m, timeoutMs) => request('POST', m, timeoutMs),
        close: async () => { if (state.session) await request('DELETE', null, 5000).catch(() => undefined); },
    };
}

function stdioTransport(t: Extract<McpTarget, { kind: 'stdio' }>, onMessage: (m: McpMessage) => void, onEnd: (e: McpError) => void): Transport {
    const child: ChildProcessWithoutNullStreams = spawn(t.command, t.args ?? [], { cwd: t.cwd, env: t.env, stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32' && /^(npx|npm)$/i.test(t.command), windowsHide: true });
    let buf = '', errText = '', ended = false;
    const end = (e: McpError) => { if (!ended) { ended = true; onEnd(e); } };
    const tail = () => (errText.trim() ? `: ${errText.trim().split('\n').slice(-3).join(' ')}` : '');
    child.stderr.on('data', (d) => { errText = (errText + d).slice(-4000); });
    child.on('error', (e) => end(new McpError((e as NodeJS.ErrnoException).code === 'ENOENT' ? `${t.command} was not found on this computer.` : e.message)));
    child.on('exit', (code) => end(new McpError(`The server stopped (exit code ${code})${tail()}.`)));
    child.stdin.on('error', () => undefined);
    child.stdout.on('data', (d) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith('{') && !line.startsWith('[')) continue;
            try { const j = JSON.parse(line); for (const m of Array.isArray(j) ? j : [j]) onMessage(m); } catch { /* a log line */ }
        }
    });
    return {
        send: async (m) => { if (ended) throw new McpError('The server is not running.'); child.stdin.write(`${JSON.stringify(m)}\n`); return []; },
        close: async () => { ended = true; try { child.kill(); } catch { /* gone */ } },
        get stderr() { return errText; },
    };
}

export interface McpConnectOptions {
    timeoutMs?: number;
    /** Every message from the server (answers, notifications, the server's own requests), as it arrives. */
    onMessage?: (m: McpMessage) => void;
    clientInfo?: { name: string; version: string };
}

export class McpClient {
    server = { name: '', version: '', protocol: MCP_CLIENT_VERSION };
    capabilities: Record<string, unknown> = {};
    private id = 0;
    private readonly pending = new Map<number | string, { resolve: (m: McpMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
    private transport!: Transport;
    private readonly state = { protocol: MCP_CLIENT_VERSION } as { session?: string; protocol: string };
    private failure?: McpError;

    private constructor(private readonly target: McpTarget, private readonly o: McpConnectOptions) {}

    /** Connect and initialize (the handshake); the server's name, version and protocol are then known. */
    static async connect(target: McpTarget, o: McpConnectOptions = {}): Promise<McpClient> {
        const c = new McpClient(target, o);
        c.transport = target.kind === 'http' ? httpTransport(target, c.state) : stdioTransport(target, (m) => c.receive(m), (e) => c.fail(e));
        try {
            const init = await c.request<{ protocolVersion?: string; capabilities?: Record<string, unknown>; serverInfo?: { name?: string; version?: string } }>('initialize',
                { protocolVersion: MCP_CLIENT_VERSION, capabilities: { roots: { listChanged: false } }, clientInfo: o.clientInfo ?? { name: 'cs-test-studio', version: '1' } });
            c.state.protocol = init?.protocolVersion ?? MCP_CLIENT_VERSION;
            c.server = { name: init?.serverInfo?.name ?? '', version: init?.serverInfo?.version ?? '', protocol: c.state.protocol };
            c.capabilities = init?.capabilities ?? {};
            await c.notify('notifications/initialized');
            return c;
        } catch (e) { await c.close(); throw e; }
    }

    get session(): string | undefined { return this.state.session; }
    get serverLabel(): string { return `${this.server.name} ${this.server.version}`.trim(); }

    /** A request; resolves with its result, rejects with the server's error. */
    async request<T = unknown>(method: string, params?: unknown, timeoutMs = this.o.timeoutMs ?? 30_000): Promise<T> {
        const m = await this.requestMessage({ method, ...(params !== undefined ? { params } : {}) }, timeoutMs);
        if (m.error) throw new McpError(m.error.message ?? JSON.stringify(m.error), m.error.code);
        return m.result as T;
    }

    /** A request, answered with the whole response message (an error included, not thrown). */
    requestMessage(call: { method: string; params?: unknown }, timeoutMs = this.o.timeoutMs ?? 30_000): Promise<McpMessage> {
        if (this.failure) return Promise.reject(this.failure);
        const id = ++this.id;
        return new Promise<McpMessage>((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new McpError(`No answer to ${call.method} within ${Math.round(timeoutMs / 1000)} s${this.stderrTail()}.`)); }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.transport.send({ jsonrpc: '2.0', id, ...call }, timeoutMs).then((msgs) => {
                for (const m of msgs) this.receive(m);
                // An HTTP answer that did not carry the response (202 to a request is not expected).
                if (this.target.kind === 'http' && this.pending.has(id)) { clearTimeout(timer); this.pending.delete(id); reject(new McpError(`The server did not answer ${call.method}.`)); }
            }, (e: Error) => { clearTimeout(timer); this.pending.delete(id); reject(e); });
        });
    }

    async notify(method: string, params?: unknown): Promise<void> {
        const msgs = await this.transport.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }, this.o.timeoutMs ?? 30_000).catch(() => []);
        for (const m of msgs) this.receive(m);
    }

    /** All tools (a long list comes in pages). */
    async listTools(maxPages = 50): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
        const tools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
        let cursor: string | undefined;
        for (let page = 0; page < maxPages; page++) {
            const r = await this.request<{ tools?: typeof tools; nextCursor?: string }>('tools/list', cursor ? { cursor } : undefined);
            tools.push(...(r?.tools ?? []));
            cursor = r?.nextCursor;
            if (!cursor) break;
        }
        return tools;
    }

    callTool(name: string, args: unknown = {}): Promise<{ content?: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: unknown }> {
        return this.request('tools/call', { name, arguments: args });
    }

    async close(): Promise<void> {
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new McpError('Closed.')); }
        this.pending.clear();
        await this.transport?.close();
    }

    private stderrTail(): string {
        const t = this.transport?.stderr ?? '';
        return t.trim() ? `: ${t.trim().split('\n').slice(-3).join(' ')}` : '';
    }

    private fail(e: McpError) {
        this.failure = e;
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(e); }
        this.pending.clear();
    }

    private receive(m: McpMessage) {
        this.o.onMessage?.(m);
        // A request from the server: answered so it never waits.
        if (typeof m.method === 'string' && m.id !== undefined) {
            const reply = m.method === 'ping' ? { result: {} } : m.method === 'roots/list' ? { result: { roots: [] } } : { error: { code: -32601, message: `${m.method} is not supported by this client.` } };
            void this.transport.send({ jsonrpc: '2.0', id: m.id, ...reply }, 10_000).then((msgs) => msgs.forEach((x) => this.receive(x)), () => undefined);
            return;
        }
        if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
            const p = this.pending.get(m.id as number);
            if (p) { clearTimeout(p.timer); this.pending.delete(m.id as number); p.resolve(m); }
        }
    }
}
