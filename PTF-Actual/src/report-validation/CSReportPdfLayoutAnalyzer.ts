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
 *   1. TOC extraction  — pull title/page entries as ground truth
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
import { extractToc, findTocEntryLines } from './layout/CSTocExtractor';

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
    // Section titles must survive header/footer stripping. A title repeats at identical
    // coordinates on every page its section spans, which on a short extract is a majority of
    // the document — enough to be mistaken for running chrome and deleted before
    // `detectSectionHeaders` ever runs, losing the entire section. The spec's own section
    // matchers are the authority on what a title is, so they are handed to the segmenter as
    // protected text.
    const segmented = segmentPages(pages, {
        repeatThreshold: opts.headerFooterRepeatThreshold,
        protectedPatterns: opts.sectionHeaderRegexes,
    });

    // 3. Per-page analysis. Section promotion is suppressed on the CONTENTS LINES of a
    // table-of-contents page: those lines read exactly like section titles, so detecting
    // sections there mints a duplicate of every real section, resolving to the same canonical
    // id and shadowing the genuine one for any lookup that takes the first match.
    //
    // Per line rather than per page, because a report may print its contents at the top of
    // page 1 and start a real section below it; blanket suppression would lose that section.
    const tocLines = findTocEntryLines(pages);
    const analyzedPages: AnalyzedPage[] = [];
    for (let p = 0; p < segmented.length; p++) {
        const seg = segmented[p];
        const pageContent = pages[p];
        analyzedPages.push(
            analyzeOnePage(
                pageContent,
                seg.bodyItems,
                seg.headerItems,
                seg.footerItems,
                opts,
                tocLines.get(pageContent.pageNumber),
            ),
        );
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
    tocEntryYBuckets?: Set<number>,
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
        // Page geometry enables the detector's wide-gap veto, which keeps a row of
        // column labels from being read as a section title and splitting the section.
        pageWidth: original.width,
        maxTitleGapRatio: opts.maxTitleGapRatio,
    });
    // A contents entry looks like a title because it NAMES one. Drop just those lines from
    // consideration; anything else on the page is still eligible to be a real section.
    const fullSectionHeaders = sectionCandidates.filter(
        (c) => c.isFullSectionHeader && !isTocEntryLine(c, tocEntryYBuckets),
    );

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

    // Late-header recovery. Runs AFTER stitching so a header wrapped over two lines
    // wrapped over two lines is already one cell by the time we read it.
    let preambleText: string[] = [];
    if (opts.recoverLateHeaderRow !== false) {
        const recovered = recoverHeaderRowFromData(columns, rows, dataLines);
        if (recovered) {
            rows = recovered.rows;
            realignHeadersOntoDataBands(columns, rows);
            // Everything above the recovered header is the section's summary block: the
            // figures the section reports, which sit outside every column band. Dropping it
            // would leave the grid verified and those figures unchecked.
            preambleText = preambleAbove(lines, recovered.headerY, recovered.headerLines);
        }
    }

    // Reindex after stitching so rowIndex reflects the final visible order.
    rows.forEach((r, i) => (r.rowIndex = i + 1));

    return {
        title,
        titleY,
        tableRows: rows,
        columns,
        freeText: [],
        preambleText,
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
 * header label sits further left than its digits yields two bands: `[label][ ]`
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

/** Y-tolerance used when bucketing TOC entry lines; must match `CSTocExtractor`'s default. */
const TOC_Y_TOLERANCE = 3;

function isTocEntryLine(
    candidate: SectionHeaderCandidate,
    tocEntryYBuckets: Set<number> | undefined,
): boolean {
    if (!tocEntryYBuckets || tocEntryYBuckets.size === 0) return false;
    return tocEntryYBuckets.has(Math.round(candidate.line.y / TOC_Y_TOLERANCE));
}

/**
 * Second-chance header detection for a section that opens with a summary block.
 *
 * `splitHeaderAndData` only inspects the top one or two lines, which is right for a plain
 * grid and wrong when those lines carry summary VALUES: the bands then take their headers
 * from them, no spec field maps onto them, and the section yields zero records — a silent
 * loss on a section the spec claims to check.
 *
 * The recovery reads the type profile rather than the position: the header row is the first
 * row whose filled cells are all non-numeric, sitting immediately above a row that carries
 * values. Its cells become the band headers, and it plus everything above it is dropped.
 *
 * GATING — measured against the bands that carry DATA, never the total band count. Column
 * detection emits a spacer band wherever the PDF pads cells, and how many varies from page to
 * page of one report, so a gate on total bands fires according to padding rather than on
 * whether the headers are good: a healthy grid can slip under it and have its headers rebuilt
 * from a data row, losing a key column and with it every record in the section. In a healthy
 * grid every band carrying data also carries a header, whereas headers taken from a summary
 * block sit over bands the grid leaves empty — so the gate is "fewer than half the
 * DATA-carrying bands have a header", with padding excluded from both sides.
 *
 * @returns the surviving data rows plus the header's position, or `null` to leave the
 *          section exactly as it was.
 */
interface RecoveredHeader {
    /** Data rows that survive below the recovered header. */
    rows: TableRow[];
    /** Baseline of the recovered header row. */
    headerY: number;
    /** Every source line the header occupied, wrapped continuations included. */
    headerLines: LogicalLine[];
}

function recoverHeaderRowFromData(
    columns: ColumnBand[],
    rows: TableRow[],
    sourceLines: LogicalLine[],
): RecoveredHeader | null {
    if (columns.length === 0 || rows.length < 2) return null;

    const carriesData = columns.map((_, ci) =>
        rows.some((row) => {
            if (row.isTotalRow || row.isGroupHeader) return false;
            const cell = row.cells[ci];
            return cell !== null && cell !== undefined && cell.trim().length > 0;
        }),
    );
    const dataBands = carriesData.filter(Boolean).length;
    if (dataBands === 0) return null;

    const headedDataBands = columns.filter(
        (c, ci) => carriesData[ci] && c.header !== null && c.header.trim().length > 0,
    ).length;
    if (headedDataBands * 2 >= dataBands) return null;

    // A header row this far down is a preamble, not a header. Bounded so a long section of
    // genuinely unheaded text rows can't have an arbitrary row promoted out of its middle.
    const searchLimit = Math.min(LATE_HEADER_SEARCH_ROWS, rows.length - 1);

    for (let i = 0; i < searchLimit; i++) {
        const row = rows[i];
        if (row.isGroupHeader || row.isTotalRow) continue;

        const filled = row.cells.filter((c): c is string => c !== null && c.trim().length > 0);
        // Two labels don't make a header row — that's a caption or a stray pair.
        if (filled.length < MIN_HEADER_CELLS) continue;
        if (filled.some(looksLikeValue)) continue;

        // …and the row under it must actually carry data, or we've found a paragraph.
        const below = rows[i + 1];
        const valuesBelow = below.cells.filter((c) => c !== null && looksLikeValue(c)).length;
        if (valuesBelow < MIN_VALUE_CELLS_BELOW) continue;

        // Re-read the header text from the ITEMS rather than from `row.cells`. The generic
        // cell bucketing places each item in the band it overlaps most, independently — and
        // header labels are wider than the values beneath them, so two adjacent labels can
        // both land in one band, leaving the column next door headerless and its values
        // unmapped. A header row has exactly one label per column, so it is a MATCHING
        // problem: assign left-to-right, never moving backwards, which also re-joins a
        // label wrapped over two lines.
        const headerLines = headerLinesFor(row, sourceLines);
        const headerItems = headerLines.flatMap((l) => l.items);
        const headerTexts = headerTextsFromItems(headerItems, columns);
        for (let ci = 0; ci < columns.length; ci++) {
            columns[ci].header = headerTexts[ci];
            columns[ci].headerPath = [];
        }
        return { rows: rows.slice(i + 1), headerY: row.y, headerLines };
    }
    return null;
}

/**
 * The pre-stitch lines that make up a (possibly stitched) header row — the line at the
 * row's own y plus any wrapped continuation clustered right above or below it, which is
 * how a wrapped header label is printed.
 */
function headerLinesFor(row: TableRow, sourceLines: LogicalLine[]): LogicalLine[] {
    const window = maxFontSizeOn(sourceLines) * HEADER_WRAP_LINES;
    return sourceLines.filter((line) => Math.abs(line.y - row.y) <= window);
}

/**
 * The section's calculation preamble: every line above the header row that isn't part of
 * the header itself, rendered top-down as plain text with runs joined left to right.
 *
 * Plain text rather than cells on purpose. The preamble is a label-and-value block, not a
 * grid — the two engines lay it out differently (one engine's first preamble line is even
 * consumed as column headers before recovery runs), so band positions carry no meaning
 * here. Text is the one representation both sides agree on.
 */
function preambleAbove(lines: LogicalLine[], headerY: number, headerLines: LogicalLine[]): string[] {
    const consumed = new Set(headerLines);
    return lines
        .filter((line) => !consumed.has(line) && line.y > headerY)
        .sort((a, b) => b.y - a.y)
        .map((line) =>
            [...line.items]
                .sort((a, b) => a.x - b.x)
                .map((i) => i.str)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim(),
        )
        .filter((text) => text.length > 0);
}

/** Vertical reach, in line-heights, over which a wrapped header label is still the same header. */
const HEADER_WRAP_LINES = 1.2;

function maxFontSizeOn(lines: LogicalLine[]): number {
    let max = 0;
    for (const line of lines) {
        for (const item of line.items) {
            if (item.fontSize > max) max = item.fontSize;
        }
    }
    return max;
}

/**
 * Assign header items to column bands as an ordered MATCHING: walking the items left to
 * right, each one takes the best-overlapping band at or after the last band used. Two
 * consequences, both wanted:
 *
 *   - No band can swallow two labels while the next goes headerless: a label on the SAME
 *     line as the previous one must look strictly forward of where that one landed.
 *     Independent per-item assignment gets this wrong whenever a label is wider than its
 *     values, so it lands on the band to its left and that column loses its name.
 *   - A label wrapped onto a SECOND line rejoins its own band, because a different line is
 *     allowed to reuse the band just used.
 *
 * Bands with no label get `null`, and `realignHeadersOntoDataBands` afterwards nudges a
 * header sitting over an empty band onto the neighbouring band that carries the values —
 * the usual right-aligned-numeric offset.
 */
function headerTextsFromItems(items: TextItem[], bands: ColumnBand[]): (string | null)[] {
    const out: (string | null)[] = bands.map(() => null);
    const inked = items.filter((i) => i.str.trim().length > 0).sort((a, b) => a.x - b.x);
    let last = 0;
    let lastY: number | null = null;
    for (const item of inked) {
        const sameLine = lastY !== null && Math.abs(item.y - lastY) <= SAME_LINE_EPSILON;
        const from = lastY === null ? 0 : sameLine ? last + 1 : last;
        const right = item.x + Math.max(item.width, 0);
        let best = -1;
        let bestOverlap = -Infinity;
        let bestDelta = Infinity;
        for (let bi = from; bi < bands.length; bi++) {
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
        out[best] = out[best] === null ? text : `${out[best]} ${text}`;
        last = best;
        lastY = item.y;
    }
    return out;
}

/** Baseline distance (points) within which two header items count as the same printed line. */
const SAME_LINE_EPSILON = 1;

/** How far into a section the late-header pass will look before giving up. */
const LATE_HEADER_SEARCH_ROWS = 6;
/** Minimum filled cells for a row to be considered a header rather than a caption. */
const MIN_HEADER_CELLS = 3;
/** Minimum value-shaped cells the row BELOW a candidate header must carry. */
const MIN_VALUE_CELLS_BELOW = 2;

/**
 * True when a cell reads as DATA rather than a label: a number (with optional currency,
 * thousands separators, accounting parens, trailing percent) or a date. Deliberately narrow
 * — anything it isn't sure about counts as a label, which only makes the late-header pass
 * decline to fire.
 */
function looksLikeValue(cell: string): boolean {
    const t = cell.trim();
    if (t.length === 0) return false;
    if (/^\(?-?[$\u00a3\u20ac]?[\d,]+(?:\.\d+)?\)?%?-?$/.test(t)) return true;
    if (/^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/.test(t)) return true;
    return false;
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
