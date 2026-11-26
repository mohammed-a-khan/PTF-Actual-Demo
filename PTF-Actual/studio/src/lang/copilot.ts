/**
 * GitHub Copilot inline suggestions ("ghost text") for the Studio's editor.
 *
 * The agents use the Copilot SDK (chat); inline completions come from GitHub's official Copilot
 * language server (npm package @github/copilot-language-server), spoken to over LSP on stdio:
 *  - installed by the Studio into its own folder, like the agents runtime (npm, with this computer's
 *    npm settings and the Studio's network settings), and run with the Studio's own Node.js;
 *  - one process per Studio, started when the editor first needs it, restarted when it crashes,
 *    stopped after a while without use;
 *  - sign-in: the language server's own GitHub device flow (a code to enter on github.com), a sign-in
 *    another Copilot editor on this computer already made (it offers those), or the Copilot token kept
 *    in the Studio's secret store;
 *  - nothing from a secret file (.env, keys, saved sessions) is sent, and secret values the Studio knows
 *    (its secret store, or found by its secret scanner) are blanked out of the text before it leaves.
 * CS_STUDIO_COPILOT_LSP overrides the command (a .js file run with this Node.js, or a program), e.g. a
 * test double.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { pathToFileURL } from 'url';
import { installedVersion, RuntimeInstaller, RuntimePackage } from '../agents/runtime';
import { scanLines, scanPath } from '../scanner/scanner';

export const LSP_PACKAGE = '@github/copilot-language-server';
/** The version this Studio was built and tested with. */
export const LSP_TESTED_VERSION = '1.574.3';
/** The language server needs Node.js 22.13 or later (else it wants its ~160 MB platform binary). */
const NODE_OK = (() => { const [a, b] = process.versions.node.split('.').map(Number); return a > 22 || (a === 22 && b >= 13); })();
export const LSP_RUNTIME: RuntimePackage = {
    pkg: LSP_PACKAGE, label: 'the Copilot language server',
    // The platform binaries and the Copilot CLI (~500 MB) are only needed without a recent Node.js.
    extraArgs: () => (NODE_OK ? ['--omit=optional'] : []),
    platformPackages: /^copilot-(language-server-|sdk-|linux|darwin|win32)/,
};

// ------------------------------------------------------------------ JSON-RPC over stdio (LSP framing)

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export class RpcError extends Error { constructor(message: string, readonly code?: number, readonly data?: unknown) { super(message); } }

/** One LSP connection: Content-Length framed JSON-RPC 2.0 on a child's stdin/stdout. */
export class LspConnection extends EventEmitter {
    private buf = Buffer.alloc(0);
    private nextId = 1;
    private readonly pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>();
    private closed = false;
    /** Requests the server sends to the client. */
    onRequest: (method: string, params: Json) => unknown = () => null;

    constructor(private readonly input: NodeJS.ReadableStream, private readonly output: NodeJS.WritableStream) {
        super();
        input.on('data', (d: Buffer) => this.data(d));
        input.on('end', () => this.close(new Error('The language server closed its output.')));
        output.on('error', () => undefined);
    }

    private data(d: Buffer) {
        this.buf = Buffer.concat([this.buf, d]);
        for (;;) {
            const h = this.buf.indexOf('\r\n\r\n');
            if (h < 0) return;
            const head = this.buf.subarray(0, h).toString('ascii');
            const m = /content-length:\s*(\d+)/i.exec(head);
            if (!m) { this.buf = this.buf.subarray(h + 4); continue; }
            const len = Number(m[1]);
            if (this.buf.length < h + 4 + len) return;
            const body = this.buf.subarray(h + 4, h + 4 + len).toString('utf8');
            this.buf = this.buf.subarray(h + 4 + len);
            let msg: Json;
            try { msg = JSON.parse(body); } catch { continue; }
            this.dispatch(msg);
        }
    }

