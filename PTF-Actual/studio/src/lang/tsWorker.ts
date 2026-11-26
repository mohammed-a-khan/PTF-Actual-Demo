/**
 * Runs the TypeScript language service in a worker thread. Building a program for a framework
 * project takes seconds; done on the main thread it would freeze the whole Studio (Git, run
 * output, every request) while it works.
 *
 * Each call carries the editor texts that changed since the previous one. A shared flag (set by
 * tsClient.ts when the person waits for something) makes a long background call give way: the
 * language service checks it while it works, and this side between the steps of a call.
 */
import { parentPort, workerData } from 'worker_threads';
import { TsProjects } from './tsService';

const flag = new Int32Array((workerData as { cancel?: SharedArrayBuffer }).cancel ?? new SharedArrayBuffer(4));
const token = { isCancellationRequested: () => Atomics.load(flag, 0) === 1 };
const projects = new TsProjects((workerData as { root: string }).root, token);

type Call = { id: number; method: string; args: unknown[]; sync?: Array<[string, string | null]> };

const isCancel = (e: unknown) => !!e && typeof e === 'object' && (e as { constructor?: { name?: string } }).constructor?.name === 'OperationCanceledException';

parentPort!.on('message', (m: Call) => {
    const t0 = performance.now();
    try {
        for (const [f, text] of m.sync ?? []) projects.update(f, text ?? undefined);
        const a = m.args as [string, ...unknown[]];
        let result: unknown;
        switch (m.method) {
            case 'update': projects.update(a[0], a[1] as string | undefined); result = true; break;
            case 'diagnostics': result = projects.for(a[0]).diagnostics(a[0]); break;
            case 'completions': result = projects.for(a[0]).completions(a[0], a[1] as number); break;
            case 'completionDetails': result = projects.for(a[0]).completionDetails(a[0], a[1] as number, a[2] as string, a[3] as string | undefined, a[4]); break;
            case 'signatureHelp': result = projects.for(a[0]).signatureHelp(a[0], a[1] as number, a[2] as string | undefined); break;
            case 'quickInfo': result = projects.for(a[0]).quickInfo(a[0], a[1] as number); break;
            case 'definition': result = projects.for(a[0]).definition(a[0], a[1] as number); break;
            case 'references': result = projects.for(a[0]).references(a[0], a[1] as number); break;
            case 'format': result = projects.for(a[0]).format(a[0]); break;
            case 'projectDiagnostics': result = projects.projectDiagnostics(a[0]); break;
            case 'warmUp': projects.warmUp(a[0]); result = true; break;
            case 'info': result = projects.info(); break;
            default: throw new Error(`Unknown method ${m.method}`);
        }
        parentPort!.postMessage({ id: m.id, result, ms: Math.round(performance.now() - t0) });
    } catch (e) {
        if (isCancel(e)) parentPort!.postMessage({ id: m.id, cancelled: true, ms: Math.round(performance.now() - t0) });
        else parentPort!.postMessage({ id: m.id, error: (e as Error).message });
    }
});
