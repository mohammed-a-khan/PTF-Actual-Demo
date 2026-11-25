/**
 * API client for the local Studio server. The per-launch token arrives once in the URL fragment
 * (#token=…), is removed from the address bar, and is kept for this browser (localStorage, or
 * sessionStorage where localStorage is blocked), so a second tab or a pasted Studio link works too.
 * The server makes a new token at each launch: a stored token it rejects (401) is dropped, and only
 * then the page asks to open the Studio from its start link.
 */
const TOKEN_KEY = 'cs-studio-token';
const TOKEN_RE = /(?:^#|&)token=([A-Za-z0-9_-]+)/;

function stores(): Storage[] {
    const out: Storage[] = [];
    try { out.push(localStorage); } catch { /* blocked */ }
    try { out.push(sessionStorage); } catch { /* blocked */ }
    return out;
}
function saveToken(v: string): void {
    // localStorage first (shared by this browser's tabs); sessionStorage when it is blocked or full.
    for (const s of stores()) { try { s.setItem(TOKEN_KEY, v); return; } catch { /* try the next */ } }
}
function readToken(): string {
    for (const s of stores()) { try { const v = s.getItem(TOKEN_KEY); if (v) return v; } catch { /* try the next */ } }
    return '';
}
function dropToken(): void {
    for (const s of stores()) { try { s.removeItem(TOKEN_KEY); } catch { /* blocked */ } }
}
/** Removes the key from the address bar, keeping the rest of the fragment (a deep link after the key). */
function hashWithoutToken(hash: string): string {
    const rest = hash.replace(/^#/, '').split('&').filter((p) => !/^token=/.test(p)).join('&');
    return rest ? '#' + rest : '';
}

function initToken(): string {
    const m = TOKEN_RE.exec(window.location.hash);
    if (m) {
        saveToken(m[1]);
        history.replaceState(history.state, '', window.location.pathname + window.location.search + hashWithoutToken(window.location.hash));
        return m[1];
    }
    return readToken();
}

let token = initToken();
export const hasToken = () => token !== '';
// A start link pasted into an already open tab changes only the fragment (no page load): pick
// up the new key by loading the page again (the key is then read and removed as usual).
window.addEventListener('hashchange', () => {
    const m = TOKEN_RE.exec(window.location.hash);
    if (m && m[1] !== token) { saveToken(m[1]); window.location.reload(); }
});
// Another tab opened a new start link (the Studio was started again): use its key here too.
window.addEventListener('storage', (e) => {
    if (e.key === TOKEN_KEY && e.newValue && e.newValue !== token) token = e.newValue;
});
/** The server rejected the key (a stored key from an earlier launch): forget it and show the start-link page. */
function tokenRejected(res: Response, data?: unknown): boolean {
    if (res.status !== 401) return false;
    const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : '';
    if (data !== undefined && !/Studio token/i.test(msg)) return false;
    // A newer key may have arrived from another tab meanwhile: only drop the one that was refused.
    if (readToken() === token) dropToken();
    const fresh = readToken();
    if (fresh && fresh !== token) { token = fresh; return true; }
    token = '';
    window.location.reload();
    return true;
}

export class ApiError extends Error {
    /** e.g. 'stale-hunk', 'index-lock': errors the UI offers a specific action for. */
    constructor(message: string, public status: number, public code?: string) { super(message); }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = undefined;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
    if (!res.ok) {
        tokenRejected(res, data);
        const msg = (data && typeof data === 'object' && 'error' in data) ? String((data as { error: unknown }).error) : `Request failed (${res.status})`;
        const code = data && typeof data === 'object' && 'code' in data && typeof (data as { code: unknown }).code === 'string' ? (data as { code: string }).code : undefined;
        // Git's index.lock is left behind by a crashed Git: the app offers to remove it (App.tsx).
        if (code === 'index-lock') window.dispatchEvent(new CustomEvent('cs-studio:index-lock'));
        throw new ApiError(msg, res.status, code);
    }
    return data as T;
}

/** Asked before a run against a protected (production-like) environment; the app replaces it with its own dialog. */
let confirmProtected: (message: string) => Promise<boolean> = async (m) => window.confirm(m);
export const setProtectedRunConfirm = (f: (message: string) => Promise<boolean>) => { confirmProtected = f; };
/** Starts something that runs tests: when the environment is protected, asks first and starts it again confirmed. */
async function confirmedRun<T>(method: string, url: string, b: object): Promise<T> {
    try { return await request<T>(method, url, b); }
    catch (e) {
        if (e instanceof ApiError && e.code === 'run-protected' && await confirmProtected(e.message)) return request<T>(method, url, { ...b, confirmed: true });
        throw e;
    }
}
export interface PublishPreviewDef { groups: Array<{ plan: number; suite: number; testCases: number; results: Array<{ testCase: number; outcome: string; scenario: string }> }>; notLinked: string[]; noPlan: string[];
    published?: Array<{ plan: number; suite: number; runId: number; url: string; published: number; missing: number[] }> }
export interface MissionInputDef { key: string; label: string; required?: boolean; multiline?: boolean; placeholder?: string; kind?: 'project' | 'env' | 'run' | 'text' | 'number' }
export interface MissionBudgetDef { minutes: number; modelCalls: number; attempts: number }
export interface MissionTemplateDef { key: string; title: string; about: string; inputs: MissionInputDef[]; oneOf?: string[]; writes: boolean; budget: MissionBudgetDef; team?: Array<{ id: string; name: string }> }
export type MissionStateDef = 'queued' | 'preparing' | 'working' | 'waiting' | 'verifying' | 'succeeded' | 'partial' | 'failed' | 'blocked' | 'over-budget' | 'stopped';
export interface MissionUsedDef { activeMs: number; modelCalls: number; inputTokens: number; outputTokens: number; cost: number; attempts: number }
export interface MissionSummaryDef { id: string; key: string; title: string; state: MissionStateDef; reason?: string; trigger: { kind: string; by: string; ref?: string }; createdAt: string; endedAt?: string; used: MissionUsedDef; budget: MissionBudgetDef; changes: number; verified: boolean; waiting: boolean; result?: string }
export interface MissionTriggerDef { mission: string; on: 'run-failed' | 'schedule'; cron?: string; projects?: string[]; envs?: string[]; inputs?: Record<string, string>; enabled?: boolean; maxPerDay?: number }
export interface MissionsDef { templates: MissionTemplateDef[]; runs: MissionSummaryDef[]; triggers: MissionTriggerDef[]; problems: string[]; file: string }
export interface ExploreNoteDef { id: string; kind: 'covered' | 'bug' | 'risk' | 'question' | 'idea'; title: string; detail?: string; screen?: string; severity?: 'high' | 'medium' | 'low'; steps?: string[]; shot?: string; by?: string; at: string }
export interface MissionDef {
    id: string; key: string; title: string; inputs: Record<string, string>; state: MissionStateDef; reason?: string; trigger: { kind: string; by: string; ref?: string }; autonomy: 'supervised' | 'autonomous';
    createdAt: string; endedAt?: string; budget: MissionBudgetDef; used: MissionUsedDef; session?: string;
    copy?: { rel: string; branch: string; base: string; dirtyAtStart?: boolean }; commit?: string; changes: Array<{ path: string; status: string }>;
    timeline: Array<{ at: string; text: string; kind: string }>;
    approvals?: Array<{ id: string; title: string; detail: string; kind: string; who?: string }>;
    exploration?: { notes: ExploreNoteDef[] };
    team?: Array<{ id: string; member: string; name: string; task: string; session?: string; state: 'working' | 'done' | 'failed' | 'stopped'; answer?: string; startedAt: string; endedAt?: string; used?: { modelCalls: number; cost: number } }>;
    checkpoints: Array<{ id: string; kind: 'question' | 'plan'; question: string; content?: string; options?: string[]; at: string; answer?: string; answeredAt?: string; by?: string }>;
    report?: { outcome: string; summary: string; findings?: Array<{ scenario?: string; cause?: string; detail: string; fixed?: boolean }>; verify?: { features?: string[]; scenarios?: string[]; tags?: string }; bugs?: Array<{ title: string; detail: string; filed?: { id: number; url: string; by: string; at: string } }> };
    verifications: Array<{ at: string; attempt: number; passed: boolean; why: string; runs: Array<{ id: string; state: string; passed?: number; failed?: number }>; failures: Array<{ name: string; error?: string }> }>;
    memory: Array<{ id: string; note: string; state: 'proposed' | 'accepted' | 'dismissed' }>;
    result?: { kind: string; at: string; detail?: string };
}
export interface SecretUseDef { file: string; line?: number; key?: string; where: string; env?: string }
export interface SecretUsageDef { secrets: Array<{ name: string; project?: string; env?: string; updatedAt: string; ageDays: number; rotate: boolean; uses: SecretUseDef[] }>; missing: Array<{ name: string; uses: SecretUseDef[] }>; rotateDays: number }
export type KnowledgeKind = 'repo' | 'folder' | 'ado-wiki' | 'ado-workitems' | 'history' | 'url';
export interface KnowledgeSourceDef { id: string; name: string; kind: KnowledgeKind; enabled?: boolean; path?: string; include?: string[]; query?: string; wiki?: string; urls?: string[]; project?: string }
export interface KnowledgeStatusDef extends KnowledgeSourceDef { docs: number; chunks: number; builtAt: string | null; errors: string[] }
export interface KnowledgeHitDef { id: string; source: string; sourceName: string; path: string; title: string; type: string; lines?: [number, number]; url?: string; score: number; snippet: string }
export type ToolGroupId = 'studio-read' | 'studio-change' | 'browser' | 'tests' | 'app-code' | 'files' | 'shell' | 'tool-servers' | 'knowledge';
export type AgentTriggerDef =
    | { on: 'run-failed'; projects?: string[]; envs?: string[]; maxPerDay?: number; enabled?: boolean }
    | { on: 'schedule'; cron: string; inputs?: Record<string, string>; maxPerDay?: number; enabled?: boolean }
    | { on: 'work-item'; query: string; input?: string; inputs?: Record<string, string>; maxPerDay?: number; enabled?: boolean }
    | { on: 'pull-request'; target?: string; repository?: string; inputs?: Record<string, string>; maxPerDay?: number; enabled?: boolean };
export interface InboxItemDef { id: string; kind: 'question' | 'plan' | 'approval' | 'review' | 'regression'; title: string; detail?: string; source: { type: 'mission' | 'conversation' | 'evaluation'; id: string; title: string }; at: string; options?: string[]; actions: Array<'answer' | 'approve' | 'approve-session' | 'reject' | 'open'>; who?: string }
export type EvalCheckDef =
    | { kind: 'contains' | 'not-contains'; text: string } | { kind: 'matches'; pattern: string } | { kind: 'tool-called'; tool: string; args?: string } | { kind: 'tool-not-called'; tool: string }
    | { kind: 'cites-knowledge' } | { kind: 'max-calls'; calls: number } | { kind: 'max-seconds'; seconds: number } | { kind: 'judge'; criteria: string };
export interface EvalCaseDef { id: string; name: string; prompt: string; inputs?: Record<string, string>; checks: EvalCheckDef[]; repeat?: number }
export interface EvalRunSummaryDef { id: string; state: 'running' | 'done' | 'failed' | 'stopped'; startedAt: string; endedAt?: string; by: string; passed: number; total: number; compared?: { run: string; regressions: number; fixed: number }; subject: { model?: string; tools: string[] } }
export interface EvalRunDef extends EvalRunSummaryDef { agent: string; agentName: string; error?: string;
    cases: Array<{ id: string; name: string; pass: boolean; passRate: number; regression?: boolean; fixed?: boolean; attempts: Array<{ pass: boolean; answer: string; tools: Array<{ tool: string; args: string }>; calls: number; ms: number; error?: string; checks: Array<{ check: EvalCheckDef; pass: boolean; detail: string }> }> }> }
export interface EvalsDef { file: string; suite: { cases: EvalCaseDef[] }; runs: EvalRunSummaryDef[]; running: boolean; problem?: string }
export interface TeamAgentDef {
    id: string; name: string; description?: string; mode: 'assistant' | 'mission'; instructions: string; starters?: string[]; tools: ToolGroupId[]; knowledge?: string[]; model?: string;
    goal?: string; inputs?: MissionInputDef[]; writes?: boolean; budget?: Partial<MissionBudgetDef>; verify?: { kind: 'tests'; features?: 'changed' | string[]; tags?: string; scenarios?: string[]; repeat?: number } | { kind: 'report' };
    triggers?: AgentTriggerDef[]; team?: string[]; updatedAt?: string; updatedBy?: string;
}
export interface AgentBuilderDef { agents: TeamAgentDef[]; problems: string[]; dir: string; templates: TeamAgentDef[]; teamCandidates: Array<{ id: string; name: string; description?: string; tools: ToolGroupId[]; builtIn: boolean }>; groups: Array<{ id: ToolGroupId; label: string; about: string }>; knowledge: Array<{ id: string; name: string }>; reserved: string[]; policyModels: string[] | null }
export interface NotifyChannelDef { id: string; name: string; kind: 'teams' | 'slack' | 'webhook'; when: 'always' | 'failures' | 'changes'; projects?: string[]; envs?: string[]; enabled: boolean; hasWebhook?: boolean; inbox?: boolean }
export interface NotifyDeliveryDef { at: string; channel: string; run: string; ok: boolean; detail: string }
export interface NotifyDef { channels: NotifyChannelDef[]; deliveries: NotifyDeliveryDef[]; canSave: boolean }
export interface DoctorDef { project?: string; env?: string; projects: string[]; environments: Record<string, string[]>;
    checks: Array<{ id: string; group: string; title: string; level: 'ok' | 'warning' | 'error' | 'info'; detail: string; fix?: { action: string; label: string } }> }
export interface RunConfigDef { name: string; description?: string; request: RunRequest }
/** The Azure DevOps project the Pull requests screen shows (undefined: the configured one). */
let prProject: string | undefined;
export const setPrProject = (p: string | undefined) => { prProject = p; };
const withPrProject = (url: string) => (prProject ? `${url}${url.includes('?') ? '&' : '?'}adoProject=${encodeURIComponent(prProject)}` : url);
const q = (o: Record<string, string | number | boolean | undefined>) =>
    '?' + Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');

// ---- types (mirror the server)
export interface FileStatus { path: string; origPath?: string; staged: string; unstaged: string; untracked: boolean; conflicted: boolean }
export interface GitRemote { name: string; fetchUrl: string; pushUrl: string }
export interface RepoStatus { branch: string | null; head: string | null; upstream: string | null; ahead: number; behind: number; files: FileStatus[]; hasConflicts: boolean; mergeMessage?: string; operation: 'merge' | 'cherry-pick' | 'revert' | 'rebase' | 'am' | null;
    /** The upstream branch was deleted on the server. */
    upstreamGone?: boolean;
    /** During a rebase Git's "ours" is the branch being rebased onto and "theirs" is your commit. */
    sidesSwapped?: boolean; rebaseBranch?: string | null; rebaseOnto?: string | null }
export interface BranchInfo { name: string; current: boolean; upstream: string | null; sha: string; remote: boolean; upstreamGone?: boolean }
export interface LogEntry { sha: string; authorName: string; authorEmail: string; date: string; subject: string }
export interface Finding { id: string; ruleId: string; type: string; reason: string; confidence: 'high' | 'medium'; file: string; line: number; column: number; preview: string; fingerprint: string; suggestedName?: string }
export type GateResult =
    | { status: 'ok'; sha?: string; output?: string; overridden?: boolean }
    | { status: 'blocked'; findings: Finding[]; digest: string; overrideAllowed: boolean; overrideRefusal: string | null }
    | { status: 'rejected'; message: string };
export type MergeResult = { status: 'ok' | 'conflicts' | 'rejected'; message?: string; conflicts?: string[] };
export interface SecretMeta { name: string; project?: string; env?: string; createdAt: string; updatedAt: string; length: number }
export interface Definition { source: string; label: string; line?: number; raw: string }
export interface EffectiveEntry { key: string; value: string; sensitive: boolean; from: Definition; overrides: Definition[]; runtimePlaceholders: boolean }
export interface Problem { code: string; severity: 'error' | 'warning' | 'info'; key?: string; source?: string; line?: number; message: string }
export interface ResolveResult { project: string; environment: string; layers: Array<{ source: string; label: string; exists: boolean; keys: number }>; entries: EffectiveEntry[]; problems: Problem[] }
export interface Discover { projects: string[]; environments: Record<string, string[]>; commonEnvironments: string[] }
export interface ActivityEntry { ts: string; action: string; repo: string; summary: string; data?: Record<string, unknown> }
export interface Override { reason: string; digest: string }

export interface PipelineRow { name: string; usedBy: Array<{ key?: string; file: string; line?: number }>; local: boolean; inAdo?: 'secret' | 'plain' | 'missing' }
export interface PipelineSecrets { project: string; env: string; variableGroup: string; rows: PipelineRow[]; yaml: string; adoChecked: boolean; groupExists?: boolean; adoError?: string; adoHost?: string }
export interface ClientCert { host: string; pfxFile?: string; certFile?: string; keyFile?: string; passphraseSecret?: string }
export interface NetworkSettings {
    proxyMode: 'off' | 'environment' | 'manual' | 'system' | 'pac'; proxyUrl: string; proxyUser: string; bypass: string[];
    useSystemCerts: boolean; caFile: string; certsForTestRuns: boolean;
    pacUrl?: string; proxyAuth?: 'basic' | 'ntlm' | 'digest'; proxyDomain?: string; clientCerts?: ClientCert[];
}
export interface StudioSettings {
    trustedAdoHosts: string[]; adoPatSecret: string; adoAuth?: 'pat' | 'entra'; openBrowser: boolean; port: number; loadTeamFolder?: string;
    git: { name: string; email: string; scope: 'repository' | 'global' | 'none' };
    network: NetworkSettings;
    networkInfo: { systemCertsSupported: boolean; nodeVersion: string; hasProxyPassword: boolean; environmentProxy: string; environmentNoProxy: string };
}
export interface ConnectionCheck {
    ok: boolean; stage: 'dns' | 'connect' | 'proxy' | 'certificate' | 'http' | 'ok'; message: string; url: string; proxy: string | null;
    status?: number; certificateChain?: Array<{ subject: string; issuer: string }>; detail?: string; tokenChecked?: boolean;
}
export type GitNetKey = 'http.proxy' | 'https.proxy' | 'http.sslBackend' | 'http.sslCAInfo' | 'http.sslVerify';
export interface GitNetworkState {
    global: Partial<Record<GitNetKey, string>>; effective: Partial<Record<GitNetKey, { value: string; origin: string }>>;
    environment: Record<string, string>; platform: string; gitVersion: string;
}
export interface GitNetworkChange { proxy?: string | null; sslBackend?: 'schannel' | 'openssl' | null; sslCAInfo?: string | null; restoreSslVerify?: boolean }
export interface GitConnectionCheck { ok: boolean; stage: string; message: string; remote?: string; detail?: string }

export interface DiffOpts { ws?: 'none' | 'changes' | 'all'; eol?: boolean }
export interface GraphRow { col: number; into: number[]; passThrough: number[]; out: number[]; width: number }
export interface LogCommit { sha: string; parents: string[]; authorName: string; authorEmail: string; date: string; subject: string; refs: Array<{ name: string; kind: 'head' | 'branch' | 'remote' | 'tag' | 'stash' }> }
export interface NameStatus { status: string; path: string; oldPath?: string }
export interface CommitDetails { sha: string; parents: string[]; authorName: string; authorEmail: string; date: string; message: string; files: NameStatus[]; pushed: boolean; branches: string[] }
export interface HistoryQuery { all?: boolean; text?: string; field?: 'message' | 'author' | 'path'; firstParent?: boolean; noMerges?: boolean; limit?: number; refs?: string }
export interface StashEntry { index: number; ref: string; sha: string; message: string; date: string }
export interface TagInfo { name: string; sha: string; date: string; message: string; annotated: boolean }
export interface Hunk { id: string; header: string; lines: string[]; added: number; removed: number; newStart: number }
export interface Backup { ref: string; sha: string; date: string; subject: string }
type OpResult = { status: 'ok' | 'conflicts' | 'rejected'; message?: string; conflicts?: string[] };
const dq = (o?: DiffOpts) => ({ ws: o?.ws && o.ws !== 'none' ? o.ws : undefined, eol: o?.eol ? true : undefined });

export interface FileData { path: string; content?: string; hash: string; size: number; eol?: string; binary: boolean }
export interface Diag { line: number; column: number; endLine: number; endColumn: number; message: string; severity: string; source: string; fix?: 'create-step' }
export interface StepPlan {
    step: string; pattern: string; params: Array<{ name: string; type: string }>; preview: string;
    targets: Array<{ file: string; exists: boolean; recommended: boolean }>;
}
export interface StepUsage { path: string; line: number; column: number; text: string; keyword: string }
export interface StepUsages { step: { pattern: string; file: string; line: number; builtIn?: boolean }; usages: StepUsage[] }
export interface StepRename { step: { pattern: string; file: string; line: number }; pattern?: string; changes: Array<{ path: string; line: number; before: string; after: string }>; files: string[]; skipped: StepUsage[] }
export interface Loc { path: string; line: number; column: number; endLine: number; endColumn: number; text?: string }
export interface SearchHit { path: string; line: number; column: number; text: string }
export interface CompletionItem { name: string; kind: string; sortText?: string; insertText?: string; detail?: string }

// ---- API workspace (same shapes as src/api/model.ts)
/** GET, POST… or any other method the API uses (PURGE, PROPFIND…), upper case. */
export type HttpMethod = string;
export interface ApiKV { key: string; value: string; enabled?: boolean; description?: string; secret?: boolean }
export type ApiBodyMode = 'none' | 'json' | 'text' | 'xml' | 'form' | 'multipart' | 'file' | 'graphql';
export interface GqlFieldInfo { name: string; type: string; description?: string; deprecated?: string; args: Array<{ name: string; type: string; defaultValue?: string; description?: string }> }
export interface GqlTypeInfo { name: string; kind: 'object' | 'interface' | 'union' | 'enum' | 'input' | 'scalar'; description?: string; fields: GqlFieldInfo[]; values?: string[]; possible?: string[] }
export interface GqlOutline { query?: string; mutation?: string; subscription?: string; types: GqlTypeInfo[] }
export interface GqlError { message: string; line?: number; column?: number }
export interface ApiPart extends ApiKV { type?: 'text' | 'file' }
export interface ApiAuth {
    type: 'inherit' | 'none' | 'basic' | 'bearer' | 'apikey' | 'oauth2' | 'ntlm' | 'digest' | 'jwt' | 'aws' | 'oauth1' | 'hawk' | 'edgegrid' | 'asap' | 'negotiate'; spn?: string;
    username?: string; password?: string; domain?: string; workstation?: string; token?: string; key?: string; value?: string; in?: 'header' | 'query';
    grant?: 'client_credentials' | 'password' | 'authorization_code' | 'implicit' | 'device_code' | 'refresh_token'; tokenUrl?: string; clientId?: string; clientSecret?: string; scope?: string;
    authUrl?: string; deviceUrl?: string; pkce?: boolean; refreshToken?: string; audience?: string;
    algorithm?: string; secret?: string; privateKey?: string; payload?: string; jwtHeader?: string; prefix?: string; queryKey?: string;
    accessKey?: string; secretKey?: string; sessionToken?: string; region?: string; service?: string;
    consumerKey?: string; consumerSecret?: string; tokenSecret?: string; signatureMethod?: 'HMAC-SHA1' | 'HMAC-SHA256' | 'RSA-SHA1' | 'PLAINTEXT'; realm?: string;
    hawkId?: string; hawkKey?: string; ext?: string; payloadHash?: boolean;
    clientToken?: string; accessToken?: string;
    issuer?: string; keyId?: string; subject?: string; expiresIn?: number;
}
export type ApiCheckKind = 'script' | 'status' | 'statusBetween' | 'jsonExists' | 'jsonEquals' | 'jsonNotContains' | 'bodyContains' | 'bodyNotContains' | 'bodyEmpty' | 'headerExists' | 'headerEquals' | 'headerContains' | 'timeBelow' | 'rule' | 'schema' | 'dbItems';
export type ApiValueSource = 'json' | 'xml' | 'header' | 'cookie' | 'status' | 'time' | 'size' | 'body';
export type ApiOperator = 'equals' | 'notEquals' | 'contains' | 'notContains' | 'matches' | 'exists' | 'notExists' | 'empty' | 'notEmpty' | 'type' | 'count' | 'greater' | 'less' | 'atLeast' | 'atMost' | 'between' | 'oneOf';
export type ApiCompare = 'text' | 'number' | 'date' | 'datetime';
export interface ApiExpected { from: 'text' | 'saved' | 'data' | 'config' | 'query'; value: string; query?: string; connection?: string; params?: string[]; column?: string }
export interface ApiDbItemsRule { title: string; items: string; connection: string; query: string; sql?: string; params: string[]; rows?: string; matchBy?: { field: string; column: string }; count?: boolean; fields: Array<{ field: string; column: string; compare: ApiCompare; tolerance?: number }>; whenNoRows?: Array<{ field: string; value: string }> }
export interface ApiCheck { kind: ApiCheckKind; target?: string; value?: string; min?: number; max?: number; source?: ApiValueSource; op?: ApiOperator; expected?: ApiExpected; expected2?: ApiExpected; compare?: ApiCompare; tolerance?: number; ignoreCase?: boolean; schema?: string; schemaFile?: string; db?: ApiDbItemsRule }
export interface ApiExtract { from: 'json' | 'header' | 'cookie' | 'status' | 'xml' | 'regex' | 'body'; path: string; variable: string }
export interface ApiData { source: string; type: 'json' | 'csv' | 'excel'; sheet?: string; path?: string; filter?: string }
export interface ApiPrepare { name: string; whenEmpty: 'query' | 'today' | 'previousBusinessDay' | 'text'; format?: string; value?: string; query?: string; connection?: string; params?: string[]; column?: string; list?: boolean }
export interface ApiRequestDef { kind: 'request'; id: string; name: string; description?: string; method: HttpMethod; url: string; query: ApiKV[]; headers: ApiKV[]; body: { mode: ApiBodyMode; text?: string; form?: ApiKV[]; parts?: ApiPart[]; file?: string; graphql?: { query: string; variables?: string; operationName?: string } }; auth: ApiAuth; checks: ApiCheck[]; extract: ApiExtract[]; notes?: string[]; ws?: { steps: ApiWsStep[]; protocol?: ApiMsgProtocol; options?: ApiMsgOptions }; data?: ApiData; prepare?: ApiPrepare[]; scripts?: ApiScripts; examples?: ApiExampleDef[]; settings?: ApiRequestSettings; comments?: ApiCommentDef[]; recordedThinkMs?: number }
export interface ApiCommentDef { id: string; author: string; at: string; text: string; resolved?: boolean; replyTo?: string }
export interface ApiRequestChange { sha: string; author: string; date: string; message: string; kind: 'added' | 'changed' | 'removed'; diff: string; added: number; removed: number }
export interface ApiRequestSettings { timeoutMs?: number; followRedirects?: boolean; retries?: number; retryDelayMs?: number; insecure?: boolean; http2?: boolean; resources?: boolean }
export interface ApiExampleDef { id: string; name: string; status: number; headers?: Record<string, string>; body?: string; when?: { query?: Record<string, string>; body?: string } }
export type ApiScopeName = 'saved' | 'collection' | 'global' | 'config' | 'secret' | 'missing';
export interface ApiScopeEntry { ref: string; name: string; from: ApiScopeName; value?: string; shadowed: Array<{ from: ApiScopeName; value: string }>; usedBy: string[]; setBy: string[]; secret: boolean }
export interface ApiScripts { pre?: string; test?: string }
export interface ApiWsStep { kind: 'send' | 'expect'; text: string; timeoutMs?: number; save?: { path: string; variable: string }; topic?: string; key?: string }
export type ApiMsgProtocol = 'websocket' | 'socketio' | 'mqtt' | 'kafka' | 'grpc' | 'amqp' | 'mcp' | 'sql';
export interface ApiMsgOptions { path?: string; subscribe?: string[]; qos?: 0 | 1 | 2; clientId?: string; groupId?: string; sasl?: 'plain' | 'scram-sha-256' | 'scram-sha-512'; fromBeginning?: boolean; protoFile?: string; reflection?: boolean; service?: string; method?: string }
export interface GrpcServiceInfo { service: string; methods: Array<{ name: string; requestStream: boolean; responseStream: boolean; request: string; response: string }> }
export interface ApiFolderDef { kind: 'folder'; id: string; name: string; description?: string; items: ApiItemDef[] }
export type ApiItemDef = ApiRequestDef | ApiFolderDef;
export interface ApiCollectionDef { format: 'cs-studio-api/1'; name: string; description?: string; baseUrl: string; variables: ApiKV[]; auth: ApiAuth; items: ApiItemDef[]; scripts?: ApiScripts }
export interface ApiCollectionInfo { project: string; file: string; name: string; requests: number; changed: string }
export interface ApiCheckResult { check: ApiCheck; pass: boolean; actual?: string; message: string }
export interface ApiCookie { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; expires: string | null }
export interface ApiTimings { blocked: number; dns: number; connect: number; tls: number; send: number; wait: number; download: number }
export interface ApiTlsInfo { protocol: string; cipher: string; authorized: boolean; authorizationError?: string; chain: Array<{ subject: string; issuer: string; validFrom: string; validTo: string; fingerprint256: string; altNames?: string; serial?: string }> }
export interface ApiHistoryEntry { def: ApiRequestDef; sent: ApiSendResult['prepared']; response?: NonNullable<ApiSendResult['response']>; checks?: Array<{ pass: boolean; message: string; actual?: string }>; error?: string }
export interface ApiSendResult {
    prepared: { method: string; url: string; headers: Record<string, string>; body?: string; missing: string[] };
    error?: string;
    response?: { status: number; statusText: string; headers: Record<string, string>; body: string; truncated: boolean; size: number; timeMs: number; redirects: string[]; timings?: ApiTimings; bodyBase64?: string; remote?: string; tls?: ApiTlsInfo };
    checks?: ApiCheckResult[];
    extracted?: Array<{ variable: string; value?: string; found: boolean }>;
    /** Test data values that took their defaults (the row left them empty); a body that is not valid JSON. */
    notes?: string[];
    /** The cookies Send keeps for this collection (after this response). */
    cookies?: ApiCookie[];
    /** console.log of the request's scripts. */
    logs?: Array<{ level: 'log' | 'info' | 'warn' | 'error'; text: string }>;
    /** Values the scripts set (pm.environment / pm.collectionVariables / pm.variables). */
    scriptVars?: Record<string, string>;
    /** pm.visualizer.set: the page the template made (shown in a sandboxed frame). */
    visualizer?: string;
}
export interface ApiRunStep { iteration: number; requestId: string; name: string; method: string; url: string; status?: number; timeMs?: number; size?: number; passed: boolean; error?: string; checks: Array<{ pass: boolean; message: string; actual?: string }>; logs?: string[] }
export type ApiRunChange = 'fixed' | 'broke' | 'same' | 'still failing' | 'new' | 'gone';
export interface ApiRunComparison {
    a: Pick<ApiRunJob, 'id' | 'name' | 'env' | 'startedAt' | 'summary'>; b: Pick<ApiRunJob, 'id' | 'name' | 'env' | 'startedAt' | 'summary'>;
    rows: Array<{ key: string; name: string; iteration: number; change: ApiRunChange; a?: { status?: number; timeMs?: number; passed: boolean }; b?: { status?: number; timeMs?: number; passed: boolean }; timeDelta?: number; checksChanged?: string[] }>;
    counts: Record<ApiRunChange, number>; avgDelta: number;
}
export interface ApiMonitorDef { id: string; name: string; file: string; env: string; everyMinutes: number; enabled: boolean; webhookSecret?: string; alertOn: 'failure' | 'change'; last?: { at: string; runId: string; passed: boolean; failed: number; requests: number; alert?: string } }
export interface ApiFlow {
    nodes: Array<{ id: string; name: string; method: string; folder: string; scenario: number; column: number; row: number; saves: string[]; uses: string[] }>;
    edges: Array<{ from: string; to: string; kind: 'value' | 'jump' | 'order'; label: string }>;
    scenarios: Array<{ index: number; name: string; requests: string[] }>;
    unresolved: Array<{ request: string; name: string }>;
}
export interface ApiRunJob { id: string; collection: string; name: string; project: string; env: string; startedAt: string; endedAt?: string; state: 'running' | 'stopped' | 'finished'; iterations: number; total: number; steps: ApiRunStep[]; summary: { requests: number; passed: number; failed: number; checks: number; checksPassed: number; avgMs: number } }
export interface ApiHistoryItem { id?: string; at: string; project: string; env: string; collection: string; file?: string; requestId?: string; request: string; method: string; url: string; status: number; timeMs: number; passed: number; checks: number; /** Not sent: could not connect, timed out. */ error?: string }
export interface ApiImportReport { requests: number; folders: number; converted: number; notConverted: number; warnings: string[]; secrets: Record<string, string> }
/** The framework core's review of a change: every file before/after with its diff, and the standards check. */
export interface FindingDef { level: 'error' | 'warning' | 'info'; rule: string; file?: string; line?: number; message: string }
export interface ReviewedFileDef { path: string; kind: 'feature' | 'data' | 'page' | 'steps' | 'config' | 'other'; text: string; change: 'new' | 'update' | 'same'; before: string | null; baseHash: string | null; diff: string; added: number; removed: number }
export interface PlanReviewDef { title: string; files: ReviewedFileDef[]; findings: FindingDef[]; warnings: string[]; blocked: boolean }
/** What apply checks: the files as the review saw them. */
/** A new project made by the framework's scaffolder (cs_qa_init_project). */
export interface NewProjectRequest { slug: string; displayName?: string; environments: Array<{ name: string; baseUrl: string; loginUrl?: string; apiBaseUrl?: string }>; dbType: 'none' | 'oracle' | 'sqlserver' | 'mysql' | 'postgresql'; credentials?: { username?: string; password?: string } }
export interface NewProjectPreview { review: PlanReviewDef; dirs: string[]; environments: string[]; alias: string; globalEnv: 'written' | 'kept' | 'unavailable'; notes: string[] }
export const baseHashesOf = (r?: PlanReviewDef | null): Record<string, string | null> | undefined => (r ? Object.fromEntries(r.files.map((f) => [f.path, f.baseHash])) : undefined);
export interface ApiFeaturePreview { file: string; exists: boolean; text: string; warnings: string[]; scenarios: number; current?: string; review?: PlanReviewDef }

// ---- Performance (same shapes as src/load/*)
export interface HarReportDef { entries: number; imported: number; skipped: { static: number; preflight: number; otherHosts: number; other: number }; hosts: Array<{ host: string; requests: number }>; correlations: Array<{ variable: string; from: number; fromName: string; kind: 'json' | 'header' | 'regex'; path: string; preview: string; usedBy: string[]; rule?: string }>; medianPause?: number; warnings: string[]; secrets: Record<string, string> }
export interface LoadPolicyDef { type: 'constant' | 'ramp' | 'steps' | 'peaks' | 'wave' | 'arrival' | 'custom'; points?: Array<{ t: number; users: number }>; duration: number; users: number; /** arrival: iterations per second, from startRate. */ rate?: number; startRate?: number; rampUp?: number; rampDown?: number; startUsers?: number; stepUsers?: number; stepEvery?: number; peakUsers?: number; peakEvery?: number; peakLength?: number; amplitude?: number; period?: number }
export interface LoadSlaLevels { avg?: number; p90?: number; p95?: number; p99?: number; errorRate?: number; /** Requests per second, at least. */ throughput?: number }
export interface LoadSla extends LoadSlaLevels { target: string; /** Arrival rate: percent of the due iterations dropped, at most. */ dropped?: number; warn?: LoadSlaLevels; per?: 'run' | 'interval' }
export interface LoadRangeTx { id: string; name: string; count: number; errors: number; errorRate: number; avg: number; p50: number; p90: number; p95: number; p99: number; max: number; throughput: number }
export interface LoadRegressionDef { pass: boolean; details: string[]; rows: Array<{ id: string; name: string; base: LoadRangeTx; now: LoadRangeTx; problems: string[] }> }
export interface LoadAnalysisDef {
    steady: { from: number; to: number } | null; range: { from: number; to: number; seconds: number; intervals: number; exact: boolean; total: LoadRangeTx; tx: LoadRangeTx[] }; intervals: Array<{ t0: number; t1: number }>;
    correlation: Array<{ monitor: string; unit: string; r: number; n: number; strength: 'strong' | 'moderate' | 'weak' | 'none' }>;
    baseline?: { id: string; startedAt: string; gate: Record<string, number>; gateFromScenario: boolean; regression: LoadRegressionDef }; isBaseline: boolean;
}
export interface LoadTeamRunDef { file: string; id: string; project: string; scenario: string; name: string; env: string; startedAt: string; passed: boolean; stopReason?: string; maxUsers: number; duration: number;
    summary: { requests: number; errorRate: number; avg: number; p95: number; p99: number; throughput: number }; by: { user: string; machine: string; pipeline?: string }; publishedAt: string }
export interface LoadScheduleDef { id: string; file: string; env?: string; enabled: boolean; kind: 'once' | 'daily' | 'weekly'; at: string; days?: number[]; last?: { at: string; runId?: string; error?: string }; next?: string | null }
export interface LoadInsightsDef { summary: string; insights: Array<{ kind: 'anomaly' | 'capacity' | 'cause' | 'note'; severity: 'info' | 'warning' | 'critical'; title: string; detail: string; at?: { from: number; to: number } }> }
export type LoadRating = 'good' | 'acceptable' | 'poor' | 'critical' | 'info';
export interface LoadExplainDef { status: 'green' | 'amber' | 'red'; headline: string; answer: string; metrics: Array<{ key: string; label: string; value: string; meaning: string; rating: LoadRating; basis: string }>;
    behaviour: { verdict: string; text: string }; risks: string[]; recommendations: string[]; glossary: Array<{ term: string; text: string }> }
export interface LoadCompareDef {
    a: { id: string; name: string; env: string; startedAt: string; passed: boolean; maxUsers: number; duration: number }; b: LoadCompareDef['a'];
    comparison: { status: 'green' | 'amber' | 'red'; headline: string; answer: string; metrics: Array<{ label: string; a: string; b: string; change: string; verdict: string; meaning: string }>;
        transactions: Array<{ name: string; aP95: number; bP95: number; changePct: number; verdict: string }>; findings: string[]; notes: string[] };
    series: Array<{ id: string; label: string; points: Array<{ t: number; v: number }> }>; throughput: LoadCompareDef['series'];
}
export interface BugActionDef { kind: 'file' | 'update' | 'reopen' | 'resolve'; tag: string; bug?: number; title?: string; from?: string; to?: string; comment?: string; why: string }
export interface PrNewDef { branch: string; repositories: Array<{ id: string; name: string; defaultBranch?: string }>; repository: string | null; target?: string; commits?: number; pushed?: boolean; title?: string; description?: string; workItems?: number[]; reviewers?: Array<{ id: string; name: string; email?: string; team: string }>; problem?: string }
export interface LoadSlaProfileInfo { file: string; name: string; description?: string; slas: number; interval?: number; error?: string }
/** Where the time of the HTTP exchanges went (average milliseconds per phase). */
export interface LoadPhases { blocked: number; dns: number; connect: number; tls: number; send: number; wait: number; download: number }
export type DbCell = null | number | boolean | string | { $t: 'date' | 'big' | 'json'; v: string } | { $t: 'bin' | 'text'; v: string; n: number };
export interface DbColumn { name: string; type: string }
export interface DbConnection { alias: string; type: string; host: string; port: number; database: string; username: string; passwordSet: boolean; trusted: boolean; problems: string[]; readOnlyByConfig: boolean; queryTimeoutMs: number; driver: string | null; driverInstalled: boolean }
export interface DbConnections { projects: string[]; environments: Record<string, string[]>; project?: string; environment?: string; frameworkInstalled?: boolean; protected?: string | null; connections: DbConnection[]; running?: boolean }
export interface DbObject { schema: string; name: string; kind: 'table' | 'view' | 'procedure' | 'function'; rows?: number }
export interface DbColumnInfo { name: string; type: string; nullable: boolean; key: boolean; default?: string }
/** The Studio's MCP server (/mcp) for assistants outside the Studio. */
export interface ToolServerDef { kind: 'stdio' | 'http'; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; tools?: string[]; changes?: boolean; description?: string; from?: string; enabled?: boolean }
export interface ToolInfo { name: string; description: string; schema?: string }
export interface ToolDiff { added: string[]; removed: string[]; changed: string[]; fromServer?: string; toServer?: string; at: string }
export interface ToolServerState { known: ToolInfo[] | null; server: string | null; checkedAt: string | null; ok: boolean | null; error: string | null; diff: ToolDiff | null; session: { status: string; error?: string; toolCount?: number; at: string } | null }
export interface ToolServerTest { ok: boolean; tools: ToolInfo[]; server?: string; error?: string; at: string; diff: ToolDiff | null }
export interface ToolServerCatalogEntry { id: string; title: string; description: string; changes: boolean; fields: Array<{ key: string; label: string; kind: 'text' | 'secret' | 'connection'; placeholder?: string; help?: string; optional?: boolean; choices?: string[] }> }
export interface ToolServerRow { name: string; scope: 'team' | 'personal'; server: ToolServerDef; missing: string[]; allowed: boolean; checking: boolean; state: ToolServerState }
export interface ToolServersView {
    catalog: ToolServerCatalogEntry[];
    servers: ToolServerRow[];
    connections: Array<{ value: string; label: string }>; teamFile: string; policy: boolean | string[] | null;
}
export interface ToolServerImport { servers: Array<{ name: string; server: ToolServerDef; problem: string | null; exists: boolean; secrets: Array<{ secret: string; where: string; fromPaste: boolean; saved: boolean }> }> }
export interface McpSettings { enabled: boolean; url: string; token: string; refusal: string | null }
export interface DbResult { columns: DbColumn[]; rows: DbCell[][]; total: number; truncated: boolean; ms: number; command: string; affected?: number; type: string; kind: 'read' | 'change'; interpolated?: boolean; rolledBack?: boolean }
/** Comparing two query results (see src/db/compare.ts). */
export type DatePrecisionDef = 'exact' | 'second' | 'minute' | 'day';
export interface DbCompareOptions { keys?: string[]; ignore?: string[]; map?: string[]; tolerance?: number; ignoreCase?: boolean; trim?: boolean; dates?: DatePrecisionDef }
export interface DbCompareSide { alias: string; env: string; rows: number; truncated: boolean; ms: number; columns: string[] }
export interface DbCompareResponse {
    result: { passed: boolean; sourceRows: number; targetRows: number; matched: number; missingInTarget: string[]; extraInTarget: string[]; differences: Array<{ key: string; column: string; source: string; target: string }>; rowsDiffering: number; duplicateKeys: { source: string[]; target: string[] }; columnsCompared: string[]; onlyInSource: string[]; onlyInTarget: string[]; truncated: boolean };
    vitals: { passed: boolean; differences: Array<{ check: string; column?: string; source: unknown; target: unknown }>; source: { count: number }; target: { count: number } };
    summary: string; source: DbCompareSide; target: DbCompareSide; stepAvailable: boolean;
}
/** Correlation by replay (see src/load/correlate.ts). */
export interface CorrelationStep { id: string; name: string; status: number; ok: boolean; error?: string; timeMs: number }
export interface CorrelationCandidateDef { from: string; fromName: string; source: 'json' | 'header' | 'cookie'; path: string; variable: string; samples: [string, string]; to: Array<{ request: string; requestName: string; where: 'query' | 'header' | 'json' | 'form' | 'path'; field: string; current: string }> }
/** API mocks (see src/api/mock.ts). */
export type MockFaultKind = 'none' | 'delay' | 'error' | 'drop' | 'malformed';
export interface MockResponseDef { name?: string; when?: { query?: Record<string, string>; headers?: Record<string, string>; body?: string }; status: number; headers?: Record<string, string>; body?: unknown }
export interface MockRouteDef { method: string; path: string; status: number; headers?: Record<string, string>; body?: unknown; delayMs?: number; fault?: { kind: MockFaultKind; rate?: number; delayMs?: number; status?: number; body?: string }; enabled?: boolean; name?: string; responses?: MockResponseDef[]; sequence?: boolean }
export interface MockDef { name: string; port?: number; routes: MockRouteDef[]; fallbackStatus?: number; source?: string }
export interface MockInfo { file: string; name: string; routes: number; problems: string[]; url?: string; startedAt?: string }
export interface MockLogEntryDef { at: string; method: string; path: string; status: number; route?: string; fault?: MockFaultKind; ms: number }
export interface DbSavedQuery { file: string; name: string; connection: string | null; size: number }
export interface DbHistoryItem { at: string; project: string; env: string; alias: string; sql: string; kind: 'read' | 'change'; ok: boolean; rows?: number; affected?: number; ms?: number; error?: string }
export interface DbFeaturePreview { file: string; exists: boolean; text: string; warnings: string[]; current?: string; review?: PlanReviewDef }
export interface PdfFileDef { path: string; size: number; modified: string }
export interface PdfInspectDef { pages: number; fields: Array<{ label: string; value: string; page: number }>; tables: Array<{ name: string; columns: string[]; rows: string[][]; page?: number }>;
    formFields: Array<{ name: string; label: string | null; type: string; value: string }>; lines: Array<{ page: number; text: string }>; linesTotal: number }
export type PdfSourceDef = { kind: 'file'; file: string; sheet?: string } | { kind: 'query'; connection: string; sql: string } | { kind: 'pdf'; file: string } | { kind: 'values'; rows: string[][] };
export interface PdfOptionsDef { tolerance?: number; caseSensitive?: boolean; dayFirst?: boolean; keyColumns?: string[]; extraRows?: boolean; rowOrder?: boolean; ignore?: string[]; pages?: string }
export interface PdfFindingDef { kind: string; where: string; expected?: string; actual?: string; page?: number; note?: string }
export interface PdfCompareDef { passed: boolean; summary: string; counts: Record<string, number>; findings: PdfFindingDef[]; matched: Array<{ where: string; expected: string; actual: string; page?: number; how?: string }>; reportId: string | null; steps: string[]; durationMs: number }
export interface PdfCheckBody { project: string; env?: string; pdf: string; source: PdfSourceDef; key?: string; options?: PdfOptionsDef; password?: string }
export interface DbFeatureChecks { rowCount: 'exact' | 'atLeast' | 'none'; columns: boolean; rows: number; firstRow: boolean }
export type LoadMonitorKind = 'prometheus' | 'json' | 'ssh' | 'perfmon' | 'jolokia' | 'sql';
export interface LoadMonitorDef { name: string; kind: LoadMonitorKind; url: string; metric?: string; path?: string; headers?: ApiKV[]; unit?: string; rate?: boolean; scale?: number; max?: number; warn?: number;
    host?: string; preset?: 'cpu' | 'memory' | 'load' | 'disk'; command?: string; identity?: string; knownHosts?: string; counter?: string; mbean?: string; attribute?: string; innerPath?: string; connection?: string; query?: string }
export interface LoadAlertDef { t: number; level: 'warning' | 'critical' | 'ok'; source: string; message: string }
export interface LoadApmDef { traceparent?: boolean; dynatrace?: boolean; header?: { name: string; value: string } }
export interface LoadMonitorSeries { name: string; unit: string; points: Array<{ t: number; v: number }>; max?: number; warn?: number; error?: string; generator?: boolean }
export interface LoadWanDef { latencyMs?: number; bandwidthKbps?: number; lossPercent?: number }
export interface LoadPopulationDef { name: string; collection?: string; browserPath?: string; requests: string[]; share: number; policy?: LoadPolicyDef; startDelay?: number; stopAfter?: number; wan?: LoadWanDef; logic?: import('./components/LogicEditor').Logic }
export interface LoadScenarioDef { format: 'cs-studio-load/1'; name: string; description?: string; collection: string; browserPath?: string; showBrowsers?: boolean; requests: string[]; mainName?: string; populations?: LoadPopulationDef[]; generators?: LoadGeneratorDef[]; slaProfile?: string; slaInterval?: number; regression?: { p95Percent?: number; avgPercent?: number; errorRatePoints?: number; throughputPercent?: number; steadyOnly?: boolean }; monitors?: LoadMonitorDef[]; monitorEvery?: number; alerting?: { webhook?: string; stopOnCritical?: boolean }; apm?: LoadApmDef; data?: { file?: string; source?: DataSourceDef; mode: 'sequential' | 'random' | 'perUser' | 'unique' }; thinkTime: { min: number; max: number }; pacing: number; policy: LoadPolicyDef; slas: LoadSla[]; stopOnErrorRate?: number; timeout: number; logic?: import('./components/LogicEditor').Logic; iterationsPerUser?: number; wan?: LoadWanDef }
export interface DataSourceDef { kind: 'file' | 'query' | 'procedure' | 'api' | 'generate'; file?: string; sheet?: string; path?: string; xpath?: string; delimiter?: string; connection?: string; sql?: string; procedure?: string; params?: string[]; collection?: string; request?: string; generate?: string; filter?: string; limit?: number; randomize?: boolean }
export interface DataPreview { columns: string[]; rows: Array<Record<string, string>>; total: number; readOnly?: string }
export type RecCheckKind = 'visible' | 'text' | 'contains' | 'value' | 'checked' | 'url' | 'title' | 'hidden' | 'enabled' | 'disabled' | 'attribute' | 'count' | 'cell' | 'compare' | 'column' | 'wait';
/** A dialog of the recorded page (alert, confirm, prompt) waiting for the tester's answer. */
export interface RecDialog { type: string; message: string; defaultValue: string }
export interface RecProposal { kind: RecCheckKind; code: string; expected: string; label: string; password?: boolean; attribute?: string; attributes?: Array<{ name: string; value: string }>; /** compare: names remembered so far. */ remembered?: string[]; op?: string; name?: string; plus?: number; /** column: its values now and its header. */ values?: string[]; column?: string; reload?: boolean; seconds?: number }
/** What an action in the recording window needs from the Studio (a list to choose in, files, a dialog's answer). */
export interface RecWindowUi { seq: number; select?: { options: Array<{ value: string; label: string; selected: boolean }>; multiple: boolean; label: string }; file?: { label: string; multiple: boolean }; dialog?: RecDialog | null; note?: string }
export interface RecordingInfo { id: string; url: string; state: 'recording' | 'finished' | 'failed'; startedAt: string; endedAt?: string; error?: string; testIdAttribute: string; script?: string; warnings?: string[]; engine?: 'studio' | 'playwright'; /** Recorded in a browser window on this computer. */ window?: boolean; /** Its details could not be saved. */ saveProblem?: string; /** The name it was saved under, and the feature written. */ name?: string; savedAs?: string }
export type RecValueMode = 'data' | 'fixed' | 'secret' | 'unique' | 'date';
/** A check the recorder suggests from what the last action changed on the page. */
export interface RecSuggestion { kind: RecCheckKind; code: string; expected: string; label: string; why: string }
/** Recording from a step: the steps up to it done again in the browser first. */
export interface RecReplay { done: number; total: number; after: number; error?: string; finished: boolean }
export interface RecSuggestions { seq: number; after: string; items: RecSuggestion[] }
/** A framework locator of a recorded element, graded by the framework's locator linter. */
export interface RecLocator { key: 'testId' | 'id' | 'name' | 'role' | 'text' | 'placeholder'; value: string; score: number; tier?: string; reasons?: string[] }
export interface RecRow { /** The recorded script's line of this step (1-based). */ scriptLine?: number; index: number; kind: string; page: string; pageExisting: boolean; element?: string; elementKey?: string; elementReused?: boolean; locators?: RecLocator[]; locator?: { key: RecLocator['key']; value: string }; line: string; stepReused: boolean; value?: string; mode?: RecValueMode; column?: string; sensitive?: boolean; testData?: string; signIn?: boolean; remembered?: string; date?: { when: string; format: string }; dateLike?: boolean; selector?: string; frames: string[]; /** Part of a reusable step (its text). */ block?: string }
export interface RecFile { path: string; text: string; kind: 'feature' | 'data' | 'page' | 'steps' | 'config' | 'other'; change: 'new' | 'update' }
export interface RecPreview { rows: RecRow[]; files: RecFile[]; pages: Array<{ name: string; className: string; existing: boolean; file: string }>; existingPages: string[]; secrets: string[]; warnings: string[]; summary: { stepsReused: number; stepsNew: number; elementsReused: number; elementsNew: number }; folders: { featureFolder: string; stepsFolder: string; pagesFolder: string; dataFolder: string }; review?: PlanReviewDef }
/** The recording's test data: a new file in a format, or one of the project's data files. */
export interface RecDataChoice { format?: 'json' | 'csv' | 'excel'; file?: string; sheet?: string; path?: string; filter?: string }
export interface RecDataFileInfo { columns: string[]; rows: number; sheets: string[]; format: 'json' | 'csv' | 'excel' | 'xml'; readOnly: boolean }
export interface RecGenerateRequest { project: string; env?: string; name: string; script: string; breaks: Record<number, string>; labels: Record<string, string>; /** The locator chosen for an element (element key → one of its locators). */ locators?: Record<string, { key: RecLocator['key']; value: string }>; values: Record<number, { mode?: RecValueMode; column?: string; when?: string; format?: string }>; secretMode: 'encrypted' | 'studio'; testIdAttribute?: string; data?: RecDataChoice; /** The steps up to this check (action index) sign in. */ signIn?: { marker: number }; /** Steps done only when their element is shown (action indexes). */ optional?: number[]; /** Reusable steps: the steps of actions from..to as one step (its text: {string} per value). */ blocks?: Array<{ from: number; to: number; name: string; text?: string }>; baseHashes?: Record<string, string | null>; force?: boolean; /** The in-Studio recording whose uploaded files are copied to the data folder on save. */ recording?: string }
export interface AgentSettingsDef { provider: 'copilot' | 'custom'; model: string; reasoningEffort?: 'low' | 'medium' | 'high'; custom?: { type: 'openai' | 'azure' | 'anthropic'; baseUrl: string; wireApi?: 'completions' | 'responses'; azureApiVersion?: string }; approvals: { files: 'ask' | 'auto' | 'deny'; shell: 'ask' | 'auto' | 'deny'; mcp: 'ask' | 'auto' | 'deny'; studio: 'ask' | 'auto' | 'deny'; urls: 'ask' | 'auto' | 'deny' } }
export interface AgentPolicyDef { file: string; enabled?: boolean; providers?: string[]; models?: string[]; customEndpoints?: string[]; approvals?: Partial<Record<keyof AgentSettingsDef['approvals'], 'ask' | 'deny'>>; blockedTools?: string[]; blockedAreas?: string[]; allowedHosts?: string[]; note?: string }
export interface AgentRuntimeDef { installed: boolean; problem?: string; version: string | null; source: 'repository' | 'studio' | 'package' | null; studioVersion: string | null; folder: string; tested: string; pinned: string | null; install: { running: boolean; target?: string; startedAt?: number; finishedAt?: number; ok?: boolean; error?: string; log: string[] } }
export type SignInStep =
    | { kind: 'open-url'; url: string } | { kind: 'device-code'; userCode: string; verificationUri: string; expiresAt: number }
    | { kind: 'input-required'; prompt: string } | { kind: 'waiting' }
    | { kind: 'choose-account'; accounts: Array<{ selectionId: string; host: string; login: string }> } | { kind: 'store-consent'; text: string }
    | { kind: 'done'; login?: string; host?: string } | { kind: 'error'; message: string } | { kind: 'cancelled' };
export interface SignInStateDef { active: boolean; provider?: 'githubDotCom' | 'proxima'; method?: 'web' | 'device-code'; step?: SignInStep }
export interface AgentQuotaDef { unlimited: boolean; entitlement: number; used: number; remainingPercent: number; overage: number; resetDate?: string }
export interface AgentStatus { sdk: { installed: boolean; version?: string; source?: string }; runtime?: AgentRuntimeDef; signIn?: SignInStateDef; settings: AgentSettingsDef; effective?: AgentSettingsDef; policy?: AgentPolicyDef | null; policyProblems?: string[]; providerKeySet: boolean; copilotTokenSet: boolean; browser: { running: boolean }; auth?: { isAuthenticated?: boolean; login?: string; host?: string; authType?: string; statusMessage?: string; tokenFromStudio?: boolean }; models?: Array<{ id: string; name: string; multiplier?: number; enabled?: boolean }>; quota?: Record<string, AgentQuotaDef>; accounts?: Array<{ selectionId: string; login: string; host: string; active: boolean }>; error?: string }
export interface AgentUsage { calls: number; inputTokens: number; outputTokens: number; cost: number; model?: string }
export interface AgentSessionInfo { id: string; title: string; createdAt: string; workflow?: string; model: string; active: boolean; busy: boolean; changes: number; usage: AgentUsage; agent?: { id: string; name: string } }
export interface AgentChange { path: string; state: 'new' | 'modified' | 'deleted' | 'unchanged' | 'gone'; staged: boolean }
export type AgentEventDef = { seq: number; at: number } & (
    | { type: 'user'; text: string; context?: string } | { type: 'delta'; text: string } | { type: 'assistant'; text: string } | { type: 'reasoning'; text: string }
    | { type: 'tool-start'; id: string; tool: string; args: string; server?: string } | { type: 'tool-end'; id: string; ok: boolean; result: string }
    | { type: 'approval'; id: string; title: string; detail: string; kind: string } | { type: 'approval-done'; id: string; decision: string }
    | { type: 'error'; text: string } | { type: 'idle' } | { type: 'info'; text: string });
export interface BrowserFrame { running: boolean; actor: 'agent' | 'person' | null; frame: { data: string; seq: number; url: string; width: number; height: number; at: number } | null }
export interface BrowserPathInfo { project: string; file: string; name: string; startUrl: string; actions: number }
export interface BrowserActionDef { type: string; selector?: string; value?: string; url?: string; description?: string; key?: string; expectedValue?: string; semanticOverride?: string; element?: { text?: string }; thenActions?: BrowserActionDef[]; elseActions?: BrowserActionDef[] }
export interface BrowserPathDef { format: 'cs-studio-browser-path/1'; name: string; startUrl: string; signIn: BrowserActionDef[]; actions: BrowserActionDef[]; browser: 'chromium' | 'firefox' | 'webkit' }
export interface LoadSecond { t: number; users: number; requests: number; errors: number; avg: number; p95: number }
export interface LoadTx { id: string; name: string; count: number; errors: number; errorRate: number; avg: number; min: number; max: number; p50: number; p90: number; p95: number; p99: number; throughput: number; phases?: LoadPhases; phaseCount?: number; topErrors: Array<{ message: string; count: number; samples: LoadErrorSample[] }> }
export interface LoadErrorSample { t: number; user?: number; request?: { method: string; url: string; headers: Record<string, string>; body?: string }; response?: { status: number; statusText?: string; timeMs: number; headers: Record<string, string>; body?: string }; page?: string }
export interface LoadTxSecond { t: number; n: number; e: number; avg: number; p95: number }
export interface LoadTotal { count: number; errors: number; errorRate: number; avg: number; p50: number; p90: number; p95: number; p99: number; max: number; throughput: number }
export interface LoadSnapshot { state: string; elapsed: number; users: number; requests: number; errors: number; iterations: number; /** Arrival rate: iterations due when every user was busy. */ dropped?: number; /** Arrival rate: iterations that came due. */ due?: number; /** The load generator was the bottleneck. */ overload?: string; timeline: LoadSecond[]; transactions: LoadTx[]; txTimeline?: Record<string, LoadTxSecond[]>; populations?: Array<{ name: string; share: number; users: number }>; monitors?: LoadMonitorSeries[]; alerts?: LoadAlertDef[]; total: LoadTotal }
export interface LoadResult extends LoadSnapshot { startedAt: string; endedAt: string; stopReason: 'completed' | 'stopped' | 'error-rate' | 'data-used' | 'alert'; slas: Array<{ sla: LoadSla; name: string; pass: boolean; details: string[]; level?: 'pass' | 'warning' | 'fail'; intervals?: Array<{ t0: number; t1: number; level: 'warning' | 'fail'; details: string[] }> }>; passed: boolean }
export interface LoadRunInfoDef { id: string; scenario: string; name: string; project: string; env: string; startedAt: string; state: 'running' | 'stopping' | 'finished' | 'error'; maxUsers: number; duration: number; message?: string; passed?: boolean; stopReason?: string; loadFactor?: number; baseline?: boolean; summary?: { requests: number; errorRate: number; avg: number; p95: number; throughput: number } }
export interface LoadGeneratorDef { name: string; url: string; zone?: string; token: string }
export interface LoadGeneratorHealth { name: string; zone?: string; url: string; state: string; users?: number; requests?: number; errors?: number; cpu?: number; memory?: number; error?: string; lastSeen?: string }
export interface LoadRunDetailDef extends LoadRunInfoDef { live?: LoadSnapshot; result?: LoadResult; definition: LoadScenarioDef; generators?: LoadGeneratorHealth[] }

export interface RunRequest { project: string; env: string; features?: string[]; tags?: string; scenario?: string; scenarios?: string[]; headless?: boolean; browser?: string; workers?: number;
    retries?: number; device?: string; viewport?: { width: number; height: number }; variables?: Record<string, string>;
    /** Send results to Azure DevOps for this run; not set: as the project is configured. */
    ado?: boolean;
    /** A debug run: pause before each step and/or on a failure, browser shown, one scenario at a time. */
    debug?: { steps?: boolean; pauseOnFailure?: boolean; slowMo?: number; exceptions?: boolean } }
export interface DebugPause { kind: 'before-step' | 'after-failure'; step: string; scenario?: string; error?: string; file?: string; line?: number; reason?: 'breakpoint' | 'step' }
export interface CodeFrame { index: number; name: string; file?: string; line?: number; external: boolean }
export interface CodePause { seq: number; reason: string; frames: CodeFrame[]; exception?: string }
/** A debug run's state as it changes: where it is paused (a feature step, a code line with its top frame's variables), or running. */
export interface DebugState { paused: DebugPause | null; codePaused: CodePause | null; scopes?: DebugScope[] }
export interface DebugVariable { name: string; value: string; type: string; objectId?: string }
export interface DebugScope { name: string; variables: DebugVariable[] }
export interface Breakpoint { file: string; line: number }
export interface CatalogScenario { name: string; line: number; tags: string[]; outline: boolean; examples: number }
export interface CatalogFeature { path: string; name: string; tags: string[]; scenarios: CatalogScenario[]; /** The framework cannot parse it: it is left out of runs. */ parseError?: string }
export interface RunCatalog { features: CatalogFeature[]; projectFolders: Record<string, string | null> }
export interface ScenarioResult { name: string; feature: string; status: string; duration: number; error?: string; /** Failed attempts before the final one (the framework retried it). */ retries?: number; /** Passed only after a retry. */ flaky?: boolean }
export interface RunSummary { total: number; passed: number; failed: number; skipped: number; duration: number; scenarios: ScenarioResult[]; hasHtml: boolean; /** Scenarios that passed only after a retry. */ flaky?: number; /** Scenarios that ran but are not in the framework report. */ missing?: Array<{ name: string; status: string; retries: number }> }
export type QualityClass = 'new-failure' | 'failing' | 'flaky' | 'fixed' | 'stable' | 'skipped';
export interface QualityRun { id: string; at: string; source: 'studio' | 'report'; project?: string; env?: string; total: number; passed: number; failed: number; skipped: number; flaky: number; passRate: number; reportDir?: string }
export interface QualityResult { run: string; at: string; status: 'passed' | 'failed' | 'skipped'; retries: number; error?: string; duration: number; signature?: string }
export interface QualityScenario { key: string; name: string; feature: string; file?: string; line?: number; quarantined: boolean; note?: { at: string; reason: string }; cls: QualityClass; results: QualityResult[]; passRate: number; failingFor: number; retriedPasses: number; flips: number; lastFailure?: string; lastPass?: string; avgDuration: number; lastRun: string; project?: string; env?: string }
export type FailureCategory = 'timeout' | 'element' | 'assertion' | 'api' | 'database' | 'step' | 'script' | 'other';
export type TriageVerdict = 'product-bug' | 'test-issue' | 'environment' | 'flaky' | 'expected';
export interface TriageEntry { signature: string; verdict?: TriageVerdict; note?: string; bug?: number; by?: string; at: string }
export interface TriageBug { id: number; title: string; state: string; type: string; tags: string[]; changed: string; resolved?: string; url: string }
export interface PlanContext {
    project: string; folder: string; features: string[]; seed: string | null;
    story?: { id: number; type: string; title: string; state: string; url: string; description: string; acceptanceCriteria: string };
    storyError?: string;
}
export interface PlanStep { line: number; keyword: string; text: string; status: 'reused' | 'new' | 'not-loaded' | 'no-examples'; def?: { pattern: string; file: string; line: number; builtIn: boolean }; closest?: string }
export interface PlanCoverage {
    feature: string; background: PlanStep[];
    scenarios: Array<{ line: number; name: string; outline: boolean; examples: number; tags: string[]; steps: PlanStep[] }>;
    counts: { scenarios: number; steps: number; reused: number; new: number; notLoaded: number };
}
export interface FailureGroup { signature: string; category: FailureCategory; sample: string; failures: number; runs: number; inLatest: boolean; firstSeen: string; lastSeen: string; scenarios: Array<{ key: string; name: string; feature: string }>; tag: string; triage?: TriageEntry }
export interface GateSettings { minPassRate: number; noNewFailures: boolean; maxFlaky: number | null; ignoreQuarantined: boolean }
export interface QualityReport {
    runs: QualityRun[]; scenarios: QualityScenario[]; groups: FailureGroup[];
    gate: { ok: boolean; run: string | null; rules: Array<{ name: string; ok: boolean; detail: string }> };
    counts: Record<QualityClass | 'quarantined', number>;
    projects: string[]; project: string | null; settings: GateSettings;
    quarantine: { excludeTags: string; from: string; skipsQuarantined: boolean; frameworkSupports: boolean | null };
}
export type HealStatus = 'review' | 'applied' | 'confirmed' | 'dismissed';
export interface HealEvent { run: string; at: string; scenario: string; feature: string; step: string; element: string; pageClass?: string; property?: string; original: string; healed: string; strategy: string; confidence: number }
export type VisualStatus = 'new' | 'changed' | 'cosmetic' | 'same';
type Box = { x: number; y: number; width: number; height: number };
export interface VisualSnapshot {
    dir: string; name: string; key: string; status: VisualStatus;
    verdict?: string; message?: string; passed?: boolean; at?: string; scenario?: string; feature?: string; region?: boolean;
    pixels?: { percent: number; changed?: number; total?: number; area?: Box | null; sizeChanged?: boolean };
    ariaChanges: string[]; layoutChanges: Array<{ element: string; type: string; before?: Box; after?: Box }>;
    files: { baseline: string | null; actual: string | null; diff: string | null };
    reviewed?: { action: 'approved' | 'accepted'; at: string };
    baselineSha: string; actualSha: string | null;
}
export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }
export interface AriaSnapshotInfo { dir: string; name: string; key: string; status: 'changed' | 'same'; baseline: string; actual: string | null; actualSha?: string; diff?: DiffLine[]; at?: string }
export interface A11yViolation { id: string; impact: string; description: string; element?: string; help?: string; helpUrl?: string }
export interface A11yCheck { url: string; scenario?: string; feature?: string; at: string; run: string; passed: boolean; violations: A11yViolation[]; passes?: number }
export interface HealGroup { key: string; element: string; pageClass?: string; property?: string; original: string; healed: string; variants: Array<{ healed: string; count: number }>; strategy: string; confidence: number; count: number; runs: number; firstSeen: string; lastSeen: string; scenarios: Array<{ name: string; feature: string; project?: string; env?: string }>; status: HealStatus; decidedAt?: string; events: HealEvent[] }
export interface HealPreview { file: string; baseHash: string; line: number; before: string; after: string; option: { key: string; value: string } }
export interface TestPlanDef { id: number; name: string; state: string; rootSuite: number; iteration?: string; areaPath?: string; owner?: string; web: string }
export interface TestSuiteDef { id: number; name: string; type: string; parent: number | null; requirementId?: number; query?: string }
export type TargetFrom = 'scenario' | 'feature' | 'config';
export interface RepoScenario { file: string; line: number; name: string; feature: string; testCases: number[]; plan?: number; suite?: number; planFrom?: TargetFrom; suiteFrom?: TargetFrom }
export interface TestPointDef { id: number; testCase: number; title: string; state?: string; configuration: string; tester?: string; outcome: string; lastRun?: string; lastRunBy?: string; runId?: number; isAutomated: boolean; active: boolean; scenarios: Array<RepoScenario & { status: 'here' | 'elsewhere' | 'unpublished' }>; automationStatus?: string; automatedTestName?: string }
export interface AdoPublishing { project: string; env: string; enabled: boolean; plan: number | null; suite: number | null;
    /** ADO_TEST_CONFIGURATION; whether the installed framework combines several scenarios' results and chooses configurations. */
    configuration: string; combines: boolean; chooses: boolean }
export interface AdoScope { adoProject?: string; project?: string; env?: string }
export interface RunInfo { id: string; request: RunRequest; workdir?: string; pr?: { id: number; repository: string; title: string; commit: string; based: 'merge' | 'source'; selection?: RunSelection }; command: string[]; state: 'running' | 'passed' | 'failed' | 'stopped' | 'error'; startedAt: string; endedAt?: string; exitCode?: number | null; summary?: RunSummary; message?: string; secretNames: string[]; reportKey?: string; reportIndex?: string | null; paused?: DebugPause | null; codePaused?: CodePause | null; commit?: string; dirty?: boolean; bisect?: { commit: string } }
export interface BisectStep { commit: string; subject: string; outcome: 'pass' | 'fail' | 'skip'; note?: string; run?: string; end?: 'good' | 'bad' }
export interface BisectInfo {
    state: 'running' | 'found' | 'inconclusive' | 'error' | 'stopped'; good: string; bad: string; commits: number; estimate: number; steps: BisectStep[];
    current?: { commit: string; subject: string }; result?: { commit: string; subject: string; author: string; date: string; files: string[] };
    candidates?: Array<{ commit: string; subject: string }>; message?: string; startedAt: string; endedAt?: string; feature: string; scenario: string; project: string; env: string;
}
export interface TeamTrendTest { name: string; container: string; total: number; passed: number; failed: number; flaky: number; notExecuted: number; failRate: number; avgSec: number; lastFailed?: string; kind: 'failing' | 'flaky' | 'stable' }
export interface TeamTrends {
    from: string; to: string; days: Array<{ date: string; total: number; passed: number; failed: number; notExecuted: number; flaky: number; passRate: number | null; durationSec: number }>;
    totals: { total: number; passed: number; failed: number; flaky: number; notExecuted: number; passRate: number | null }; previous: { passRate: number | null; total: number };
    tests: TeamTrendTest[]; status: 'green' | 'amber' | 'red' | 'none'; summary: string; options: { pipelines: string[]; branches: string[] };
}
export interface EvidenceFile { kind: 'screenshot' | 'video' | 'trace' | 'console' | 'har'; file: string; name: string; time?: string; size: number }
export interface PipelineDef { id: number; name: string; folder: string }
export interface PipelineRun { id: number; number: string; pipeline: { id: number; name: string }; status: string; result?: string; branch: string; reason: string; requestedFor?: string; queued?: string; started?: string; finished?: string; url: string }
export interface TimelineNode { id: string; parentId: string | null; type: string; name: string; state: string; result?: string; started?: string; finished?: string; errors: number; warnings: number; logId?: number; issues: Array<{ type: string; message: string }>; order: number }
export interface StageSummary { id: string; identifier?: string; name: string; state: string; result?: string; order: number; attempt: number; retried: boolean; started?: string; finished?: string; waiting: boolean; errors: number }
export interface RunArtifactInfo { name: string; type: string; size?: number; job?: string; stage?: string; candidate: boolean }
export interface PublishedTestRun { id: number; name: string; state: string; total: number; passed: number; failed: number; notExecuted: number; started?: string; completed?: string; url: string; stage?: string; job?: string }
export interface PublishedTestResult { id: number; title: string; automatedTestName?: string; outcome: string; durationMs?: number; errorMessage?: string; stackTrace?: string; testCaseId?: number; priority?: number }
export interface PipelineRunDetail { run: PipelineRun; stages: StageSummary[]; timeline: TimelineNode[]; artifacts: RunArtifactInfo[]; publishedTestRuns: PublishedTestRun[]; publishedTestRunsError?: string }
export interface PipelineResults {
    run: PipelineRun; looked: string[]; others: string[]; errors: Array<{ artifact: string; message: string }>;
    projects: Array<{ name: string; artifact: string; stage?: string; job?: string; base: string; scenarios: ScenarioEvidence[]; run: EvidenceFile[]; reportIndex: string | null; alsoIn?: string[] }>;
}
export interface PrPerson { id: string; name: string }
export interface PrReviewer extends PrPerson { vote: number; required: boolean; isMe?: boolean }
export interface PrSummary {
    id: number; title: string; repository: { id: string; name: string }; source: string; target: string; author: PrPerson; created: string;
    isDraft: boolean; status: string; mergeStatus?: string; reviewers: PrReviewer[]; myVote?: number; url: string; local?: boolean; autoComplete?: boolean;
}
export interface PrRepo { id: string; name: string; defaultBranch?: string; here: boolean }
export interface PrGlance { files: number; counts: Record<'feature' | 'steps' | 'code' | 'config' | 'data' | 'other', number>; here: boolean; workItems: number; testCases: number; automatedHere?: number }
export interface PrThread { id: number; status: string; file?: string; line?: number; comments: Array<{ author: string; content: string; date?: string; system: boolean }> }
export interface PrCheckoutInfo { dir: string; rel: string; commit: string; based?: 'merge' | 'source'; reused?: boolean; copiedConfig?: string[]; notes?: string[] }
export interface PrDetail extends Omit<PrSummary, 'local'> {
    description: string; commits: { source?: string; target?: string; merge?: string }; iterations: number;
    changes: Array<{ path: string; changeType: string; originalPath?: string }>; workItems: number[]; threads: PrThread[];
    policies: Array<{ name: string; status: string; blocking: boolean; detail?: string; buildId?: number }>; statuses: Array<{ name: string; state: string; description?: string; url?: string }>;
    workItemDetails: WorkItemSummary[]; testCaseIds: number[];
    local: { canTest: boolean; remote: string | null; checkout: PrCheckoutInfo | null };
    runs: Array<RunInfo & { check?: SelectionCheck | null }>;
}
export type ImpactLevel = 'direct' | 'code' | 'data' | 'coverage' | 'steps' | 'recent';
export interface PrImpactFeature { path: string; name: string; project?: string; reasons: string[]; scenarios: string[]; total: number; level: ImpactLevel }
export interface RunSelection { features: Array<{ path: string; name: string; scenarios: string[] }>; observe: boolean }
export interface SelectionCheck { selected: number; failed: number; missed: Array<{ scenario: string; feature: string }> }
export interface PrStatus { state: 'succeeded' | 'failed' | 'error' | 'pending'; description: string }
export interface PrImpact { features: PrImpactFeature[]; fullSuite: string[]; other: string[]; testCases: Array<{ id: number; scenarios: Array<{ file: string; name: string }> }>; deletedFeatures: string[] }
export interface ScenarioRef { file: string; line: number; name: string }
export interface WorkItemSummary { id: number; title: string; type: string; state: string; assignedTo?: string; iteration?: string; area?: string; priority?: number; tags: string[]; changed?: string; automationStatus?: string; url: string; automatedIn?: ScenarioRef[] }
export interface WorkItemList { items: WorkItemSummary[]; sprint?: { name: string; path: string } | null; team?: string; project: string; env: string; capped: boolean }
export interface Sprint { name: string; path: string; start?: string; finish?: string; timeFrame?: 'past' | 'current' | 'future' }
export interface ItemType { name: string; states: Array<{ name: string; category: string; color?: string }> }
export interface BoardsMeta { teams: string[]; types: ItemType[]; defaultTeam?: string; adoProject: string; project: string; env: string }
export interface TeamMeta { team: string; sprints: Sprint[]; current?: Sprint; areas: Array<{ path: string; children: boolean }> }
export interface ItemFilter { team?: string; sprint?: string; areas?: string[]; types?: string[]; states?: string[]; open?: boolean; assigned?: string; tags?: string[]; text?: string; changedDays?: number; order?: 'changed' | 'priority' | 'id' }
export interface ItemQueryResult { total: number; capped: boolean; doneMatches?: number; items: WorkItemSummary[]; sprint?: Sprint; adoProject: string }
export interface WorkItemDetail extends WorkItemSummary { rev?: number; assignedToEmail?: string;
    description?: string; acceptanceCriteria?: string; reproSteps?: string;
    steps?: Array<{ action: string; expected: string; shared?: { id: number; title: string } }>; parameters?: { names: string[]; rows: Array<Record<string, string>>; sharedSet?: { id: number; title?: string } }; automatedTestName?: string;
    related: Array<{ kind: string; id?: number; item: WorkItemSummary | null }>;
    scenario?: string; branchName: string;
}
export interface StepAction { kind: 'pass' | 'fail' | 'info' | 'warn'; text: string; durationMs?: number; time?: string }
export interface StepDetail { text: string; status: string; durationMs?: number; error?: string; screenshot?: EvidenceFile; actions: StepAction[] }
export interface ScenarioEvidence {
    index: number; name: string; feature: string; status: string; durationMs?: number;
    steps: StepDetail[]; location?: { file: string; line: number };
    failedStep?: { name: string; error?: string; screenshot?: EvidenceFile }; files: EvidenceFile[]; matchedByTime: boolean;
}
export interface RunEvidence { resultsRoot: string; reportIndex: string | null; scenarios: ScenarioEvidence[]; run: EvidenceFile[]; hasPlaywright: boolean }
export interface LogLine { n: number; stream: 'out' | 'err' | 'studio'; text: string }

/** Follow a run's output live (newline-delimited JSON over fetch, so the token header is sent). */
export async function followRun(id: string, from: number, onLog: (l: LogLine) => void, onEnd: (r: RunInfo) => void, signal: AbortSignal): Promise<void> {
    const res = await fetch(`/api/runs/${encodeURIComponent(id)}/stream?from=${from}`, { headers: { Authorization: `Bearer ${token}` }, signal });
    if (res.status === 401) tokenRejected(res);
    if (!res.ok || !res.body) throw new ApiError(`Could not follow the run (${res.status})`, res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (!line) continue;
            const ev = JSON.parse(line);
            if (ev.type === 'log') onLog(ev as LogLine); else if (ev.type === 'end') onEnd(ev.run as RunInfo);
        }
    }
}

