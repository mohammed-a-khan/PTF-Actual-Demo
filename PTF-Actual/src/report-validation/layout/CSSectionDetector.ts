/**
 * CS Report Validation — Layer 2.4: Section header detection.
 *
 * Identifies which lines on a page are SECTION HEADERS (top-of-section
 * titles like "Deal Summary", "Coverage Test Summary") vs GROUP SUB-
 * HEADERS inside a table (like "Interest Coverage Tests", "OverCollat-
 * eralization Tests" as bold sub-headings within Coverage Test Summary).
 *
 * Uses THREE independent signals + majority voting so no single heuristic
 * can misfire alone:
 *
 *   1. FONT SIZE — item font ≥ `sectionHeaderFontRatio × pageMedianFontSize`
 *      (default 1.2 = 20% larger than surrounding text).
 *   2. TEXT SHAPE — all-caps run of ≥ 4 alpha chars OR title-case with
 *      known "section-word" tokens (`Summary`, `Detail`, `Tests`, …).
 *   3. REGEX — spec-supplied patterns matching known section names.
 *
 * A line needs at least 2 of 3 signals to qualify as a section header.
 *
 * One VETO overrides the vote: a line whose text runs are separated by a
 * blank gap wider than `maxTitleGapRatio` of the page is a column-label
 * row, not a title. Financial reports print grid labels in the same large
 * all-caps face they use for section titles (`CALCULATION` … `RATIO`
 * spanning the right half of the page), which otherwise scores 2 votes and
 * splits the section in half — orphaning the detail grid under a bogus
 * title no spec matcher can name. A real title is one contiguous phrase.
 * The veto yields to an explicit spec matcher: when the `regex` signal
 * fires the spec has NAMED this title, and the spec outranks geometry.
 * A single signal downgrades to "group sub-header" candidate — inside a
 * table region, that's a legitimate sub-header row; outside, it's noise.
 *
 * The voting model is deliberate: individual heuristics all misfire in
 * specific ways (font-size alone breaks on reports where the whole page
 * uses 14pt; regex alone breaks when spec drifts vs. actual title; all-
 * caps alone breaks on banking reports where every column header is
 * uppercase). 2-of-3 is robust to any one going wrong.
 *
 * @module report-validation/layout/CSSectionDetector
 */

import type { LogicalLine } from '../CSReportPdfTypes';

export interface SectionDetectorOptions {
    /** Font-size multiplier vs page median for the FONT signal. Default 1.2. */
    sectionHeaderFontRatio?: number;
    /** Regex patterns matching known section titles (from spec). Default []. */
    sectionHeaderRegexes?: RegExp[];
    /** Additional "section-word" tokens beyond the built-in set (Summary, Detail, Tests, Report, Notification, Section). */
    extraSectionWords?: string[];
    /** Vote count required to qualify as a full section header. Default 2 of 3. */
    votesRequired?: number;
    /**
     * Page width in PDF user-space. Enables the wide-gap veto (below). Omit to disable it —
     * callers that don't know the page geometry keep the pre-veto behaviour.
     */
    pageWidth?: number;
    /**
     * Wide-gap veto threshold, as a fraction of `pageWidth`. A candidate line whose runs are
     * separated by a blank gap wider than this is a COLUMN-LABEL row, not a section title.
     * Default 0.06 (6% of the page).
     */
    maxTitleGapRatio?: number;
}

export interface SectionHeaderCandidate {
    line: LogicalLine;
    /** Fired signals (subset of `font`, `shape`, `regex`). */
    signals: Array<'font' | 'shape' | 'regex'>;
    /** True = full section header (votes ≥ threshold); false = single-signal group sub-header candidate. */
    isFullSectionHeader: boolean;
    /** Plain-text title as it will be surfaced downstream (spaces normalised, no punctuation). */
    title: string;
}

/** Built-in "section-word" tokens — extended by opts.extraSectionWords. */
const DEFAULT_SECTION_WORDS = [
    'Summary',
    'Detail',
    'Details',
    'Tests',
    'Test',
    'Report',
    'Notification',
    'Section',
    'Statement',
    'Analysis',
    'Overview',
];

/**
 * Scan `lines` and return a candidate per line that fired at least one signal. Callers
 * filter on `isFullSectionHeader` for hard section boundaries; single-signal candidates
 * are useful as group-sub-header hints inside table regions.
 */
