/**
 * Collection runner: the requests of a collection (or some of them) in order, for a number of
 * iterations or once per row of a CSV data file; values saved by a request are used by the next ones
 * within an iteration. Results per iteration and request, kept for this Studio session; an HTML report.
 */
import type { Connection } from '../core/network';
import { ApiCollection, ApiRequest } from './model';
import { CookieJar } from './cookies';
import { authorize, CheckResult, evaluateAll, extract, prepare, send, TokenCache, Values, sendWith } from './send';
import { prepareValues, type QueryRows } from './checks';
import { wsAsResponse, wsUrl } from './ws';
import { PROTOCOL_LABEL, runExchange } from './messaging';
import { runPreScripts, withGlobals, runTestScripts, scriptSender } from './scripts';

export interface RunnerStep {
    iteration: number;
    requestId: string;
    name: string;
    method: string;
    url: string;
    status?: number;
    timeMs?: number;
    size?: number;
    passed: boolean;
    error?: string;
    checks: Array<Pick<CheckResult, 'pass' | 'message' | 'actual'>>;
    /** console.log of the request's scripts. */
    logs?: string[];
}
export interface RunnerJob {
    id: string;
    collection: string;
    name: string;
    project: string;
    env: string;
    startedAt: string;
    endedAt?: string;
    state: 'running' | 'stopped' | 'finished';
    iterations: number;
    total: number;
    steps: RunnerStep[];
    summary: { requests: number; passed: number; failed: number; checks: number; checksPassed: number; avgMs: number };
}

export interface RunnerInput {
    collection: Pick<ApiCollection, 'baseUrl' | 'auth' | 'name' | 'scripts'>;
    file: string;
    project: string;
    env: string;
    requests: ApiRequest[];
    values: Values;
    rows: Array<Record<string, string>>;
    iterations: number;
    delayMs: number;
    stopOnFailure: boolean;
    timeoutMs: number;
    connection?: Connection;
    readFile?: (rel: string) => Buffer;
    /** The repository (gRPC .proto files). */
    projectRoot?: string;
    environment?: string;
    mask: (t: string) => string;
    /** The project's database queries (database checks, prepared defaults). */
    queryRows?: QueryRows;
    /** Called when the run ends (finished or stopped): to keep it. */
    onDone?: (job: RunnerJob) => void;
}

export class CollectionRunner {
    private jobs = new Map<string, { job: RunnerJob; stop: boolean }>();

    start(i: RunnerInput): RunnerJob {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const iterations = i.rows.length ? i.rows.length : Math.max(1, Math.min(i.iterations, 1000));
        const job: RunnerJob = { id, collection: i.file, name: i.collection.name, project: i.project, env: i.env, startedAt: new Date().toISOString(), state: 'running', iterations,
            total: iterations * i.requests.length, steps: [], summary: { requests: 0, passed: 0, failed: 0, checks: 0, checksPassed: 0, avgMs: 0 } };
        const entry = { job, stop: false };
        this.jobs.set(id, entry);
        for (const [k, v] of [...this.jobs].slice(0, -20)) if (v.job.state !== 'running') this.jobs.delete(k); // keep the last 20
        void this.run(entry, i);
        return job;
    }

