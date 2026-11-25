/**
 * Which tests a pull request calls for, worked out from what it changes (in its checked-out copy):
 *  - feature files it adds or edits;
 *  - features with a step that matches a step definition in a step file it changes (the new
 *    version, and the old version from the target: a removed or renamed step affects them too);
 *  - scenarios tagged @TestCaseId with a test case linked to the pull request (directly, or as
 *    "Tested By" of a linked story/bug);
 *  - features whose steps are in a step file that uses changed code (page objects, helpers: imports and
 *    pages found by name, see impactGraph.ts);
 *  - features that name a changed data file;
 *  - scenarios a recorded run (the framework's IMPACT_COLLECT data) saw load a changed file;
 *  - scenarios that failed in recent runs (offered, not chosen);
 *  - the full suite is recommended when configuration or packages change, or changed code reaches no feature.
 */
import * as fs from 'fs';
import * as path from 'path';
import { extractStepDefs, featureSteps, isStepFile, matches, StepDef } from '../lang/steps';
import { readCatalog } from './catalog';
import { automatedScenarios } from '../ado/workItems';
import { chainOf, codeFiles, importGraph, reachedBy, tsAliases } from './impactGraph';
import type { RunInfo } from './runner';

export interface ImpactFeature {
    path: string;
    name: string;
    project?: string;
    /** Why it is suggested. */
    reasons: string[];
    /** Only these scenarios (from linked test cases); empty: the whole feature. */
    scenarios: string[];
    total: number;
    /**
     * Why: 'direct' changed by the pull request or a linked test case; 'code' its steps use changed code; 'data' it names
     * a changed data file; 'coverage' a recorded run of it loaded a changed file; 'steps' it uses a changed step (wider);
     * 'recent' it failed recently (offered).
     */
    level: ImpactLevel;
}
export type ImpactLevel = 'direct' | 'code' | 'data' | 'coverage' | 'steps' | 'recent';
const ORDER: ImpactLevel[] = ['direct', 'code', 'data', 'coverage', 'steps', 'recent'];

/** The framework's recorded impact data (.cs-ai/impact/impact-data.json). */
export interface CoverageStore { tests: Record<string, { testId: string; testName: string; featureFile: string; files: string[] }> }

export interface PrImpact {
    features: ImpactFeature[];
    /** Why the whole suite should run instead (empty: the selection is enough). */
    fullSuite: string[];
    /** Changed files no feature can be tied to with certainty. */
    other: string[];
    /** Linked test cases and whether a scenario automates them. */
    testCases: Array<{ id: number; scenarios: Array<{ file: string; name: string }> }>;
    deletedFeatures: string[];
}

export type ChangeKind = 'feature' | 'steps' | 'code' | 'config' | 'data' | 'other';

