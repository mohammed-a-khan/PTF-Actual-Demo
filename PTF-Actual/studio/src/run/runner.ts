/**
 * Runs tests with the project's own CS Playwright Test Framework CLI (`cs-playwright-test`),
 * exactly as a person would from a terminal, plus:
 *  - the user's stored secrets for the chosen environment are given to the test process only
 *    (the framework resolves {env:NAME} from them), never written to disk or logs;
 *  - output streams live to the Studio; Stop ends the whole process tree (browsers included);
 *  - when the run ends, results are read from the framework's report-data.json (the same file the
 *    ADO pipeline template parses) and the HTML report is offered.
 *
 * Arguments follow the framework's CLI (minimist in src/index.ts): --project --env --features
 * --tags --scenario --scenarios --headless --browser --parallel/--workers.
 */
import { ChildProcess, spawn, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';
import * as fs from 'fs';
import * as path from 'path';
import { CodePause, InspectorSession, inspectorUrl } from '../debug/inspector';
import { UserError } from '../core/errors';
import { frameworkPackages } from '../lang/steps';
import { systemTool } from '../secrets/protector';

export interface RunRequest {
    /** A rerun of another run's failed scenarios: that run (so "Run again" can offer what it ran). */
    rerunOf?: string;
    project: string;
    env: string;
    features?: string[];
    tags?: string;
    scenario?: string;        // name contains
    scenarios?: string[];     // exact names (e.g. rerun failed)
    headless?: boolean;
    browser?: string;
    workers?: number;
    /** Retry a failed scenario up to this many times (the framework's --retry / RETRY_COUNT). */
    retries?: number;
    /** Emulate a device by its Playwright name ("iPhone 15", "Pixel 7"): the framework's BROWSER_DEVICE. */
    device?: string;
    /** Browser window size (BROWSER_VIEWPORT_WIDTH / _HEIGHT). */
    viewport?: { width: number; height: number };
    /** Configuration values for this run only (they override the project's config files, as environment variables do). */
    variables?: Record<string, string>;
    /** Send this run's results to Azure DevOps (ADO_INTEGRATION_ENABLED for this run only); not set: as the project is configured. */
    ado?: boolean;
    /** A debug run: pause before each step and/or on a failure (the framework's DEBUG_STEPS / PAUSE_ON_FAILURE),
     *  in a visible browser, one scenario at a time; slowMo slows each browser action (BROWSER_SLOWMO, ms). */
    debug?: {
        steps?: boolean; pauseOnFailure?: boolean; slowMo?: number;
        /** Breakpoints: feature file lines (before that step) and TypeScript / JavaScript lines (the code). */
        breakpoints?: Array<{ file: string; line: number }>;
        /** Also pause where code throws an error nothing catches. */
        exceptions?: boolean;
    };
}

/** Where a debug run waits (from the framework's "##cs-debug {json}" lines). */
export interface DebugPause { kind: 'before-step' | 'after-failure'; step: string; scenario?: string; error?: string; file?: string; line?: number; reason?: 'breakpoint' | 'step' }

export interface ScenarioResult { name: string; feature: string; status: string; duration: number; error?: string; /** Failed attempts before the final one (the framework's retry, RETRY_COUNT). */ retries?: number; /** Passed only after a retry. */ flaky?: boolean }
export interface RunSummary { total: number; passed: number; failed: number; skipped: number; duration: number; scenarios: ScenarioResult[]; reportDir: string; hasHtml: boolean; /** Scenarios that passed only after a retry. */ flaky?: number; /** Scenarios the run's output shows completed that the framework's report does not have. */ missing?: Array<{ name: string; status: string; retries: number }> }

/** A run of a pull request's tests, in its local copy (see git/prWorktree.ts). */
export interface RunPr {
    id: number; repository: string; title: string; commit: string; based: 'merge' | 'source';
    /** The tests chosen for it; with observe, everything ran and the choice is checked against the failures. */
    selection?: import('./prImpact').RunSelection;
}

export interface RunInfo {
    id: string;
    request: RunRequest;
    /** Folder the tests ran in, relative to the repository (a pull request's local copy). */
    workdir?: string;
    pr?: RunPr;
    /** The commit the tests ran on, and whether the working copy had changes not committed then. */
    commit?: string;
    dirty?: boolean;
    /** A step of a search for the commit that broke a test (see git/bisect.ts). */
    bisect?: { commit: string };
    command: string[];
    state: 'running' | 'passed' | 'failed' | 'stopped' | 'error';
    startedAt: string;
    endedAt?: string;
    exitCode?: number | null;
    summary?: RunSummary;
    message?: string;
    /** Secret names given to the run (values never stored). */
    secretNames: string[];
    /** A debug run waiting before a step / after a failure: Next / Continue / Stop. */
    paused?: DebugPause | null;
    /** A debug run stopped in the project's code (a breakpoint, a step, an error): call stack. */
    codePaused?: CodePause | null;
}

export interface LogLine { n: number; stream: 'out' | 'err' | 'studio'; text: string }

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const MAX_LOG_LINES = 50_000;
const MAX_LINE_CHARS = 8_000;
/** Output of older runs is dropped from memory (their results stay in the history). */
const KEEP_LOGS_FOR_RUNS = 10;

/** Path of the framework CLI script inside node_modules (from its package.json "bin"). */
export function frameworkCli(root: string): { script: string; version: string } {
    for (const pkg of frameworkPackages(root)) {
        const j = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
        const bin = typeof j.bin === 'string' ? j.bin : j.bin?.['cs-playwright-test'];
        if (bin && fs.existsSync(path.join(pkg, bin))) return { script: path.join(pkg, bin), version: j.version ?? '?' };
    }
    throw new UserError('The CS Playwright Test Framework is not installed in this project. Run "npm install" in the project folder first.');
}

/** The commit a folder is on and whether tracked files have changes (quick; nothing when Git cannot tell). */
export function commitOf(cwd: string): { commit?: string; dirty?: boolean } {
    try {
        const head = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 5000 });
        if (head.status !== 0) return {};
        const st = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 1 << 20 });
        return { commit: head.stdout.trim(), ...(st.status === 0 ? { dirty: st.stdout.trim().length > 0 } : {}) };
    } catch { return {}; }
}

