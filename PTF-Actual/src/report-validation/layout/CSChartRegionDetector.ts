/**
 * CS Report Validation — Layer 2.8: Chart region detection.
 *
 * Bar/line charts in Crystal + SSRS reports render as embedded images
 * with a spray of TINY text labels around them (axis labels, series
 * legends, data labels like "4.35%"). Left in place, those labels
 * corrupt column detection — the KDE picks up spurious peaks at chart
 * label positions.
 *
 * HEURISTIC (deliberate — no image decoding needed):
 *
 * A chart region is characterised by
 *   - Many SMALL-font text items clustered together
 *   - Non-tabular layout (items don't align to a grid — high x-variance
 *     within a narrow y-band)
 *   - A CAPTION text just above, usually all-caps or title-cased
 *
 * We compute per-region density (items per square inch) and font
 * homogeneity (all small, all similar size). Regions above a density
 * threshold + below a font-size threshold + with a plausible caption
 * are flagged as charts. The originating text items are removed from
 * the body pass so table extraction ignores them.
 *
 * Pages that contain ONLY charts (a graphical summary page, for instance)
 * return their entire body as chart regions — no false-positive tables
 * get extracted.
 *
 * @module report-validation/layout/CSChartRegionDetector
 */

import type { BoundingBox, ChartRegion, PageContent, TextItem } from '../CSReportPdfTypes';

export interface ChartRegionDetectorOptions {
    /** Max font size (points) for a text item to count as a "chart label". Default 8 — reports use 7-8pt for chart labels vs 10-12pt for table cells. */
    maxChartLabelFontSize?: number;
    /** Minimum items per square inch inside a region for it to qualify as chart-like. Default 5. */
    minItemsPerSquareInch?: number;
    /** Minimum items required inside a region — below this, treat as free text. Default 8. */
    minItemsInRegion?: number;
    /** Font size (points) below which we count as "chart label"; larger items in the region are captions. Default 8. */
    captionFontSize?: number;
    /** Minimum y-bands (rows) a cluster must have before the grid-alignment veto can fire. Default 4. */
    minTabularRows?: number;
    /** Minimum aligned columns a cluster must show to be vetoed as a table. Default 3. */
    minTabularColumns?: number;
    /** Fraction of rows an x-edge must appear in to count as an aligned column. Default 0.6. */
    tabularColumnCoverage?: number;
    /** Tolerance (points) for treating two x-edges as the same column. Default 3. */
    tabularEdgeTolerance?: number;
}

/**
 * Detect chart regions on a single page. Returns them sorted top-to-bottom (highest y
 * first, PDF Y grows upward → highest = topmost). The `itemsInside` array is kept for
 * evidence + debugging; callers filter these out of body items before layout analysis.
 */
export function detectChartRegions(
    page: PageContent,
    opts: ChartRegionDetectorOptions = {},
): ChartRegion[] {
    if (page.textItems.length === 0) return [];
    const maxLabelFont = opts.maxChartLabelFontSize ?? 8;
    const minDensity = opts.minItemsPerSquareInch ?? 5;
    const minItems = opts.minItemsInRegion ?? 8;
    const captionFont = opts.captionFontSize ?? 8;

    // Gather small-font items — these are the chart labels.
    const smallItems = page.textItems.filter((it) => it.fontSize <= maxLabelFont);
    if (smallItems.length < minItems) return [];

    // Cluster small items into spatial regions via a naïve union-find over "any two items
    // whose bounding boxes are within `mergeDistance` points". Good enough for chart
    // detection at typical report resolution.
    const mergeDistance = 30; // points ≈ 0.4 inch
    const clusters = spatialCluster(smallItems, mergeDistance);

    // Convert each qualifying cluster to a ChartRegion.
    const regions: ChartRegion[] = [];
    for (const cluster of clusters) {
        if (cluster.length < minItems) continue;
        const box = boundingBox(cluster);
        const area = ((box.x2 - box.x1) / 72) * ((box.y2 - box.y1) / 72); // sq inch
        if (area <= 0) continue;
        const density = cluster.length / area;
        if (density < minDensity) continue;
        // GRID VETO — a dense small-font cluster that aligns to a column grid is a TABLE,
        // not a chart. Reports that render their detail tables at 7-8pt (SSRS and Crystal
        // both do) otherwise trip every density check above and get their entire data
        // table deleted before column detection ever runs. Charts scatter their labels;
        // tables repeat the same x-edges down every row.
        if (looksTabular(cluster, opts)) continue;
        // Find caption: a slightly-larger text item just above the region.
        const caption = findCaption(page.textItems, box, captionFont);
        // Confidence heuristic: higher density + presence of caption + font homogeneity.
        const fontSizes = cluster.map((c) => c.fontSize);
        const fontStd = std(fontSizes);
        const fontHomogeneity = 1 / (1 + fontStd);
        const captionBoost = caption ? 0.2 : 0;
        const rawConfidence = 0.5 + Math.min(density / 20, 0.3) + captionBoost + fontHomogeneity * 0.1;
        const confidence = Math.min(1, rawConfidence);
        regions.push({
            pageNumber: page.pageNumber,
            box,
            itemsInside: cluster,
            confidence,
            caption,
        });
    }
    // Sort top-to-bottom.
    regions.sort((a, b) => b.box.y2 - a.box.y2);
    return regions;
}

