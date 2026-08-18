/**
 * CS Report Validation — Layer 2 orchestrator.
 *
 * Composes every Layer-2 submodule (line clusterer, chart detector,
 * column detector, section detector, table header resolver, cell
 * stitcher, total-row tagger, TOC extractor, page segmenter) into the
 * full extraction pipeline. Input: raw `PageContent[]` from Layer 1
 * (`CSReportPdfExtractor`). Output: `AnalyzedReport` — sections merged
 * across pages, chrome stripped, tables normalized, checksums tagged.
 *
 * PIPELINE
 * --------
 *   1. TOC extraction  — pull `Deal Summary → 2` style entries as ground truth
 *   2. Page segmentation — strip repeating header/footer chrome
 *   3. Per-page loop:
 *      a. Chart region detection → drop chart-label items
 *      b. Line clustering
 *      c. Section header detection (voting)
 *      d. Per-section:
 *         - Column detection over remaining lines
 *         - Table header resolution (multi-level flatten)
 *         - Lines → TableRows via column assignment
 *         - Group-header tagging (bold + single filled column)
 *         - Total-row tagging
 *         - Multi-line cell stitching
 *   4. Cross-page section merging (same title + matching band skeleton
 *      = same section continued)
 *
 * Every step is defensive: missing data (empty page, no sections, no
 * columns) degrades gracefully to an empty result rather than throwing.
 *
 * @module report-validation/CSReportPdfLayoutAnalyzer
 */

import type {
    AnalyzedPage,
    AnalyzedReport,
    AnalyzedSection,
    ColumnBand,
    LayoutAnalyzerOptions,
    LogicalLine,
    PageContent,
    TableRow,
    TextItem,
} from './CSReportPdfTypes';
import { detectChartRegions, removeChartItems } from './layout/CSChartRegionDetector';
import {
    linesToTableRows,
    shouldMergeAcrossPages,
    stitchMultiLineCells,
    extractGroupLabelIfHeader,
} from './layout/CSCellStitcher';
import { detectColumns } from './layout/CSColumnDetector';
import { clusterLines } from './layout/CSLineClusterer';
import { segmentPages } from './layout/CSPageSegmenter';
import { detectSectionHeaders, type SectionHeaderCandidate } from './layout/CSSectionDetector';
import { resolveTableHeaders } from './layout/CSTableHeaderResolver';
import { tagTotalRows } from './layout/CSTotalRowTagger';
import { extractToc } from './layout/CSTocExtractor';

/**
 * Full Layer-2 analysis. Given the raw pages from Layer 1, returns an `AnalyzedReport`
 * with everything the Phase-C section mapper needs.
 */
