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
