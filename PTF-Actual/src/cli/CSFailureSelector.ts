/**
 * CSFailureSelector — pick failed scenarios from prior test reports and turn
 * them into runner filter args for --rerun-failed / --last-failed /
 * --execute-failures-only invocations.
 *
 * Report shape (produced by CSReportAggregator):
 *   <cwd>/reports/test-results-<ts>/reports/report-data.json
 *   {
 *     project, environment, executionTime, duration,
 *     stats: { totalScenarios, passed, failed, skipped, ... },
 *     scenarios: [
 *       { name, status: 'passed'|'failed'|'skipped'|'broken', feature, tags[], steps[], testData, ... }
 *     ]
 *   }
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FailedScenario {
    name: string;
    feature: string;
    tags: string[];
    dataRowIndex: number | null;
    reportSource: string;
}

export interface ReportMeta {
    reportDir: string;
    reportDataPath: string;
    project: string | null;
    environment: string | null;
    executionTime: string | null;
    totalScenarios: number;
    failedScenarios: number;
}

export interface SelectionFilters {
    features?: string[];
    tags?: string[];
    testNames?: string[];
    grep?: string;
}

export interface SelectionContext {
    currentProject?: string;
    currentEnvironment?: string;
    strictContext?: boolean;
}

export type SelectionOutcome =
    | { kind: 'ready'; failures: FailedScenario[]; excluded: ExcludedScenario[]; reports: ReportMeta[]; filterArgs: FilterArgs; summary: string }
    | { kind: 'no-failures'; reports: ReportMeta[]; summary: string }
    | { kind: 'no-matches'; failures: FailedScenario[]; excluded: ExcludedScenario[]; reports: ReportMeta[]; summary: string }
    | { kind: 'no-report'; searchedIn: string[]; summary: string }
    | { kind: 'parse-error'; reportDir: string; error: string; summary: string }
    | { kind: 'context-mismatch'; reports: ReportMeta[]; expected: SelectionContext; summary: string };

export interface ExcludedScenario {
    scenario: FailedScenario;
    reason: string;
}

export interface FilterArgs {
    features: string[];
    testNames: string[];
    scenarioCount: number;
    featureCount: number;
}

// ---------------------------------------------------------------------------
// Report discovery
// ---------------------------------------------------------------------------

const DEFAULT_REPORTS_BASE = 'reports';

/**
 * Walk `<workspaceRoot>/reports` for `test-results-<ts>` dirs, sort by
 * timestamp descending, return the first N with parseable report-data.json.
 * When `explicitPath` is given, use it directly (accepts dir or file path).
 */
export function findRecentReports(
    workspaceRoot: string,
    count: number = 1,
    explicitPath?: string,
    reportsBase?: string,
): { reports: string[]; searchedIn: string[] } {
    if (explicitPath) {
        const abs = path.isAbsolute(explicitPath) ? explicitPath : path.join(workspaceRoot, explicitPath);
        if (!fs.existsSync(abs)) return { reports: [], searchedIn: [abs] };
        if (fs.statSync(abs).isFile()) return { reports: [path.dirname(abs)], searchedIn: [abs] };
        const inner = path.join(abs, 'reports', 'report-data.json');
        if (fs.existsSync(inner)) return { reports: [path.join(abs, 'reports')], searchedIn: [abs] };
        const direct = path.join(abs, 'report-data.json');
        if (fs.existsSync(direct)) return { reports: [abs], searchedIn: [abs] };
        return { reports: [], searchedIn: [abs] };
    }

    const base = path.join(workspaceRoot, reportsBase || DEFAULT_REPORTS_BASE);
    if (!fs.existsSync(base)) return { reports: [], searchedIn: [base] };

    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); }
    catch { return { reports: [], searchedIn: [base] }; }

    const dirs = entries
        .filter((e) => e.isDirectory() && /^test-results-/.test(e.name))
        .map((e) => path.join(base, e.name))
        .sort()
        .reverse();

    const withData: string[] = [];
    for (const d of dirs) {
        const p = path.join(d, 'reports', 'report-data.json');
        if (fs.existsSync(p)) withData.push(path.join(d, 'reports'));
        if (withData.length >= count) break;
    }
    return { reports: withData, searchedIn: [base] };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface RawScenario {
    name?: string;
    status?: string;
    feature?: string;
    tags?: string[];
    testData?: { _dataRow?: number; _rowIndex?: number };
    dataRowIndex?: number;
}

interface RawReport {
    project?: string;
    environment?: string;
    executionTime?: string;
    generatedAt?: string;
    stats?: { totalScenarios?: number; failed?: number };
    scenarios?: RawScenario[];
    suite?: {
        name?: string;
        scenarios?: RawScenario[];
        totalScenarios?: number;
        failedScenarios?: number;
        passedScenarios?: number;
    };
}