/**
 * Remove every item that falls inside any chart region from `items`. Useful for the
 * layout analyzer's body pass — feeds table detection the item set MINUS chart labels.
 */
export function removeChartItems(items: TextItem[], regions: ChartRegion[]): TextItem[] {
    if (regions.length === 0) return items;
    return items.filter((item) => !insideAnyRegion(item, regions));
}

function insideAnyRegion(item: TextItem, regions: ChartRegion[]): boolean {
    const cx = item.x + item.width * 0.5;
    const cy = item.y + item.height * 0.5;
    for (const region of regions) {
        if (cx >= region.box.x1 && cx <= region.box.x2 && cy >= region.box.y1 && cy <= region.box.y2) {
            return true;
        }
    }
    return false;
}

// ---- helpers -------------------------------------------------------------

/**
 * Grid-alignment test — the "non-tabular layout" half of the documented heuristic.
 *
 * Groups the cluster into y-bands (rows), then looks for x-edges that REPEAT down those
 * rows. A table's cells share left edges (text/left-aligned columns) or right edges
 * (right-aligned numeric columns), so a handful of edge positions cover most rows. Chart
 * labels sit wherever their data point lands, so no edge repeats.
 *
 * Both edges are measured because report tables mix alignments — a name column is
 * left-aligned while an amount column is right-aligned, and only one edge of each is stable.
 */
function looksTabular(cluster: TextItem[], opts: ChartRegionDetectorOptions): boolean {
    const minRows = opts.minTabularRows ?? 4;
    const minColumns = opts.minTabularColumns ?? 3;
    const coverage = opts.tabularColumnCoverage ?? 0.6;
    const tolerance = opts.tabularEdgeTolerance ?? 3;

    const rows = groupIntoRows(cluster);
    if (rows.length < minRows) return false;

    // Bucket every left and right edge by row, so one row can't inflate a bucket by
    // contributing several items at the same x.
    const leftEdges = new Map<number, Set<number>>();
    const rightEdges = new Map<number, Set<number>>();
    for (let r = 0; r < rows.length; r++) {
        for (const item of rows[r]) {
            addEdge(leftEdges, item.x, r, tolerance);
            addEdge(rightEdges, item.x + item.width, r, tolerance);
        }
    }

    const required = Math.ceil(rows.length * coverage);
    const alignedLeft = countAlignedEdges(leftEdges, required);
    const alignedRight = countAlignedEdges(rightEdges, required);
    return Math.max(alignedLeft, alignedRight) >= minColumns;
}