    private async run(entry: { job: RunnerJob; stop: boolean }, i: RunnerInput) {
        const { job } = entry;
        const tokens: TokenCache = new Map();
        let total = 0;
        // Globals of scripts (pm.globals) last for the whole run; the others per iteration, as in Postman.
        const globals: Record<string, string> = {};
        const sender = scriptSender((p) => send(p, i.connection, i.timeoutMs));
        outer: for (let it = 0; it < job.iterations; it++) {
            const saved: Record<string, string> = {};
            const row = i.rows[it] ?? {};
            // Cookies per iteration (a scenario of the generated feature has its own API client and cookies).
            const jar = new CookieJar();
            // In order, unless a script names the next request (pm.execution.setNextRequest): at most 1000 steps an iteration.
            let at = 0, steps = 0;
            while (at < i.requests.length && steps++ < 1000) {
                const r0 = i.requests[at];
                let next: string | null | undefined;
                if (entry.stop) break outer;
                const v: Values = { ...i.values, vars: { ...i.values.vars, ...row, ...saved }, row, readFile: i.readFile };
                const step: RunnerStep = { iteration: it + 1, requestId: r0.id, name: r0.name, method: r0.method, url: '', passed: false, checks: [] };
                let skipped = false;
                try {
                    await prepareValues(r0.prepare, v, i.queryRows);
                    const pre = await runPreScripts(i.collection, r0, v, globals, sender, it);
                    if (pre.logs.length) step.logs = pre.logs.map((l) => i.mask(l.text));
                    if (pre.next !== undefined) next = pre.next;
                    for (const k of Object.keys(v.vars)) if (v.vars[k] !== (i.values.vars[k] ?? row[k])) saved[k] = v.vars[k];
                    if (pre.error) throw new Error(pre.error);
                    if (pre.skip) { skipped = true; step.error = 'Skipped by the pre-request script'; step.passed = true; }
                    const r = pre.request;
                    if (!skipped) {
                    let p = prepare(i.collection, r, withGlobals(v, globals), { readFile: i.readFile });
                    p = await authorize(i.collection, r, v, p, i.connection, tokens, i.timeoutMs);
                    step.url = i.mask(p.url);
                    if (p.missing.length) step.error = `Not filled in: ${p.missing.join(', ')}`;
                    else {
                        if (r.ws) {
                            const w = await runExchange(r.ws, p, v, i.timeoutMs, i.connection, i.projectRoot, { environment: i.environment });
                            step.url = i.mask(r.ws.protocol && r.ws.protocol !== 'websocket' ? p.url : wsUrl(p.url)); step.method = !r.ws.protocol || r.ws.protocol === 'websocket' ? 'WS' : PROTOCOL_LABEL[r.ws.protocol]; step.status = w.connected ? 101 : undefined; step.timeMs = w.timeMs;
                            Object.assign(saved, w.saved);
                            step.checks = wsAsResponse(w, r.ws.steps).checks.map((c) => ({ pass: c.pass, message: i.mask(c.message) }));
                            step.passed = !w.error;
                            if (w.error) step.error = i.mask(w.error);
                        } else {
                        const res = await sendWith(p, r.settings, i.connection, i.timeoutMs, jar);
                        step.status = res.status; step.timeMs = res.timeMs; step.size = res.size;
                        for (const x of extract(r.extract, res)) if (x.found && x.value !== undefined) { saved[x.variable] = x.value; v.vars[x.variable] = x.value; }
                        const own = await evaluateAll(r.checks, res, v, i.queryRows);
                        const t = await runTestScripts(i.collection, r, p, res, v, globals, sender, it);
                        if (t.logs.length) step.logs = [...(step.logs ?? []), ...t.logs.map((l) => i.mask(l.text))];
                        if (t.next !== undefined) next = t.next;
                        for (const k of Object.keys(v.vars)) if (v.vars[k] !== (i.values.vars[k] ?? row[k])) saved[k] = v.vars[k];
                        step.checks = [...own, ...t.checks].map((c) => ({ pass: c.pass, message: c.message, actual: c.actual === undefined ? undefined : i.mask(c.actual) }));
                        step.passed = step.checks.length ? step.checks.every((c) => c.pass) : res.status < 400;
                        if (!step.checks.length && res.status >= 400) step.error = `HTTP ${res.status}`;
                        }
                    }
                    }
                } catch (e) { step.error = i.mask((e as Error).message); }
                job.steps.push(step);
                const s2 = job.summary;
                s2.requests++; if (step.passed) s2.passed++; else s2.failed++;
                s2.checks += step.checks.length; s2.checksPassed += step.checks.filter((c) => c.pass).length;
                if (step.timeMs !== undefined) { total += step.timeMs; s2.avgMs = Math.round(total / Math.max(1, job.steps.filter((x) => x.timeMs !== undefined).length)); }
                if (!step.passed && i.stopOnFailure) { entry.stop = true; break outer; }
                if (i.delayMs > 0) await new Promise((res) => setTimeout(res, i.delayMs));
                if (next === null) break;                       // setNextRequest(null): this iteration ends
                if (typeof next === 'string') {
                    const j = i.requests.findIndex((x) => x.name === next || x.id === next);
                    if (j < 0) { job.steps.push({ iteration: it + 1, requestId: '', name: String(next), method: '', url: '', passed: false, checks: [], error: `setNextRequest("${next}"): no request of this run has that name` }); job.summary.requests++; job.summary.failed++; break; }
                    at = j;
                } else at++;
            }
            job.total = Math.max(job.total, job.steps.length);
        }
        job.state = entry.stop ? 'stopped' : 'finished';
        job.endedAt = new Date().toISOString();
        try { i.onDone?.(job); } catch { /* keeping it is best effort */ }
    }

