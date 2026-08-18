/**
 * CS Report Validation — Layer 2.9: Table-of-contents extraction.
 *
 * The first page of most Crystal / SSRS report exports is a Table of
 * Contents. We extract it as GROUND TRUTH — the authoritative section
 * list against which the layout analyzer's own section detection is
 * cross-checked downstream. When the TOC says "Deal Summary → 2" and
 * layout analysis finds "Deal Summary" on page 4 (or doesn't find it
 * at all), that's a real, high-signal discrepancy the reconciler
 * surfaces.
 *
 * DETECTION
 * ---------
 * A TOC page has the visual signature:
 *   - "Table of Contents" (or "TABLE OF CONTENTS") in the top strip
 *   - Two-column body: left = section names, right = page numbers
 *   - Every right-column value is a small integer (1-3 digits)
 *
 * When those signatures line up, we pair each left-column line with the
 * page-number line at the same y (± tolerance). The pairing is stable
 * because TOC entries always have EXACTLY two horizontal text items on
 * a line (the name and the number), separated by a wide gap.
 *
 * @module report-validation/layout/CSTocExtractor
 */

import { clusterLines } from './CSLineClusterer';
import type { LogicalLine, PageContent, TocEntry } from '../CSReportPdfTypes';

export interface TocExtractorOptions {
    /** Y-tolerance (points) for pairing left-column entries with right-column numbers. Default 3. */
    yPairingTolerance?: number;
    /** Regex the top-strip must match (case-insensitive) to trigger TOC extraction. */
    tocHeaderPattern?: RegExp;
    /** Max page number allowed in a TOC entry (defensive against noise). Default 9999. */
    maxTocPageNumber?: number;
}

/**
 * Scan the first N pages of a report and extract every TOC entry found. In practice a
 * report has ONE TOC page (page 1); we scan up to `maxScanPages` because some reports
 * span the TOC across page 1 + 2.
 *
 * Returns an empty array when no TOC is found — callers gracefully degrade to
 * "section detection without ground truth" in that case.
 */
export function extractToc(pages: PageContent[], maxScanPages = 3, opts: TocExtractorOptions = {}): TocEntry[] {
    if (pages.length === 0) return [];
    const headerPattern = opts.tocHeaderPattern ?? /table\s*of\s*contents/i;
    const yTol = opts.yPairingTolerance ?? 3;
    const maxPageNumber = opts.maxTocPageNumber ?? 9999;

    const entries: TocEntry[] = [];
    for (let p = 0; p < Math.min(maxScanPages, pages.length); p++) {
        const page = pages[p];
        // Cheap header check: does any line on the page match "Table of Contents"?
        const lines = clusterLines(page.textItems);
        const hasHeader = lines.some((l) =>
            headerPattern.test(l.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ')),
        );
        if (!hasHeader) continue;

        // Pair title lines with page-number items. TOC entries typically have the form:
        // one or more left-side items (title text), a wide gap, one right-side item
        // (page number, integer). We spot page-number items first (integers), then find
        // their same-y title items.
        for (const line of lines) {
            const entry = extractTocEntryFromLine(line, yTol, maxPageNumber);
            if (entry) entries.push(entry);
        }
        // Once we've found a TOC page with entries, stop scanning (guard against picking
        // up a stray "Table of Contents" phrase deeper in the report).
        if (entries.length > 0) break;
    }
    // Deterministic order — deduplicate by (title, page).
    const seen = new Set<string>();
    return entries.filter((e) => {
        const k = `${e.title}${e.startPage}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

/**
 * Interpret one line as a TOC entry. Returns null when the line doesn't fit the pattern
 * (title-text plus integer page number). "Integer" is strict — decimal or currency-
 * shaped tokens are rejected so a numeric cell in a coincidentally-TOC-looking page
 * doesn't create a false entry.
 */
function extractTocEntryFromLine(line: LogicalLine, yTol: number, maxPageNumber: number): TocEntry | null {
    if (line.items.length < 2) return null;
    // Right-most item = page-number candidate.
    const sorted = [...line.items].sort((a, b) => a.x - b.x);
    const rightMost = sorted[sorted.length - 1];
    const pageStr = rightMost.str.trim();
    if (!/^\d{1,4}$/.test(pageStr)) return null;
    const startPage = parseInt(pageStr, 10);
    if (!Number.isFinite(startPage) || startPage < 1 || startPage > maxPageNumber) return null;

    // Title = everything to the left of the page number. Must have SOME letters — reject
    // e.g. a line that's just two numbers.
    const titleItems = sorted.slice(0, -1);
    const titleText = titleItems.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
    // Strip trailing dot-leaders ("Deal Summary ....." → "Deal Summary").
    const cleanTitle = titleText.replace(/[\s.·:]+$/g, '').trim();
    if (cleanTitle.length === 0) return null;
    if (!/[A-Za-z]/.test(cleanTitle)) return null;
    // Sanity: title items must be on the same y as the page number (they're on the same
    // clustered line, but let's double-check with the tolerance too — cheap belt-and-braces).
    for (const it of titleItems) {
        if (Math.abs(it.y - rightMost.y) > yTol) return null;
    }
    return { title: cleanTitle, startPage };
}