    private dispatch(msg: Json) {
        if (msg.id !== undefined && msg.method === undefined) {
            const p = this.pending.get(Number(msg.id));
            if (!p) return;
            this.pending.delete(Number(msg.id));
            if (p.timer) clearTimeout(p.timer);
            if (msg.error) p.reject(new RpcError(String(msg.error.message ?? 'Error'), msg.error.code, msg.error.data)); else p.resolve(msg.result);
            return;
        }
        if (msg.method !== undefined && msg.id !== undefined) {
            Promise.resolve().then(() => this.onRequest(msg.method, msg.params)).then(
                (result) => this.send({ jsonrpc: '2.0', id: msg.id, result: result ?? null }),
                (e) => this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: (e as Error).message } }));
            return;
        }
        if (msg.method !== undefined) this.emit('notification', msg.method, msg.params);
    }

    private send(msg: Json) {
        if (this.closed) return;
        const body = Buffer.from(JSON.stringify(msg), 'utf8');
        this.output.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
    }

    request<T = Json>(method: string, params: Json, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
        if (this.closed) return Promise.reject(new Error('The language server is not running.'));
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const entry: { resolve: (v: Json) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout } = { resolve, reject };
            if (o.timeoutMs) { entry.timer = setTimeout(() => { this.pending.delete(id); this.notify('$/cancelRequest', { id }); reject(new Error(`The language server did not answer ${method} in time.`)); }, o.timeoutMs); entry.timer.unref(); }
            this.pending.set(id, entry);
            if (o.signal) {
                if (o.signal.aborted) { this.pending.delete(id); reject(new RpcError('Cancelled', -32800)); return; }
                o.signal.addEventListener('abort', () => {
                    if (!this.pending.has(id)) return;
                    this.pending.delete(id); if (entry.timer) clearTimeout(entry.timer);
                    this.notify('$/cancelRequest', { id });
                    reject(new RpcError('Cancelled', -32800));
                }, { once: true });
            }
            this.send({ jsonrpc: '2.0', id, method, params });
        });
    }

    notify(method: string, params: Json) { this.send({ jsonrpc: '2.0', method, params }); }

    close(e = new Error('The language server stopped.')) {
        if (this.closed) return;
        this.closed = true;
        for (const [id, p] of this.pending) { if (p.timer) clearTimeout(p.timer); p.reject(e); this.pending.delete(id); }
        this.emit('close');
    }
}

// ------------------------------------------------------------------ text helpers

/** LSP position (line, UTF-16 character) of an offset in text with "\n" line ends. */
export function positionAt(text: string, offset: number): { line: number; character: number } {
    let line = 0, start = 0;
    for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) { line++; start = i + 1; }
    return { line, character: Math.min(offset, text.length) - start };
}
/** Offset of an LSP position (clamped to the line). */
export function offsetAt(text: string, pos: { line: number; character: number }): number {
    let off = 0;
    for (let l = 0; l < pos.line; l++) { const n = text.indexOf('\n', off); if (n < 0) return text.length; off = n + 1; }
    const end = text.indexOf('\n', off);
    return Math.min(off + Math.max(0, pos.character), end < 0 ? text.length : end);
}
/** The one changed range between two texts (common start and end kept), as an LSP incremental change. */
export function changeBetween(a: string, b: string): { range: { start: { line: number; character: number }; end: { line: number; character: number } }; text: string } | null {
    if (a === b) return null;
    const max = Math.min(a.length, b.length);
    let s = 0;
    while (s < max && a.charCodeAt(s) === b.charCodeAt(s)) s++;
    let e = 0;
    while (e < max - s && a.charCodeAt(a.length - 1 - e) === b.charCodeAt(b.length - 1 - e)) e++;
    return { range: { start: positionAt(a, s), end: positionAt(a, a.length - e) }, text: b.slice(s, b.length - e) };
}