export function analyzeReport(pages: PageContent[], opts: LayoutAnalyzerOptions = {}): AnalyzedReport {
    if (pages.length === 0) {
        return { pageCount: 0, pages: [], toc: [], mergedSections: [] };
    }

    // 1. TOC first — needed before per-page loop so its ground truth is available for
    //    downstream verification. (Layer-2 output doesn't currently use TOC; it's here
    //    so Phase C's section mapper can cross-check without re-extracting.)
    const toc = extractToc(pages);

    // 2. Page-level chrome removal.
    const segmented = segmentPages(pages);

    // 3. Per-page analysis.
    const analyzedPages: AnalyzedPage[] = [];
    for (let p = 0; p < segmented.length; p++) {
        const seg = segmented[p];
        const pageContent = pages[p];
        analyzedPages.push(analyzeOnePage(pageContent, seg.bodyItems, seg.headerItems, seg.footerItems, opts));
    }

    // 4. Cross-page section merging.
    const mergedSections = mergeCrossPageSections(analyzedPages, opts);

    return {
        pageCount: pages.length,
        pages: analyzedPages,
        toc,
        mergedSections,
    };
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

function analyzeOnePage(
    original: PageContent,
    bodyItems: TextItem[],
    headerItems: TextItem[],
    footerItems: TextItem[],
    opts: LayoutAnalyzerOptions,
): AnalyzedPage {
    const pageNumber = original.pageNumber;
    const header = headerItems.map((i) => i.str).filter((s) => s.trim().length > 0);
    const footer = footerItems.map((i) => i.str).filter((s) => s.trim().length > 0);

    if (bodyItems.length === 0) {
        return { pageNumber, header, footer, sections: [], residualText: [] };
    }

    // 3a. Chart detection over the body items, then remove chart items.
    // We scope the detector to a page-content-shaped input so it can compute regions.
    const chartRegions = detectChartRegions({
        pageNumber,
        width: original.width,
        height: original.height,
        textItems: bodyItems,
    });
    const nonChartItems = removeChartItems(bodyItems, chartRegions);

    // 3b. Line clustering over non-chart items.
    const lines = clusterLines(nonChartItems, {
        lineToleranceRatio: opts.lineToleranceRatio,
    });
    if (lines.length === 0) {
        return {
            pageNumber,
            header,
            footer,
            sections: [
                emptySectionWithCharts(pageNumber, chartRegions),
            ].filter((s): s is AnalyzedSection => s.charts.length > 0),
            residualText: [],
        };
    }

    // 3c. Section headers — vote across font, shape, regex.
    const sectionCandidates = detectSectionHeaders(lines, {
        sectionHeaderFontRatio: opts.sectionHeaderFontRatio,
        sectionHeaderRegexes: opts.sectionHeaderRegexes,
    });
    const fullSectionHeaders = sectionCandidates.filter((c) => c.isFullSectionHeader);

    // If no section header was found, treat the whole page as one anonymous section so
    // downstream code has SOMETHING to hand to the mapper. Layer-3 will decide whether
    // to skip it based on spec.requiredSections.
    if (fullSectionHeaders.length === 0) {
        const section = analyzeSectionRegion(
            pageNumber,
            '(anonymous)',
            median(lines.map((l) => l.y)),
            lines,
            chartRegions,
            opts,
        );
        return {
            pageNumber,
            header,
            footer,
            sections: [section],
            residualText: [],
        };
    }

    // Assign every line to whichever section header sits above it (by y-coordinate in
    // reading order). PDF Y grows upward → a line "below" a header has SMALLER y.
    // Sort headers top-to-bottom (highest y first).
    const headersTopDown = [...fullSectionHeaders].sort((a, b) => b.line.y - a.line.y);
    const sections: AnalyzedSection[] = [];
    for (let hi = 0; hi < headersTopDown.length; hi++) {
        const header = headersTopDown[hi];
        const nextHeader = headersTopDown[hi + 1];
        const sectionLines = lines.filter((l) => {
            if (l === header.line) return false;
            // Line belongs to this section if y is BELOW header AND ABOVE next header (or page bottom).
            const below = l.y < header.line.y;
            const above = nextHeader ? l.y > nextHeader.line.y : true;
            return below && above;
        });
        // Charts inside this section's y range.
        const sectionCharts = chartRegions.filter((c) => {
            const midY = (c.box.y1 + c.box.y2) / 2;
            const below = midY < header.line.y;
            const above = nextHeader ? midY > nextHeader.line.y : true;
            return below && above;
        });
        sections.push(
            analyzeSectionRegion(pageNumber, header.title, header.line.y, sectionLines, sectionCharts, opts, sectionCandidates),
        );
    }

    return {
        pageNumber,
        header,
        footer,
        sections,
        residualText: [],
    };
}

/**
 * Analyze the lines belonging to one section on one page. Detects columns, resolves
 * multi-level headers, converts lines to rows, tags group headers + totals, then stitches
 * multi-line cells.
 */
function analyzeSectionRegion(
    pageNumber: number,
    title: string,
    titleY: number,
    lines: LogicalLine[],
    charts: import('./CSReportPdfTypes').ChartRegion[],
    opts: LayoutAnalyzerOptions,
    allCandidates?: SectionHeaderCandidate[],
): AnalyzedSection {
    if (lines.length === 0) {
        return {
            title,
            titleY,
            tableRows: [],
            columns: [],
            freeText: [],
            charts,
            spansToNextPage: false,
            startPage: pageNumber,
        };
    }

    // Column detection over ALL lines in the section. If it returns [] we have no
    // tabular content — everything is free text.
    const columns = detectColumns(lines, {
        kdeBandwidth: opts.columnKdeBandwidth,
    });

    if (columns.length === 0) {
        return {
            title,
            titleY,
            tableRows: [],
            columns: [],
            freeText: lines.map((l) => l.items.map((i) => i.str).join(' ').trim()),
            charts,
            spansToNextPage: false,
            startPage: pageNumber,
        };
    }

    // Header row detection: the first 1-2 lines under the title that satisfy either
    // the section-detector's "shape" signal (bold/all-caps) OR whose items span all the
    // detected column bands. Below the header rows, the remaining lines are data.
    const { headerRows, dataLines } = splitHeaderAndData(lines, columns);
    resolveTableHeaders(columns, headerRows);

    // Data lines → TableRows.
    let rows = linesToTableRows(dataLines, columns);

    // Right-aligned numeric columns routinely split into TWO bands — the header label
    // occupies one x-range and the values another — which leaves the header on an empty
    // band and the data on an unheaded one. Downstream field mapping is header-driven, so
    // that split silently drops the column. Re-home those headers onto the band that
    // actually carries the values.
    realignHeadersOntoDataBands(columns, rows);

    // Group-header tagging: single-filled-column + bold styling ⇒ group sub-header.
    for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri];
        // Find the backing items for this row so we can inspect bold styling.
        const backingLine = dataLines.find((l) => Math.abs(l.y - row.y) < 1);
        if (!backingLine) continue;
        const label = extractGroupLabelIfHeader(row, backingLine.items);
        if (label) {
            row.isGroupHeader = true;
            row.groupLabel = label;
        }
    }

    // Propagate group labels downward — every subsequent data row inherits the most
    // recent groupLabel until another group header appears.
    let currentGroup: string | null = null;
    for (const row of rows) {
        if (row.isGroupHeader) {
            currentGroup = row.groupLabel;
        } else {
            row.groupLabel = currentGroup;
        }
    }

    // Totals tagging.
    tagTotalRows(rows);

    // Multi-line cell stitching.
    if (opts.stitchMultiLineCells !== false) {
        rows = stitchMultiLineCells(rows);
    }

    // Reindex after stitching so rowIndex reflects the final visible order.
    rows.forEach((r, i) => (r.rowIndex = i + 1));

    return {
        title,
        titleY,
        tableRows: rows,
        columns,
        freeText: [],
        charts,
        // spansToNextPage: decided during cross-page merging.
        spansToNextPage: false,
        startPage: pageNumber,
    };
}

