/**
 * Runs a load test in a worker thread, so the Studio stays responsive while thousands of requests
 * are measured. Messages: in 'stop'; out { kind: 'second', snapshot } and { kind: 'done', result } or
 * { kind: 'error', message }.
 */
import { parentPort, workerData } from 'worker_threads';
import { connection, NetworkSettings } from '../core/network';
import { EngineInput, LoadEngine } from './engine';
import type { SystemProxy } from '../core/systemProxy';

interface Data { input: Omit<EngineInput, 'connection'>; network?: NetworkSettings; proxyPassword?: string; netExtras?: { system?: SystemProxy; pacScript?: string; secrets?: Record<string, string> }; env: Record<string, string> }

if (parentPort) {
    const d = workerData as Data;
    const x = d.netExtras ?? {};
    const conn = d.network ? connection(d.network, d.env, d.proxyPassword, { system: x.system, pacScript: x.pacScript, secret: (name) => x.secrets?.[name] }) : undefined;
    const engine = new LoadEngine({ ...d.input, connection: conn });
    parentPort.on('message', (m) => { if (m === 'stop') engine.stop('stopped'); else if (m && typeof m === 'object' && m.kind === 'adjust') engine.adjust(Number(m.factor)); });
    engine.run((s) => parentPort!.postMessage({ kind: 'second', snapshot: s }))
        .then((result) => parentPort!.postMessage({ kind: 'done', result }))
        .catch((e: Error) => parentPort!.postMessage({ kind: 'error', message: e.message }));
}