export function parseReport(reportDir: string, workspaceRoot?: string): { meta: ReportMeta; scenarios: FailedScenario[] } | { error: string } {
    const p = path.join(reportDir, 'report-data.json');
    if (!fs.existsSync(p)) return { error: `report-data.json not found at ${p}` };
    let raw: RawReport;
    try {
        const src = fs.readFileSync(p, 'utf-8');
        raw = JSON.parse(src) as RawReport;
    } catch (e) {
        return { error: `Failed to parse ${p}: ${(e as Error).message}` };
    }

    // Aggregator writes `{suite: {name, scenarios}, ...}`. Older/manual reports
    // may put scenarios at the top level. Support both.
    const scenarios: RawScenario[] = Array.isArray(raw.suite?.scenarios)
        ? (raw.suite!.scenarios as RawScenario[])
        : Array.isArray(raw.scenarios)
            ? raw.scenarios
            : [];

    // Build a feature-name → file-path map by scanning the workspace test tree
    // so the emitted --features= is a runnable path, not the human feature name.
    const nameToPath = workspaceRoot ? indexFeatureFiles(workspaceRoot) : new Map<string, string>();

    const failed: FailedScenario[] = [];
    for (const s of scenarios) {
        const status = String(s.status || '').toLowerCase();
        if (status === 'failed' || status === 'broken') {
            const dataRowIndex = typeof s.dataRowIndex === 'number'
                ? s.dataRowIndex
                : (s.testData && (typeof s.testData._dataRow === 'number' ? s.testData._dataRow : (typeof s.testData._rowIndex === 'number' ? s.testData._rowIndex : null)));
            const rawFeature = String(s.feature || '').trim();
            const featurePath = resolveFeaturePath(rawFeature, nameToPath);
            failed.push({
                name: String(s.name || '').trim() || '<unnamed scenario>',
                feature: featurePath || rawFeature || '<unknown feature>',
                tags: Array.isArray(s.tags) ? s.tags.map((t) => String(t).trim()).filter(Boolean) : [],
                dataRowIndex: dataRowIndex == null ? null : Number(dataRowIndex),
                reportSource: p,
            });
        }
    }

    const total = typeof raw.stats?.totalScenarios === 'number'
        ? raw.stats.totalScenarios
        : (typeof raw.suite?.totalScenarios === 'number' ? raw.suite.totalScenarios : scenarios.length);
    const failedCount = typeof raw.stats?.failed === 'number'
        ? raw.stats.failed
        : (typeof raw.suite?.failedScenarios === 'number' ? raw.suite.failedScenarios : failed.length);

    const meta: ReportMeta = {
        reportDir,
        reportDataPath: p,
        project: raw.project ? String(raw.project) : null,
        environment: raw.environment ? String(raw.environment) : null,
        executionTime: raw.executionTime ? String(raw.executionTime) : (raw.generatedAt ? String(raw.generatedAt) : null),
        totalScenarios: total,
        failedScenarios: failedCount,
    };

    return { meta, scenarios: failed };
}

/**
 * Walk `<workspaceRoot>/test/**` for .feature files and index by their
 * `Feature: <name>` header so a report entry referring to a feature by name
 * (which is what CSReportAggregator emits) can be mapped back to a runnable
 * file path. Memoised per selectFailures call via closure caching in caller.
 */
function indexFeatureFiles(workspaceRoot: string): Map<string, string> {
    const out = new Map<string, string>();
    const roots = [
        path.join(workspaceRoot, 'test'),
        path.join(workspaceRoot, 'tests'),
        path.join(workspaceRoot, 'features'),
    ].filter((p) => fs.existsSync(p));
    for (const root of roots) walkForFeatures(root, workspaceRoot, out);
    return out;
}

function walkForFeatures(dir: string, workspaceRoot: string, out: Map<string, string>) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.git')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walkForFeatures(full, workspaceRoot, out); continue; }
        if (!e.isFile() || !full.toLowerCase().endsWith('.feature')) continue;
        try {
            const src = fs.readFileSync(full, 'utf-8');
            const m = src.match(/^\s*Feature:\s*(.+?)\s*$/m);
            if (!m) continue;
            const name = m[1].trim();
            const relPath = path.relative(workspaceRoot, full).replace(/\\/g, '/');
            if (!out.has(name)) out.set(name, relPath);
        } catch { /* ignore per-file errors */ }
    }
}

function resolveFeaturePath(rawFeature: string, nameToPath: Map<string, string>): string {
    if (!rawFeature) return '';
    // If the report already gave us a path (contains `.feature`), use it verbatim.
    if (/\.feature$/i.test(rawFeature)) return rawFeature.replace(/\\/g, '/');
    // Otherwise treat it as a feature NAME and look up the file.
    const mapped = nameToPath.get(rawFeature);
    return mapped ?? rawFeature;
}

