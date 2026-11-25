/**
 * Test quality across runs: each scenario's results over the recent runs, what kind of problem it has
 * (new failure, failing, flaky, fixed, stable), failures grouped by cause, quarantine and a pass-rate gate.
 *
 * Sources (verified in the framework):
 *  - The framework writes every run's results to report-data.json (suite.scenarios: name, feature, status,
 *    error / failed step error, duration, and in current versions retries and flaky). The Studio's run
 *    history keeps the results of runs it started; report folders on disk add runs from the command line
 *    or a pipeline. These are the source here.
 *  - The framework's own flaky store (.flaky-test-data) is not used for the classification: its score is a
 *    failure rate (a test that always fails scores highest) and it is keyed by scenario name only.
 *  - Quarantine is the tag @quarantine on a scenario (or its feature); the framework leaves such scenarios
 *    out of a run when EXCLUDE_TAGS (or --exclude-tags) names the tag.
 */
import * as fs from 'fs';
import * as path from 'path';
import { RunInfo, RunSummary, ScenarioResult, readReport } from '../run/runner';
import { CatalogFeature } from '../run/catalog';

export type QualityClass = 'new-failure' | 'failing' | 'flaky' | 'fixed' | 'stable' | 'skipped';

export interface QualityRun {
    id: string; at: string; source: 'studio' | 'report'; project?: string; env?: string;
    total: number; passed: number; failed: number; skipped: number; flaky: number; passRate: number;
    reportDir?: string;
    /** A debug run (one scenario at a time, stopped at breakpoints): not judged by the gate. */
    debug?: boolean;
}
export interface QualityResult { run: string; at: string; status: 'passed' | 'failed' | 'skipped'; retries: number; error?: string; duration: number; signature?: string }
export interface QualityScenario {
    key: string; name: string; feature: string;
    /** Where it is written (when the feature file is found). */
    file?: string; line?: number;
    quarantined: boolean;
    cls: QualityClass;
    /** Oldest first, one per run it ran in (within the window). */
    results: QualityResult[];
    passRate: number;
    /** Failed runs in a row up to the latest run (failing scenarios). */
    failingFor: number;
    /** Runs it passed only after a retry. */
    retriedPasses: number;
    /** Changes between passed and failed. */
    flips: number;
    lastFailure?: string; lastPass?: string;
    avgDuration: number;
    /** The run, project and environment it last ran in (to run it again). */
    lastRun: string; project?: string; env?: string;
}
export type FailureCategory = 'timeout' | 'element' | 'assertion' | 'api' | 'database' | 'step' | 'script' | 'other';
export interface FailureGroup {
    signature: string; category: FailureCategory; sample: string;
    failures: number; runs: number; inLatest: boolean; firstSeen: string; lastSeen: string;
    scenarios: Array<{ key: string; name: string; feature: string }>;
}
export interface GateSettings { minPassRate: number; noNewFailures: boolean; maxFlaky: number | null; ignoreQuarantined: boolean }
export interface GateRule { name: string; ok: boolean; detail: string }
export interface QualityReport {
    runs: QualityRun[];
    scenarios: QualityScenario[];
    groups: FailureGroup[];
    gate: { ok: boolean; run: string | null; rules: GateRule[] };
    counts: Record<QualityClass | 'quarantined', number>;
}

export const DEFAULT_GATE: GateSettings = { minPassRate: 95, noNewFailures: true, maxFlaky: null, ignoreQuarantined: true };
export const QUARANTINE_TAG = '@quarantine';

