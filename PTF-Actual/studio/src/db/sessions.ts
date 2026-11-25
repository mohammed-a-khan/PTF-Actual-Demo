/**
 * Query processes of the Database screen (src/db/worker.ts): one per project + environment, started on
 * first use in the repository folder with the environment a test run of that project would get (the
 * Studio's secrets as environment variables). Each request has a deadline: a process that does not
 * answer in time is stopped (which also drops its connections, so the database ends the query). Stop
 * does the same on request. Idle processes are closed after a while.
 */
import { ChildProcess, fork } from 'child_process';
import * as path from 'path';

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
interface Proc { child: ChildProcess; pending: Map<number, Pending>; ready: Promise<void>; idle?: NodeJS.Timeout; stderr: string; busy: number }

export class DbSessions {
    private procs = new Map<string, Proc>();
    private seq = 0;

    constructor(private readonly o: { repoRoot: string; env: (project: string, environment: string) => Record<string, string>; idleMs?: number; memoryMb?: number; workerFile?: string }) {}

    private key(project: string, environment: string) { return `${project}|${environment}`; }

    private start(project: string, environment: string): Proc {
        const k = this.key(project, environment);
        const existing = this.procs.get(k);
        if (existing) return existing;
        const child = fork(this.o.workerFile ?? path.join(__dirname, 'worker.js'), [project, environment], {
            cwd: this.o.repoRoot,
            env: { ...process.env, ...this.o.env(project, environment), PROJECT: project, ENVIRONMENT: environment },
            execArgv: [`--max-old-space-size=${this.o.memoryMb ?? 1536}`],
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        const p: Proc = { child, pending: new Map(), stderr: '', busy: 0, ready: Promise.resolve() };
        p.ready = new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('The query process did not start.')), 30000);
            child.once('message', () => { clearTimeout(t); resolve(); });
            child.once('exit', () => { clearTimeout(t); reject(new Error(this.exitReason(p))); });
        });
        p.ready.catch(() => { /* reported to the request */ });
        child.stderr?.on('data', (d: Buffer) => { p.stderr = (p.stderr + d.toString()).slice(-4000); });
        child.on('message', (m: { id?: number; result?: unknown; error?: string; code?: string }) => {
            if (m.id === undefined) return;
            const w = p.pending.get(m.id);
            if (!w) return;
            p.pending.delete(m.id); clearTimeout(w.timer);
            if (m.error !== undefined) w.reject(Object.assign(new Error(m.error), { code: m.code })); else w.resolve(m.result);
        });
        child.on('exit', () => {
            if (this.procs.get(k) === p) this.procs.delete(k);
            for (const w of p.pending.values()) { clearTimeout(w.timer); w.reject(new Error(this.exitReason(p))); }
            p.pending.clear();
        });
        this.procs.set(k, p);
        return p;
    }

    private exitReason(p: Proc): string {
        if (p.child.signalCode === 'SIGTERM' || p.child.signalCode === 'SIGKILL') return 'Stopped.';
        if (/heap out of memory|Allocation failed/i.test(p.stderr)) return 'The result is too large for the Studio (the query process ran out of memory). Narrow the query (WHERE, TOP / LIMIT) or select fewer columns.';
        return `The query process ended unexpectedly.${p.stderr.trim() ? ` ${p.stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`;
    }

    async request<T>(project: string, environment: string, msg: Record<string, unknown>, deadlineMs: number): Promise<T> {
        const p = this.start(project, environment);
        await p.ready;
        if (p.idle) clearTimeout(p.idle);
        const id = ++this.seq;
        p.busy++;
        try {
            return await new Promise<T>((resolve, reject) => {
                // Past the deadline the process is stopped: its connections drop and the database ends the work.
                const timer = setTimeout(() => { p.pending.delete(id); reject(new Error(`No answer within ${Math.round(deadlineMs / 1000)} s: the query was stopped.`)); this.stop(project, environment); }, deadlineMs);
                p.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
                p.child.send({ id, ...msg });
            });
        } finally {
            p.busy--;
            if (!p.busy && this.procs.get(this.key(project, environment)) === p) {
                p.idle = setTimeout(() => this.stop(project, environment), this.o.idleMs ?? 10 * 60_000);
                p.idle.unref();
            }
        }
    }

    running(project: string, environment: string): boolean { return (this.procs.get(this.key(project, environment))?.busy ?? 0) > 0; }

    /** Stop the process (and so every query it runs); the next request starts a new one. */
    stop(project: string, environment: string): boolean {
        const p = this.procs.get(this.key(project, environment));
        if (!p) return false;
        this.procs.delete(this.key(project, environment));
        if (p.idle) clearTimeout(p.idle);
        p.child.kill('SIGTERM');
        setTimeout(() => { if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill('SIGKILL'); }, 3000).unref();
        return true;
    }

    stopAll() { for (const k of [...this.procs.keys()]) { const [a, b] = k.split('|'); this.stop(a, b); } }
}
