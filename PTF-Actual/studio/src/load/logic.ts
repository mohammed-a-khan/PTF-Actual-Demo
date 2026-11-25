/**
 * Logic of a load user path (as in NeoLoad's design): Init (once per user), Actions (every iteration) and End (once,
 * when the user stops), made of steps:
 *   request      one request of the collection (its own think time, optional)
 *   transaction  steps measured together as one transaction (each request is still measured on its own)
 *   loop         steps a number of times, or while a condition holds (a maximum keeps it finite)
 *   if / switch  steps chosen by a condition or a value
 *   try          steps; when one fails, the catch steps (the failure is still counted)
 *   waitUntil    repeat steps (or just wait) until a condition holds, or a time is up
 *   delay        a pause; js: JavaScript that sets values (vars.name = …)
 *   fork         branches run at the same time by the user (like a browser's parallel requests)
 *   rendezvous   users wait for each other, then go together (a number or a share of the running users)
 *   queuePut / queueTake   values handed from user to user (an order one user makes, another approves)
 *   generate     a value made per use: counter, random number, random text, date, uuid
 *   nextRow      the next row of the test data, in the middle of an iteration
 * Conditions and JavaScript see `vars` (the user's values: data row, saved values) and `last` (the last response:
 * status, body, json, headers, ok); they run in a sandbox with a time limit.
 */
import * as vm from 'vm';
import { randomUUID } from 'crypto';

export type PathStep =
    | { kind: 'request'; id: string; think?: { min: number; max: number } }
    | { kind: 'transaction'; name: string; steps: PathStep[] }
    | { kind: 'loop'; count?: number; while?: string; max?: number; steps: PathStep[] }
    | { kind: 'if'; condition: string; then: PathStep[]; else?: PathStep[] }
    | { kind: 'switch'; value: string; cases: Array<{ equals: string; steps: PathStep[] }>; default?: PathStep[] }
    | { kind: 'try'; steps: PathStep[]; catch: PathStep[] }
    | { kind: 'waitUntil'; condition: string; steps?: PathStep[]; everyMs?: number; timeoutMs: number }
    | { kind: 'delay'; ms: number }
    | { kind: 'js'; code: string }
    | { kind: 'fork'; branches: PathStep[][] }
    | { kind: 'rendezvous'; name: string; users?: number; percent?: number; timeoutMs: number }
    | { kind: 'queuePut'; queue: string; value: string }
    | { kind: 'queueTake'; queue: string; into: string; timeoutMs: number }
    | { kind: 'generate'; into: string; type: 'counter' | 'random' | 'text' | 'date' | 'uuid'; min?: number; max?: number; length?: number; format?: string; start?: number }
    | { kind: 'nextRow' };

export interface PathLogic { init?: PathStep[]; actions: PathStep[]; end?: PathStep[] }

const KINDS = ['request', 'transaction', 'loop', 'if', 'switch', 'try', 'waitUntil', 'delay', 'js', 'fork', 'rendezvous', 'queuePut', 'queueTake', 'generate', 'nextRow'];

