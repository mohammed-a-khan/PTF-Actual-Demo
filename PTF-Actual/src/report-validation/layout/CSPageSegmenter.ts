/**
 * CS Report Validation — Layer 2.3: Page segmentation + header/footer dedup.
 *
 * Every page in a Crystal / SSRS report carries running chrome: the
 * report title, company logo/name, "As of: <date>", "Page N", copyright
 * footer. If we leave these in with the tabular data, they bloat the
 * canonical model, confuse column detection, and produce spurious
 * findings when the "As of" date differs between Crystal (rendered top-
 * right) and SSRS (rendered top-left).
 *
 * ALGORITHM
 * ---------
 * A text item is treated as header/footer chrome when its (rounded) y-
 * coordinate appears at similar y across ≥ `repeatThreshold` fraction of
 * pages. We look at the TOP strip (upper 15% of page height) and BOTTOM
 * strip (lower 10%) separately since headers and footers occupy
 * different bands.
 *
 * We don't just match on y-position — we ALSO match on text similarity.
 * A running page number ("Page 5", "Page 6", …) has the SAME position
 * across pages but DIFFERENT text; both must repeat for the strip to
 * qualify. Position-repeat + text-shape-repeat (numbers changing, all
 * else stable) both count.
 *
 * @module report-validation/layout/CSPageSegmenter
 */

import type { PageContent, TextItem } from '../CSReportPdfTypes';

export interface PageSegmenterOptions {
    /** Fraction of pages at which text must recur to count as chrome. Default 0.6. */
    repeatThreshold?: number;
    /** Top strip band (fraction of page height, measured from top). Default 0.15. */
    topStripRatio?: number;
    /** Bottom strip band (fraction of page height, measured from bottom). Default 0.10. */
    bottomStripRatio?: number;
    /** Y-tolerance for grouping items across pages (in PDF points). Default 3. */
    yTolerance?: number;
    /** X-tolerance for grouping items across pages (in PDF points). Default 5. */
    xTolerance?: number;
}

/** Per-page segmentation output. Header + footer items are removed from `bodyItems`. */
export interface SegmentedPage {
    pageNumber: number;
    /** Text items that formed the running header (removed from body). */
    headerItems: TextItem[];
    /** Text items that formed the running footer (removed from body). */
    footerItems: TextItem[];
    /** Everything else — this is what the section detector + table extractor consume. */
    bodyItems: TextItem[];
}

/**
 * Segment every page into (headerItems, footerItems, bodyItems). Requires the FULL
 * set of pages up front because the header/footer detection is cross-page: a text
 * item is chrome only when it repeats at similar coordinates on other pages.
 *
 * Deterministic: same input pages produce the same segmentation, so downstream
 * layout analysis is reproducible.
 */
export function segmentPages(pages: PageContent[], opts: PageSegmenterOptions = {}): SegmentedPage[] {
    if (pages.length === 0) return [];
    const repeatThreshold = opts.repeatThreshold ?? 0.6;
    const topStripRatio = opts.topStripRatio ?? 0.15;
    const bottomStripRatio = opts.bottomStripRatio ?? 0.1;
    const yTol = opts.yTolerance ?? 3;
    const xTol = opts.xTolerance ?? 5;

    // For each page, split items into "top strip" (candidate header), "bottom strip"
    // (candidate footer), "body". The strip regions are height-relative — reports use
    // different page sizes, so a fixed pixel band is wrong.
    interface StripSet {
        top: TextItem[];
        bottom: TextItem[];
        body: TextItem[];
    }
    const strips: StripSet[] = pages.map((page) => {
        const topCutoff = page.height * (1 - topStripRatio);
        const bottomCutoff = page.height * bottomStripRatio;
        const top: TextItem[] = [];
        const bottom: TextItem[] = [];
        const body: TextItem[] = [];
        for (const item of page.textItems) {
            if (item.y >= topCutoff) top.push(item);
            else if (item.y <= bottomCutoff) bottom.push(item);
            else body.push(item);
        }
        return { top, bottom, body };
    });

    // For each candidate-strip item, count on how many pages a similar-position item
    // appears. Similarity = (x, y) within tolerance AND text either exact-match OR the
    // "shape" matches after digits normalised (so "Page 5" ~ "Page 6").
    const totalPages = pages.length;
    const minRepeats = Math.max(1, Math.ceil(totalPages * repeatThreshold));

    const chromeHeader: TextItem[][] = strips.map(() => []);
    const chromeFooter: TextItem[][] = strips.map(() => []);

    for (const region of ['top', 'bottom'] as const) {
        // Build a "signature" for each item on each page: (roundedY, roundedX, textShape)
        // where textShape is the item.str with runs of digits collapsed to `#`.
        const signatures: Map<string, { pages: Set<number>; items: Array<{ page: number; item: TextItem }> }> =
            new Map();
        for (let p = 0; p < strips.length; p++) {
            const items = strips[p][region];
            for (const item of items) {
                const sig = itemSignature(item, xTol, yTol);
                let entry = signatures.get(sig);
                if (!entry) {
                    entry = { pages: new Set(), items: [] };
                    signatures.set(sig, entry);
                }
                entry.pages.add(p);
                entry.items.push({ page: p, item });
            }
        }
        // Items whose signature appears on ≥ minRepeats pages = chrome.
        for (const entry of signatures.values()) {
            if (entry.pages.size < minRepeats) continue;
            for (const { page, item } of entry.items) {
                if (region === 'top') chromeHeader[page].push(item);
                else chromeFooter[page].push(item);
            }
        }
    }

    // Body = original items minus everything classified as chrome.
    const chromeItemSets: Set<TextItem>[] = strips.map((_, p) => {
        const set = new Set<TextItem>();
        for (const it of chromeHeader[p]) set.add(it);
        for (const it of chromeFooter[p]) set.add(it);
        return set;
    });

    return pages.map((page, p) => ({
        pageNumber: page.pageNumber,
        headerItems: chromeHeader[p],
        footerItems: chromeFooter[p],
        bodyItems: page.textItems.filter((it) => !chromeItemSets[p].has(it)),
    }));
}

/**
 * Build a deduplication signature for a text item. Rounds x/y to nearest tolerance-
 * granularity bucket. For "Page N"-style text the digit run is normalised so the item
 * clusters across pages — but ONLY when the string is short AND contains at least one
 * letter (rejects long numeric data cells like "250,000,000.00" that shouldn't collapse
 * across pages).
 */
function itemSignature(item: TextItem, xTol: number, yTol: number): string {
    const xBucket = Math.round(item.x / xTol);
    const yBucket = Math.round(item.y / yTol);
    let shape = item.str;
    // Only normalise digits for short label-shaped items — protects numeric cells from
    // being over-collapsed. "Page 5" (6 chars, has letters) → "Page #"; "250,000,000.00"
    // (14 chars, no letters) → left alone.
    if (item.str.length <= 20 && /[A-Za-z]/.test(item.str)) {
        shape = item.str.replace(/\d+/g, '#');
    }
    return `${xBucket}|${yBucket}|${shape}`;
}
