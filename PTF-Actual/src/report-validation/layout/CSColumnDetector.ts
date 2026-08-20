/**
 * CS Report Validation — Layer 2.2: Column detection.
 *
 * Given a set of lines from the same table region, find the vertical
 * column boundaries. Uses kernel-density estimation on the x-start
 * coordinates of every text item — local maxima of the KDE are the
 * column-start positions. This handles both left-aligned columns (labels)
 * and right-aligned columns (numeric) provided the sample includes
 * enough rows for the density to peak reliably.
 *
 * The approach is more robust than "look at the header row's item
 * positions" because in Crystal reports the header row is often the ONLY
 * line where every column has a value — later rows have blanks. Density
 * over all rows captures the true column skeleton.
 *
 * @module report-validation/layout/CSColumnDetector
 */

import type { ColumnBand, LogicalLine, TextItem } from '../CSReportPdfTypes';
import { detectColumnsByAlignment } from './CSTextAlignmentNetwork';

export interface ColumnDetectorOptions {
    /** Gaussian kernel bandwidth in PDF points. Smaller = more columns detected; larger = merges nearby columns. Default 3. */
    kdeBandwidth?: number;
    /** Minimum peak-to-neighbour ratio to accept a peak. Default 1.2 — a peak must be 20% taller than its immediate neighbours. */
    peakProminence?: number;
    /** Sample resolution — number of x-samples across the region's x-range. Default 400. */
    sampleResolution?: number;
    /**
     * When true, also emit a column band using item RIGHT-edges (x + width). Useful for
     * detecting right-aligned numeric columns where LEFT edges vary widely (numbers of
     * different magnitudes align on the right). Default FALSE — the `right - medianWidth`
     * offset estimator is coarse and creates spurious duplicate columns on tight-alignment
     * input. A follow-up will replace it with a proper right-alignment detector using the
     * bands produced by the left-edge pass. Enable if your report is known-right-aligned.
     */
    detectRightAlignedColumns?: boolean;
    /** Minimum items required across all lines for column detection to run. Default 6 — fewer is treated as free-text and returns []. */
    minItems?: number;
    /** Set false to skip the alignment network and use density estimation alone. Default true. */
    useAlignmentNetwork?: boolean;
    /** Points within which two coordinates count as the same alignment. Default 2. */
    alignmentTolerance?: number;
    /** Distinct rows an alignment must span to be believed a column. Default 3. */
    minRowsPerColumn?: number;
}

/**
 * Detect column bands over `lines`. Returns bands sorted left-to-right. When there
 * aren't enough items for a meaningful KDE (below `minItems`), returns [].
 *
 * The bands are HALF-OPEN intervals; a cell at exactly `band.end` belongs to the NEXT
 * column, which matches Crystal/SSRS "cells butt-up against each other" convention.
 */
export function detectColumns(lines: LogicalLine[], opts: ColumnDetectorOptions = {}): ColumnBand[] {
    const minItems = opts.minItems ?? 6;
    const allItems = lines.flatMap((l) => l.items);
    if (allItems.length < minItems) return [];

    // PRIMARY: the alignment network. It asks whether runs line up with each other along both
    // axes, which is what makes a grid a grid. Density over left edges — the fallback below —
    // cannot answer that: it misses right-aligned money columns (no shared left edge), invents a
    // band for a heading wider than its column, fragments a column around one long value, and
    // reads a left-aligned paragraph as a column. Every one of those has cost us a section.
    //
    // An empty result means "this region does not read as a grid", not "there is nothing here",
    // so the density estimator still gets its turn on short or irregular regions.
    if (opts.useAlignmentNetwork !== false) {
        const networked = detectColumnsByAlignment(lines, {
            alignmentTolerance: opts.alignmentTolerance,
            minRowsPerColumn: opts.minRowsPerColumn,
        });
        if (networked.length >= 2) return networked;
    }

    const bandwidth = opts.kdeBandwidth ?? 3;
    const resolution = opts.sampleResolution ?? 400;
    const prominence = opts.peakProminence ?? 1.2;

    const xLeft = allItems.map((it) => it.x);
    const minX = Math.min(...xLeft);
    const maxX = Math.max(...allItems.map((it) => it.x + it.width));

    // Build KDE over left-edges first — this catches left-aligned + numeric-right-aligned
    // columns whose LEFT-edges cluster (numbers of similar magnitude line up on the left).
    const leftPeaks = kdePeaks(xLeft, minX, maxX, bandwidth, resolution, prominence);

    // Optional right-edge KDE (default OFF — see option docstring). When enabled, the
    // estimator `right - medianWidth` is coarse and can double-count columns on tight
    // input; use only when the report is known right-aligned.
    let peaks = leftPeaks;
    if (opts.detectRightAlignedColumns === true) {
        const xRight = allItems.map((it) => it.x + it.width);
        const rightPeaks = kdePeaks(xRight, minX, maxX, bandwidth, resolution, prominence);
        const medianWidth = median(allItems.map((it) => it.width));
        const rightAsLeft = rightPeaks.map((p) => p - medianWidth);
        peaks = mergeAdjacent([...leftPeaks, ...rightAsLeft], bandwidth * 2);
    }

    // Convert peak x-positions into half-open bands.
    // - Column N starts at peaks[N]
    // - Column N ends at peaks[N+1] (or maxX for the last)
    peaks.sort((a, b) => a - b);
    const bands: ColumnBand[] = [];
    for (let i = 0; i < peaks.length; i++) {
        const start = peaks[i];
        const end = i + 1 < peaks.length ? peaks[i + 1] : maxX + 1;
        bands.push({
            start,
            end,
            header: null,
            headerPath: [],
            rightAligned: false,
        });
    }
    return bands;
}

