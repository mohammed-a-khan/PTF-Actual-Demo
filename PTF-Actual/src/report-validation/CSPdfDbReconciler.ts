/**
 * PDF-vs-DB pair reconciler (v1.53).
 *
 * Reconciles a candidate PDF against reference rows loaded from a DB via a
 * consumer-supplied helper module. Follows the framework's existing "DB
 * calls only in the DB helper" rule — the framework never talks to the DB
 * directly, it delegates to a helper method the consumer writes.
 *
 * Rules JSON schema (delta from PDF-vs-PDF):
 *   {
 *     "sections": {...},
 *     "knownDifferences": [...],
 *     "referenceDataSource": {
 *       "kind": "consumer-helper",
 *       "module": "test/<project>/helpers/<YourDbHelper>.js",
 *       "className": "<YourDbHelper>",                 // optional (default: default export or module itself)
 *       "sections": {
 *         "<Section A>": {
 *           "method": "<queryMethodA>",
 *           "params": { "reportId": "<runtime-value>" }
 *         },
 *         "<Section B>": {
 *           "method": "<queryMethodB>",
 *           "params": { "reportId": "<runtime-value>" },
 *           "resultSetIndex": 0                        // when helper returns multi-result-set
 *         }
 *       }
 *     }
 *   }
 *
 * Helper method signatures (either):
 *   1. Simple:    async <yourMethod>(params) → Row[]
 *      where Row is Record<string, string|number|null> — keys are column names,
 *      values are cell values matching the section's rules.
 *   2. Multi-RS:  async <yourMethod>(params) → { resultSets: Row[][] }
 *      when the DB call (typically a stored procedure) returns multiple result
 *      sets. Rules JSON's `resultSetIndex` selects which one to use per section.
 *
 * Framework instantiates the class (if `className` given), calls the method,
 * treats returned rows as the reference-side of the reconciliation. Rest of
 * the pipeline is identical to PDF-vs-PDF.
 *
 * @module report-validation/CSPdfDbReconciler
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractPagesFromPdf } from './CSReportPdfExtractor';
import { analyzeReport } from './CSReportPdfLayoutAnalyzer';
import type { AnalyzedSection, TableRow, ColumnBand, AnalyzedReport } from './CSReportPdfTypes';
import type {
    KnownDifference,
    GlobalTolerance,
    ReconcileSectionRule,
    ReconcileColumnRule,
    ReconcileFinding,
    ReconcileResult,
} from './CSPdfPairReconciler';
import { reconcileAnalyzedReports } from './CSPdfPairReconciler';

export interface DbSectionSpec {
    /** Method name on the helper module/class to call. */
    method: string;
    /** Named params passed as a single object to the helper method. */
    params?: Record<string, unknown>;
    /** For multi-result-set helpers: which result set to pick. Default 0. */
    resultSetIndex?: number;
}

export interface DbReferenceDataSource {
    kind: 'consumer-helper';
    /** Path to the helper module (relative to workspace root, or absolute). */
    module: string;
    /** Optional class name to instantiate on the module. If omitted, uses default export or the module namespace. */
    className?: string;
    /** Per-section helper-method mapping. */
    sections: Record<string, DbSectionSpec>;
}

export interface PdfDbRulesJson {
    _meta?: Record<string, unknown>;
    sections: Record<string, ReconcileSectionRule>;
    knownDifferences?: KnownDifference[];
    globalTolerance?: GlobalTolerance;
    ignoreSections?: string[];
    ignoreColumns?: string[];
    aliasFuzzyThreshold?: number;
    /**
     * Enables relaxed matching (column-name fuzzy fallback, row-key
     * normalization, string-value normalization, total-row auto-skip, subset
     * auto-skip) — set automatically by the zero-JSON `reconcilePdfDbAuto`
     * flow. Hand-authored rules default to strict matching.
     */
    autoMode?: boolean;
    referenceDataSource: DbReferenceDataSource;
}

