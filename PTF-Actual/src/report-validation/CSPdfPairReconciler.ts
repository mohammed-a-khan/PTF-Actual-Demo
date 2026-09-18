/**
 * PDF-vs-PDF pair reconciler (v1.53).
 *
 * Minimal, cell-level reconciliation between two structurally-similar PDFs
 * — a candidate against a reference. Operates on `AnalyzedReport` directly
 * rather than the full CanonicalReport pipeline — thinner, sufficient for
 * the "did these two PDFs render the same values?" question. Domain-agnostic:
 * works for any tabular PDF pair (report migrations, invoice-vs-invoice
 * regression, layout-swap validation, etc.).
 *
 * Zero-config mode (`Then the PDF at X matches the reference PDF at Y`)
 * discovers sections, composite key columns, aliases, and tolerances
 * automatically. Consumers who need explicit control author a rules JSON
 * (per RECONCILIATION-QUICKSTART.md) declaring sections + keyColumns +
 * per-column tolerance / aliases / known-differences.
 *
 * For the full spec-driven flow (with per-source fieldMap + database oracle
 * + coverage checksums + section validators), consumers stay on
 * `SimpleReportSpec + CSReportReconciler` (v1.51 surface, unchanged).
 *
 * @module report-validation/CSPdfPairReconciler
 */

import * as fs from 'fs';
import * as path from 'path';
import { CSReporter } from '../reporter/CSReporter';
import { extractPagesFromPdf } from './CSReportPdfExtractor';
import { analyzeReport } from './CSReportPdfLayoutAnalyzer';
import type { AnalyzedReport, AnalyzedSection, TableRow } from './CSReportPdfTypes';

export type ReconcileFindingKind =
    | 'CELL_MISMATCH'
    | 'CELL_MISSING_CANDIDATE'
    | 'CELL_MISSING_REFERENCE'
    | 'ROW_MISSING_CANDIDATE'
    | 'ROW_MISSING_REFERENCE'
    | 'SECTION_MISSING_CANDIDATE'
    | 'SECTION_MISSING_REFERENCE'
    | 'COLUMN_MISSING_CANDIDATE'
    | 'COLUMN_MISSING_REFERENCE'
    | 'KNOWN_DIFFERENCE_MATCHED';

export interface ReconcileFinding {
    kind: ReconcileFindingKind;
    section: string;
    column?: string;
    key?: string;
    candidateValue?: string;
    referenceValue?: string;
    delta?: number;
    tolerance?: number;
    reason?: string;
    knownDifferenceId?: string;
}

export interface ReconcileColumnRule {
    /** Extra names to match this canonical column against (case-insensitive). */
    aliases?: string[];
    /** Numeric tolerance for equality — absolute delta ≤ tolerance is treated as equal. */
    tolerance?: number;
    /** How to compare — default heuristic sniffs numeric-shaped strings as numbers. */
    kind?: 'string' | 'number' | 'date';
    /** True when the column is a row-identity key (see also section-level keyColumns). */
    isKey?: boolean;
}

export interface ReconcileSectionRule {
    /** Extra names to match this canonical section against (case-insensitive). */
    aliases?: string[];
    /** Ordered column names whose combined values uniquely identify a row in this section. */
    keyColumns: string[];
    /** Column-by-column config. Key is the canonical column name. */
    columns: Record<string, ReconcileColumnRule>;
    /** True to skip this section entirely (documentation only; use `ignoreSections` instead in practice). */
    skip?: boolean;
}

export interface KnownDifference {
    section: string;
    field: string;
    key: string;
    reason: string;
    /** Assigned an ID if missing; used to group findings in the report. */
    id?: string;
}

export interface GlobalTolerance {
    currency?: number;
    percentage?: number;
    count?: number;
    /** Default when a column kind='number' has no explicit tolerance. */
    number?: number;
}

export interface ReconcileRules {
    _meta?: {
        candidateSource?: string;
        referenceSource?: string;
        description?: string;
    };
    sections: Record<string, ReconcileSectionRule>;
    knownDifferences?: KnownDifference[];
    globalTolerance?: GlobalTolerance;
    ignoreSections?: string[];
    ignoreColumns?: string[];
    /** Fuzzy alias auto-detection — strict = 0.85, moderate = 0.70, loose = 0.55. Default 0.85. */
    aliasFuzzyThreshold?: number;
    /**
     * When true, apply relaxed matching intended for zero-config parity tests
     * (report migrations, layout swaps, formatting-only refactors):
     *   - Column names fall back to a 0.70 fuzzy threshold on second pass.
     *   - Row keys are compared after case/whitespace/punctuation normalization.
     *   - String cell values are compared after the same normalization.
     * Numeric-typed columns are unaffected (they use the number branch already).
     * Emitted automatically by `generateReconciliationRulesFromPair`; consumers
     * authoring rules by hand default to strict matching (autoMode=false).
     */
    autoMode?: boolean;
}

export interface ReconcileResult {
    passed: boolean;
    summary: {
        candidatePdf: string;
        referencePdf: string;
        sectionsCompared: number;
        columnsCompared: number;
        rowsCompared: number;
        cellsCompared: number;
        cellMismatches: number;
        rowMissing: number;
        sectionMissing: number;
        columnMissing: number;
        knownDifferencesMatched: number;
    };
    findings: ReconcileFinding[];
    /**
     * Per-cell comparison ledger — one entry for every row-key joined across
     * candidate/reference within a reconciled section, then one nested cell
     * entry per compared column. Reporters use this to render the full audit
     * table (candidate value | reference value | verdict) that the summary +
     * findings arrays alone can't reconstruct.
     */
    ledger: ReconcileLedgerRow[];
    /** Sections/columns detected in reference but not resolvable on candidate — for `_unmatched` block. */
    unmatched: {
        sectionsInReferenceOnly: Array<{ name: string; nearestOnCandidate: string[] }>;
        sectionsInCandidateOnly: string[];
        columnsInReferenceOnly: Array<{ section: string; name: string; nearestOnCandidate: string[] }>;
    };
    warnings: string[];
}

export interface ReconcileLedgerRow {
    section: string;
    /** Raw joined key string (as used internally to hash rows). */
    rowKey: string;
    /**
     * Human-readable key pairs — one entry per section-declared keyColumn,
     * carrying the column name AND the value from either the candidate or
     * reference row (whichever is non-null; both agree when the row matched).
     * Reporters render these as `col1=v1 | col2=v2` for legibility.
     */
    keyPairs: Array<{ column: string; value: string }>;
    cells: ReconcileLedgerCell[];
}

export interface ReconcileLedgerCell {
    column: string;
    candidate: string | null;
    reference: string | null;
    outcome:
        | 'MATCH'
        | 'MISMATCH'
        | 'KNOWN_DIFFERENCE'
        | 'MISSING_CANDIDATE'
        | 'MISSING_REFERENCE'
        | 'IGNORED';
    delta?: number;
    tolerance?: number;
}

export interface ReconcilePdfPairOptions {
    candidatePdfPath: string;
    referencePdfPath: string;
    rulesPath?: string;
    rulesInline?: ReconcileRules;
}

/**
 * Auto-generate a minimal reconciliation `ReconcileRules` object from a PDF
 * pair — used by the zero-config BDD step (`Then the PDF at X matches the
 * reference PDF at Y`). Framework detects sections + columns via the
 * analyzer, applies strict fuzzy matching, sensible tolerance defaults, and
 * skips sections with no reconcilable columns or keyColumns.
 *
 * No files written — returns the rules inline. The rules-JSON path is only
 * needed when consumers want to override tolerance / aliases / known-diffs.
 */
