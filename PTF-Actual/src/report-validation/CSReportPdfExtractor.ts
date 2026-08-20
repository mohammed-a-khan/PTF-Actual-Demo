/**
 * CS Report Validation — Layer 1: PDF text + coordinate extraction.
 *
 * Uses pdfjs-dist (Mozilla, MIT, pure JS, offline) to extract text items
 * with their x/y coordinates, dimensions, font info, and — where the PDF
 * producer emitted them — colors. Coordinates are in PDF user-space
 * (points, 1/72 inch); Y grows upward from page bottom.
 *
 * pdfjs-dist v4 ships as ESM only, but this framework's build target is
 * CommonJS. Dynamic `import()` bridges the two — the `Function`-string
 * form defeats TS's static resolution so it doesn't try to rewrite the
 * ESM import into a `require()` at compile time.
 *
 * TESTING
 * -------
 * The extractor accepts an optional `pdfjsLoader` so tests can inject a
 * stub without needing a real PDF on disk. The default loader lazy-imports
 * pdfjs on first use; failure to load produces a clear "install pdfjs-dist"
 * message rather than a cryptic module-not-found stack.
 *
 * @module report-validation/CSReportPdfExtractor
 */

import * as fs from 'fs';
import type { PageContent, TextItem } from './CSReportPdfTypes';
import type { OcrAdapter } from './CSReportOcrAdapter';

/**
 * The minimal shape the extractor needs from pdfjs. Real pdfjs-dist exposes far more;
 * we depend on the smallest surface so a mock can implement it in a dozen lines.
 */
export interface PdfJsLoader {
    /** Kick off document parsing. Real pdfjs returns a loading task with a `.promise` field. */
    getDocument(src: { data: Uint8Array }): { promise: Promise<PdfJsDocument> };
}

export interface PdfJsDocument {
    /** Number of pages in the parsed document. */
    numPages: number;
    /** Fetch page N (1-indexed). */
    getPage(n: number): Promise<PdfJsPage>;
    /** Best-effort resource release. */
    cleanup?(): void;
    destroy?(): Promise<void>;
}

export interface PdfJsPage {
    /** MediaBox / CropBox in PDF user-space. */
    view: number[]; // [x1, y1, x2, y2]
    /** Fetch every text run on this page. */
    getTextContent(options?: {
        includeMarkedContent?: boolean;
        disableCombineTextItems?: boolean;
    }): Promise<PdfJsTextContent>;
    /** Loaded fonts / colors — some producers surface color info here. */
    getOperatorList?(): Promise<unknown>;
    cleanup?(): void;
}

export interface PdfJsTextContent {
    items: Array<PdfJsTextItem | PdfJsMarkedContentItem>;
    styles: Record<string, PdfJsStyle>;
}

export interface PdfJsTextItem {
    str: string;
    dir?: string;
    /** Standard 6-element affine `[a, b, c, d, e, f]` — e/f are x/y. */
    transform: number[];
    width: number;
    height: number;
    fontName: string;
    hasEOL: boolean;
}

export interface PdfJsMarkedContentItem {
    type: 'beginMarkedContent' | 'endMarkedContent' | 'beginMarkedContentProps';
    id?: string | null;
}

export interface PdfJsStyle {
    fontFamily?: string;
    ascent?: number;
    descent?: number;
    vertical?: boolean;
}

/**
 * Default loader — dynamically imports pdfjs-dist v4 (ESM-only). The
 * `Function`-string form bypasses TypeScript's static resolution so `tsc`
 * doesn't try to rewrite the import into `require()`. On import failure,
 * throws a helpful "install pdfjs-dist" error instead of the raw stack.
 */
