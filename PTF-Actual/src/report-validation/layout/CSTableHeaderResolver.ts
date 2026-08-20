/**
 * CS Report Validation — Layer 2.5: Multi-level table header resolution.
 *
 * Reports frequently have two-row column headers where the top row spans
 * multiple sub-columns:
 *
 *     |          Original Rating         |     Current Rating           |
 *     | Agency A | Agency B | Watch (A/B) | Agency A | Agency B | Watch  ...  |
 *
 * The KDE column detector finds the SUB-COLUMN boundaries (Agency A, Agency B,
 * Watch, …). This module walks up from those sub-columns to find their
 * PARENT header spans, then flattens the hierarchy into a single header
 * string per column: `originalRatingAgencyA`, `originalRatingAgencyB`,
 * `originalRatingWatch`, `currentRatingAgencyA`, …
 *
 * The flat headers are what `spec.fieldMap` maps to canonical field
 * names. Multi-level headers are one of the biggest sources of extraction
 * bugs when you skip this pass — column headers silently get mislabelled
 * as just "Agency A" (which appears twice), so the reconciler sees two
 * fields with the same name and one overwrites the other.
 *
 * @module report-validation/layout/CSTableHeaderResolver
 */

import type { ColumnBand, LogicalLine, TextItem } from '../CSReportPdfTypes';
import { bandIndexForItem } from './CSColumnDetector';

/** Points of overlap below which a heading is clipping into a neighbour, not spanning it. */
const MIN_SPAN_OVERLAP_POINTS = 4;
/** Fraction of a heading's own width that must sit inside a band for it to count as spanned. */
const MIN_SPAN_OVERLAP_RATIO = 0.25;

export interface TableHeaderResolverOptions {
    /**
     * Y-gap tolerance in points between the sub-column header row and its parent header
     * row. Default 30 — parent header lives right above the sub-column row.
     */
    parentRowMaxGap?: number;
    /**
     * A parent-header text run qualifies as a "spanner" when its x-range covers this
     * fraction of at least this many sub-column bands. Default 2. If the top-row item
     * covers only ONE sub-column, it's not a multi-level header — it's just that
     * column's header itself.
     */
    minSpannedColumns?: number;
    /** Case-fold + strip non-alnum when composing flattened header names? Default true. */
    normalizeNames?: boolean;
}

/**
 * Assign headers to `bands` in-place using `headerLines` (the 1-2 rows immediately above
 * the data rows). Returns the same `bands` array with `header` + `headerPath` populated.
 *
 * When multiple header rows are given, they're processed bottom-up: the bottom row is the
 * "leaf" header per column; each row above is a spanner that groups multiple leaf columns.
 */
export function resolveTableHeaders(
    bands: ColumnBand[],
    headerLines: LogicalLine[],
    opts: TableHeaderResolverOptions = {},
): ColumnBand[] {
    if (bands.length === 0 || headerLines.length === 0) return bands;
    const minSpanned = opts.minSpannedColumns ?? 2;
    const maxGap = opts.parentRowMaxGap ?? 30;

    // Sort header rows top-to-bottom (highest y first) so we process them in visual
    // reading order.
    const linesTopDown = [...headerLines].sort((a, b) => b.y - a.y);

    // Leaf row = bottom-most header line. Its items map directly onto the bands.
    const leafRow = linesTopDown[linesTopDown.length - 1];
    const leafTexts = assignLeafLabelsExclusively(leafRow.items, bands);
    for (let i = 0; i < bands.length; i++) {
        const band = bands[i];
        const leafText = leafTexts[i] ?? '';
        bands[i].header = leafText || null;
        bands[i].headerPath = leafText ? [leafText] : [];
        // Right-aligned detection: leaf-item's right edge close to band's right edge but
        // the item's start is not close to the band's start.
        const leafItems = leafRow.items.filter((it) => itemInBand(it, bands, i));
        if (leafItems.length > 0) {
            const rightMost = leafItems.reduce((a, b) => (a.x + a.width > b.x + b.width ? a : b));
            const bandCenter = (band.start + band.end) / 2;
            bands[i].rightAligned = rightMost.x + rightMost.width * 0.5 > bandCenter;
        }
    }

    // Walk upward: each ancestor row's items become PATH PREFIXES for whichever bands the
    // item's x-range covers.
    for (let li = linesTopDown.length - 2; li >= 0; li--) {
        const ancestor = linesTopDown[li];
        const child = linesTopDown[li + 1];
        // Only consider ancestor if it's within `maxGap` of its child row (i.e. really
        // sitting above it, not a random earlier section title). Y decreases downward in
        // reading order but PDF Y grows upward — child y < ancestor y.
        if (ancestor.y - child.y > maxGap) continue;

        for (const item of ancestor.items) {
            const itemLeft = item.x;
            const itemRight = item.x + item.width;
            // Which bands does this item straddle?
            // A band counts as covered only when the overlap is MEANINGFUL. Counting any
            // overlap at all means a heading whose box clips one point into the next band —
            // routine, since headings are wider than their digits — reads as a two-column
            // spanner and gets camel-cased onto a neighbour it has nothing to do with
            // (`Purchase` + `Identifier` → `purchaseIdentifier`). A real spanner sits
            // squarely over its sub-columns, so requiring a fraction of the item's own width
            // separates the two without needing to know the report.
            const width = Math.max(itemRight - itemLeft, 1);
            const minOverlap = Math.max(MIN_SPAN_OVERLAP_POINTS, width * MIN_SPAN_OVERLAP_RATIO);
            const covered: number[] = [];
            for (let bi = 0; bi < bands.length; bi++) {
                const b = bands[bi];
                const overlap = Math.min(itemRight, b.end) - Math.max(itemLeft, b.start);
                if (overlap >= Math.min(minOverlap, b.end - b.start)) covered.push(bi);
            }
            const label = item.str.trim();
            if (label.length === 0) continue;
            if (covered.length < minSpanned) {
                // Covers ONE band: not a spanner but a CONTINUATION — the upper half of a
                // heading too wide for its column, wrapped over two lines (`Current Par` above
                // `Amount`, `S & P Recovery` above `Rate`). Dropping it, as a spanner-only rule
                // does, loses half of every wrapped heading and the column stops resolving.
                // Prepending rebuilds the heading in reading order.
                if (covered.length === 1) bands[covered[0]].headerPath.unshift(label);
                continue;
            }
            for (const bi of covered) {
                bands[bi].headerPath.unshift(label);
                bands[bi].spannerDepth = (bands[bi].spannerDepth ?? 0) + 1;
            }
        }
    }

    // Recompute `header` as a normalised flat concatenation of `headerPath` so downstream
    // fieldMap lookup can match on it deterministically. Preserve the raw headerPath
    // separately for diff-report display.
    const normalize = opts.normalizeNames !== false;
    for (const band of bands) {
        // A band whose heading arrived ONLY as a continuation has a path but no header yet —
        // the leaf row had nothing for it. Without this the heading is carried in headerPath
        // and never surfaces, so the column resolves to nothing.
        if (band.headerPath.length === 1 && (!band.header || band.header.trim().length === 0)) {
            band.header = band.headerPath[0];
            continue;
        }
        if (band.headerPath.length <= 1) continue;
        // A wrapped heading is ONE column name spread over lines, so it re-joins with a
        // space: `Current Par` + `Amount` is the column `Current Par Amount`, which is what
        // the spec declares. Only a genuine spanner hierarchy gets camel-cased, and that is
        // recorded by `spannerDepth` while the path was being built.
        const flat = band.spannerDepth && band.spannerDepth > 0
            ? flattenPath(band.headerPath, normalize)
            : band.headerPath.join(' ').replace(/\s+/g, ' ').trim();
        band.header = flat;
    }
    return bands;
}