// ---------------------------------------------------------------------------
// Union across N reports (dedup by feature+scenarioName+dataRowIndex)
// ---------------------------------------------------------------------------

function scenarioKey(s: FailedScenario): string {
    return `${s.feature}::${s.name}::${s.dataRowIndex ?? '_'}`;
}

function unionFailures(perReport: Array<{ meta: ReportMeta; scenarios: FailedScenario[] }>): { failures: FailedScenario[]; reports: ReportMeta[] } {
    const seen = new Set<string>();
    const out: FailedScenario[] = [];
    for (const r of perReport) {
        for (const s of r.scenarios) {
            const k = scenarioKey(s);
            if (!seen.has(k)) { seen.add(k); out.push(s); }
        }
    }
    return { failures: out, reports: perReport.map((r) => r.meta) };
}

// ---------------------------------------------------------------------------
// Filter application (INTERSECT semantics)
// ---------------------------------------------------------------------------

function normalizeTag(t: string): string {
    const s = t.trim();
    return s.startsWith('@') ? s.toLowerCase() : ('@' + s).toLowerCase();
}

function matchesFeatureGlob(featurePath: string, patterns: string[]): boolean {
    const norm = featurePath.replace(/\\/g, '/');
    for (const raw of patterns) {
        const pat = raw.trim();
        if (!pat) continue;
        const patNorm = pat.replace(/\\/g, '/');
        if (norm === patNorm) return true;
        if (norm.endsWith('/' + patNorm)) return true;
        const rx = new RegExp('^' + patNorm.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*\*/g, '§§DBLSTAR§§').replace(/\*/g, '[^/]*').replace(/§§DBLSTAR§§/g, '.*') + '$');
        if (rx.test(norm)) return true;
        if (norm.includes(patNorm)) return true;
    }
    return false;
}

function matchesTags(scenarioTags: string[], filterTags: string[]): boolean {
    if (filterTags.length === 0) return true;
    const set = new Set(scenarioTags.map(normalizeTag));
    return filterTags.some((raw) => set.has(normalizeTag(raw)));
}

function matchesNames(name: string, filterNames: string[]): boolean {
    if (filterNames.length === 0) return true;
    return filterNames.some((n) => name === n || name.includes(n));
}

function matchesGrep(name: string, grep?: string): boolean {
    if (!grep) return true;
    try { return new RegExp(grep, 'i').test(name); }
    catch { return false; }
}

function applyFilters(failures: FailedScenario[], f: SelectionFilters): { kept: FailedScenario[]; excluded: ExcludedScenario[] } {
    const kept: FailedScenario[] = [];
    const excluded: ExcludedScenario[] = [];
    for (const s of failures) {
        const reasons: string[] = [];
        if (f.features && f.features.length > 0 && !matchesFeatureGlob(s.feature, f.features)) reasons.push(`feature '${s.feature}' does not match --features filter`);
        if (f.tags && f.tags.length > 0 && !matchesTags(s.tags, f.tags)) reasons.push(`scenario tags [${s.tags.join(',')}] do not include any of --tags [${f.tags.join(',')}]`);
        if (f.testNames && f.testNames.length > 0 && !matchesNames(s.name, f.testNames)) reasons.push(`scenario name '${s.name}' does not match --test filter`);
        if (f.grep && !matchesGrep(s.name, f.grep)) reasons.push(`scenario name '${s.name}' does not match --grep /${f.grep}/i`);
        if (reasons.length === 0) kept.push(s);
        else excluded.push({ scenario: s, reason: reasons.join('; ') });
    }
    return { kept, excluded };
}

// ---------------------------------------------------------------------------
// Filter args builder — turns selected failures into effective run args
// ---------------------------------------------------------------------------

function buildFilterArgs(kept: FailedScenario[]): FilterArgs {
    const featureSet = new Set<string>();
    const nameSet = new Set<string>();
    for (const s of kept) {
        if (s.feature && s.feature !== '<unknown feature>') featureSet.add(s.feature);
        if (s.name) nameSet.add(s.name);
    }
    return {
        features: Array.from(featureSet).sort(),
        testNames: Array.from(nameSet).sort(),
        scenarioCount: kept.length,
        featureCount: featureSet.size,
    };
}

// ---------------------------------------------------------------------------
// Context match check
// ---------------------------------------------------------------------------

