/**
 * Main-thread side of the TypeScript worker. Calls are queued in order (the worker handles one
 * at a time). If the worker dies (out of memory on a huge project, a TypeScript crash) the next
 * call starts a fresh one, re-sending the files open in the editor.
 */
import * as path from 'path';
import { Worker } from 'worker_threads';
import type { TsCompletion, TsDiagnostic, TsLocation } from './tsService';

const CALL_TIMEOUT_MS = 120_000;

export class TsClient {
    private worker: Worker | null = null;
    private nextId = 1;
    private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
    private readonly open = new Map<string, string>();
    private started = false;

    constructor(private readonly root: string, private readonly workerFile = path.join(__dirname, 'tsWorker.js')) {}

    /** True once the worker has been asked to start (for the "TypeScript starting…" hint). */
    get isStarted(): boolean { return this.started; }

    private ensure(): Worker {
        if (this.worker) return this.worker;
        this.started = true;
        const w = new Worker(this.workerFile, { workerData: { root: this.root }, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
        w.unref();
        w.on('message', (m: { id: number; result?: unknown; error?: string }) => {
            const p = this.pending.get(m.id);
            if (!p) return;
            this.pending.delete(m.id);
            clearTimeout(p.timer);
            if (m.error !== undefined) p.reject(new Error(m.error)); else p.resolve(m.result);
        });
        const fail = (e: Error) => {
            if (this.worker !== w) return;
            this.worker = null;
            for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(e); this.pending.delete(id); }
        };
        w.on('error', fail);
        w.on('exit', (code) => fail(new Error(`TypeScript stopped (exit code ${code}). It restarts on the next request.`)));
        this.worker = w;
        for (const [f, t] of this.open) this.post(w, 'update', [f, t]).catch(() => undefined);
        return w;
    }

    private post<T>(w: Worker, method: string, args: unknown[]): Promise<T> {
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('TypeScript took too long to answer.')); }, CALL_TIMEOUT_MS);
            timer.unref();
            this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
            w.postMessage({ id, method, args });
        });
    }

    private call<T>(method: string, ...args: unknown[]): Promise<T> { return this.post<T>(this.ensure(), method, args); }

    update(abs: string, text: string | undefined): Promise<boolean> {
        if (text === undefined) this.open.delete(abs); else this.open.set(abs, text);
        if (text === undefined && !this.worker) return Promise.resolve(true);
        return this.call('update', abs, text);
    }
    diagnostics(abs: string) { return this.call<TsDiagnostic[]>('diagnostics', abs); }
    completions(abs: string, offset: number) { return this.call<TsCompletion[]>('completions', abs, offset); }
    quickInfo(abs: string, offset: number) { return this.call<{ text: string; doc: string } | null>('quickInfo', abs, offset); }
    definition(abs: string, offset: number) { return this.call<TsLocation[]>('definition', abs, offset); }
    references(abs: string, offset: number) { return this.call<TsLocation[]>('references', abs, offset); }
    format(abs: string) { return this.call<string>('format', abs); }
    projectDiagnostics(configAbs: string) { return this.call<TsDiagnostic[]>('projectDiagnostics', configAbs); }
    warmUp() { return this.call<boolean>('warmUp'); }
    info() { return this.call<{ version: string; tsconfig: string | null }>('info'); }

    async close(): Promise<void> {
        const w = this.worker;
        this.worker = null;
        for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('The Studio is stopping.')); this.pending.delete(id); }
        if (w) await w.terminate();
    }
}
