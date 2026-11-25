/**
 * The load engine: virtual users run a user path (API requests in order) under a load policy.
 *
 *  - Each virtual user keeps its own saved values ({{token}}, {{id}}…), so one user's login is not
 *    used by another (correlation), and takes rows from the data file as the scenario says.
 *  - Requests are sent like the API workspace sends them (same values, checks, saved values,
 *    network settings); a request fails when a check fails, or (no checks) on HTTP 4xx/5xx, or on a
 *    network error / timeout.
 *  - Think time after each request (the last one too), pacing per iteration; when the policy lowers the number of users,
 *    users stop after their current iteration (no request is cut off); at the end or on Stop, no new
 *    request starts and the ones in flight may finish (up to their timeout).
 *  - Timing: performance.now() around the whole exchange (connect, send, wait, read the body).
 */
import { performance } from 'perf_hooks';
import type { Connection } from '../core/network';
import type { ApiCollection, ApiRequest } from '../api/model';
import { CookieJar } from '../api/cookies';
import { AgentPool, authorize, evaluateAll, extract, fill, prepare, send, Timings, TokenCache, Values, sendWith } from '../api/send';
import { rateAt, usersAt } from './policy';
import { ErrorSample, HistogramDump, Interval, RunMetrics, Second, TransactionStats, TxSecond } from './metrics';
import { LoadAlert, monitorChecks, Monitors, MonitorSeries } from './monitor';
import { checkSlas, intervalBreaches, LoadScenario, SlaResult, splitUsers, WanProfile } from './scenario';
import type { LoadPolicy } from './policy';
import { BrowserPathDef, browserUserPath } from './browserPath';
import { projectFileReader } from './prepare';
import { runPreScripts, withGlobals, runTestScripts, scriptSender } from '../api/scripts';
import { wsUrl } from '../api/ws';
import { redactUrl, runExchange } from '../api/messaging';
import { ApmTagging, apmHeaders } from './apm';
import { LastResponse, PathHost, PathLogic, PathShared, runSteps } from './logic';
import { BrowserCache, loadResources, pageResources } from './resources';

/** An iteration that failed within this time is followed by a short wait (see the user loop). */
const FAST_FAILURE_MS = 100;
const FAILURE_BACKOFF_MS = 250;

/** Milliseconds with one decimal (fast services answer in under a millisecond). */
const r1 = (x: number) => Math.round(x * 10) / 10;

/** What one virtual user does: one session per user, iterations until told to stop. */
export interface UserSession {
    /** One pass through the user path. `measure` times one transaction; `pause` is think time. */
    iteration(measure: Measure, pause: () => Promise<void>, stopped: () => boolean, report?: Report): Promise<void>;
    /** The user stops: its End steps (logic paths). */
    finish?(measure: Measure, pause: () => Promise<void>): Promise<void>;
    close(): Promise<void>;
}
/** What a transaction returns: null (passed), an error message, or an error with what was exchanged. */
export type Outcome = string | null | { error: string; sample?: Omit<ErrorSample, 't'> };
/** A value measured by the user itself (browser Web Vitals): recorded like a transaction of that duration. */
export type Report = (id: string, name: string, ms: number) => void;
/** `fn` may report where the time of its HTTP exchange went (`timed`). */
export type Measure = (id: string, name: string, fn: (timed: (t: Timings) => void) => Promise<Outcome>) => Promise<string | null>;

const SAMPLE_BODY = 4096;
const SECRET_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i;
/** Hide secrets in a sample: known secret values everywhere, credential headers (keeping the scheme). */
export function masker(secrets: string[]): { text: (t: string) => string; headers: (h: Record<string, string>) => Record<string, string> } {
    const list = [...new Set(secrets.filter((x) => x && x.length >= 4))].sort((a, b) => b.length - a.length);
    const text = (t: string) => { let out = t; for (const x of list) out = out.split(x).join('••••'); return out; };
    const headers = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, SECRET_HEADERS.test(k) ? (/^(Bearer|Basic|Token|Digest)\s/i.exec(v)?.[0] ?? '') + '••••' : text(v)]));
    return { text, headers };
}
const cut = (t: string) => (t.length > SAMPLE_BODY ? `${t.slice(0, SAMPLE_BODY)}… (${t.length - SAMPLE_BODY} more characters)` : t);
export interface UserPath {
    /** A new user (its own browser context, its own saved values…). */
    start(index: number): Promise<UserSession>;
    /** End of the run (close browsers…). */
    dispose(): Promise<void>;
}