/**
 * Join the items falling inside `band` on `line` into a single text run. Items are
 * left-to-right; joined with a single space; trimmed.
 */

/**
 * Assign the leaf header row's labels to bands as an ordered, EXCLUSIVE matching.
 *
 * Collecting per band — "which items land in band i", joined — lets one band swallow two
 * labels while its neighbour gets none. That happens whenever a label is wider than the
 * values beneath it, which is normal for right-aligned numeric columns: the heading starts
 * well left of its digits and overlaps the band to its left more than its own. The merged
 * text then matches no spec column, the nameless band's values are dropped, and if that band
 * held a key column every row in the section goes with it.
 *
 * A header row has exactly one label per column, so it is a matching problem, not a lookup:
 * walking left to right, each label takes the best-overlapping band strictly after the one
 * the previous label took. Labels cannot cross and cannot share a band.
 *
 * Bands with no label get `null`; `realignHeadersOntoDataBands` afterwards nudges a header
 * sitting over an empty band onto the neighbour that carries the values.
 */
function assignLeafLabelsExclusively(items: TextItem[], bands: ColumnBand[]): Array<string | null> {
    const out: Array<string | null> = bands.map(() => null);
    const inked = items.filter((i) => i.str.trim().length > 0).sort((a, b) => a.x - b.x);
    let next = 0;
    for (const item of inked) {
        if (next >= bands.length) break;
        const right = item.x + Math.max(item.width, 0);
        let best = -1;
        let bestOverlap = -Infinity;
        let bestDelta = Infinity;
        for (let bi = next; bi < bands.length; bi++) {
            const overlap = Math.min(right, bands[bi].end) - Math.max(item.x, bands[bi].start);
            const delta = Math.abs(item.x - bands[bi].start);
            if (overlap > bestOverlap || (overlap === bestOverlap && delta < bestDelta)) {
                best = bi;
                bestOverlap = overlap;
                bestDelta = delta;
            }
        }
        if (best < 0) continue;
        const text = item.str.trim();
        out[best] = out[best] === null ? text : `${out[best]} ${text}`.replace(/\s+/g, ' ').trim();
        next = best + 1;
    }
    return out;
}

/**
 * True when `item` belongs to band `index` of `bands`. Delegates to the same max-overlap
 * rule the data-row assignment uses, so a header can never land in a different band than
 * the values it names — a divergence that silently empties the column downstream.
 */
function itemInBand(item: TextItem, bands: ColumnBand[], index: number): boolean {
    return bandIndexForItem(item, bands) === index;
}

/**
 * Flatten a header path (`["Original Rating", "Agency A"]`) to a single canonical string
 * (`originalRatingAgencyA`) suitable for direct comparison to a spec.fieldMap key.
 */
function flattenPath(path: string[], normalize: boolean): string {
    const parts = path
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
    if (parts.length === 0) return '';
    const joined = parts.join(' ');
    if (!normalize) return joined;
    // camelCase: drop non-alnum, lowercase first char, uppercase following words.
    const tokens = joined.split(/[^A-Za-z0-9]+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return '';
    let out = tokens[0].toLowerCase();
    for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        out += t[0].toUpperCase() + t.slice(1).toLowerCase();
    }
    return out;
}