export async function generateReconciliationRulesFromPair(opts: {
    candidatePdfPath: string;
    referencePdfPath: string;
    fuzzyThreshold?: number;
    candidateAuthoritative?: boolean;
}): Promise<ReconcileRules> {
    if (!fs.existsSync(opts.candidatePdfPath)) throw new Error(`Candidate PDF not found: ${opts.candidatePdfPath}`);
    if (!fs.existsSync(opts.referencePdfPath)) throw new Error(`Reference PDF not found: ${opts.referencePdfPath}`);
    const threshold = opts.fuzzyThreshold ?? 0.85;
    const candidateAuthoritative = opts.candidateAuthoritative !== false;
    const [candPages, refPages] = await Promise.all([
        extractPagesFromPdf(opts.candidatePdfPath),
        extractPagesFromPdf(opts.referencePdfPath),
    ]);
    const candAnalyzed = analyzeReport(candPages);
    const refAnalyzed = analyzeReport(refPages);
    const candSections = mergeAnalyzedSections(candAnalyzed);
    const refSections = mergeAnalyzedSections(refAnalyzed);

    CSReporter.info(
        `[generateReconciliationRulesFromPair] candidate sections (${candSections.size}): ` +
        Array.from(candSections.keys()).map((s) => `"${s}"`).join(', '),
    );
    CSReporter.info(
        `[generateReconciliationRulesFromPair] reference sections (${refSections.size}): ` +
        Array.from(refSections.keys()).map((s) => `"${s}"`).join(', '),
    );
    const anonKey = /^\s*\(?anonymous\)?\s*$/i;
    const dumpAnon = (label: string, secs: Map<string, AnalyzedSection>) => {
        const anons: Array<{ title: string; rows: number; cols: string[] }> = [];
        for (const [t, s] of secs.entries()) {
            if (!anonKey.test(t)) continue;
            const cols = (s.columns ?? []).map((c) => (c.header ?? '').trim()).filter((h) => h.length > 0);
            anons.push({ title: t, rows: s.tableRows?.length ?? 0, cols });
        }
        if (anons.length > 0) {
            CSReporter.warn(
                `[generateReconciliationRulesFromPair] ${label} has ${anons.length} anonymous section(s) - ` +
                `likely a multi-page section whose title was printed as a running header and the analyzer did ` +
                `not merge the chunks. This silently drops sections from reconciliation. Details:`,
            );
            for (let i = 0; i < anons.length; i++) {
                const a = anons[i];
                CSReporter.warn(
                    `  ${label} anon #${i + 1}: rows=${a.rows}, columns=[${a.cols.map((c) => `"${c}"`).join(', ')}]`,
                );
            }
        }
    };
    dumpAnon('candidate', candSections);
    dumpAnon('reference', refSections);
    CSReporter.info(
        `[generateReconciliationRulesFromPair] candidateAuthoritative=${candidateAuthoritative} (walk ` +
        `${candidateAuthoritative ? 'CANDIDATE' : 'REFERENCE'} sections, match against the other side)`,
    );

    const sections: Record<string, ReconcileSectionRule> = {};
    const [drivingSections, otherSections] = candidateAuthoritative
        ? [candSections, refSections]
        : [refSections, candSections];

    for (const [drivingTitle, drivingSec] of drivingSections.entries()) {
        const nearest = Array.from(otherSections.keys())
            .map((c) => ({ c, s: similarityRatio(drivingTitle.toLowerCase(), c.toLowerCase()) }))
            .sort((a, b) => b.s - a.s);
        const bestMatch = nearest[0];
        if (!bestMatch || bestMatch.s < threshold) {
            CSReporter.debug(
                `[generateReconciliationRulesFromPair] no ${candidateAuthoritative ? 'reference' : 'candidate'} ` +
                `match for section "${drivingTitle}" (best "${bestMatch?.c ?? 'n/a'}" at ${bestMatch?.s.toFixed(2) ?? 'n/a'} < ${threshold})`,
            );
            continue;
        }
        const otherSec = otherSections.get(bestMatch.c);
        if (!otherSec) continue;

        const candSec = candidateAuthoritative ? drivingSec : otherSec;
        const refSec = candidateAuthoritative ? otherSec : drivingSec;
        const candTitle = candidateAuthoritative ? drivingTitle : bestMatch.c;
        const refTitle = candidateAuthoritative ? bestMatch.c : drivingTitle;

        const refCols = refSec.columns.map((c) => (c.header ?? '').trim()).filter((h) => h.length > 0);
        const candCols = candSec.columns.map((c) => (c.header ?? '').trim()).filter((h) => h.length > 0);
        if (refCols.length === 0 && candCols.length === 0) continue;

        // Column-header fallback: when the driving side has NO detected column
        // headers (typical of continuation-heavy SSRS renders that only print
        // the header row on page 1 and lose it during merge), fall back to the
        // other side's headers so the section still enters rules. Row-level
        // reconciliation then reads cells positionally, matching what the eye
        // sees on the page even without a header string on one side.
        const drivingHasCols = candidateAuthoritative ? candCols.length > 0 : refCols.length > 0;
        const otherHasCols = candidateAuthoritative ? refCols.length > 0 : candCols.length > 0;

        const keyDrivingSec = drivingHasCols
            ? (candidateAuthoritative ? candSec : refSec)
            : (candidateAuthoritative ? refSec : candSec);
        const keyDrivingCols = drivingHasCols
            ? (candidateAuthoritative ? candCols : refCols)
            : (candidateAuthoritative ? refCols : candCols);
        if (keyDrivingCols.length === 0) continue;
        const keyColIndices = pickKeyColumnIndices(keyDrivingSec, keyDrivingCols);
        if (keyColIndices.length === 0) continue;
        const keyColumns = keyColIndices.map((i) => keyDrivingCols[i]);

        const columns: Record<string, ReconcileColumnRule> = {};
        const colDriving = drivingHasCols
            ? (candidateAuthoritative ? candCols : refCols)
            : (candidateAuthoritative ? refCols : candCols);
        const colOther = drivingHasCols && otherHasCols
            ? (candidateAuthoritative ? refCols : candCols)
            : colDriving;
        const kindSec = drivingHasCols
            ? (candidateAuthoritative ? candSec : refSec)
            : (candidateAuthoritative ? refSec : candSec);
        for (const drivingCol of colDriving) {
            if (drivingHasCols && otherHasCols) {
                const nearestCol = colOther
                    .map((c) => ({ c, s: similarityRatio(drivingCol.toLowerCase(), c.toLowerCase()) }))
                    .sort((a, b) => b.s - a.s)[0];
                if (nearestCol && nearestCol.s >= threshold) {
                    const rule: ReconcileColumnRule = {};
                    if (nearestCol.c !== drivingCol) rule.aliases = [nearestCol.c];
                    const kind = sniffColumnKindLocal(kindSec, colDriving.indexOf(drivingCol));
                    if (kind) rule.kind = kind;
                    columns[drivingCol] = rule;
                }
            } else {
                // Only one side has headers — use it authoritatively and hope
                // positional column alignment on the other side matches.
                const rule: ReconcileColumnRule = {};
                const kind = sniffColumnKindLocal(kindSec, colDriving.indexOf(drivingCol));
                if (kind) rule.kind = kind;
                columns[drivingCol] = rule;
            }
        }
        if (Object.keys(columns).length === 0) continue;

        const canonicalTitle = candidateAuthoritative ? candTitle : refTitle;
        const rule: ReconcileSectionRule = { keyColumns, columns };
        const aliasTitle = candidateAuthoritative ? refTitle : candTitle;
        if (aliasTitle && aliasTitle !== canonicalTitle) rule.aliases = [aliasTitle];
        const candRows = candSec.tableRows?.length ?? 0;
        const refRows = refSec.tableRows?.length ?? 0;
        if (candRows === 0 || refRows === 0) {
            rule.skip = true;
            CSReporter.warn(
                `[generateReconciliationRulesFromPair] "${canonicalTitle}" — one side has 0 rows (candidate=${candRows}, reference=${refRows}); marking rule as skip=true`,
            );
        }
        sections[canonicalTitle] = rule;
    }

    CSReporter.info(
        `[generateReconciliationRulesFromPair] generated ${Object.keys(sections).length} section rule(s): ` +
        Object.keys(sections).map((s) => `"${s}"`).join(', '),
    );

    return {
        _meta: {
            candidateSource: `pdf:${opts.candidatePdfPath}`,
            referenceSource: `pdf:${opts.referencePdfPath}`,
            description: `Auto-generated rules (zero-config, fuzzy threshold ${threshold}, candidateAuthoritative=${candidateAuthoritative}).`,
        },
        sections,
        globalTolerance: { currency: 0.01, percentage: 0.001, count: 0, number: 0.01 },
        aliasFuzzyThreshold: threshold,
        autoMode: true,
    };
}

/**
 * Composite-key builder — returns 1..N column indices whose combined values
 * are unique across the section's rows. Starts from the best single-column
 * scorer (`pickKeyColumnIndex`) and greedily appends the column that most
 * improves the joint uniqueness ratio, stopping when the composite key hits
 * 100% uniqueness or when adding another column would not improve it.
 *
 * Composite keys are essential for tables where the same identifier appears
 * multiple times (same loan at multiple tranches / dates / par amounts) —
 * a single-column key would collide and drop rows silently.
 */
/**
 * Public wrapper used by the PDF-vs-DB auto path — returns key-column NAMES
 * (not indices) for a section restricted to the given column subset, so a
 * caller can build a section rule without importing internal index math.
 */
export function pickKeyColumnIndicesForRule(sec: AnalyzedSection, allowedCols: string[]): string[] {
    // Full section-column list — indices from the picker index INTO this list,
    // matching sec.tableRows[i].cells[<index>]. We then filter the picker's
    // chosen columns down to those the caller declared allowed.
    const secCols = sec.columns.map((c) => (c.header ?? '').trim());
    if (secCols.length === 0) return allowedCols.slice(0, 1);
    const allowedSet = new Set(allowedCols);
    const indices = pickKeyColumnIndices(sec, secCols);
    const filtered = indices.map((i) => secCols[i]).filter((name) => allowedSet.has(name));
    // Fallback: if nothing intersected, take the first allowed column so the
    // reconciler still has a key to join on.
    return filtered.length > 0 ? filtered : allowedCols.slice(0, 1);
}