/** API user path: the requests in order, each one a transaction; saved values per user. */
export function apiUserPath(input: Pick<EngineInput, 'collection' | 'requests' | 'values' | 'connection'> & { timeout: number; row: (index: number) => Record<string, string>; readFile?: (rel: string) => Buffer; secrets?: string[]; projectRoot?: string; environment?: string;
    /** APM tagging of each request (scenario name, run id for the tags). */
    apm?: { tagging: ApmTagging; scenario: string; run: string };
    /** Logic (Init / Actions / End) instead of the requests in order; what users share (rendezvous, queues, counters). */
    logic?: PathLogic; shared?: PathShared; sleep?: (ms: number, stopped: () => boolean) => Promise<void>; wan?: WanProfile }): UserPath {
    const tokens: TokenCache = new Map();
    const mask = masker(input.secrets ?? []);
    return {
        async start(index) {
            const saved: Record<string, string> = {};
            // pm.globals of the user's scripts (kept across its iterations).
            const globals: Record<string, string> = {};
            // The user's cookies and connections: a new session at every iteration (as a new visit), saved values kept.
            const jar = new CookieJar();
            const pool = new AgentPool(input.connection);
            const byId = new Map(input.requests.map((r) => [r.id, r]));
            const wait = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());
            // The user's browser cache (kept across its iterations: a returning visitor).
            const browserCache = new BrowserCache();
            const resourcesLoaded = { requested: 0, fromCache: 0, notModified: 0 };
            const state: { last?: LastResponse } = {};
            let initDone = false;
            let lastRes: LastResponse | undefined;
            // One request, measured by the caller: the outcome (and the response, for logic conditions).
            const one = async (r0: ApiRequest, row: Record<string, string>, timed: (t: Timings) => void): Promise<Outcome> => {
                lastRes = undefined;
                const v: Values = { ...input.values, vars: { ...input.values.vars, ...row, ...saved } };
                const before = { ...v.vars };
                const sender = scriptSender((x) => send(x, input.connection, input.timeout, undefined, pool));
                const pre = await runPreScripts(input.collection, r0, v, globals, sender);
                for (const [k, x] of Object.entries(v.vars)) if (before[k] !== x) saved[k] = x;
                if (pre.error) { await wait(Math.min(input.timeout, 1000)); return { error: pre.error, sample: { user: index } }; }
                if (pre.skip) return null;
                const r = pre.request;
                const p = await authorize(input.collection, r, v, prepare(input.collection, r, withGlobals(v, globals), { readFile: input.readFile }), input.connection, tokens, input.timeout);
                const tag = input.apm ? apmHeaders(input.apm.tagging, { scenario: input.apm.scenario, transaction: r.name, user: index, run: input.apm.run }) : undefined;
                if (tag) Object.assign(p.headers, tag.headers);
                const request = { method: p.method, url: mask.text(p.url), headers: mask.headers(p.headers), ...(p.body !== undefined ? { body: Buffer.isBuffer(p.body) ? `(${p.body.length} bytes, multipart)` : cut(mask.text(p.body)) } : {}) };
                // Not sendable (a value not filled in): an error at once would make each user spin without pause, so it
                // takes a moment like a failed request (and Stop is seen).
                if (p.missing.length) { await wait(Math.min(input.timeout, 1000)); return { error: `Not filled in: ${p.missing.join(', ')}`, sample: { user: index, request } }; }
                if (r.ws) {
                    const w = await runExchange(r.ws, p, v, input.timeout, input.connection, input.projectRoot, { environment: input.environment });
                    Object.assign(saved, w.saved);
                    if (!w.error) return null;
                    return { error: mask.text(w.error), sample: { user: index, request: { ...request, method: 'WS', url: mask.text(redactUrl(wsUrl(p.url))) }, response: { status: w.connected ? 101 : 0, statusText: w.connected ? 'WebSocket' : 'Not connected', timeMs: w.timeMs, headers: {}, body: cut(mask.text(w.log.map((l) => `${l.dir === 'out' ? '→' : l.dir === 'in' ? '←' : '·'} ${l.t} ms  ${l.text}`).join('\n'))) } } };
                }
                // WAN emulation: a lost request, the round trip, the time the body takes over the limited bandwidth.
                const wan = input.wan;
                if (wan?.lossPercent && Math.random() * 100 < wan.lossPercent) { await wait(Math.min(input.timeout, 3000)); return { error: 'WAN emulation: the request was lost', sample: { user: index, request } }; }
                if (wan?.latencyMs) await wait(wan.latencyMs);
                if (wan?.bandwidthKbps && p.body) await wait(((typeof p.body === 'string' ? Buffer.byteLength(p.body) : p.body.length) * 8) / wan.bandwidthKbps);
                let res;
                // The scenario's timeout is the limit of the load test: a request's own longer timeout does not lift it.
                try { res = await sendWith(p, r.settings ? { ...r.settings, retries: 0, ...(r.settings.timeoutMs !== undefined ? { timeoutMs: Math.min(r.settings.timeoutMs, input.timeout) } : {}) } : undefined, input.connection, input.timeout, jar, pool); }
                catch (e) { return { error: (e as Error).message.split('\n')[0], sample: { user: index, request } }; }
                if (wan?.bandwidthKbps) await wait((res.size * 8) / wan.bandwidthKbps);
                if (res.timings) timed(res.timings);
                // A page: its scripts, styles and images too, through this user's cache (the page's time includes them).
                let resourceError: string | null = null;
                if (r.settings?.resources && /html/i.test(res.headers['content-type'] ?? '')) {
                    const urls = pageResources(res.body, p.url);
                    const lr = await loadResources(urls, browserCache, async (u, h) => {
                        const x = await sendWith({ method: 'GET', url: u, headers: h, missing: [] }, { ...(r.settings?.http2 ? { http2: true } : {}), ...(r.settings?.insecure ? { insecure: true } : {}) }, input.connection, input.timeout, jar, pool);
                        if (wan?.latencyMs) await wait(wan.latencyMs);
                        if (wan?.bandwidthKbps) await wait((x.size * 8) / wan.bandwidthKbps);
                        return { status: x.status, headers: x.headers, size: x.size };
                    });
                    resourcesLoaded.requested += lr.requested; resourcesLoaded.fromCache += lr.fromCache; resourcesLoaded.notModified += lr.notModified;
                    if (lr.failed.length) resourceError = `${lr.failed.length} resource${lr.failed.length === 1 ? '' : 's'} failed: ${lr.failed.slice(0, 3).join(', ')}`;
                }
                lastRes = { status: res.status, body: res.body, json: res.json, headers: res.headers, ok: res.status < 400 };
                for (const x of extract(r.extract, res)) if (x.found && x.value !== undefined) saved[x.variable] = x.value;
                // Every check of the request, rule and schema ones too; database checks are not run under load
                // (a query per request would load the database, not the system under test).
                const own = await evaluateAll(r.checks.filter((c) => c.kind !== 'dbItems'), res, { ...v, readFile: input.readFile });
                const t = await runTestScripts(input.collection, r, p, res, v, globals, sender);
                for (const [k, x] of Object.entries(v.vars)) if (before[k] !== x) saved[k] = x;
                const all = [...own, ...t.checks];
                const failed = all.find((c) => !c.pass);
                const error = failed ? `${failed.message}${failed.actual !== undefined ? ` (got ${failed.actual})` : ''}` : !all.length && res.status >= 400 ? `HTTP ${res.status}` : resourceError;
                if (!error) return null;
                return { error, sample: { user: index, request, response: { status: res.status, statusText: res.statusText, timeMs: res.timeMs, headers: mask.headers(res.headers), body: cut(mask.text(res.body)) } } };
            };
            // The logic's view of this user: its values (data row + saved), requests, transactions, pauses, shared things.
            const hostFor = (measure: Measure, pause: () => Promise<void>, stopped: () => boolean, getRow: () => Record<string, string>, setRow: (r: Record<string, string>) => void): PathHost => {
                const vars = new Proxy({} as Record<string, string>, {
                    get: (_t, k: string) => saved[k] ?? getRow()[k] ?? input.values.vars[k],
                    set: (_t, k: string, v) => { saved[k] = typeof v === 'string' ? v : JSON.stringify(v); return true; },
                    has: (_t, k: string) => k in saved || k in getRow() || k in input.values.vars,
                    ownKeys: () => [...new Set([...Object.keys(input.values.vars), ...Object.keys(getRow()), ...Object.keys(saved)])],
                    getOwnPropertyDescriptor: (_t, k: string) => ({ enumerable: true, configurable: true, writable: true, value: saved[k] ?? getRow()[k] ?? input.values.vars[k] }),
                });
                return {
                    vars, shared: input.shared!, stopped,
                    request: async (id) => {
                        const r0 = byId.get(id);
                        if (!r0) return { error: `No request ${id}` };
                        const error = await measure(r0.id, r0.name, (timed) => one(r0, getRow(), timed));
                        return { error, ...(lastRes ? { last: lastRes } : {}) };
                    },
                    transaction: (name, fn) => measure(`tx:${name}`, name, async () => fn()),
                    think: (range) => (range ? (input.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(range.min + Math.random() * (range.max - range.min), stopped) : pause()),
                    sleep: (ms) => (input.sleep ?? ((x) => new Promise((r) => setTimeout(r, x))))(ms, stopped),
                    nextRow: () => setRow(input.row(index)),
                };
            };
            return {
                async iteration(measure, pause, stopped) {
                    let row = input.row(index);
                    jar.clear();
                    pool.close();
                    if (!input.logic) {
                        for (const r0 of input.requests) {
                            if (stopped()) return;
                            await measure(r0.id, r0.name, (timed) => one(r0, row, timed));
                            // Think time after every request, the last one too (a user reads the page before going on).
                            await pause();
                        }
                        return;
                    }
                    const host = hostFor(measure, pause, stopped, () => row, (r) => { row = r; });
                    if (!initDone) { initDone = true; if (input.logic.init?.length) { const e = await runSteps(input.logic.init, host, state); if (e) return; } }
                    await runSteps(input.logic.actions, host, state);
                },
                async finish(measure, pause) {
                    if (!input.logic?.end?.length) return;
                    let row = input.row(index);
                    await runSteps(input.logic.end, hostFor(measure, pause, () => false, () => row, (r) => { row = r; }), state);
                },
                async close() { pool.close(); },
            };
        },
        async dispose() { /* nothing */ },
    };
}