    get(id: string): RunnerJob | null { return this.jobs.get(id)?.job ?? null; }
    list(): RunnerJob[] { return [...this.jobs.values()].map((x) => x.job).reverse(); }
    stop(id: string): boolean { const e = this.jobs.get(id); if (!e || e.job.state !== 'running') return false; e.stop = true; return true; }
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A self-contained HTML report (everything escaped; no scripts). */
export function runnerReport(j: RunnerJob): string {
    const s = j.summary;
    const rows = j.steps.map((x) => `<tr class="${x.passed ? 'ok' : 'bad'}"><td>${x.iteration}</td><td>${esc(x.name)}</td><td><code>${esc(x.method)}</code> ${esc(x.url)}</td><td>${x.status ?? ''}</td><td>${x.timeMs ?? ''}</td><td>${x.passed ? 'Passed' : 'Failed'}${x.error ? `<div class="err">${esc(x.error)}</div>` : ''}${x.checks.map((c) => `<div class="${c.pass ? 'cp' : 'cf'}">${c.pass ? '✓' : '✗'} ${esc(c.message)}${!c.pass && c.actual !== undefined && !c.message.includes(String(c.actual)) ? ` (got ${esc(c.actual)})` : ''}</div>`).join('')}</td></tr>`).join('\n');
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(j.name)} — API run</title><style>
body{font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;margin:24px;color:#1f2328}h1{font-size:20px;margin:0 0 4px}.m{color:#6b7280;font-size:13px;margin-bottom:16px}
.k{display:flex;gap:28px;margin:12px 0 18px}.k b{display:block;font-size:20px}.k span{font-size:11px;color:#6b7280;text-transform:uppercase}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid #e5e7eb;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f6f8fa}
tr.bad td{background:#fff5f5}.err{color:#cf222e}.cp{color:#1a7f37}.cf{color:#cf222e}code{font-family:ui-monospace,Consolas,monospace;font-size:12px}</style></head><body>
<h1>${esc(j.name)}</h1><div class="m">${esc(j.project)} / ${esc(j.env)} · ${esc(new Date(j.startedAt).toLocaleString())} · ${j.iterations} iteration${j.iterations === 1 ? '' : 's'} · ${esc(j.state)}</div>
<div class="k"><div><b>${s.passed}/${s.requests}</b><span>Requests passed</span></div><div><b>${s.checksPassed}/${s.checks}</b><span>Checks passed</span></div><div><b>${s.avgMs} ms</b><span>Average time</span></div></div>
<table><thead><tr><th>#</th><th>Request</th><th>URL</th><th>Status</th><th>ms</th><th>Result</th></tr></thead><tbody>
${rows}
</tbody></table></body></html>`;
}

const xml = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

/** JUnit XML (Azure DevOps "Publish test results", Jenkins…): a test suite per iteration, a test case per request, each failed check a failure. */
export function runnerJUnit(j: RunnerJob): string {
    const its = [...new Set(j.steps.map((s) => s.iteration))];
    const suites = its.map((it) => {
        const st = j.steps.filter((s) => s.iteration === it);
        const fails = st.filter((s) => !s.passed).length;
        const time = st.reduce((n, s) => n + (s.timeMs ?? 0), 0) / 1000;
        const cases = st.map((s) => {
            const failed = s.checks.filter((c) => !c.pass);
            const body = s.passed ? '' : `\n      <failure message="${xml(s.error ?? failed[0]?.message ?? 'Failed')}" type="${s.error ? 'error' : 'check'}">${xml([s.error, ...failed.map((c) => `${c.message}${c.actual !== undefined && !c.message.includes(String(c.actual)) ? ` (got ${c.actual})` : ''}`)].filter(Boolean).join('\n'))}</failure>\n    `;
            const out = s.logs?.length ? `\n      <system-out>${xml(s.logs.join('\n'))}</system-out>\n    ` : '';
            return `    <testcase classname="${xml(j.name)}" name="${xml(s.name)}" time="${((s.timeMs ?? 0) / 1000).toFixed(3)}">${body}${out}${body || out ? '' : ''}</testcase>`;
        }).join('\n');
        return `  <testsuite name="${xml(`${j.name} — iteration ${it}`)}" tests="${st.length}" failures="${fails}" errors="0" skipped="0" time="${time.toFixed(3)}" timestamp="${xml(j.startedAt.replace(/Z$/, ''))}">\n${cases}\n  </testsuite>`;
    }).join('\n');
    const total = j.steps.length, failures = j.steps.filter((s) => !s.passed).length;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${xml(j.name)}" tests="${total}" failures="${failures}" errors="0" time="${(j.steps.reduce((n, s) => n + (s.timeMs ?? 0), 0) / 1000).toFixed(3)}">\n${suites}\n</testsuites>\n`;
}

export type RunChange = 'fixed' | 'broke' | 'same' | 'still failing' | 'new' | 'gone';
export interface RunComparison {
    a: Pick<RunnerJob, 'id' | 'name' | 'env' | 'startedAt' | 'summary'>;
    b: Pick<RunnerJob, 'id' | 'name' | 'env' | 'startedAt' | 'summary'>;
    rows: Array<{ key: string; name: string; iteration: number; change: RunChange; a?: { status?: number; timeMs?: number; passed: boolean }; b?: { status?: number; timeMs?: number; passed: boolean }; timeDelta?: number; checksChanged?: string[] }>;
    counts: Record<RunChange, number>;
    avgDelta: number;
}

/** Two runs side by side: each request (by iteration and name) fixed, broken, still failing or the same, its time, the checks whose result changed. */
export function compareRuns(a: RunnerJob, b: RunnerJob): RunComparison {
    const key = (s: RunnerStep, n: number) => `${s.iteration}|${s.requestId || s.name}|${n}`;
    const index = (j: RunnerJob) => { const seen = new Map<string, number>(); const m = new Map<string, RunnerStep>(); for (const s of j.steps) { const k0 = `${s.iteration}|${s.requestId || s.name}`; const n = seen.get(k0) ?? 0; seen.set(k0, n + 1); m.set(key(s, n), s); } return m; };
    const A = index(a), B = index(b);
    const keys = [...new Set([...A.keys(), ...B.keys()])];
    const rows: RunComparison['rows'] = keys.map((k) => {
        const x = A.get(k), y = B.get(k);
        const v = (s?: RunnerStep) => (s ? { status: s.status, timeMs: s.timeMs, passed: s.passed } : undefined);
        const change: RunChange = !x ? 'new' : !y ? 'gone' : x.passed && y.passed ? 'same' : !x.passed && y.passed ? 'fixed' : x.passed && !y.passed ? 'broke' : 'still failing';
        const checksChanged = x && y ? y.checks.filter((c) => { const was = x.checks.find((d) => d.message === c.message); return was ? was.pass !== c.pass : false; }).map((c) => `${c.pass ? 'now passes' : 'now fails'}: ${c.message}`) : undefined;
        return { key: k, name: (y ?? x)!.name, iteration: (y ?? x)!.iteration, change, a: v(x), b: v(y), ...(x?.timeMs !== undefined && y?.timeMs !== undefined ? { timeDelta: y.timeMs - x.timeMs } : {}), ...(checksChanged?.length ? { checksChanged } : {}) };
    });
    const counts = { fixed: 0, broke: 0, same: 0, 'still failing': 0, new: 0, gone: 0 } as Record<RunChange, number>;
    for (const r of rows) counts[r.change]++;
    const pick = (j: RunnerJob) => ({ id: j.id, name: j.name, env: j.env, startedAt: j.startedAt, summary: j.summary });
    return { a: pick(a), b: pick(b), rows, counts, avgDelta: b.summary.avgMs - a.summary.avgMs };
}