/**
 * Whether the installed framework reads --scenarios (exact names; from 1.55). An older one reads only --scenario
 * (a part of the name), so the Studio uses that for one chosen scenario and refuses several.
 */
export function frameworkReadsScenarios(cliScript: string): boolean {
    try { return /args\.scenarios\b/.test(fs.readFileSync(cliScript, 'utf8')); } catch { return true; }
}

export function buildArgs(r: RunRequest, o: { scenariosFlag?: boolean } = {}): string[] {
    if (!NAME_RE.test(r.project)) throw new UserError('Choose a project.');
    if (!NAME_RE.test(r.env)) throw new UserError('Choose an environment.');
    const a = [`--project=${r.project}`, `--env=${r.env}`];
    if (r.features?.length) {
        for (const f of r.features) if (!f || f.startsWith('-') || f.includes('\0') || f.includes(',')) throw new UserError(`Invalid feature path: ${f}`);
        a.push(`--features=${r.features.join(',')}`);
    }
    if (r.tags?.trim()) a.push(`--tags=${r.tags.trim()}`);
    if (r.scenario?.trim()) a.push(`--scenario=${r.scenario.trim()}`);
    if (r.scenarios?.length) {
        if (r.scenarios.some((s) => s.includes(','))) throw new UserError('Scenario names containing commas cannot be selected individually; use a tag instead.');
        if (o.scenariosFlag !== false) a.push(`--scenarios=${r.scenarios.join(',')}`);
        else if (r.scenarios.length === 1 && !r.scenario?.trim()) a.push(`--scenario=${r.scenarios[0]}`);
        else throw new UserError('The project\'s framework runs one chosen scenario at a time (several need framework 1.55 or later): choose one scenario, or use a tag.');
    }
    if (r.headless !== undefined) a.push(`--headless=${r.headless ? 'true' : 'false'}`);
    if (r.browser) { if (!/^(chrome|chromium|msedge|edge|firefox|webkit)$/.test(r.browser)) throw new UserError('Unknown browser.'); a.push(`--browser=${r.browser}`); }
    if (r.workers !== undefined) {
        if (!Number.isInteger(r.workers) || r.workers < 1 || r.workers > 32) throw new UserError('Workers must be between 1 and 32.');
        a.push(r.workers > 1 ? `--parallel=${r.workers}` : '--parallel=false');
    }
    if (r.retries !== undefined) {
        if (!Number.isInteger(r.retries) || r.retries < 0 || r.retries > 5) throw new UserError('Retries must be 0 to 5.');
        // Also 0: the choice made here wins over RETRY_COUNT of the project's configuration.
        a.push(`--retry=${r.retries}`);
    }
    runEnvOf(r); // validates device, viewport and variables
    if (r.debug) {
        // Debugging: one scenario at a time in a visible browser (parallel workers do not pause).
        if (r.debug.breakpoints && (!Array.isArray(r.debug.breakpoints) || r.debug.breakpoints.length > 500 || r.debug.breakpoints.some((b) => !b || typeof b.file !== 'string' || !b.file || b.file.includes('\0') || path.isAbsolute(b.file) || b.file.split(/[\\/]/).includes('..') || !Number.isInteger(b.line) || b.line < 1))) throw new UserError('Invalid breakpoints.');
        if (r.debug.slowMo !== undefined && (!Number.isInteger(r.debug.slowMo) || r.debug.slowMo < 0 || r.debug.slowMo > 5000)) throw new UserError('Slow motion must be 0 to 5000 ms.');
        for (const x of ['--headless', '--parallel']) { const i = a.findIndex((v) => v.startsWith(x)); if (i >= 0) a.splice(i, 1); }
        a.push('--headless=false', '--parallel=false');
        if (r.debug.steps) a.push('--debug-steps');
        if (r.debug.pauseOnFailure) a.push('--pause-on-failure');
    }
    return a;
}