/** Another user path of the run (a population). */
export interface PopulationInput {
    name: string;
    /** Percent of the users. */
    share: number;
    collection: Pick<ApiCollection, 'baseUrl' | 'auth' | 'scripts'>;
    requests: ApiRequest[];
    values: Values;
    secrets?: string[];
    browser?: { def: BrowserPathDef; projectRoot: string; headless: boolean };
    /** Tests: a ready user path. */
    userPath?: UserPath;
    /** Logic of the path (Init / Actions / End) instead of the requests in order. */
    logic?: PathLogic;
    /** Its own policy, start delay and stop (seconds), network emulation. */
    policy?: LoadPolicy;
    startDelay?: number;
    stopAfter?: number;
    wan?: WanProfile;
}

export interface EngineInput {
    scenario: LoadScenario;
    collection: Pick<ApiCollection, 'baseUrl' | 'auth' | 'scripts'>;
    requests: ApiRequest[];
    /** Collection variables, config and secrets (filled in by the caller). */
    values: Values;
    rows: Array<Record<string, string>>;
    connection?: Connection;
    /** Another user path; default: the API requests above. */
    userPath?: UserPath;
    /** The project folder (multipart files are read from it). */
    projectRoot?: string;
    /** The environment's name (SQL actions only read in production-like environments). */
    environment?: string;
    /** Browser users (built where the run happens: Playwright objects do not cross threads). */
    browser?: { def: BrowserPathDef; projectRoot: string; headless: boolean };
    /** Secret values to hide in error samples. */
    secrets?: string[];
    /** More user paths, each with its share of the users (the main path gets the rest). */
    populations?: PopulationInput[];
    /** Distributed run: this computer runs part `index` (0-based) of `of` equal parts of the users. */
    part?: { index: number; of: number };
}

