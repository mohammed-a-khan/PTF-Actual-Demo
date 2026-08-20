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

    // Top-to-bottom, the order the heading reads in.
    const linesTopDown = [...headerLines].sort((a, b) => b.y - a.y);

    // EVERY header line is matched to the bands exclusively — not just the bottom one.
    //
    // Treating the bottom line as the only real header row and the lines above it as spanners
    // breaks on the common case: a heading too wide for its column wraps, so `Purchase` sits
    // above `Price` and `Current Par` above `Amount`. Those upper words are not spanners, they
    // are the rest of the heading. Worse, once bands are tight around their data, a wide upper
    // word overlaps several bands and gets copied onto all of them — one heading smeared across
    // three columns, and a band left holding six headings joined end to end.
    //
    // Matching line by line and stacking the results per band assembles a wrapped heading in
    // reading order and gives each label exactly one column per line.
    const placements = linesTopDown.map((line) => placeLabels(line.items, bands));

    for (const band of bands) {
        band.header = null;
        band.headerPath = [];
        band.headerLeft = undefined;
        band.spannerDepth = 0;
    }

    for (let li = 0; li < linesTopDown.length; li++) {
        const isLeaf = li === linesTopDown.length - 1;
        // An upper line only belongs to this heading block if it sits close above the next one;
        // further away it is a section title or a stray label, not part of the header.
        if (!isLeaf && linesTopDown[li].y - linesTopDown[li + 1].y > maxGap) continue;
        const below = isLeaf ? null : placements[li + 1];

        for (const placement of placements[li]) {
            // A genuine SPANNER sits over several sub-columns, which shows up as its x-range
            // containing labels from more than one band on the line beneath it. A wrapped
            // heading has exactly one label below it — its own continuation.
            const spanned = below
                ? [...new Set(
                      below
                          .filter((q) => q.left < placement.right && q.right > placement.left)
                          .map((q) => q.band),
                  )]
                : [];
            if (spanned.length >= minSpanned) {
                for (const bi of spanned) {
                    bands[bi].headerPath.push(placement.text);
                    bands[bi].spannerDepth = (bands[bi].spannerDepth ?? 0) + 1;
                }
                continue;
            }
            const band = bands[placement.band];
            band.headerPath.push(placement.text);
            band.headerLeft = band.headerLeft === undefined
                ? placement.left
                : Math.min(band.headerLeft, placement.left);
        }
    }

    // Right-alignment is read off the bottom line, the one sitting directly over the values.
    for (const placement of placements[placements.length - 1]) {
        const band = bands[placement.band];
        const centre = (band.start + band.end) / 2;
        band.rightAligned = (placement.left + placement.right) / 2 > centre;
    }

    // Flatten. A wrapped heading is ONE column name spread over lines, so it re-joins with a
    // space: `Current Par` + `Amount` is the column `Current Par Amount`, which is what the spec
    // declares. Only a genuine spanner hierarchy is camel-cased into a path.
    const normalize = opts.normalizeNames !== false;
    for (const band of bands) {
        if (band.headerPath.length === 0) {
            band.header = null;
            continue;
        }
        band.header = band.spannerDepth && band.spannerDepth > 0
            ? flattenPath(band.headerPath, normalize)
            : band.headerPath.join(' ').replace(/\s+/g, ' ').trim();
    }
    return bands;
}

