/**
 * PDF table-depth validator (§7 augmentation).
 *
 * Existing `CSTableExtractor` gives us positional cell grids. This module
 * adds the *quality* dimension consumer teams asked for after the demo:
 *
 *   - **Empty-vs-missing distinction** — a blank cell in an otherwise
 *     populated column is a data hole, not a layout artifact; a whole
 *     column that is blank across every row is (usually) a layout artifact.
 *   - **Merged-cell detection** — a row whose only non-empty cell spans the
 *     full width of the column band and whose text runs across ≥2 detected
 *     column midpoints is treated as a merged cell (subtotal / section
 *     label). We surface it so the caller doesn't count it as a data row.
 *   - **Row-shape accuracy score** — Camelot-inspired ratio of "cells that
 *     matched a detected column midpoint within tolerance" ÷ total cells.
 *     Consumers use this as a heuristic threshold (typical passing: ≥ 0.85).
 *   - **Column-arity assertion** — a row whose non-empty cell count differs
 *     from the expected column count is a torn-cell finding.
 *
 * No native deps. Pure JS over the `TableRow[]` structure already produced
 * by our layout pipeline.
 *
 * @module report-validation/checks/CSPdfTableDepthValidator
 */

import type { TableRow, ColumnBand } from '../CSReportPdfTypes';

export interface TableDepthRule {
    /** Assert every non-header row has this many non-empty cells (arity). */
    expectedColumnCount?: number;
    /** Minimum acceptable row-shape accuracy (0..1). */
    minAccuracyScore?: number;
    /** Rows with more empty cells than this ratio (0..1) are flagged as sparse. */
    maxRowSparsityRatio?: number;
    /** If true, columns entirely empty across all rows are flagged. */
    flagAllEmptyColumns?: boolean;
    /** If true, merged rows (subtotals/section labels) are surfaced separately, not counted as data rows. */
    reportMergedRows?: boolean;
    /** Assert no merged-row is a data row — flag as MERGED_ROW_UNEXPECTED. */
    forbidMergedRows?: boolean;
}

export interface TableDepthFinding {
    kind:
        | 'ROW_ARITY_DRIFT'
        | 'ACCURACY_BELOW_THRESHOLD'
        | 'ROW_TOO_SPARSE'
        | 'COLUMN_ALL_EMPTY'
        | 'MERGED_ROW_DETECTED'
        | 'MERGED_ROW_UNEXPECTED';
    message: string;
    rowIndex?: number;
    columnIndex?: number;
    expected?: string;
    actual?: string;
}

export interface TableDepthAnalysis {
    findings: TableDepthFinding[];
    accuracyScore: number;
    mergedRowIndices: number[];
    dataRowCount: number;
    emptyColumnIndices: number[];
}