let cachedPdfJs: PdfJsLoader | null = null;
async function defaultPdfJsLoader(): Promise<PdfJsLoader> {
    if (cachedPdfJs) return cachedPdfJs;
    try {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const dynamicImport = new Function('specifier', 'return import(specifier)') as (
            s: string,
        ) => Promise<{ getDocument: PdfJsLoader['getDocument'] }>;
        const mod = await dynamicImport('pdfjs-dist/legacy/build/pdf.mjs');
        assertSupportedPdfJs((mod as { version?: string }).version);
        cachedPdfJs = { getDocument: mod.getDocument };
        return cachedPdfJs;
    } catch (err) {
        throw new Error(
            `CSReportPdfExtractor: failed to load pdfjs-dist. ` +
                `Run: npm install pdfjs-dist. Underlying error: ${(err as Error).message}`,
        );
    }
}

/** pdfjs major version this extractor's geometry handling is written and tested against. */
const SUPPORTED_PDFJS_MAJOR = 4;

/**
 * Refuse to run on an untested pdfjs major.
 *
 * Column bands are clustered from the `x`, `y` and `width` pdfjs reports per text item, so a
 * release that changes those numbers moves every band boundary. The visible result is not an
 * error — it is adjacent headers collapsing into one band, a key column losing its name, and
 * every row in the section being discarded for want of a business key. Silent, and
 * indistinguishable from a report that genuinely has no data.
 *
 * A consumer whose own project depends on a newer pdfjs hoists it above this package, so the
 * wrong version arrives without anyone choosing it. Failing loudly here costs one clear
 * message; the alternative costs a day of looking for the defect in the wrong place.
 *
 * `REPORT_PDFJS_ALLOW_UNTESTED=true` downgrades this to a warning for anyone deliberately
 * trying a newer release.
 */
function assertSupportedPdfJs(loadedVersion?: string): void {
    // The version MUST come from the module that was actually imported. Reading it from
    // `require('pdfjs-dist/package.json')` uses CommonJS resolution while the loader above
    // uses ESM resolution, and in a project holding two copies — one hoisted, one nested —
    // those resolve to DIFFERENT installs. The check would then pass on the copy that isn't
    // parsing anything, which is worse than no check at all.
    let version = loadedVersion;
    if (!version) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            version = require('pdfjs-dist/package.json').version;
        } catch {
            return; // Version unreadable — not worth blocking on.
        }
    }
    if (!version) return;
    const major = Number(version.split('.')[0]);
    if (!Number.isFinite(major) || major === SUPPORTED_PDFJS_MAJOR) return;

    const message =
        `CSReportPdfExtractor: the loaded pdfjs-dist is ${version}, but PDF layout analysis is ` +
        `written and tested against ${SUPPORTED_PDFJS_MAJOR}.x. Text-item geometry differs ` +
        `between majors: a multi-word column heading that this version returns as ONE text ` +
        `item can come back as several, so the band header becomes a fragment, matches no ` +
        `spec column, and every row is dropped for want of a business key. ` +
        `Install the tested version alongside your project: ` +
        `npm install pdfjs-dist@${SUPPORTED_PDFJS_MAJOR}.10.38 --save-exact. ` +
        `Set REPORT_PDFJS_ALLOW_UNTESTED=true to proceed anyway.`;

    const allow = String(process.env['REPORT_PDFJS_ALLOW_UNTESTED'] ?? '').toLowerCase();
    if (allow === 'true' || allow === '1' || allow === 'yes') {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require('../reporter/CSReporter').CSReporter.warn(message);
        } catch {
            console.warn(message);
        }
        return;
    }
    throw new Error(message);
}