/** One heading label and the band it was matched to. */
interface LabelPlacement {
    band: number;
    text: string;
    left: number;
    right: number;
}

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
function placeLabels(items: TextItem[], bands: ColumnBand[]): LabelPlacement[] {
    const out: LabelPlacement[] = [];
    if (bands.length === 0) return out;

    const labels = groupRunsIntoLabels(items);
    if (labels.length === 0) return out;

    const n = labels.length;
    const m = bands.length;
    const overlap = (li: number, bi: number): number => {
        const l = labels[li];
        const b = bands[bi];
        const value = Math.min(l.right, b.end) - Math.max(l.left, b.start);
        return value > 0 ? value : 0;
    };

    // best[i][j] — highest total overlap placing labels 0..i, with label i on band j and every
    // earlier label on a band at or before j. `prefix[i][j]` is the running max over bands, so
    // each cell is O(1) and the whole table is O(labels × bands).
    // One heading per band while there are enough bands to go round. A table gives each column
    // exactly one name, so letting two headings share a band is what produces
    // `"Purchase Price Current Par Amount"` beside a nameless column. Sharing is permitted only
    // when headings outnumber bands, where something has to give.
    const exclusive = n <= m;
    const NEG = -Infinity;
    const best: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(NEG));
    const prefix: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(NEG));
    for (let j = 0; j < m; j++) {
        best[0][j] = overlap(0, j);
        prefix[0][j] = j === 0 ? best[0][j] : Math.max(prefix[0][j - 1], best[0][j]);
    }
    for (let i = 1; i < n; i++) {
        for (let j = 0; j < m; j++) {
            // Strict: this label must sit strictly right of the previous one, so read the
            // running best from band j-1. Sharing: read it from band j.
            const carried = exclusive ? (j === 0 ? NEG : prefix[i - 1][j - 1]) : prefix[i - 1][j];
            best[i][j] = carried === NEG ? NEG : carried + overlap(i, j);
            prefix[i][j] = j === 0 ? best[i][j] : Math.max(prefix[i][j - 1], best[i][j]);
        }
    }

    // Walk back for the actual placement, latest-best band first so labels stay left-to-right.
    const placement = new Array<number>(n).fill(-1);
    let limit = m - 1;
    for (let i = n - 1; i >= 0; i--) {
        let chosen = -1;
        let chosenScore = NEG;
        for (let j = 0; j <= limit; j++) {
            if (best[i][j] !== NEG && best[i][j] >= chosenScore) {
                chosenScore = best[i][j];
                chosen = j;
            }
        }
        if (chosen < 0) chosen = Math.max(0, Math.min(limit, i));
        placement[i] = chosen;
        limit = exclusive ? chosen - 1 : chosen;
    }

    for (let i = 0; i < n; i++) {
        out.push({ band: placement[i], text: labels[i].text, left: labels[i].left, right: labels[i].right });
    }
    return out;
}

/**
 * Join the heading row's text runs into whole labels before any band is chosen.
 *
 * A producer may emit a heading as one run or as one run per WORD. Matching word runs to bands
 * individually scatters a single heading across several columns — `Issue` in one, `Name` in the
 * next — so runs separated by no more than a word space are combined first. What is matched is
 * then a column name, which is what a band actually has one of.
 */
function groupRunsIntoLabels(items: TextItem[]): Array<{ text: string; left: number; right: number }> {
    const inked = items
        .filter((i) => i.str.trim().length > 0)
        .sort((a, b) => a.x - b.x);
    const out: Array<{ text: string; left: number; right: number }> = [];
    for (const item of inked) {
        const left = item.x;
        const right = item.x + Math.max(item.width, 0);
        const last = out[out.length - 1];
        const gap = left - (last ? last.right : 0);
        // Only a small POSITIVE gap is word spacing. A negative gap means the previous run's
        // reported width over-runs the next one — common, since a run's width can include a
        // trailing space — and merging on it would fuse two distinct headings into one.
        if (last && gap >= MIN_WORD_GAP && gap <= MAX_WORD_GAP) {
            last.text = `${last.text} ${item.str.trim()}`.replace(/\s+/g, ' ').trim();
            last.right = Math.max(last.right, right);
            continue;
        }
        out.push({ text: item.str.trim(), left, right });
    }
    return out;
}

/** Clear space, in points, up to which two runs are words of one heading rather than two headings. */
const MAX_WORD_GAP = 6;
/** Slack for a run whose reported width over-runs the next run by a hair. Beyond this they are separate headings. */
const MIN_WORD_GAP = -2;

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
