/**
 * CS Report Validation — PDF extraction types.
 *
 * The types the extractor + layout analyzer + downstream mapper all agree on.
 * Extractor produces `PageContent`. Layout analyzer chews on `TextItem[]` and
 * produces `AnalyzedPage`. Section mapper turns `AnalyzedPage[]` into the
 * canonical model.
 *
 * @module report-validation/CSReportPdfTypes
 */

/** A single text run as it appears on the page. All coordinates are in PDF user-space (points, 1/72 inch). */
export interface TextItem {
    /** The literal text — pdfjs delivers ligatures like `fi` unpacked; no post-processing needed. */
    str: string;
    /** X coordinate of the item's baseline start, PDF-space. */
    x: number;
    /** Y coordinate of the item's baseline, PDF-space. Note: PDF Y grows upward from page bottom. */
    y: number;
    /** Reported width of the text run (may over-count for spaces at the end). */
    width: number;
    /** Reported height — usually just the font size in points. */
    height: number;
    /** Point size (font ascent + descent). Useful for section-header voting. */
    fontSize: number;
    /** Font family / weight identifier as pdfjs exposes it (e.g. `g_d0_f1`, `Helvetica-Bold`). */
    fontName: string;
    /** True when pdfjs marked this item as ending a text line (newline in the content stream). */
    hasEOL: boolean;
    /**
     * Rotation angle in degrees, derived from the transform matrix. 0 for horizontal text,
     * 90/270 for rotated column labels (rare in tabular reports but present in some Crystal
     * templates).
     */
    rotation: number;
    /** Hex color from font state, e.g. `#ff0000` when Crystal renders a "Fail" cell in red. Optional — not every producer emits color info. */
    color?: string;
}

/** One page as pdfjs delivers it. */
export interface PageContent {
    /** 1-indexed page number. */
    pageNumber: number;
    /** Page width in PDF user-space. */
    width: number;
    /** Page height in PDF user-space. */
    height: number;
    /** All text runs on this page, in extraction order. */
    textItems: TextItem[];
}

/**
 * A rectangular region on the page that Layer-2 chart detection carved out.
 * Layer-2 removes any text items falling inside these regions before table
 * extraction so bar-chart labels don't get mistaken for data rows.
 */
export interface ChartRegion {
    /** 1-indexed page number this region belongs to. */
    pageNumber: number;
    /** Bounding box in PDF user-space. */
    box: BoundingBox;
    /** Text items INSIDE the region (chart labels, axis values) — kept for reference / debugging. */
    itemsInside: TextItem[];
    /** Heuristic confidence 0..1 that this really is a chart, not a table. */
    confidence: number;
    /** Best-guess chart caption if any (usually the text just above the region). */
    caption?: string;
}