/** A path's problems (empty: it runs): unknown requests, steps without what they need, too deep. */
export function logicProblems(l: PathLogic, requestIds: Set<string>): string[] {
    const out: string[] = [];
    let n = 0;
    const walk = (steps: unknown, where: string, depth: number) => {
        if (!Array.isArray(steps)) { out.push(`${where}: not a list of steps`); return; }
        if (depth > 12) { out.push(`${where}: nested too deep`); return; }
        steps.forEach((s0, i) => {
            const s = s0 as PathStep;
            const at = `${where} › ${i + 1}`;
            if (++n > 2000) return;
            if (!s || !KINDS.includes((s as { kind: string }).kind)) { out.push(`${at}: unknown step`); return; }
            switch (s.kind) {
                case 'request': if (!requestIds.has(s.id)) out.push(`${at}: no request ${s.id} in the collection`); break;
                case 'transaction': if (!s.name?.trim()) out.push(`${at}: a transaction needs a name`); walk(s.steps, `${at} ${s.name}`, depth + 1); break;
                case 'loop': if (!(s.count && s.count > 0) && !s.while?.trim()) out.push(`${at}: a loop needs a count or a condition`); walk(s.steps, `${at} loop`, depth + 1); break;
                case 'if': if (!s.condition?.trim()) out.push(`${at}: if needs a condition`); walk(s.then, `${at} then`, depth + 1); if (s.else) walk(s.else, `${at} else`, depth + 1); break;
                case 'switch': if (!s.value?.trim()) out.push(`${at}: switch needs a value`); (s.cases ?? []).forEach((c, j) => walk(c.steps, `${at} case ${j + 1}`, depth + 1)); if (s.default) walk(s.default, `${at} default`, depth + 1); break;
                case 'try': walk(s.steps, `${at} try`, depth + 1); walk(s.catch, `${at} catch`, depth + 1); break;
                case 'waitUntil': if (!s.condition?.trim()) out.push(`${at}: wait until needs a condition`); if (!(s.timeoutMs > 0)) out.push(`${at}: wait until needs a time limit`); if (s.steps) walk(s.steps, `${at} wait`, depth + 1); break;
                case 'delay': if (!(s.ms >= 0) || s.ms > 3_600_000) out.push(`${at}: a delay of 0 to 3600000 ms`); break;
                case 'js': if (typeof s.code !== 'string') out.push(`${at}: no JavaScript`); else { try { new vm.Script(`(async () => { ${s.code}\n })`); } catch (e) { out.push(`${at}: ${(e as Error).message}`); } } break;
                case 'fork': if (!Array.isArray(s.branches) || s.branches.length < 2) out.push(`${at}: fork needs at least two branches`); else s.branches.forEach((b, j) => walk(b, `${at} branch ${j + 1}`, depth + 1)); break;
                case 'rendezvous': if (!s.name?.trim() || !((s.users ?? 0) > 0 || ((s.percent ?? 0) > 0 && (s.percent ?? 0) <= 100))) out.push(`${at}: a rendezvous needs a name and a number or share of users`); break;
                case 'queuePut': if (!s.queue?.trim()) out.push(`${at}: which queue`); break;
                case 'queueTake': if (!s.queue?.trim() || !/^[\w.-]+$/.test(s.into ?? '')) out.push(`${at}: which queue, and the value's name`); break;
                case 'generate': if (!/^[\w.-]+$/.test(s.into ?? '')) out.push(`${at}: the value's name`); break;
                case 'nextRow': break;
            }
        });
    };
    walk(l.actions, 'Actions', 0);
    if (l.init) walk(l.init, 'Init', 0);
    if (l.end) walk(l.end, 'End', 0);
    return out;
}

/** What users share during a run: rendezvous, queues, counters. One per load generator. */
export class PathShared {
    private rdv = new Map<string, Array<() => void>>();
    private queues = new Map<string, string[]>();
    private takers = new Map<string, Array<(v: string | null) => void>>();
    private counters = new Map<string, number>();
    /** Released rendezvous (name → how many times), for the results. */
    readonly released = new Map<string, number>();
    constructor(private readonly activeUsers: () => number, private readonly stopped: () => boolean) {}

    /** Wait at a rendezvous until enough users are there (or the time is up, or the run stops). */
    rendezvous(name: string, need: { users?: number; percent?: number }, timeoutMs: number): Promise<'released' | 'timeout'> {
        const target = () => Math.max(1, need.users ?? Math.ceil(((need.percent ?? 100) / 100) * this.activeUsers()));
        return new Promise((resolve) => {
            const list = this.rdv.get(name) ?? [];
            let done = false;
            const go = () => { if (done) return; done = true; clearTimeout(timer); resolve('released'); };
            const timer = setTimeout(() => { if (done) return; done = true; this.rdv.set(name, (this.rdv.get(name) ?? []).filter((f) => f !== go)); resolve('timeout'); }, timeoutMs);
            list.push(go);
            this.rdv.set(name, list);
            if (list.length >= target() || this.stopped()) this.release(name);
        });
    }
    private release(name: string) {
        const list = this.rdv.get(name) ?? [];
        this.rdv.set(name, []);
        this.released.set(name, (this.released.get(name) ?? 0) + 1);
        for (const f of list) f();
    }
    /** The run is stopping: nobody waits any more. */
    releaseAll() { for (const [n, w] of [...this.rdv]) if (w.length) this.release(n); for (const [q, t] of this.takers) { for (const f of t) f(null); this.takers.set(q, []); } }

