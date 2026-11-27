/**
 * Main-thread side of the TypeScript worker. The worker handles one call at a time; this side keeps
 * the queue, so what the person waits for comes first:
 *  - interactive calls (completions, their details, signature help, hover, go to definition) go ahead
 *    of background ones (diagnostics, find references, format), and a background call already running
 *    is asked to give way (a shared flag the language service checks): it runs again afterwards;
 *  - a newer completion / signature-help request for a file replaces one still waiting; diagnostics
 *    for a file waiting already are shared;
 *  - the editor's text goes with the next call (only files changed since the last one), so no call
 *    ever runs on older text than the newest the editor sent.
 * If the worker dies (out of memory on a huge project, a TypeScript crash) the next call starts a
 * fresh one, re-sending the files open in the editor.
 */
import * as path from 'path';
import { Worker } from 'worker_threads';
import type { TsCompletion, TsCompletionDetails, TsDiagnostic, TsLocation, TsSignatureHelp } from './tsService';

const CALL_TIMEOUT_MS = 120_000;
/** Calls the person waits for, in the editor. */
const INTERACTIVE = new Set(['completions', 'completionDetails', 'signatureHelp', 'quickInfo', 'definition']);
/** A newer one of these for the same file makes a waiting older one useless. */
const SUPERSEDE = new Set(['completions', 'signatureHelp', 'completionDetails', 'quickInfo']);
/** These for the same file give the same answer: share one. */
const SHARE = new Set(['diagnostics', 'projectDiagnostics', 'warmUp', 'info']);

/** A waiting call replaced by a newer one (the answer would be for text the editor no longer has). */
export class StaleCall extends Error { constructor() { super('Replaced by a newer request.'); } }

interface Job {
    method: string;
    args: unknown[];
    high: boolean;
    key: string;
    waiters: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }>;
    retries: number;
    queuedAt: number;
}

export class TsClient {
    private worker: Worker | null = null;
    private nextId = 1;
    private readonly open = new Map<string, string>();
    /** Files whose text the worker does not have yet (null: closed, the file on disk counts again). */
    private readonly dirty = new Map<string, string | null>();
    private readonly high: Job[] = [];
    private readonly low: Job[] = [];
    private running: { id: number; job: Job; timer: NodeJS.Timeout; queuedMs: number } | null = null;
    private flag: Int32Array | null = null;
    private started = false;
    /** Timings of the last calls (method, waited in the queue, ran in the worker), for diagnosis. */
    readonly timings: Array<{ method: string; queuedMs: number; runMs: number; at: number }> = [];

    constructor(private readonly root: string, private readonly workerFile = path.join(__dirname, 'tsWorker.js')) {}

    /** True once the worker has been asked to start (for the "TypeScript starting…" hint). */
    get isStarted(): boolean { return this.started; }