export interface Snapshot {
    state: 'running' | 'stopping' | 'finished';
    elapsed: number;
    users: number;
    requests: number;
    errors: number;
    iterations: number;
    /** Arrival rate: iterations due when every user (up to the most allowed) was busy. */
    dropped?: number;
    /** Arrival rate: iterations that came due (started or dropped). */
    due?: number;
    /** The load generator itself was the bottleneck (CPU, event-loop delay): its numbers are not the system's. */
    overload?: string;
    /** The last seconds of the timeline (the whole timeline at the end). */
    timeline: Second[];
    transactions: TransactionStats[];
    /** Per transaction id: its seconds (the last two minutes while running; all at the end). */
    txTimeline: Record<string, TxSecond[]>;
    /** User paths and their users now (one entry without populations). */
    populations: Array<{ name: string; share: number; users: number }>;
    /** Server monitors and the load generator (the last two minutes while running; all at the end). */
    monitors: MonitorSeries[];
    /** Alerts raised while running (monitors over their warning level / maximum, and back). */
    alerts: LoadAlert[];
    /** Service-level intervals (at the end). */
    intervals?: Interval[];
    total: { count: number; errors: number; errorRate: number; avg: number; p50: number; p90: number; p95: number; p99: number; max: number; throughput: number };
}

export interface RunResult extends Snapshot {
    startedAt: string;
    endedAt: string;
    stopReason: 'completed' | 'stopped' | 'error-rate' | 'data-used' | 'alert';
    slas: SlaResult[];
    passed: boolean;
    /** Response-time histograms, to merge the parts of a distributed run exactly. */
    histograms: { total: HistogramDump; tx: Record<string, HistogramDump> };
    part?: { index: number; of: number };
}