/** Cluster items into y-bands. Tolerance is 60% of the median item height — same intuition as the line clusterer, kept local so the detector stays dependency-free. */
function groupIntoRows(items: TextItem[]): TextItem[][] {
    const heights = items.map((i) => i.height).filter((h) => h > 0);
    const tolerance = (heights.length > 0 ? medianOf(heights) : 8) * 0.6;
    const sorted = [...items].sort((a, b) => b.y - a.y);
    const rows: TextItem[][] = [];
    let current: TextItem[] = [];
    let anchor = Number.NaN;
    for (const item of sorted) {
        if (current.length === 0 || Math.abs(item.y - anchor) <= tolerance) {
            if (current.length === 0) anchor = item.y;
            current.push(item);
            continue;
        }
        rows.push(current);
        current = [item];
        anchor = item.y;
    }
    if (current.length > 0) rows.push(current);
    return rows;
}

/** Record that row `rowIndex` has an edge at `edge`, snapping onto an existing bucket within `tolerance`. */
function addEdge(buckets: Map<number, Set<number>>, edge: number, rowIndex: number, tolerance: number): void {
    for (const [key, rowsAtKey] of buckets) {
        if (Math.abs(key - edge) <= tolerance) {
            rowsAtKey.add(rowIndex);
            return;
        }
    }
    buckets.set(edge, new Set([rowIndex]));
}

/** How many edge buckets are shared by at least `required` distinct rows. */
function countAlignedEdges(buckets: Map<number, Set<number>>, required: number): number {
    let count = 0;
    for (const rowsAtKey of buckets.values()) {
        if (rowsAtKey.size >= required) count++;
    }
    return count;
}

function medianOf(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Naïve spatial clustering — union-find over item bounding boxes with `mergeDistance`
 * tolerance. Runs in O(n²) worst case; that's fine for page-scale item counts (few
 * hundred at most).
 */
function spatialCluster(items: TextItem[], mergeDistance: number): TextItem[][] {
    const n = items.length;
    const parent = new Array(n).fill(0).map((_, i) => i);
    const find = (x: number): number => {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    };
    const union = (a: number, b: number) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[rb] = ra;
    };
    // Precompute bounding boxes.
    const boxes = items.map((it) => ({
        x1: it.x,
        y1: it.y,
        x2: it.x + it.width,
        y2: it.y + it.height,
    }));
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (boxDistance(boxes[i], boxes[j]) <= mergeDistance) union(i, j);
        }
    }
    const buckets = new Map<number, TextItem[]>();
    for (let i = 0; i < n; i++) {
        const r = find(i);
        let arr = buckets.get(r);
        if (!arr) {
            arr = [];
            buckets.set(r, arr);
        }
        arr.push(items[i]);
    }
    return Array.from(buckets.values());
}

function boxDistance(a: BoundingBox, b: BoundingBox): number {
    const dx = Math.max(0, Math.max(a.x1 - b.x2, b.x1 - a.x2));
    const dy = Math.max(0, Math.max(a.y1 - b.y2, b.y1 - a.y2));
    return Math.hypot(dx, dy);
}

function boundingBox(items: TextItem[]): BoundingBox {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const it of items) {
        if (it.x < x1) x1 = it.x;
        if (it.y < y1) y1 = it.y;
        if (it.x + it.width > x2) x2 = it.x + it.width;
        if (it.y + it.height > y2) y2 = it.y + it.height;
    }
    return { x1, y1, x2, y2 };
}

/**
 * Find a plausible chart caption above `box`. Looks for the first text item that:
 *   - sits in the horizontal x-span of the box (allowing 20pt slack)
 *   - is within 40pt above the top of the box
 *   - has a font size larger than typical chart labels
 */
function findCaption(allItems: TextItem[], box: BoundingBox, captionFont: number): string | undefined {
    const slackX = 20;
    const slackY = 40;
    let best: TextItem | null = null;
    for (const item of allItems) {
        if (item.fontSize <= captionFont) continue;
        const cx = item.x + item.width * 0.5;
        if (cx < box.x1 - slackX || cx > box.x2 + slackX) continue;
        // Caption is ABOVE the region → its y is HIGHER (PDF Y grows up).
        if (item.y < box.y2 || item.y > box.y2 + slackY) continue;
        if (!best || item.y < best.y) best = item; // pick the closest above
    }
    return best?.str.trim();
}

function std(values: number[]): number {
    if (values.length <= 1) return 0;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length;
    return Math.sqrt(variance);
}
