/**
 * Failure evidence of a finished run, read from the framework's report on disk (nothing extra is
 * stored in the run history).
 *
 * What the framework records (verified on real 1.54.0 runs):
 *  - reports/test-results-<time>/reports/report-data.json:
 *      suite.scenarios[].steps[] with `status`, `error` and `screenshot` (a file name in ../screenshots)
 *        for the failed step;
 *      artifacts.{screenshots,videos,traces,consoleLogs,har}[] with `path` relative to the reports
 *        folder ("../traces/trace-2026-11-19T08-30-45-229Z.zip") — for the whole run;
 *      scenario-level `artifacts` may be present (strings or { path, name }).
 *  - Trace files are named with the time they were saved; with retries (RETRY_COUNT) a failing
 *    scenario runs several times and leaves one trace and one screenshot per attempt.
 *  - The HTML report links its files as "../screenshots/…", so it must be served from the results
 *    folder (the parent of reports/), not from reports/.
 */
import * as fs from 'fs';
import * as path from 'path';
import { frameworkPackages } from '../lang/steps';

export type EvidenceKind = 'screenshot' | 'video' | 'trace' | 'console' | 'har';

export interface EvidenceFile { kind: EvidenceKind; file: string; name: string; time?: string; size: number }

export type ActionKind = 'pass' | 'fail' | 'info' | 'warn';
export interface StepAction { kind: ActionKind; text: string; durationMs?: number; time?: string }
export interface StepDetail {
    text: string;
    status: 'passed' | 'failed' | 'skipped' | 'not run' | string;
    durationMs?: number;
    error?: string;
    screenshot?: EvidenceFile;
    actions: StepAction[];
}

export interface ScenarioEvidence {
    index: number;
    durationMs?: number;
    /** Every step: as reported, then (from the feature file) the ones that did not run. */
    steps: StepDetail[];
    /** Where the scenario is in the repository, when found. */
    location?: { file: string; line: number };
    name: string;
    feature: string;
    status: string;
    failedStep?: { name: string; error?: string; screenshot?: EvidenceFile };
    /** Files of this scenario: its own artifacts, or (traces) those saved while it ran. */
    files: EvidenceFile[];
    /** True when files were matched by time (run-wide lists), not named by the framework. */
    matchedByTime: boolean;
}

export interface RunEvidence {
    /** Results folder (the parent of reports/), relative to the repository. */
    resultsRoot: string;
    /** Path of the HTML report inside resultsRoot. */
    reportIndex: string | null;
    scenarios: ScenarioEvidence[];
    run: EvidenceFile[];
}

const inside = (base: string, target: string) => { const r = path.relative(base, target); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

/** The folder the report's files are relative to: test-results-<time>/ for …/reports. */
export function resultsRootOf(reportDir: string): string {
    return path.basename(reportDir) === 'reports' ? path.dirname(reportDir) : reportDir;
}

const KIND_DIRS: Record<EvidenceKind, string> = { screenshot: 'screenshots', video: 'videos', trace: 'traces', console: 'console-logs', har: 'har' };
const KIND_OF: Record<string, EvidenceKind> = { screenshots: 'screenshot', videos: 'video', traces: 'trace', consoleLogs: 'console', logs: 'console', har: 'har' };

/** "trace-2026-11-19T08-30-45-229Z.zip" → that instant. */
export function timeFromName(name: string): number | undefined {
    const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name);
    if (!m) return undefined;
    const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
    return Number.isNaN(t) ? undefined : t;
}