/** Settings that reach the framework as environment variables (device, window size, this run's values). */
export function runEnvOf(r: RunRequest): Record<string, string> {
    const env: Record<string, string> = {};
    if (r.device !== undefined && r.device !== '') {
        if (typeof r.device !== 'string' || r.device.length > 60 || !/^[\w .()+-]+$/.test(r.device)) throw new UserError('Unknown device name.');
        env.BROWSER_DEVICE = r.device;
    }
    if (r.viewport) {
        const { width, height } = r.viewport;
        if (![width, height].every((n) => Number.isInteger(n) && n >= 200 && n <= 7680)) throw new UserError('The window size must be 200 to 7680 pixels.');
        env.BROWSER_VIEWPORT_WIDTH = String(width); env.BROWSER_VIEWPORT_HEIGHT = String(height);
    }
    const vars = Object.entries(r.variables ?? {});
    if (vars.length > 40) throw new UserError('At most 40 values per run.');
    for (const [k, v] of vars) {
        if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(k)) throw new UserError(`"${k}" is not a configuration key (upper case, digits and _).`);
        if (/^(PROJECT|ENVIRONMENT|NODE_OPTIONS|PATH|HOME|DEBUG_CONTROL|DEBUG_BREAKPOINTS)$/.test(k)) throw new UserError(`${k} cannot be set per run.`);
        if (typeof v !== 'string' || v.length > 4000 || v.includes('\0')) throw new UserError(`The value of ${k} is not valid.`);
        env[k] = v;
    }
    if (r.ado !== undefined) {
        if (typeof r.ado !== 'boolean') throw new UserError('Azure DevOps results: on or off.');
        env.ADO_INTEGRATION_ENABLED = r.ado ? 'true' : 'false';
    }
    return env;
}

const REPORT_FILES = ['reports/report-data.json', 'report-data.json', 'consolidated-data.json'];

/** Every report data file under the folders the framework writes to (one and two levels deep). */
function reportFiles(root: string, bases: string[]): string[] {
    const out: string[] = [];
    const visit = (dir: string, depth: number) => {
        for (const f of REPORT_FILES) { const p = path.join(dir, f); if (fs.existsSync(p)) out.push(p); }
        if (depth === 0) return;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) if (e.isDirectory() && e.name !== 'node_modules') visit(path.join(dir, e.name), depth - 1);
    };
    for (const b of bases) visit(path.resolve(root, b), 2);
    return out;
}

/** Where the framework writes results: REPORTS_BASE_DIR / REPORT_PATH (from config) and the defaults. */
export function reportBases(reportDirs: string[] = []): string[] {
    return [...new Set(['reports', 'test-results', ...reportDirs.filter(Boolean)])];
}

/** Report files that exist before a run starts (so an old report is never shown as this run's). */
export function snapshotReports(root: string, reportDirs: string[] = []): Map<string, number> {
    const m = new Map<string, number>();
    for (const f of reportFiles(root, reportBases(reportDirs))) { try { m.set(f, fs.statSync(f).mtimeMs); } catch { /* gone */ } }
    return m;
}

/**
 * Results of the run: the newest report data file that is new or changed since the run started.
 * Supports single-project (suite.scenarios, durations in ms), multi-project (consolidated-data.json:
 * projects[].scenarios, durations in seconds) and per-project folders.
 */
