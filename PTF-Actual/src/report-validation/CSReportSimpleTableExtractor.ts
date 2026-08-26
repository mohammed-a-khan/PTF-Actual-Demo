/**
 * Extract table rows from PDF token stream per a SimpleTableSpec.
 *
 * Strategy:
 *   1. Find the section header anchor (`spec.headerAnchor`) — sets the top of the table.
 *   2. Find each named column header on the row directly below (or in-line if the
 *      table's headers share the same y as the section anchor). Record each header's x.
 *   3. Any column in `spec.columns` with no `header` is treated as unlabeled and
 *      positioned to the right of the last labeled column (its x is the first data-row
 *      token's x on that side).
 *   4. Walk data rows below the header row (higher-to-lower y), grouping tokens by
 *      y-proximity (`rowYTolerance`). Assign each token to the nearest column x.
 *   5. Stop when `spec.stopAt` text is encountered (if provided) or the tokens end.
 *
 * @module report-validation/CSReportSimpleTableExtractor
 */

import type { TextItem } from './CSReportPdfTypes';
import type { SimpleTableSpec, SimpleTableColumnSpec } from './CSReportSimpleSpec';

const DEFAULT_ROW_Y_TOLERANCE = 4;

export interface TableExtractionResult {
    rows: Array<Record<string, string>>;
    /** Populated only when extraction failed. */
    reason?: string;
}

export function extractTable(tokensByPage: TextItem[][], spec: SimpleTableSpec): TableExtractionResult {
    const anchor = findAnchor(tokensByPage, spec.headerAnchor);
    if (!anchor) {
        return { rows: [], reason: `table headerAnchor "${spec.headerAnchor}" not found` };
    }
    const pageTokens = tokensByPage[anchor.page];
    const rowYTol = spec.rowYTolerance ?? DEFAULT_ROW_Y_TOLERANCE;

    // Locate column x positions from labeled headers first — headers must sit below the section anchor.
    const labeledColumns = spec.columns.filter((c) => c.header && c.header.length > 0);
    const columnXs = resolveColumnXs(pageTokens, anchor.token, labeledColumns, rowYTol);
    if (columnXs === null) {
        return { rows: [], reason: `could not locate all labeled column headers below "${spec.headerAnchor}"` };
    }

    // Determine header row y — the y of any labeled column header.
    const headerRowY = columnXs.headerY;

    // For unlabeled columns, their x will be inferred from the first data row.
    // Data rows sit strictly below the header row.
    const dataTokens = pageTokens.filter((t) => t.y < headerRowY && !isEmpty(t));

    // Apply `stopAt` — trim tokens once the stop anchor is reached (still on this page).
    let cutoffY = -Infinity;
    if (spec.stopAt) {
        const stopHit = dataTokens.find((t) => t.str.includes(spec.stopAt as string));
        if (stopHit) {
            cutoffY = stopHit.y + rowYTol; // exclude the stop row and anything below it
        }
    }
    const rowsTokens = dataTokens.filter((t) => t.y > cutoffY);

    // Group tokens by row-y proximity.
    const byY: Array<{ y: number; items: TextItem[] }> = [];
    for (const t of rowsTokens) {
        const bucket = byY.find((b) => Math.abs(b.y - t.y) <= rowYTol);
        if (bucket) {
            bucket.items.push(t);
            bucket.y = (bucket.y + t.y) / 2;
        } else {
            byY.push({ y: t.y, items: [t] });
        }
    }
    byY.sort((a, b) => b.y - a.y); // top-to-bottom

    // Figure out unlabeled column xs from the first data row that has extra tokens right of the last labeled x.
    const unlabeledXs = inferUnlabeledColumnXs(byY, spec.columns, columnXs.xs);

    // Build final row objects by assigning tokens to nearest column.
    const allXs: Array<{ key: string; x: number }> = [];
    for (const col of spec.columns) {
        const x = columnXs.xs[col.key] ?? unlabeledXs[col.key];
        if (x === undefined) {
            return { rows: [], reason: `could not resolve column "${col.key}" x-position` };
        }
        allXs.push({ key: col.key, x });
    }
    allXs.sort((a, b) => a.x - b.x);

    const rows: Array<Record<string, string>> = [];
    for (const bucket of byY) {
        const row: Record<string, string> = {};
        for (const col of spec.columns) row[col.key] = '';
        const sortedItems = [...bucket.items].sort((a, b) => a.x - b.x);
        for (const item of sortedItems) {
            const colKey = nearestColumnKey(item.x, allXs);
            const prev = row[colKey];
            row[colKey] = prev ? `${prev} ${item.str}` : item.str;
        }
        // Skip fully-empty rows.
        if (Object.values(row).every((v) => !v || v.trim().length === 0)) continue;
        rows.push(row);
    }
    return { rows };
}