export function readEvidence(repoRoot: string, reportDir: string, opts: { features?: FeatureIndex; ran?: string[] } = {}): RunEvidence {
    const root = resultsRootOf(reportDir);
    if (!inside(repoRoot, root)) throw new Error('The report folder is outside the project.');
    const realRoot = (() => { try { return fs.realpathSync(root); } catch { return root; } })();
    const relRoot = path.relative(repoRoot, root).split(path.sep).join('/');

    /** Resolve an artifact reference to a file inside the results folder. */
    const resolve = (ref: unknown, kind: EvidenceKind): EvidenceFile | null => {
        const s = typeof ref === 'string' ? ref : ref && typeof ref === 'object' ? String((ref as { path?: unknown; name?: unknown }).path ?? (ref as { name?: unknown }).name ?? '') : '';
        if (!s || s.includes('\0')) return null;
        const cands = [path.resolve(reportDir, s), path.resolve(root, s), path.resolve(repoRoot, s), path.join(root, KIND_DIRS[kind], path.basename(s))];
        for (const c of cands) {
            if (!inside(root, c)) continue;
            let st: fs.Stats;
            try { st = fs.statSync(c); } catch { continue; }
            if (!st.isFile()) continue;
            try { if (!inside(realRoot, fs.realpathSync(c))) continue; } catch { continue; }
            // Videos have no time in their name: they are written when the scenario's page closes.
            const t = timeFromName(path.basename(c)) ?? (kind === 'video' ? st.mtimeMs : undefined);
            return { kind, file: path.relative(root, c).split(path.sep).join('/'), name: path.basename(c), size: st.size, ...(t !== undefined ? { time: new Date(t).toISOString() } : {}) };
        }
        return null;
    };

    const dataFile = ['report-data.json', 'consolidated-data.json'].map((f) => path.join(reportDir, f)).find((f) => fs.existsSync(f));
    let data: Record<string, unknown> = {};
    try { if (dataFile) data = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch { data = {}; }

    // Run-wide files: the report's lists, plus anything in the standard folders.
    const run: EvidenceFile[] = [];
    const seen = new Set<string>();
    const add = (f: EvidenceFile | null) => { if (f && !seen.has(f.file)) { seen.add(f.file); run.push(f); } };
    const arts = (data.artifacts ?? {}) as Record<string, unknown>;
    for (const [key, list] of Object.entries(arts)) {
        const kind = KIND_OF[key];
        if (kind && Array.isArray(list)) for (const r of list) add(resolve(r, kind));
    }
    for (const kind of Object.keys(KIND_DIRS) as EvidenceKind[]) {
        const dir = path.join(root, KIND_DIRS[kind]);
        let names: string[] = [];
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const n of names.sort()) if (!n.endsWith('.vtt')) add(resolve(path.join(KIND_DIRS[kind], n), kind));
    }

    // Scenarios (single-project report; consolidated reports have no step details per file).
    const raw = (((data.suite as { scenarios?: unknown[] } | undefined)?.scenarios) ?? []) as Array<Record<string, unknown>>;
    const starts = raw.map((s) => Date.parse(String(s.startTime ?? ''))).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
    const scenarios: ScenarioEvidence[] = raw.map((s, index) => {
        const steps = Array.isArray(s.steps) ? s.steps as Array<Record<string, unknown>> : [];
        const failed = steps.find((st) => st.status === 'failed');
        const failedStep = failed ? {
            name: String(failed.name ?? ''),
            error: typeof failed.error === 'string' ? failed.error.slice(0, 8000) : undefined,
            screenshot: resolve(failed.screenshot, 'screenshot') ?? undefined,
        } : undefined;
        const files: EvidenceFile[] = [];
        const own = (s.artifacts ?? {}) as Record<string, unknown>;
        for (const [key, list] of Object.entries(own)) {
            const kind = KIND_OF[key];
            if (kind && Array.isArray(list)) for (const r of list) { const f = resolve(r, kind); if (f && !files.some((x) => x.file === f.file)) files.push(f); }
        }
        let matchedByTime = false;
        const status = String(s.status ?? 'unknown');
        // Traces and videos saved while this scenario ran (from its start until the next scenario
        // starts), when the report did not list them with the scenario.
        const start = Date.parse(String(s.startTime ?? ''));
        const end = Date.parse(String(s.endTime ?? ''));
        const next = Number.isNaN(start) ? undefined : starts.find((t) => t > (Number.isNaN(end) ? start : end));
        for (const kind of ['trace', 'video'] as const) {
            if (files.some((f) => f.kind === kind) || Number.isNaN(start)) continue;
            if (kind === 'trace' && status !== 'failed' && status !== 'broken') continue;
            for (const f of run) {
                if (f.kind !== kind || !f.time) continue;
                const t = Date.parse(f.time);
                if (t >= start && (next === undefined || t < next)) { files.push(f); matchedByTime = true; }
            }
        }
        const detail: StepDetail[] = steps.map((st) => ({
            text: String(st.name ?? ''),
            status: String(st.status ?? 'unknown'),
            ...(typeof st.duration === 'number' ? { durationMs: st.duration } : {}),
            ...(typeof st.error === 'string' ? { error: st.error.slice(0, 8000) } : st.error && typeof st.error === 'object' && 'message' in (st.error as object) ? { error: String((st.error as { message: unknown }).message).slice(0, 8000) } : {}),
            ...(st.screenshot ? (() => { const f = resolve(st.screenshot, 'screenshot'); return f ? { screenshot: f } : {}; })() : {}),
            actions: groupActions(Array.isArray(st.actions) ? st.actions as Array<Record<string, unknown>> : []),
        }));
        const where = opts.features ? locateScenario(opts.features, String(s.feature ?? ''), String(s.name ?? ''), opts.ran) : null;
        if (where) addNotRun(detail, where.steps);
        return { index, name: String(s.name ?? ''), feature: String(s.feature ?? ''), status, steps: detail, durationMs: typeof s.duration === 'number' ? s.duration : undefined, ...(where ? { location: { file: where.file, line: where.line } } : {}), ...(failedStep ? { failedStep } : {}), files, matchedByTime };
    });

    const index = path.join(reportDir, 'index.html');
    return {
        resultsRoot: relRoot,
        reportIndex: fs.existsSync(index) ? path.relative(root, index).split(path.sep).join('/') : null,
        scenarios,
        run,
    };
}