/** Optional overrides for `extractPagesFromPdf`. */
export interface PdfExtractionOptions {
    /** Injected loader — tests use this to avoid needing a real PDF on disk. */
    pdfjsLoader?: PdfJsLoader;
    /** When true, pdfjs preserves individual text items instead of coalescing runs (better for column detection). Default true. */
    disableCombineTextItems?: boolean;
    /**
     * Optional filter — return false to drop a text item at extraction time. Useful for
     * stripping known noise like watermarks. Applied per raw pdfjs item before conversion.
     */
    filterItem?: (item: PdfJsTextItem) => boolean;
    /** Concurrency for per-page extraction. Default 4 — pdfjs is CPU-bound, but the JS event loop dispatches waits usefully. */
    pageConcurrency?: number;
    /**
     * When true AND `ocrAdapter` is provided, any page pdfjs returned zero text items for
     * is re-run through OCR. Enable via `spec.ocrFallback` — mirrors that field's intent.
     */
    enableOcrFallback?: boolean;
    /** OCR engine adapter. Registered on the service; threaded down through the extractor. */
    ocrAdapter?: OcrAdapter;
    /**
     * Absolute path to the source PDF. Auto-populated by `extractPagesFromPdf`; callers of
     * `extractPagesFromBuffer` may pass it explicitly so OCR adapters can rasterize the file.
     * OCR fallback is skipped (with a warning) when the source path is unknown.
     */
    sourcePath?: string;
}

/**
 * Top-level: extract every page from `pdfPath` into `PageContent[]`. Handles reading
 * the file, initialising pdfjs, iterating pages, and normalising per-item output into
 * our own `TextItem` shape.
 *
 * Throws when the file doesn't exist or pdfjs fails to parse it — never returns partial
 * data quietly, because "silently missed a page" is the single most dangerous failure
 * mode for report validation.
 */
export async function extractPagesFromPdf(
    pdfPath: string,
    opts: PdfExtractionOptions = {},
): Promise<PageContent[]> {
    if (!fs.existsSync(pdfPath)) {
        throw new Error(`CSReportPdfExtractor: file not found: ${pdfPath}`);
    }
    const buffer = fs.readFileSync(pdfPath);
    // pdfjs mutates the input buffer — pass a fresh Uint8Array over a COPY so downstream
    // code that reuses the buffer isn't surprised by zeroed bytes.
    const data = new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    // Auto-set sourcePath so an OCR adapter downstream can rasterize the actual file.
    return await extractPagesFromBuffer(data, { ...opts, sourcePath: opts.sourcePath ?? pdfPath });
}

/**
 * Same as `extractPagesFromPdf` but takes a pre-loaded Uint8Array. Handy for tests +
 * for callers that already have the PDF bytes in memory (e.g. downloaded via API).
 */
export async function extractPagesFromBuffer(
    data: Uint8Array,
    opts: PdfExtractionOptions = {},
): Promise<PageContent[]> {
    const loader = opts.pdfjsLoader ?? (await defaultPdfJsLoader());
    const doc = await loader.getDocument({ data }).promise;
    const disableCombineTextItems = opts.disableCombineTextItems ?? true;
    const filterItem = opts.filterItem;
    const concurrency = Math.max(1, opts.pageConcurrency ?? 4);

    try {
        const pages: PageContent[] = new Array(doc.numPages);
        // Process pages in bounded parallel batches. pdfjs page-fetch is async I/O to its
        // own worker, so a few in flight overlaps nicely; too many just backs up the queue.
        for (let start = 1; start <= doc.numPages; start += concurrency) {
            const batch: Promise<void>[] = [];
            for (let n = start; n < start + concurrency && n <= doc.numPages; n++) {
                batch.push(
                    (async () => {
                        const page = await doc.getPage(n);
                        pages[n - 1] = await extractOnePage(page, n, { disableCombineTextItems, filterItem });
                        page.cleanup?.();
                    })(),
                );
            }
            await Promise.all(batch);
        }
        // OCR pass: rescue image-only pages (zero pdfjs text) when the caller opted in.
        // Serial by design — OCR engines are typically memory-hungry and parallelising
        // them fights the page-render already using RAM. Errors bubble; ingestion refuses
        // to silently produce a partial canonical when OCR was declared mandatory.
        if (opts.enableOcrFallback && opts.ocrAdapter) {
            for (let i = 0; i < pages.length; i++) {
                const page = pages[i];
                if (page.textItems.length > 0) continue;
                if (!opts.sourcePath) {
                    // Signal loudly. Silently dropping OCR would hide a real gap.
                    throw new Error(
                        `CSReportPdfExtractor: OCR fallback requested for page ${page.pageNumber} but ` +
                        `opts.sourcePath is unknown (call extractPagesFromPdf or set sourcePath explicitly).`,
                    );
                }
                const ocrItems = await opts.ocrAdapter.ocrPage({
                    filePath: opts.sourcePath,
                    pageNumber: page.pageNumber,
                    width: page.width,
                    height: page.height,
                });
                pages[i] = { ...page, textItems: ocrItems };
            }
        }
        return pages;
    } finally {
        try {
            doc.cleanup?.();
            if (doc.destroy) await doc.destroy();
        } catch {
            /* best-effort cleanup */
        }
    }
}