function pickKeyColumnIndices(sec: AnalyzedSection, cols: string[]): number[] {
    if (sec.tableRows.length === 0 || cols.length === 0) return [];

    const primary = pickKeyColumnIndex(sec, cols);
    if (primary < 0) return [];
    const chosen = [primary];

    // Seed uniqueness with the primary column's own uniqueness.
    let bestKeys = keySetFor(sec, chosen);
    // Cap composite size at 3 columns — beyond that the key becomes noisy
    // to read and further gains are almost always negligible.
    while (bestKeys.size < sec.tableRows.length && chosen.length < 3) {
        let bestIdx = -1;
        let bestUniqueness = bestKeys.size;
        for (let i = 0; i < cols.length; i++) {
            if (chosen.includes(i)) continue;
            // Skip columns whose sole value never varies — adding them
            // can't improve uniqueness.
            const combined = keySetFor(sec, [...chosen, i]);
            if (combined.size > bestUniqueness) {
                bestUniqueness = combined.size;
                bestIdx = i;
            }
        }
        if (bestIdx < 0 || bestUniqueness === bestKeys.size) break;
        chosen.push(bestIdx);
        bestKeys = keySetFor(sec, chosen);
    }
    return chosen;
}

/** Distinct row-key values produced by joining the given column indices. */
function keySetFor(sec: AnalyzedSection, indices: number[]): Set<string> {
    const out = new Set<string>();
    for (const row of sec.tableRows) {
        const parts = indices.map((i) => {
            const v = row.cells[i];
            return v === null || v === undefined ? '' : String(v).trim();
        });
        const key = parts.join('|');
        if (parts.every((p) => !p)) continue; // skip totally-empty
        out.add(key);
    }
    return out;
}

function pickKeyColumnIndex(
    sec: AnalyzedSection,
    cols: string[],
): number {
    // Score every column on statistical properties of ITS OWN data — no
    // pattern-matching, no header-word bonuses, no domain assumptions. A good
    // row-identity column is:
    //   - highly unique (each row has a distinct value)
    //   - filled reliably across rows (few blanks)
    //   - uniform in value length (IDs are fixed-width; names/addresses are not)
    //
    // Weights sum to 1; small gentle nudges break ties without steering.
    if (sec.tableRows.length === 0 || cols.length === 0) return -1;

    let bestIdx = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < cols.length; i++) {
        const uniques = new Set<string>();
        const lengths: number[] = [];
        for (const row of sec.tableRows) {
            const v = row.cells[i];
            if (v === null || v === undefined) continue;
            const s = String(v).trim();
            if (!s) continue;
            uniques.add(s);
            lengths.push(s.length);
        }
        const nonEmpty = lengths.length;
        if (nonEmpty === 0) continue;

        const uniqueRatio = uniques.size / nonEmpty;
        const coverage = nonEmpty / sec.tableRows.length;

        // Length stability = 1 - CV (coefficient of variation), clamped to [0,1].
        // Uniform lengths (all IDs 8 chars) → stability ≈ 1.
        // Wildly varying lengths (facility names 20..80 chars) → stability < 0.5.
        const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
        let stability = 1;
        if (mean > 0) {
            const variance =
                lengths.reduce((acc, l) => acc + (l - mean) * (l - mean), 0) / lengths.length;
            const cv = Math.sqrt(variance) / mean;
            stability = Math.max(0, 1 - Math.min(cv, 1));
        }

        // Length-carrying-capacity — proxy for entropy per row. A 1-char page
        // number carries much less identity information than a 30-char section
        // name; both may be "unique" but the shorter column is a fragile key
        // that collides on trivial reordering. Cap at mean-length 6.
        const lengthCapacity = Math.min(mean / 6, 1);

        // Weighted composite. Uniqueness leads; length capacity and stability
        // arbitrate ties. Coverage matters less because valid keys can still
        // be blank on summary/total rows.
        let score =
            uniqueRatio * 0.5 +
            lengthCapacity * 0.2 +
            stability * 0.15 +
            coverage * 0.15;

        // Gentle nudges — smaller than any real signal, only decide ties:
        //   1. Leftmost columns first (report authors typically put keys first).
        //   2. Non-numeric strings preferred over numeric strings only when
        //      uniqueness/coverage/stability tie — because pure-number columns
        //      like amounts can look identity-shaped by coincidence.
        score -= i * 0.001;
        const kind = sniffColumnKindLocal(sec, i);
        if (kind !== 'number') score += 0.002;

        if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
        }
    }
    return bestIdx >= 0 ? bestIdx : 0;
}

function sniffColumnKindLocal(sec: AnalyzedSection, colIdx: number): 'number' | 'date' | 'string' | undefined {
    if (colIdx < 0) return undefined;
    for (const row of sec.tableRows.slice(0, 10)) {
        const v = row.cells[colIdx];
        if (v === null || v === undefined || String(v).trim() === '') continue;
        const s = String(v).trim();
        if (isNumericLike(s)) return 'number';
        if (isDateLike(s)) return 'date';
        return 'string';
    }
    return undefined;
}

/**
 * Locale-agnostic numeric detection. Accepts:
 *   - Common currency symbols anywhere in the string:
 *     $ € £ ¥ ₹ ₩ ¢ ₽ ₺ ₪ ₨ ৳ ﷼ R$ kr Fr Rp
 *   - ISO codes as prefix or suffix: USD, EUR, GBP, JPY, INR, CAD, AUD, CHF, CNY, HKD, SGD, MXN, BRL, ZAR
 *   - Percent sign as suffix (5.0% counts as numeric)
 *   - Both decimal styles: US "1,234.56" and European "1.234,56"; also plain "1234.56"
 *   - Whitespace as thousands separator (French style: "1 234,56")
 *   - Negatives via leading `-` OR wrapping parentheses (accounting)
 *   - Optional scientific notation (1.5e6, -3.14E-2)
 *
 * Consumers whose values use a format this doesn't recognize can declare
 * `"kind": "number"` explicitly in the rules JSON to force numeric parsing.
 */
function isNumericLike(s: string): boolean {
    // Strip currency symbols, ISO codes, percent sign, whitespace, parentheses.
    // What remains must be a syntactically-valid number (US or EU style).
    let stripped = s
        .replace(/[$€£¥₹₩¢₽₺₪₨৳﷼]/g, '')
        .replace(/\b(USD|EUR|GBP|JPY|INR|CAD|AUD|CHF|CNY|HKD|SGD|MXN|BRL|ZAR|R\$|Rp|kr|Fr)\b/gi, '')
        .replace(/%/g, '')
        .replace(/\s/g, '')
        .trim();
    // Wrap-in-parens negative → convert to leading minus
    if (/^\(.+\)$/.test(stripped)) stripped = '-' + stripped.slice(1, -1);
    // US: digits with commas as thousand separator, dot as decimal
    if (/^-?\d{1,3}(,\d{3})*(\.\d+)?([eE][-+]?\d+)?$/.test(stripped)) return true;
    // EU: digits with dots as thousand separator, comma as decimal
    if (/^-?\d{1,3}(\.\d{3})*(,\d+)?([eE][-+]?\d+)?$/.test(stripped)) return true;
    // Plain integer or decimal — no thousand separator ambiguity
    if (/^-?\d+([.,]\d+)?([eE][-+]?\d+)?$/.test(stripped)) return true;
    return false;
}

/**
 * Locale-agnostic date detection. Accepts:
 *   - ISO 8601: 2025-01-02, 2025-01-02T14:30:00Z, 2025/01/02
 *   - US/EU numeric: 01/02/2025, 1-2-25, 01.02.2025
 *   - Month-name forms: 2 Jan 2025, Jan 2 2025, 2-Jan-2025, 02-January-2025
 *
 * Doesn't guess US-vs-EU day/month order — the reconciler only needs the
 * "is this a date-ish string" verdict for kind inference. Actual comparison
 * of date values stays string-based unless the consumer opts into `kind: "number"`
 * with a normalized numeric representation.
 */
function isDateLike(s: string): boolean {
    // ISO 8601 date (optionally with time / zone)
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return true;
    // Numeric d/m/y or m/d/y or d.m.y
    if (/^\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}$/.test(s)) return true;
    // Text month: "2 Jan 2025", "Jan 2 2025", "2-Jan-2025"
    if (/^\d{1,2}[\s\-]?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s\-]?\d{2,4}$/i.test(s)) return true;
    if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{2,4}$/i.test(s)) return true;
    return false;
}

