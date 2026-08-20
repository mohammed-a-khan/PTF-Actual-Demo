/**
 * CS Report Validation — Layer 2.2b: Column detection by text-alignment network.
 *
 * WHY THIS REPLACES DENSITY ESTIMATION
 * ------------------------------------
 * Finding columns by kernel density over left edges asks "where do many runs start?". That
 * question has the wrong answer in several layouts that reports use constantly:
 *
 *   - A right-aligned money column has NO common left edge — its digits start wherever the
 *     magnitude puts them — so it produces no peak, or several weak ones.
 *   - A heading wider than its column contributes a left edge of its own, minting a band that
 *     holds a heading and no data.
 *   - A single long value fragments its column into two bands.
 *   - A paragraph of prose has a strong shared left edge and looks exactly like a column.
 *
 * A table is not a density pattern, it is a NETWORK. Cells line up with each other along both
 * axes at once: a column is a set of runs sharing a left, right or centre coordinate, AND each
 * of those runs sits on a row shared with runs from other columns. Prose fails the second half
 * of that test — every line is left-aligned, but the lines form no rows — which is precisely
 * the discrimination a density peak cannot make.
 *
 * ALGORITHM
 * ---------
 *   1. Collect the inked runs, tagged with the line (row) they sit on.
 *   2. Cluster their LEFT, RIGHT and CENTRE coordinates independently. Each cluster is a
 *      candidate alignment — a column edge that several runs share.
 *   3. Keep a candidate only when its runs span several DISTINCT rows. One row of runs is a
 *      heading or a caption, not a column; several rows is a column.
 *   4. Give every run to its strongest surviving candidate, so a run aligned on two axes is
 *      counted once rather than inflating both.
 *   5. Turn each surviving group into a column region spanning its runs, and cut the page into
 *      half-open bands at the region starts.
 *
 * Right-aligned columns come out of step 2 for free: their runs share a right coordinate even
 * though no two share a left one.
 *
 * @module report-validation/layout/CSTextAlignmentNetwork
 */

import type { ColumnBand, LogicalLine, TextItem } from '../CSReportPdfTypes';

export interface AlignmentNetworkOptions {
    /** Points within which two coordinates count as the same alignment. Default 2. */
    alignmentTolerance?: number;
    /** Distinct rows a candidate alignment must span to be believed a column. Default 3. */
    minRowsPerColumn?: number;
    /** Rows a region must contain before column detection runs at all. Default 3. */
    minRows?: number;
    /** Columns below which the network is treated as inconclusive and the caller should fall back. Default 2. */
    minColumns?: number;
}

/** Share of the wider region that two regions must share before they are judged one column. */
const SAME_COLUMN_OVERLAP = 0.5;

/** Which edge of a run an alignment is measured on. */
type Axis = 'left' | 'right' | 'center';

interface Run {
    item: TextItem;
    row: number;
    left: number;
    right: number;
    center: number;
}

interface Candidate {
    axis: Axis;
    coordinate: number;
    runs: Run[];
    rows: Set<number>;
}

/**
 * Detect columns via the alignment network. Returns bands left-to-right, or an empty array when
 * the region does not read as a table — too few rows, or too few columns to be a grid. An empty
 * result is a signal to fall back, NOT an assertion that there is no content.
 */