export class LoadEngine {
    private metrics!: RunMetrics;
    private t0 = 0;
    private startedAt = '';
    private active = 0;
    private nextVu = 0;
    private vus = new Map<number, { stop: boolean; pop: number }>();
    private pops: Array<{ name: string; share: number; prefix: string; path: UserPath; policy?: LoadPolicy; startDelay?: number; stopAfter?: number }> = [];
    /** Users started per path (iterations per user: a user that finished is not replaced). */
    private started: number[] = [];
    /** The load now: the policy's users (and rate) times this, changed during the run. */
    private factor = 1;
    private stopping = false;
    /** Rendezvous, queues and counters of the users' logic. */
    private shared!: PathShared;
    private stopReason: RunResult['stopReason'] = 'completed';
    private wake = new Set<() => void>();
    private rowCursor = 0;
    private inflight = 0;
    private monitors!: Monitors;
    /** Alerts raised while running (monitors, service levels per interval). */
    private readonly alerts: LoadAlert[] = [];
    /** This run's id (APM tags, alerts). */
    private readonly runId = `run-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
    /** Arrival rate: iterations due (fractions add up), users waiting for one, iterations dropped. */
    private due = 0;
    private idle: Array<(go: boolean) => void> = [];
    private dropped = 0;
    /** Arrival rate: iterations that came due (started or dropped). */
    private arrived = 0;

    constructor(private readonly input: EngineInput) {}

    private now() { return performance.now(); }
    private elapsed() { return (this.now() - this.t0) / 1000; }

    /** Run to the end. `onSecond` is called about once a second with a snapshot. */
    async run(onSecond?: (s: Snapshot) => void): Promise<RunResult> {
        const { scenario } = this.input;
        this.t0 = this.now();
        this.startedAt = new Date().toISOString();
        this.metrics = new RunMetrics(this.t0, scenario.slaInterval ?? 10, (i) => {
            const names = (id: string) => this.metrics.tx.get(id)?.name ?? id;
            for (const b of intervalBreaches(scenario.slas, i, names)) this.alert({ t: i.t1, level: b.level === 'fail' ? 'critical' : 'warning', source: `sla:${b.sla.target}`, message: b.message });
        });
        const readFile = this.input.projectRoot ? projectFileReader(this.input.projectRoot) : undefined;
        this.shared = new PathShared(() => this.active, () => this.stopping);
        const sleep = (ms: number, stopped: () => boolean) => this.sleep(ms, { get stop() { return stopped(); } });
        const build = (x: Pick<PopulationInput, 'collection' | 'requests' | 'values' | 'secrets' | 'browser' | 'userPath' | 'logic' | 'wan'>): UserPath => x.userPath
            ?? (x.browser ? browserUserPath(x.browser.def, { projectRoot: x.browser.projectRoot, headless: x.browser.headless, timeout: scenario.timeout, row: (i) => this.rowFor(i),
                proxy: (() => { const l = this.input.connection?.proxyLabel(x.browser!.def.startUrl); return l ? l.split(' ')[0] : undefined; })() })
                : apiUserPath({ ...x, connection: this.input.connection, timeout: scenario.timeout, row: (i) => this.rowFor(i), readFile, projectRoot: this.input.projectRoot, environment: this.input.environment, shared: this.shared, sleep,
                    ...(scenario.apm ? { apm: { tagging: scenario.apm, scenario: scenario.name, run: this.runId } } : {}) }));
        const extra = this.input.populations ?? [];
        this.pops = [
            { name: scenario.mainName?.trim() || 'Main', share: 100 - extra.filter((p) => !p.policy).reduce((n, p) => n + p.share, 0), prefix: '', path: build({ ...this.input, logic: scenario.logic, wan: scenario.wan }) },
            ...extra.map((p, i) => ({ name: p.name, share: p.share, prefix: `p${i + 1}:`, path: build(p), ...(p.policy ? { policy: p.policy } : {}), startDelay: p.startDelay ?? 0, ...(p.stopAfter !== undefined ? { stopAfter: p.stopAfter } : {}) })),
        ];
        const policy = scenario.policy;
        let lastReport = -1;
        this.monitors = new Monitors(scenario.monitors ?? [], this.input.values, this.input.connection, 4000, { environment: this.input.environment, projectRoot: this.input.projectRoot, onAlert: (a) => this.alert(a) });
        const every = scenario.monitorEvery ?? 5;
        let nextSample = 0;
        const part = this.input.part;
        if (part) this.rowCursor = part.index;
        const arrival = policy.type === 'arrival';
        // Open model: iterations started at the rate, each at its own moment (evenly spaced, not in bursts).
        if (arrival) void this.arrivals();
        await new Promise<void>((resolve) => {
            const tick = () => {
                const t = this.elapsed();
                if (!this.stopping && t >= policy.duration) this.stop('completed');
                if (!this.stopping && !arrival) {
                    const mine = (n: number) => (part ? splitUsers(n, Array.from({ length: part.of }, () => 1))[part.index] : n);
                    const perUser = scenario.iterationsPerUser;
                    // Paths with their own policy: their users over their own time (start delay, stop).
                    this.pops.forEach((p, i) => {
                        if (!p.policy) return;
                        const local = t - (p.startDelay ?? 0);
                        const want = local < 0 || (p.stopAfter !== undefined && t >= p.stopAfter) ? 0 : mine(Math.round(usersAt(p.policy, local) * this.factor));
                        const live = [...this.vus.values()].filter((v) => !v.stop && v.pop === i);
                        const have = perUser ? this.started[i] ?? 0 : live.length;
                        for (let k = have; k < want; k++) this.startVu(false, i);
                        if (live.length > want) live.slice(0, live.length - want).forEach((v) => { v.stop = true; });
                    });
                    // The others share the scenario's policy.
                    const shared = this.pops.map((p, i) => i).filter((i) => !this.pops[i].policy);
                    if (shared.length) {
                        const want = mine(Math.round(usersAt(policy, t) * this.factor));
                        const live = [...this.vus.values()].filter((v) => !v.stop && !this.pops[v.pop].policy);
                        const have = perUser ? shared.reduce((n, i) => n + (this.started[i] ?? 0), 0) : live.length;
                        for (let i = have; i < want; i++) this.startVu();
                        if (live.length > want) live.slice(0, live.length - want).forEach((v) => { v.stop = true; });
                    }
                    // Iterations per user: the run ends when every user has done its iterations.
                    if (perUser && this.active === 0 && this.started.reduce((a, b) => a + b, 0) > 0 && t > 1) this.stop('completed');
                }
                // Too many errors: stop early (both models).
                if (!this.stopping && scenario.stopOnErrorRate !== undefined) {
                    const last = this.metrics.timeline.slice(-10);
                    const req = last.reduce((n, s) => n + s.requests, 0), err = last.reduce((n, s) => n + s.errors, 0);
                    if (req >= 20 && (100 * err) / req > scenario.stopOnErrorRate) this.stop('error-rate');
                }
                if (t >= nextSample && !this.stopping) { nextSample += every; void this.monitors.sample(Math.round(t * 10) / 10); }
                this.metrics.second(this.now(), this.active);
                const sec = Math.floor(t);
                if (onSecond && sec !== lastReport) { lastReport = sec; onSecond(this.snapshot(false)); }
                if (this.stopping && this.active === 0 && this.inflight === 0) { clearInterval(timer); resolve(); }
            };
            const timer = setInterval(tick, 100);
            tick();
        });
        await Promise.all(this.pops.map((p) => p.path.dispose().catch(() => { /* ignore */ })));
        this.metrics.finish();
        this.monitors.close();
        const snap = this.snapshot(true);
        const slas = [...checkSlas(scenario.slas, snap.transactions, snap.total, { due: snap.due, dropped: snap.dropped, intervals: this.metrics.intervals }), ...monitorChecks(snap.monitors)];
        return { ...snap, state: 'finished', startedAt: this.startedAt, endedAt: new Date().toISOString(), stopReason: this.stopReason, slas, passed: this.stopReason !== 'error-rate' && this.stopReason !== 'alert' && slas.every((s) => s.pass),
            histograms: this.metrics.histograms(), ...(this.input.part ? { part: this.input.part } : {}) };
    }

    /**
     * Arrival rate: the rate (a part of a distributed run takes its share) is added up over time and an iteration
     * starts the moment a whole one is due; between two, the scheduler sleeps until the next one (at most 50 ms, so a
     * changing rate is followed). Each iteration goes to an idle user, else a new one up to the most users, else it
     * is dropped (counted).
     */
    private async arrivals() {
        const policy = this.input.scenario.policy, part = this.input.part;
        const share = part ? 1 / part.of : 1;
        const most = part ? splitUsers(policy.users, Array.from({ length: part.of }, () => 1))[part.index] : policy.users;
        let last = this.elapsed();
        while (!this.stopping) {
            const t = this.elapsed();
            if (t >= policy.duration) break;
            const rate = rateAt(policy, t) * share * this.factor;
            this.due += rate * Math.max(0, t - last);
            last = t;
            while (this.due >= 1 && !this.stopping) {
                this.due -= 1;
                this.arrived++;
                const w = this.idle.shift();
                if (w) w(true);
                else if (this.vus.size < most) this.startVu(true);
                else this.dropped++;
            }
            const wait = rate > 0 ? Math.min(50, ((1 - this.due) / rate) * 1000) : 50;
            await new Promise<void>((resolve) => {
                const done = () => { clearTimeout(timer); this.wake.delete(done); resolve(); };
                const timer = setTimeout(done, Math.max(1, wait));
                this.wake.add(done);
            });
        }
    }

    /** Stop: no new iteration or request; requests in flight finish. */
    /** An alert while running: kept, sent to the webhook, and a critical one stops the run when asked. */
    private alert(a: LoadAlert) {
        const sc = this.input.scenario;
        this.alerts.push(a);
        const hook = sc.alerting?.webhook?.trim();
        if (hook) {
            const missing = new Set<string>();
            const url = fill(hook, this.input.values, missing);
            const icon = a.level === 'critical' ? '🔴' : a.level === 'warning' ? '🟠' : '🟢';
            const body = JSON.stringify({ text: `${icon} Load test "${sc.name}" at ${Math.round(a.t)} s: ${a.message}`, alert: a, scenario: sc.name, run: this.runId });
            if (!missing.size) void send({ method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body, missing: [] }, this.input.connection, 10_000).catch(() => undefined);
        }
        if (a.level === 'critical' && sc.alerting?.stopOnCritical && !this.stopping) this.stop('alert');
    }

    stop(reason: RunResult['stopReason'] = 'stopped') {
        if (this.stopping) return;
        this.stopping = true;
        this.stopReason = reason;
        for (const v of this.vus.values()) v.stop = true;
        this.shared?.releaseAll();
        for (const w of this.wake) w();
        for (const w of this.idle.splice(0)) w(false);
    }

    private sleep(ms: number, vu: { stop: boolean }) {
        if (ms <= 0 || vu.stop) return Promise.resolve();
        return new Promise<void>((resolve) => {
            const done = () => { clearTimeout(t); this.wake.delete(done); resolve(); };
            const t = setTimeout(done, ms);
            this.wake.add(done);
        });
    }

    private dataUsedUp(): boolean {
        const { rows, scenario } = this.input;
        return scenario.data?.mode === 'unique' && rows.length > 0 && this.rowCursor >= rows.length;
    }

    private rowFor(vuIndex: number): Record<string, string> {
        const { rows, scenario } = this.input;
        if (!rows.length || !scenario.data) return {};
        if (scenario.data.mode === 'perUser') return rows[vuIndex % rows.length];
        if (scenario.data.mode === 'random') return rows[Math.floor(Math.random() * rows.length)];
        if (scenario.data.mode === 'unique' && this.rowCursor >= rows.length) return rows[rows.length - 1];
        // Parts of a distributed run take every n-th row, so they do not use the same ones.
        const row = rows[this.rowCursor % rows.length];
        this.rowCursor += this.input.part?.of ?? 1;
        return row;
    }

    /** The user path a new user takes: the one (of those sharing the scenario's policy) furthest below its share. */
    private nextPop(): number {
        const shared = this.pops.map((p, i) => i).filter((i) => !this.pops[i].policy);
        if (shared.length <= 1) return shared[0] ?? 0;
        const running = this.pops.map(() => 0);
        for (const v of this.vus.values()) if (!v.stop) running[v.pop]++;
        const want = splitUsers(shared.reduce((n, i) => n + running[i], 0) + 1, shared.map((i) => this.pops[i].share));
        let best = 0;
        for (let k = 1; k < shared.length; k++) if (want[k] - running[shared[k]] > want[best] - running[shared[best]]) best = k;
        return shared[best];
    }

    /** Change the load during the run: the policy's users (and arrival rate) times `factor` (0–10). */
    adjust(factor: number) { this.factor = Math.max(0, Math.min(10, Number(factor) || 0)); }
    get loadFactor() { return this.factor; }

    /** arrival: the user starts with an iteration to do, then waits for the next one due. */
    private startVu(arrival = false, pop?: number) {
        // Users are numbered across the parts of a distributed run (one data row per user stays unique).
        const index = this.input.part ? this.nextVu++ * this.input.part.of + this.input.part.index : this.nextVu++;
        const vu = { stop: false, pop: pop ?? this.nextPop() };
        this.started[vu.pop] = (this.started[vu.pop] ?? 0) + 1;
        this.vus.set(index, vu);
        this.active++;
        void this.userLoop(index, vu, arrival).finally(() => { this.active--; this.vus.delete(index); });
    }

    /** arrival: wait until an iteration is due for this user (false: the run stops). */
    private nextIteration(): Promise<boolean> {
        if (this.stopping) return Promise.resolve(false);
        return new Promise((resolve) => this.idle.push(resolve));
    }

    private async userLoop(index: number, vu: { stop: boolean; pop: number }, arrival = false) {
        const { scenario } = this.input;
        const pop = this.pops[vu.pop];
        const label = (name: string) => (this.pops.length > 1 ? `${pop.name} › ${name}` : name);
        const think = () => scenario.thinkTime.min + Math.random() * (scenario.thinkTime.max - scenario.thinkTime.min);
        const measure: Measure = async (id, name, fn) => {
            const t1 = this.now();
            let out: Outcome;
            let timings: Timings | undefined;
            this.inflight++;
            try { out = await fn((t) => { timings = t; }); } catch (e) { out = (e as Error).message.split('\n')[0]; }
            finally { this.inflight--; }
            const error = out === null ? null : typeof out === 'string' ? out : out.error;
            if (error) iterationFailed = true;
            this.metrics.record(pop.prefix + id, label(name), this.now() - t1, error, this.now(), this.active, out && typeof out === 'object' ? out.sample : { user: index }, timings);
            return error;
        };
        const report: Report = (id, name, ms) => this.metrics.record(pop.prefix + id, label(name), ms, null, this.now(), this.active, { user: index });
        // An iteration with an error that ended at once (connection refused, bad address): the user
        // waits a moment before the next one, or it would retry in a tight loop and use a full CPU.
        let iterationFailed = false;
        let session: UserSession;
        try { session = await pop.path.start(index); }
        catch (e) {
            this.metrics.record(`${pop.prefix}_start`, label('Start a user'), 0, (e as Error).message.split('\n')[0], this.now(), this.active, { user: index });
            // Arrival rate: the iteration this user was started for did not happen.
            if (arrival) this.dropped++;
            return;
        }
        let done = 0;
        try {
            let first = true;
            while (!vu.stop) {
                // Arrival rate: an iteration when one is due (the first one is why the user started), no pacing.
                if (arrival && !first && !(await this.nextIteration())) break;
                first = false;
                if (vu.stop) break;
                // Each row once: when all are taken, the test ends (iterations in progress finish).
                if (this.dataUsedUp()) { this.stop('data-used'); break; }
                const started = this.now();
                iterationFailed = false;
                await session.iteration(measure, () => this.sleep(think(), vu), () => vu.stop, report);
                this.metrics.iterations++;
                // A turn of the event loop between iterations: messages (Stop, adjust) and timers are never starved.
                await new Promise<void>((r) => setImmediate(r));
                if (iterationFailed && this.now() - started < FAST_FAILURE_MS && !vu.stop) await this.sleep(FAILURE_BACKOFF_MS, vu);
                if (scenario.iterationsPerUser && ++done >= scenario.iterationsPerUser) { vu.stop = true; break; }
                if (!arrival) await this.sleep(scenario.pacing - (this.now() - started), vu);
            }
        } finally {
            // The user stops: its End steps (logic), then its session closes.
            await session.finish?.(measure, () => this.sleep(think(), { stop: false })).catch(() => { /* counted by measure */ });
            await session.close().catch(() => { /* ignore */ });
        }
    }

    private snapshot(full: boolean): Snapshot {
        const elapsed = Math.min(this.elapsed(), this.input.scenario.policy.duration + 600);
        const secs = Math.max(elapsed, 0.001);
        const a = this.metrics.all;
        return {
            state: this.stopping ? 'stopping' : 'running',
            elapsed: Math.round(elapsed * 10) / 10,
            users: this.active,
            requests: a.count, errors: this.metrics.errors, iterations: this.metrics.iterations,
            ...(this.input.scenario.policy.type === 'arrival' ? { dropped: this.dropped, due: this.arrived } : {}),
            ...(this.monitors?.overload() ? { overload: this.monitors.overload()! } : {}),
            timeline: full ? this.metrics.timeline : this.metrics.timeline.slice(-120),
            transactions: this.metrics.transactions(secs),
            txTimeline: this.metrics.txTimeline(full ? undefined : 120),
            populations: this.pops.map((p, i) => ({ name: p.name, share: p.share, users: [...this.vus.values()].filter((v) => v.pop === i).length })),
            monitors: this.monitors ? this.monitors.snapshot(full ? undefined : 120) : [],
            alerts: [...this.alerts].sort((x, y) => x.t - y.t),
            ...(full ? { intervals: this.metrics.intervals } : {}),
            total: {
                count: a.count, errors: this.metrics.errors, errorRate: a.count ? (100 * this.metrics.errors) / a.count : 0,
                avg: r1(a.avg), p50: r1(a.percentile(50)), p90: r1(a.percentile(90)), p95: r1(a.percentile(95)), p99: r1(a.percentile(99)), max: r1(a.max),
                throughput: a.count / secs,
            },
        };
    }
}