/**
 * Top-level entry — reconcile two PDFs against a rules JSON. The rules can
 * be supplied inline (for programmatic use) or via `rulesPath` (for BDD).
 */
export async function reconcilePdfsFromRules(opts: ReconcilePdfPairOptions): Promise<ReconcileResult> {
    if (!fs.existsSync(opts.candidatePdfPath)) throw new Error(`Candidate PDF not found: ${opts.candidatePdfPath}`);
    if (!fs.existsSync(opts.referencePdfPath)) throw new Error(`Reference PDF not found: ${opts.referencePdfPath}`);
    let rules: ReconcileRules;
    if (opts.rulesInline) {
        rules = opts.rulesInline;
    } else if (opts.rulesPath) {
        if (!fs.existsSync(opts.rulesPath)) throw new Error(`Rules JSON not found: ${opts.rulesPath}`);
        rules = JSON.parse(fs.readFileSync(opts.rulesPath, 'utf-8')) as ReconcileRules;
    } else {
        throw new Error('Provide either rulesPath or rulesInline');
    }
    validateRulesShape(rules);

    const [candPages, refPages] = await Promise.all([
        extractPagesFromPdf(opts.candidatePdfPath),
        extractPagesFromPdf(opts.referencePdfPath),
    ]);
    const candAnalyzed = analyzeReport(candPages);
    const refAnalyzed = analyzeReport(refPages);

    return reconcileAnalyzedReports({
        candidatePdf: opts.candidatePdfPath,
        referencePdf: opts.referencePdfPath,
        candidateAnalyzed: candAnalyzed,
        referenceAnalyzed: refAnalyzed,
        rules,
    });
}

// ---------------------------------------------------------------------------
// Core reconciliation (pure — no I/O)
// ---------------------------------------------------------------------------

interface ReconcileInternalOpts {
    candidatePdf: string;
    referencePdf: string;
    candidateAnalyzed: AnalyzedReport;
    referenceAnalyzed: AnalyzedReport;
    rules: ReconcileRules;
}