export function detectColumnsByAlignment(
    lines: LogicalLine[],
    opts: AlignmentNetworkOptions = {},
): ColumnBand[] {
    const tolerance = opts.alignmentTolerance ?? 2;
    const minRowsPerColumn = opts.minRowsPerColumn ?? 3;
    const minRows = opts.minRows ?? 3;
    const minColumns = opts.minColumns ?? 2;

    const runs: Run[] = [];
    lines.forEach((line, row) => {
        for (const item of line.items) {
            if (item.str.trim().length === 0) continue;
            const left = item.x;
            const right = item.x + Math.max(item.width, 0);
            runs.push({ item, row, left, right, center: (left + right) / 2 });
        }
    });
    if (runs.length === 0) return [];
    const distinctRows = new Set(runs.map((r) => r.row)).size;
    if (distinctRows < minRows) return [];

    // 2 + 3 — candidate alignments that span several rows.
    const candidates: Candidate[] = [];
    for (const axis of ['left', 'right', 'center'] as Axis[]) {
        for (const group of clusterByCoordinate(runs, axis, tolerance)) {
            if (group.rows.size >= minRowsPerColumn) candidates.push(group);
        }
    }
    if (candidates.length === 0) return [];

    // 4 — one run, one column. Strongest candidate wins; ties go to the wider row span, then to
    // the earlier axis, so the outcome does not depend on iteration order.
    candidates.sort((a, b) => b.rows.size - a.rows.size || b.runs.length - a.runs.length);
    const claimed = new Set<TextItem>();
    const columns: Run[][] = [];
    for (const candidate of candidates) {
        const mine = candidate.runs.filter((r) => !claimed.has(r.item));
        const rows = new Set(mine.map((r) => r.row));
        if (rows.size < minRowsPerColumn) continue;
        for (const run of mine) claimed.add(run.item);
        columns.push(mine);
    }
    if (columns.length < minColumns) return [];

    // 5 — regions, then bands. A band starts where its column's runs start and ends where the
    // next column's begin, so the bands tile the row with no gaps for a value to fall into.
    const regions = columns
        .map((group) => ({
            start: Math.min(...group.map((r) => r.left)),
            end: Math.max(...group.map((r) => r.right)),
        }))
        .sort((a, b) => a.start - b.start);

    const merged: Array<{ start: number; end: number }> = [];
    for (const region of regions) {
        const last = merged[merged.length - 1];
        // One column can surface as TWO groups when some of its cells align left and the rest
        // align right — the first group claims its runs, the remainder form a second. Those two
        // describe the same x-range, so they are merged.
        //
        // The test is NEAR-COINCIDENCE, not mere overlap. A long value that overruns into the
        // next column also makes two regions overlap, and merging on that alone fuses two
        // genuine columns into one — the name and the identifier arrive in a single cell. So the
        // shared span must be most of the WIDER region, which is true when both describe one
        // column and false when one is simply spilling into its neighbour.
        if (last) {
            const overlap = Math.min(last.end, region.end) - Math.max(last.start, region.start);
            const widest = Math.max(last.end - last.start, region.end - region.start);
            if (widest > 0 && overlap / widest >= SAME_COLUMN_OVERLAP) {
                last.start = Math.min(last.start, region.start);
                last.end = Math.max(last.end, region.end);
                continue;
            }
        }
        merged.push({ ...region });
    }
    if (merged.length < minColumns) return [];

    // Boundaries sit in the WHITESPACE between columns, not hard against the first run.
    //
    // A column's runs mark where its VALUES are, but a heading is routinely wider than its
    // values and starts to their left — a right-aligned money column is the standard case. A
    // band beginning flush at the first digit leaves that heading outside its own column, on the
    // neighbour, which is the mis-assignment that empties fields downstream. Splitting the gap
    // gives each column the blank space that visually belongs to it.
    //
    // When two regions overlap — a long value running under the next column — there is no gap to
    // split, so the boundary is the next column's start and the overrun is handled as cell
    // overflow further down the pipeline.
    const boundaries: number[] = [];
    for (let i = 0; i + 1 < merged.length; i++) {
        const gapStart = merged[i].end;
        const gapEnd = merged[i + 1].start;
        boundaries.push(gapStart < gapEnd ? (gapStart + gapEnd) / 2 : gapEnd);
    }

    const lastEnd = Math.max(...merged.map((m) => m.end));
    return merged.map((region, i) => ({
        start: i === 0 ? region.start : boundaries[i - 1],
        end: i + 1 < merged.length ? boundaries[i] : lastEnd + 1,
        header: null,
        headerPath: [],
        rightAligned: false,
    }));
}

/** Cluster runs whose `axis` coordinate falls within `tolerance` of each other. */
function clusterByCoordinate(runs: Run[], axis: Axis, tolerance: number): Candidate[] {
    const sorted = [...runs].sort((a, b) => a[axis] - b[axis]);
    const out: Candidate[] = [];
    let current: Candidate | null = null;
    for (const run of sorted) {
        const coordinate = run[axis];
        if (current && coordinate - current.coordinate <= tolerance) {
            current.runs.push(run);
            current.rows.add(run.row);
            continue;
        }
        current = { axis, coordinate, runs: [run], rows: new Set([run.row]) };
        out.push(current);
    }
    return out;
}