export function findResults(root: string, since: number, before: Map<string, number> = new Map(), reportDirs: string[] = []): RunSummary | null {
    const fresh = reportFiles(root, reportBases(reportDirs))
        .map((f) => { try { return { f, t: fs.statSync(f).mtimeMs }; } catch { return null; } })
                // New since the run started: not in the before-run snapshot, or changed since. The 2 s
        // tolerance only covers coarse file-system clocks; old files are excluded by the snapshot.
        .filter((x): x is { f: string; t: number } => !!x && x.t >= since - 2000 && (!before.has(x.f) || before.get(x.f)! < x.t))
        .filter((x) => !path.relative(root, x.f).startsWith('..'))
        .sort((a, b) => b.t - a.t);
    if (!fresh.length) return null;
    return readReport(fresh[0].f);
}

/** Every report data file under the folders the framework writes to (runs from the Studio, the command line or a pipeline). */
export function allReportFiles(root: string, reportDirs: string[] = []): string[] {
    // The same file can be reached from two folders (reports/x/reports/report-data.json from reports and from reports/x).
    return [...new Set(reportFiles(root, reportBases(reportDirs)).map((f) => path.resolve(f)))].filter((f) => !path.relative(root, f).startsWith('..'));
}

/** The results in a framework report data file. */
export function readReport(json: string): RunSummary {
    const data = JSON.parse(fs.readFileSync(json, 'utf8'));
    const consolidated = Array.isArray(data.projects) && !data.suite;
    const raw: Array<Record<string, unknown>> = data.suite?.scenarios
        ?? (consolidated ? data.projects.flatMap((p: { name?: string; scenarios?: Array<Record<string, unknown>> }) => (p.scenarios ?? []).map((sc) => ({ ...sc, project: p.name }))) : undefined)
        ?? data.scenarios ?? [];
    const ms = (v: unknown) => { const n = Number(v ?? 0); return consolidated ? Math.round(n * 1000) : n; };
    const scenarios: ScenarioResult[] = raw.map((s) => {
        const steps = Array.isArray(s.steps) ? s.steps as Array<Record<string, unknown>> : [];
        const failedStep = steps.find((st) => st.status === 'failed' && st.error);
        const err = (s.error as string | undefined) ?? (failedStep?.error as string | { message?: string } | undefined);
        return {
            name: String(s.name ?? ''), feature: String(s.feature ?? (s.project ? `[${s.project}]` : '')), status: String(s.status ?? 'unknown'),
            duration: ms(s.duration),
            error: typeof err === 'string' ? err.slice(0, 4000) : err && typeof err === 'object' && 'message' in err ? String(err.message).slice(0, 4000) : undefined,
            // Framework versions that record retries in the report.
            ...(typeof s.retries === 'number' ? { retries: s.retries, flaky: s.flaky === true || (s.retries > 0 && s.status === 'passed') } : {}),
        };
    });
    const count = (st: string) => scenarios.filter((s) => s.status === st).length;
    const reportsDir = path.dirname(json);
    return {
        total: scenarios.length, passed: count('passed'), failed: scenarios.filter((s) => s.status === 'failed' || s.status === 'broken').length, skipped: count('skipped'),
        duration: data.suite?.duration !== undefined ? Number(data.suite.duration) : scenarios.reduce((t, s) => t + s.duration, 0),
        scenarios, reportDir: reportsDir, hasHtml: fs.existsSync(path.join(reportsDir, 'index.html')),
    };
}

/**
 * Retries as the run's output shows them (for framework versions whose report does not record them): the
 * framework prints "Test completed: <scenario>" after each attempt and "Retrying scenario (attempt n)" when it
 * runs the one that just failed again. Each scenario's retries and the status of its last attempt.
 */
export function attemptsFromOutput(lines: string[]): Map<string, { retries: number; status: 'passed' | 'failed' }> {
    const out = new Map<string, { retries: number; status: 'passed' | 'failed' }>();
    let last: string | null = null;
    for (const raw of lines) {
        const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
        const done = /\[(PASS|FAIL)\]\s+Test completed:\s+(.+?)\s*$/.exec(line);
        if (done) {
            last = done[2];
            const cur = out.get(last) ?? { retries: 0, status: 'failed' as const };
            out.set(last, { ...cur, status: done[1] === 'PASS' ? 'passed' : 'failed' });
            continue;
        }
        if (last && /Retrying scenario \(attempt \d+\)/.test(line)) out.get(last)!.retries++;
    }
    return out;
}