/**
 * Playwright's command-line tool in the project (it has the Trace Viewer), looked up only inside
 * the project's node_modules — never through global paths.
 */
export function projectPlaywrightCli(repoRoot: string): string | null {
    const nm = path.join(repoRoot, 'node_modules');
    const cands = [
        path.join(nm, 'playwright-core', 'cli.js'),
        path.join(nm, 'playwright', 'node_modules', 'playwright-core', 'cli.js'),
        path.join(nm, '@playwright', 'test', 'node_modules', 'playwright-core', 'cli.js'),
        path.join(nm, 'playwright', 'cli.js'),
        // npm nests Playwright inside the framework package when the project needs another version.
        ...frameworkPackages(repoRoot).flatMap((pkg) => [
            path.join(pkg, 'node_modules', 'playwright-core', 'cli.js'),
            path.join(pkg, 'node_modules', 'playwright', 'cli.js'),
        ]),
    ];
    for (const c of cands) {
        try { if (fs.statSync(c).isFile() && inside(fs.realpathSync(repoRoot), fs.realpathSync(c))) return c; } catch { /* next */ }
    }
    return null;
}

/**
 * The framework's step actions are its log lines, prefixed with ✓ (pass), ✗ (fail), ℹ (info) or
 * ⚠ (warn) (CSScenarioContext). An element action is logged twice: "ℹ Executing Fill with "x" on
 * User name field" and then "✓ Fill with "x" successful on User name field (388ms)"; those pairs
 * become one action with its duration.
 */
export function groupActions(raw: Array<Record<string, unknown>>): StepAction[] {
    const out: StepAction[] = [];
    for (const a of raw.slice(0, 1000)) {
        let text = String(a.name ?? a.action ?? '').trim();
        if (!text) continue;
        let kind: ActionKind = a.status === 'failed' || a.status === 'fail' ? 'fail' : 'info';
        const icon = /^([✓✗ℹ⚠])\uFE0F?\s*/.exec(text);
        if (icon) {
            kind = icon[1] === '✓' ? 'pass' : icon[1] === '✗' ? 'fail' : icon[1] === '⚠' ? 'warn' : 'info';
            text = text.slice(icon[0].length);
        }
        const time = typeof a.timestamp === 'string' ? a.timestamp : undefined;
        // "<action> successful on <element> (Nms)" closes the "Executing <action> on <element>" before it.
        const done = /^(.*) successful on (.*) \((\d+)ms\)$/.exec(text);
        if (done) {
            const prev = out[out.length - 1];
            const what = `${done[1]} on ${done[2]}`;
            if (prev && prev.kind === 'info' && prev.text === what) { prev.kind = 'pass'; prev.durationMs = Number(done[3]); continue; }
            out.push({ kind: 'pass', text: what, durationMs: Number(done[3]), ...(time ? { time } : {}) });
            continue;
        }
        const exec = /^Executing (.*)$/.exec(text);
        out.push({ kind, text: exec ? exec[1] : text, ...(time ? { time } : {}) });
    }
    // An "Executing …" that never finished (the step failed during it) is shown as failed.
    return out;
}