    put(queue: string, value: string) {
        const waiting = this.takers.get(queue);
        const t = waiting?.shift();
        if (t) { t(value); return; }
        const q = this.queues.get(queue) ?? [];
        if (q.length < 100_000) q.push(value);
        this.queues.set(queue, q);
    }
    take(queue: string, timeoutMs: number): Promise<string | null> {
        const q = this.queues.get(queue);
        if (q?.length) return Promise.resolve(q.shift()!);
        return new Promise((resolve) => {
            const list = this.takers.get(queue) ?? [];
            let done = false;
            const f = (v: string | null) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
            const timer = setTimeout(() => { if (done) return; done = true; this.takers.set(queue, (this.takers.get(queue) ?? []).filter((x) => x !== f)); resolve(null); }, timeoutMs);
            list.push(f);
            this.takers.set(queue, list);
        });
    }
    counter(name: string, start: number): number { const n = this.counters.has(name) ? this.counters.get(name)! + 1 : start; this.counters.set(name, n); return n; }
}

export interface LastResponse { status: number; body: string; json?: unknown; headers: Record<string, string>; ok: boolean }

/** What the interpreter needs from the user path. */
export interface PathHost {
    /** Run one request as a measured transaction; its outcome (null: passed) and the response. */
    request(id: string): Promise<{ error: string | null; last?: LastResponse }>;
    /** Measure steps together as one transaction. */
    transaction(name: string, fn: () => Promise<string | null>): Promise<string | null>;
    think(range?: { min: number; max: number }): Promise<void>;
    sleep(ms: number): Promise<void>;
    stopped(): boolean;
    vars: Record<string, string>;
    nextRow(): void;
    shared: PathShared;
}

const ctxFor = (vars: Record<string, string>, last: LastResponse | undefined) => vm.createContext({ vars, last: last ?? { status: 0, body: '', headers: {}, ok: false }, JSON, Math, Date, Number, String, Boolean, parseInt, parseFloat, Array, Object, RegExp });