/**
 * Split the section's lines into (headerRows, dataLines). A line qualifies as a header
 * row when EITHER:
 *   - it's emphasized (bold/all-caps) AND has ≥ column-count/2 items, OR
 *   - it's the first line and every item center falls into a column band
 *
 * The "top 1-2 lines" heuristic handles both single-row and two-row headers. A section
 * with no headers (rare — Investor Notification paragraph pages, etc.) returns an empty
 * headerRows.
 */
function splitHeaderAndData(
    lines: LogicalLine[],
    columns: ColumnBand[],
): { headerRows: LogicalLine[]; dataLines: LogicalLine[] } {
    if (lines.length === 0 || columns.length === 0) return { headerRows: [], dataLines: lines };
    // Top-to-bottom.
    const topDown = [...lines].sort((a, b) => b.y - a.y);
    const headerRows: LogicalLine[] = [];
    // First line: header if EMPHASIZED (bold / all-caps / large font). A plain data row
    // with items in every column would otherwise get miscategorised. We deliberately
    // do NOT accept "spans most columns" as a header signal on its own — that's what
    // regular data rows look like.
    if (topDown.length > 0) {
        const first = topDown[0];
        if (first.isEmphasized || first.isHeader || usesDifferentFontFromBody(first, topDown.slice(1))) {
            headerRows.push(first);
        }
    }
    // Second line: header only if emphasized. This picks up the sub-column row in a
    // two-row header (`Original Rating` spanner / `Moody's | S&P` sub-columns) where the
    // second row is usually bold too. Never absorbs a plain data row.
    if (headerRows.length === 1 && topDown.length > 1) {
        const second = topDown[1];
        if (second.isEmphasized || second.isHeader || usesDifferentFontFromBody(second, topDown.slice(2))) {
            headerRows.push(second);
        }
    }
    const dataLines = topDown.slice(headerRows.length);
    return { headerRows, dataLines };
}

/**
 * Move a header off an empty band onto the adjacent band that holds its values.
 *
 * The KDE column detector works on x-positions, so a right-aligned money column whose
 * header label sits further left than its digits yields two bands: `[Purchase Price][ ]`
 * where the label is in the first and `99.2500` in the second. `spec.fieldMap` resolves
 * fields BY HEADER, so the field would map to a permanently-empty band and every record
 * would come out blank.
 *
 * A header is only moved when its own band is empty across every data row AND the
 * neighbouring band has data but no header of its own — so a legitimately-empty optional
 * column can never steal its neighbour's identity. The right neighbour is tried first
 * (right-aligned numerics push their values rightward), then the left.
 *
 * Mutates `columns` in place; `rows` is read-only here.
 */