/** Follow a debug run's pauses live; resolves when the run ends (or the stream closes). */
export async function followDebug(id: string, onState: (s: DebugState) => void, signal: AbortSignal): Promise<void> {
    const res = await fetch(`/api/runs/${encodeURIComponent(id)}/debug/stream`, { headers: { Authorization: `Bearer ${token}` }, signal });
    if (!res.ok || !res.body) throw new ApiError(`Could not follow the debug run (${res.status})`, res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (!line) continue;
            const ev = JSON.parse(line);
            if (ev.type === 'state') onState(ev as DebugState); else if (ev.type === 'end') return;
        }
    }
}

export const api = {
    health: () => request<{ ok: boolean; repoRoot: string; projectId: string }>('GET', '/api/health'),
    status: () => request<RepoStatus>('GET', '/api/git/status'),
    branches: () => request<BranchInfo[]>('GET', '/api/git/branches'),
    log: (limit = 100) => request<LogEntry[]>('GET', '/api/git/log' + q({ limit })),
    diff: (file: string, staged: boolean, o?: DiffOpts) => request<{ diff: string }>('GET', '/api/git/diff' + q({ file, staged, ...dq(o) })),
    stage: (paths: string[]) => request<RepoStatus>('POST', '/api/git/stage', { paths }),
    unstage: (paths: string[]) => request<RepoStatus>('POST', '/api/git/unstage', { paths }),
    commit: (message: string, override?: Override, opts?: { amend?: boolean; allowRewritePushed?: boolean; signoff?: boolean }) => request<GateResult>('POST', '/api/git/commit', { message, override, ...opts }),
    push: (override?: Override, opts?: { forceWithLease?: boolean; tags?: boolean }) => request<GateResult>('POST', '/api/git/push', { override, ...opts }),
    pull: () => request<MergeResult & { mode?: string }>('POST', '/api/git/pull'),
    pullMode: () => request<{ mode: 'merge' | 'rebase' | 'ff-only' }>('GET', '/api/git/pull/mode'),
    commitTemplate: () => request<{ template: string }>('GET', '/api/git/commit-template'),
    cleanPreview: (ignored = false) => request<{ files: string[] }>('GET', '/api/git/clean' + q({ ignored: String(ignored) })),
    clean: (files: string[], ignored = false) => request<{ removed: string[]; recoveryDir?: string }>('POST', '/api/git/clean', { files, ignored }),
    reflog: (limit = 100) => request<Array<{ sha: string; ref: string; date: string; subject: string }>>('GET', '/api/git/reflog' + q({ limit: String(limit) })),
    rebase: (onto: string, todo?: Array<{ sha: string; action: 'pick' | 'reword' | 'squash' | 'fixup' | 'drop'; message?: string }>) => request<MergeResult>('POST', '/api/git/rebase', { onto, todo }),
    commitsSince: (base: string) => request<Array<{ sha: string; subject: string; body: string; merge: boolean }>>('GET', '/api/git/since' + q({ base })),
    blame: (file: string, rev?: string) => request<Array<{ line: number; sha: string; author: string; date: string; summary: string }>>('GET', '/api/git/blame' + q({ file, ...(rev ? { rev } : {}) })),
    remotes: () => request<GitRemote[]>('GET', '/api/git/remotes'),
    remoteChange: (b: { action?: 'add' | 'remove' | 'rename' | 'set-url'; name: string; url?: string; to?: string }) => request<GitRemote[]>('POST', '/api/git/remotes', b),
    submodules: () => request<Array<{ path: string; sha: string; state: 'ok' | 'not-initialized' | 'different-commit' | 'conflict' }>>('GET', '/api/git/submodules'),
    updateSubmodules: () => request<Array<{ path: string; sha: string; state: string }>>('POST', '/api/git/submodules/update'),
    lfs: () => request<{ used: boolean; installed: boolean; missing: string[] }>('GET', '/api/git/lfs'),
    lfsPull: () => request<{ used: boolean; installed: boolean; missing: string[] }>('POST', '/api/git/lfs/pull'),
    conflictWithBase: (file: string) => request<{ ok: boolean }>('POST', '/api/git/conflict/base', { file }),
    trustFolder: () => request<{ ok: boolean }>('POST', '/api/git/trust-folder'),
    fetch: () => request<{ ok: boolean }>('POST', '/api/git/fetch'),
    createBranch: (name: string, from?: string) => request<RepoStatus>('POST', '/api/git/branch', { name, from }),
    switchBranch: (name: string) => request<RepoStatus>('POST', '/api/git/switch', { name }),
    merge: (branch: string, opts?: { noFastForward?: boolean; squash?: boolean; noCommit?: boolean }) => request<MergeResult>('POST', '/api/git/merge', { branch, ...opts }),
    history: (h: HistoryQuery) => request<{ commits: LogCommit[]; graph: GraphRow[]; more: boolean }>('GET', '/api/git/history' + q({ ...h })),
    commitDetails: (rev: string) => request<CommitDetails>('GET', '/api/git/commit' + q({ rev })),
    commitDiff: (rev: string, file: string, o?: DiffOpts) => request<{ diff: string }>('GET', '/api/git/commit/diff' + q({ rev, file, ...dq(o) })),
    compare: (a: string, b: string, threeDot = false) => request<NameStatus[]>('GET', '/api/git/compare' + q({ a, b, threeDot })),
    compareDiff: (a: string, b: string, file: string, threeDot = false, o?: DiffOpts) => request<{ diff: string }>('GET', '/api/git/compare/diff' + q({ a, b, file, threeDot, ...dq(o) })),
    messages: () => request<string[]>('GET', '/api/git/messages'),
    revert: (rev: string) => request<OpResult>('POST', '/api/git/revert', { rev }),
    cherryPick: (revs: string[]) => request<OpResult>('POST', '/api/git/cherry-pick', { revs }),
    continueOp: (override?: Override) => request<GateResult>('POST', '/api/git/operation/continue', { override }),
    abortOp: () => request<RepoStatus>('POST', '/api/git/operation/abort'),
    skipOp: () => request<{ status: 'ok' | 'conflicts' | 'rejected'; message?: string; conflicts?: string[] }>('POST', '/api/git/operation/skip'),
    reset: (rev: string, mode: 'soft' | 'mixed' | 'hard') => request<{ backup: string; uncommittedBackup?: string }>('POST', '/api/git/reset', { rev, mode }),
    backups: () => request<Backup[]>('GET', '/api/git/backups'),
    restoreBackup: (ref: string) => request<RepoStatus>('POST', '/api/git/backups/restore', { ref }),
    discard: (paths: string[]) => request<{ recoveryDir: string }>('POST', '/api/git/discard', { paths }),
    restoreFile: (rev: string, file: string) => request<{ recoveryDir: string }>('POST', '/api/git/restore-file', { rev, file }),
    hunks: (file: string, staged: boolean) => request<{ header: string[]; hunks: Hunk[]; binary: boolean }>('GET', '/api/git/hunks' + q({ file, staged })),
    stageHunks: (file: string, ids: string[], unstage = false) => request<RepoStatus>('POST', '/api/git/hunks', { file, ids, unstage }),
    stageLines: (file: string, id: string, lines: number[], unstage = false) => request<RepoStatus>('POST', '/api/git/lines', { file, id, lines, unstage }),
    intentToAdd: (file: string) => request<RepoStatus>('POST', '/api/git/intent-to-add', { file }),
    removeStaleLock: () => request<{ removed: boolean; message: string }>('POST', '/api/git/lock/remove'),
    stashes: () => request<StashEntry[]>('GET', '/api/git/stash'),
    stashSave: (message: string, includeUntracked: boolean) => request<RepoStatus>('POST', '/api/git/stash', { message, includeUntracked }),
    stashApply: (index: number, pop: boolean, sha?: string) => request<OpResult>('POST', '/api/git/stash/apply', { index, pop, sha }),
    stashDrop: (index: number, sha?: string) => request<{ ok: boolean }>('DELETE', '/api/git/stash' + q({ index, sha })),
    stashFiles: (index: number) => request<NameStatus[]>('GET', '/api/git/stash/files' + q({ index })),
    stashDiff: (index: number, file: string) => request<{ diff: string }>('GET', '/api/git/stash/diff' + q({ index, file })),
    tags: () => request<TagInfo[]>('GET', '/api/git/tags'),
    createTag: (name: string, rev: string, message?: string) => request<TagInfo[]>('POST', '/api/git/tags', { name, rev, message }),
    deleteTag: (name: string, remote: boolean) => request<TagInfo[]>('DELETE', '/api/git/tags' + q({ name, remote })),
    pushTag: (name: string) => request<{ ok: boolean }>('POST', '/api/git/tags/push', { name }),
    deleteBranch: (name: string, force = false) => request<{ status: 'ok' | 'not-merged'; message?: string }>('POST', '/api/git/branch/delete', { name, force }),
    deleteRemoteBranch: (name: string) => request<{ ok: boolean }>('POST', '/api/git/branch/delete-remote', { name }),
    renameBranch: (from: string, to: string) => request<BranchInfo[]>('POST', '/api/git/branch/rename', { from, to }),
    setUpstream: (upstream: string) => request<RepoStatus>('POST', '/api/git/branch/upstream', { upstream }),
    abortMerge: () => request<RepoStatus>('POST', '/api/git/merge/abort'),
    conflict: (file: string) => request<{ base: string | null; ours: string | null; theirs: string | null; working: string | null }>('GET', '/api/git/conflict' + q({ file })),
    resolve: (file: string, choice: 'ours' | 'theirs' | { content: string }) =>
        request<RepoStatus & { resolved?: { deleted: boolean; message?: string } }>('POST', '/api/git/conflict/resolve', typeof choice === 'string' ? { file, choice } : { file, content: choice.content }),
    scanStaged: () => request<{ findings: Finding[]; digest: string }>('GET', '/api/scan/staged'),
    fix: (body: Record<string, unknown>) => request<Record<string, unknown>>('POST', '/api/scan/fix', body),
    secrets: () => request<SecretMeta[]>('GET', '/api/secrets'),
    setSecret: (name: string, value: string, env?: string, scope?: 'all-projects') => request<SecretMeta>('PUT', '/api/secrets', { name, value, env, scope }),
    deleteSecret: (name: string, env?: string, scope?: 'all-projects') => request<{ removed: boolean }>('DELETE', '/api/secrets' + q({ name, env, scope })),
    envDiscover: () => request<Discover>('GET', '/api/env'),
    envResolve: (project: string, env: string) => request<ResolveResult>('GET', '/api/env/resolve' + q({ project, env })),
    envCompare: (project: string, a: string, b: string) =>
        request<{ differences: Array<{ key: string; a?: string; b?: string; aFrom?: string; bFrom?: string }> }>('GET', '/api/env/compare' + q({ project, a, b })),
    envSet: (file: string, key: string, value: string, allowLiteralSecret = false) => request<{ line: number }>('PUT', '/api/env/value', { file, key, value, allowLiteralSecret }),
    envRemove: (file: string, key: string) => request<{ removed: number }>('DELETE', '/api/env/value' + q({ file, key })),
    envSecret: (b: { file: string; key: string; secretName: string; value: string; env?: string }) => request<{ reference: string }>('POST', '/api/env/secret', b),
    envCreate: (project: string, name: string, copyFrom?: string) => request<{ file: string; secretKeys: string[] }>('POST', '/api/env/create', { project, name, copyFrom }),
    pipelineSettings: () => request<{ variableGroup: string }>('GET', '/api/pipeline/settings'),
    setPipelineSettings: (variableGroup: string) => request<{ variableGroup: string }>('PUT', '/api/pipeline/settings', { variableGroup }),
    pipelineSecrets: (project: string, env: string, check: boolean) => request<PipelineSecrets>('GET', '/api/pipeline/secrets' + q({ project, env, check })),
    syncPipelineSecrets: (project: string, env: string, names: string[], confirmHost: string) => request<{ created: boolean; sent: string[]; variableGroup: string }>('POST', '/api/pipeline/secrets/sync', { project, env, names, confirmHost }),
    settings: () => request<StudioSettings>('GET', '/api/settings'),
    saveSettings: (s: Partial<Omit<StudioSettings, 'git'>>) => request<StudioSettings>('PUT', '/api/settings', s),
    networkInfo: () => request<{ system: { proxy?: string; httpsProxy?: string; bypass: string[]; pacUrl?: string; source: string } | null; pacFrom: string | null; pacLoaded: boolean; error: string | null }>('GET', '/api/settings/network/info'),
    setNetworkSecret: (name: string, value: string | null) => request<{ ok: boolean }>('PUT', '/api/settings/network/secret', { name, value }),
    saveNetwork: (n: Partial<NetworkSettings>) => request<StudioSettings>('PUT', '/api/settings/network', n),
    setProxyPassword: (password: string | null) => request<StudioSettings>('PUT', '/api/settings/network/password', { password }),
    readCertificates: (file: string) => request<{ certificates: Array<{ subject: string; issuer: string; validTo: string }> }>('POST', '/api/settings/network/certificates', { file }),
    testNetwork: () => request<ConnectionCheck>('POST', '/api/settings/network/test', {}),
    gitNetwork: () => request<GitNetworkState>('GET', '/api/git/network'),
    previewGitNetwork: (c: GitNetworkChange) => request<{ commands: string[] }>('POST', '/api/git/network/preview', c),
    applyGitNetwork: (c: GitNetworkChange) => request<{ ran: string[]; state: GitNetworkState }>('PUT', '/api/git/network', c),
    testGitNetwork: () => request<GitConnectionCheck>('POST', '/api/git/network/test', {}),
    setGitIdentity: (name: string, email: string, scope: 'repository' | 'global') => request<StudioSettings['git']>('PUT', '/api/settings/git-identity', { name, email, scope }),
    planStep: (path: string, content: string, line: number) => request<StepPlan>('POST', '/api/lang/steps/plan', { path, content, line }),
    createStep: (path: string, content: string, line: number, target: string, targetContent?: string) =>
        request<{ file: string; content: string; line: number; created: boolean; baseHash: string | null; pattern: string; methodName: string }>('POST', '/api/lang/steps/create', { path, content, line, target, targetContent }),
    runEvidence: (id: string) => request<RunEvidence>('GET', `/api/runs/${encodeURIComponent(id)}/evidence`),
    openTrace: (id: string, file: string) => request<{ ok: boolean }>('POST', `/api/runs/${encodeURIComponent(id)}/trace`, { file }),
    workItems: (w: { list: 'mine' | 'sprint' | 'search'; text?: string; type?: string; closed?: boolean; project?: string; env?: string }) =>
        request<WorkItemList>('GET', '/api/ado/workitems' + q({ ...w, closed: w.closed ? 'true' : undefined })),
    workItemEditOptions: (id: number, type: string) => request<{ states: Array<{ name: string; category: string }>; iterations: string[]; areas: string[]; people: Array<{ name: string; email: string }> }>('GET', `/api/ado/workitems/${id}/edit-options` + q({ type })),
    workItemUpdate: (id: number, changes: { state?: string; assignedTo?: string; iteration?: string; area?: string; priority?: number; tags?: string[]; comment?: string }, rev?: number) => request<{ ok: true; rev?: number }>('PATCH', `/api/ado/workitems/${id}`, { changes, ...(rev !== undefined ? { rev } : {}), confirm: true }),
    workItem: (id: number, o: { project?: string; env?: string } = {}) => request<WorkItemDetail>('GET', `/api/ado/workitems/${id}` + q(o)),
    boardsMeta: (adoProject?: string) => request<BoardsMeta>('GET', '/api/ado/boards/meta' + q({ adoProject })),
    boardsTeam: (team: string, adoProject?: string) => request<TeamMeta>('GET', '/api/ado/boards/team' + q({ team, adoProject })),
    boardsAreas: (adoProject?: string) => request<{ areas: string[] }>('GET', '/api/ado/boards/areas' + q({ adoProject })),
    queryWorkItems: (filter: ItemFilter, page: { skip: number; take: number }, adoProject?: string) => request<ItemQueryResult>('POST', '/api/ado/workitems/query', { filter, ...page, adoProject }),
    apiCollections: () => request<{ projects: string[]; environments: Record<string, string[]>; collections: ApiCollectionInfo[] }>('GET', '/api/apiws/collections'),
    apiCollection: (file: string) => request<{ file: string; collection: ApiCollectionDef }>('GET', '/api/apiws/collection' + q({ file })),
    apiSaveCollection: (project: string, collection: ApiCollectionDef, file?: string) => request<{ file: string }>('PUT', '/api/apiws/collection', { project, collection, file }),
    apiDeleteCollection: (file: string) => request<{ ok: true }>('DELETE', '/api/apiws/collection' + q({ file, confirm: 'true' })),
    apiCookies: (project: string, env: string | undefined, collection: string) => request<{ cookies: ApiCookie[] }>('GET', `/api/apiws/cookies?project=${encodeURIComponent(project)}${env ? `&env=${encodeURIComponent(env)}` : ''}&collection=${encodeURIComponent(collection)}`),
    apiClearCookies: (project: string, env: string | undefined, collection: string, name?: string, domain?: string) => request<{ cookies: ApiCookie[] }>('DELETE', `/api/apiws/cookies?project=${encodeURIComponent(project)}${env ? `&env=${encodeURIComponent(env)}` : ''}&collection=${encodeURIComponent(collection)}${name ? `&name=${encodeURIComponent(name)}` : ''}${domain ? `&domain=${encodeURIComponent(domain)}` : ''}`),
    oauthStart: (b: { project: string; env?: string; collection: ApiCollectionDef; auth: ApiAuth }) => request<{ url: string; redirectUri: string }>('POST', '/api/oauth2/start', b),
    oauthDevice: (b: { project: string; env?: string; collection: ApiCollectionDef; auth: ApiAuth }) => request<{ id: string; userCode: string; verificationUri: string; verificationUriComplete?: string; expiresIn: number }>('POST', '/api/oauth2/device', b),
    oauthDeviceStatus: (id: string) => request<{ state: 'waiting' | 'done' | 'failed'; error?: string }>('GET', `/api/oauth2/device/${encodeURIComponent(id)}`),
    oauthStatus: (b: { project: string; env?: string; collection: ApiCollectionDef; auth: ApiAuth }) => request<{ signedIn: boolean; until?: number; refreshable?: boolean }>('POST', '/api/oauth2/status', b),
    oauthForget: (b: { project: string; env?: string; collection: ApiCollectionDef; auth: ApiAuth }) => request<{ ok: boolean }>('POST', '/api/oauth2/forget', b),
    apiSend: (b: { project: string; env?: string; file?: string; collection: ApiCollectionDef; request: ApiRequestDef; saved: Record<string, string>; row?: Record<string, string> }) => request<ApiSendResult>('POST', '/api/apiws/send', b),
    apiImportCollection: (text: string, environment?: string) => request<{ collection: ApiCollectionDef; report: ApiImportReport }>('POST', '/api/apiws/import', { kind: 'collection', text, environment }),
    apiImportCurl: (text: string) => request<{ request: ApiRequestDef; warnings: string[] }>('POST', '/api/apiws/import', { kind: 'curl', text }),
    apiImportHar: (text: string, o: { hosts?: string[]; skipCorrelations?: string[]; name?: string } = {}) => request<{ collection: ApiCollectionDef; report: HarReportDef }>('POST', '/api/apiws/import', { kind: 'har', text, ...o }),
    apiImportWsdl: (b: { text?: string; url?: string }) => request<{ collection: ApiCollectionDef; report: { services: number; operations: number; warnings: string[] } }>('POST', '/api/apiws/import', { kind: 'wsdl', text: b.text ?? '', ...(b.url ? { url: b.url } : {}) }),
    apiImportOther: (text: string) => request<{ collection: ApiCollectionDef; report: { requests: number; folders: number; warnings: string[] }; format: string }>('POST', '/api/apiws/import', { kind: 'other', text }),
    apiImportOpenApi: (text: string) => request<{ collection: ApiCollectionDef; report: { operations: number; folders: number; warnings: string[] } }>('POST', '/api/apiws/import', { kind: 'openapi', text }),
    apiPipeline: (b: { file: string; variableGroup?: string; schedule?: string; branch?: string; save?: boolean }) => request<{ yaml: string; file: string; secretNames: string[]; saved: boolean }>('POST', '/api/apiws/pipeline', b),
    apiMonitors: () => request<{ monitors: ApiMonitorDef[] }>('GET', '/api/apiws/monitors'),
    apiSaveMonitor: (m: Omit<ApiMonitorDef, 'id' | 'last'> & { id?: string }) => request<ApiMonitorDef>('PUT', '/api/apiws/monitors', m),
    apiDeleteMonitor: (id: string) => request<{ ok: boolean }>('DELETE', `/api/apiws/monitors/${encodeURIComponent(id)}`),
    apiRunMonitor: (id: string) => request<ApiRunJob>('POST', `/api/apiws/monitors/${encodeURIComponent(id)}/run`, {}),
    apiSnippet: (b: { project: string; env?: string; collection: ApiCollectionDef; request: ApiRequestDef; saved: Record<string, string>; lang: string; reveal?: boolean }) => request<{ code: string; missing: string[]; masked: boolean; note?: string }>('POST', '/api/apiws/snippet', b),
    apiDocs: (file: string, format: 'html' | 'md') => request<string>('GET', `/api/apiws/docs?file=${encodeURIComponent(file)}&format=${format}`),
    apiDocsWiki: (b: { file: string; path?: string; wiki?: string }) => request<{ url: string; created: boolean; page: string }>('POST', '/api/apiws/docs/wiki', b),
    apiFlow: (collection: ApiCollectionDef) => request<ApiFlow>('POST', '/api/apiws/flow', { collection }),
    apiSuggest: (response: NonNullable<ApiSendResult['response']>, checks: ApiCheck[]) => request<{ suggestions: Array<{ check: ApiCheck; why: string; selected: boolean }> }>('POST', '/api/apiws/suggest', { response, checks }),
    apiRequestHistory: (file: string, id: string) => request<{ changes: ApiRequestChange[] }>('GET', `/api/apiws/request-history?file=${encodeURIComponent(file)}&id=${encodeURIComponent(id)}`),
    apiMe: () => request<{ name: string }>('GET', '/api/apiws/me'),
    apiExport: (collection: ApiCollectionDef) => request<{ collection: Record<string, unknown>; warnings: string[] }>('POST', '/api/apiws/export', { collection }),
    apiHistoryEntry: (id: string) => request<ApiHistoryEntry>('GET', `/api/apiws/history/${encodeURIComponent(id)}`),
    apiHistory: () => request<{ items: ApiHistoryItem[] }>('GET', '/api/apiws/history'),
    apiClearHistory: () => request<{ ok: true }>('DELETE', '/api/apiws/history?confirm=true'),
    apiStartRun: (b: { project: string; env?: string; file?: string; collection: ApiCollectionDef; requests?: string[]; iterations: number; dataFile?: string; data?: DataSourceDef; delayMs: number; stopOnFailure: boolean }) => request<ApiRunJob>('POST', '/api/apiws/runs', b),
    apiRuns: () => request<{ runs: Array<Omit<ApiRunJob, 'steps'>> }>('GET', '/api/apiws/runs'),
    apiRun: (id: string) => request<ApiRunJob>('GET', `/api/apiws/runs/${encodeURIComponent(id)}`),
    apiStopRun: (id: string) => request<{ stopped: boolean }>('POST', `/api/apiws/runs/${encodeURIComponent(id)}/stop`, {}),
    apiRunReport: (id: string) => request<string>('GET', `/api/apiws/runs/${encodeURIComponent(id)}/report`),
    apiRunExport: (id: string, format: 'junit' | 'json') => request<unknown>('GET', `/api/apiws/runs/${encodeURIComponent(id)}/report?format=${format}`).then((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))),
    apiRunCompare: (a: string, b: string) => request<ApiRunComparison>('GET', `/api/apiws/runs/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
    apiRunDelete: (id: string) => request<{ ok: boolean }>('DELETE', `/api/apiws/runs/${encodeURIComponent(id)}`),
    apiFeature: (project: string, collection: ApiCollectionDef, save = false, overwrite = false, apply: { baseHashes?: Record<string, string | null>; force?: boolean; env?: string } = {}) => request<ApiFeaturePreview>('POST', '/api/apiws/feature', { project, collection, save, overwrite, ...apply }),
    loadScenarios: () => request<{ projects: string[]; environments: Record<string, string[]>; scenarios: Array<{ project: string; file: string; name: string; collection: string; users: number; duration: number }>; collections: ApiCollectionInfo[]; browserPaths: BrowserPathInfo[]; running: LoadRunInfoDef | null }>('GET', '/api/load/scenarios'),
    loadBrowserPath: (file: string) => request<{ file: string; path: BrowserPathDef }>('GET', '/api/load/browser-path' + q({ file })),
    loadImportBrowserPaths: (project: string, text: string) => request<{ files: string[] }>('POST', '/api/load/browser-paths/import', { project, text }),
    loadScenario: (file: string) => request<{ file: string; scenario: LoadScenarioDef }>('GET', '/api/load/scenario' + q({ file })),
    loadSaveScenario: (project: string, scenario: LoadScenarioDef, file?: string) => request<{ file: string }>('PUT', '/api/load/scenario', { project, scenario, file }),
    loadDeleteScenario: (file: string) => request<{ ok: true }>('DELETE', '/api/load/scenario' + q({ file, confirm: 'true' })),
    loadSlaProfiles: (project: string) => request<{ profiles: LoadSlaProfileInfo[] }>('GET', '/api/load/sla-profiles' + q({ project })),
    loadSaveSlaProfile: (project: string, profile: { name: string; description?: string; slas: LoadSla[]; interval?: number }, overwrite = false) => request<{ file: string }>('PUT', '/api/load/sla-profile', { project, profile, overwrite }),
    loadStart: (file: string, env?: string) => request<LoadRunInfoDef>('POST', '/api/load/runs', { file, env }),
    loadRuns: () => request<{ runs: LoadRunInfoDef[] }>('GET', '/api/load/runs'),
    loadRun: (id: string) => request<LoadRunDetailDef>('GET', `/api/load/runs/${encodeURIComponent(id)}`),
    loadAdjust: (id: string, factor: number) => request<{ adjusted: boolean; factor: number }>('POST', `/api/load/runs/${encodeURIComponent(id)}/adjust`, { factor }),
    loadRecordStart: (target: string) => request<{ url: string; target: string }>('POST', '/api/load/record/start', { target }),
    loadRecordStatus: () => request<{ url: string | null; target?: string; count?: number }>('GET', '/api/load/record'),
    loadRecordStop: (b: { name?: string; mergeInto?: string }) => request<{ collection: ApiCollectionDef; report: { correlations: unknown[]; warnings: string[]; imported: number }; merge?: { kept: string[]; updated: string[]; added: string[]; missing: string[] }; file?: string }>('POST', '/api/load/record/stop', b),
    loadStop: (id: string) => request<{ stopped: boolean }>('POST', `/api/load/runs/${encodeURIComponent(id)}/stop`, {}),
    /** The run's report (HTML or Excel) as a file to save. */
    loadReport: async (id: string, format: 'html' | 'xlsx' | 'pdf' | 'docx', compareWith: string[] = []) => {
        const url = compareWith.length ? `/api/load/compare/report?ids=${[id, ...compareWith].map(encodeURIComponent).join(',')}&format=${format}` : `/api/load/runs/${encodeURIComponent(id)}/report?format=${format}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) { let m = `Request failed (${res.status})`; try { m = (await res.json()).error ?? m; } catch { /* not JSON */ } throw new ApiError(m, res.status); }
        const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `load-${id}.${format}`;
        return { blob: await res.blob(), name };
    },
    agentStatus: () => request<AgentStatus>('GET', '/api/agents/status'),
    agentSaveSettings: (settings: AgentSettingsDef, keys: { providerKey?: string; copilotToken?: string } = {}) => request<AgentStatus>('PUT', '/api/agents/settings', { settings, ...keys }),
    agentRuntime: () => request<AgentRuntimeDef>('GET', '/api/agents/runtime'),
    agentRuntimeInstall: (version?: string) => request<AgentRuntimeDef>('POST', '/api/agents/runtime/install', version ? { version } : {}),
    agentRuntimeCancel: () => request<{ ok: boolean }>('POST', '/api/agents/runtime/cancel', {}),
    agentRuntimeRemove: () => request<AgentRuntimeDef>('DELETE', '/api/agents/runtime'),
    agentSignIn: () => request<SignInStateDef>('GET', '/api/agents/signin'),
    agentSignInBegin: (provider: 'githubDotCom' | 'proxima', method: 'web' | 'device-code') => request<SignInStateDef>('POST', '/api/agents/signin', { provider, method }),
    agentSignInAnswer: (answer: { input?: string; selectionId?: string; consent?: boolean }) => request<SignInStateDef>('POST', '/api/agents/signin/answer', answer),
    agentSignInCancel: () => request<SignInStateDef>('DELETE', '/api/agents/signin'),
    agentSignOut: (forgetToken = false) => request<{ hasMoreUsers: boolean }>('POST', '/api/agents/signout', { forgetToken }),
    agentSwitchAccount: (selectionId: string) => request<{ ok: boolean }>('POST', '/api/agents/accounts/switch', { selectionId }),
    agentContext: (context: Record<string, unknown>) => request<{ ok: boolean }>('POST', '/api/agents/context', { context }),
    agentSessions: () => request<{ sessions: AgentSessionInfo[] }>('GET', '/api/agents/sessions'),
    agentCreate: (title?: string, workflow?: string, agent?: string) => request<{ id: string; title: string }>('POST', '/api/agents/sessions', { title, workflow, ...(agent ? { agent } : {}) }),
    agentBuilder: () => request<AgentBuilderDef>('GET', '/api/agent-builder'),
    inbox: () => request<{ items: InboxItemDef[] }>('GET', '/api/inbox'),
    inboxAct: (id: string, action: InboxItemDef['actions'][number], text?: string) => request<{ items: InboxItemDef[] }>('POST', '/api/inbox/act', { id, action, ...(text ? { text } : {}) }),
    evals: (agent: string) => request<EvalsDef>('GET', `/api/evals/${encodeURIComponent(agent)}`),
    saveEvals: (agent: string, suite: { cases: EvalCaseDef[] }) => request<{ suite: { cases: EvalCaseDef[] } }>('PUT', `/api/evals/${encodeURIComponent(agent)}`, { suite }),
    runEvals: (agent: string, cases?: string[]) => request<EvalRunSummaryDef>('POST', `/api/evals/${encodeURIComponent(agent)}/run`, cases?.length ? { cases } : {}),
    stopEvals: (agent: string) => request<{ ok: true }>('POST', `/api/evals/${encodeURIComponent(agent)}/stop`, {}),
    evalRun: (agent: string, id: string) => request<EvalRunDef>('GET', `/api/evals/${encodeURIComponent(agent)}/runs/${encodeURIComponent(id)}`),
    saveTeamAgent: (agent: TeamAgentDef, isNew: boolean) => request<AgentBuilderDef & { agent: TeamAgentDef }>('PUT', `/api/agent-builder/${encodeURIComponent(agent.id)}`, { agent, isNew }),
    deleteTeamAgent: (id: string) => request<AgentBuilderDef>('DELETE', `/api/agent-builder/${encodeURIComponent(id)}`, { confirm: true }),
    agentDelete: (id: string) => request<{ ok: boolean }>('DELETE', `/api/agents/sessions/${encodeURIComponent(id)}`),
    agentSend: (id: string, text: string, context?: Record<string, unknown>) => request<{ ok: boolean }>('POST', `/api/agents/sessions/${encodeURIComponent(id)}/messages`, { text, context }),
    agentChanges: (id: string) => request<{ files: AgentChange[] }>('GET', `/api/agents/sessions/${encodeURIComponent(id)}/changes`),
    agentTranscript: (id: string) => request<string>('GET', `/api/agents/sessions/${encodeURIComponent(id)}/transcript`),
    agentEvents: (id: string, after: number) => request<{ events: AgentEventDef[]; busy: boolean; known?: boolean; usage?: AgentUsage; changes?: number }>('GET', `/api/agents/sessions/${encodeURIComponent(id)}/events?after=${after}`),
    agentAbort: (id: string) => request<{ ok: boolean }>('POST', `/api/agents/sessions/${encodeURIComponent(id)}/abort`, {}),
    agentDecide: (id: string, approvalId: string, decision: 'once' | 'session' | 'reject') => request<{ ok: boolean }>('POST', `/api/agents/sessions/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}`, { decision }),
    browserFrame: (after: number) => request<BrowserFrame>('GET', `/api/agents/browser/frame?after=${after}`),
    browserOpen: (url: string) => request<{ url: string; title: string }>('POST', '/api/agents/browser/open', { url }),
    browserInput: (input: Record<string, unknown>) => request<{ ok: boolean }>('POST', '/api/agents/browser/input', input),
    browserClose: () => request<{ ok: boolean }>('POST', '/api/agents/browser/close', {}),
    browserRecording: () => request<{ script: string; lines: number }>('GET', '/api/agents/browser/recording'),
    recStart: (b: { project: string; env?: string; url?: string; browser?: string; testIdAttribute?: string; device?: string; ignoreHttpsErrors?: boolean; engine?: 'studio' | 'playwright'; window?: boolean }) => request<RecordingInfo>('POST', '/api/recorder/start', b),
    recLive: (id: string, after: number) => request<{ frame: BrowserFrame['frame']; steps: Array<{ index: number; line: string }>; paused: boolean; running: boolean; notes: string[]; dialog?: RecDialog | null; tabs?: Array<{ index: number; url: string; current: boolean }>; suggest?: boolean; suggestions?: RecSuggestions | null; replay?: RecReplay | null; insertAt?: number | null; window?: { picked: { x: number; y: number; seq: number } | null; ui: RecWindowUi | null } }>('GET', `/api/recorder/${encodeURIComponent(id)}/live?after=${after}`),
    recPick: (id: string, mode: string | null) => request<{ mode: string | null }>('POST', `/api/recorder/${encodeURIComponent(id)}/pick`, { mode }),
    recInput: (id: string, input: Record<string, unknown>) => request<{ step?: string; note?: string; select?: { options: Array<{ value: string; label: string; selected: boolean }>; multiple: boolean; label: string }; file?: { label: string; multiple: boolean }; dialog?: RecDialog | null }>('POST', `/api/recorder/${encodeURIComponent(id)}/input`, input),
    recDialog: (id: string, action: 'accept' | 'dismiss', text?: string) => request<{ step: string }>('POST', `/api/recorder/${encodeURIComponent(id)}/dialog`, { action, text }),
    recCloseTab: (id: string) => request<{ step: string }>('POST', `/api/recorder/${encodeURIComponent(id)}/close-tab`, {}),
    recTab: (id: string, index: number) => request<{ step: string }>('POST', `/api/recorder/${encodeURIComponent(id)}/tab`, { index }),
    recData: (id: string, value: string, binding: { name: string; column: string; mode: 'run' | 'copy' | 'file'; source: DataSourceDef }, check = false) => request<{ step: string }>('POST', `/api/recorder/${encodeURIComponent(id)}/data`, { value, binding, check }),
    recRemember: (id: string, code: string, name: string, pattern?: string) => request<{ step: string; value: string }>('POST', `/api/recorder/${encodeURIComponent(id)}/remember`, { code, name, pattern }),
    recUpload: (id: string, files: Array<{ name: string; data: string }>) => request<{ step: string }>('POST', `/api/recorder/${encodeURIComponent(id)}/upload`, { files }),
    recHover: (id: string, x: number, y: number) => request<{ hit: { box: { x: number; y: number; width: number; height: number } | null; code: string; label: string } | null }>('POST', `/api/recorder/${encodeURIComponent(id)}/hover`, { x, y }),
    recSelect: (id: string, values: string[]) => request<{ step: string }>('POST', `/api/recorder/${encodeURIComponent(id)}/select`, { values }),
    recPropose: (id: string, kind: RecCheckKind, x?: number, y?: number) => request<RecProposal>('POST', `/api/recorder/${encodeURIComponent(id)}/propose`, { kind, x, y }),
    recConfirm: (id: string, kind: RecCheckKind, code: string, expected: string, attribute?: string, more: { op?: string; name?: string; plus?: number; column?: string; reload?: boolean; seconds?: number } = {}) => request<{ step: string }>('POST', `/api/recorder/${encodeURIComponent(id)}/confirm`, { kind, code, expected, attribute, ...more }),
    recSuggest: (id: string, o: { on?: boolean; dismiss?: RecSuggestion }) => request<{ suggest: boolean; suggestions: RecSuggestions | null }>('POST', `/api/recorder/${encodeURIComponent(id)}/suggest`, { ...(o.on !== undefined ? { on: o.on } : {}), ...(o.dismiss ? { dismiss: { kind: o.dismiss.kind, code: o.dismiss.code, expected: o.dismiss.expected } } : {}) }),
    recContinue: (id: string, b: { project: string; env?: string; at: number; ignoreHttpsErrors?: boolean }) => request<RecordingInfo>('POST', `/api/recorder/${encodeURIComponent(id)}/continue`, b),
    recPause: (id: string, paused: boolean) => request<{ paused: boolean }>('POST', `/api/recorder/${encodeURIComponent(id)}/pause`, { paused }),
    recRemoveStep: (id: string, index: number) => request<{ steps: Array<{ index: number; line: string }> }>('DELETE', `/api/recorder/${encodeURIComponent(id)}/steps/${index}`),
    recUpdate: (id: string, u: { script?: string; name?: string }) => request<RecordingInfo>('PUT', `/api/recorder/${encodeURIComponent(id)}`, u),
    recNavigate: (id: string, url: string) => request<{ ok: boolean }>('POST', `/api/recorder/${encodeURIComponent(id)}/navigate`, { url }),
    recBack: (id: string) => request<{ ok: boolean }>('POST', `/api/recorder/${encodeURIComponent(id)}/back`, {}),
    recReload: (id: string) => request<{ ok: boolean }>('POST', `/api/recorder/${encodeURIComponent(id)}/reload`, {}),
    recList: () => request<{ recordings: RecordingInfo[] }>('GET', '/api/recorder'),
    recGet: (id: string) => request<RecordingInfo>('GET', `/api/recorder/${encodeURIComponent(id)}`),
    recStop: (id: string) => request<{ stopped: boolean }>('POST', `/api/recorder/${encodeURIComponent(id)}/stop`, {}),
    recDelete: (id: string) => request<{ removed: boolean }>('DELETE', `/api/recorder/${encodeURIComponent(id)}`),
    recDataFiles: (project: string) => request<{ files: Array<{ path: string; format: string }> }>('GET', '/api/recorder/data-files' + q({ project })),
    recDataFile: (file: string, sheet?: string, path?: string) => request<RecDataFileInfo>('POST', '/api/recorder/data-file', { file, sheet, path }),
    newProjectPreview: (b: NewProjectRequest) => request<NewProjectPreview>('POST', '/api/projects/new/preview', b),
    newProjectApply: (b: NewProjectRequest & { baseHashes?: Record<string, string | null>; force?: boolean }) => request<{ written: Array<{ path: string; change: string }>; dirs: string[]; environments: string[] }>('POST', '/api/projects/new/apply', b),
    recPreview: (b: RecGenerateRequest) => request<RecPreview>('POST', '/api/recorder/preview', b),
    recSave: (b: RecGenerateRequest) => request<{ files: Array<{ path: string; change: 'new' | 'update' }>; uploads?: Array<{ path: string; change: 'new' | 'kept' }>; feature?: string; secretsSaved: string[]; project: string; env: string; recoveryDir: string | null }>('POST', '/api/recorder/save', b),
    dataPreview: (project: string, env: string | undefined, source: DataSourceDef, recording?: string) => request<DataPreview>('POST', '/api/data/preview', { project, env, source, recording }),
    pdfList: () => request<{ files: PdfFileDef[]; engine: 'project' | 'studio' | null }>('GET', '/api/pdf/list'),
    pdfInspect: (path: string, password?: string) => request<PdfInspectDef>('POST', '/api/pdf/inspect', { path, password }),
    pdfUpload: (project: string, name: string, data: string, replace = false) => request<{ path: string }>('POST', '/api/pdf/upload', { project, name, data, ...(replace ? { replace: true } : {}) }),
    pdfCompare: (b: PdfCheckBody) => request<PdfCompareDef>('POST', '/api/pdf/compare', b),
    pdfFeature: (b: PdfCheckBody & { name: string; save?: boolean; overwrite?: boolean; baseHashes?: Record<string, string | null>; force?: boolean }) => request<DbFeaturePreview>('POST', '/api/pdf/feature', b),
    dbConnections: (project?: string, env?: string) => request<DbConnections>('GET', '/api/db/connections' + q({ project, env })),
    dbPing: (project: string, env: string, alias: string) => request<{ ok: boolean; ms: number; type: string }>('POST', '/api/db/ping', { project, env, alias }),
    dbObjects: (project: string, env: string, alias: string) => request<{ objects: DbObject[]; type: string; unsupported?: boolean }>('GET', '/api/db/objects' + q({ project, env, alias })),
    dbColumns: (project: string, env: string, alias: string, schema: string, table: string) => request<{ columns: DbColumnInfo[] }>('GET', '/api/db/columns' + q({ project, env, alias, schema, table })),
    mocks: (project: string) => request<{ mocks: MockInfo[] }>('GET', `/api/mocks?project=${encodeURIComponent(project)}`),
    mockGet: (project: string, file: string) => request<{ file: string; mock: MockDef; url?: string }>('GET', `/api/mocks/file?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`),
    mockFromCollection: (file: string, name?: string) => request<{ mock: MockDef; warnings: string[] }>('POST', '/api/mocks/from-collection', { file, ...(name ? { name } : {}) }),
    mockRecordStart: (target: string) => request<{ url: string; target: string }>('POST', '/api/mocks/record/start', { target }),
    mockRecordStatus: () => request<{ url: string | null; target?: string; count?: number }>('GET', '/api/mocks/record'),
    mockRecordStop: (name?: string) => request<{ mock: MockDef; warnings: string[] }>('POST', '/api/mocks/record/stop', { ...(name ? { name } : {}) }),
    mockFromOpenApi: (b: { text?: string; specFile?: string; name?: string }) => request<{ mock: MockDef; warnings: string[] }>('POST', '/api/mocks/from-openapi', b),
    mockSave: (project: string, file: string, mock: MockDef) => request<{ file: string; saved: boolean; applied?: boolean; restartForPort?: boolean }>('PUT', '/api/mocks/file', { project, file, mock }),
    mockDelete: (project: string, file: string) => request<{ removed: boolean }>('DELETE', `/api/mocks/file?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`),
    mockStart: (project: string, file: string, port?: number) => request<{ url: string; port: number }>('POST', '/api/mocks/start', { project, file, ...(port !== undefined ? { port } : {}) }),
    mockStop: (project: string, file: string) => request<{ stopped: boolean }>('POST', '/api/mocks/stop', { project, file }),
    mockLog: (project: string, file: string) => request<{ running: boolean; url?: string; log: MockLogEntryDef[] }>('GET', `/api/mocks/log?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`),
    apiGraphqlSchema: (b: { project: string; env?: string; collection: ApiCollectionDef; request: ApiRequestDef }) => request<{ url: string; outline: GqlOutline }>('POST', '/api/apiws/graphql/schema', b),
    apiGraphqlCheck: (url: string, query: string) => request<{ errors: GqlError[] }>('POST', '/api/apiws/graphql/check', { url, query }),
    apiGraphqlOperation: (url: string, root: 'query' | 'mutation' | 'subscription', field: string) => request<{ query: string; variables: string; operationName: string }>('POST', '/api/apiws/graphql/operation', { url, root, field }),
    apiGrpcDescribe: (b: { project: string; env?: string; collection: ApiCollectionDef; request: ApiRequestDef }) => request<{ services: GrpcServiceInfo[]; sample?: string }>('POST', '/api/apiws/grpc/describe', b),
    apiScopes: (b: { project: string; env?: string; collection: ApiCollectionDef; saved: Record<string, string> }) => request<{ env: string; entries: ApiScopeEntry[] }>('POST', '/api/apiws/scopes', b),
    apiClearGlobals: (collection: string) => request<{ ok: boolean }>('POST', '/api/apiws/globals/clear', { collection }),
    apiCorrelate: (b: { project: string; env?: string; collection: ApiCollectionDef }) => request<{ steps: CorrelationStep[]; candidates: CorrelationCandidateDef[] }>('POST', '/api/apiws/correlate', b),
    apiCorrelateApply: (b: { collection: ApiCollectionDef; candidates: CorrelationCandidateDef[] }) => request<{ collection: ApiCollectionDef; changed: number }>('POST', '/api/apiws/correlate/apply', b),
    dbCompareRules: (project: string, env: string) => request<{ ignore: string[]; dates: DatePrecisionDef; file: string }>('GET', `/api/db/compare/rules?project=${encodeURIComponent(project)}&env=${encodeURIComponent(env)}`),
    dbSaveCompareRules: (project: string, ignore: string[], dates: DatePrecisionDef) => request<{ file: string }>('PUT', '/api/db/compare/rules', { project, ignore, dates }),
    dbCompareTables: (b: { project: string; env: string; source: { env: string; alias: string }; target: { env: string; alias: string } }) => request<{ pairs: Array<{ name: string; source?: { schema: string; name: string; rows?: number }; target?: { schema: string; name: string; rows?: number } }>; source: { alias: string; env: string; type: string }; target: { alias: string; env: string; type: string } }>('POST', '/api/db/compare/tables', b),
    dbCompareTable: (b: { project: string; env: string; source: { env: string; alias: string; table: { schema: string; name: string } }; target: { env: string; alias: string; table: { schema: string; name: string } }; options: { ignore?: string[]; tolerance?: number; ignoreCase?: boolean; trim?: boolean; keys?: string[]; idsDiffer?: boolean; dates?: DatePrecisionDef }; same?: boolean; maxRows?: number; limit?: number }) => request<{ result: DbCompareResponse['result']; keys: string[]; keyKind: string; idColumns?: string[]; primaryKey?: string[]; summary: string; source: { rows: number; truncated: boolean; ms: number; columns: string[] }; target: { rows: number; truncated: boolean; ms: number; columns: string[] }; side: { columns: string[]; targetColumn: Record<string, string>; truncated: boolean; rows: Array<{ key: string; status: 'differs' | 'missing' | 'extra' | 'same'; source?: Record<string, unknown>; target?: Record<string, unknown>; differing: string[] }> } }>('POST', '/api/db/compare/table', b),
    dbCompare: (b: { project: string; env: string; source: { alias: string; sql: string; env?: string }; target: { alias: string; sql: string; env?: string }; options: DbCompareOptions; maxRows?: number }) => request<DbCompareResponse>('POST', '/api/db/compare', b),
    toolServers: () => request<ToolServersView>('GET', '/api/agents/tool-servers'),
    saveToolServer: (b: { scope: 'team' | 'personal'; name: string; from?: string; values?: Record<string, string>; server?: ToolServerDef; editing?: string }) => request<ToolServersView>('PUT', '/api/agents/tool-servers', b),
    changeToolServer: (name: string, b: { scope: 'team' | 'personal'; enabled?: boolean; tools?: string[] | null }) => request<ToolServersView>('PATCH', `/api/agents/tool-servers/${encodeURIComponent(name)}`, b),
    removeToolServer: (name: string, scope: 'team' | 'personal') => request<ToolServersView>('DELETE', `/api/agents/tool-servers/${encodeURIComponent(name)}?scope=${scope}`),
    testToolServer: (name: string) => request<ToolServerTest>('POST', `/api/agents/tool-servers/${encodeURIComponent(name)}/test`, {}),
    checkToolServers: () => request<ToolServersView>('POST', '/api/agents/tool-servers/check', {}),
    reviewedToolServer: (name: string, scope: 'team' | 'personal') => request<ToolServersView>('POST', `/api/agents/tool-servers/${encodeURIComponent(name)}/reviewed`, { scope }),
    importToolServers: (scope: 'team' | 'personal', text: string, apply = false, replace = false) => request<ToolServerImport & Partial<ToolServersView> & { added?: string[] }>('POST', '/api/agents/tool-servers/import', { scope, text, apply, replace }),
    mcpSettings: () => request<McpSettings>('GET', '/api/mcp'),
    mcpSetEnabled: (enabled: boolean) => request<McpSettings>('PUT', '/api/mcp', { enabled }),
    mcpRenewToken: () => request<McpSettings>('POST', '/api/mcp/token'),
    dbRows: (project: string, env: string, alias: string, table: string, maxRows: number) => request<DbResult>('GET', '/api/db/rows' + q({ project, env, alias, table, maxRows: String(maxRows) })),
    dbQuery: (b: { project: string; env: string; alias: string; sql: string; params: string[]; maxRows: number; timeoutSec?: number; confirmed?: boolean }) => request<DbResult>('POST', '/api/db/query', b),
    dbDdl: (project: string, env: string, alias: string, kind: string, schema: string, name: string) => request<{ sql: string }>('GET', '/api/db/ddl' + q({ project, env, alias, kind, schema, name })),
    dbStop: (project: string, env: string) => request<{ stopped: boolean }>('POST', '/api/db/stop', { project, env }),
    dbHistory: () => request<{ items: DbHistoryItem[] }>('GET', '/api/db/history'),
    dbClearHistory: () => request<{ ok: boolean }>('DELETE', '/api/db/history?confirm=true'),
    dbQueries: (project: string) => request<{ queries: DbSavedQuery[] }>('GET', '/api/db/queries' + q({ project })),
    dbQueryFile: (file: string) => request<{ file: string; text: string; connection: string | null }>('GET', '/api/db/query-file' + q({ file })),
    dbSaveQuery: (b: { project: string; text: string; file?: string; name?: string; overwrite?: boolean }) => request<{ file: string }>('PUT', '/api/db/query-file', b),
    dbDeleteQuery: (file: string) => request<{ ok: boolean }>('DELETE', '/api/db/query-file' + q({ file, confirm: true })),
    dbFeature: (b: { project: string; name: string; alias: string; file?: string; sql?: string; params?: string[]; result: { columns: DbColumn[]; rows: DbCell[][]; total: number; truncated: boolean }; checks: DbFeatureChecks; save?: boolean; overwrite?: boolean; baseHashes?: Record<string, string | null>; force?: boolean; env?: string }) => request<DbFeaturePreview>('POST', '/api/db/feature', b),
    dbExport: async (columns: DbColumn[], rows: DbCell[][]) => {
        const res = await fetch('/api/db/export', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ columns, rows }) });
        if (!res.ok) { let m = `Request failed (${res.status})`; try { m = (await res.json()).error ?? m; } catch { /* not JSON */ } throw new ApiError(m, res.status); }
        return res.blob();
    },
    loadImportRuns: (texts: string[]) => request<LoadRunInfoDef>('POST', '/api/load/runs/import', { texts }),
    loadJunit: (id: string) => request<string>('GET', `/api/load/runs/${encodeURIComponent(id)}/junit`),
    loadAnalysis: (id: string, range?: { from: number; to: number }) => request<LoadAnalysisDef>('GET', `/api/load/runs/${encodeURIComponent(id)}/analysis` + q(range ? { from: String(range.from), to: String(range.to) } : {})),
    loadSetBaseline: (id: string, on: boolean) => request<{ ok: true }>('POST', `/api/load/runs/${encodeURIComponent(id)}/baseline`, { on }),
    loadOverlay: (ids: string[], metric: string) => request<{ metric: string; series: Array<{ id: string; label: string; points: Array<{ t: number; v: number }> }> }>('GET', '/api/load/overlay' + q({ ids: ids.join(','), metric })),
    loadTeam: (project?: string, scenario?: string) => request<{ folder: string | null; runs: LoadTeamRunDef[]; error?: string }>('GET', '/api/load/team' + q({ ...(project ? { project } : {}), ...(scenario ? { scenario } : {}) })),
    loadShare: (id: string) => request<LoadTeamRunDef>('POST', `/api/load/runs/${encodeURIComponent(id)}/share`, {}),
    loadTeamOpen: (file: string) => request<LoadRunInfoDef>('POST', '/api/load/team/open', { file }),
    loadAdoImport: (runId: number, project: string, env?: string) => request<{ imported: LoadRunInfoDef[]; shared: string[] }>('POST', '/api/load/team/ado-import', { runId, project, ...(env ? { env } : {}) }),
    loadSchedules: () => request<{ schedules: LoadScheduleDef[] }>('GET', '/api/load/schedules'),
    loadSaveSchedule: (s: Partial<LoadScheduleDef>) => request<LoadScheduleDef>('PUT', '/api/load/schedules', s),
    loadDeleteSchedule: (id: string) => request<{ removed: boolean }>('DELETE', `/api/load/schedules/${encodeURIComponent(id)}`),
    loadPipeline: (b: { file: string; generators?: number; schedule?: string; variableGroup?: string; pool?: string; teamFolder?: string; save?: boolean }) => request<{ yaml: string; file: string; secretNames: string[]; saved: boolean }>('POST', '/api/load/pipeline', b),
    loadInsights: (id: string) => request<LoadInsightsDef>('GET', `/api/load/runs/${encodeURIComponent(id)}/insights`),
    loadExplain: (id: string) => request<LoadExplainDef>('GET', `/api/load/runs/${encodeURIComponent(id)}/explain`),
    loadCompare: (a: string, b: string) => request<LoadCompareDef>('GET', '/api/load/compare' + q({ a, b })),
    loadDeleteRun: (id: string) => request<{ removed: boolean }>('DELETE', `/api/load/runs/${encodeURIComponent(id)}`),
    adoProjects: () => request<{ projects: string[]; configured: string }>('GET', '/api/ado/projects'),
    pipelineDefinitions: (o: { adoProject?: string; search?: string; folder?: string; next?: string }) => request<{ items: PipelineDef[]; next?: string; folders?: string[] }>('GET', '/api/ado/pipelines/definitions' + q(o)),
    pipelines: (o: { adoProject?: string; pipeline?: number; branch?: string; result?: string; mine?: boolean; next?: string } = {}) =>
        request<{ runs: PipelineRun[]; next?: string; project: string; env: string; adoProject: string }>('GET', '/api/ado/pipelines' + q({ ...o, mine: o.mine ? 'true' : undefined })),
    pipelineRun: (id: number, adoProject?: string) => request<PipelineRunDetail>('GET', `/api/ado/pipelines/runs/${id}` + q({ adoProject })),
    pipelineLog: (id: number, logId: number, adoProject?: string) => request<{ text: string; truncated: boolean; totalLines?: number }>('GET', `/api/ado/pipelines/runs/${id}/logs/${logId}` + q({ adoProject })),
    pipelineResults: (id: number, o: { adoProject?: string; artifact?: string } = {}) => request<PipelineResults>('POST', `/api/ado/pipelines/runs/${id}/results`, o),
    publishedTestResults: (testRunId: number, adoProject?: string) => request<{ results: PublishedTestResult[] }>('GET', `/api/ado/pipelines/testruns/${testRunId}` + q({ adoProject })),
    queuePipeline: (pipelineId: number, branch: string, parameters: Record<string, string> = {}, adoProject?: string) => request<PipelineRun>('POST', `/api/ado/pipelines/${pipelineId}/run`, { branch, parameters, confirm: true, adoProject }),
    untrackedRunOutput: () => request<{ paths: string[] }>('GET', '/api/runs/untracked-output'),
    ignoreRunOutput: (paths: string[]) => request<{ added: string[] }>('POST', '/api/runs/ignore-output', { paths }),
    warmUpLanguage: () => request<{ ok: boolean }>('POST', '/api/lang/warmup'),
    files: () => request<string[]>('GET', '/api/files'),
    readFile: (path: string) => request<FileData>('GET', '/api/file' + q({ path })),
    saveFile: (path: string, content: string, expectedHash: string | null) => request<{ hash: string }>('PUT', '/api/file', { path, content, expectedHash }),
    newFolder: (path: string) => request<{ ok: boolean }>('POST', '/api/file/folder', { path }),
    renamePath: (from: string, to: string) => request<{ ok: boolean }>('POST', '/api/file/rename', { from, to }),
    deletePath: (path: string) => request<{ recoveryDir: string }>('DELETE', '/api/file' + q({ path })),
    search: (query: string, o: { regex?: boolean; case?: boolean; word?: boolean; glob?: string }) => request<SearchHit[]>('GET', '/api/search' + q({ q: query, regex: o.regex, case: o.case, word: o.word, glob: o.glob })),
    diagnostics: (path: string, content: string) => request<{ diagnostics: Diag[] }>('POST', '/api/lang/diagnostics', { path, content }),
    completions: (path: string, content: string, offset: number) => request<{ items: CompletionItem[] }>('POST', '/api/lang/completions', { path, content, offset }),
    hover: (path: string, content: string, offset: number) => request<{ text?: string; doc?: string }>('POST', '/api/lang/hover', { path, content, offset }),
    definition: (path: string, content: string, offset: number) => request<{ locations: Loc[] }>('POST', '/api/lang/definition', { path, content, offset }),
    references: (path: string, content: string, offset: number) => request<{ locations: Loc[] }>('POST', '/api/lang/references', { path, content, offset }),
    stepUsages: (path: string, content: string, offset: number) => request<StepUsages>('POST', '/api/lang/step-usages', { path, content, offset }),
    stepRename: (path: string, content: string, offset: number, pattern: string, apply: boolean) => request<StepRename>('POST', '/api/lang/step-rename', { path, content, offset, pattern, apply }),
    format: (path: string, content: string) => request<{ content: string }>('POST', '/api/lang/format', { path, content }),
    closeFile: (path: string) => request<{ ok: boolean }>('POST', '/api/lang/close', { path }),
    framework: () => request<{ installed: boolean; version?: string; message?: string; severalScenarios?: boolean }>('GET', '/api/runs/framework'),
    workspaces: () => request<{ current: string; parent: string; recent: Array<{ path: string; name: string; openedAt: string }> }>('GET', '/api/workspaces'),
    workspaceAdoRepos: () => request<{ repos: Array<{ name: string; url: string; defaultBranch?: string; size?: number }> }>('GET', withPrProject('/api/workspaces/ado-repos')),
    workspaceClone: (b: { url: string; parent: string; name?: string }) => request<{ path: string }>('POST', '/api/workspaces/clone', { ...b, confirm: true }),
    workspaceOpen: (b: { path: string; trustRepoConfig?: boolean }) => request<{ url?: string | null; same?: boolean; path?: string; needsTrust?: string[] }>('POST', '/api/workspaces/open', b),
    prNew: (o: { repository?: string; target?: string; adoProject?: string } = {}) => request<PrNewDef>('GET', '/api/ado/prs/new' + q(o)),
    prCreate: (b: { repository: string; target: string; title: string; description: string; draft: boolean; reviewers: Array<{ id: string; required?: boolean }>; workItems: number[]; adoProject?: string }) => request<{ id: number; url: string }>('POST', '/api/ado/prs', { ...b, confirm: true }),
    prs: (o: { scope: 'review' | 'mine' | 'all'; status: 'active' | 'completed' | 'abandoned'; repository?: string; target?: string; skip?: number; top?: number }) =>
        request<{ prs: PrSummary[]; more: boolean }>('GET', withPrProject('/api/ado/prs' + q({ ...o }))),
    prRepos: () => request<{ adoProject: string; repos: PrRepo[] }>('GET', withPrProject('/api/ado/git/repos')),
    prGlance: (repo: string, id: number, target?: string) => request<PrGlance>('GET', withPrProject(`/api/ado/prs/${encodeURIComponent(repo)}/${id}/glance` + q({ target }))),
    pr: (repo: string, id: number) => request<PrDetail>('GET', withPrProject(`/api/ado/prs/${encodeURIComponent(repo)}/${id}`)),
    prCheckout: (repo: string, id: number, testCaseIds: number[]) => request<{ checkout: PrCheckoutInfo; impact: PrImpact }>('POST', withPrProject(`/api/ado/prs/${encodeURIComponent(repo)}/${id}/checkout`), { testCaseIds }),
    prRemoveCheckout: (repo: string, id: number) => request<{ ok: true }>('DELETE', withPrProject(`/api/ado/prs/${encodeURIComponent(repo)}/${id}/checkout`)),
    prDiff: (repo: string, id: number, target: string, commit: string, file: string, from?: string) => request<{ diff: string }>('GET', withPrProject(`/api/ado/prs/${encodeURIComponent(repo)}/${id}/diff` + q({ target, commit, path: file, from }))),
    prRun: (repo: string, id: number, r: RunRequest & { title: string; observe?: boolean }) => request<RunInfo>('POST', withPrProject(`/api/ado/prs/${encodeURIComponent(repo)}/${id}/run`), r),
    prStatus: (repo: string, id: number, run: string) => request<PrStatus>('POST', withPrProject(`/api/ado/prs/${encodeURIComponent(repo)}/${id}/status`), { run, confirm: true }),
    prResultsComment: (repo: string, id: number, run: string) => request<{ text: string }>('GET', withPrProject(`/api/ado/prs/${encodeURIComponent(repo)}/${id}/results-comment?run=${encodeURIComponent(run)}`)),
    prComment: (repo: string, id: number, text: string, kind?: 'results') => request<{ thread: number }>('POST', withPrProject(`/api/ado/prs/${encodeURIComponent(repo)}/${id}/comment`), { text, kind, confirm: true }),
    prThread: (repo: string, id: number, thread: number, o: { reply?: string; status?: 'active' | 'fixed' | 'closed' }) => request<{ ok: true }>('POST', withPrProject(`/api/ado/prs/${encodeURIComponent(repo)}/${id}/threads/${thread}`), { ...o, confirm: true }),
    prFinish: (repo: string, id: number, b: { action: 'complete' | 'auto-complete' | 'cancel-auto-complete' | 'abandon' | 'reactivate'; strategy?: string; deleteSourceBranch?: boolean; transitionWorkItems?: boolean; message?: string; expectedCommit?: string }) =>
        request<{ status: string; autoComplete: boolean }>('POST', withPrProject(`/api/ado/prs/${encodeURIComponent(repo)}/${id}/finish`), { ...b, confirm: true }),
    prVote: (repo: string, id: number, vote: number) => request<{ ok: true }>('POST', withPrProject(`/api/ado/prs/${encodeURIComponent(repo)}/${id}/vote`), { vote, confirm: true }),
    runs: () => request<RunInfo[]>('GET', '/api/runs'),
    mergeTools: () => request<{ tools: Array<{ name: string; label: string; userDefined?: boolean }>; default?: string; runs: Record<string, { tool: string; startedAt: string; done?: { resolved: boolean; message: string; at: string } }> }>('GET', '/api/git/mergetools'),
    openMergeTool: (file: string, tool: string) => request<{ file: string; tool: string; startedAt: string; done?: { resolved: boolean; message: string; at: string } }>('POST', '/api/git/mergetool', { file, tool }),
    teamTrends: (o: { days: number; pipeline?: string; branch?: string; workflow?: 'Build' | 'Release'; project?: string }) => request<TeamTrends>('GET', '/api/ado/analytics/tests' + q(o)),
    bisectSuggest: (scenario: string) => request<{ bad: string; good?: string; goodRun?: { id: string; at: string }; warning?: string; commits: Array<{ commit: string; subject: string; author: string; date: string }> }>('GET', '/api/bisect/suggest' + q({ scenario })),
    bisectRange: (good: string, bad?: string) => request<{ good: string; bad: string; commits: number; estimate: number }>('GET', '/api/bisect/range' + q({ good, bad })),
    bisect: () => request<{ bisect: BisectInfo | null }>('GET', '/api/bisect'),
    bisectStart: (b: { feature: string; scenario: string; good: string; bad?: string; project: string; env: string; browser?: string }) => confirmedRun<{ bisect: BisectInfo }>('POST', '/api/bisect/start', b),
    bisectStop: () => request<{ bisect: BisectInfo | null }>('POST', '/api/bisect/stop'),
    runCatalog: () => request<RunCatalog>('GET', '/api/runs/catalog'),
    startRun: (r: RunRequest) => confirmedRun<RunInfo>('POST', '/api/runs', r),
    publishRunPreview: (id: string, b: { plan?: number; suite?: number }) => request<PublishPreviewDef>('POST', `/api/runs/${encodeURIComponent(id)}/publish-ado`, b),
    publishRun: (id: string, b: { plan?: number; suite?: number }) => request<PublishPreviewDef>('POST', `/api/runs/${encodeURIComponent(id)}/publish-ado`, { ...b, publish: true }),
    doctor: (t: { project?: string; env?: string }) => request<DoctorDef>('GET', '/api/doctor' + q({ project: t.project, env: t.env })),
    notifications: () => request<NotifyDef>('GET', '/api/notifications'),
    saveNotifications: (channels: NotifyChannelDef[], webhooks: Record<string, string>) => request<NotifyDef>('PUT', '/api/notifications', { channels, webhooks }),
    testNotification: (id: string) => request<NotifyDeliveryDef>('POST', '/api/notifications/test', { id }),
    testPipeline: (b: Record<string, unknown>) => request<{ yaml: string; file: string; exists: boolean; secretNames: string[]; variableGroup: string; saved: boolean }>('POST', '/api/pipeline/tests', b),
    missions: () => request<MissionsDef>('GET', '/api/missions'),
    mission: (id: string) => request<MissionDef>('GET', `/api/missions/${encodeURIComponent(id)}`),
    missionStart: (key: string, inputs: Record<string, string>, autonomy: 'supervised' | 'autonomous', budget: Partial<MissionBudgetDef>, queue = false) => request<MissionSummaryDef>('POST', '/api/missions', { key, inputs, autonomy, budget, queue }),
    missionBug: (id: string, index: number) => request<{ id: number; url: string }>('POST', withPrProject(`/api/missions/${encodeURIComponent(id)}/bugs/${index}`), { confirm: true }),
    missionStop: (id: string) => request<{ ok: boolean }>('POST', `/api/missions/${encodeURIComponent(id)}/stop`, {}),
    missionAnswer: (id: string, checkpoint: string, answer: string) => request<{ ok: boolean }>('POST', `/api/missions/${encodeURIComponent(id)}/answer`, { checkpoint, answer }),
    missionApprove: (id: string, approval: string, decision: 'once' | 'session' | 'reject') => request<{ ok: boolean }>('POST', `/api/missions/${encodeURIComponent(id)}/approve`, { approval, decision }),
    missionDiff: (id: string) => request<string | undefined>('GET', `/api/missions/${encodeURIComponent(id)}/diff`),
    missionApply: (id: string) => request<{ files: string[] }>('POST', `/api/missions/${encodeURIComponent(id)}/apply`, { confirm: true }),
    missionDiscard: (id: string) => request<{ ok: boolean }>('POST', `/api/missions/${encodeURIComponent(id)}/discard`, { confirm: true }),
    missionPublish: (id: string, b: { repository: string; target: string; title?: string; draft?: boolean }) => request<{ id: number; url: string }>('POST', withPrProject(`/api/missions/${encodeURIComponent(id)}/publish`), { ...b, confirm: true }),
    missionMemory: (id: string, note: string, accept: boolean) => request<{ ok: boolean }>('POST', `/api/missions/${encodeURIComponent(id)}/memory/${encodeURIComponent(note)}`, { accept }),
    teamNotes: () => request<{ file: string; text: string }>('GET', '/api/missions-memory'),
    saveTeamNotes: (text: string) => request<{ ok: boolean }>('PUT', '/api/missions-memory', { text }),
    secretUsage: () => request<SecretUsageDef>('GET', '/api/secrets/usage'),
    knowledge: () => request<{ sources: KnowledgeStatusDef[]; building: { source: string; done: number; total: number } | null; file: string; problems: string[] }>('GET', '/api/knowledge'),
    saveKnowledgeSources: (sources: KnowledgeSourceDef[]) => request<{ sources: KnowledgeStatusDef[] }>('PUT', '/api/knowledge/sources', { sources }),
    buildKnowledge: (source?: string) => request<{ started: boolean }>('POST', '/api/knowledge/build', source ? { source } : {}),
    searchKnowledge: (text: string, sources?: string[]) => request<{ hits: KnowledgeHitDef[] }>('GET', '/api/knowledge/search' + q({ q: text, k: '12', ...(sources?.length ? { sources: sources.join(',') } : {}) })),
    readKnowledge: (id: string) => request<{ id: string; path: string; title: string; source: string; url?: string; lines?: [number, number]; text: string }>('GET', '/api/knowledge/read' + q({ id })),
    doctorFix: (action: string) => request<{ done: string }>('POST', '/api/doctor/fix', { action }),
    runConfigs: () => request<{ configs: RunConfigDef[]; file: string; version?: string }>('GET', '/api/run-configs'),
    saveRunConfigs: (configs: RunConfigDef[], version?: string) => request<{ configs: RunConfigDef[]; file: string; version?: string }>('PUT', '/api/run-configs', { configs, ...(version ? { version } : {}) }),
    stopRun: (id: string) => request<{ ok: boolean }>('POST', `/api/runs/${encodeURIComponent(id)}/stop`),
    run: (id: string, from?: number) => request<RunInfo & { log: LogLine[] }>('GET', `/api/runs/${encodeURIComponent(id)}` + q({ from })),
    debugRun: (id: string, command: 'next' | 'into' | 'continue' | 'stop' | 'resume' | 'stepOver' | 'stepInto' | 'stepOut' | 'pause') => request<{ ok: true }>('POST', `/api/runs/${encodeURIComponent(id)}/debug`, { command }),
    debugScopes: (id: string, frame: number) => request<{ scopes: DebugScope[] }>('GET', `/api/runs/${encodeURIComponent(id)}/debug/scopes` + q({ frame })),
    debugProperties: (id: string, objectId: string) => request<{ variables: DebugVariable[] }>('GET', `/api/runs/${encodeURIComponent(id)}/debug/properties` + q({ objectId })),
    debugEvaluate: (id: string, expression: string, frame: number) => request<DebugVariable>('POST', `/api/runs/${encodeURIComponent(id)}/debug/evaluate`, { expression, frame }),
    breakpoints: () => request<{ breakpoints: Breakpoint[] }>('GET', '/api/breakpoints'),
    setBreakpoints: (breakpoints: Breakpoint[]) => request<{ breakpoints: Breakpoint[] }>('PUT', '/api/breakpoints', { breakpoints }),
    quality: (window: number, project?: string) => request<QualityReport>('GET', '/api/quality' + q({ window, project })),
    qualityGate: (g: GateSettings) => request<GateSettings>('PUT', '/api/quality/gate', g),
    quarantine: (b: { key: string; file: string; line: number; name: string; on: boolean; reason?: string }) => request<{ ok: true; changed: boolean }>('POST', '/api/quality/quarantine', b),
    excludeQuarantined: () => request<{ ok: true; file: string }>('POST', '/api/quality/exclude-quarantined'),
    agentPlanContext: (project: string, env?: string, story?: string) => request<PlanContext>('GET', '/api/agents/plan-context' + q({ project, env, story })),
    planCoverage: (path: string, content?: string) => request<{ coverage: PlanCoverage; summary: string }>('POST', '/api/lang/plan', { path, ...(content !== undefined ? { content } : {}) }),
    triageSet: (b: { tag: string; signature: string; verdict?: TriageVerdict; note?: string; bug?: number }) => request<{ entry: TriageEntry | null }>('PUT', '/api/triage', b),
    triageBugs: (b: { tags: string[]; ids: number[]; project?: string; env?: string }) => request<{ bugs: TriageBug[] }>('POST', '/api/triage/bugs', b),
    triageBugPlan: (b: { project?: string; qualityProject?: string; passesNeeded?: number }) => request<{ actions: BugActionDef[]; states: { reopen: string; resolve: string } }>('POST', '/api/triage/bugs/plan', b),
    triageBugApply: (actions: BugActionDef[], project?: string) => request<{ results: Array<{ kind: string; bug?: number; ok: boolean; error?: string }> }>('POST', '/api/triage/bugs/apply', { actions, confirm: true, ...(project ? { project } : {}) }),
    triageFileBug: (b: { tag: string; title: string; project?: string; env?: string; qualityProject?: string }) => request<{ id: number }>('POST', '/api/triage/bug', { ...b, confirm: true }),
    triageMatch: (errors: string[]) => request<{ matches: Array<TriageEntry | null> }>('POST', '/api/triage/match', { errors }),
    visual: () => request<{ dirs: string[]; snapshots: VisualSnapshot[] }>('GET', '/api/visual'),
    /** A review image as an object URL (fetched with the token; the caller revokes it). */
    visualImage: async (file: string) => {
        const res = await fetch('/api/visual/image' + q({ path: file }), { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new ApiError(`Could not load the image (${res.status})`, res.status);
        return URL.createObjectURL(await res.blob());
    },
    /** A PDF comparison's HTML report, opened in a new tab (fetched with the token; a link cannot send it). */
    openPdfReport: async (id: string) => {
        const w = window.open('', '_blank');
        const res = await fetch(`/api/pdf/report/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) { w?.close(); throw new ApiError(`Could not open the report (${res.status})`, res.status); }
        const url = URL.createObjectURL(new Blob([await res.text()], { type: 'text/html' }));
        if (w) w.location.href = url; else window.open(url, '_blank');
    },
    /** A PDF of the project as an object URL (fetched with the token: a page or frame cannot send it; the caller revokes it). */
    pdfFile: async (file: string) => {
        const res = await fetch('/api/pdf/file' + q({ path: file }), { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new ApiError(`Could not load the PDF (${res.status})`, res.status);
        return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: 'application/pdf' }));
    },
    /** An exploration's screenshot as an object URL (the caller revokes it). */
    missionShot: async (id: string, file: string) => {
        const res = await fetch(`/api/missions/${encodeURIComponent(id)}/shots/${encodeURIComponent(file)}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new ApiError(`Could not load the screenshot (${res.status})`, res.status);
        return URL.createObjectURL(await res.blob());
    },
    visualApprove: (dir: string, name: string, actualSha: string) => request<{ ok: true }>('POST', '/api/visual/approve', { dir, name, actualSha }),
    visualAccept: (dir: string, name: string, baselineSha: string) => request<{ ok: true }>('POST', '/api/visual/accept', { dir, name, baselineSha }),
    accessibility: () => request<{ checks: A11yCheck[]; dirs: string[]; snapshots: AriaSnapshotInfo[] }>('GET', '/api/accessibility'),
    ariaApprove: (dir: string, name: string, actualSha: string) => request<{ ok: true }>('POST', '/api/accessibility/approve', { dir, name, actualSha }),
    healing: (project?: string) => request<{ groups: HealGroup[]; project: string | null; projects: string[] }>('GET', '/api/healing' + q({ project })),
    healPreview: (key: string, healed: string) => request<HealPreview>('POST', '/api/healing/preview', { key, healed }),
    healApply: (key: string, healed: string, baseHash: string) => request<{ ok: true; file: string; line: number }>('POST', '/api/healing/apply', { key, healed, baseHash }),
    healDismiss: (key: string, healed?: string, undo?: boolean) => request<{ ok: true }>('POST', '/api/healing/dismiss', { key, healed, undo }),
    testPlans: (s: AdoScope) => request<{ project: string; env: string; adoProject: string; plans: TestPlanDef[] }>('GET', '/api/ado/testplans' + q({ ...s })),
    testSuites: (plan: number, s: AdoScope) => request<{ suites: TestSuiteDef[] }>('GET', `/api/ado/testplans/${plan}/suites` + q({ ...s })),
    testPoints: (plan: number, suite: number, s: AdoScope) => request<{ points: TestPointDef[]; publishing: AdoPublishing; missing: Array<{ testCase: number; file: string; line: number; name: string }> }>('GET', `/api/ado/testplans/${plan}/suites/${suite}/points` + q({ ...s })),
    repoScenarios: (s: AdoScope) => request<{ scenarios: RepoScenario[] }>('GET', '/api/ado/testplans/scenarios' + q({ ...s })),
    scenarioSteps: (s: { file: string; line: number; name: string }) => request<{ name: string; steps: Array<{ action: string; expected: string }> }>('POST', '/api/ado/testplans/steps', s),
    addScenariosToSuite: (plan: number, suite: number, scenarios: Array<{ file: string; line: number; name: string }>, markAutomated: boolean, s: AdoScope) =>
        request<{ created: Array<{ id: number; name: string; file: string }> }>('POST', `/api/ado/testplans/${plan}/suites/${suite}/add-scenarios`, { scenarios, markAutomated, ...s, confirm: true }),
    syncTestCase: (id: number, sc: { file: string; line: number; name: string }, markAutomated: boolean, s: AdoScope) =>
        request<{ ok: true; steps: number }>('POST', `/api/ado/testcases/${id}/sync`, { ...sc, markAutomated, ...s, confirm: true }),
    activity: (limit = 200) => request<ActivityEntry[]>('GET', '/api/activity' + q({ limit })),
};