/** Retries of a run's scenarios: from the report where it has them, else from the output; scenarios the report lacks. */
export function withRetries(summary: RunSummary, lines: string[]): RunSummary {
    const seen = attemptsFromOutput(lines);
    for (const sc of summary.scenarios) {
        if (sc.retries !== undefined) continue;
        const o = seen.get(sc.name);
        if (o) { sc.retries = o.retries; sc.flaky = o.retries > 0 && sc.status === 'passed'; }
    }
    const names = new Set(summary.scenarios.map((s) => s.name));
    const missing = [...seen].filter(([n]) => !names.has(n)).map(([name, o]) => ({ name, status: o.status, retries: o.retries }));
    return { ...summary, flaky: summary.scenarios.filter((s) => s.flaky).length, ...(missing.length ? { missing } : {}) };
}

/** Replace secret values (and their URL/base64 forms) in text. */
export function maskSecrets(text: string, secrets: string[]): string {
    let t = text;
    for (const v of secrets) {
        if (!v || v.length < 4) continue;
        for (const form of new Set([v, encodeURIComponent(v), Buffer.from(v).toString('base64')])) if (form.length >= 4 && t.includes(form)) t = t.split(form).join('••••••');
    }
    return t;
}

export class TestRunner extends EventEmitter {
    private runs: RunInfo[] = [];
    private logs = new Map<string, LogLine[]>();
    private procs = new Map<string, ChildProcess>();
    readonly reportKeys = new Map<string, string>();

    /** Extra report folders from the project's config (REPORTS_BASE_DIR, REPORT_PATH). */
    reportDirs: string[] = [];

