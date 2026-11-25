/**
 * The controller of a distributed load test: the scenario's load generators (computers running
 * `cs-test-studio agent`, e.g. the Docker image in other zones or regions) each run their part of the users,
 * starting at the same moment. Every second the controller reads their progress and their health (CPU, memory,
 * reachable or not) and adds their numbers up for the live view; at the end their results are merged exactly
 * (merge.ts). Stop and load changes go to all of them.
 */
import type { Connection } from '../core/network';
import { send, fill, Values } from '../api/send';
import type { EngineInput, RunResult, Snapshot } from './engine';
import type { LoadRunDetail, RunHandle } from './runs';
import type { LoadScenario } from './scenario';
import { mergeRuns } from './merge';

export type { GeneratorDef, GeneratorHealth } from './generators';
import type { GeneratorDef, GeneratorHealth } from './generators';

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The generators' live numbers added up (response-time percentiles: the highest generator's, until the exact merge at the end). */
export function mergeLive(parts: Array<{ name: string; s: Snapshot }>): Snapshot | undefined {
    if (!parts.length) return undefined;
    const ss = parts.map((p) => p.s);
    const byT = new Map<number, Snapshot['timeline']>();
    for (const s of ss) for (const x of s.timeline) byT.set(x.t, [...(byT.get(x.t) ?? []), x]);
    const timeline = [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([t, xs]) => {
        const requests = xs.reduce((n, x) => n + x.requests, 0);
        return { t, users: xs.reduce((n, x) => n + x.users, 0), requests, errors: xs.reduce((n, x) => n + x.errors, 0), avg: requests ? r1(xs.reduce((n, x) => n + x.avg * x.requests, 0) / requests) : 0, p95: Math.max(...xs.map((x) => x.p95)) };
    });
    const ids = [...new Set(ss.flatMap((s) => s.transactions.map((t) => t.id)))];
    const transactions = ids.map((id) => {
        const ts = ss.map((s) => s.transactions.find((t) => t.id === id)).filter((t): t is NonNullable<typeof t> => !!t);
        const count = ts.reduce((n, t) => n + t.count, 0), errors = ts.reduce((n, t) => n + t.errors, 0);
        return { ...ts[0], count, errors, errorRate: count ? (100 * errors) / count : 0, avg: count ? r1(ts.reduce((n, t) => n + t.avg * t.count, 0) / count) : 0,
            min: Math.min(...ts.map((t) => t.min)), max: Math.max(...ts.map((t) => t.max)), p50: Math.max(...ts.map((t) => t.p50)), p90: Math.max(...ts.map((t) => t.p90)), p95: Math.max(...ts.map((t) => t.p95)), p99: Math.max(...ts.map((t) => t.p99)),
            throughput: ts.reduce((n, t) => n + t.throughput, 0), topErrors: ts.flatMap((t) => t.topErrors).slice(0, 5) };
    });
    const txTimeline: Snapshot['txTimeline'] = {};
    for (const id of ids) {
        const m = new Map<number, Snapshot['txTimeline'][string]>();
        for (const s of ss) for (const x of s.txTimeline?.[id] ?? []) m.set(x.t, [...(m.get(x.t) ?? []), x]);
        txTimeline[id] = [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, xs]) => { const n = xs.reduce((k, x) => k + x.n, 0); return { t, n, e: xs.reduce((k, x) => k + x.e, 0), avg: n ? r1(xs.reduce((k, x) => k + x.avg * x.n, 0) / n) : 0, p95: Math.max(...xs.map((x) => x.p95)) }; });
    }
    const count = ss.reduce((n, s) => n + s.total.count, 0), errors = ss.reduce((n, s) => n + s.total.errors, 0);
    const stopping = ss.some((s) => s.state === 'stopping');
    return {
        state: stopping ? 'stopping' : 'running', elapsed: Math.max(...ss.map((s) => s.elapsed)), users: ss.reduce((n, s) => n + s.users, 0),
        requests: ss.reduce((n, s) => n + s.requests, 0), errors: ss.reduce((n, s) => n + s.errors, 0), iterations: ss.reduce((n, s) => n + s.iterations, 0),
        ...(ss.some((s) => s.dropped !== undefined) ? { dropped: ss.reduce((n, s) => n + (s.dropped ?? 0), 0), due: ss.reduce((n, s) => n + (s.due ?? 0), 0) } : {}),
        ...(ss.some((s) => s.overload) ? { overload: parts.filter((p) => p.s.overload).map((p) => `${p.name}: ${p.s.overload}`).join(' ') } : {}),
        timeline, transactions, txTimeline, populations: ss[0].populations,
        monitors: parts.flatMap((p) => p.s.monitors.map((m) => ({ ...m, name: `${m.name} (${p.name})` }))),
        alerts: parts.flatMap((p) => p.s.alerts.map((a) => ({ ...a, message: `${p.name}: ${a.message}` }))).sort((a, b) => a.t - b.t),
        total: { count, errors, errorRate: count ? (100 * errors) / count : 0, avg: count ? r1(ss.reduce((n, s) => n + s.total.avg * s.total.count, 0) / count) : 0,
            p50: Math.max(...ss.map((s) => s.total.p50)), p90: Math.max(...ss.map((s) => s.total.p90)), p95: Math.max(...ss.map((s) => s.total.p95)), p99: Math.max(...ss.map((s) => s.total.p99)), max: Math.max(...ss.map((s) => s.total.max)),
            throughput: ss.reduce((n, s) => n + s.total.throughput, 0) },
    };
}