function checkContext(reports: ReportMeta[], ctx: SelectionContext): string | null {
    if (!ctx.strictContext) return null;
    for (const r of reports) {
        if (ctx.currentProject && r.project && r.project !== ctx.currentProject) {
            return `report project '${r.project}' does not match current --project=${ctx.currentProject} (report: ${r.reportDataPath})`;
        }
        if (ctx.currentEnvironment && r.environment && r.environment !== ctx.currentEnvironment) {
            return `report environment '${r.environment}' does not match current --env=${ctx.currentEnvironment} (report: ${r.reportDataPath})`;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export interface SelectFailuresInput {
    workspaceRoot: string;
    count?: number;                    // how many recent reports to union across (default 1)
    reportFrom?: string;               // explicit report dir/file (overrides discovery)
    reportsBase?: string;              // default 'reports'
    filters?: SelectionFilters;
    context?: SelectionContext;
}

export function selectFailures(input: SelectFailuresInput): SelectionOutcome {
    const count = Math.max(1, input.count || 1);
    const { reports: reportDirs, searchedIn } = findRecentReports(input.workspaceRoot, count, input.reportFrom, input.reportsBase);

    if (reportDirs.length === 0) {
        return {
            kind: 'no-report',
            searchedIn,
            summary: `No test report found. Searched: ${searchedIn.join(', ')}. Run tests at least once before --rerun-failed.`,
        };
    }

    const parsed: Array<{ meta: ReportMeta; scenarios: FailedScenario[] }> = [];
    for (const d of reportDirs) {
        const r = parseReport(d, input.workspaceRoot);
        if ('error' in r) {
            return {
                kind: 'parse-error',
                reportDir: d,
                error: r.error,
                summary: `Report unreadable at ${d}. ${r.error}`,
            };
        }
        parsed.push(r);
    }

    const ctxErr = checkContext(parsed.map((p) => p.meta), input.context || {});
    if (ctxErr) {
        return {
            kind: 'context-mismatch',
            reports: parsed.map((p) => p.meta),
            expected: input.context || {},
            summary: `Report context mismatch (--strict-context). ${ctxErr}`,
        };
    }

    const { failures, reports } = unionFailures(parsed);

    if (failures.length === 0) {
        return {
            kind: 'no-failures',
            reports,
            summary: `No failed scenarios found across ${reports.length} report(s). Nothing to rerun.`,
        };
    }

    const { kept, excluded } = applyFilters(failures, input.filters || {});

    if (kept.length === 0) {
        return {
            kind: 'no-matches',
            failures,
            excluded,
            reports,
            summary: `Found ${failures.length} failed scenario(s), but 0 match the combined filters (features/tags/test/grep). Nothing to rerun.`,
        };
    }

    const filterArgs = buildFilterArgs(kept);
    return {
        kind: 'ready',
        failures: kept,
        excluded,
        reports,
        filterArgs,
        summary: `Rerunning ${filterArgs.scenarioCount} failed scenario(s) across ${filterArgs.featureCount} feature file(s) from ${reports.length} report(s).`,
    };
}

// ---------------------------------------------------------------------------
// Pretty-print helpers (used by --dry-run)
// ---------------------------------------------------------------------------

export function formatOutcome(outcome: SelectionOutcome): string {
    const lines: string[] = [];
    lines.push('[rerun-failed] ' + outcome.summary);
    if (outcome.kind === 'ready' || outcome.kind === 'no-matches') {
        lines.push('[rerun-failed] Reports scanned:');
        for (const r of outcome.reports) {
            lines.push(`  - ${r.reportDataPath}  (project=${r.project ?? '?'}, env=${r.environment ?? '?'}, failed=${r.failedScenarios}/${r.totalScenarios})`);
        }
    }
    if (outcome.kind === 'ready') {
        lines.push(`[rerun-failed] Effective filter:`);
        lines.push(`  --features="${outcome.filterArgs.features.join(',')}"`);
        lines.push(`  --test="${outcome.filterArgs.testNames.join(',')}"`);
        lines.push('[rerun-failed] Scenarios to rerun:');
        const byFeature = new Map<string, FailedScenario[]>();
        for (const s of outcome.failures) {
            if (!byFeature.has(s.feature)) byFeature.set(s.feature, []);
            byFeature.get(s.feature)!.push(s);
        }
        for (const [feat, arr] of byFeature.entries()) {
            lines.push(`  ${feat}`);
            for (const s of arr) {
                const rowSuffix = s.dataRowIndex != null ? ` [row ${s.dataRowIndex}]` : '';
                const tagSuffix = s.tags.length > 0 ? ` (${s.tags.join(' ')})` : '';
                lines.push(`    - ${s.name}${rowSuffix}${tagSuffix}`);
            }
        }
        if (outcome.excluded.length > 0) {
            lines.push(`[rerun-failed] Excluded ${outcome.excluded.length} failure(s) by filter (top 5):`);
            for (const e of outcome.excluded.slice(0, 5)) {
                lines.push(`  - ${e.scenario.name} — ${e.reason}`);
            }
        }
    }
    return lines.join('\n');
}