/** Axis-aligned bounding box in PDF user-space. */
export interface BoundingBox {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

/**
 * A group of text items that share (approximately) the same y-coordinate — a logical line.
 * Items are stored left-to-right in x-order. Line-clustering tolerance is
 * `fontSize * options.lineToleranceRatio` (default 0.4).
 */
export interface LogicalLine {
    /** Baseline y — the median of member items' y values. */
    y: number;
    /** Height of the line (max item height) — used by cell-stitching to decide continuation. */
    height: number;
    /** Left-to-right sorted text items on this line. */
    items: TextItem[];
    /** True when every item on the line uses a font size ≥ 120% of the page's median font size (candidate header). */
    isHeader: boolean;
    /** True when the concatenated line text is all upper-case, all-punctuation, or bold-styled (candidate section header). */
    isEmphasized: boolean;
}

/**
 * A detected column in a table region. Populated by the KDE-based column detector.
 * Column bands are HALF-OPEN intervals `[start, end)` so a cell with x exactly at a
 * boundary belongs to the right-side column.
 */
export interface ColumnBand {
    /** X-start of the column band. */
    start: number;
    /** X-end of the column band (half-open). */
    end: number;
    /**
     * How many TRUE spanner labels sit above this column — labels that covered several
     * sub-columns. Zero means every extra entry in `headerPath` is a wrapped continuation of
     * one heading, which re-joins with a space rather than camel-casing into a path.
     */
    spannerDepth?: number;
    /** X where this column's heading text begins, when one was resolved. Distinguishes a left-aligned heading that overflowed from a right-aligned one that starts left of its digits. */
    headerLeft?: number;
    /** Header text for this column, or `null` when the column is auto-detected without a header row. */
    header: string | null;
    /** Multi-level header ancestry (top → bottom), e.g. `['Original Rating', 'Agency A']`. Empty when column is single-level. */
    headerPath: string[];
    /** True when the column is right-aligned (numeric formatting hint) — used to bias number-vs-string detection. */
    rightAligned: boolean;
}

/**
 * A resolved row inside an analyzed table. Cell values are the raw joined text from the
 * items falling inside each column band. `null` = column present but empty.
 */
export interface TableRow {
    /** 1-indexed row position within the table (after header + total rows are stripped). */
    rowIndex: number;
    /** Y-coordinate of the row's baseline (helps map back to the source PDF for evidence). */
    y: number;
    /** Column index → raw text (or null for empty cells). */
    cells: (string | null)[];
    /**
     * Per-cell metadata carried forward from Layer 1 — useful for spec-driven behaviour like
     * "column X uses text color as Pass/Fail signal". Same array length as `cells`.
     */
    cellMeta: (CellMeta | null)[];
    /** True when this row was classified as a group sub-header (a bold sub-heading inside a table), not a data row. */
    isGroupHeader: boolean;
    /** True when this row was classified as a totals / subtotals row (extractor-side checksum, not comparable data). */
    isTotalRow: boolean;
    /** Group header text this row falls under (from the most recent group-header row above), or null if none. */
    groupLabel: string | null;
}

/** Small companion object carrying extraction-side metadata per cell. */
export interface CellMeta {
    /** Text color if pdfjs exposed one. Preserved for spec-driven Pass/Fail signals. */
    color?: string;
    /** True when the joined text spanned more than one PDF-line item (multi-line cell stitched together). */
    stitched?: boolean;
    /** Font weight if the producer set one ("bold", "italic", "regular"). Bold cells often carry emphasis. */
    fontWeight?: string;
}

/**
 * A section detected on the page — either a top-of-section title or a mid-table group
 * sub-header. Sections that span
 * multiple pages have `spansToNextPage` set so the cross-page merger can join them.
 */
export interface AnalyzedSection {
    /** As-detected title text. */
    title: string;
    /** Y-coordinate of the section title (top of the section on this page). */
    titleY: number;
    /** Ordered rows under this section. Empty when the section is text-only or chart-only. */
    tableRows: TableRow[];
    /** Detected columns for the table(s) in this section. Empty when there's no tabular content. */
    columns: ColumnBand[];
    /** Free text paragraphs found within the section but outside any table. */
    freeText: string[];
    /**
     * Lines of the summary block printed above the section's grid, top-down, when one was
     * found. These carry figures that sit outside every column band and would otherwise never
     * be compared. Empty for an ordinary grid. See `RequiredSectionSpec.summaryFields`.
     */
    preambleText?: string[];
    /** Chart regions detected within this section — kept for debug/evidence; NOT used for data compare. */
    charts: ChartRegion[];
    /**
     * True when the section title reappears on the next page's header — indicates a
     * cross-page continuation the cross-page merger should join.
     */
    spansToNextPage: boolean;
    /** 1-indexed page number where this section START appears (may end on a later page). */
    startPage: number;
}

/**
 * Result of Layer 2 analysis for one page. Includes all detected sections plus the
 * page-level chrome that was stripped off. The `residualText` collects any items
 * that didn't fit into a section or table — kept for debug so nothing extracted
 * silently disappears.
 */
export interface AnalyzedPage {
    pageNumber: number;
    /** Text detected as the running page header (deduplicated after multi-page voting). */
    header: string[];
    /** Text detected as the running page footer. */
    footer: string[];
    /** Sections detected on this page (may be empty for pure text/chart pages). */
    sections: AnalyzedSection[];
    /** Text items that didn't map to any section — kept so we can spot extraction misses in debug. */
    residualText: string[];
}

/**
 * Result of the top-of-report Table-of-Contents extraction. Used as GROUND TRUTH
 * downstream: the section mapper cross-checks its detected sections against this list
 * and flags any that don't line up.
 */
export interface TocEntry {
    /** As-rendered section title. */
    title: string;
    /** Page number the TOC pointed at. */
    startPage: number;
}

/** Fully analyzed report. This is what the section mapper (Phase C) consumes. */
export interface AnalyzedReport {
    /** Total page count. */
    pageCount: number;
    /** All analyzed pages in order. */
    pages: AnalyzedPage[];
    /** Extracted TOC — empty array when the report has no TOC. */
    toc: TocEntry[];
    /**
     * Cross-page-merged sections. Each entry is the full section (all rows), pulling in
     * continuations from subsequent pages when `spansToNextPage` was set. This is the
     * primary output the section mapper reads.
     */
    mergedSections: AnalyzedSection[];
}

/** Options for the layout analyzer. All fields optional with sensible defaults. */
export interface LayoutAnalyzerOptions {
    /** Multiplier of median font size for line-cluster tolerance. Default 0.4. */
    lineToleranceRatio?: number;
    /** Fraction of pages a text item must appear on (at similar y) to be classified as header/footer. Default 0.6. */
    headerFooterRepeatThreshold?: number;
    /**
     * Wide-gap veto threshold for section-title detection, as a fraction of page width.
     * See `CSSectionDetector`. Default 0.06.
     */
    maxTitleGapRatio?: number;
    /**
     * When true (default), a section whose column bands came back mostly unheaded gets a
     * second pass that looks for the real header row further down the section. See
     * `recoverHeaderRowFromData` in `CSReportPdfLayoutAnalyzer`.
     */
    recoverLateHeaderRow?: boolean;
    /** Section-header font-size threshold (× median). Default 1.2 — 20% larger than surrounding text. */
    sectionHeaderFontRatio?: number;
    /** Kernel-density bandwidth for column detection (in PDF points). Default 3. */
    columnKdeBandwidth?: number;
    /** Minimum items on a line for column detection to consider it. Default 3 — fewer are treated as free text. */
    minLineItemsForTable?: number;
    /** Multi-line cell stitching on/off. Default true. */
    stitchMultiLineCells?: boolean;
    /** Cross-page table continuation on/off. Default true. */
    stitchCrossPageTables?: boolean;
    /** Regexes matching section-header text on a per-report basis. Passed in from the spec at run time. */
    sectionHeaderRegexes?: RegExp[];
}