/**
 * Assign each item on `line` to a column band. Returns the same length as
 * `bands`, with `null` when no item fell in that column. When multiple items
 * fall in the same column (e.g. label + value in a single mixed-content cell)
 * they're joined with a single space.
 */
export function assignItemsToColumns(
    line: LogicalLine,
    bands: ColumnBand[],
): (TextItem[] | null)[] {
    const buckets: TextItem[][] = bands.map(() => []);
    for (const item of line.items) {
        const idx = bandIndexForItem(item, bands);
        if (idx >= 0) buckets[idx].push(item);
    }
    return buckets.map((b) => (b.length === 0 ? null : b));
}

/** How close (points) an item's left edge must sit to a band start to count as flush-left in that band. */
const LEFT_EDGE_AFFINITY = 3;

/**
 * Which band does `item` belong to? Resolved by LEFT-EDGE AFFINITY first — a band whose
 * `start` the item's `x` sits flush against — then by largest horizontal overlap, then by
 * centre.
 *
 * Neither rule alone is sufficient on real reports:
 *
 *  - Centre/overlap alone makes a cell's column depend on how LONG its text is. The
 *    issue-name column fragments into several bands, and "Short Name Ltd" then lands in
 *    a different column than "A Considerably Longer Counterparty Name Ltd" even
 *    though the report renders both flush at the same x. Downstream field mapping is
 *    column-indexed, so one logical column scatters across two and the longer rows lose the
 *    value.
 *  - Left-edge alone breaks right-aligned money columns, whose left edge floats with the
 *    magnitude of the number and can start inside the preceding band.
 *
 * Bands begin at KDE peaks over item left-edges, so "flush against a band start" is exactly
 * the signal that a cell is left-aligned in that column. Anything not flush-left is decided
 * by overlap, which is what right-aligned numerics need.
 *
 * Header resolution calls this same function, so a header can never be assigned to a
 * different band than the data underneath it.
 */
export function bandIndexForItem(item: { x: number; width: number }, bands: ColumnBand[]): number {
    if (bands.length === 0) return -1;
    const left = item.x;
    const width = Math.max(item.width, 0);
    const right = left + width;

    let flushIdx = -1;
    let flushDelta = Infinity;
    for (let i = 0; i < bands.length; i++) {
        const delta = Math.abs(left - bands[i].start);
        if (delta <= LEFT_EDGE_AFFINITY && delta < flushDelta) {
            flushDelta = delta;
            flushIdx = i;
        }
    }
    if (flushIdx >= 0) return flushIdx;

    let bestIdx = -1;
    let bestOverlap = 0;
    for (let i = 0; i < bands.length; i++) {
        const overlap = Math.min(right, bands[i].end) - Math.max(left, bands[i].start);
        if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestIdx = i;
        }
    }
    if (bestIdx >= 0) return bestIdx;
    return columnIndexFor(left + width * 0.5, bands);
}

/** Which column band contains `x`? Returns -1 when x falls outside any band. */
export function columnIndexFor(x: number, bands: ColumnBand[]): number {
    for (let i = 0; i < bands.length; i++) {
        if (x >= bands[i].start && x < bands[i].end) return i;
    }
    // Right-edge exact hit → last column (matches "half-open interval on the right").
    if (bands.length > 0 && x <= bands[bands.length - 1].end) return bands.length - 1;
    return -1;
}

// ---------------------------------------------------------------------------
// KDE internals — kept in this file (not exported) so consumers only see the
// column-detection API.
// ---------------------------------------------------------------------------

