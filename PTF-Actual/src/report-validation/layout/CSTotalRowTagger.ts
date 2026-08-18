/**
 * CS Report Validation — Layer 2.7: Total/subtotal row tagger.
 *
 * The last row of a Crystal detail page renders as:
 *
 *   SUBTOTALS:    1,234,567.89    1,200,000.00    ...
 *
 * SSRS's equivalent at the bottom of Position Detail 1D:
 *
 *   Totals:             1,234,567.89    1,198,765.43
 *
 * These are NOT data rows — they're report-side checksums. Extracting
 * them as regular rows creates a phantom record whose key doesn't line
 * up with anything on the other side, and the reconciler emits a false
 * MISSING/EXTRA finding on it.
 *
 * The tagger flags such rows so:
 *   1. They don't enter `CanonicalReport.records`.
 *   2. Their numeric values feed `CanonicalReport.meta.checksums`, so
 *      the reconciler can verify the sum of DATA rows matches the
 *      report's declared total (mismatch = extractor missed a row).
 *
 * @module report-validation/layout/CSTotalRowTagger
 */

import type { TableRow } from '../CSReportPdfTypes';

export interface TotalRowTaggerOptions {
    /** Additional keywords that identify a totals row beyond the built-in set. Case-insensitive. */
    extraKeywords?: string[];
}

/**
 * Built-in totals keywords. The leftmost non-empty cell is checked (with a trailing colon
 * stripped) — reports tend to put "Total", "Totals", "Subtotal", "Grand Total" etc. in
 * the label column with the numeric total to the right.
 */
const DEFAULT_TOTAL_KEYWORDS = [
    'total',
    'totals',
    'subtotal',
    'subtotals',
    'sub total',
    'sub totals',
    'grand total',
    'grand totals',
    'sum',
    'total loans',
    'subtotals loans',
];

/**
 * Walk `rows` in place, tagging any that match totals-row patterns. Mutation is
 * intentional — the tagger is one step in a chain that all mutates the same TableRow
 * objects; making it functional would waste allocation.
 *
 * Returns the mutated array for chaining.
 */
export function tagTotalRows(rows: TableRow[], opts: TotalRowTaggerOptions = {}): TableRow[] {
    const keywords = new Set<string>(
        [...DEFAULT_TOTAL_KEYWORDS, ...(opts.extraKeywords ?? [])].map((k) => k.toLowerCase()),
    );
    for (const row of rows) {
        if (row.isGroupHeader) continue; // group headers aren't totals
        const label = firstNonEmptyCell(row);
        if (!label) continue;
        const normalized = label.replace(/[:.,;]+$/g, '').trim().toLowerCase();
        if (keywords.has(normalized)) {
            row.isTotalRow = true;
            continue;
        }
        // "Total <thing>:" / "Subtotal <thing>:" pattern — first word matches.
        const firstWord = normalized.split(/\s+/)[0];
        if (firstWord === 'total' || firstWord === 'totals' || firstWord === 'subtotal' || firstWord === 'subtotals') {
            row.isTotalRow = true;
        }
    }
    tagUnlabelledTotalsBandRows(rows);
    return rows;
}

/**
 * Tag the UNLABELLED half of a two-line totals band.
 *
 * Crystal draws its grand total across two baselines one row-pitch apart — the figures
 * alone, then the same figures again beside the `TOTALS:` label:
 *
 *     1,234,567.89   1,198,765.43        <- y 441.3, no label
 *     TOTALS:   1,234,567.89   1,198,765.43   <- y 433.7, labelled
 *
 * Keyword tagging catches the second line only. The first then survives as a "data row"
 * with no business key, so the mapper drops it — silently before the coverage gate existed,
 * and as a spurious COVERAGE_GAP after.
 *
 * The rule is deliberately narrow: a row is absorbed into the totals band only when it is
 * ADJACENT to a tagged total row and every one of its filled cells holds the SAME value in
 * the SAME column as that total row. Requiring exact value agreement is what keeps this from
 * swallowing a genuine data row whose key failed to extract — which is precisely the defect
 * the coverage gate is meant to surface.
 */
function tagUnlabelledTotalsBandRows(rows: TableRow[]): void {
    for (let i = 0; i < rows.length; i++) {
        if (!rows[i].isTotalRow) continue;
        for (const neighbour of [i - 1, i + 1]) {
            if (neighbour < 0 || neighbour >= rows.length) continue;
            const candidate = rows[neighbour];
            if (candidate.isTotalRow || candidate.isGroupHeader) continue;
            if (duplicatesFilledCellsOf(candidate, rows[i])) candidate.isTotalRow = true;
        }
    }
}

/**
 * True when every filled cell of `candidate` matches `total`'s cell in the same column,
 * and there is at least one such cell. Comparison is numeric where both parse as numbers
 * (so `1,234,567.89` and `57421291.53` agree), textual otherwise.
 */
function duplicatesFilledCellsOf(candidate: TableRow, total: TableRow): boolean {
    let matched = 0;
    for (let ci = 0; ci < candidate.cells.length; ci++) {
        const cell = candidate.cells[ci];
        if (cell === null || cell.trim().length === 0) continue;
        const against = total.cells[ci];
        if (against === null || against === undefined || against.trim().length === 0) return false;
        const a = tryParseNumber(cell);
        const b = tryParseNumber(against);
        if (a !== null && b !== null) {
            if (a !== b) return false;
        } else if (cell.trim() !== against.trim()) {
            return false;
        }
        matched++;
    }
    return matched > 0;
}

/**
 * Extract the checksum-worthy numeric values from a total row: any column whose cell
 * parses as a number. Returned as a `{columnIndex: value}` map so the caller can align
 * against `spec.expectedChecksums` by column position.
 *
 * Callers typically do:
 *
 *     const totals = rows.filter(r => r.isTotalRow);
 *     const checksums = totals.map(r => extractChecksumsFromTotalRow(r));
 *
 * and stash the merged result under `CanonicalReport.meta.checksums`.
 */
export function extractChecksumsFromTotalRow(row: TableRow): Record<number, number> {
    const out: Record<number, number> = {};
    for (let ci = 0; ci < row.cells.length; ci++) {
        const cell = row.cells[ci];
        if (cell === null) continue;
        const parsed = tryParseNumber(cell);
        if (parsed !== null) out[ci] = parsed;
    }
    return out;
}

function firstNonEmptyCell(row: TableRow): string | null {
    for (const cell of row.cells) {
        if (cell !== null && cell.trim().length > 0) return cell.trim();
    }
    return null;
}

/** Same normalization pattern as the reconciler's numeric parse — kept local to avoid the cross-module dep. */
function tryParseNumber(raw: string): number | null {
    let s = raw.trim();
    if (s.length === 0) return null;
    let sign = 1;
    const parens = s.match(/^\((.+)\)$/);
    if (parens) {
        sign = -1;
        s = parens[1].trim();
    }
    // strip currency + separators
    s = s.replace(/[$£€¥₹¢₽₩,'\s]/g, '');
    // strip trailing %
    if (s.endsWith('%')) s = s.slice(0, -1);
    if (!/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s)) return null;
    const n = parseFloat(s) * sign;
    return Number.isFinite(n) ? n : null;
}