export function detectSectionHeaders(
    lines: LogicalLine[],
    opts: SectionDetectorOptions = {},
): SectionHeaderCandidate[] {
    if (lines.length === 0) return [];
    const fontRatio = opts.sectionHeaderFontRatio ?? 1.2;
    const votesRequired = opts.votesRequired ?? 2;
    const regexes = opts.sectionHeaderRegexes ?? [];
    const words = new Set([...DEFAULT_SECTION_WORDS, ...(opts.extraSectionWords ?? [])]);
    const maxGap = opts.pageWidth ? opts.pageWidth * (opts.maxTitleGapRatio ?? 0.06) : Infinity;

    // Compute page-wide median font size (per-line max-item font) as the FONT baseline.
    // Using per-line MAX (not per-item) so a mixed-font body-text line doesn't drag the
    // median down and cause every 12pt paragraph to look "large".
    const lineFontMaxes = lines.map((l) => Math.max(...l.items.map((it) => it.fontSize)));
    const medianFont = median(lineFontMaxes);
    const fontThreshold = medianFont * fontRatio;

    const candidates: SectionHeaderCandidate[] = [];
    for (const line of lines) {
        const title = line.items
            .map((i) => i.str)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (title.length === 0) continue;

        const signals: Array<'font' | 'shape' | 'regex'> = [];

        // Signal 1: FONT
        const lineFontMax = Math.max(...line.items.map((it) => it.fontSize));
        if (lineFontMax >= fontThreshold) signals.push('font');

        // Signal 2: SHAPE — all-caps ≥ 4 alpha chars, OR title-case with a section-word token
        const alphaOnly = title.replace(/[^A-Za-z]/g, '');
        const isAllCaps = alphaOnly.length >= 4 && alphaOnly === alphaOnly.toUpperCase();
        const hasSectionWord = words.has(lastWordOf(title));
        // Title-case = first char of each significant word is upper. Weaker than all-caps.
        const isTitleCase = isTitleCased(title);
        if (isAllCaps || (isTitleCase && hasSectionWord)) signals.push('shape');

        // Signal 3: REGEX
        if (regexes.some((r) => r.test(title))) signals.push('regex');

        if (signals.length === 0) continue;

        // VETO: wide internal gap ⇒ column labels, not a title. Skipped when the spec
        // explicitly matched this title (regex signal) — the spec outranks geometry.
        const vetoed = !signals.includes('regex') && widestInternalGap(line) > maxGap;

        candidates.push({
            line,
            signals,
            isFullSectionHeader: !vetoed && signals.length >= votesRequired,
            title,
        });
    }
    return candidates;
}

/**
 * Widest blank run between consecutive non-blank text runs on a line, in PDF user-space
 * points. Whitespace-only items (pdfjs emits them as padding runs) are skipped rather than
 * measured, because their reported width is the gap we're after — measuring edge-to-edge
 * between the runs that carry ink is the same number without depending on that quirk.
 *
 * Returns 0 for a line with fewer than two inked runs.
 */
function widestInternalGap(line: LogicalLine): number {
    const inked = line.items
        .filter((i) => i.str.trim().length > 0)
        .sort((a, b) => a.x - b.x);
    let widest = 0;
    for (let i = 1; i < inked.length; i++) {
        const prev = inked[i - 1];
        const gap = inked[i].x - (prev.x + prev.width);
        if (gap > widest) widest = gap;
    }
    return widest;
}

/**
 * Extract the "meaningful last word" of a title — skips trailing digits (e.g. "Detail 1"
 * → "Detail") and roman numerals (I, II, III) so numbered variants still match the
 * section-word set.
 */
function lastWordOf(title: string): string {
    const parts = title.split(/\s+/).filter((p) => p.length > 0);
    for (let i = parts.length - 1; i >= 0; i--) {
        const w = parts[i];
        if (/^[0-9]+[A-Z]?$/.test(w)) continue; // "1", "2", "1F", "1D"
        if (/^[IVX]+$/.test(w)) continue; // roman
        return w;
    }
    return '';
}

/**
 * Title-cased test: at least one word starts uppercase followed by lowercase, and no
 * words are entirely lowercase (except stopwords `of, and, the, in, on, to, a, an, for`).
 */
function isTitleCased(title: string): boolean {
    const stop = new Set(['of', 'and', 'the', 'in', 'on', 'to', 'a', 'an', 'for', 'by', 'with', 'or']);
    const words = title.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
    if (words.length === 0) return false;
    let titleWordCount = 0;
    for (const w of words) {
        if (stop.has(w.toLowerCase())) continue;
        // Strip trailing punctuation.
        const stripped = w.replace(/[^\w]+$/, '');
        if (stripped.length === 0) continue;
        const first = stripped[0];
        const rest = stripped.slice(1);
        if (first === first.toUpperCase() && (rest.length === 0 || rest.toLowerCase() === rest)) {
            titleWordCount++;
        } else if (stripped === stripped.toUpperCase()) {
            // ALL-CAPS acronyms like "S&P", "CLO" — still title-ish.
            titleWordCount++;
        } else {
            return false;
        }
    }
    return titleWordCount > 0;
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