/**
 * Compute a Gaussian KDE over `values`, sample at `resolution` points across [minX, maxX],
 * and return the x-positions of local maxima whose height exceeds their VALLEY (density
 * at ±bandwidth in sample-space) by at least `prominence` × valley height.
 *
 * WHY BANDWIDTH-WIDE PROMINENCE, NOT IMMEDIATE-NEIGHBOUR
 * ------------------------------------------------------
 * The immediate neighbour of a peak (at ±1 sample step) is very close in value when the
 * sampling resolution is high and the underlying data is a sharp cluster (as happens on
 * pixel-perfect synthetic fixtures — and also on real PDFs where every cell in one
 * column has the exact same x). Using immediate neighbours as the reference makes the
 * prominence test fail on legitimate columns.
 *
 * Comparing against density at ±bandwidth (roughly one standard deviation away for a
 * Gaussian kernel) is the natural check: a real column-peak drops to ≈ 60% of its peak
 * by ±bandwidth, easily passing prominence ≥ 1.2. Noise bumps don't get anywhere near
 * that drop-off.
 */
function kdePeaks(
    values: number[],
    minX: number,
    maxX: number,
    bandwidth: number,
    resolution: number,
    prominence: number,
): number[] {
    if (values.length === 0 || maxX <= minX) return [];
    // Pad the sampling range by 3 bandwidths on each side so peaks near the data edges
    // still have windowSamples worth of valley samples on both sides. Without padding,
    // a column at exactly minX would fall inside the [0, windowSamples) skipped band.
    const pad = bandwidth * 3;
    const paddedMinX = minX - pad;
    const paddedMaxX = maxX + pad;
    const step = (paddedMaxX - paddedMinX) / resolution;
    const density = new Float64Array(resolution + 1);
    const norm = 1 / (values.length * bandwidth * Math.sqrt(2 * Math.PI));
    for (let i = 0; i <= resolution; i++) {
        const x = paddedMinX + i * step;
        let sum = 0;
        for (let j = 0; j < values.length; j++) {
            const z = (x - values[j]) / bandwidth;
            sum += Math.exp(-0.5 * z * z);
        }
        density[i] = sum * norm;
    }
    // Absolute-density floor: gate peaks to those above the mean density. Filters out
    // noise bumps in sparse regions where every point is small.
    let mean = 0;
    for (let i = 0; i <= resolution; i++) mean += density[i];
    mean /= resolution + 1;

    // Window = TWO bandwidths in sample-space (Gaussian drops to ~14% of peak by then, so
    // a real peak's prominence ratio is ~7x, easy to distinguish from noise). One bandwidth
    // proved borderline on synthetic pixel-perfect fixtures — the ratio landed around 1.15
    // which is under the 1.2 threshold. Never less than 1 sample.
    const windowSamples = Math.max(1, Math.round((bandwidth * 2) / step));

    const peaks: number[] = [];
    for (let i = windowSamples; i <= resolution - windowSamples; i++) {
        const c = density[i];
        if (c < mean) continue;
        // Local-max check within ±windowSamples. Asymmetric comparison (strict `>` on left,
        // `>=` on right) so that when a smooth Gaussian's peak falls between samples and
        // two adjacent samples share the same peak value, exactly ONE of them wins — the
        // rightmost point of the plateau. Deterministic, no double-counting.
        let isMax = true;
        for (let d = 1; d <= windowSamples; d++) {
            if (density[i - d] > c || density[i + d] >= c) {
                isMax = false;
                break;
            }
        }
        if (!isMax) continue;
        // Prominence: compare to the density at the ±windowSamples valley — the larger of
        // the two so we don't call something a peak that's just riding down a slope.
        const valley = Math.max(density[i - windowSamples], density[i + windowSamples]);
        // Guard against zero-valley (padded edge with no data) — treat as pass since
        // there's nothing to reject against.
        if (valley === 0 || c / valley >= prominence) {
            peaks.push(paddedMinX + i * step);
        }
    }
    return peaks;
}

/** Merge peaks within `tolerance` of each other, keeping the mean position. */
function mergeAdjacent(values: number[], tolerance: number): number[] {
    if (values.length === 0) return [];
    const sorted = [...values].sort((a, b) => a - b);
    const merged: number[] = [];
    let cluster = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] - cluster[cluster.length - 1] <= tolerance) {
            cluster.push(sorted[i]);
        } else {
            merged.push(cluster.reduce((s, v) => s + v, 0) / cluster.length);
            cluster = [sorted[i]];
        }
    }
    merged.push(cluster.reduce((s, v) => s + v, 0) / cluster.length);
    return merged;
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
