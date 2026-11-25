/**
 * Load runs of this project: one at a time, in a worker thread; live progress for the screen; the
 * result kept in <git dir>/cs-studio/load-runs/<id>.json (this computer only) for history,
 * comparison and the JUnit file a pipeline reads.
 */
import * as fs from 'fs';
import type { SystemProxy } from '../core/systemProxy';
import * as path from 'path';
import { Worker } from 'worker_threads';
import type { NetworkSettings } from '../core/network';
import type { EngineInput, RunResult, Snapshot } from './engine';
import { LoadScenario, validScenario } from './scenario';
import { maxUsers } from './policy';
import { regression } from './analysis';
import type { GeneratorHealth } from './generators';

export interface LoadRunInfo {
    id: string;
    scenario: string;          // scenario file
    name: string;
    project: string;
    env: string;
    startedAt: string;
    state: 'running' | 'stopping' | 'finished' | 'error';
    maxUsers: number;
    duration: number;
    message?: string;
    /** Finished runs: the verdict and the main numbers. */
    passed?: boolean;
    stopReason?: RunResult['stopReason'];
    /** The load was changed during the run (1: as planned). */
    loadFactor?: number;
    summary?: { requests: number; errorRate: number; avg: number; p95: number; throughput: number };
    /** This run is its scenario's baseline (the regression gate compares later runs with it). */
    baseline?: boolean;
}
export interface LoadRunDetail extends LoadRunInfo { live?: Snapshot; result?: RunResult; definition: LoadScenario; generators?: GeneratorHealth[] }

/** What runs a test: a worker thread on this computer, or load generators (controller.ts). */
export interface RunHandle { stop(): void; adjust(factor: number): void; dispose(): void; generators?(): GeneratorHealth[] }

type Running = { info: LoadRunInfo; handle: RunHandle; live?: Snapshot; definition: LoadScenario };

export class LoadRuns {
    /** Runs in progress (several at once, up to maxConcurrent; one scenario runs once at a time). */
    private readonly active = new Map<string, { info: LoadRunInfo; handle: RunHandle; live?: Snapshot; definition: LoadScenario }>();
    constructor(private readonly dir: string, private readonly workerFile: string, private readonly maxConcurrent = 3) {}

    private file(id: string) {
        if (!/^[\w-]{1,80}$/.test(id)) throw new Error('Invalid run id.');
        return path.join(this.dir, `${id}.json`);
    }

    running(): LoadRunInfo | null { return [...this.active.values()][0]?.info ?? null; }
    /** Every run in progress. */
    runningAll(): LoadRunInfo[] { return [...this.active.values()].map((c) => c.info); }
    private canStart(scenarioFile: string, name: string) {
        const same = [...this.active.values()].find((c) => c.info.scenario === scenarioFile);
        if (same) throw new Error(`${name} is already running. Stop it first.`);
        if (this.active.size >= this.maxConcurrent) throw new Error(`${this.active.size} load tests are running already (at most ${this.maxConcurrent} at once on this computer). Stop one first.`);
    }