const strip = (t: string) => t.replace(/\u001b\[[0-9;]*m/g, '');
/** A data row of an outline is reported as "name_Iteration-2" (or with the row's values): the written scenario. */
export const baseName = (name: string) => name.replace(/_Iteration-\d+$/, '').trim();

/**
 * The cause of a failure without the details that change between runs (numbers, ids, addresses, quoted
 * values, times), so the same problem in different scenarios and runs has the same signature.
 */
export function failureSignature(error: string): string {
    const lines = strip(error).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^at\s/.test(l) && !/^=+/.test(l) && !/^Call log:?$/i.test(l));
    let first = lines[0] ?? '';
    // A Playwright check names its element on a line of its own ("Locator: getByTestId('total')"): part of the cause.
    const loc = lines.find((l, i) => i > 0 && /^Locator:\s*\S/.test(l));
    if (loc && !first.includes(loc.replace(/^Locator:\s*/, ''))) first = `${first} @ ${loc.replace(/^Locator:\s*/, '')}`;
    // Quoted values are data (masked), except where they name the element (a locator, a selector): kept, digits masked.
    const element = /locator|selector|getBy|element/i.test(first);
    // HTTP status codes are part of the cause (503 and 500 are different problems): kept when the message is about a status.
    const keep: string[] = [];
    if (/status|http|response/i.test(first)) first = first.replace(/\b[1-5]\d\d\b/g, (c) => { keep.push(c); return `\u0000${String.fromCharCode(96 + keep.length)}\u0000`; });
    return first
        .replace(/^(Error|AssertionError|TimeoutError|TypeError|ReferenceError)\s*:\s*/i, (m) => m)
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
        .replace(/https?:\/\/[^\s"'`)]+/g, '<url>')
        .replace(/\b\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?\b/g, '<date>')
        .replace(/"[^"]{0,200}"|'[^']{0,200}'|`[^`]{0,200}`/g, (q) => (element ? q.slice(0, 80) : '"…"'))
        .replace(/\b0x[0-9a-f]+\b/gi, '<n>')
        // Every number, also inside names (row-12, id q7): values that change between runs
        .replace(/\d+(\.\d+)?(\s*(ms|px|%)\b)?/g, '<n>')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\u0000([a-z])\u0000/g, (_m, i: string) => keep[i.charCodeAt(0) - 97] ?? '')
        .slice(0, 200);
}

/** What kind of failure it is, from its message. */
export function failureCategory(error: string): FailureCategory {
    const e = strip(error);
    if (/undefined step|no step definition|step definition.*not found|step.*is not defined/i.test(e)) return 'step';
    if (/unable to locate element|waiting for (locator|selector)|strict mode violation|element is not (visible|attached|enabled)|intercepts pointer events|no element|element.*not found/i.test(e)) return 'element';
    if (/time(d)?\s?out|exceeded/i.test(e)) return 'timeout';
    if (/database|\bsql\b|query result|ORA-\d|SQLSTATE|connection.*(db|database)|stored procedure/i.test(e)) return 'database';
    if (/status (code )?(should be |is )?\d{3}|\bstatus\b.*\b[1-5]\d\d\b|response|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up|network|fetch failed|\bAPI\b/i.test(e)) return 'api';
    if (/\b(TypeError|ReferenceError|SyntaxError|RangeError)\b|cannot read propert|is not a function|is not defined/i.test(e)) return 'script';
    if (/expect|assert|should|to (be|equal|contain|have)|mismatch|difference|but (was|got|found)|not equal/i.test(e)) return 'assertion';
    return 'other';
}

const normStatus = (s: string): 'passed' | 'failed' | 'skipped' => (s === 'passed' ? 'passed' : s === 'failed' || s === 'broken' ? 'failed' : 'skipped');

/** The class of a scenario from its results (oldest first). */
export function classify(results: Array<Pick<QualityResult, 'status' | 'retries'>>): { cls: QualityClass; flips: number; failingFor: number; retriedPasses: number } {
    const ran = results.filter((r) => r.status !== 'skipped');
    let flips = 0;
    for (let i = 1; i < ran.length; i++) if (ran[i].status !== ran[i - 1].status) flips++;
    const retriedPasses = ran.filter((r) => r.status === 'passed' && r.retries > 0).length;
    let failingFor = 0;
    for (let i = ran.length - 1; i >= 0 && ran[i].status === 'failed'; i--) failingFor++;
    if (!ran.length) return { cls: 'skipped', flips, failingFor, retriedPasses };
    const latest = ran[ran.length - 1];
    const previous = ran[ran.length - 2];
    // Flaky: passed only after a retry, or switched between passing and failing more than once
    // (one change is a new failure or a fix, not flakiness).
    const flaky = retriedPasses > 0 || flips >= 2;
    let cls: QualityClass;
    if (flaky) cls = 'flaky';
    else if (latest.status === 'failed') cls = previous && previous.status === 'failed' ? 'failing' : 'new-failure';
    // Fixed: failed earlier in these runs and passes since (one change); stable: never failed here.
    else cls = flips === 1 ? 'fixed' : 'stable';
    return { cls, flips, failingFor, retriedPasses };
}

/** Scenario tags from the feature files: where each scenario is and whether it is quarantined. */
function locate(catalog: CatalogFeature[]): Map<string, { file: string; line: number; quarantined: boolean }> {
    const m = new Map<string, { file: string; line: number; quarantined: boolean }>();
    for (const f of catalog) {
        const fq = f.tags.some(isQuarantineTag);
        for (const s of f.scenarios) {
            const k = `${f.name}\u0000${s.name}`;
            if (!m.has(k)) m.set(k, { file: f.path, line: s.line, quarantined: fq || s.tags.some(isQuarantineTag) });
        }
    }
    return m;
}
export const isQuarantineTag = (t: string) => t.toLowerCase() === QUARANTINE_TAG || t.toLowerCase() === QUARANTINE_TAG.slice(1);

/** Runs to look at: the Studio's (with results) and report files on disk that are not one of them. */
export function collectRuns(studioRuns: RunInfo[], reportFiles: string[], repoRoot: string, projectOf: (featureName: string) => string | undefined = () => undefined): Array<{ run: QualityRun; summary: RunSummary }> {
    const out: Array<{ run: QualityRun; summary: RunSummary }> = [];
    const known = new Set<string>();
    for (const r of studioRuns) {
        // A pull request's runs test other code (its own copy): not this branch's quality.
        if (!r.summary || r.pr || r.workdir) continue;
        known.add(path.resolve(r.summary.reportDir));
        out.push({ run: { ...toRun(r.id, r.startedAt, 'studio', r.summary, r.request.project, r.request.env), ...((r.request as { debug?: unknown }).debug ? { debug: true } : {}) }, summary: r.summary });
    }
    for (const f of reportFiles) {
        const dir = path.resolve(path.dirname(f));
        if (known.has(dir)) continue;
        let summary: RunSummary, at: string;
        try {
            summary = readReport(f);
            const data = JSON.parse(fs.readFileSync(f, 'utf8')) as { suite?: { startTime?: string; name?: string } };
            at = data.suite?.startTime && !isNaN(Date.parse(data.suite.startTime)) ? new Date(data.suite.startTime).toISOString() : fs.statSync(f).mtime.toISOString();
        } catch { continue; }
        if (!summary.scenarios.length) continue;
        const id = 'report:' + path.relative(repoRoot, dir).split(path.sep).join('/');
        // A report does not name its project: the project of its features (test/<project>/features).
        const projects = new Set(summary.scenarios.map((x) => projectOf(x.feature)).filter((x): x is string => !!x));
        out.push({ run: toRun(id, at, 'report', summary, projects.size === 1 ? [...projects][0] : undefined), summary });
    }
    return out.sort((a, b) => a.run.at.localeCompare(b.run.at));
}

function toRun(id: string, at: string, source: QualityRun['source'], s: RunSummary, project?: string, env?: string): QualityRun {
    const ran = s.passed + s.failed;
    return { id, at, source, project, env, total: s.total, passed: s.passed, failed: s.failed, skipped: s.skipped,
        flaky: s.scenarios.filter((x) => x.flaky).length, passRate: ran ? Math.round((s.passed / ran) * 1000) / 10 : 0, reportDir: s.reportDir };
}

export interface QualityInput {
    runs: Array<{ run: QualityRun; summary: RunSummary }>;
    catalog: CatalogFeature[];
    window: number;
    project?: string;
    gate: GateSettings;
}

export function buildQuality(input: QualityInput): QualityReport {
    const runs = input.runs.filter((r) => !input.project || r.run.project === input.project).slice(-Math.max(1, input.window));
    const where = locate(input.catalog);
    const by = new Map<string, { name: string; feature: string; results: QualityResult[]; last: QualityRun }>();
    for (const { run, summary } of runs) {
        for (const sc of summary.scenarios as ScenarioResult[]) {
            const key = `${sc.feature}\u0000${sc.name}`;
            let e = by.get(key);
            if (!e) { e = { name: sc.name, feature: sc.feature, results: [], last: run }; by.set(key, e); }
            const status = normStatus(sc.status);
            e.results.push({ run: run.id, at: run.at, status, retries: sc.retries ?? 0, duration: sc.duration,
                ...(status === 'failed' && sc.error ? { error: sc.error, signature: failureSignature(sc.error) } : {}) });
            e.last = run;
        }
    }
    const scenarios: QualityScenario[] = [...by.entries()].map(([key, e]) => {
        const c = classify(e.results);
        const ran = e.results.filter((r) => r.status !== 'skipped');
        const loc = where.get(`${e.feature}\u0000${baseName(e.name)}`) ?? where.get(`${e.feature}\u0000${e.name}`);
        const lastOf = (st: string) => [...ran].reverse().find((r) => r.status === st)?.at;
        return {
            key, name: e.name, feature: e.feature, ...(loc ? { file: loc.file, line: loc.line } : {}),
            quarantined: !!loc?.quarantined, cls: c.cls, results: e.results,
            passRate: ran.length ? Math.round((ran.filter((r) => r.status === 'passed').length / ran.length) * 1000) / 10 : 0,
            failingFor: c.failingFor, retriedPasses: c.retriedPasses, flips: c.flips,
            lastFailure: lastOf('failed'), lastPass: lastOf('passed'),
            avgDuration: ran.length ? Math.round(ran.reduce((t, r) => t + r.duration, 0) / ran.length) : 0,
            lastRun: e.last.id, project: e.last.project, env: e.last.env,
        };
    });
    const order: Record<QualityClass, number> = { 'new-failure': 0, failing: 1, flaky: 2, fixed: 3, stable: 4, skipped: 5 };
    scenarios.sort((a, b) => order[a.cls] - order[b.cls] || a.passRate - b.passRate || a.name.localeCompare(b.name));

    // Failures grouped by cause (all failures in the window; the latest run's first).
    const latest = runs.length ? runs[runs.length - 1].run.id : null;
    const groups = new Map<string, FailureGroup & { runSet: Set<string>; keys: Set<string> }>();
    for (const sc of scenarios) for (const r of sc.results) {
        if (r.status !== 'failed' || !r.signature) continue;
        let g = groups.get(r.signature);
        if (!g) { g = { signature: r.signature, category: failureCategory(r.error ?? ''), sample: (r.error ?? '').slice(0, 2000), failures: 0, runs: 0, inLatest: false, firstSeen: r.at, lastSeen: r.at, scenarios: [], runSet: new Set(), keys: new Set() }; groups.set(r.signature, g); }
        g.failures++; g.runSet.add(r.run);
        if (r.run === latest) g.inLatest = true;
        if (r.at < g.firstSeen) g.firstSeen = r.at;
        if (r.at >= g.lastSeen) { g.lastSeen = r.at; g.sample = (r.error ?? '').slice(0, 2000); }
        if (!g.keys.has(sc.key)) { g.keys.add(sc.key); g.scenarios.push({ key: sc.key, name: sc.name, feature: sc.feature }); }
    }
    const groupList: FailureGroup[] = [...groups.values()].map(({ runSet, keys: _k, ...g }) => ({ ...g, runs: runSet.size }))
        .sort((a, b) => Number(b.inLatest) - Number(a.inLatest) || b.scenarios.length - a.scenarios.length || b.failures - a.failures);

    const counts = { 'new-failure': 0, failing: 0, flaky: 0, fixed: 0, stable: 0, skipped: 0, quarantined: 0 } as QualityReport['counts'];
    for (const s of scenarios) { counts[s.cls]++; if (s.quarantined) counts.quarantined++; }

    return { runs: runs.map((r) => r.run), scenarios, groups: groupList, gate: evaluateGate([...runs].reverse().find((r) => !r.run.debug) ?? null, scenarios, input.gate, new Set(runs.filter((r) => r.run.debug).map((r) => r.run.id))), counts };
}

/**
 * The quality gate: every scenario in scope (the runs of the window, of the project chosen) is judged by its latest
 * result, so a run of only some scenarios (one chosen scenario, "Rerun failed") does not hide a failure another
 * scenario still has. Debug runs are not judged. The pass rate says how many results came from the latest run and
 * how many from earlier runs (and how many of those failed). Quarantined scenarios are left out when set.
 */
export function evaluateGate(latest: { run: QualityRun; summary: RunSummary } | null, scenarios: QualityScenario[], g: GateSettings, debugRuns: ReadonlySet<string> = new Set()): QualityReport['gate'] {
    if (!latest) return { ok: false, run: null, rules: [{ name: 'Results', ok: false, detail: 'No runs yet.' }] };
    const quarantined = scenarios.filter((s) => s.quarantined).length;
    const inScope = scenarios.filter((s) => !(g.ignoreQuarantined && s.quarantined));
    // Each scenario's latest result that counts (not skipped, not from a debug run).
    const judged = inScope.map((s) => ({ s, r: [...s.results].reverse().find((x) => x.status !== 'skipped' && !debugRuns.has(x.run)) }))
        .filter((x): x is { s: QualityScenario; r: QualityResult } => !!x.r);
    const ran = judged.length;
    const passed = judged.filter((x) => x.r.status === 'passed').length;
    const rate = ran ? Math.round((passed / ran) * 1000) / 10 : 0;
    const inLatest = judged.filter((x) => x.r.run === latest.run.id).length;
    const earlier = judged.filter((x) => x.r.run !== latest.run.id);
    const earlierFailed = earlier.filter((x) => x.r.status === 'failed').length;
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const scope = !earlier.length ? '' : `: ${inLatest} from the last run, ${earlier.length} from ${earlier.length === 1 ? 'an earlier run' : 'earlier runs'}${earlierFailed ? ` – ${earlierFailed === earlier.length ? (earlierFailed === 1 ? 'a failure' : 'all failed') : `${earlierFailed} failed`}` : ''}`;
    const notes = [quarantined && g.ignoreQuarantined ? 'quarantined left out' : ''].filter(Boolean);
    const judgedKeys = new Set(judged.map((x) => x.s.key));
    // A new failure or a flaky scenario still counts until a later result says otherwise (not only when it was in the last run).
    const newFails = judged.filter((x) => x.s.cls === 'new-failure' && x.r.status === 'failed').map((x) => x.s);
    const flaky = inScope.filter((s) => s.cls === 'flaky' && judgedKeys.has(s.key));
    const rules: GateRule[] = [
        { name: `Pass rate at least ${g.minPassRate}%`, ok: ran > 0 && rate >= g.minPassRate,
            detail: ran ? `${rate}% (${passed} of ${plural(ran, 'scenario', 'scenarios')}, each by its latest result${scope}${notes.length ? `; ${notes.join('; ')}` : ''})` : 'Nothing ran.' },
    ];
    if (g.noNewFailures) rules.push({ name: 'No new failures', ok: newFails.length === 0, detail: newFails.length ? newFails.map((s) => s.name).slice(0, 5).join(', ') + (newFails.length > 5 ? ` and ${newFails.length - 5} more` : '') : 'None.' });
    if (g.maxFlaky !== null) rules.push({ name: `At most ${g.maxFlaky} flaky`, ok: flaky.length <= g.maxFlaky, detail: `${flaky.length} flaky` });
    return { ok: rules.every((r) => r.ok), run: latest.run.id, rules };
}

export function readGate(file: string): GateSettings {
    try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<GateSettings>;
        return {
            minPassRate: typeof j.minPassRate === 'number' && j.minPassRate >= 0 && j.minPassRate <= 100 ? j.minPassRate : DEFAULT_GATE.minPassRate,
            noNewFailures: typeof j.noNewFailures === 'boolean' ? j.noNewFailures : DEFAULT_GATE.noNewFailures,
            maxFlaky: typeof j.maxFlaky === 'number' && j.maxFlaky >= 0 ? Math.floor(j.maxFlaky) : null,
            ignoreQuarantined: typeof j.ignoreQuarantined === 'boolean' ? j.ignoreQuarantined : DEFAULT_GATE.ignoreQuarantined,
        };
    } catch { return { ...DEFAULT_GATE }; }
}