/** Extract one page from pdfjs into our `PageContent`. */
async function extractOnePage(
    page: PdfJsPage,
    pageNumber: number,
    opts: { disableCombineTextItems: boolean; filterItem?: (item: PdfJsTextItem) => boolean },
): Promise<PageContent> {
    const [x1, y1, x2, y2] = page.view;
    const width = x2 - x1;
    const height = y2 - y1;
    const content = await page.getTextContent({
        disableCombineTextItems: opts.disableCombineTextItems,
    });
    const textItems: TextItem[] = [];
    for (const rawItem of content.items) {
        // Skip marked-content markers — they're structure hints, not visible text.
        if (!('str' in rawItem)) continue;
        const item = rawItem as PdfJsTextItem;
        if (opts.filterItem && !opts.filterItem(item)) continue;
        if (item.str.length === 0) continue;
        textItems.push(normalizeItem(item));
    }
    return { pageNumber, width, height, textItems };
}

/**
 * Convert pdfjs's raw item into our canonical `TextItem`. Extracts rotation from the
 * transform matrix, computes font size from the transform's scale-y (pdfjs bakes the
 * point size into the matrix rather than surfacing it directly), and defaults color to
 * black when the producer didn't emit one.
 */
function normalizeItem(item: PdfJsTextItem): TextItem {
    // Transform is `[a, b, c, d, e, f]` — a 3x2 affine matrix in row-major form.
    //   x' = a*x + c*y + e
    //   y' = b*x + d*y + f
    // For unrotated horizontal text, b == c == 0 and a == d == fontSize.
    // For 90°-rotated text (rare in reports; occurs in some Crystal templates for narrow
    // column labels), a == 0, b == fontSize, c == -fontSize, d == 0.
    const [a, b, c, d, e, f] = item.transform;
    const fontSize = Math.hypot(a, b) || Math.hypot(c, d) || item.height || 0;
    // Rotation in degrees, positive counterclockwise. atan2(b, a) is the angle of the
    // first row of the matrix, which is the rendered x-axis direction. We negate to
    // match "reading direction rotates clockwise" convention (0 = horizontal, 90 = down).
    let rotation = Math.round((Math.atan2(b, a) * 180) / Math.PI);
    if (rotation < 0) rotation += 360;
    return {
        str: item.str,
        x: e,
        y: f,
        width: item.width,
        height: item.height || fontSize,
        fontSize,
        fontName: item.fontName,
        hasEOL: !!item.hasEOL,
        rotation,
        // pdfjs's text stream doesn't natively expose color; the color-carrying variant
        // lives in the operator list. Leaving undefined here; a follow-up commit can add
        // an optional color-enrichment pass that walks getOperatorList() when a spec
        // needs Pass/Fail color signals. For now, undefined = "no color info".
        color: undefined,
    };
}

/** Small helper — tests need to reset the cached loader between runs. */
export function _resetPdfJsLoaderCache(): void {
    cachedPdfJs = null;
}