/** Feature files of the project: per feature title, its scenarios with their steps (Background first). */
export interface FeatureIndex { byFeature: Map<string, Array<{ file: string; name: string; line: number; outline: boolean; steps: string[] }>> }

const SKIP = new Set(['node_modules', '.git', 'reports', 'test-results', 'dist', 'build', 'coverage', '.cs-studio']);

export function indexFeatures(repoRoot: string): FeatureIndex {
    const byFeature: FeatureIndex['byFeature'] = new Map();
    const walk = (dir: string, depth: number) => {
        if (depth > 12) return;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name.startsWith('.') && e.name !== '.') continue;
            const a = path.join(dir, e.name);
            if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(a, depth + 1); }
            else if (e.isFile() && e.name.endsWith('.feature')) {
                let text = '';
                try { const st = fs.statSync(a); if (st.size > 2 * 1024 * 1024) continue; text = fs.readFileSync(a, 'utf8'); } catch { continue; }
                const rel = path.relative(repoRoot, a).split(path.sep).join('/');
                parseFeature(text, rel, byFeature);
            }
        }
    };
    walk(repoRoot, 0);
    return { byFeature };
}

function parseFeature(text: string, file: string, into: FeatureIndex['byFeature']): void {
    const lines = text.split(/\r?\n/);
    let feature = '';
    let background: string[] = [];
    let current: { name: string; line: number; outline: boolean; steps: string[] } | null = null;
    let inBackground = false;
    let doc: string | null = null;
    const list = () => { if (!into.has(feature)) into.set(feature, []); return into.get(feature)!; };
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (doc) { if (t.startsWith(doc)) doc = null; continue; }
        const d = /^("{3}|`{3})/.exec(t); if (d) { doc = d[1]; continue; }
        if (!t || t.startsWith('#') || t.startsWith('@') || t.startsWith('|')) continue;
        let m: RegExpExecArray | null;
        if ((m = /^Feature:\s*(.*)$/.exec(t))) { feature = m[1].trim(); background = []; current = null; inBackground = false; continue; }
        if (/^Background:/.test(t)) { inBackground = true; current = null; continue; }
        if (/^Rule:/.test(t)) { inBackground = false; current = null; continue; }
        if ((m = /^(Scenario Outline|Scenario Template|Scenario|Example):\s*(.*)$/.exec(t))) {
            inBackground = false;
            current = { name: m[2].trim(), line: i + 1, outline: m[1] !== 'Scenario' && m[1] !== 'Example', steps: [...background] };
            list().push({ file, ...current });
            current = list()[list().length - 1];
            continue;
        }
        if (/^(Examples|Scenarios):/.test(t)) { current = current; continue; }
        if (/^(Given|When|Then|And|But|\*)\s/.test(t)) {
            if (inBackground) background.push(t);
            else if (current) current.steps.push(t);
        }
    }
}

/**
 * Where a reported scenario is. `ran`: the files the run was given (--features), which decide
 * between features that share a name (copies of a feature in several projects are common).
 */
export function locateScenario(index: FeatureIndex, feature: string, scenario: string, ran?: string[]): { file: string; line: number; steps: string[] } | null {
    let cands = index.byFeature.get(feature.trim()) ?? [];
    if (ran?.length) {
        const norm = (f: string) => f.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
        const inRun = cands.filter((c) => ran.some((r) => { const x = norm(r); return c.file === x || c.file.startsWith(x + '/'); }));
        if (inRun.length) cands = inRun;
    }
    const exact = cands.filter((c) => c.name === scenario.trim());
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null; // ambiguous: say nothing rather than guess
    // Outline iterations are reported with the example values or a suffix: match a unique outline.
    const outl = cands.filter((c) => c.outline && scenario.startsWith(c.name.replace(/<[^>]+>.*$/, '').trim()));
    return outl.length === 1 ? outl[0] : null;
}

/** Steps the report does not have, after the last reported one, if the reported ones match the file. */
export function addNotRun(detail: StepDetail[], fileSteps: string[]): void {
    if (detail.length >= fileSteps.length) return;
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const re = (s: string) => new RegExp('^' + norm(s).split(/<[^>]+>/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    for (let i = 0; i < detail.length; i++) if (!re(fileSteps[i]).test(norm(detail[i].text))) return; // not the same scenario shape
    for (const st of fileSteps.slice(detail.length)) detail.push({ text: st, status: 'not run', actions: [] });
}