export interface ReconcilePdfDbOptions {
    candidatePdfPath: string;
    rulesPath?: string;
    rulesInline?: PdfDbRulesJson;
    /** Optional override — dependency-injects the helper (used by unit tests). */
    helperFactory?: () => unknown;
}

/**
 * Zero-JSON PDF-vs-DB reconciliation. Consumer supplies only:
 *   - the PDF to compare
 *   - a helper module + method (resolved from `HELPERS_PATH` config, or an
 *     explicit path) plus its params
 *   - (optional) the section title on the PDF side to match rows against
 *
 * Framework auto-detects the target section by column-name overlap with the
 * DB rows, auto-composes a keyColumns list, and reconciles cell-by-cell in
 * auto-mode. Meant for the everyday case where hand-authoring
 * `PdfDbRulesJson` is more ceremony than the test deserves.
 */
export interface ReconcilePdfDbAutoOptions {
    candidatePdfPath: string;
    /** Helper module name (looked up under `HELPERS_PATH`) OR absolute/relative file path. */
    helperModule: string;
    /** Class exported from the module. Defaults to same-as-module-name. */
    helperClassName?: string;
    /** Method to call on the helper instance. */
    method: string;
    /** Params passed to the helper method. */
    params?: Record<string, unknown>;
    /** Optional section title on the PDF side. When omitted, framework picks
     * the section whose columns best overlap the DB row keys. */
    sectionHint?: string;
    /** When helper returns multi-result-set, index to pick. Default 0. */
    resultSetIndex?: number;
    /** Optional override — dependency-injects the helper (used by unit tests). */
    helperFactory?: () => unknown;
}

/**
 * Zero-JSON entry — consumer-friendly PDF-vs-DB reconciliation. The framework
 * auto-detects the matching section, auto-composes the key columns, and
 * reconciles in auto-mode (relaxed matching for common formatting drift).
 *
 * Consumer's total authoring:
 *   - one Gherkin step call
 *   - one helper module method that returns Row[] or {resultSets: Row[][]}
 *
 * No rules JSON, no section→method mapping, no keyColumns declaration.
 */
export async function reconcilePdfDbAuto(opts: ReconcilePdfDbAutoOptions): Promise<ReconcileResult> {
    if (!fs.existsSync(opts.candidatePdfPath)) throw new Error(`Candidate PDF not found: ${opts.candidatePdfPath}`);

    // 1. Extract + analyze candidate PDF
    const candPages = await extractPagesFromPdf(opts.candidatePdfPath);
    const candAnalyzed = analyzeReport(candPages);

    // 2. Load helper + fetch rows
    const helper = (opts.helperFactory
        ? opts.helperFactory()
        : loadHelperByName(opts.helperModule, opts.helperClassName)) as HelperInstance;
    const method = helper[opts.method];
    if (typeof method !== 'function') {
        throw new Error(`Helper "${opts.helperModule}" does not export method "${opts.method}"`);
    }
    let raw: unknown;
    try {
        raw = await method.call(helper, opts.params ?? {});
    } catch (e) {
        throw new Error(`Helper "${opts.helperModule}.${opts.method}" threw: ${(e as Error).message}`);
    }
    const rows = extractRows(raw, opts.method, opts.resultSetIndex ?? 0);
    if (rows.length === 0) {
        throw new Error(`Helper "${opts.helperModule}.${opts.method}" returned zero rows — nothing to compare against`);
    }

    // 3. Determine target PDF section
    const dbColumnKeys = Object.keys(rows[0] ?? {});
    const targetSectionTitle = opts.sectionHint
        ? resolveSectionByHint(candAnalyzed, opts.sectionHint)
        : autoDetectSection(candAnalyzed, dbColumnKeys);

    // 4. Auto-generate a section rule matching what generateReconciliationRulesFromPair
    // would emit — same code path preserved.
    const pdfSection = mergeAnalyzedByTitle(candAnalyzed).get(targetSectionTitle);
    if (!pdfSection) {
        throw new Error(`Section "${targetSectionTitle}" not found in PDF "${opts.candidatePdfPath}"`);
    }
    const sectionRule = autoBuildSectionRule(pdfSection, dbColumnKeys);

    // 5. Build a virtual reference AnalyzedReport from the DB rows
    const pseudoSection = buildPseudoSection(targetSectionTitle, rows, sectionRule, 1);
    const referenceAnalyzed: AnalyzedReport = {
        pageCount: 1,
        pages: [
            { pageNumber: 1, sections: [pseudoSection], header: [], footer: [], residualText: [] },
        ],
        toc: [],
        mergedSections: [pseudoSection],
    };

    // 6. Wrap into a minimal ReconcileRules object with autoMode ON
    const rules: PdfDbRulesJson = {
        _meta: {
            candidateSource: `pdf:${opts.candidatePdfPath}`,
            referenceSource: `db://${opts.helperModule}.${opts.method}`,
            description: 'Auto-generated rules (zero-JSON PDF-vs-DB).',
        },
        sections: { [targetSectionTitle]: sectionRule },
        globalTolerance: { currency: 0.01, percentage: 0.001, count: 0, number: 0.01 },
        aliasFuzzyThreshold: 0.85,
        autoMode: true,
        referenceDataSource: {
            kind: 'consumer-helper',
            module: opts.helperModule,
            className: opts.helperClassName,
            sections: {
                [targetSectionTitle]: { method: opts.method, params: opts.params ?? {} },
            },
        },
    };

    return reconcileAnalyzedReports({
        candidatePdf: opts.candidatePdfPath,
        referencePdf: `db://${opts.helperModule}.${opts.method}`,
        candidateAnalyzed: candAnalyzed,
        referenceAnalyzed,
        rules,
    });
}