/** Files never sent to Copilot: environment files, keys and certificates, saved sessions, anything under a secrets folder. */
export function isSecretPath(rel: string, content?: string): boolean {
    const p = rel.replace(/\\/g, '/');
    const base = p.split('/').pop() ?? '';
    if (/^\.env(\..*)?$/i.test(base) || /\.env$/i.test(base) || /^\.npmrc$|^\.netrc$|^\.pypirc$|^id_(rsa|dsa|ecdsa|ed25519)/i.test(base)) return true;
    if (p.split('/').some((seg) => /^(\.?secrets?|\.ssh|\.aws|\.azure|credentials?|private)$/i.test(seg))) return true;
    if (/(^|[._-])(secrets?|credentials?)([._-]|$)/i.test(base)) return true;
    try { return scanPath(p, content).length > 0; } catch { return false; }
}

/**
 * The text with secret values replaced by "•" of the same length (so positions stay right): the values
 * the Studio knows (its secret store) and what its secret scanner finds in the text.
 */
export function maskSameLength(text: string, known: string[], file = 'x'): string {
    let t = text;
    const blank = (v: string) => { if (v && v.length >= 4 && t.includes(v)) t = t.split(v).join('•'.repeat(v.length)); };
    for (const v of known) blank(v);
    try {
        const lines = t.split('\n').map((l, i) => ({ file, line: i + 1, text: l }));
        for (const f of scanLines(lines, { knownSecrets: [] })) blank(f.value);
    } catch { /* the scanner is best effort here */ }
    return t;
}

const LANG: Record<string, string> = {
    ts: 'typescript', tsx: 'typescriptreact', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascriptreact', mjs: 'javascript', cjs: 'javascript',
    json: 'json', yml: 'yaml', yaml: 'yaml', md: 'markdown', feature: 'gherkin', py: 'python', java: 'java', cs: 'csharp', sql: 'sql', xml: 'xml', html: 'html', css: 'css',
    sh: 'shellscript', ps1: 'powershell', properties: 'properties', graphql: 'graphql', gql: 'graphql', proto: 'proto3', txt: 'plaintext', csv: 'csv',
};
export const languageOf = (file: string) => LANG[(file.split('.').pop() ?? '').toLowerCase()] ?? 'plaintext';

// ------------------------------------------------------------------ the service

export type CopilotState = 'off' | 'not-installed' | 'installing' | 'stopped' | 'starting' | 'sign-in' | 'ready' | 'working' | 'error';

export interface CopilotStatus {
    state: CopilotState;
    /** Why (error, off by policy, …), in words people can act on. */
    reason?: string;
    enabled: boolean;
    installed: boolean;
    /** Installed version (null with CS_STUDIO_COPILOT_LSP or when not installed). */
    version: string | null;
    tested: string;
    folder: string;
    custom: boolean;
    install: ReturnType<RuntimeInstaller['state']>;
    user?: string;
    /** A sign-in in progress: the code to enter and where. */
    signIn?: { userCode: string; verificationUri: string; expiresAt: number };
    /** Sign-ins other Copilot editors on this computer made, that can be used here too. */
    existing?: Array<{ tokenId: number; login: string; host?: string }>;
    /** The language server's own last message (didChangeStatus / showMessage). */
    message?: string;
}

export interface InlineItem { id: string; text: string; start: number; end: number }

export interface CopilotDeps {
    home: string;
    repoRoot: string;
    studioVersion: string;
    /** Proxy and certificate environment (the Studio's network settings). */
    env: () => Record<string, string>;
    /** The proxy for the language server's own setting (http.proxy), when one is set. */
    proxy: () => string | undefined;
    /** A GitHub token for Copilot kept in the Studio's secret store (used instead of a sign-in). */
    token: () => string | undefined;
    /** Secret values the Studio knows, blanked out before text leaves. */
    knownSecrets: () => string[];
    /** A reason inline suggestions are not allowed (the repository's agent policy), or null. */
    blocked: () => string | null;
    log: (action: string, text: string) => void;
    /** For tests: the installer's npm. */
    npm?: { command: string; prefixArgs: string[] };
    /** Stop the language server after this long without a request (default 20 min). */
    idleMs?: number;
}

const DOCS_OPEN = 20;