    private ensure(): Worker {
        if (this.worker) return this.worker;
        this.started = true;
        const sab = new SharedArrayBuffer(4);
        this.flag = new Int32Array(sab);
        const w = new Worker(this.workerFile, { workerData: { root: this.root, cancel: sab }, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
        w.unref();
        w.on('message', (m: { id: number; result?: unknown; error?: string; cancelled?: boolean; ms?: number }) => this.answer(m));
        const fail = (e: Error) => {
            if (this.worker !== w) return;
            this.worker = null;
            const r = this.running;
            this.running = null;
            if (r) { clearTimeout(r.timer); for (const x of r.job.waiters) x.reject(e); }
            // The editor's files go to the next worker with its first call.
            for (const [f, t] of this.open) this.dirty.set(f, t);
            this.pump();
        };
        w.on('error', fail);
        w.on('exit', (code) => fail(new Error(`TypeScript stopped (exit code ${code}). It restarts on the next request.`)));
        this.worker = w;
        for (const [f, t] of this.open) this.dirty.set(f, t);
        return w;
    }

    private answer(m: { id: number; result?: unknown; error?: string; cancelled?: boolean; ms?: number }) {
        const r = this.running;
        if (!r || r.id !== m.id) return;
        this.running = null;
        clearTimeout(r.timer);
        if (this.flag) Atomics.store(this.flag, 0, 0);
        const job = r.job;
        this.timings.push({ method: job.method, queuedMs: r.queuedMs, runMs: m.ms ?? 0, at: Date.now() });
        if (this.timings.length > 50) this.timings.shift();
        if (m.cancelled && job.retries < 5) { job.retries++; (job.high ? this.high : this.low).unshift(job); }
        else if (m.cancelled) for (const x of job.waiters) x.reject(new Error('TypeScript was busy: try again.'));
        else if (m.error !== undefined) for (const x of job.waiters) x.reject(new Error(m.error));
        else for (const x of job.waiters) x.resolve(m.result);
        this.pump();
    }

    /** Send the next call to the worker (interactive ones first). */
    private pump() {
        if (this.running) return;
        const job = this.high.shift() ?? this.low.shift();
        if (!job) return;
        let w: Worker;
        try { w = this.ensure(); } catch (e) { for (const x of job.waiters) x.reject(e as Error); this.pump(); return; }
        const id = this.nextId++;
        const sync = [...this.dirty.entries()];
        this.dirty.clear();
        const timer = setTimeout(() => {
            if (this.running?.id !== id) return;
            this.running = null;
            for (const x of job.waiters) x.reject(new Error('TypeScript took too long to answer.'));
            // A worker stuck that long is replaced.
            const old = this.worker; this.worker = null; void old?.terminate();
            for (const [f, t] of this.open) this.dirty.set(f, t);
            this.pump();
        }, CALL_TIMEOUT_MS);
        timer.unref();
        this.running = { id, job, timer, queuedMs: Date.now() - job.queuedAt };
        w.postMessage({ id, method: job.method, args: job.args, sync });
    }

    private call<T>(method: string, ...args: unknown[]): Promise<T> {
        const high = INTERACTIVE.has(method);
        const key = `${method}\0${String(args[0] ?? '')}`;
        return new Promise<T>((resolve, reject) => {
            const waiter = { resolve: resolve as (v: unknown) => void, reject };
            const q = high ? this.high : this.low;
            if (SHARE.has(method)) {
                const same = q.find((j) => j.key === key && JSON.stringify(j.args) === JSON.stringify(args));
                if (same) { same.waiters.push(waiter); return; }
            }
            if (SUPERSEDE.has(method)) {
                for (let i = q.length - 1; i >= 0; i--) if (q[i].key === key) { for (const x of q[i].waiters) x.reject(new StaleCall()); q.splice(i, 1); }
            }
            q.push({ method, args, high, key, waiters: [waiter], retries: 0, queuedAt: Date.now() });
            // A background call running now gives way (it runs again after this one).
            if (high && this.running && !this.running.job.high && this.flag) Atomics.store(this.flag, 0, 1);
            this.pump();
        });
    }

    /** The editor's current text of a file (undefined: closed or saved, the file on disk counts). Sent with the next call. */
    update(abs: string, text: string | undefined): Promise<boolean> {
        if (text === undefined) this.open.delete(abs); else this.open.set(abs, text);
        if (text === undefined && !this.worker) { this.dirty.delete(abs); return Promise.resolve(true); }
        this.dirty.set(abs, text ?? null);
        return Promise.resolve(true);
    }
    diagnostics(abs: string) { return this.call<TsDiagnostic[]>('diagnostics', abs); }
    completions(abs: string, offset: number) { return this.call<TsCompletion[]>('completions', abs, offset); }
    completionDetails(abs: string, offset: number, name: string, source?: string, data?: unknown) { return this.call<TsCompletionDetails | null>('completionDetails', abs, offset, name, source, data); }
    signatureHelp(abs: string, offset: number, trigger?: string) { return this.call<TsSignatureHelp | null>('signatureHelp', abs, offset, trigger); }
    quickInfo(abs: string, offset: number) { return this.call<{ text: string; doc: string } | null>('quickInfo', abs, offset); }
    definition(abs: string, offset: number) { return this.call<TsLocation[]>('definition', abs, offset); }
    references(abs: string, offset: number) { return this.call<Array<TsLocation & { definition?: boolean; write?: boolean }>>('references', abs, offset); }
    format(abs: string) { return this.call<string>('format', abs); }
    projectDiagnostics(configAbs: string) { return this.call<TsDiagnostic[]>('projectDiagnostics', configAbs); }
    /** Build the program of the project a file belongs to (the repository's root project without one). */
    warmUp(abs?: string) { return this.call<boolean>('warmUp', ...(abs ? [abs] : [])); }
    info() { return this.call<{ version: string; tsconfig: string | null }>('info'); }

    async close(): Promise<void> {
        const w = this.worker;
        this.worker = null;
        const all = [...this.high, ...this.low, ...(this.running ? [this.running.job] : [])];
        if (this.running) clearTimeout(this.running.timer);
        this.running = null;
        this.high.length = 0; this.low.length = 0;
        for (const j of all) for (const x of j.waiters) x.reject(new Error('The Studio is stopping.'));
        if (w) await w.terminate();
    }
}