/**
 * Top-level entry — reconcile a PDF against DB rows via a consumer helper.
 */
export async function reconcilePdfDbFromRules(opts: ReconcilePdfDbOptions): Promise<ReconcileResult> {
    if (!fs.existsSync(opts.candidatePdfPath)) throw new Error(`Candidate PDF not found: ${opts.candidatePdfPath}`);
    let rules: PdfDbRulesJson;
    if (opts.rulesInline) {
        rules = opts.rulesInline;
    } else if (opts.rulesPath) {
        if (!fs.existsSync(opts.rulesPath)) throw new Error(`Rules JSON not found: ${opts.rulesPath}`);
        rules = JSON.parse(fs.readFileSync(opts.rulesPath, 'utf-8')) as PdfDbRulesJson;
    } else {
        throw new Error('Provide either rulesPath or rulesInline');
    }
    if (!rules.referenceDataSource || rules.referenceDataSource.kind !== 'consumer-helper') {
        throw new Error('rules.referenceDataSource.kind must be "consumer-helper"');
    }

    // 1. Extract candidate PDF
    const candPages = await extractPagesFromPdf(opts.candidatePdfPath);
    const candAnalyzed = analyzeReport(candPages);

    // 2. Load DB rows via the consumer helper
    const helper = (opts.helperFactory ? opts.helperFactory() : loadHelper(rules.referenceDataSource)) as HelperInstance;
    const referenceAnalyzed = await buildReferenceFromDb(helper, rules.referenceDataSource, rules.sections);

    // 3. Feed both to the reconciler (reuses PDF-vs-PDF core)
    const result = reconcileAnalyzedReports({
        candidatePdf: opts.candidatePdfPath,
        referencePdf: `db://${rules.referenceDataSource.module}`,
        candidateAnalyzed: candAnalyzed,
        referenceAnalyzed: referenceAnalyzed,
        rules,
    });

    return result;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface HelperInstance {
    [method: string]: (...args: unknown[]) => Promise<unknown>;
}

/**
 * Load a helper by short name — resolves against the configured `HELPERS_PATH`
 * (from `CSConfigurationManager`, defaulting to `test/<project>/helpers`).
 * Also accepts absolute paths and paths ending in `.js`/`.ts`.
 */
function loadHelperByName(helperModule: string, className?: string): HelperInstance {
    const workspaceRoot = process.env.CS_QA_WORKSPACE_ROOT || process.cwd();
    // If the caller passed a real path (contains a separator OR ends with .js/.ts), use it directly
    const isPath = /[\\/]/.test(helperModule) || /\.[jt]s$/.test(helperModule);
    let modulePath: string;
    if (isPath) {
        modulePath = path.isAbsolute(helperModule) ? helperModule : path.resolve(workspaceRoot, helperModule);
    } else {
        // Look up HELPERS_PATH from configuration; fall back to conventional locations
        let helpersDir = '';
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { CSConfigurationManager } = require('../core/CSConfigurationManager');
            helpersDir = CSConfigurationManager.getInstance().get('HELPERS_PATH', '');
        } catch { /* framework not booted — fall back */ }
        const candidates = [
            helpersDir ? path.resolve(workspaceRoot, helpersDir, `${helperModule}.js`) : '',
            helpersDir ? path.resolve(workspaceRoot, helpersDir, `${helperModule}.ts`) : '',
            path.resolve(workspaceRoot, 'test', 'helpers', `${helperModule}.js`),
            path.resolve(workspaceRoot, 'helpers', `${helperModule}.js`),
        ].filter(Boolean);
        const hit = candidates.find((p) => fs.existsSync(p));
        if (!hit) {
            throw new Error(
                `Reconciliation helper "${helperModule}" not found. Tried: ${candidates.join(', ')}. ` +
                `Set HELPERS_PATH in your project config or pass an explicit relative path.`,
            );
        }
        modulePath = hit;
    }
    if (!fs.existsSync(modulePath)) throw new Error(`Reconciliation helper module not found: ${modulePath}`);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(modulePath);
    // Class-name resolution: explicit param → mod[className] → mod[helperModule] (bare-name convention)
    const className2 = className ?? path.basename(helperModule).replace(/\.[jt]s$/, '');
    if (mod[className2] && typeof mod[className2] === 'function') return new mod[className2]() as HelperInstance;
    if (mod.default && typeof mod.default === 'function') return new mod.default() as HelperInstance;
    if (mod.default && typeof mod.default === 'object') return mod.default as HelperInstance;
    return mod as HelperInstance;
}

