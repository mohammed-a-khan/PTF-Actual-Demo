/**
 * CS Report Validation — Layer 2.1: Line clustering.
 *
 * Groups `TextItem[]` on a page into `LogicalLine[]` by y-coordinate. Two
 * items belong to the same line when their baselines differ by less than
 * `fontSize * lineToleranceRatio` — a font-size-relative tolerance so
 * small (footer) text and large (title) text both cluster correctly
 * without hand-tuning per report.
 *
 * The output is sorted TOP-TO-BOTTOM in reading order. PDF coordinates
 * have Y growing upward from the page bottom, so "top" = highest y — we
 * reverse-sort by y and left-to-right by x within each line.
 *
 * Every line carries `isHeader` (font ≥ 1.2× median) and `isEmphasized`
 * (all-caps text) flags — downstream section-detection and table-header
 * resolution both use these signals.
 *
 * @module report-validation/layout/CSLineClusterer
 */

import type { LogicalLine, TextItem } from '../CSReportPdfTypes';

export interface LineClusterOptions {
    /** Multiplier of item font size used as the y-tolerance. Default 0.4 — captures italic slant + subpixel drift. */
    lineToleranceRatio?: number;
    /** Font-size ratio for `isHeader` classification. Default 1.2 = 20% larger than page median. */
    headerFontRatio?: number;
}

/**
 * Cluster a page's text items into logical lines, top-to-bottom in reading order.
 * Empty input returns an empty array (never throws).
 */
export function clusterLines(items: TextItem[], opts: LineClusterOptions = {}): LogicalLine[] {
    if (items.length === 0) return [];
    const tolRatio = opts.lineToleranceRatio ?? 0.4;
    const headerRatio = opts.headerFontRatio ?? 1.2;

    // Only cluster horizontal text (rotation ≈ 0 or 180). Rotated column labels get their
    // own cluster path via `clusterRotatedItems` in the column detector; mixing them here
    // would confuse the y-clustering.
    const horizontal = items.filter((it) => it.rotation === 0 || it.rotation === 180);
    if (horizontal.length === 0) return [];

    const medianFontSize = median(horizontal.map((i) => i.fontSize));

    // Sort by y descending (PDF Y grows up → highest y = top of page).
    const sorted = [...horizontal].sort((a, b) => b.y - a.y);

    // Sweep top-to-bottom. Start a new line when the y gap exceeds the current line's
    // tolerance. The tolerance is derived from the CURRENT line's max font size, so a
    // 6pt footer and a 14pt title both cluster correctly without hand-tuning.
    const lines: LogicalLine[] = [];
    let currentLineItems: TextItem[] = [sorted[0]];
    let currentLineMaxFont = sorted[0].fontSize;
    let currentLineY = sorted[0].y;

    for (let i = 1; i < sorted.length; i++) {
        const it = sorted[i];
        const tolerance = Math.max(currentLineMaxFont * tolRatio, 1); // never below 1pt so tiny-font pages still cluster
        if (Math.abs(it.y - currentLineY) <= tolerance) {
            currentLineItems.push(it);
            if (it.fontSize > currentLineMaxFont) currentLineMaxFont = it.fontSize;
            continue;
        }
        lines.push(finaliseLine(currentLineItems, medianFontSize, headerRatio));
        currentLineItems = [it];
        currentLineMaxFont = it.fontSize;
        currentLineY = it.y;
    }
    lines.push(finaliseLine(currentLineItems, medianFontSize, headerRatio));
    return lines;
}

/** Sort line items left-to-right, compute median baseline, tag header/emphasis flags. */
function finaliseLine(
    items: TextItem[],
    medianFontSize: number,
    headerFontRatio: number,
): LogicalLine {
    const sortedByX = [...items].sort((a, b) => a.x - b.x);
    const y = median(sortedByX.map((i) => i.y));
    const height = Math.max(...sortedByX.map((i) => i.height));
    const maxItemFont = Math.max(...sortedByX.map((i) => i.fontSize));
    const isHeader = medianFontSize > 0 && maxItemFont >= medianFontSize * headerFontRatio;
    const joined = sortedByX
        .map((i) => i.str)
        .join(' ')
        .trim();
    // "Emphasized" = bold-font OR true-all-caps line. All-caps detection must reject
    // data rows that happen to contain acronyms + numbers (e.g. "MIDO 2014-2A A 250.00"
    // where the alpha chars alone are all-caps but the majority of the line is numbers).
    // A section-header line like "COVERAGE TEST SUMMARY" has letters as ≥ 50% of its
    // non-whitespace content; a data row rarely does.
    const nonSpace = joined.replace(/\s+/g, '');
    const letters = nonSpace.replace(/[^A-Za-z]/g, '');
    const hasLower = /[a-z]/.test(joined);
    const lettersFraction = nonSpace.length > 0 ? letters.length / nonSpace.length : 0;
    const isAllCaps = !hasLower && letters.length >= 4 && lettersFraction >= 0.5;
    const isBoldFont = sortedByX.some((it) => /bold|black|heavy/i.test(it.fontName));
    return {
        y,
        height,
        items: sortedByX,
        isHeader,
        isEmphasized: isAllCaps || isBoldFont,
    };
}

/** Median of a numeric array. Empty input → 0. */
function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Fewest lines a section needs before a stagger can be established at all. */
const MIN_STAGGER_LINES = 4;
/** Fewest lines below the headings that must show the offset before it is believed. */
const MIN_STAGGER_RUN = 3;