/** An agent's HTTP API (agent.ts), with its token. */
class AgentClient {
    constructor(readonly def: GeneratorDef, private readonly token: string, private readonly conn?: Connection) {}
    private async call<T>(method: string, p: string, body?: unknown, timeoutMs = 8000): Promise<T> {
        const res = await send({ method, url: `${this.def.url.trim().replace(/\/+$/, '')}${p}`, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), missing: [] }, this.conn, timeoutMs);
        if (res.status === 401) throw new Error('the agent refused the token');
        if (res.status >= 400) throw new Error((res.json as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`);
        return res.json as T;
    }
    health() { return this.call<{ busy: boolean; cpu: number; memory: number; version: string; host: string; zone?: string }>('GET', '/health', undefined, 4000); }
    start(body: unknown) { return this.call<{ id: string }>('POST', '/runs', body, 60_000); }
    get(id: string) { return this.call<LoadRunDetail & { waiting?: boolean }>('GET', `/runs/${encodeURIComponent(id)}`); }
    stop(id: string) { return this.call('POST', `/runs/${encodeURIComponent(id)}/stop`, {}); }
    adjust(id: string, factor: number) { return this.call('POST', `/runs/${encodeURIComponent(id)}/adjust`, { factor }); }
}

export interface DistributedOptions {
    generators: GeneratorDef[];
    scenarioFile: string; project: string; env: string; definition: LoadScenario;
    input: Omit<EngineInput, 'connection'>;
    /** Fills the generators' tokens ({env:…}, {config:…}). */
    values: Values;
    conn?: Connection;
    /** Seconds between starting the parts and the common start (default 5): every generator starts its users at the same moment. */
    leadSeconds?: number;
    pollMs?: number;
}

/** Run the scenario on its generators; the callbacks get the live numbers and the merged result. */
export function runDistributed(o: DistributedOptions, cb: { live: (s: Snapshot) => void; done: (r?: RunResult, message?: string) => void }): RunHandle {
    const n = o.generators.length;
    const health: GeneratorHealth[] = o.generators.map((g) => ({ name: g.name, ...(g.zone ? { zone: g.zone } : {}), url: g.url, state: 'starting' }));
    const clients = o.generators.map((g) => {
        const missing = new Set<string>();
        const token = fill(g.token.trim(), o.values, missing);
        return { client: new AgentClient(g, missing.size ? '' : token, o.conn), missing: [...missing] };
    });
    const ids: Array<string | undefined> = [];
    const details: Array<LoadRunDetail | undefined> = [];
    let stopped = false, ended = false, timer: NodeJS.Timeout | undefined;
    const end = (r?: RunResult, m?: string) => { if (ended) return; ended = true; if (timer) clearInterval(timer); cb.done(r, m); };
    const all = (f: (c: AgentClient, id: string) => Promise<unknown>) => clients.forEach(({ client }, i) => { const id = ids[i]; if (id) void f(client, id).catch(() => undefined); });
    (async () => {
        // Every generator reachable and idle before any starts (a part missing would make the test smaller than planned).
        const checks = await Promise.all(clients.map(async ({ client, missing }, i) => {
            if (missing.length) return `${o.generators[i].name}: its token is not set (${missing.join(', ')})`;
            try { const h = await client.health(); Object.assign(health[i], { cpu: h.cpu, memory: h.memory }); return h.busy ? `${o.generators[i].name} is running another test` : null; }
            catch (e) { health[i].state = 'unreachable'; health[i].error = (e as Error).message.split('\n')[0]; return `${o.generators[i].name} (${o.generators[i].url}) cannot be reached: ${health[i].error}`; }
        }));
        const bad = checks.filter(Boolean);
        if (bad.length) return end(undefined, `Not started: ${bad.join('; ')}.`);
        const startAt = new Date(Date.now() + (o.leadSeconds ?? 5) * 1000).toISOString();
        const started = await Promise.all(clients.map(async ({ client }, i) => {
            try {
                const r = await client.start({ scenarioFile: o.scenarioFile, project: o.project, env: o.env, definition: o.definition, startAt, input: { ...o.input, part: { index: i, of: n } } });
                ids[i] = r.id; health[i].state = 'waiting';
                return null;
            } catch (e) { health[i].state = 'error'; health[i].error = (e as Error).message; return `${o.generators[i].name}: ${(e as Error).message}`; }
        }));
        const failed = started.filter(Boolean);
        if (failed.length) { all((c, id) => c.stop(id)); return end(undefined, `Not started: ${failed.join('; ')}.`); }
        let busy = false;
        timer = setInterval(async () => {
            if (busy || ended) return;
            busy = true;
            try {
                await Promise.all(clients.map(async ({ client }, i) => {
                    if (details[i]?.state === 'finished' || details[i]?.state === 'error') return;
                    try {
                        const [d, h] = await Promise.all([client.get(ids[i]!), client.health().catch(() => undefined)]);
                        details[i] = d;
                        Object.assign(health[i], { state: d.waiting ? 'waiting' : d.state, users: d.live?.users ?? d.result?.users ?? 0, requests: d.live?.total.count ?? d.result?.total.count, errors: d.live?.total.errors ?? d.result?.total.errors, lastSeen: new Date().toISOString(), ...(h ? { cpu: h.cpu, memory: h.memory } : {}) });
                        if (d.state === 'error') health[i].error = d.message;
                        else delete health[i].error;
                    } catch (e) {
                        // A generator not answering for 30 s is lost (its part of the numbers is missing).
                        health[i].error = (e as Error).message.split('\n')[0];
                        if (health[i].lastSeen && Date.now() - Date.parse(health[i].lastSeen!) > 30_000) { health[i].state = 'unreachable'; details[i] = { ...(details[i] ?? {} as LoadRunDetail), state: 'error', message: `lost: ${health[i].error}` }; }
                    }
                }));
                const live = mergeLive(details.map((d, i) => ({ name: o.generators[i].name, s: d?.live as Snapshot })).filter((x) => x.s));
                if (live) cb.live(stopped && live.state !== 'stopping' ? { ...live, state: 'stopping' } : live);
                if (details.every((d) => d && (d.state === 'finished' || d.state === 'error'))) {
                    const ok = details.filter((d): d is LoadRunDetail => !!d?.result);
                    const lost = details.map((d, i) => (d?.result ? '' : `${o.generators[i].name}: ${d?.message ?? 'no result'}`)).filter(Boolean);
                    if (!ok.length) return end(undefined, `No generator finished: ${lost.join('; ')}`);
                    const merged = ok.length > 1 ? mergeRuns(ok).result! : ok[0].result!;
                    end(merged, lost.length ? `Results without ${lost.join('; ')} (their users are missing from the numbers).` : undefined);
                }
            } finally { busy = false; }
        }, o.pollMs ?? 1000);
    })().catch((e) => end(undefined, (e as Error).message));
    return {
        stop: () => { stopped = true; all((c, id) => c.stop(id)); },
        adjust: (factor) => all((c, id) => c.adjust(id, factor)),
        dispose: () => { if (timer) clearInterval(timer); },
        generators: () => health.map((h) => ({ ...h })),
    };
}