/**
 * Add or remove @quarantine on a scenario in its feature file (the tag line above it; a new line when it
 * has none). The scenario must still be on the given line with that name. Line endings are kept.
 */
export function setQuarantineTag(text: string, line: number, name: string, on: boolean): string {
    return setScenarioTag(text, line, name, QUARANTINE_TAG, on, isQuarantineTag);
}

/**
 * Add or remove a tag on a scenario (see setQuarantineTag). `same` says which existing tags count as this
 * one (removed, or making an add a no-op).
 */
export function setScenarioTag(text: string, line: number, name: string, tag: string, on: boolean, same: (t: string) => boolean = (t) => t.toLowerCase() === tag.toLowerCase()): string {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const i = line - 1;
    const m = /^(\s*)(Scenario Outline|Scenario Template|Scenario|Example):\s*(.*)$/.exec(lines[i] ?? '');
    if (!m || m[3].trim() !== name.trim()) throw new Error('The scenario is no longer on that line: reload the page.');
    // The tag lines directly above (comments in between are kept).
    let j = i - 1;
    const tagLines: number[] = [];
    while (j >= 0 && (/^\s*@/.test(lines[j]) || /^\s*#/.test(lines[j]))) { if (/^\s*@/.test(lines[j])) tagLines.push(j); j--; }
    const has = tagLines.some((k) => lines[k].split(/\s+/).some(same));
    if (on) {
        if (has) return text;
        if (tagLines.length) { const k = tagLines[0]; lines[k] = lines[k].replace(/(\s*#.*)?$/, (c) => ` ${tag}${c}`); }
        else lines.splice(i, 0, `${m[1]}${tag}`);
    } else {
        if (!has) return text;
        for (const k of tagLines) {
            const [, indent, tags, comment = ''] = /^(\s*)([^#]*?)\s*(#.*)?$/.exec(lines[k])!;
            const kept = tags.split(/\s+/).filter((t) => t && !same(t));
            if (!kept.length && !comment) lines.splice(k, 1);
            else lines[k] = indent + [...kept, ...(comment ? [comment] : [])].join(' ');
        }
    }
    return lines.join(eol);
}

/**
 * Set tags on a scenario in one change: a tag "Kind:value" replaces any tag of the same kind above the
 * scenario (@TestPlanId:7 replaces @TestPlanId:3); other tags stay. The new tags go on the first tag line
 * (a new line when there is none). The scenario must still be on the given line with that name.
 */
export function withScenarioTags(text: string, line: number, name: string, tags: string[]): string {
    if (!tags.length) return text;
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const i = line - 1;
    const m = /^(\s*)(Scenario Outline|Scenario Template|Scenario|Example):\s*(.*)$/.exec(lines[i] ?? '');
    if (!m || m[3].trim() !== name.trim()) throw new Error('The scenario is no longer on that line: reload the page.');
    const kind = (t: string) => (t.includes(':') ? t.slice(0, t.indexOf(':') + 1).toLowerCase() : t.toLowerCase());
    const replaced = new Set(tags.map(kind));
    let j = i - 1;
    const tagLines: number[] = [];
    while (j >= 0 && (/^\s*@/.test(lines[j]) || /^\s*#/.test(lines[j]))) { if (/^\s*@/.test(lines[j])) tagLines.push(j); j--; }
    // Remove the tags being replaced (the line nearest the scenario keeps the new ones).
    const target = tagLines[0];
    for (const k of tagLines) {
        const [, indent, tagText, comment = ''] = /^(\s*)([^#]*?)\s*(#.*)?$/.exec(lines[k])!;
        const kept = tagText.split(/\s+/).filter((t) => t && !replaced.has(kind(t)));
        if (k === target) lines[k] = indent + [...kept, ...tags, ...(comment ? [comment] : [])].join(' ');
        else if (!kept.length && !comment) lines[k] = '\u0000';
        else lines[k] = indent + [...kept, ...(comment ? [comment] : [])].join(' ');
    }
    if (target === undefined) lines.splice(i, 0, `${m[1]}${tags.join(' ')}`);
    return lines.filter((l) => l !== '\u0000').join(eol);
}
