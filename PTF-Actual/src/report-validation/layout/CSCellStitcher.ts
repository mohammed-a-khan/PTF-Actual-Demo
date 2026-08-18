/**
 * CS Report Validation — Layer 2.6: Multi-line + cross-page cell stitching.
 *
 * TWO stitching problems in one module because they share the same core
 * "when do two rows really represent one logical row" question.
 *
 * MULTI-LINE CELLS (within a page)
 * --------------------------------
 * A long name in the first column wraps across two lines:
 *
 *   SAMPLE COUNTERPARTY 2024-2 FIRST      REF238664   60,310.60
 *   TRANCHE
 *
 * The second line has content ONLY in the first column; every other
 * column band is empty. That's the stitching trigger: a line with data
 * in exactly one column concatenates its lone cell into the same column
 * of the ADJACENT data row.
 *
 * "Adjacent" means nearest by y — NOT "the row above". Some engines
 * vertically centre a wrapped cell against its row, so a two-line name
 * renders as
 *
 *   A CONSIDERABLY LONGER COUNTERPARTY        <- y 180.5
 *   REF198193   99.5000   12,345.67   ...     <- y 176.5
 *   NAME LTD                                  <- y 172.5
 *
 * where the wrap lines straddle their own data row 4pt away while the
 * PREVIOUS row sits a full row-pitch (11pt) above. Merging backward
 * unconditionally would graft this row's name onto the previous record
 * and leave this one holding only `NAME LTD`.
 *
 * CROSS-PAGE CONTINUATION
 * -----------------------
 * A long detail section spans multiple
 * pages. On page N+1 the report renders the section title again + the
 * column headers again + more data rows. The stitching pass finds:
 *
 *   - Same section title on adjacent pages
 *   - Same column skeleton (bands overlap)
 *   - Header row on page N+1 matches header row on page N
 *
 * and merges page N+1's data rows into page N's row list, then marks
 * page N+1's section as `continuedFromPreviousPage` so the section
 * mapper knows not to double-count it.
 *
 * @module report-validation/layout/CSCellStitcher
 */

import type { ColumnBand, LogicalLine, TableRow, TextItem } from '../CSReportPdfTypes';
import { assignItemsToColumns } from './CSColumnDetector';

export interface CellStitcherOptions {
    /** Max y-gap between a candidate continuation row and its parent row, in points. Default 20. */
    maxContinuationGap?: number;
    /**
     * Continuation-row detection threshold: how many columns must be EMPTY on the
     * candidate row for it to qualify as a continuation. Default: everything except one
     * column (so a row with data in 1 of N columns is a continuation candidate).
     */
    continuationEmptyColumns?: 'all-but-one' | number;
}

/**
 * Given a list of already-column-assigned rows, merge continuation rows into their parents.
 * Returns a new array — never mutates input. Rows that were absorbed have their content
 * appended (space-separated) to the parent row's matching column.
 */
export function stitchMultiLineCells(rows: TableRow[], opts: CellStitcherOptions = {}): TableRow[] {
    if (rows.length === 0) return [];
    const maxGap = opts.maxContinuationGap ?? 20;
    const emptyMode = opts.continuationEmptyColumns ?? 'all-but-one';

    // Classify up front so a continuation can look BOTH ways for its anchor.
    const continuation = rows.map((row) => {
        if (row.isGroupHeader || row.isTotalRow) return false;
        const filled = countFilledCells(row);
        if (filled === 0) return false;
        return emptyMode === 'all-but-one' ? filled === 1 : filled <= (emptyMode as number);
    });
    // Anchors are the real data rows. Group headers and totals never absorb a wrap.
    const anchor = rows.map((row, i) => !continuation[i] && !row.isGroupHeader && !row.isTotalRow);

    // Clone so the documented "never mutates input" contract holds even though we now
    // merge into rows that may already have been emitted conceptually.
    const working: TableRow[] = rows.map((row) => ({
        ...row,
        cells: [...row.cells],
        cellMeta: [...row.cellMeta],
    }));
    const absorbed = new Array<boolean>(rows.length).fill(false);

    for (let i = 0; i < working.length; i++) {
        if (!continuation[i]) continue;
        const target = pickAnchorIndex(working, anchor, i, maxGap);
        if (target === null) continue; // Orphan wrap — keep it as its own row rather than lose the text.
        mergeContinuationInto(working[target], working[i]);
        absorbed[i] = true;
    }

    return working.filter((_, i) => !absorbed[i]);
}

/** Count cells with non-whitespace content. */
function countFilledCells(row: TableRow): number {
    return row.cells.filter((c) => c !== null && c.trim().length > 0).length;
}

/**
 * Pick which anchor row a continuation attaches to: the nearest anchor by y-distance,
 * looking above and below, within `maxGap`.
 *
 * Nearest-by-distance is the primary rule because a wrapped cell always renders tighter
 * to its own row than one full row-pitch away. When both neighbours are exactly equidistant
 * (evenly-spaced rows — the classic "name wraps onto the line below" layout), the tiebreak
 * prefers the anchor whose cell in the continuation's column is EMPTY, since a row that
 * already has text there is not the one missing its continuation. Failing that, backward,
 * matching the historical behaviour.
 *
 * Returns null when no anchor sits within `maxGap`.
 */