/** Unwrap helper return value to a flat Row[]. */
function extractRows(raw: unknown, methodName: string, resultSetIndex: number): Array<Record<string, unknown>> {
    if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
    if (raw && typeof raw === 'object' && Array.isArray((raw as { resultSets?: unknown[] }).resultSets)) {
        const sets = (raw as { resultSets: Array<Array<Record<string, unknown>>> }).resultSets;
        if (resultSetIndex < 0 || resultSetIndex >= sets.length) {
            throw new Error(`resultSetIndex ${resultSetIndex} out of bounds for ${sets.length} result sets`);
        }
        return sets[resultSetIndex];
    }
    throw new Error(
        `Helper "${methodName}" returned unexpected shape (expected Row[] OR { resultSets: Row[][] }); got: ${Object.prototype.toString.call(raw)}`,
    );
}

/** Section title lookup — exact match first, then fuzzy at 0.85. */
function resolveSectionByHint(analyzed: AnalyzedReport, hint: string): string {
    const titles = new Set<string>();
    for (const p of analyzed.pages) for (const s of p.sections) titles.add(s.title);
    const lc = hint.toLowerCase();
    for (const t of titles) if (t.toLowerCase() === lc) return t;
    // Fuzzy — reuse the reconciler's Levenshtein (imported lazily so we don't
    // depend on internal export). Simple substring / prefix / suffix match:
    for (const t of titles) if (t.toLowerCase().includes(lc) || lc.includes(t.toLowerCase())) return t;
    throw new Error(
        `Section "${hint}" not found in PDF. Available sections: ${Array.from(titles).map((t) => `"${t}"`).join(', ')}`,
    );
}

