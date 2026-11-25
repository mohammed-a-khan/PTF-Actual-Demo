/**
 * Runs the TypeScript language service in a worker thread. Building a program for a framework
 * project takes seconds; done on the main thread it would freeze the whole Studio (Git, run
 * output, every request) while it works.
 */
import { parentPort, workerData } from 'worker_threads';
import { TsProjects } from './tsService';

const projects = new TsProjects((workerData as { root: string }).root);

type Call = { id: number; method: string; args: unknown[] };

parentPort!.on('message', (m: Call) => {
    try {
        const a = m.args as [string, ...unknown[]];
        let result: unknown;
        switch (m.method) {
            case 'update': projects.update(a[0], a[1] as string | undefined); result = true; break;
            case 'diagnostics': result = projects.for(a[0]).diagnostics(a[0]); break;
            case 'completions': result = projects.for(a[0]).completions(a[0], a[1] as number); break;
            case 'quickInfo': result = projects.for(a[0]).quickInfo(a[0], a[1] as number); break;
            case 'definition': result = projects.for(a[0]).definition(a[0], a[1] as number); break;
            case 'references': result = projects.for(a[0]).references(a[0], a[1] as number); break;
            case 'format': result = projects.for(a[0]).format(a[0]); break;
            case 'projectDiagnostics': result = projects.projectDiagnostics(a[0]); break;
            case 'warmUp': projects.warmUp(); result = true; break;
            case 'info': result = projects.info(); break;
            default: throw new Error(`Unknown method ${m.method}`);
        }
        parentPort!.postMessage({ id: m.id, result });
    } catch (e) {
        parentPort!.postMessage({ id: m.id, error: (e as Error).message });
    }
});