function pickAnchorIndex(
    rows: TableRow[],
    anchor: boolean[],
    index: number,
    maxGap: number,
): number | null {
    let prev: number | null = null;
    for (let j = index - 1; j >= 0; j--) {
        if (anchor[j]) { prev = j; break; }
    }
    let next: number | null = null;
    for (let j = index + 1; j < rows.length; j++) {
        if (anchor[j]) { next = j; break; }
    }

    const gapPrev = prev === null ? Infinity : Math.abs(rows[prev].y - rows[index].y);
    const gapNext = next === null ? Infinity : Math.abs(rows[next].y - rows[index].y);
    const prevOk = gapPrev <= maxGap;
    const nextOk = gapNext <= maxGap;

    if (!prevOk && !nextOk) return null;
    if (prevOk && !nextOk) return prev;
    if (nextOk && !prevOk) return next;
    if (gapPrev < gapNext) return prev;
    if (gapNext < gapPrev) return next;

    // Equidistant — fall back to the column-emptiness signal, then to backward.
    const column = filledColumnIndex(rows[index]);
    if (column !== null) {
        const prevEmpty = isCellEmpty(rows[prev as number], column);
        const nextEmpty = isCellEmpty(rows[next as number], column);
        if (nextEmpty && !prevEmpty) return next;
    }
    return prev;
}

/** Index of the first cell with content, or null when the row is empty. */
function filledColumnIndex(row: TableRow): number | null {
    for (let ci = 0; ci < row.cells.length; ci++) {
        const cell = row.cells[ci];
        if (cell !== null && cell.trim().length > 0) return ci;
    }
    return null;
}

function isCellEmpty(row: TableRow, column: number): boolean {
    const cell = row.cells[column];
    return cell === null || cell.trim().length === 0;
}

/**
 * Append every filled cell of `source` onto the same column of `target`, space-separated,
 * and tag the resulting cells as stitched so the diff report can show which values were
 * reassembled from a wrap.
 */
function mergeContinuationInto(target: TableRow, source: TableRow): void {
    for (let ci = 0; ci < source.cells.length; ci++) {
        const cell = source.cells[ci];
        if (cell === null || cell.trim().length === 0) continue;
        const existing = target.cells[ci];
        if (existing === null || existing.trim().length === 0) {
            target.cells[ci] = cell.trim();
        } else if (source.y > target.y) {
            // Source rendered ABOVE the target — it's the first line of the wrap, so it
            // leads. Ordering matters: "A Considerably Longer Counterparty Name Ltd Term" + "Loan", not the reverse.
            target.cells[ci] = `${cell} ${existing}`.replace(/\s+/g, ' ').trim();
        } else {
            target.cells[ci] = `${existing} ${cell}`.replace(/\s+/g, ' ').trim();
        }
        const meta = target.cellMeta[ci] ?? {};
        meta.stitched = true;
        target.cellMeta[ci] = meta;
    }
}

/**
 * Convert a list of `LogicalLine`s to `TableRow`s by assigning items to column bands.
 * The row index and total/group flags are left as defaults — later passes (row tagger,
 * group-header detection) set them based on cell content.
 */
export function linesToTableRows(lines: LogicalLine[], bands: ColumnBand[]): TableRow[] {
    return lines.map((line, idx) => {
        const buckets = assignItemsToColumns(line, bands);
        const cells: (string | null)[] = buckets.map((items) => {
            if (items === null) return null;
            return items
                .map((it) => it.str)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
        });
        const cellMeta: (import('../CSReportPdfTypes').CellMeta | null)[] = buckets.map((items) => {
            if (items === null) return null;
            const bold = items.some((it) => /bold|black|heavy/i.test(it.fontName));
            const color = items.find((it) => it.color)?.color;
            const meta: import('../CSReportPdfTypes').CellMeta = {};
            if (bold) meta.fontWeight = 'bold';
            if (color) meta.color = color;
            return Object.keys(meta).length > 0 ? meta : null;
        });
        return {
            rowIndex: idx + 1,
            y: line.y,
            cells,
            cellMeta,
            isGroupHeader: false,
            isTotalRow: false,
            groupLabel: null,
        };
    });
}

/**
 * Cross-page continuation: given two adjacent pages' `[title, bands, rows]` triples for
 * the same section, decide whether page N+1's rows should merge into page N's. Merge
 * criteria:
 *   - Titles case-fold-equal
 *   - Band count matches
 *   - Band positions within `bandTolerance` points (default 5)
 */
export function shouldMergeAcrossPages(
    prev: { title: string; bands: ColumnBand[] },
    next: { title: string; bands: ColumnBand[] },
    bandTolerance = 5,
): boolean {
    if (prev.title.toLowerCase().trim() !== next.title.toLowerCase().trim()) return false;
    if (prev.bands.length !== next.bands.length) return false;
    for (let i = 0; i < prev.bands.length; i++) {
        if (Math.abs(prev.bands[i].start - next.bands[i].start) > bandTolerance) return false;
        if (Math.abs(prev.bands[i].end - next.bands[i].end) > bandTolerance) return false;
    }
    return true;
}

/**
 * Extract a "group label" from a row that qualifies as a group sub-header. A group
 * sub-header is a row where the leftmost cell has bold text OR emphasised styling AND
 * all other cells are empty. Returns null when the row doesn't qualify.
 *
 * Used by the group-header tagging pass; kept here alongside stitching because both
 * modules work over the same TableRow shape.
 */
export function extractGroupLabelIfHeader(row: TableRow, items: TextItem[]): string | null {
    const filled = row.cells.filter((c) => c !== null && c.trim().length > 0).length;
    if (filled !== 1) return null;
    const firstCell = row.cells.find((c) => c !== null && c.trim().length > 0);
    if (!firstCell) return null;
    // Bold detection — look at the source items backing the first cell.
    const bold = items.some((it) => /bold|black|heavy/i.test(it.fontName));
    if (!bold) return null;
    return firstCell.trim();
}