function findAnchor(
    tokensByPage: TextItem[][],
    label: string,
): { token: TextItem; page: number } | null {
    const needle = label.toLowerCase();
    for (let p = 0; p < tokensByPage.length; p++) {
        for (const t of tokensByPage[p]) {
            if (t.str.toLowerCase().includes(needle)) return { token: t, page: p };
        }
    }
    return null;
}

interface ResolvedHeaderXs {
    xs: Record<string, number>;
    headerY: number;
}

function resolveColumnXs(
    pageTokens: TextItem[],
    sectionAnchor: TextItem,
    labeledColumns: SimpleTableColumnSpec[],
    rowYTol: number,
): ResolvedHeaderXs | null {
    if (labeledColumns.length === 0) {
        // No labeled columns — headerY is the row directly below the section anchor.
        return { xs: {}, headerY: sectionAnchor.y };
    }
    // Find each labeled header token below the section anchor.
    const headerTokens: Array<{ col: SimpleTableColumnSpec; token: TextItem }> = [];
    for (const col of labeledColumns) {
        const label = col.header as string;
        const hit = pageTokens.find(
            (t) => t.y < sectionAnchor.y && t.str.trim() === label,
        ) ?? pageTokens.find(
            (t) => t.y < sectionAnchor.y && t.str.includes(label),
        );
        if (!hit) return null;
        headerTokens.push({ col, token: hit });
    }
    // All headers should share (approximately) the same y.
    const headerYs = headerTokens.map((h) => h.token.y).sort((a, b) => b - a);
    const referenceY = headerYs[0];
    for (const y of headerYs) {
        if (Math.abs(y - referenceY) > rowYTol * 2) {
            // Headers span multiple rows — unusual; take the topmost as reference and continue.
            break;
        }
    }
    const xs: Record<string, number> = {};
    for (const h of headerTokens) xs[h.col.key] = h.token.x;
    return { xs, headerY: referenceY };
}

function inferUnlabeledColumnXs(
    rows: Array<{ y: number; items: TextItem[] }>,
    columns: SimpleTableColumnSpec[],
    labeledXs: Record<string, number>,
): Record<string, number> {
    const result: Record<string, number> = {};
    const unlabeled = columns.filter((c) => !labeledXs[c.key]);
    if (unlabeled.length === 0) return result;
    const lastLabeledX = Math.max(...Object.values(labeledXs), 0);
    // Find the first row that has tokens right of the last labeled x — use those xs.
    for (const bucket of rows) {
        const extra = bucket.items.filter((it) => it.x > lastLabeledX + 5).sort((a, b) => a.x - b.x);
        if (extra.length >= unlabeled.length) {
            for (let i = 0; i < unlabeled.length; i++) {
                result[unlabeled[i].key] = extra[i].x;
            }
            return result;
        }
    }
    // Fallback: place unlabeled columns evenly to the right of the last labeled column.
    let x = lastLabeledX + 40;
    for (const c of unlabeled) {
        result[c.key] = x;
        x += 60;
    }
    return result;
}

/**
 * Range-based column assignment: a token at x belongs to the LAST column whose
 * xStart ≤ token.x. Better than nearest-neighbor for tables where the value
 * sits between two column starts — e.g. `Bonds Outstanding` header at x=393
 * and `Calculation` header at x=503, value `1,000` at x=453 must go to
 * `Bonds Outstanding` (its range = [393, 503)), not `Calculation`.
 * Tokens strictly left of the first column go to the first column.
 */
function nearestColumnKey(x: number, columns: Array<{ key: string; x: number }>): string {
    let assigned = columns[0].key;
    for (let i = 0; i < columns.length; i++) {
        if (x >= columns[i].x) assigned = columns[i].key;
        else break;
    }
    return assigned;
}

function isEmpty(t: TextItem): boolean {
    return !t.str || t.str.trim().length === 0;
}