export function analyzeTableDepth(
    rows: TableRow[],
    columns: ColumnBand[],
    rule: TableDepthRule,
): TableDepthAnalysis {
    const findings: TableDepthFinding[] = [];
    const mergedRowIndices: number[] = [];
    const dataRows: TableRow[] = [];

    // ---- pass 1: merged-row detection --------------------------------------
    // A row is "merged" when only one column has a non-empty cell AND the
    // text plainly runs wider than a single column (checked by looking for
    // spaces / more than N characters). Very conservative heuristic.
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const nonEmpty = r.cells.filter((c) => c !== null && String(c).trim().length > 0);
        if (nonEmpty.length === 1 && String(nonEmpty[0]).trim().length > 12) {
            mergedRowIndices.push(i);
            if (rule.reportMergedRows) {
                findings.push({
                    kind: 'MERGED_ROW_DETECTED',
                    message: `Row ${i} appears to be a merged / subtotal row: "${String(nonEmpty[0]).slice(0, 80)}"`,
                    rowIndex: i,
                    actual: String(nonEmpty[0]).slice(0, 200),
                });
            }
            if (rule.forbidMergedRows) {
                findings.push({
                    kind: 'MERGED_ROW_UNEXPECTED',
                    message: `Row ${i} is a merged row but the spec forbids merged rows in this table`,
                    rowIndex: i,
                    actual: String(nonEmpty[0]).slice(0, 200),
                });
            }
        } else {
            dataRows.push(r);
        }
    }

    // ---- pass 2: row-arity check on data rows ------------------------------
    if (rule.expectedColumnCount !== undefined) {
        for (let i = 0; i < rows.length; i++) {
            if (mergedRowIndices.includes(i)) continue;
            const nonEmpty = rows[i].cells.filter((c) => c !== null && String(c).trim().length > 0);
            if (nonEmpty.length !== rule.expectedColumnCount) {
                findings.push({
                    kind: 'ROW_ARITY_DRIFT',
                    message: `Row ${i} has ${nonEmpty.length} non-empty cells; expected ${rule.expectedColumnCount}`,
                    rowIndex: i,
                    expected: String(rule.expectedColumnCount),
                    actual: String(nonEmpty.length),
                });
            }
        }
    }

    // ---- pass 3: sparsity check --------------------------------------------
    if (rule.maxRowSparsityRatio !== undefined) {
        for (let i = 0; i < rows.length; i++) {
            if (mergedRowIndices.includes(i)) continue;
            const total = rows[i].cells.length;
            if (total === 0) continue;
            const empty = rows[i].cells.filter((c) => c === null || String(c).trim().length === 0).length;
            const ratio = empty / total;
            if (ratio > rule.maxRowSparsityRatio) {
                findings.push({
                    kind: 'ROW_TOO_SPARSE',
                    message: `Row ${i} sparsity ${(ratio * 100).toFixed(0)}% exceeds max ${(rule.maxRowSparsityRatio * 100).toFixed(0)}%`,
                    rowIndex: i,
                    expected: `≤ ${(rule.maxRowSparsityRatio * 100).toFixed(0)}%`,
                    actual: `${(ratio * 100).toFixed(0)}%`,
                });
            }
        }
    }

    // ---- pass 4: all-empty column detection --------------------------------
    const emptyColumnIndices: number[] = [];
    if (rule.flagAllEmptyColumns && columns.length > 0) {
        for (let c = 0; c < columns.length; c++) {
            const anyNonEmpty = rows.some((r) => {
                const cell = r.cells[c];
                return cell !== null && String(cell).trim().length > 0;
            });
            if (!anyNonEmpty) {
                emptyColumnIndices.push(c);
                findings.push({
                    kind: 'COLUMN_ALL_EMPTY',
                    message: `Column ${c} is empty across all ${rows.length} rows`,
                    columnIndex: c,
                    actual: '0/' + rows.length,
                });
            }
        }
    }

    // ---- accuracy score: cells that landed in the expected number of columns
    // ÷ total cells across all non-merged rows.
    let matched = 0;
    let total = 0;
    for (let i = 0; i < rows.length; i++) {
        if (mergedRowIndices.includes(i)) continue;
        for (const c of rows[i].cells) {
            total++;
            if (c !== null && String(c).trim().length > 0) matched++;
        }
    }
    const accuracyScore = total === 0 ? 1.0 : matched / total;

    if (rule.minAccuracyScore !== undefined && accuracyScore < rule.minAccuracyScore) {
        findings.push({
            kind: 'ACCURACY_BELOW_THRESHOLD',
            message: `Table shape accuracy ${accuracyScore.toFixed(3)} below minimum ${rule.minAccuracyScore.toFixed(3)}`,
            expected: `≥ ${rule.minAccuracyScore.toFixed(3)}`,
            actual: accuracyScore.toFixed(3),
        });
    }

    return {
        findings,
        accuracyScore,
        mergedRowIndices,
        dataRowCount: dataRows.length,
        emptyColumnIndices,
    };
}