    start(o: { scenarioFile: string; project: string; env: string; definition: LoadScenario; input: Omit<EngineInput, 'connection'>; network?: NetworkSettings; proxyPassword?: string; netExtras?: { system?: SystemProxy; pacScript?: string; secrets?: Record<string, string> } }): LoadRunInfo {
        this.canStart(o.scenarioFile, o.definition.name);
        const id = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 8);
        const info: LoadRunInfo = { id, scenario: o.scenarioFile, name: o.definition.name, project: o.project, env: o.env, startedAt: new Date().toISOString(), state: 'running', maxUsers: maxUsers(o.definition.policy), duration: o.definition.policy.duration };
        const env: Record<string, string> = {};
        for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) if (process.env[k]) env[k] = process.env[k]!;
        const worker = new Worker(this.workerFile, { workerData: { input: o.input, network: o.network, proxyPassword: o.proxyPassword, netExtras: o.netExtras, env } });
        const handle: RunHandle = { stop: () => worker.postMessage('stop'), adjust: (factor) => worker.postMessage({ kind: 'adjust', factor }), dispose: () => { void worker.terminate(); } };
        const cur = { info, handle, definition: o.definition } as Running;
        this.active.set(id, cur);
        worker.on('message', (m: { kind: string; snapshot?: Snapshot; result?: RunResult; message?: string }) => {
            if (m.kind === 'second' && m.snapshot) { cur.live = m.snapshot; cur.info.state = m.snapshot.state === 'stopping' ? 'stopping' : 'running'; }
            if (m.kind === 'done' && m.result) this.finish(cur, m.result);
            if (m.kind === 'error') this.finish(cur, undefined, m.message);
        });
        worker.on('error', (e) => this.finish(cur, undefined, e.message));
        worker.on('exit', () => { if (this.active.get(id) === cur) this.finish(cur, undefined, 'The load test stopped unexpectedly.'); });
        return info;
    }

    /**
     * A run on load generators (each runs its part of the users; see controller.ts): the live numbers are theirs
     * added up, the result their parts merged.
     */
    startDistributed(o: { scenarioFile: string; project: string; env: string; definition: LoadScenario; run: (cb: { live: (s: Snapshot) => void; done: (r?: RunResult, message?: string) => void }) => RunHandle }): LoadRunInfo {
        this.canStart(o.scenarioFile, o.definition.name);
        const id = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 8);
        const info: LoadRunInfo = { id, scenario: o.scenarioFile, name: o.definition.name, project: o.project, env: o.env, startedAt: new Date().toISOString(), state: 'running', maxUsers: maxUsers(o.definition.policy), duration: o.definition.policy.duration };
        const cur = { info, definition: o.definition } as Running;
        this.active.set(id, cur);
        cur.handle = o.run({ live: (s) => { cur.live = s; if (cur.info.state === 'running' && s.state === 'stopping') cur.info.state = 'stopping'; }, done: (r, m) => this.finish(cur, r, m) });
        return info;
    }

    /** Change the load of the running test: the policy's users (and rate) times `factor`. */
    adjust(id: string, factor: number): boolean {
        const cur = this.active.get(id);
        if (!cur || cur.info.state !== 'running') return false;
        cur.handle.adjust(factor);
        cur.info.loadFactor = factor;
        return true;
    }

    stop(id: string): boolean {
        const cur = this.active.get(id);
        if (!cur) return false;
        cur.info.state = 'stopping';
        cur.handle.stop();
        return true;
    }

    private finish(cur: Running, result?: RunResult, message?: string) {
        if (this.active.get(cur.info.id) !== cur) return;
        this.active.delete(cur.info.id);
        const info: LoadRunInfo = { ...cur.info, state: result ? 'finished' : 'error', ...(message ? { message } : {}) };
        if (result) {
            // The regression gate: this run against its scenario's baseline (a failing gate fails the run).
            const gate = cur.definition.regression;
            const baseId = gate ? this.baselineOf(info.scenario) : null;
            const base = baseId ? this.get(baseId) : null;
            if (gate && base?.result) {
                const g = regression(result, base.result, gate);
                result.slas.push({ sla: { target: 'baseline' }, name: `Regression against the baseline of ${new Date(base.startedAt).toLocaleString()}`, pass: g.pass, level: g.pass ? 'pass' : 'fail', details: g.details });
                result.passed &&= g.pass;
            }
            info.passed = result.passed; info.stopReason = result.stopReason;
            info.summary = { requests: result.total.count, errorRate: result.total.errorRate, avg: result.total.avg, p95: result.total.p95, throughput: result.total.throughput };
        }
        fs.mkdirSync(this.dir, { recursive: true });
        const gens = cur.handle.generators?.();
        fs.writeFileSync(this.file(info.id), JSON.stringify({ ...info, definition: cur.definition, result, ...(gens ? { generators: gens } : {}) }));
        if (cur.handle.generators) (cur as { generators?: GeneratorHealth[] }).generators = cur.handle.generators();
        cur.handle.dispose();
    }

    list(): LoadRunInfo[] {
        const out: LoadRunInfo[] = this.runningAll();
        let names: string[] = [];
        try { names = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch { /* none yet */ }
        for (const f of names.sort().reverse().slice(0, 300)) {
            try { const { definition: _d, result: _r, ...info } = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as LoadRunDetail; void _d; void _r; out.push(info); } catch { /* skip */ }
        }
        const b = new Set(Object.values(this.baselines()));
        return out.map((x) => (b.has(x.id) ? { ...x, baseline: true } : x));
    }

    get(id: string): LoadRunDetail | null {
        const cur = this.active.get(id);
        if (cur) return { ...cur.info, live: cur.live, definition: cur.definition, ...(cur.handle.generators ? { generators: cur.handle.generators() } : {}) };
        try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as LoadRunDetail; } catch { return null; }
    }

    /** Results produced elsewhere (a pipeline's --json, or merged parts), kept like a run of this computer. */
    importRun(d: LoadRunDetail): LoadRunInfo {
        const r = d.result;
        if (!r || !Array.isArray(r.transactions) || !Array.isArray(r.timeline) || !r.total || !Array.isArray(r.slas)) throw new Error('This is not the results file of a load run (cs-test-studio load … --json).');
        validScenario(d.definition);
        const id = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 8);
        const info: LoadRunInfo = {
            id, scenario: String(d.scenario), name: String(d.name), project: String(d.project), env: String(d.env), startedAt: String(r.startedAt ?? d.startedAt), state: 'finished',
            maxUsers: Number(d.maxUsers) || 0, duration: Number(d.duration) || 0, passed: !!r.passed, stopReason: r.stopReason,
            summary: { requests: r.total.count, errorRate: r.total.errorRate, avg: r.total.avg, p95: r.total.p95, throughput: r.total.throughput },
            message: d.message ? String(d.message).slice(0, 300) : 'Imported results.',
        };
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(this.file(id), JSON.stringify({ ...info, definition: d.definition, result: r }));
        return info;
    }

    private get baselinesFile() { return path.join(path.dirname(this.dir), 'load-baselines.json'); }
    private baselines(): Record<string, string> { try { return JSON.parse(fs.readFileSync(this.baselinesFile, 'utf8')); } catch { return {}; } }
    /** The baseline run of a scenario file (if it still exists). */
    baselineOf(scenario: string): string | null { const id = this.baselines()[scenario]; return id && fs.existsSync(this.file(id)) ? id : null; }
    /** Make a finished run its scenario's baseline (or no baseline). */
    setBaseline(id: string, on: boolean): void {
        const d = this.get(id);
        if (!d || d.state !== 'finished' || !d.result) throw new Error('Only a finished run can be the baseline.');
        const b = this.baselines();
        if (on) b[d.scenario] = id; else if (b[d.scenario] === id) delete b[d.scenario];
        fs.mkdirSync(path.dirname(this.baselinesFile), { recursive: true });
        fs.writeFileSync(this.baselinesFile, JSON.stringify(b, null, 2));
    }

    remove(id: string): boolean {
        if (this.active.has(id)) return false;
        try { fs.rmSync(this.file(id)); return true; } catch { return false; }
    }
}

/** JUnit XML for a pipeline: one test case per SLA (and one for the run itself). */
export function junit(run: LoadRunDetail): string {
    const r = run.result;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const cases: string[] = [];
    const runOk = !!r && r.stopReason !== 'error-rate';
    cases.push(`    <testcase classname="load.${esc(run.name)}" name="Run completed" time="${r ? r.elapsed : 0}">${runOk ? '' : `<failure message="${esc(r ? 'Stopped: error rate too high' : run.message ?? 'Did not finish')}"/>`}</testcase>`);
    for (const s of r?.slas ?? []) cases.push(`    <testcase classname="load.${esc(run.name)}" name="SLA ${esc(s.name)}" time="0">${s.pass ? '' : `<failure message="${esc(s.details.join('; '))}"/>`}<system-out>${esc(s.details.join('\n'))}</system-out></testcase>`);
    const failures = cases.filter((c) => c.includes('<failure')).length;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${esc(run.name)}" tests="${cases.length}" failures="${failures}" timestamp="${esc(run.startedAt)}">\n${cases.join('\n')}\n</testsuite>\n`;
}