    constructor(private readonly root: string, private readonly historyFile: string, private readonly nodePath = process.execPath) {
        super();
        try { this.runs = JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch { this.runs = []; }
        // A history file is data from disk: report folders must be inside the repository.
        for (const r of this.runs) {
            if (r.summary && (typeof r.summary.reportDir !== 'string' || path.relative(root, r.summary.reportDir).startsWith('..') || path.isAbsolute(path.relative(root, r.summary.reportDir)))) delete r.summary;
        }
        // A working folder from disk must be a relative path inside the repository.
        for (const r of this.runs) if (r.workdir !== undefined && (typeof r.workdir !== 'string' || path.isAbsolute(r.workdir) || r.workdir.split(/[\\/]/).includes('..'))) { delete r.workdir; delete r.summary; }
        for (const r of this.runs) if (r.state === 'running') { r.state = 'error'; r.message = 'The Studio was closed while this run was in progress.'; }
    }

    list(): RunInfo[] { return [...this.runs].reverse(); }
    get(id: string): RunInfo | undefined { return this.runs.find((r) => r.id === id); }
    log(id: string, from = 0): LogLine[] {
        let lines = this.logs.get(id);
        // A finished run's output is kept on disk, so it is still there after the Studio restarts.
        if (!lines && /^[\w-]{1,64}$/.test(id) && this.get(id)) {
            try { lines = JSON.parse(fs.readFileSync(this.logFile(id), 'utf8')) as LogLine[]; } catch { lines = []; }
            if (!Array.isArray(lines)) lines = [];
        }
        return (lines ?? []).filter((l) => l.n >= from);
    }
    private logFile(id: string): string { return path.join(path.dirname(this.historyFile), 'run-logs', `${id}.json`); }
    isRunning(): boolean { return this.runs.some((r) => r.state === 'running'); }

    private save(): void {
        fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
        this.runs = this.runs.slice(-100);
        fs.writeFileSync(this.historyFile, JSON.stringify(this.runs, null, 1));
        // Output of runs no longer in the history goes too.
        const keep = new Set(this.runs.map((r) => `${r.id}.json`));
        try { for (const f of fs.readdirSync(path.dirname(this.logFile('x')))) if (!keep.has(f)) fs.rmSync(path.join(path.dirname(this.logFile('x')), f), { force: true }); } catch { /* no logs yet */ }
    }

    private counters = new Map<string, number>();
    /** Debugger connections of debug runs. */
    private sessions = new Map<string, InspectorSession>();

    private attach(id: string, url: string): void {
        const run = this.get(id);
        if (!run || this.sessions.has(id)) return;
        const session = new InspectorSession(url, this.base(run));
        this.sessions.set(id, session);
        session.on('paused', (p: CodePause) => { run.codePaused = p; this.emit(`debug:${id}`, p); this.emit('change'); });
        session.on('resumed', () => { run.codePaused = null; this.emit(`debug:${id}`, null); this.emit('change'); });
        session.on('closed', () => { this.sessions.delete(id); run.codePaused = null; });
        const code = (run.request.debug?.breakpoints ?? []).filter((b) => !b.file.endsWith('.feature'));
        session.start(code, { pauseOnExceptions: run.request.debug?.exceptions ? 'uncaught' : 'none' })
            .catch((e: Error) => this.push(id, 'studio', `Debugger: ${e.message}`, []));
    }

    private session(id: string): InspectorSession {
        const s = this.sessions.get(id);
        if (!s) throw new UserError('That run has no debugger attached.');
        return s;
    }
    /** Resume, step over / into / out of the paused code. */
    async debugCode(id: string, command: 'resume' | 'stepOver' | 'stepInto' | 'stepOut' | 'pause'): Promise<void> { await this.session(id).command(command); }
    debugScopes(id: string, frame: number) { return this.session(id).scopes(frame); }
    debugProperties(id: string, objectId: string) { return this.session(id).properties(objectId); }
    debugEvaluate(id: string, expression: string, frame: number, o: { noSideEffects?: boolean } = {}) { return this.session(id).evaluate(expression, frame, o); }
    /** Change a debug run's breakpoints while it runs (code ones in the debugger, feature ones in the framework). */
    async setBreakpoints(id: string, list: Array<{ file: string; line: number }>): Promise<void> {
        const child = this.procs.get(id);
        const run = this.get(id);
        if (!child || !run || run.state !== 'running' || !run.request.debug) return;
        run.request.debug.breakpoints = list;
        child.stdin?.write(`break set ${list.filter((b) => b.file.endsWith('.feature')).map((b) => `${b.file}:${b.line}`).join(',')}\n`);
        await this.sessions.get(id)?.setBreakpoints(list.filter((b) => !b.file.endsWith('.feature')));
    }

    private push(id: string, stream: LogLine['stream'], text: string, secrets: string[]): void {
        // The Node debugger's own lines: its address (attach), and its wait at the end (let the run end).
        if (stream === 'err') {
            const url = inspectorUrl(text);
            if (url) { this.attach(id, url); return; }
            if (/^Waiting for the debugger to disconnect/.test(text)) { this.sessions.get(id)?.close(); return; }
            if (/^(Debugger attached\.|For help, see: https:\/\/nodejs\.org\/en\/docs\/inspector)/.test(text)) return;
        }
        // A debug run's pause / resume (machine lines: kept out of the output).
        const dbg = stream === 'out' ? /^##cs-debug (\{.*\})\s*$/.exec(text) : null;
        if (dbg) {
            const run = this.get(id);
            try {
                const j = JSON.parse(dbg[1]) as Partial<DebugPause> & { resumed?: boolean };
                if (run && j.resumed) run.paused = null;
                else if (run && (j.kind === 'before-step' || j.kind === 'after-failure') && typeof j.step === 'string') {
                    run.paused = {
                        kind: j.kind, step: maskSecrets(j.step, secrets),
                        ...(j.scenario ? { scenario: maskSecrets(String(j.scenario), secrets) } : {}),
                        ...(j.error ? { error: maskSecrets(String(j.error), secrets).slice(0, 4000) } : {}),
                        // Where (a feature file line) and why (a breakpoint, or stepping)
                        ...(typeof j.file === 'string' && !path.isAbsolute(j.file) && !j.file.split(/[\\/]/).includes('..') ? { file: j.file } : {}),
                        ...(Number.isInteger(j.line) && j.line! > 0 ? { line: j.line } : {}),
                        ...(j.reason === 'breakpoint' || j.reason === 'step' ? { reason: j.reason } : {}),
                    };
                }
                this.emit(`debug:${id}`, run?.paused ?? null);
                this.emit('change');
            } catch { /* not a pause line */ }
            return;
        }
        const buf = this.logs.get(id)!;
        // Defence in depth: a test that prints a secret must not leak it into the Studio.
        text = maskSecrets(text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) + ' …(line shortened)' : text, secrets);
        const n = this.counters.get(id) ?? 0;
        this.counters.set(id, n + 1);
        const line = { n, stream, text };
        // Keep the newest lines (and therefore the end of the run) when output is huge.
        buf.push(line);
        if (buf.length > MAX_LOG_LINES) buf.splice(0, buf.length - MAX_LOG_LINES);
        this.emit(`log:${id}`, line);
    }

    /** Folder a run works in: the repository, or a pull request's local copy inside it. */
    base(r: Pick<RunInfo, 'workdir'>): string { return r.workdir ? path.join(this.root, r.workdir) : this.root; }