export function reconcileAnalyzedReports(opts: ReconcileInternalOpts): ReconcileResult {
    const findings: ReconcileFinding[] = [];
    const warnings: string[] = [];
    const ledger: ReconcileLedgerRow[] = [];
    const threshold = opts.rules.aliasFuzzyThreshold ?? 0.85;

    // Flatten sections across pages on each side. AnalyzedSection is per-page;
    // we merge by title equality (identical titles across pages = one logical section).
    const candSections = mergeAnalyzedSections(opts.candidateAnalyzed);
    const refSections = mergeAnalyzedSections(opts.referenceAnalyzed);
    const ignoreSections = new Set((opts.rules.ignoreSections ?? []).map((s) => s.toLowerCase()));
    const ignoreColumns = new Set((opts.rules.ignoreColumns ?? []).map((s) => s.toLowerCase()));

    // Section resolution: rule name (canonical) → { candTitle?, refTitle? }
    // First, exact matches. Then aliases. Then fuzzy on unmatched.
    const sectionResolution = resolveSections(
        Object.keys(opts.rules.sections),
        opts.rules.sections,
        Array.from(candSections.keys()),
        Array.from(refSections.keys()),
        threshold,
    );

    let sectionsCompared = 0;
    let columnsCompared = 0;
    let rowsCompared = 0;
    let cellsCompared = 0;

    // Build knownDifferences index for O(1) lookups.
    const kdMap = indexKnownDifferences(opts.rules.knownDifferences ?? []);
    let knownDifferencesMatched = 0;

    for (const [canonicalSectionName, sectionRule] of Object.entries(opts.rules.sections)) {
        if (sectionRule.skip) continue;
        if (ignoreSections.has(canonicalSectionName.toLowerCase())) continue;

        const res = sectionResolution.get(canonicalSectionName);
        const candTitle = res?.candTitle;
        const refTitle = res?.refTitle;
        if (!candTitle && !refTitle) {
            warnings.push(`Section "${canonicalSectionName}" not found on either side — skipping.`);
            continue;
        }
        if (!candTitle) {
            findings.push({
                kind: 'SECTION_MISSING_CANDIDATE',
                section: canonicalSectionName,
                reason: `Section present on reference (as "${refTitle}") but no match on candidate`,
            });
            continue;
        }
        if (!refTitle) {
            findings.push({
                kind: 'SECTION_MISSING_REFERENCE',
                section: canonicalSectionName,
                reason: `Section present on candidate (as "${candTitle}") but no match on reference`,
            });
            continue;
        }
        const candSec = candSections.get(candTitle);
        const refSecForSize = refSections.get(refTitle);
        // Auto-mode subset detection: when candidate and reference row-counts
        // for the same section differ by more than 2× (min/max < 0.5), the
        // two PDFs are not the same view of the same data — one side is a
        // subset (partial replacement, sampling report, or "top-N" view).
        // Row-level parity is meaningless on such a pair; skip with a warning
        // instead of drowning the caller in ROW_MISSING findings. Hand-authored
        // rules (autoMode=false) always reconcile — the consumer opted in.
        if (opts.rules.autoMode && candSec && refSecForSize) {
            const candN = candSec.tableRows?.length ?? 0;
            const refN = refSecForSize.tableRows?.length ?? 0;
            if (candN === 0 || refN === 0) {
                warnings.push(
                    `Section "${canonicalSectionName}" — one side has 0 rows (candidate=${candN}, reference=${refN}); treating as info-only, no findings emitted`,
                );
                continue;
            }
            const maxN = Math.max(candN, refN);
            if (maxN > 0) {
                const ratio = Math.min(candN, refN) / maxN;
                if (ratio < 0.5) {
                    const structuralAsymmetry = columnsAreCandidateSubsetOfReference(candSec, refSecForSize);
                    if (structuralAsymmetry) {
                        warnings.push(
                            `Section "${canonicalSectionName}" retained despite row-count asymmetry (candN=${candN}, refN=${refN}, ratio=${ratio.toFixed(2)}). ` +
                            `Candidate columns are a proper subset of reference columns — likely a section-splitting asymmetry, not a genuine subset view. ` +
                            `Reconciling on the ${countSharedColumnNames(candSec, refSecForSize)} shared columns only.`,
                        );
                    } else {
                        warnings.push(
                            `Section "${canonicalSectionName}" skipped — candidate has ${candN} rows, ` +
                            `reference has ${refN} (ratio ${ratio.toFixed(2)}). One side appears to be ` +
                            `a subset view; row-level parity is not meaningful. Author rules JSON to ` +
                            `override and force a comparison.`,
                        );
                        continue;
                    }
                }
            }
        }
        sectionsCompared++;

        const refSec = refSections.get(refTitle);
        if (!candSec || !refSec) continue;

        const candCols = candSec.columns.map((c) => (c.header ?? '').trim()).filter((h) => h.length > 0);
        const refCols = refSec.columns.map((c) => (c.header ?? '').trim()).filter((h) => h.length > 0);
        const columnResolution = resolveColumns(sectionRule.columns, candCols, refCols, threshold, opts.rules.autoMode);

        // Row keying — combine keyColumn values from each row (positional index into columns)
        const keyColCanonical = sectionRule.keyColumns;
        const candKeyIndices = keyColCanonical.map((k) => {
            const r = columnResolution.get(k);
            return r?.candTitle ? indexOfHeader(candSec, r.candTitle) : -1;
        });
        const refKeyIndices = keyColCanonical.map((k) => {
            const r = columnResolution.get(k);
            return r?.refTitle ? indexOfHeader(refSec, r.refTitle) : -1;
        });
        const candByKey = groupRowsByKey(candSec.tableRows, candKeyIndices, opts.rules.autoMode);
        const refByKey = groupRowsByKey(refSec.tableRows, refKeyIndices, opts.rules.autoMode);
        const allRowKeys = new Set<string>([...candByKey.keys(), ...refByKey.keys()]);

        for (const rowKey of allRowKeys) {
            rowsCompared++;
            const candRow = candByKey.get(rowKey);
            const refRow = refByKey.get(rowKey);
            if (candRow && !refRow) {
                findings.push({
                    kind: 'ROW_MISSING_REFERENCE',
                    section: canonicalSectionName,
                    key: rowKey,
                    reason: `Row present on candidate but not on reference`,
                });
                // Record every candidate cell in the ledger with outcome MISSING_REFERENCE
                // so the audit report shows what the candidate said even though the
                // reference had nothing to compare against.
                const cells: ReconcileLedgerCell[] = [];
                for (const [canonicalCol] of Object.entries(sectionRule.columns)) {
                    if (ignoreColumns.has(canonicalCol.toLowerCase())) continue;
                    const colRes = columnResolution.get(canonicalCol);
                    if (!colRes?.candTitle) continue;
                    const candIdx = indexOfHeader(candSec, colRes.candTitle);
                    cells.push({
                        column: canonicalCol,
                        candidate: valueAt(candRow, candIdx),
                        reference: null,
                        outcome: 'MISSING_REFERENCE',
                    });
                }
                if (cells.length) ledger.push({ section: canonicalSectionName, rowKey, keyPairs: buildKeyPairs(sectionRule.keyColumns, columnResolution, candSec, refSec, candRow, refRow), cells });
                continue;
            }
            if (refRow && !candRow) {
                findings.push({
                    kind: 'ROW_MISSING_CANDIDATE',
                    section: canonicalSectionName,
                    key: rowKey,
                    reason: `Row present on reference but not on candidate`,
                });
                const cells: ReconcileLedgerCell[] = [];
                for (const [canonicalCol] of Object.entries(sectionRule.columns)) {
                    if (ignoreColumns.has(canonicalCol.toLowerCase())) continue;
                    const colRes = columnResolution.get(canonicalCol);
                    if (!colRes?.refTitle) continue;
                    const refIdx = indexOfHeader(refSec, colRes.refTitle);
                    cells.push({
                        column: canonicalCol,
                        candidate: null,
                        reference: valueAt(refRow, refIdx),
                        outcome: 'MISSING_CANDIDATE',
                    });
                }
                if (cells.length) ledger.push({ section: canonicalSectionName, rowKey, keyPairs: buildKeyPairs(sectionRule.keyColumns, columnResolution, candSec, refSec, candRow, refRow), cells });
                continue;
            }
            if (!candRow || !refRow) continue;

            const ledgerCells: ReconcileLedgerCell[] = [];

            // Compare each mapped column
            for (const [canonicalCol, colRule] of Object.entries(sectionRule.columns)) {
                if (ignoreColumns.has(canonicalCol.toLowerCase())) {
                    // Still record the values with outcome IGNORED so the ledger shows
                    // WHY a column isn't scored.
                    const colRes = columnResolution.get(canonicalCol);
                    const candIdx = colRes?.candTitle ? indexOfHeader(candSec, colRes.candTitle) : -1;
                    const refIdx = colRes?.refTitle ? indexOfHeader(refSec, colRes.refTitle) : -1;
                    ledgerCells.push({
                        column: canonicalCol,
                        candidate: candIdx >= 0 ? valueAt(candRow, candIdx) : null,
                        reference: refIdx >= 0 ? valueAt(refRow, refIdx) : null,
                        outcome: 'IGNORED',
                    });
                    continue;
                }
                const colRes = columnResolution.get(canonicalCol);
                if (!colRes?.candTitle || !colRes?.refTitle) {
                    // Coverage handled below — skip here for now
                    continue;
                }
                columnsCompared++;
                const candIdx = indexOfHeader(candSec, colRes.candTitle);
                const refIdx = indexOfHeader(refSec, colRes.refTitle);
                const candVal = valueAt(candRow, candIdx);
                const refVal = valueAt(refRow, refIdx);
                cellsCompared++;

                // Check known-differences allowlist
                const kd = kdMap.get(kdKey(canonicalSectionName, canonicalCol, rowKey));
                if (kd) {
                    knownDifferencesMatched++;
                    findings.push({
                        kind: 'KNOWN_DIFFERENCE_MATCHED',
                        section: canonicalSectionName,
                        column: canonicalCol,
                        key: rowKey,
                        candidateValue: candVal ?? undefined,
                        referenceValue: refVal ?? undefined,
                        reason: kd.reason,
                        knownDifferenceId: kd.id ?? `${kd.section}:${kd.key}:${kd.field}`,
                    });
                    ledgerCells.push({
                        column: canonicalCol,
                        candidate: candVal,
                        reference: refVal,
                        outcome: 'KNOWN_DIFFERENCE',
                    });
                    continue;
                }

                if (candVal === null || candVal === undefined) {
                    findings.push({
                        kind: 'CELL_MISSING_CANDIDATE',
                        section: canonicalSectionName,
                        column: canonicalCol,
                        key: rowKey,
                        referenceValue: refVal ?? undefined,
                    });
                    ledgerCells.push({
                        column: canonicalCol,
                        candidate: null,
                        reference: refVal,
                        outcome: 'MISSING_CANDIDATE',
                    });
                    continue;
                }
                if (refVal === null || refVal === undefined) {
                    findings.push({
                        kind: 'CELL_MISSING_REFERENCE',
                        section: canonicalSectionName,
                        column: canonicalCol,
                        key: rowKey,
                        candidateValue: candVal,
                    });
                    ledgerCells.push({
                        column: canonicalCol,
                        candidate: candVal,
                        reference: null,
                        outcome: 'MISSING_REFERENCE',
                    });
                    continue;
                }

                const tolerance = resolveTolerance(colRule, opts.rules.globalTolerance);
                const comparison = compareValues(candVal, refVal, colRule.kind, tolerance, opts.rules.autoMode);
                if (!comparison.equal) {
                    findings.push({
                        kind: 'CELL_MISMATCH',
                        section: canonicalSectionName,
                        column: canonicalCol,
                        key: rowKey,
                        candidateValue: candVal,
                        referenceValue: refVal,
                        delta: comparison.delta,
                        tolerance,
                    });
                    ledgerCells.push({
                        column: canonicalCol,
                        candidate: candVal,
                        reference: refVal,
                        outcome: 'MISMATCH',
                        delta: comparison.delta,
                        tolerance,
                    });
                } else {
                    ledgerCells.push({
                        column: canonicalCol,
                        candidate: candVal,
                        reference: refVal,
                        outcome: 'MATCH',
                        delta: comparison.delta,
                        tolerance,
                    });
                }
            }
            if (ledgerCells.length) ledger.push({ section: canonicalSectionName, rowKey, keyPairs: buildKeyPairs(sectionRule.keyColumns, columnResolution, candSec, refSec, candRow, refRow), cells: ledgerCells });
        }

        // Column-level coverage findings (columns declared but absent on one side)
        for (const [canonicalCol, colRule] of Object.entries(sectionRule.columns)) {
            const colRes = columnResolution.get(canonicalCol);
            if (!colRes?.candTitle) {
                findings.push({
                    kind: 'COLUMN_MISSING_CANDIDATE',
                    section: canonicalSectionName,
                    column: canonicalCol,
                    reason: `Column declared with aliases ${JSON.stringify(colRule.aliases ?? [])} not found on candidate`,
                });
            }
            if (!colRes?.refTitle) {
                findings.push({
                    kind: 'COLUMN_MISSING_REFERENCE',
                    section: canonicalSectionName,
                    column: canonicalCol,
                    reason: `Column declared with aliases ${JSON.stringify(colRule.aliases ?? [])} not found on reference`,
                });
            }
        }
    }

    // Unmatched block — everything in reference NOT resolved on candidate,
    // and vice versa (for auto-discover helpers to seed the JSON).
    const unmatched = computeUnmatched(candSections, refSections, sectionResolution, opts.rules.sections, threshold);

    const summary = {
        candidatePdf: opts.candidatePdf,
        referencePdf: opts.referencePdf,
        sectionsCompared,
        columnsCompared,
        rowsCompared,
        cellsCompared,
        cellMismatches: findings.filter((f) => f.kind === 'CELL_MISMATCH').length,
        rowMissing: findings.filter((f) => f.kind === 'ROW_MISSING_CANDIDATE' || f.kind === 'ROW_MISSING_REFERENCE').length,
        sectionMissing: findings.filter((f) => f.kind === 'SECTION_MISSING_CANDIDATE' || f.kind === 'SECTION_MISSING_REFERENCE').length,
        columnMissing: findings.filter((f) => f.kind === 'COLUMN_MISSING_CANDIDATE' || f.kind === 'COLUMN_MISSING_REFERENCE').length,
        knownDifferencesMatched,
    };
    // A run passes when there are no CELL_MISMATCH / ROW_MISSING / SECTION_MISSING / COLUMN_MISSING findings
    // AND at least one section was actually reconciled. Zero-comparison runs used to trivially pass because
    // every mismatch counter was zero by default; that hides the real failure mode where rule generation or
    // section resolution matched nothing between the two PDFs. Passing on "we compared nothing" is a false
    // positive and masks real diffs (see Market Value Detail multi-page continuation case).
    // KNOWN_DIFFERENCE_MATCHED is recorded but not gating.
    const noMismatches = summary.cellMismatches === 0 && summary.rowMissing === 0 && summary.sectionMissing === 0 && summary.columnMissing === 0;
    const somethingCompared = summary.sectionsCompared > 0 && summary.cellsCompared > 0;
    if (!somethingCompared) {
        const cand = unmatched?.sectionsInCandidateOnly ?? [];
        const ref = unmatched?.sectionsInReferenceOnly ?? [];
        warnings.push(
            `Nothing was reconciled: sectionsCompared=${summary.sectionsCompared}, cellsCompared=${summary.cellsCompared}. ` +
            `Rule generation or section resolution produced no matched section pair. ` +
            `Candidate-only sections (${cand.length}): ${cand.map((t) => `"${t}"`).join(', ') || 'none'}. ` +
            `Reference-only sections (${ref.length}): ${ref.map((r) => `"${r.name}"`).join(', ') || 'none'}. ` +
            `Report will FAIL because a zero-comparison run cannot be trusted as a pass.`,
        );
    }
    const passed = noMismatches && somethingCompared;

    return { passed, summary, findings, ledger, unmatched, warnings };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function validateRulesShape(rules: ReconcileRules): void {
    if (!rules || typeof rules !== 'object') throw new Error('Rules JSON must be an object');
    if (!rules.sections || typeof rules.sections !== 'object') {
        throw new Error('Rules JSON must declare a top-level `sections` object');
    }
    for (const [name, sec] of Object.entries(rules.sections)) {
        if (!sec || typeof sec !== 'object') throw new Error(`sections["${name}"] must be an object`);
        if (!Array.isArray(sec.keyColumns) || sec.keyColumns.length === 0) {
            throw new Error(`sections["${name}"].keyColumns must be a non-empty array`);
        }
        if (!sec.columns || typeof sec.columns !== 'object') {
            throw new Error(`sections["${name}"].columns must be an object`);
        }
    }
}

/**
 * Merge per-page section repetitions of the same title into one logical section.
 * (AnalyzedReport represents sections per-page; a section that spans pages appears
 * multiple times with the same title.)
 */
function mergeAnalyzedSections(analyzed: AnalyzedReport): Map<string, AnalyzedSection> {
    const buckets = new Map<string, AnalyzedSection[]>();
    const analyzerMerged = (analyzed as unknown as { mergedSections?: AnalyzedSection[] }).mergedSections;
    if (Array.isArray(analyzerMerged) && analyzerMerged.length > 0) {
        for (const sec of analyzerMerged) {
            const title = (sec.title ?? '').trim();
            if (!title) continue;
            const arr = buckets.get(title) ?? [];
            arr.push(sec);
            buckets.set(title, arr);
        }
    } else {
        for (const page of analyzed.pages) {
            for (const sec of page.sections) {
                const title = (sec.title ?? '').trim();
                if (!title) continue;
                const arr = buckets.get(title) ?? [];
                arr.push(sec);
                buckets.set(title, arr);
            }
        }
    }
    const merged = new Map<string, AnalyzedSection>();
    for (const [title, sections] of buckets) {
        const chosen = pickAccumulatorByEvidence(sections);
        const accumulator: AnalyzedSection = {
            ...chosen,
            tableRows: [...(chosen.tableRows ?? [])],
            columns: [...(chosen.columns ?? [])],
        };
        if (sections.length > 1) {
            const alts = sections.filter((s) => s !== chosen);
            const altSummary = alts
                .map((s) => `${(s.tableRows?.length ?? 0)}r/${(s.columns?.length ?? 0)}c`)
                .join(', ');
            CSReporter.warn(
                `[mergeAnalyzedSections] "${title}" — chose ${(chosen.tableRows?.length ?? 0)}-row/${(chosen.columns?.length ?? 0)}-col accumulator over alternatives: ${altSummary}`,
            );
        }
        for (const sec of sections) {
            if (sec === chosen) continue;
            appendRowsWithRealign(accumulator, sec, title);
        }
        merged.set(title, accumulator);
    }
    return merged;
}

function pickAccumulatorByEvidence(sections: AnalyzedSection[]): AnalyzedSection {
    if (sections.length === 1) return sections[0];
    const scored = sections.map((s) => {
        const rows = s.tableRows?.length ?? 0;
        const cols = s.columns ?? [];
        const filled = cols.filter((c) => (c?.header ?? '').trim().length > 0).length;
        const headerCompleteness = filled / Math.max(1, cols.length);
        return { s, score: rows * headerCompleteness, rows, colCount: cols.length };
    });
    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.rows !== a.rows) return b.rows - a.rows;
        return b.colCount - a.colCount;
    });
    return scored[0].s;
}