/** What kind of file a changed path is, for a quick summary of a pull request. */
export function changeKind(file: string): ChangeKind {
    const f = file.replace(/^\/+/, '');
    const base = f.split('/').pop() ?? f;
    if (/\.feature$/i.test(f)) return 'feature';
    if (/\.(ts|js)$/i.test(f) && isStepFile(base)) return 'steps';
    if (/^config\//i.test(f) || /\.env(\.|$)/i.test(base) || /^(package(-lock)?\.json|tsconfig[^/]*\.json|\.npmrc|azure-pipelines[^/]*\.ya?ml)$/i.test(base)) return 'config';
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(f)) return 'code';
    if (/(^|\/)(test-?data|data|fixtures)\//i.test(f) || /\.(csv|xlsx?|json|ya?ml|xml)$/i.test(f)) return 'data';
    return 'other';
}

export function prImpact(o: {
    root: string;
    changes: Array<{ path: string; changeType: string; originalPath?: string }>;
    /** The target's version of a changed file (null: not there). */
    oldText: (file: string) => string | null;
    testCaseIds: number[];
    projects: string[];
    /** Whether a project's tests load this step file (its STEP_DEFINITIONS_PATH); project unknown: undefined. */
    loadsStepFile?: (project: string | undefined, file: string) => boolean;
    /** The framework's recorded impact data, if any. */
    coverage?: CoverageStore | null;
    /** Scenarios that failed in recent runs (feature name, scenario name, when). */
    recentFailures?: Array<{ feature: string; scenario: string; at: string }>;
}): PrImpact {
    const catalog = readCatalog(o.root);
    const byPath = new Map(catalog.map((f) => [f.path, f]));
    const out = new Map<string, Omit<ImpactFeature, 'level'> & { whole: boolean; picked: Set<string>; level: ImpactLevel }>();
    /** A scenario: only that scenario is wanted (test cases); none: the whole feature. The strongest level wins. */
    const add = (file: string, reason: string, scenario?: string, level: ImpactLevel = 'direct') => {
        const f = byPath.get(file);
        if (!f) return false;
        let e = out.get(file);
        if (!e) {
            const m = /^test\/([^/]+)\//.exec(file);
            e = { path: file, name: f.name, project: m && o.projects.includes(m[1]) ? m[1] : undefined, reasons: [], scenarios: [], total: f.scenarios.length, whole: false, picked: new Set(), level };
            out.set(file, e);
        }
        if (!e.reasons.includes(reason) && e.reasons.length < 6) e.reasons.push(reason);
        if (ORDER.indexOf(level) < ORDER.indexOf(e.level)) e.level = level;
        if (scenario) e.picked.add(scenario); else e.whole = true;
        return true;
    };
    const featureText = new Map<string, string>();
    const textOf = (file: string) => { if (!featureText.has(file)) { let t = ''; try { t = fs.readFileSync(path.join(o.root, file), 'utf8'); } catch { /* gone */ } featureText.set(file, t); } return featureText.get(file)!; };
    const projectOf = (file: string) => { const m = /^test\/([^/]+)\//.exec(file); return m && o.projects.includes(m[1]) ? m[1] : undefined; };
    /** Features that use one of these step definitions (in a project that loads their file). */
    const usingDefs = (defs: StepDef[]) => catalog.flatMap((f) => {
        const steps = featureSteps(textOf(f.path));
        const hit = defs.find((d) => (!o.loadsStepFile || o.loadsStepFile(projectOf(f.path), d.file)) && steps.some((s) => s.variants.some((v) => matches(d, v))));
        return hit ? [{ feature: f.path, def: hit }] : [];
    });
    const other: string[] = [];
    const deletedFeatures: string[] = [];
    const changedDefs: StepDef[] = [];
    for (const c of o.changes) {
        const isDelete = /delete/i.test(c.changeType);
        if (c.path.endsWith('.feature')) {
            if (isDelete) deletedFeatures.push(c.path);
            else add(c.path, /add/i.test(c.changeType) ? 'New feature in this pull request' : /rename/i.test(c.changeType) && c.originalPath ? `Renamed from ${c.originalPath}${/edit/i.test(c.changeType) ? ' and changed' : ''}` : 'Changed in this pull request');
            continue;
        }
        if (isStepFile(path.basename(c.path)) && /\.(ts|js)$/.test(c.path)) {
            let now = '';
            try { now = isDelete ? '' : fs.readFileSync(path.join(o.root, c.path), 'utf8'); } catch { /* gone */ }
            const before = o.oldText(c.path) ?? '';
            // Only the definitions that differ between the two versions matter.
            const a = extractStepDefs(now, c.path, false), b = extractStepDefs(before, c.path, false);
            const key = (d: StepDef) => d.pattern;
            // A definition's code: from its decorator to the next definition (or the end of the file).
            const body = (text: string, defs: StepDef[], d: StepDef) => {
                const next = defs.map((x) => x.line).filter((l) => l > d.line).sort((x, y) => x - y)[0];
                return text.split('\n').slice(d.line - 1, next ? next - 1 : undefined).join('\n').trim();
            };
            const changed = [
                ...a.filter((d) => { const old = b.find((x) => key(x) === key(d)); return !old || body(before, b, old) !== body(now, a, d); }),
                ...b.filter((d) => !a.some((x) => key(x) === key(d))),
            ];
            changedDefs.push(...(changed.length ? changed : a));
            continue;
        }
        other.push(c.path);
    }
    // Only when the feature's project loads that step file (else the change cannot affect it).
    if (changedDefs.length) for (const { feature, def } of usingDefs(changedDefs)) add(feature, `Uses the step "${def.pattern}" changed in ${def.file}`, undefined, 'steps');

    // Everything else: configuration, code reached through imports and page names, data files, recorded runs.
    const fullSuite: string[] = [];
    const untied: string[] = [];
    const isDelete = (p: string) => /delete/i.test(o.changes.find((c) => c.path === p)?.changeType ?? '');
    let graph: ReturnType<typeof importGraph> | undefined;
    const files = () => graph?.files ?? codeFiles(o.root);
    const read = (f: string) => { try { return fs.readFileSync(path.join(o.root, f), 'utf8'); } catch { return null; } };
    const aliases = tsAliases(o.root);
    const coverage = Object.values(o.coverage?.tests ?? {});
    const featureOf = (ref: string) => (/\.feature$/i.test(ref) ? (byPath.has(ref) ? ref : undefined) : catalog.find((f) => f.name === ref)?.path);
    for (const file of other) {
        const kind = changeKind(file);
        let tied = false;
        if (kind === 'config') { fullSuite.push(`${file} changed: configuration or packages every test uses`); continue; }
        if (kind === 'code' && !isDelete(file)) {
            graph = graph ?? importGraph(files(), read, aliases);
            const reach = reachedBy([file], graph.files, read, aliases, graph);
            const stepFiles = [...reach.files.keys()].filter((f) => f !== file && isStepFile(path.basename(f)));
            const defs = stepFiles.flatMap((sf) => extractStepDefs(read(sf) ?? '', sf, false));
            for (const { feature, def } of usingDefs(defs)) tied = add(feature, `Uses steps in ${def.file}, which ${chainOf(reach, def.file)}`, undefined, 'code') || tied;
        }
        if (kind === 'data' && !isDelete(file)) {
            const base = path.basename(file);
            for (const f of catalog) if (textOf(f.path).includes(base)) tied = add(f.path, `Names ${base}, which changed`, undefined, 'data') || tied;
        }
        for (const rec of coverage) {
            const fp = rec.files.includes(file) ? featureOf(rec.featureFile) : undefined;
            if (fp) tied = add(fp, `A recorded run of "${rec.testName}" loaded ${file}`, rec.testName, 'coverage') || tied;
        }
        if (!tied) untied.push(file);
    }
    const untiedCode = untied.filter((f) => changeKind(f) === 'code');
    if (untiedCode.length) fullSuite.push(`${untiedCode.slice(0, 3).join(', ')}${untiedCode.length > 3 ? ` and ${untiedCode.length - 3} more` : ''} changed and no feature's steps reach ${untiedCode.length === 1 ? 'it' : 'them'} in the code`);

    const automated = automatedScenarios(o.root);
    const testCases = o.testCaseIds.map((id) => ({ id, scenarios: (automated.get(id) ?? []).map((s) => ({ file: s.file, name: s.name })) }));
    for (const tc of testCases) for (const s of tc.scenarios) add(s.file, `Test case #${tc.id} is linked to this pull request`, s.name);
    // Failing recently: offered (a broken test fails whatever the change).
    for (const r of (o.recentFailures ?? []).slice(0, 30)) {
        const fp = catalog.find((f) => f.name === r.feature && f.scenarios.some((x) => x.name === r.scenario))?.path;
        if (fp && !out.has(fp)) add(fp, `Failed in a recent run (${r.at.slice(0, 10)})`, r.scenario, 'recent');
        else if (fp && out.get(fp)!.level === 'recent') add(fp, `Failed in a recent run (${r.at.slice(0, 10)})`, r.scenario, 'recent');
    }
    const features: ImpactFeature[] = [...out.values()].map(({ whole, picked, ...f }) => ({ ...f, scenarios: whole ? [] : [...picked] }))
        .sort((x, y) => (x.level === y.level ? x.path.localeCompare(y.path) : ORDER.indexOf(x.level) - ORDER.indexOf(y.level)));
    return { features, fullSuite, other: untied, testCases, deletedFeatures };
}

/** Scenarios whose latest result in the last 14 days of runs is a failure (latest first). */
export function recentFailures(runs: RunInfo[], now = Date.now()): Array<{ feature: string; scenario: string; at: string }> {
    const latest = new Map<string, { feature: string; scenario: string; at: string; failed: boolean }>();
    const finished = runs.filter((r) => r.summary && !r.bisect && r.endedAt && now - Date.parse(r.endedAt) < 14 * 86400_000)
        .sort((a, b) => Date.parse(b.endedAt!) - Date.parse(a.endedAt!));
    for (const r of finished) for (const sc of r.summary!.scenarios) {
        const k = `${sc.feature}\u0000${sc.name.replace(/_Iteration-\d+$/, '')}`;
        if (!latest.has(k)) latest.set(k, { feature: sc.feature, scenario: sc.name.replace(/_Iteration-\d+$/, ''), at: r.endedAt!, failed: sc.status === 'failed' || sc.status === 'broken' });
    }
    return [...latest.values()].filter((x) => x.failed).map(({ failed, ...x }) => x); // eslint-disable-line @typescript-eslint/no-unused-vars
}

/** The tests chosen for a pull request, kept with an observed run (everything ran) to check the choice afterwards. */
export interface RunSelection { features: Array<{ path: string; name: string; scenarios: string[] }>; observe: boolean }

/** An observed run: would the chosen tests alone have caught every failure? */
export function selectionCheck(r: Pick<RunInfo, 'summary'> & { pr?: { selection?: RunSelection } }): { selected: number; failed: number; missed: Array<{ scenario: string; feature: string }> } | null {
    const sel = r.pr?.selection;
    if (!sel?.observe || !r.summary) return null;
    const failed = r.summary.scenarios.filter((x) => x.status === 'failed' || x.status === 'broken');
    const chosen = (feature: string, scenario: string) => sel.features.some((f) => f.name === feature && (!f.scenarios.length || f.scenarios.includes(scenario.replace(/_Iteration-\d+$/, ''))));
    const missed = failed.filter((x) => !chosen(x.feature, x.name)).map((x) => ({ scenario: x.name, feature: x.feature }));
    const selected = r.summary.scenarios.filter((x) => chosen(x.feature, x.name)).length;
    return { selected, failed: failed.length, missed };
}

/** A run of a pull request as its status check: the state and one line (ADO shows it next to the builds). */
export function prStatusOf(r: Pick<RunInfo, 'state' | 'summary' | 'request'> & { pr?: { commit: string; selection?: RunSelection } }): { state: 'succeeded' | 'failed' | 'error' | 'pending'; description: string } {
    const s = r.summary;
    const at = r.pr ? ` at ${r.pr.commit.slice(0, 8)}` : '';
    const what = r.pr?.selection && !r.pr.selection.observe ? `${r.pr.selection.features.length} selected feature${r.pr.selection.features.length === 1 ? '' : 's'}` : 'all tests';
    if (r.state === 'running') return { state: 'pending', description: `Tests running (${what}, ${r.request.project}/${r.request.env})${at}` };
    if (!s || !s.total) return { state: 'error', description: `The test run ended without results (${r.state})${at}` };
    const line = `${s.passed} passed, ${s.failed} failed${s.skipped ? `, ${s.skipped} skipped` : ''} (${what}, ${r.request.project}/${r.request.env})${at}`;
    return { state: s.failed ? 'failed' : 'succeeded', description: line };
}
