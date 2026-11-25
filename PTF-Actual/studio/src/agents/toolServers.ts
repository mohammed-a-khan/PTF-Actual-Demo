/**
 * Tool servers: MCP servers the Studio's agents use (Playwright, a database, Azure DevOps…), added in the Studio.
 *
 *  - The team's servers: .cs-studio/mcp-servers.json in the repository (committed, no secrets).
 *    Each person's own: the Studio's private folder (per repository).
 *  - Passwords and tokens are written as {secret:NAME} (a Studio secret) and filled in only when an agent session
 *    starts; a database server can name a Studio connection ({db:ALIAS}): its address is built from the project's
 *    configuration then.
 *  - Test: the Studio starts / calls the server itself and lists its tools. Each check is kept (per person) and
 *    compared with the one before: tools added, removed or whose parameters changed are shown until reviewed. A
 *    session that sees a different number of tools than the last check starts a new check by itself.
 *  - Tools: all (new ones included) unless the server lists `tools`; then only those, and new tools stay off until
 *    someone turns them on (for a team server, in the repository file, so the team reviews them together).
 *  - Import: paste the configuration an MCP server's documentation gives (mcpServers / servers / one entry);
 *    passwords and tokens in it become Studio secrets.
 *  - The agents' sessions get the servers (Copilot SDK mcpServers); every tool call of a server is an approval card
 *    (the "MCP tools" setting); a server that can change data or drive applications always asks; the repository's
 *    agent policy can allow only some servers or none.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { McpClient } from '../mcp/client';

export interface ToolServer {
    kind: 'stdio' | 'http';
    /** stdio: the program and its arguments (started without a shell). */
    command?: string;
    args?: string[];
    /** stdio: environment variables (values may be {secret:NAME}). */
    env?: Record<string, string>;
    /** http: the server's address and headers (values may be {secret:NAME}). */
    url?: string;
    headers?: Record<string, string>;
    /** Only these tools (all when empty). */
    tools?: string[];
    /** It can change data or drive applications: every call asks, whatever the settings. */
    changes?: boolean;
    description?: string;
    /** The catalog entry it was made from. */
    from?: string;
    /** false: kept, but not given to agents. */
    enabled?: boolean;
    /** The Studio secrets made from a pasted configuration (offered for removal with the server). */
    pastedSecrets?: string[];
}
export type Scope = 'team' | 'personal';
export interface ListedServer { name: string; scope: Scope; server: ToolServer; missing: string[] }

export const TEAM_FILE = '.cs-studio/mcp-servers.json';
const NAME = /^[a-z][a-z0-9-]{1,39}$/;
const SECRET_REF = /\{secret:([A-Z][A-Z0-9_]{0,63})\}/g;
const DB_REF = /\{db:([\w.-]+\/[\w.-]+\/[A-Z0-9_]{1,64})\}/g;