function realignHeadersOntoDataBands(columns: ColumnBand[], rows: TableRow[]): void {
    if (columns.length === 0 || rows.length === 0) return;
    const hasData = columns.map((_, ci) =>
        rows.some((row) => {
            const cell = row.cells[ci];
            return cell !== null && cell !== undefined && cell.trim().length > 0;
        }),
    );

    for (let ci = 0; ci < columns.length; ci++) {
        if (!columns[ci].header) continue;
        if (hasData[ci]) continue;
        for (const target of [ci + 1, ci - 1]) {
            if (target < 0 || target >= columns.length) continue;
            if (columns[target].header) continue;
            if (!hasData[target]) continue;
            columns[target].header = columns[ci].header;
            columns[target].headerPath = columns[ci].headerPath;
            columns[target].rightAligned = columns[ci].rightAligned;
            columns[ci].header = null;
            columns[ci].headerPath = [];
            break;
        }
    }
}

/**
 * Font-contrast header signal.
 *
 * `LogicalLine.isEmphasized` detects bold via the font NAME (`/bold|black|heavy/`), which
 * never fires on subsetted fonts — and SSRS/Crystal both emit subset names like `g_d0_f2`.
 * Those reports render the column-header row in the bold face of the SAME point size as
 * the data rows, so neither the font-size nor the name signal catches it and the header
 * row leaks into the data as a bogus record.
 *
 * The face still differs, though: header items use one font id, data rows another. So we
 * compare `line`'s dominant font against the dominant font of the body beneath it. A
 * different face on the topmost line of a table region means a header row.
 *
 * Requires at least 3 body lines — below that there's no reliable modal font to contrast
 * against, and mislabelling the only data row as a header would silently drop it.
 */
function usesDifferentFontFromBody(line: LogicalLine, body: LogicalLine[]): boolean {
    if (body.length < 3) return false;
    const bodyFont = dominantFontName(body);
    const lineFont = dominantFontName([line]);
    if (!bodyFont || !lineFont) return false;
    return bodyFont !== lineFont;
}

/** Most common `fontName` across every item on the given lines. Undefined when there are no items. */
function dominantFontName(lines: LogicalLine[]): string | undefined {
    const tally = new Map<string, number>();
    for (const line of lines) {
        for (const item of line.items) {
            if (!item.fontName) continue;
            tally.set(item.fontName, (tally.get(item.fontName) ?? 0) + 1);
        }
    }
    let best: string | undefined;
    let bestCount = 0;
    for (const [name, count] of tally) {
        if (count > bestCount) {
            best = name;
            bestCount = count;
        }
    }
    return best;
}

/**
 * Cross-page merge: when two adjacent pages have sections with the same title AND
 * matching column bands, treat page N+1's section as a continuation of page N's.
 */
function mergeCrossPageSections(
    pages: AnalyzedPage[],
    opts: LayoutAnalyzerOptions,
): AnalyzedSection[] {
    if (pages.length === 0) return [];
    const stitchAcrossPages = opts.stitchCrossPageTables !== false;
    const merged: AnalyzedSection[] = [];
    for (let p = 0; p < pages.length; p++) {
        for (const section of pages[p].sections) {
            const last = merged[merged.length - 1];
            if (
                stitchAcrossPages &&
                last &&
                shouldMergeAcrossPages(
                    { title: last.title, bands: last.columns },
                    { title: section.title, bands: section.columns },
                )
            ) {
                // Absorb this page's rows into the previous section's row list.
                last.spansToNextPage = true;
                const startRowIndex = last.tableRows.length;
                for (const row of section.tableRows) {
                    row.rowIndex = startRowIndex + row.rowIndex;
                    last.tableRows.push(row);
                }
                // Merge chart regions + free text too.
                last.charts.push(...section.charts);
                last.freeText.push(...section.freeText);
                continue;
            }
            // Deep-ish clone so downstream mutations to `merged[]` don't corrupt the
            // per-page arrays (the section mapper is expected to add more per-row fields).
            merged.push({ ...section });
        }
    }
    // Reset spansToNextPage on the LAST occurrence of each merged section — the flag is
    // only meaningful for intermediate pages of a multi-page section.
    for (let i = 0; i < merged.length - 1; i++) merged[i].spansToNextPage = merged[i].spansToNextPage;
    if (merged.length > 0) merged[merged.length - 1].spansToNextPage = false;
    return merged;
}

/** Emit a synthetic section for a page that has only charts + no text sections. */
function emptySectionWithCharts(
    pageNumber: number,
    charts: import('./CSReportPdfTypes').ChartRegion[],
): AnalyzedSection {
    return {
        title: '(charts only)',
        titleY: 0,
        tableRows: [],
        columns: [],
        freeText: [],
        charts,
        spansToNextPage: false,
        startPage: pageNumber,
    };
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