export class CopilotInline {
    readonly installer: RuntimeInstaller;
    private proc: ChildProcess | null = null;
    private conn: LspConnection | null = null;
    private starting: Promise<LspConnection> | null = null;
    private st: { state: 'stopped' | 'starting' | 'sign-in' | 'ready' | 'error'; reason?: string; user?: string; message?: string; busy?: boolean } = { state: 'stopped' };
    private signin: { userCode: string; verificationUri: string; expiresAt: number } | null = null;
    private existing: CopilotStatus['existing'];
    private readonly docs = new Map<string, { version: number; text: string }>();
    private focused = '';
    private readonly items = new Map<string, Json>();
    private nextItem = 1;
    private inflight: AbortController | null = null;
    private working = 0;
    private crashes: number[] = [];
    private stopping = false;
    private idleTimer: NodeJS.Timeout | null = null;
    private stderr: string[] = [];
    private readonly settingsFile: string;

    constructor(private readonly d: CopilotDeps) {
        this.installer = new RuntimeInstaller(path.join(d.home, 'copilot-language-server'), d.npm, LSP_RUNTIME);
        this.settingsFile = path.join(d.home, 'copilot-inline.json');
    }

    // ---- settings
    get enabled(): boolean {
        try { return (JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) as { enabled?: boolean }).enabled !== false; } catch { return true; }
    }
    async setEnabled(on: boolean) {
        fs.mkdirSync(this.d.home, { recursive: true });
        fs.writeFileSync(this.settingsFile, JSON.stringify({ enabled: on }, null, 2));
        this.d.log('copilot.inline', `${on ? 'Turned on' : 'Turned off'} Copilot inline suggestions`);
        if (!on) await this.stop();
    }

    /** The command that runs the language server (null when it is not installed). */
    command(): { command: string; args: string[]; custom: boolean } | null {
        const o = process.env.CS_STUDIO_COPILOT_LSP?.trim();
        if (o) return /\.(c|m)?js$/i.test(o) ? { command: process.execPath, args: [o, '--stdio'], custom: true } : { command: o, args: ['--stdio'], custom: true };
        const js = path.join(this.installer.folder, 'node_modules', ...LSP_PACKAGE.split('/'), 'dist', 'language-server.js');
        return fs.existsSync(js) && installedVersion(this.installer.folder, LSP_PACKAGE) ? { command: process.execPath, args: [js, '--stdio'], custom: false } : null;
    }

    status(): CopilotStatus {
        const cmd = this.command();
        const install = this.installer.state();
        const base = { enabled: this.enabled, installed: !!cmd, version: cmd?.custom ? null : installedVersion(this.installer.folder, LSP_PACKAGE), tested: LSP_TESTED_VERSION, folder: this.installer.folder, custom: !!cmd?.custom, install };
        const blocked = this.d.blocked();
        if (blocked) return { ...base, state: 'off', reason: blocked };
        if (!base.enabled) return { ...base, state: 'off', reason: 'Inline suggestions are turned off.' };
        if (install.running) return { ...base, state: 'installing' };
        if (!cmd) return { ...base, state: 'not-installed', ...(install.ok === false && install.error ? { reason: install.error } : {}) };
        const s = this.st;
        const state: CopilotState = s.state === 'ready' && (this.working > 0 || s.busy) ? 'working' : s.state;
        return {
            ...base, state, ...(s.reason ? { reason: s.reason } : {}), ...(s.user ? { user: s.user } : {}), ...(s.message ? { message: s.message } : {}),
            ...(this.signin && this.signin.expiresAt > Date.now() ? { signIn: this.signin } : {}),
            ...(s.state === 'sign-in' && this.existing?.length ? { existing: this.existing } : {}),
        };
    }

    install(version?: string) {
        const v = !version || version === 'tested' ? LSP_TESTED_VERSION : version;
        this.installer.install(v, { env: this.d.env(), repoRoot: this.d.repoRoot });
        this.d.log('copilot.inline', `Installing the Copilot language server (${v})`);
        // A running (older) server is replaced on its next start.
        void this.stop();
        return this.status();
    }
    async remove() { await this.stop(); this.installer.remove(); this.d.log('copilot.inline', 'Removed the Copilot language server'); return this.status(); }

    // ---- process
    private touch() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => { this.d.log('copilot.inline', 'Stopped the Copilot language server (not used for a while)'); void this.stop(); }, this.d.idleMs ?? 20 * 60_000);
        this.idleTimer.unref();
    }

    private launched = false;
    /** The editor opened: start the language server once, in the background (later starts come with a request). */
    startOnce() { if (!this.launched && this.status().state === 'stopped') void this.start().catch(() => undefined); }

    /** Start the language server (if it is not running) and find out whether it is signed in. */
    async start(): Promise<LspConnection> {
        if (this.conn) { this.touch(); return this.conn; }
        const blocked = this.d.blocked();
        if (blocked) throw new Error(blocked);
        if (!this.enabled) throw new Error('Copilot inline suggestions are turned off.');
        this.starting ??= this.launch().finally(() => { this.starting = null; });
        return this.starting;
    }

    private async launch(): Promise<LspConnection> {
        const cmd = this.command();
        if (!cmd) throw Object.assign(new Error('Install the Copilot language server first (Agents › Setup, or the Copilot item in the editor\'s status bar).'), { code: 'copilot-not-installed' });
        this.stopping = false;
        this.launched = true;
        this.st = { state: 'starting' };
        this.stderr = [];
        const token = this.d.token();
        const env: Record<string, string> = { ...(process.env as Record<string, string>), ...this.d.env(), ...(token ? { GH_COPILOT_TOKEN: token } : {}) };
        const child = spawn(cmd.command, cmd.args, { cwd: this.d.repoRoot, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
        this.proc = child;
        const conn = new LspConnection(child.stdout!, child.stdin!);
        child.stderr?.on('data', (b: Buffer) => { for (const l of b.toString().split(/\r?\n/)) if (l.trim()) this.stderr.push(l.slice(0, 300)); if (this.stderr.length > 50) this.stderr.splice(0, this.stderr.length - 50); });
        const spawnError = new Promise<never>((_, reject) => child.once('error', (e) => reject(new Error(`The Copilot language server could not start: ${e.message}`))));
        child.on('exit', (code, signal) => this.exited(child, conn, code, signal));
        conn.onRequest = (method, params) => this.serverRequest(method, params);
        conn.on('notification', (method: string, params: Json) => this.serverNotification(method, params));
        try {
            await Promise.race([spawnError, conn.request('initialize', {
                processId: process.pid,
                clientInfo: { name: 'CS Test Studio', version: this.d.studioVersion || '0' },
                rootUri: pathToFileURL(this.d.repoRoot).href,
                workspaceFolders: [{ uri: pathToFileURL(this.d.repoRoot).href, name: path.basename(this.d.repoRoot) }],
                capabilities: { workspace: { workspaceFolders: true, configuration: true }, window: { showDocument: { support: true }, workDoneProgress: false }, textDocument: { inlineCompletion: { dynamicRegistration: false }, synchronization: { dynamicRegistration: false } } },
                initializationOptions: {
                    editorInfo: { name: 'CS Test Studio', version: this.d.studioVersion || '0' },
                    editorPluginInfo: { name: 'CS Test Studio Copilot', version: this.d.studioVersion || '0' },
                },
            }, { timeoutMs: 60_000 })]);
            conn.notify('initialized', {});
            conn.notify('workspace/didChangeConfiguration', { settings: this.settings() });
            this.conn = conn;
            this.touch();
            this.docs.clear();
            this.focused = '';
            await this.refresh(conn);
            return conn;
        } catch (e) {
            const msg = (e as Error).message + (this.stderr.length ? ` (${this.stderr[this.stderr.length - 1]})` : '');
            this.st = { state: 'error', reason: msg };
            this.stopping = true;
            try { child.kill(); } catch { /* gone */ }
            conn.close();
            throw new Error(msg);
        }
    }

    private settings() {
        const proxy = this.d.proxy();
        return { http: { ...(proxy ? { proxy } : {}), proxyStrictSSL: true }, telemetry: { telemetryLevel: 'off' } };
    }

    private exited(child: ChildProcess, conn: LspConnection, code: number | null, signal: NodeJS.Signals | null) {
        if (this.proc !== child) return;
        this.proc = null;
        this.conn = null;
        conn.close();
        this.inflight = null;
        this.working = 0;
        // Who was signed in is kept: a stopped server that was ready starts again with the next suggestion.
        const user = this.st.state === 'ready' ? this.st.user : undefined;
        if (this.stopping) { this.st = { state: 'stopped', ...(user ? { user } : {}) }; return; }
        // Crashed: started again on the next request, unless it keeps crashing.
        const now = Date.now();
        this.crashes = [...this.crashes.filter((t) => now - t < 120_000), now];
        const last = this.stderr[this.stderr.length - 1];
        this.d.log('copilot.inline', `The Copilot language server stopped (${signal ?? `exit code ${code}`})`);
        this.st = this.crashes.length >= 3
            ? { state: 'error', reason: `The Copilot language server stopped ${this.crashes.length} times in two minutes${last ? `: ${last}` : ''}. Click to start it again.` }
            : { state: 'stopped', reason: `It stopped (${signal ?? `exit code ${code}`}) and starts again with the next suggestion.`, ...(user ? { user } : {}) };
    }

    async stop() {
        this.stopping = true;
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        const c = this.conn, p = this.proc;
        this.conn = null; this.proc = null; this.signin = null;
        this.st = { state: 'stopped', ...(this.st.state === 'ready' && this.st.user ? { user: this.st.user } : {}) };
        if (c) { try { await c.request('shutdown', null, { timeoutMs: 2000 }); c.notify('exit', null); } catch { /* stopping anyway */ } c.close(); }
        if (p && p.exitCode === null) { setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 500).unref(); }
    }

    /** Start again after "stopped repeatedly". */
    async restart() { this.crashes = []; await this.stop(); await this.start(); return this.status(); }

    private serverRequest(method: string, params: Json): unknown {
        switch (method) {
            case 'workspace/configuration': {
                const s = this.settings() as Record<string, unknown>;
                return ((params?.items ?? []) as Array<{ section?: string }>).map((i) => (i.section ? i.section.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), s) ?? null : s));
            }
            // The sign-in page: shown in the Studio (the person opens it), never opened by the server.
            case 'window/showDocument': if (this.signin && params?.uri) this.signin.verificationUri = String(params.uri); return { success: true };
            case 'window/showMessageRequest': this.st.message = String(params?.message ?? '').slice(0, 500); return null;
            default: return null;
        }
    }

    private serverNotification(method: string, params: Json) {
        if (method === 'didChangeStatus') {
            const kind = String(params?.kind ?? '');
            const message = String(params?.message ?? '').slice(0, 500);
            this.st.busy = !!params?.busy;
            if (message) this.st.message = message;
            if (kind === 'Error' && this.st.state === 'ready') {
                if (/sign|auth/i.test(message)) this.st = { state: 'sign-in', message }; else this.st = { ...this.st, state: 'error', reason: message || 'Copilot reported a problem.' };
            } else if (kind === 'Normal' && (this.st.state === 'sign-in' || this.st.state === 'error')) {
                if (this.conn) void this.refresh(this.conn).catch(() => undefined);
            }
        } else if (method === 'window/showMessage') {
            this.st.message = String(params?.message ?? '').slice(0, 500);
        }
    }

    /** Ask the server whether it is signed in. */
    private async refresh(conn: LspConnection) {
        const r = await conn.request<{ status: string; user?: string }>('checkStatus', {}, { timeoutMs: 30_000 }).catch((e: Error) => ({ status: 'Error', message: e.message } as { status: string; user?: string; message?: string }));
        const status = String(r?.status ?? '');
        if (status === 'OK' || status === 'MaybeOK' || status === 'AlreadySignedIn') { this.st = { state: 'ready', user: r.user }; this.signin = null; this.existing = undefined; return; }
        if (status === 'NotSignedIn') {
            this.st = { state: 'sign-in' };
            const t = await conn.request<{ tokens?: Array<{ tokenId: number; userLogin?: string; authAuthority?: string; isCurrent?: boolean }> }>('auth/listAvailableTokens', {}, { timeoutMs: 10_000 }).catch(() => null);
            this.existing = (t?.tokens ?? []).filter((x) => typeof x.tokenId === 'number').slice(0, 10).map((x) => ({ tokenId: x.tokenId, login: String(x.userLogin ?? 'GitHub user'), ...(x.authAuthority ? { host: String(x.authAuthority) } : {}) }));
            return;
        }
        if (status === 'NotAuthorized') { this.st = { state: 'error', user: r.user, reason: `${r.user ? `${r.user} has` : 'This GitHub account has'} no GitHub Copilot access. Copilot Free can be turned on in your GitHub settings (Copilot).` }; return; }
        this.st = { state: 'error', reason: `Copilot status: ${(r as { message?: string }).message ?? status}` };
    }

    async checkStatus() { const c = await this.start(); await this.refresh(c); return this.status(); }

    // ---- sign-in
    async signIn(): Promise<CopilotStatus> {
        const conn = await this.start();
        const r = await conn.request<{ status: string; userCode?: string; verificationUri?: string; expiresIn?: number; command?: Json; user?: string }>('signIn', {}, { timeoutMs: 60_000 });
        if (r.status === 'AlreadySignedIn') { this.st = { state: 'ready', user: r.user }; return this.status(); }
        if (!r.userCode || !r.verificationUri) throw new Error('The Copilot language server did not start a sign-in.');
        const pending = { userCode: String(r.userCode), verificationUri: String(r.verificationUri), expiresAt: Date.now() + Number(r.expiresIn ?? 900) * 1000 };
        this.signin = pending;
        // Waits until the person has entered the code on GitHub (the server polls GitHub).
        if (r.command) {
            void conn.request('workspace/executeCommand', { command: r.command.command, arguments: r.command.arguments ?? [] }, { timeoutMs: Number(r.expiresIn ?? 900) * 1000 + 30_000 })
                .then(async () => { if (this.signin === pending) this.signin = null; await this.refresh(conn); if (this.st.state === 'ready') this.d.log('copilot.inline', `Signed in to Copilot inline suggestions${this.st.user ? ` as ${this.st.user}` : ''}`); })
                .catch((e: Error) => { if (this.signin !== pending) return; this.signin = null; this.st = { state: 'sign-in', reason: `Sign-in did not complete: ${e.message}` }; });
        }
        return this.status();
    }
    cancelSignIn() { this.signin = null; return this.status(); }
    async useExisting(tokenId: number) {
        const conn = await this.start();
        await conn.request('auth/useExistingToken', { tokenId }, { timeoutMs: 30_000 });
        await this.refresh(conn);
        return this.status();
    }
    async signOut() {
        const conn = await this.start();
        await conn.request('signOut', {}, { timeoutMs: 30_000 }).catch(() => undefined);
        await this.refresh(conn);
        this.d.log('copilot.inline', 'Signed out of Copilot inline suggestions');
        return this.status();
    }

    // ---- documents and suggestions
    private sync(conn: LspConnection, uri: string, languageId: string, text: string): number {
        const d = this.docs.get(uri);
        if (!d) {
            while (this.docs.size >= DOCS_OPEN) { const old = this.docs.keys().next().value as string; this.docs.delete(old); conn.notify('textDocument/didClose', { textDocument: { uri: old } }); }
            this.docs.set(uri, { version: 1, text });
            conn.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
        } else {
            const ch = changeBetween(d.text, text);
            if (ch) { d.version++; d.text = text; conn.notify('textDocument/didChange', { textDocument: { uri, version: d.version }, contentChanges: [ch] }); }
            this.docs.delete(uri); this.docs.set(uri, d);
        }
        if (this.focused !== uri) { this.focused = uri; conn.notify('textDocument/didFocus', { textDocument: { uri } }); }
        return this.docs.get(uri)!.version;
    }

    /** The editor closed a file. */
    close(rel: string) {
        const uri = pathToFileURL(path.join(this.d.repoRoot, rel)).href;
        if (this.docs.delete(uri)) this.conn?.notify('textDocument/didClose', { textDocument: { uri } });
    }

    /**
     * Suggestions at an offset of the editor's text ("\n" line ends). A newer request cancels the one
     * still waiting (as does the caller's signal: the editor typed on).
     */
    async inline(rel: string, content: string, offset: number, o: { signal?: AbortSignal; invoked?: boolean; tabSize?: number; insertSpaces?: boolean } = {}): Promise<{ items: InlineItem[]; skipped?: string }> {
        if (isSecretPath(rel, content)) return { items: [], skipped: 'This file may hold secrets: it is never sent to Copilot.' };
        const conn = await this.start();
        if (this.st.state !== 'ready') return { items: [], skipped: this.st.state === 'sign-in' ? 'Sign in to GitHub Copilot.' : this.st.reason ?? 'Copilot is not ready.' };
        this.inflight?.abort();
        const ac = new AbortController();
        this.inflight = ac;
        const onAbort = () => ac.abort();
        o.signal?.addEventListener('abort', onAbort, { once: true });
        const text = maskSameLength(content, this.d.knownSecrets(), rel);
        const uri = pathToFileURL(path.join(this.d.repoRoot, rel)).href;
        this.working++;
        try {
            const version = this.sync(conn, uri, languageOf(rel), text);
            const r = await conn.request<{ items?: Json[] } | Json[] | null>('textDocument/inlineCompletion', {
                textDocument: { uri, version }, position: positionAt(text, offset),
                context: { triggerKind: o.invoked ? 1 : 2 },
                formattingOptions: { tabSize: o.tabSize ?? 4, insertSpaces: o.insertSpaces !== false },
            }, { signal: ac.signal, timeoutMs: 30_000 });
            const list = (Array.isArray(r) ? r : r?.items ?? []) as Json[];
            const out: InlineItem[] = [];
            for (const it of list.slice(0, 10)) {
                const insert = typeof it.insertText === 'string' ? it.insertText : typeof it.insertText?.value === 'string' ? it.insertText.value : '';
                if (!insert) continue;
                const start = it.range ? offsetAt(content, it.range.start) : offset;
                const end = it.range ? offsetAt(content, it.range.end) : offset;
                const id = `c${this.nextItem++}`;
                this.items.set(id, it);
                while (this.items.size > 100) this.items.delete(this.items.keys().next().value as string);
                out.push({ id, text: insert.replace(/\r\n?/g, '\n'), start, end });
            }
            return { items: out };
        } catch (e) {
            if (e instanceof RpcError && (e.code === -32800 || e.code === -32802)) return { items: [], skipped: 'cancelled' };
            throw e;
        } finally {
            this.working--;
            o.signal?.removeEventListener('abort', onAbort);
            if (this.inflight === ac) this.inflight = null;
        }
    }

    /** The editor shows a suggestion (Copilot's "shown" notification). */
    shown(id: string) { const it = this.items.get(id); if (it && this.conn) this.conn.notify('textDocument/didShowCompletion', { item: it }); }
    /**
     * Accepted: all of it (the item's command), or part of it (acceptedLength counts from the start of the
     * suggestion's text to the end of what was taken).
     */
    async accepted(id: string, acceptedLength?: number) {
        const it = this.items.get(id);
        if (!it || !this.conn) return;
        const full = typeof it.insertText === 'string' ? it.insertText.length : String(it.insertText?.value ?? '').length;
        if (acceptedLength !== undefined && acceptedLength > 0 && acceptedLength < full) { this.conn.notify('textDocument/didPartiallyAcceptCompletion', { item: it, acceptedLength }); return; }
        if (it.command?.command) await this.conn.request('workspace/executeCommand', { command: it.command.command, arguments: it.command.arguments ?? [] }, { timeoutMs: 10_000 }).catch(() => undefined);
    }
}