/** Pick the PDF section whose column headers best overlap the DB row keys. */
function autoDetectSection(analyzed: AnalyzedReport, dbColumnKeys: string[]): string {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const dbSet = new Set(dbColumnKeys.map(norm));
    let bestTitle = '';
    let bestScore = -1;
    const scored: Array<{ title: string; score: number; hits: number }> = [];
    for (const [title, section] of mergeAnalyzedByTitle(analyzed).entries()) {
        const cols = section.columns.map((c) => norm(c.header ?? '')).filter((h) => h.length > 0);
        if (cols.length === 0) continue;
        let hits = 0;
        for (const c of cols) if (dbSet.has(c)) hits++;
        const score = hits / Math.max(dbColumnKeys.length, cols.length);
        scored.push({ title, score, hits });
        if (score > bestScore) {
            bestScore = score;
            bestTitle = title;
        }
    }
    if (bestScore < 0.3 || !bestTitle) {
        const preview = scored
            .sort((a, b) => b.score - a.score)
            .slice(0, 5)
            .map((s) => `"${s.title}" (${s.hits}/${dbColumnKeys.length})`)
            .join(', ');
        throw new Error(
            `Could not auto-detect a PDF section matching DB columns [${dbColumnKeys.join(', ')}]. ` +
            `Best candidates: ${preview}. Pass a sectionHint to disambiguate, or rename DB keys / PDF headers so they overlap.`,
        );
    }
    return bestTitle;
}

/** Fold analyzed pages into a title→section map (first section per title). */
function mergeAnalyzedByTitle(analyzed: AnalyzedReport): Map<string, AnalyzedSection> {
    const out = new Map<string, AnalyzedSection>();
    for (const p of analyzed.pages) {
        for (const s of p.sections) {
            if (!out.has(s.title)) out.set(s.title, s);
        }
    }
    return out;
}

/**
 * Auto-compose the section rule (keyColumns + columns) from the PDF section's
 * detected columns. Uses the same picker as the PDF-vs-PDF auto-mode.
 */
function autoBuildSectionRule(section: AnalyzedSection, dbColumnKeys: string[]): ReconcileSectionRule {
    // Intersect PDF headers with DB keys (normalized) to build the column map.
    // Preserves PDF header names — the reconciler will fuzzy-match them
    // against DB row keys when building the reference pseudo-section.
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const dbNormSet = new Set(dbColumnKeys.map(norm));

    const pdfHeaders = section.columns.map((c) => (c.header ?? '').trim()).filter((h) => h.length > 0);
    const columns: Record<string, ReconcileColumnRule> = {};
    for (const h of pdfHeaders) {
        if (dbNormSet.has(norm(h))) columns[h] = {};
    }
    if (Object.keys(columns).length === 0) {
        // No overlap detected — fall back to declaring every DB column,
        // using DB key as-is. Reconciler will fuzzy-match to PDF headers.
        for (const dbKey of dbColumnKeys) columns[dbKey] = {};
    }
    // Composite keyColumns via the picker used by generateReconciliationRulesFromPair
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { pickKeyColumnIndicesForRule } = require('./CSPdfPairReconciler');
    // Framework internal — accessed via a re-export we'll add below. Passing PDF section
    // + resolved column list lets it inspect real cell values for the scoring.
    const keyColumns = pickKeyColumnIndicesForRule(section, Object.keys(columns));
    return { keyColumns, columns };
}

function loadHelper(source: DbReferenceDataSource): HelperInstance {
    const workspaceRoot = process.env.CS_QA_WORKSPACE_ROOT || process.cwd();
    const modulePath = path.isAbsolute(source.module) ? source.module : path.resolve(workspaceRoot, source.module);
    if (!fs.existsSync(modulePath)) throw new Error(`Reconciliation helper module not found: ${modulePath}`);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(modulePath);
    if (source.className) {
        const Ctor = mod[source.className] ?? mod.default?.[source.className];
        if (typeof Ctor !== 'function') {
            throw new Error(`Helper module "${modulePath}" does not export class "${source.className}"`);
        }
        return new Ctor() as HelperInstance;
    }
    // No className given — try default export as instance, then module itself
    if (mod.default && typeof mod.default === 'object') return mod.default as HelperInstance;
    return mod as HelperInstance;
}