/**
 * Repair a grid whose right-hand columns were printed one row out of step with its left-hand
 * ones.
 *
 * Some report writers emit such a grid as two column groups on separate baselines, the right
 * group sitting a row higher. Clustering by y then cuts every logical row diagonally: the first
 * line carries only the right group's HEADINGS, the next pairs the left group's headings with
 * the first row's right-hand values, and so on down the table. The left-hand headings therefore
 * never become column headings — they arrive as a data row — and every figure is read against
 * its neighbouring row, so a total lands on the last detail row.
 *
 * Detection is deliberately narrow, because an ordinary table must never be touched. It needs
 * two ADJACENT heading lines, neither carrying a figure, whose columns are not merely distinct
 * but SEPARATED: the upper line must begin to the right of where the lower one ends. A heading
 * wrapped over several lines fails that test — its lines span the same columns and interleave —
 * which is what keeps this away from the multi-row headers that are far more common. The offset
 * must then hold for several lines below before it is acted on.
 *
 * Returns the input unchanged when no stagger is found.
 */
export function repairStaggeredColumns(lines: LogicalLine[], opts: LineClusterOptions = {}): LogicalLine[] {
    if (lines.length < MIN_STAGGER_LINES) return lines;
    const ordered = [...lines].sort((a, b) => b.y - a.y);
    // The heading pair can sit below a preamble, so scan for it rather than assuming it is first.
    for (let i = 0; i < ordered.length - MIN_STAGGER_RUN; i++) {
        const splitX = splitPointBetweenHeadings(ordered[i], ordered[i + 1]);
        if (splitX === null) continue;
        if (staggerRunLength(ordered, i, splitX) < MIN_STAGGER_RUN) continue;
        return restagger(ordered, i, splitX, opts);
    }
    return lines;
}

/** Every run on a line that carries text, left to right. */
function inkedRuns(line: LogicalLine): TextItem[] {
    return (line.items ?? [])
        .filter((it) => (it.str ?? '').trim().length > 0)
        .sort((a, b) => a.x - b.x);
}

/**
 * If these two lines are the two halves of one heading row, the x separating them; else null.
 *
 * The upper line is the right-hand half: labels only, no figures. The lower line carries the
 * left-hand half — also labels — and, precisely BECAUSE the grid is staggered, the first row's
 * right-hand values sitting beside them. Those values are what separate this from a heading
 * merely wrapped onto a second line: a wrapped heading's second line carries more labels, so
 * there are no figures to the right of the split and nothing is repaired. That test is what
 * keeps this away from the multi-row headers that are far more common than any stagger.
 */
function splitPointBetweenHeadings(upper: LogicalLine, lower: LogicalLine): number | null {
    const upperRuns = inkedRuns(upper);
    const lowerRuns = inkedRuns(lower);
    if (upperRuns.length < 2 || lowerRuns.length < 2) return null;
    if (upperRuns.some((it) => /\d/.test(it.str))) return null;
    const upperLeft = Math.min(...upperRuns.map((it) => it.x));
    const rightEdge = (it: TextItem): number => it.x + Math.max(it.width, 0);

    const leftHalf = lowerRuns.filter((it) => rightEdge(it) <= upperLeft);
    if (leftHalf.length < 2) return null;
    if (leftHalf.some((it) => /\d/.test(it.str))) return null;

    const besideIt = lowerRuns.filter((it) => rightEdge(it) > upperLeft);
    if (!besideIt.some((it) => /\d/.test(it.str))) return null;

    const leftHalfRight = Math.max(...leftHalf.map(rightEdge));
    return (leftHalfRight + upperLeft) / 2;
}

/** How many lines below `start` carry cells on both sides of `splitX`. */
function staggerRunLength(ordered: LogicalLine[], start: number, splitX: number): number {
    let run = 0;
    for (let i = start + 1; i < ordered.length; i++) {
        const runs = inkedRuns(ordered[i]);
        const left = runs.some((it) => it.x + Math.max(it.width, 0) / 2 < splitX);
        const right = runs.some((it) => it.x + Math.max(it.width, 0) / 2 >= splitX);
        if (!left || !right) break;
        run++;
    }
    return run;
}

/**
 * Pair the right group of each line with the left group of the line BELOW it, which is the row
 * they were printed for. Lines above `start` are left exactly as they were.
 */
function restagger(
    ordered: LogicalLine[],
    start: number,
    splitX: number,
    opts: LineClusterOptions,
): LogicalLine[] {
    const sideOf = (line: LogicalLine, right: boolean): TextItem[] =>
        inkedRuns(line).filter((it) => {
            const mid = it.x + Math.max(it.width, 0) / 2;
            return right ? mid >= splitX : mid < splitX;
        });
    const medianFont = median(ordered.flatMap((l) => (l.items ?? []).map((it) => it.fontSize)));
    const headerRatio = opts.headerFontRatio ?? 1.2;
    const repaired: LogicalLine[] = ordered.slice(0, start);
    for (let i = start; i < ordered.length; i++) {
        const right = sideOf(ordered[i], true);
        const left = i + 1 < ordered.length ? sideOf(ordered[i + 1], false) : [];
        const items = [...left, ...right];
        if (items.length === 0) continue;
        repaired.push(finaliseLine(items, medianFont, headerRatio));
    }
    return repaired;
}