/** Ready entries: what to fill in, and the server it makes. */
export interface CatalogEntry {
    id: string; title: string; description: string; changes: boolean;
    fields: Array<{ key: string; label: string; kind: 'text' | 'secret' | 'connection'; placeholder?: string; help?: string; optional?: boolean; choices?: string[] }>;
    make: (v: Record<string, string>) => ToolServer;
}
export const CATALOG: CatalogEntry[] = [
    {
        id: 'playwright', title: 'Playwright', changes: true,
        description: 'Browser automation (Microsoft Playwright MCP): open pages, click, type, read the page. Downloaded from npm on first use.',
        fields: [{ key: 'browser', label: 'Browser', kind: 'text', placeholder: 'chromium', optional: true, help: 'chromium, chrome, msedge, firefox or webkit', choices: ['chromium', 'chrome', 'msedge', 'firefox', 'webkit'] }],
        make: (v) => ({ kind: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless', ...(v.browser ? ['--browser', v.browser] : [])], changes: true }),
    },
    {
        id: 'postgres', title: 'PostgreSQL (read only)', changes: false,
        description: 'Read-only SQL and schema of a PostgreSQL database (MCP reference server). The address and password come from the Studio connection you pick.',
        fields: [{ key: 'connection', label: 'Studio connection', kind: 'connection', help: 'A PostgreSQL connection of the project (DB_<NAME>_…)' }],
        make: (v) => ({ kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', `{db:${v.connection}}`], changes: false }),
    },
    {
        id: 'oracle-sqlcl', title: 'Oracle (SQLcl)', changes: true,
        description: 'Oracle Database through SQLcl\'s MCP server (sql -mcp, SQLcl 25.2 or later). It uses the connections saved in SQLcl (conn -save … -savepwd).',
        fields: [{ key: 'sqlcl', label: 'SQLcl program', kind: 'text', placeholder: 'sql', optional: true, help: 'The sql command, or its full path' }],
        make: (v) => ({ kind: 'stdio', command: v.sqlcl || 'sql', args: ['-mcp'], changes: true }),
    },
    {
        id: 'azure-devops', title: 'Azure DevOps', changes: true,
        description: 'Work items, repositories, pipelines and test plans (Microsoft\'s Azure DevOps MCP server). Signs in with your browser on first use.',
        fields: [{ key: 'organization', label: 'Organization', kind: 'text', placeholder: 'contoso' }],
        make: (v) => ({ kind: 'stdio', command: 'npx', args: ['-y', '@azure-devops/mcp', v.organization], changes: true }),
    },
    {
        id: 'github', title: 'GitHub', changes: true,
        description: 'Repositories, issues and pull requests (GitHub\'s remote MCP server) with a personal access token.',
        fields: [{ key: 'token', label: 'Token secret', kind: 'secret', placeholder: 'GITHUB_MCP_TOKEN', help: 'The name of a Studio secret holding the token' }],
        make: (v) => ({ kind: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: `Bearer {secret:${v.token}}` }, changes: true }),
    },
];

const hashOf = (repoRoot: string) => createHash('sha256').update(path.resolve(repoRoot)).digest('hex').slice(0, 24);
const personalFile = (home: string, repoRoot: string) => path.join(home, 'mcp-servers', `${hashOf(repoRoot)}.json`);

function readFile(f: string): Record<string, ToolServer> {
    let text: string;
    try { text = fs.readFileSync(f, 'utf8'); } catch { return {}; }
    const j = JSON.parse(text) as { servers?: Record<string, ToolServer> };
    return j && typeof j === 'object' && j.servers && typeof j.servers === 'object' ? j.servers : {};
}

/** Why a server cannot be saved, or null. Secrets must be references, never values. */
export function serverProblem(name: string, s: ToolServer): string | null {
    if (!NAME.test(name)) return 'Name: lower-case letters, digits and -, starting with a letter (2–40).';
    if (s.kind === 'stdio') {
        if (!s.command || !/^[\w./\\:@ -]{1,300}$/.test(s.command) || /[;&|`$<>]/.test(s.command)) return 'The program: a command name or a path (no shell characters).';
        if (s.args && (!Array.isArray(s.args) || s.args.length > 50 || s.args.some((a) => typeof a !== 'string' || a.length > 1000))) return 'Arguments: up to 50 texts.';
    } else if (s.kind === 'http') {
        try { const u = new URL(s.url ?? ''); if (!/^https?:$/.test(u.protocol)) throw new Error(); if (u.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return 'A remote server must use https:// (plain http only on this computer).'; }
        catch { return 'The address: https://…'; }
    } else return 'Kind: stdio (a program) or http (an address).';
    // What an HTTP request can carry (the check would fail later with "Invalid character in header content").
    for (const [k, v] of Object.entries(s.headers ?? {})) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(k)) return `Header "${k}": a header name is letters, digits and - (no spaces).`;
        if (typeof v === 'string' && /[^\t\x20-\x7e]/.test(v)) return `Header ${k}: plain characters only (no emoji, accented letters or line breaks).`;
    }
    if (s.pastedSecrets !== undefined && (!Array.isArray(s.pastedSecrets) || s.pastedSecrets.some((n) => typeof n !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(n)))) return 'pastedSecrets: names of Studio secrets.';
    for (const [k, v] of Object.entries({ ...(s.env ?? {}), ...(s.headers ?? {}) })) {
        if (typeof v !== 'string' || v.length > 2000) return `${k}: text.`;
        const plain = v.replace(SECRET_REF, '').replace(DB_REF, '');
        if (/authorization|token|passw(or)?d|secret|credential|api[-_]?key|(^|[-_])key$/i.test(k) && plain.replace(/^(Bearer|Basic|token)\s*/i, '').trim()) return `${k} holds a secret: write it as {secret:NAME} (a Studio secret), never the value.`;
    }
    return null;
}

/** The servers of one list (the team's file or this person's). */
export function serversIn(repoRoot: string, home: string, scope: Scope): Record<string, ToolServer> {
    return readFile(scope === 'team' ? path.join(repoRoot, TEAM_FILE) : personalFile(home, repoRoot));
}

/** The team's servers and this person's own (same name: the person's). */
export function listServers(repoRoot: string, home: string): ListedServer[] {
    const out = new Map<string, ListedServer>();
    for (const [name, server] of Object.entries(readFile(path.join(repoRoot, TEAM_FILE)))) out.set(name, { name, scope: 'team', server, missing: [] });
    for (const [name, server] of Object.entries(readFile(personalFile(home, repoRoot)))) out.set(name, { name, scope: 'personal', server, missing: [] });
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function saveServer(repoRoot: string, home: string, scope: Scope, name: string, s: ToolServer | null) {
    const f = scope === 'team' ? path.join(repoRoot, TEAM_FILE) : personalFile(home, repoRoot);
    const all = readFile(f);
    if (s) {
        const problem = serverProblem(name, s);
        if (problem) throw new Error(problem);
        all[name] = s;
    } else if (!(name in all)) throw new Error(`No ${scope} server ${name}.`);
    else delete all[name];
    writeList(f, scope, all);
}

/**
 * Add a server (editing null) or change one (editing: its name before; a new name renames it), in one write. A name
 * another server of the list has already is refused: a rename never replaces another server.
 */
export function putServer(repoRoot: string, home: string, scope: Scope, name: string, s: ToolServer, editing: string | null) {
    const all = serversIn(repoRoot, home, scope);
    const label = scope === 'team' ? 'team' : 'personal';
    if (editing !== null && !(editing in all)) throw new Error(`No ${label} tool server ${editing}: it was removed or renamed meanwhile.`);
    if (name !== editing && name in all) throw new Error(`There is a ${label} tool server ${name} already: edit it, or choose another name.`);
    const problem = serverProblem(name, s);
    if (problem) throw new Error(problem);
    const f = scope === 'team' ? path.join(repoRoot, TEAM_FILE) : personalFile(home, repoRoot);
    const next = { ...all };
    if (editing !== null && editing !== name) delete next[editing];
    next[name] = s;
    writeList(f, scope, next);
}

function writeList(f: string, scope: Scope, all: Record<string, ToolServer>) {
    const clean = (s: ToolServer) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))) as unknown as ToolServer;
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: scope === 'personal' ? 0o700 : undefined });
    fs.writeFileSync(f, `${JSON.stringify({ servers: Object.fromEntries(Object.keys(all).sort().map((k) => [k, clean(all[k])])) }, null, 2)}\n`, scope === 'personal' ? { mode: 0o600 } : undefined);
}

/** The Studio secrets a server refers to ({secret:NAME}). */
export function secretsOf(s: ToolServer): string[] {
    return [...new Set([...JSON.stringify([s.env, s.headers, s.args, s.url]).matchAll(SECRET_REF)].map((m) => m[1]))];
}

/** The secrets and connections a server needs that are not there. */
export function missingFor(s: ToolServer, secret: (n: string) => string | undefined, db: (alias: string) => string | null): string[] {
    const all = JSON.stringify([s.env, s.headers, s.args, s.url]);
    const out: string[] = [];
    for (const m of all.matchAll(SECRET_REF)) if (!secret(m[1])) out.push(`secret ${m[1]}`);
    for (const m of all.matchAll(DB_REF)) { try { if (!db(m[1])) out.push(`connection ${m[1]}`); } catch (e) { out.push(`connection ${m[1]}: ${(e as Error).message.split('\n')[0]}`); } }
    return [...new Set(out)];
}

/** The server with its {secret:…} / {db:…} filled in (only in memory, when a session or a test starts). */
export function resolveServer(s: ToolServer, secret: (n: string) => string | undefined, db: (alias: string) => string | null): ToolServer {
    const fill = (v: string) => v.replace(SECRET_REF, (m, n: string) => secret(n) ?? m).replace(DB_REF, (m, a: string) => db(a) ?? m);
    const map = (o?: Record<string, string>) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fill(v)])) : undefined);
    return { ...s, args: s.args?.map(fill), env: map(s.env), headers: map(s.headers), url: s.url ? fill(s.url) : undefined };
}

/** The Copilot SDK's mcpServers entry. */
export function sdkConfig(s: ToolServer, cwd: string, baseEnv: Record<string, string>): Record<string, unknown> {
    // Listed tools only (new tools off until turned on), else all of them, new ones included.
    const tools = Array.isArray(s.tools) ? s.tools : ['*'];
    return s.kind === 'http'
        ? { type: 'http', url: s.url, headers: s.headers ?? {}, tools }
        : { type: 'local', command: s.command, args: s.args ?? [], env: { ...baseEnv, ...(s.env ?? {}) }, workingDirectory: cwd, tools, timeout: 120_000 };
}

// ---- Test: the Studio as an MCP client, just to start the server and list its tools.

export interface ToolInfo { name: string; description: string; /** A fingerprint of its parameters. */ schema?: string }
export interface TestResult { ok: boolean; tools: ToolInfo[]; server?: string; error?: string; ms: number }
const toolOf = (t: { name: string; description?: string; inputSchema?: unknown }): ToolInfo => ({
    name: String(t.name), description: (t.description ?? '').split('\n')[0].slice(0, 200),
    schema: createHash('sha256').update(JSON.stringify(t.inputSchema ?? {})).digest('hex').slice(0, 12),
});

/** How long Check waits for a server: the same short time a session gives it before leaving it out (agents/host.ts). */
export const CHECK_TIMEOUT_MS = 15_000;

/**
 * Start (or call) the server and list its tools. `s` is already resolved (secrets filled); `conn`: the company
 * network settings for a server over HTTP.
 */
export async function testServer(s: ToolServer, cwd: string, env: Record<string, string>, timeoutMs = CHECK_TIMEOUT_MS, conn?: { agentFor(url: string): unknown; ca?: string | Buffer | Array<string | Buffer> }): Promise<TestResult> {
    const t0 = Date.now();
    let c: McpClient | undefined;
    let timer: NodeJS.Timeout | undefined;
    let late = false;
    try {
        // The whole check (start, then the tool list) within timeoutMs, not each step on its own.
        const work = (async () => {
            c = await McpClient.connect(s.kind === 'http'
                ? { kind: 'http', url: s.url!, headers: s.headers ?? {}, ...(conn ? { agent: conn.agentFor(s.url!) as http.Agent | undefined, ...(conn.ca ? { ca: conn.ca } : {}) } : {}) }
                : { kind: 'stdio', command: s.command!, args: s.args ?? [], cwd, env: { ...env, ...(s.env ?? {}) } },
            { timeoutMs: s.kind === 'http' ? Math.min(timeoutMs, 30_000) : timeoutMs });
            // Started after the check gave up: stopped at once (no server left running).
            if (late) { await c.close(); throw new Error('late'); }
            return (await c.listTools()).map(toolOf);
        })();
        work.catch(() => undefined);
        const tools = await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => { late = true; reject(new Error(`No answer within ${Math.round(timeoutMs / 1000)} s.`)); }, timeoutMs + 500); timer.unref?.(); })]);
        const cl = c as McpClient | undefined;
        return { ok: true, server: cl?.serverLabel, tools, ms: Date.now() - t0 };
    } catch (e) {
        const cl = c as McpClient | undefined;
        return { ok: false, tools: [], ...(cl?.serverLabel ? { server: cl.serverLabel } : {}), error: (e as Error).message, ms: Date.now() - t0 };
    } finally { if (timer) clearTimeout(timer); await (c as McpClient | undefined)?.close(); }
}

// ---- Checks: what a server offered each time it was checked, and what changed.

export interface ToolDiff { added: string[]; removed: string[]; changed: string[]; fromServer?: string; toServer?: string; at: string }
export interface ServerState {
    /** The tools at the last good check. */
    known?: ToolInfo[];
    server?: string;
    checkedAt?: string;
    ok?: boolean;
    error?: string;
    /** The tools when last reviewed (changes are against these). */
    baseline?: ToolInfo[];
    baselineServer?: string;
    /** What changed since the last review. */
    diff?: ToolDiff;
    /** What an agent session saw last (the runtime's own connection). */
    session?: { status: string; error?: string; toolCount?: number; at: string };
}
const stateFile = (home: string, repoRoot: string) => path.join(home, 'mcp-servers', `${hashOf(repoRoot)}.state.json`);
export const stateKey = (scope: Scope, name: string) => `${scope}:${name}`;

export function loadStates(repoRoot: string, home: string): Record<string, ServerState> {
    try { const j = JSON.parse(fs.readFileSync(stateFile(home, repoRoot), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}
export function updateState(repoRoot: string, home: string, key: string, f: (s: ServerState) => ServerState | null) {
    const all = loadStates(repoRoot, home);
    const next = f(all[key] ?? {});
    if (next) all[key] = next; else delete all[key];
    const file = stateFile(home, repoRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify(all, null, 1)}\n`, { mode: 0o600 });
    return next;
}

/** The differences between two tool lists. */
export function diffTools(before: ToolInfo[], after: ToolInfo[]): Pick<ToolDiff, 'added' | 'removed' | 'changed'> {
    const b = new Map(before.map((t) => [t.name, t]));
    const a = new Map(after.map((t) => [t.name, t]));
    return {
        added: [...a.keys()].filter((n) => !b.has(n)).sort(),
        removed: [...b.keys()].filter((n) => !a.has(n)).sort(),
        changed: [...a.values()].filter((t) => { const o = b.get(t.name); return !!o && (o.schema !== t.schema || o.description !== t.description); }).map((t) => t.name).sort(),
    };
}

/**
 * A check's result into the state. Changes are against the baseline (the tools when the person last reviewed, or the
 * first check): they show until reviewed. A failed check keeps what was known.
 */
export function recordCheck(prev: ServerState, r: TestResult, at = new Date().toISOString()): ServerState {
    if (!r.ok) return { ...prev, ok: false, error: r.error, checkedAt: at };
    const baseline = prev.baseline ?? r.tools;
    const baselineServer = prev.baseline ? prev.baselineServer : r.server;
    const d = diffTools(baseline, r.tools);
    const changed = d.added.length + d.removed.length + d.changed.length > 0 || (!!baselineServer && !!r.server && baselineServer !== r.server);
    return { ...prev, known: r.tools, server: r.server, ok: true, error: undefined, checkedAt: at, baseline, baselineServer, diff: changed ? { ...d, fromServer: baselineServer, toServer: r.server, at } : undefined };
}

/** Reviewed: the tools now are the new baseline. */
export function markReviewed(prev: ServerState): ServerState {
    return { ...prev, baseline: prev.known ?? prev.baseline, baselineServer: prev.server ?? prev.baselineServer, diff: undefined };
}

// ---- Import: the configuration a server's documentation gives.

export interface ImportedSecret { secret: string; where: string; value?: string }
export interface Imported { name: string; server: ToolServer; secrets: ImportedSecret[]; problem: string | null }

const SECRETISH = /authorization|token|passw(or)?d|secret|credential|api[-_]?key|(^|[-_])key$/i;
const cleanName = (n: string) => n.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+/g, '-').replace(/-$/, '').slice(0, 40) || 'server';
const GENERIC_KEY = /^(api[-_]?key|apikey|key|token|access[-_]?token|auth[-_]?token|password|secret|authorization|credentials?)$/i;
/** A Studio secret name: the key's own name when it says what it is (ORDERS_API_KEY), else with the server's (SHOP_TOKEN). */
const secretName = (server: string, key: string) => (key && !GENERIC_KEY.test(key) ? key : `${server}_${key}`).toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^[^A-Z]+/, '').replace(/_+$/, '').slice(0, 64);

/** A short name from a package: "@playwright/mcp@latest" → playwright, "@example/orders-mcp@1.2" → orders. */
function packageName(pkg: string): string {
    const parts = pkg.replace(/(.)@[^@/]*$/, '$1').replace(/^@/, '').split('/');
    let n = parts.pop()!.replace(/^(mcp-server-|server-|mcp-)|(-mcp-server|-mcp|-server)$/g, '');
    if (!n || n === 'mcp' || n === 'server') n = parts.pop() ?? 'server';
    return n;
}

/**
 * Parse a pasted MCP configuration: {"mcpServers": {...}} (most servers' documentation), {"servers": {...}}
 * (VS Code mcp.json), {"mcp": {"servers": {...}}} (VS Code settings), {"name": {...}} or one bare entry.
 * Values that look like passwords or tokens become {secret:NAME} references (their values returned to be stored as
 * Studio secrets); ${input:x} / ${env:X} placeholders become references to secrets the person adds.
 */
export function parseImport(text: string): Imported[] {
    let j: unknown;
    try { j = JSON.parse(text.trim().replace(/^[^{]*/, '').replace(/,\s*([}\]])/g, '$1')); } catch (e) { throw new Error(`Not JSON: ${(e as Error).message}`); }
    if (!j || typeof j !== 'object') throw new Error('Paste the server\'s configuration (JSON).');
    const o = j as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const isEntry = (x: any) => x && typeof x === 'object' && (typeof x.command === 'string' || typeof x.url === 'string' || typeof x.serverUrl === 'string'); // eslint-disable-line @typescript-eslint/no-explicit-any
    let entries: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (o.mcpServers && typeof o.mcpServers === 'object') entries = o.mcpServers;
    else if (o.servers && typeof o.servers === 'object') entries = o.servers;
    else if (o.mcp?.servers && typeof o.mcp.servers === 'object') entries = o.mcp.servers;
    else if (isEntry(o)) {
        const pkg = (Array.isArray(o.args) ? o.args : []).find((a: unknown) => typeof a === 'string' && !a.startsWith('-')) as string | undefined;
        entries = { [cleanName(pkg ? packageName(pkg) : o.url ? new URL(o.url).hostname.split('.').slice(-2, -1)[0] ?? 'server' : String(o.command))]: o };
    } else if (Object.values(o).some(isEntry)) entries = o;
    else throw new Error('No MCP server found: expected "mcpServers", "servers", or a server with "command" or "url".');
    const out: Imported[] = [];
    for (const [rawName, e] of Object.entries(entries)) {
        if (!isEntry(e)) continue;
        const name = cleanName(rawName);
        const secrets: ImportedSecret[] = [];
        const ref = (key: string, value: string, where: string): string => {
            // Placeholders of other apps: a Studio secret of that name.
            const ph = value.replace(/\$\{(?:input|env):([^}]+)\}/g, (_m, n: string) => { const sn = secretName(name, n); secrets.push({ secret: sn, where }); return `{secret:${sn}}`; });
            if (ph !== value) return ph;
            if (!SECRETISH.test(key) || /\{secret:/.test(value)) return value;
            const m = /^(Bearer|Basic|token)\s+(.+)$/i.exec(value);
            const plain = m ? m[2] : value;
            if (!plain.trim()) return value;
            const sn = secretName(name, key);
            secrets.push({ secret: sn, where, value: plain });
            return m ? `${m[1]} {secret:${sn}}` : `{secret:${sn}}`;
        };
        const map = (x: unknown, what: string) => x && typeof x === 'object' ? Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, v]) => [k, ref(k, String(v), `${what} ${k}`)])) : undefined;
        const type = String(e.type ?? '').toLowerCase();
        const url = e.url ?? e.serverUrl;
        const server: ToolServer = typeof url === 'string' && (type === '' || /http|sse/.test(type))
            ? { kind: 'http', url, headers: map(e.headers, 'header'), changes: true }
            : { kind: 'stdio', command: String(e.command ?? ''), args: Array.isArray(e.args) ? e.args.map((a: unknown) => ref('', String(a), 'argument')) : undefined, env: map(e.env, 'environment'), changes: true };
        if (Array.isArray(e.tools) && !e.tools.includes('*')) server.tools = e.tools.map(String);
        if (typeof e.description === 'string') server.description = e.description.slice(0, 200);
        out.push({ name, server, secrets, problem: serverProblem(name, server) });
    }
    if (!out.length) throw new Error('No MCP server found in what was pasted.');
    return out;
}