/** A condition (JavaScript expression) over vars and last. */
export function condition(expr: string, vars: Record<string, string>, last?: LastResponse): boolean {
    try { return !!new vm.Script(`(${expr})`).runInContext(ctxFor(vars, last), { timeout: 50 }); } catch (e) { throw new Error(`The condition ${expr} failed: ${(e as Error).message}`); }
}
export function value(expr: string, vars: Record<string, string>, last?: LastResponse): string {
    try { const v = new vm.Script(`(${expr})`).runInContext(ctxFor(vars, last), { timeout: 50 }); return typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { throw new Error(`The value ${expr} failed: ${(e as Error).message}`); }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
function formatDate(d: Date, f = 'YYYY-MM-DD'): string {
    return f.replace(/YYYY/g, String(d.getFullYear())).replace(/MM/g, pad(d.getMonth() + 1)).replace(/DD/g, pad(d.getDate())).replace(/HH/g, pad(d.getHours())).replace(/mm/g, pad(d.getMinutes())).replace(/ss/g, pad(d.getSeconds()));
}

/** Run steps for one user; an error stops the steps (a try catches it). Returns the first error, or null. */
export async function runSteps(steps: PathStep[], h: PathHost, state: { last?: LastResponse } = {}): Promise<string | null> {
    for (const s of steps) {
        if (h.stopped()) return null;
        const err = await runStep(s, h, state);
        if (err) return err;
    }
    return null;
}

async function runStep(s: PathStep, h: PathHost, state: { last?: LastResponse }): Promise<string | null> {
    switch (s.kind) {
        case 'request': {
            const r = await h.request(s.id);
            if (r.last) state.last = r.last;
            await h.think(s.think);
            return r.error;
        }
        case 'transaction': return h.transaction(s.name, () => runSteps(s.steps, h, state));
        case 'loop': {
            const max = Math.min(s.max ?? 10_000, 100_000);
            for (let i = 0; i < (s.count ?? max) && i < max && !h.stopped(); i++) {
                h.vars.loopIndex = String(i);
                if (s.while && !condition(s.while, h.vars, state.last)) break;
                const e = await runSteps(s.steps, h, state);
                if (e) return e;
            }
            return null;
        }
        case 'if': return runSteps(condition(s.condition, h.vars, state.last) ? s.then : s.else ?? [], h, state);
        case 'switch': {
            const v = value(s.value, h.vars, state.last);
            const c = s.cases.find((x) => x.equals === v);
            return runSteps(c ? c.steps : s.default ?? [], h, state);
        }
        case 'try': {
            const e = await runSteps(s.steps, h, state);
            if (!e) return null;
            h.vars.lastError = e;
            return runSteps(s.catch, h, state);
        }
        case 'waitUntil': {
            const until = Date.now() + s.timeoutMs;
            for (;;) {
                if (condition(s.condition, h.vars, state.last)) return null;
                if (Date.now() >= until || h.stopped()) return `Waited ${s.timeoutMs} ms: ${s.condition} never held`;
                if (s.steps?.length) { const e = await runSteps(s.steps, h, state); if (e) return e; }
                await h.sleep(Math.max(10, s.everyMs ?? 1000));
            }
        }
        case 'delay': await h.sleep(s.ms); return null;
        case 'js': {
            const ctx = ctxFor(h.vars, state.last);
            try {
                const p = new vm.Script(`(async () => { ${s.code}\n })()`).runInContext(ctx, { timeout: 200 }) as Promise<unknown>;
                await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('took more than 5 s')), 5000))]);
            } catch (e) { return `JavaScript: ${(e as Error).message}`; }
            for (const [k, v] of Object.entries(h.vars)) if (typeof v !== 'string') h.vars[k] = typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
            return null;
        }
        case 'fork': {
            const errs = await Promise.all(s.branches.map((b) => runSteps(b, h, { ...state })));
            return errs.find((e) => e) ?? null;
        }
        case 'rendezvous': {
            const r = await h.shared.rendezvous(s.name, { users: s.users, percent: s.percent }, s.timeoutMs);
            h.vars[`rendezvous_${s.name}`] = r;
            return null;
        }
        case 'queuePut': h.shared.put(s.queue, value(JSON.stringify(s.value).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, '" + (vars["$1"] ?? "") + "'), h.vars, state.last)); return null;
        case 'queueTake': {
            const v = await h.shared.take(s.queue, s.timeoutMs);
            if (v === null) return h.stopped() ? null : `Nothing in the queue ${s.queue} within ${s.timeoutMs} ms`;
            h.vars[s.into] = v;
            return null;
        }
        case 'generate': {
            const min = s.min ?? 0, max = s.max ?? 1_000_000;
            h.vars[s.into] = s.type === 'counter' ? String(h.shared.counter(s.into, s.start ?? 1))
                : s.type === 'random' ? String(Math.floor(min + Math.random() * (max - min + 1)))
                    : s.type === 'text' ? Array.from({ length: Math.max(1, Math.min(s.length ?? 8, 1000)) }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('')
                        : s.type === 'date' ? formatDate(new Date(Date.now() + (s.min ?? 0) * 86_400_000), s.format)
                            : randomUUID();
            return null;
        }
        case 'nextRow': h.nextRow(); return null;
    }
}