async function buildReferenceFromDb(
    helper: HelperInstance,
    source: DbReferenceDataSource,
    sectionRules: Record<string, ReconcileSectionRule>,
): Promise<AnalyzedReport> {
    const pseudoSections: AnalyzedSection[] = [];
    let sectionOrder = 0;

    for (const [canonicalSection, dbSpec] of Object.entries(source.sections)) {
        const sectionRule = sectionRules[canonicalSection];
        if (!sectionRule) {
            throw new Error(`Rules declare DB source for section "${canonicalSection}" but no matching section in rules.sections`);
        }
        const method = helper[dbSpec.method];
        if (typeof method !== 'function') {
            throw new Error(`Reconciliation helper does not have method "${dbSpec.method}"`);
        }
        let raw: unknown;
        try {
            raw = await method.call(helper, dbSpec.params ?? {});
        } catch (e) {
            throw new Error(`Helper "${dbSpec.method}" threw: ${(e as Error).message}`);
        }
        // Extract rows (handle both simple and multi-result-set shapes)
        let rows: Array<Record<string, unknown>>;
        if (Array.isArray(raw)) {
            rows = raw as Array<Record<string, unknown>>;
        } else if (raw && typeof raw === 'object' && Array.isArray((raw as { resultSets?: unknown[] }).resultSets)) {
            const sets = (raw as { resultSets: Array<Array<Record<string, unknown>>> }).resultSets;
            const idx = dbSpec.resultSetIndex ?? 0;
            if (idx < 0 || idx >= sets.length) {
                throw new Error(
                    `Section "${canonicalSection}": resultSetIndex ${idx} out of bounds for ${sets.length} result sets`,
                );
            }
            rows = sets[idx];
        } else {
            throw new Error(
                `Helper "${dbSpec.method}" returned unexpected shape (expected Row[] OR { resultSets: Row[][] }); got: ${Object.prototype.toString.call(raw)}`,
            );
        }
        pseudoSections.push(buildPseudoSection(canonicalSection, rows, sectionRule, ++sectionOrder));
    }

    // Wrap as a single-page AnalyzedReport (page number is arbitrary; the reconciler
    // walks per-section, not per-page).
    return {
        pageCount: 1,
        pages: [
            {
                pageNumber: 1,
                sections: pseudoSections,
                header: [],
                footer: [],
                residualText: [],
            },
        ],
        toc: [],
        mergedSections: pseudoSections,
    };
}

/**
 * Materialise DB rows as an AnalyzedSection so the reconciler can walk them
 * with the same code path used for PDF-side sections.
 */
function buildPseudoSection(
    title: string,
    rows: Array<Record<string, unknown>>,
    rule: ReconcileSectionRule,
    order: number,
): AnalyzedSection {
    // Determine columns: union of keys from the declared column rules + observed keys
    const declaredCols = Object.keys(rule.columns);
    const observedKeys = new Set<string>();
    for (const row of rows) for (const k of Object.keys(row)) observedKeys.add(k);
    // Merge (declared first, then observed extras)
    const columnHeaders: string[] = [
        ...declaredCols,
        ...Array.from(observedKeys).filter((k) => !declaredCols.includes(k)),
    ];

    const columns: ColumnBand[] = columnHeaders.map((header) => ({
        start: 0,
        end: 0,
        header,
        headerPath: [header],
        rightAligned: false,
    }));
    const tableRows: TableRow[] = rows.map((row, idx) => ({
        rowIndex: idx + 1,
        y: 0,
        cells: columnHeaders.map((h) => {
            const v = row[h];
            if (v === null || v === undefined) return null;
            return String(v);
        }),
        cellMeta: columnHeaders.map(() => null),
        isGroupHeader: false,
        isTotalRow: false,
        groupLabel: null,
    }));

    return {
        title,
        titleY: 0,
        startPage: 1,
        columns,
        tableRows,
        freeText: [],
        charts: [],
        spansToNextPage: false,
    };
}