    start(req: RunRequest, secretEnv: Record<string, string>, extraEnv: Record<string, string> = {}, where: { workdir?: string; pr?: RunPr; bisect?: { commit: string } } = {}): RunInfo {
        if (this.isRunning()) throw new UserError('A test run is already in progress. Stop it or wait for it to finish.');
        // The project's installed framework, also for a pull request's copy (its node_modules is linked).
        const { script, version } = frameworkCli(this.root);
        const cwd = this.base(where);
        const args = buildArgs(req, { scenariosFlag: frameworkReadsScenarios(script) });
        const id = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
        const startedAt = new Date();
        const before = snapshotReports(cwd, this.reportDirs);
        const at = commitOf(cwd);
        const run: RunInfo = { id, request: req, ...(where.workdir ? { workdir: where.workdir } : {}), ...(where.pr ? { pr: where.pr } : {}), ...(where.bisect ? { bisect: where.bisect } : {}), ...at, command: ['cs-playwright-test', ...args], state: 'running', startedAt: startedAt.toISOString(), secretNames: Object.keys(secretEnv).sort() };
        this.runs.push(run);
        this.logs.set(id, []);
        this.save();
        const secrets = Object.values(secretEnv);
        this.push(id, 'studio', `▶ cs-playwright-test ${args.join(' ')}   (framework ${version})`, secrets);
        if (run.secretNames.length) this.push(id, 'studio', `  secrets given to this run: ${run.secretNames.join(', ')}`, secrets);

        if (where.pr) this.push(id, 'studio', `  pull request #${where.pr.id} "${where.pr.title}" — ${where.pr.based === 'merge' ? 'merge result' : 'source branch'} ${where.pr.commit.slice(0, 8)}, in ${where.workdir}`, secrets);
        // A debug run: the Node debugger (breakpoints in the project's code), waiting at the first line until the
        // Studio has set the breakpoints; feature-file breakpoints go to the framework (DEBUG_BREAKPOINTS).
        const featureBreakpoints = (req.debug?.breakpoints ?? []).filter((b) => b.file.endsWith('.feature')).map((b) => `${b.file}:${b.line}`).join(',');
        const child = spawn(this.nodePath, [...(req.debug ? ['--inspect-brk=127.0.0.1:0'] : []), script, ...args], {
            cwd,
            // AUTO_OPEN_REPORT=false: the framework would otherwise open its HTML report in a new
            // browser window after every run; the Studio shows the report itself.
            // extraEnv: trusted company certificates for the framework's own HTTPS (Settings → Network).
            env: { ...process.env, ...extraEnv, ...secretEnv, ...runEnvOf(req), FORCE_COLOR: '0', NO_COLOR: '1', AUTO_OPEN_REPORT: 'false',
                ...(req.debug?.slowMo ? { BROWSER_SLOWMO: String(req.debug.slowMo) } : {}),
                ...(req.debug ? { DEBUG_CONTROL: 'true', DEBUG_BREAKPOINTS: featureBreakpoints } : {}) },
            shell: false, windowsHide: true,
            detached: process.platform !== 'win32', // own process group so Stop can end browsers too
        });
        this.procs.set(id, child);
        Object.defineProperty(run, 'before', { value: before, enumerable: false, writable: true });
        // Free the output of old runs.
        const withLogs = this.runs.filter((r) => this.logs.has(r.id));
        for (const r of withLogs.slice(0, Math.max(0, withLogs.length - KEEP_LOGS_FOR_RUNS))) { this.logs.delete(r.id); this.counters.delete(r.id); }
        // Characters split between chunks are joined correctly (StringDecoder); \r\n, \n and lone \r
        // end lines; a partial line is flushed when the stream ends; a never-ending line is capped.
        const flushers: Array<() => void> = [];
        const pipe = (stream: 'out' | 'err') => {
            const dec = new StringDecoder('utf8');
            let rest = '';
            const emitLines = (chunk: string) => {
                const parts = (rest + chunk).split(/\r\n|\n|\r/);
                rest = parts.pop() ?? '';
                if (rest.length > MAX_LINE_CHARS * 4) { this.push(id, stream, rest, secrets); rest = ''; }
                for (const p of parts) this.push(id, stream, p, secrets);
            };
            flushers.push(() => { emitLines(dec.end()); if (rest) { this.push(id, stream, rest, secrets); rest = ''; } });
            return (b: Buffer) => emitLines(dec.write(b));
        };
        child.stdout!.on('data', pipe('out'));
        child.stderr!.on('data', pipe('err'));
        child.on('error', (e) => this.finish(run, null, `Could not start the test run: ${e.message}`, secrets));
        child.on('close', (code) => { for (const f of flushers) f(); this.finish(run, code, undefined, secrets); });
        this.emit('change');
        return run;
    }