function appendRowsWithRealign(accumulator: AnalyzedSection, incoming: AnalyzedSection, title: string): void {
    const accCols = accumulator.columns ?? [];
    const inCols = incoming.columns ?? [];
    const sameShape =
        accCols.length === inCols.length &&
        accCols.every((c, i) => {
            const b = inCols[i];
            return b && Math.abs(c.start - b.start) <= 5 && Math.abs(c.end - b.end) <= 5;
        });
    if (sameShape) {
        for (const row of incoming.tableRows) {
            if (isReconcileRowJustHeaderText(row.cells ?? [], accCols)) {
                CSReporter.debug(`[mergeAnalyzedSections] dropped leftover header-shaped row in same-shape append for section "${title}"`);
                continue;
            }
            accumulator.tableRows.push(row);
        }
        return;
    }
    CSReporter.warn(
        `[mergeAnalyzedSections] realigning "${title}" incoming rows: accumulator has ${accCols.length} cols, incoming has ${inCols.length} cols`,
    );
    const realigned = realignRowsBetweenColumnLayouts(incoming, accumulator);
    accumulator.tableRows.push(...realigned);
}

function isReconcileRowJustHeaderText(cells: (string | null)[], cols: AnalyzedSection['columns']): boolean {
    if (!cells || !cols || cells.length === 0) return false;
    let nonEmpty = 0;
    let matches = 0;
    const n = Math.min(cells.length, cols.length);
    for (let i = 0; i < n; i++) {
        const v = cells[i];
        if (v == null || String(v).trim() === '') continue;
        nonEmpty++;
        const header = (cols[i]?.header ?? '').trim();
        if (!header) continue;
        if (normaliseHeaderTextReconcile(String(v)) === normaliseHeaderTextReconcile(header)) matches++;
    }
    if (nonEmpty < 2) return false;
    return matches / nonEmpty >= 0.6;
}