    /** Answer a paused debug run: run the next step, continue without pausing before steps, or stop. */
    debugCommand(id: string, command: 'next' | 'continue' | 'stop'): void {
        const child = this.procs.get(id);
        const run = this.get(id);
        if (!child || !run || run.state !== 'running') throw new UserError('That run is not running.');
        if (!run.paused) throw new UserError('That run is not paused.');
        child.stdin?.write(`${command}\n`);
    }

    /** Paused before a step: run it and break at the first line of its code (the step definition). */
    async debugStepInto(id: string): Promise<void> {
        const run = this.get(id);
        if (!run?.paused || run.paused.kind !== 'before-step') throw new UserError('That run is not paused before a step.');
        // Without a step definition found (an AI step…), the step just runs, pausing before the next one.
        await this.session(id).breakInto();
        this.debugCommand(id, 'next');
    }

    private finish(run: RunInfo, code: number | null, message: string | undefined, secrets: string[]): void {
        if (run.state !== 'running') return;
        run.paused = null;
        run.codePaused = null;
        this.sessions.get(run.id)?.close();
        this.procs.delete(run.id);
        run.exitCode = code;
        run.endedAt = new Date().toISOString();
        const stopped = (run as RunInfo & { stopping?: boolean }).stopping;
        try {
            const summary = findResults(this.base(run), Date.parse(run.startedAt), (run as RunInfo & { before?: Map<string, number> }).before, this.reportDirs);
            if (summary) {
                // Error texts can contain values a test printed; never store or show secrets.
                for (const sc of summary.scenarios) { sc.name = maskSecrets(sc.name, secrets); if (sc.error) sc.error = maskSecrets(sc.error, secrets); }
                // Scenarios that passed only after the framework retried them; ones its report left out.
                run.summary = withRetries(summary, (this.logs.get(run.id) ?? []).filter((l) => l.stream !== 'studio').map((l) => l.text));
                for (const m of run.summary.missing ?? []) this.push(run.id, 'studio', `⚠ "${m.name}" ${m.status} (after ${m.retries} retr${m.retries === 1 ? 'y' : 'ies'}) but is not in the framework's report.`, secrets);
            }
        } catch (e) { this.push(run.id, 'studio', `Could not read the results: ${(e as Error).message}`, secrets); }
        // Exit code 0 but no scenario ran (filters matched nothing, or no report): not a pass.
        if (!stopped && !message && code === 0 && (!run.summary || run.summary.total === 0)) message = run.summary ? 'No scenario ran: the chosen features, tags or scenarios matched nothing.' : 'The run ended without results: the framework\'s report was not found.';
        run.state = stopped ? 'stopped' : message ? 'error' : code === 0 && (!run.summary || run.summary.failed === 0) ? 'passed' : 'failed';
        if (message) run.message = message;
        delete (run as RunInfo & { stopping?: boolean }).stopping;
        const s = run.summary;
        this.push(run.id, 'studio', `■ ${run.state.toUpperCase()}${s ? ` — ${s.passed} passed${s.flaky ? ` (${s.flaky} only after a retry)` : ''}, ${s.failed} failed, ${s.skipped} skipped` : ''} (exit code ${code ?? '–'})`, secrets);
        try {
            fs.mkdirSync(path.dirname(this.logFile(run.id)), { recursive: true });
            fs.writeFileSync(this.logFile(run.id), JSON.stringify(this.logs.get(run.id) ?? []));
        } catch { /* the output stays available until the Studio closes */ }
        this.save();
        this.emit(`end:${run.id}`, run);
        this.emit('ended', run);
        this.emit('change');
    }

    stop(id: string): void {
        const child = this.procs.get(id);
        const run = this.get(id);
        if (!child || !run || run.state !== 'running') return;
        (run as RunInfo & { stopping?: boolean }).stopping = true;
        // A debug run paused in the debugger runs no code (its exit handlers neither): let it go first.
        const session = this.sessions.get(id);
        if (session) { this.sessions.delete(id); void session.release().finally(() => this.kill(child)); return; }
        this.kill(child);
    }

    private kill(child: ChildProcess): void {
        if (process.platform === 'win32') spawnSync(systemTool('taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else { try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); } setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } }, 5000).unref(); }
    }

    /** Per-run key for opening its HTML report in a browser tab (which cannot send the API token). */
    /** Stop every run (Studio shutting down): runs live in their own process group and would keep going. */
    stopAll(): void { for (const r of this.runs) if (r.state === 'running') this.stop(r.id); }

    reportKey(id: string): string | undefined {
        if (!this.get(id)?.summary?.hasHtml) return undefined;
        if (!this.reportKeys.has(id)) this.reportKeys.set(id, randomBytes(16).toString('hex'));
        return this.reportKeys.get(id);
    }
}