function normaliseHeaderTextReconcile(s: string): string {
    return String(s ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function columnsAreCandidateSubsetOfReference(candSec: AnalyzedSection, refSec: AnalyzedSection): boolean {
    const candNames = new Set(
        (candSec.columns ?? [])
            .map((c) => normaliseHeaderTextReconcile(c.header ?? ''))
            .filter((s) => s.length > 0),
    );
    const refNames = new Set(
        (refSec.columns ?? [])
            .map((c) => normaliseHeaderTextReconcile(c.header ?? ''))
            .filter((s) => s.length > 0),
    );
    if (candNames.size === 0 || refNames.size === 0) return false;
    if (candNames.size >= refNames.size) return false;
    for (const n of candNames) {
        if (!refNames.has(n)) return false;
    }
    return true;
}

function countSharedColumnNames(candSec: AnalyzedSection, refSec: AnalyzedSection): number {
    const candNames = new Set(
        (candSec.columns ?? [])
            .map((c) => normaliseHeaderTextReconcile(c.header ?? ''))
            .filter((s) => s.length > 0),
    );
    const refNames = new Set(
        (refSec.columns ?? [])
            .map((c) => normaliseHeaderTextReconcile(c.header ?? ''))
            .filter((s) => s.length > 0),
    );
    let shared = 0;
    for (const n of candNames) if (refNames.has(n)) shared++;
    return shared;
}

function realignRowsBetweenColumnLayouts(incoming: AnalyzedSection, accumulator: AnalyzedSection): TableRow[] {
    const accCols = accumulator.columns ?? [];
    const inCols = incoming.columns ?? [];
    if (accCols.length === 0 || inCols.length === 0) return incoming.tableRows ?? [];
    const looseTolerance = 40;
    const mapping: number[] = new Array(inCols.length).fill(-1);
    for (let i = 0; i < inCols.length; i++) {
        const inMid = (inCols[i].start + inCols[i].end) / 2;
        let bestJ = -1;
        let bestDist = Infinity;
        for (let j = 0; j < accCols.length; j++) {
            if (inMid >= accCols[j].start - looseTolerance && inMid <= accCols[j].end + looseTolerance) {
                const accMid = (accCols[j].start + accCols[j].end) / 2;
                const dist = Math.abs(inMid - accMid);
                if (dist < bestDist) { bestDist = dist; bestJ = j; }
            }
        }
        if (bestJ < 0) {
            const inHeader = (inCols[i].header ?? '').trim().toLowerCase();
            if (inHeader) {
                for (let j = 0; j < accCols.length; j++) {
                    const accHeader = (accCols[j].header ?? '').trim().toLowerCase();
                    if (accHeader && accHeader === inHeader) { bestJ = j; break; }
                }
            }
        }
        mapping[i] = bestJ;
    }
    const out: TableRow[] = [];
    for (const row of incoming.tableRows ?? []) {
        const cells: (string | null)[] = new Array(accCols.length).fill(null);
        const cellMeta: (import('./CSReportPdfTypes').CellMeta | null)[] = new Array(accCols.length).fill(null);
        const srcCells = row.cells ?? [];
        const srcMeta = row.cellMeta ?? [];
        for (let i = 0; i < srcCells.length; i++) {
            const dst = mapping[i];
            if (dst < 0) continue;
            const val = srcCells[i];
            if (val == null || String(val).trim() === '') continue;
            if (cells[dst] == null || String(cells[dst]).trim() === '') {
                cells[dst] = val;
                cellMeta[dst] = srcMeta[i] ?? null;
            } else {
                cells[dst] = `${cells[dst]} ${val}`;
            }
        }
        if (isReconcileRowJustHeaderText(cells, accCols)) {
            CSReporter.debug(`[mergeAnalyzedSections] dropped leftover header-shaped row in realign for section "${accumulator.title}"`);
            continue;
        }
        out.push({
            rowIndex: row.rowIndex,
            y: row.y,
            cells,
            cellMeta,
            isGroupHeader: row.isGroupHeader,
            isTotalRow: row.isTotalRow,
            groupLabel: row.groupLabel,
        });
    }
    return out;
}

function resolveSections(
    canonicalNames: string[],
    sectionRules: Record<string, ReconcileSectionRule>,
    candTitles: string[],
    refTitles: string[],
    threshold: number,
): Map<string, { candTitle?: string; refTitle?: string }> {
    const out = new Map<string, { candTitle?: string; refTitle?: string }>();
    for (const canonical of canonicalNames) {
        const rule = sectionRules[canonical];
        const candidatesForMatch = [canonical, ...(rule.aliases ?? [])];
        const candMatch = findFirstMatch(candidatesForMatch, candTitles, threshold);
        const refMatch = findFirstMatch(candidatesForMatch, refTitles, threshold);
        out.set(canonical, { candTitle: candMatch, refTitle: refMatch });
    }
    return out;
}

function resolveColumns(
    columnRules: Record<string, ReconcileColumnRule>,
    candCols: string[],
    refCols: string[],
    threshold: number,
    autoMode?: boolean,
): Map<string, { candTitle?: string; refTitle?: string }> {
    const out = new Map<string, { candTitle?: string; refTitle?: string }>();
    for (const [canonical, rule] of Object.entries(columnRules)) {
        const candidatesForMatch = [canonical, ...(rule.aliases ?? [])];
        out.set(canonical, {
            candTitle: findFirstMatch(candidatesForMatch, candCols, threshold, autoMode),
            refTitle: findFirstMatch(candidatesForMatch, refCols, threshold, autoMode),
        });
    }
    return out;
}

function findFirstMatch(candidates: string[], pool: string[], threshold: number, autoMode?: boolean): string | undefined {
    const poolLower = pool.map((s) => ({ orig: s, lower: s.toLowerCase() }));
    // Exact case-insensitive first
    for (const c of candidates) {
        const lc = c.toLowerCase();
        const hit = poolLower.find((p) => p.lower === lc);
        if (hit) return hit.orig;
    }
    // Fuzzy at declared threshold
    let best: { score: number; orig: string } | null = null;
    for (const c of candidates) {
        for (const p of poolLower) {
            const s = similarityRatio(c.toLowerCase(), p.lower);
            if (s >= threshold && (!best || s > best.score)) best = { score: s, orig: p.orig };
        }
    }
    if (best) return best.orig;
    // Auto-mode fallback: try a relaxed 0.70 second pass. This absorbs column
    // renames like "Price Date" ↔ "Pricing Date" that a migration or refactor
    // typically produces without demanding hand-authored aliases.
    if (autoMode) {
        const relaxed = 0.7;
        if (relaxed < threshold) {
            for (const c of candidates) {
                for (const p of poolLower) {
                    const s = similarityRatio(c.toLowerCase(), p.lower);
                    if (s >= relaxed && (!best || s > best.score)) best = { score: s, orig: p.orig };
                }
            }
            return best?.orig;
        }
    }
    return undefined;
}

/**
 * Normalise a section/column title for fuzzy comparison. Strips parenthesised
 * qualifiers so renderer differences like "Loan Participation Detail" (SSRS)
 * vs "Loan Participation (Selling Institution) Detail" (Crystal) fuzzy-match
 * at 1.0 after normalisation. The original string is preserved in the actual
 * section rule — normalisation is only applied inside the comparator.
 */
function normaliseTitleForFuzzy(s: string): string {
    return s
        .replace(/^\s*\[cols\]\s*/i, '')
        .replace(/\s*\([^)]*\)\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/**
 * Damerau-Levenshtein similarity ratio in [0, 1]. 1.0 = identical.
 * Threshold 0.85 = "near-identical, tiny typos or word-order stability".
 * Both sides pass through normaliseTitleForFuzzy() first so parenthesised
 * qualifiers, extra whitespace, and case differences don't reduce similarity.
 */
function similarityRatio(a: string, b: string): number {
    a = normaliseTitleForFuzzy(a);
    b = normaliseTitleForFuzzy(b);
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
    }
    const dist = dp[m][n];
    return 1 - dist / Math.max(m, n);
}

function indexOfHeader(sec: AnalyzedSection, header: string): number {
    return sec.columns.findIndex((c) => (c.header ?? '').trim() === header);
}


function valueAt(row: TableRow, idx: number): string | null {
    if (idx < 0 || idx >= row.cells.length) return null;
    const cell = row.cells[idx];
    return cell === null ? null : String(cell).trim();
}

/**
 * Assemble the `{column, value}` list for a ledger entry — one entry per
 * declared keyColumn. Value comes from whichever side has a non-null cell
 * (both sides agree for a matched row; only one side is populated for a
 * ROW_MISSING). Rendered by the HTML reporter as `col1=v1 | col2=v2`.
 */
function buildKeyPairs(
    keyColumns: string[],
    columnResolution: Map<string, { candTitle?: string; refTitle?: string }>,
    candSec: AnalyzedSection,
    refSec: AnalyzedSection,
    candRow: TableRow | undefined,
    refRow: TableRow | undefined,
): Array<{ column: string; value: string }> {
    const out: Array<{ column: string; value: string }> = [];
    for (const col of keyColumns) {
        const r = columnResolution.get(col);
        let value: string | null = null;
        if (candRow && r?.candTitle) {
            const idx = indexOfHeader(candSec, r.candTitle);
            value = valueAt(candRow, idx);
        }
        if ((value === null || value === '') && refRow && r?.refTitle) {
            const idx = indexOfHeader(refSec, r.refTitle);
            value = valueAt(refRow, idx);
        }
        out.push({ column: col, value: value ?? '' });
    }
    return out;
}

function groupRowsByKey(rows: TableRow[], keyIndices: number[], autoMode?: boolean): Map<string, TableRow> {
    const out = new Map<string, TableRow>();
    if (keyIndices.some((i) => i < 0)) return out; // any key column unresolvable → no rows keyable
    for (const row of rows) {
        if (autoMode && row.isTotalRow) continue;
        const keyParts = keyIndices.map((i) => valueAt(row, i) ?? '');
        if (keyParts.every((k) => !k)) continue;
        let key: string;
        if (autoMode) {
            const normParts = keyParts.map((v) => normalizeKeyValue(v));
            key = normParts.join('|').trim();
        } else {
            key = keyParts.join('|').trim();
        }
        if (!key) continue;
        out.set(key, row);
    }
    return out;
}

function normalizeKeyValue(v: string): string {
    const s = (v ?? '').trim();
    if (!s) return '';
    const iso = normaliseDateToIsoIfPossible(s);
    if (iso) return iso;
    return normalizeForMatch(s);
}

function normaliseDateToIsoIfPossible(s: string): string | null {
    if (!looksLikeDate(s)) return null;
    const d = parseCalendarDay(s);
    if (!d) return null;
    const mm = String(d.m).padStart(2, '0');
    const dd = String(d.d).padStart(2, '0');
    return `${d.y}-${mm}-${dd}`;
}

/**
 * Auto-mode string normalization for row keys and cell-value equality:
 * lowercase, replace every run of non-alphanumeric characters with a single
 * space, trim. Absorbs formatting drift (punctuation, case, whitespace) that
 * commonly appears when a report is re-implemented on a different engine,
 * without touching numeric-typed columns which stay strict via the number
 * branch in compareValues.
 */
function normalizeForMatch(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function kdKey(section: string, field: string, rowKey: string): string {
    return `${section}::${field}::${rowKey}`;
}

function indexKnownDifferences(kds: KnownDifference[]): Map<string, KnownDifference> {
    const m = new Map<string, KnownDifference>();
    for (const kd of kds) m.set(kdKey(kd.section, kd.field, kd.key), kd);
    return m;
}

function resolveTolerance(colRule: ReconcileColumnRule, global?: GlobalTolerance): number {
    if (typeof colRule.tolerance === 'number') return colRule.tolerance;
    if (colRule.kind === 'number' && global?.number !== undefined) return global.number;
    return 0;
}

export function compareValues(
    a: string,
    b: string,
    kind: 'string' | 'number' | 'date' | undefined,
    tolerance: number,
    autoMode?: boolean,
): { equal: boolean; delta?: number } {
    // Normalise whitespace
    const na = a.trim();
    const nb = b.trim();
    if (na === nb) return { equal: true };
    // Sniff numeric-shaped when kind not declared (locale-agnostic — same
    // detector used in the column-kind sniffer above).
    if (kind === 'number' || (kind === undefined && isNumericLike(na) && isNumericLike(nb))) {
        const aNum = parseNumeric(na);
        const bNum = parseNumeric(nb);
        if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
            const delta = Math.abs(aNum - bNum);
            return { equal: delta <= tolerance, delta };
        }
    }
    if (kind === 'date' || (kind === undefined && looksLikeDate(na) && looksLikeDate(nb))) {
        const da = parseCalendarDay(na);
        const db = parseCalendarDay(nb);
        if (da && db) {
            const equal = da.y === db.y && da.m === db.m && da.d === db.d;
            if (equal) return { equal: true };
            if (kind === 'date') return { equal: false };
        }
    }
    if (autoMode && (kind === 'string' || kind === 'date' || kind === undefined)) {
        const isoA = normaliseDateToIsoIfPossible(na);
        const isoB = normaliseDateToIsoIfPossible(nb);
        if (isoA && isoB && isoA === isoB) return { equal: true };
        if (normalizeForMatch(na) === normalizeForMatch(nb)) return { equal: true };
    }
    return { equal: false };
}

const MONTH_NAMES: Record<string, number> = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
    may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
    oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function looksLikeDate(s: string): boolean {
    if (!s) return false;
    return /^\s*(\d{1,4}[-/.\s]\d{1,2}[-/.\s]\d{1,4}|\d{1,2}[-/\s][A-Za-z]{3,9}[-/\s]\d{2,4}|[A-Za-z]{3,9}[-/\s]\d{1,2}[,\s]+\d{2,4})\s*$/.test(s);
}

function parseCalendarDay(s: string): { y: number; m: number; d: number } | null {
    if (!s) return null;
    const raw = s.trim();
    let m: RegExpMatchArray | null;
    m = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (m) {
        const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
        if (validYmd(y, mo, d)) return { y, m: mo, d };
    }
    m = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
    if (m) {
        const first = Number(m[1]), second = Number(m[2]);
        let y = Number(m[3]);
        if (y < 100) y += y >= 70 ? 1900 : 2000;
        if (first > 12 && second <= 12 && validYmd(y, second, first)) return { y, m: second, d: first };
        if (validYmd(y, first, second)) return { y, m: first, d: second };
    }
    m = raw.match(/^(\d{1,2})[-/\s]([A-Za-z]{3,9})[-/\s](\d{2,4})$/);
    if (m) {
        const d = Number(m[1]);
        const mo = MONTH_NAMES[m[2].toLowerCase()];
        let y = Number(m[3]);
        if (y < 100) y += y >= 70 ? 1900 : 2000;
        if (mo && validYmd(y, mo, d)) return { y, m: mo, d };
    }
    m = raw.match(/^([A-Za-z]{3,9})[-/\s](\d{1,2})[,\s]+(\d{2,4})$/);
    if (m) {
        const mo = MONTH_NAMES[m[1].toLowerCase()];
        const d = Number(m[2]);
        let y = Number(m[3]);
        if (y < 100) y += y >= 70 ? 1900 : 2000;
        if (mo && validYmd(y, mo, d)) return { y, m: mo, d };
    }
    return null;
}

function validYmd(y: number, m: number, d: number): boolean {
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
    if (y < 1900 || y > 2200) return false;
    if (m < 1 || m > 12) return false;
    if (d < 1 || d > 31) return false;
    const daysInMonth = [31, 28 + (leap(y) ? 1 : 0), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return d <= daysInMonth[m - 1];
}

function leap(y: number): boolean {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * Locale-agnostic numeric parser. Handles US ("1,234.56"), European
 * ("1.234,56"), French ("1 234,56"), currency-prefixed / -suffixed forms,
 * ISO-code prefixed forms ("USD 1,234.56"), percent-suffixed forms,
 * and accounting-style parentheses for negatives.
 */
function parseNumeric(s: string): number {
    // Strip currency + ISO codes + percent
    let cleaned = s
        .replace(/[$€£¥₹₩¢₽₺₪₨৳﷼]/g, '')
        .replace(/\b(USD|EUR|GBP|JPY|INR|CAD|AUD|CHF|CNY|HKD|SGD|MXN|BRL|ZAR|R\$|Rp|kr|Fr)\b/gi, '')
        .replace(/%/g, '')
        .replace(/\s/g, '')
        .trim();
    // Wrap-in-parens negative → convert to leading minus
    if (/^\(.+\)$/.test(cleaned)) cleaned = '-' + cleaned.slice(1, -1);
    // Detect European decimal-comma format vs US decimal-dot. A decimal comma
    // exists iff the LAST separator is a comma AND the value contains commas.
    // US "1,234.56" → last sep is dot. EU "1.234,56" → last sep is comma.
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    if (lastComma > lastDot) {
        // European: commas are decimal, dots are thousand-separator
        cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
        // US or plain: dots are decimal, commas are thousand-separator
        cleaned = cleaned.replace(/,/g, '');
    }
    return Number(cleaned);
}

function computeUnmatched(
    candSections: Map<string, AnalyzedSection>,
    refSections: Map<string, AnalyzedSection>,
    resolution: Map<string, { candTitle?: string; refTitle?: string }>,
    sectionRules: Record<string, ReconcileSectionRule>,
    threshold: number,
): ReconcileResult['unmatched'] {
    const usedCandTitles = new Set<string>();
    const usedRefTitles = new Set<string>();
    for (const r of resolution.values()) {
        if (r.candTitle) usedCandTitles.add(r.candTitle);
        if (r.refTitle) usedRefTitles.add(r.refTitle);
    }
    const candTitles = Array.from(candSections.keys());
    const refTitles = Array.from(refSections.keys());
    const sectionsInReferenceOnly = refTitles
        .filter((t) => !usedRefTitles.has(t) && !isFuzzyMatched(t, Array.from(usedRefTitles), threshold))
        .map((t) => ({
            name: t,
            nearestOnCandidate: candTitles
                .map((c) => ({ c, s: similarityRatio(t.toLowerCase(), c.toLowerCase()) }))
                .sort((a, b) => b.s - a.s)
                .slice(0, 3)
                .map((x) => x.c),
        }));
    const sectionsInCandidateOnly = candTitles.filter((t) => !usedCandTitles.has(t));
    // Columns — a section-by-section walk. Only for sections we resolved on both sides.
    const columnsInReferenceOnly: Array<{ section: string; name: string; nearestOnCandidate: string[] }> = [];
    for (const [canonicalSection, res] of resolution.entries()) {
        if (!res.candTitle || !res.refTitle) continue;
        const rule = sectionRules[canonicalSection];
        if (!rule) continue;
        const candSec = candSections.get(res.candTitle);
        const refSec = refSections.get(res.refTitle);
        if (!candSec || !refSec) continue;
        const candCols = candSec.columns.map((c) => (c.header ?? '').trim()).filter((h) => h.length > 0);
        const refCols = refSec.columns.map((c) => (c.header ?? '').trim()).filter((h) => h.length > 0);
        const declaredCanonical = Object.keys(rule.columns);
        const declaredMatchesInRef = new Set(
            declaredCanonical.map((canonical) => {
                const colRule = rule.columns[canonical];
                const candidatesForMatch = [canonical, ...(colRule.aliases ?? [])];
                return findFirstMatch(candidatesForMatch, refCols, threshold);
            }).filter((x): x is string => !!x),
        );
        for (const refCol of refCols) {
            if (declaredMatchesInRef.has(refCol)) continue;
            columnsInReferenceOnly.push({
                section: canonicalSection,
                name: refCol,
                nearestOnCandidate: candCols
                    .map((c) => ({ c, s: similarityRatio(refCol.toLowerCase(), c.toLowerCase()) }))
                    .sort((a, b) => b.s - a.s)
                    .slice(0, 3)
                    .map((x) => x.c),
            });
        }
    }
    return { sectionsInReferenceOnly, sectionsInCandidateOnly, columnsInReferenceOnly };
}

function isFuzzyMatched(t: string, pool: string[], threshold: number): boolean {
    return pool.some((p) => similarityRatio(t.toLowerCase(), p.toLowerCase()) >= threshold);
}
