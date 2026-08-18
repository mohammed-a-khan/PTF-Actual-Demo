/**
 * CS Report Validation — OCR adapter contract.
 *
 * Some Crystal reports are exported as image-only PDFs (scanned or
 * rasterised at print time). pdfjs finds zero selectable text on those
 * pages; without OCR, extraction produces an empty canonical and the
 * reconciler cannot compare anything. `spec.ocrFallback: true` opts a
 * report in to an OCR pass for image-only pages.
 *
 * WHY AN INTERFACE (NOT A CONCRETE ADAPTER)
 * -----------------------------------------
 * Concrete OCR engines are heavy — tesseract.js is ~50MB WASM, Azure/AWS
 * cost money and need network access, node-canvas needs native compile.
 * Users pick their engine based on their VDI's constraints. The framework
 * ships the CONTRACT + wiring; consumers register the adapter that fits.
 *
 * DEFAULT
 * -------
 * `NoOpOcrAdapter` throws with a clear "no OCR adapter configured" message
 * when `spec.ocrFallback` is on but nothing was registered. Silently
 * returning `[]` would let extraction produce empty canonicals — a
 * confusing failure mode where the reconciler flags "everything missing".
 *
 * @module report-validation/CSReportOcrAdapter
 */

import type { TextItem } from './CSReportPdfTypes';

/** Context supplied to the OCR adapter for one page. */
export interface OcrPageContext {
    /** Absolute path to the source PDF. Adapters that need to rasterise use pdfjs' `page.render()` or a sibling tool. */
    filePath: string;
    /** 1-indexed page number within the source PDF. */
    pageNumber: number;
    /** Page width in PDF user-space points. */
    width: number;
    /** Page height in PDF user-space points. */
    height: number;
}

/**
 * Adapter contract: given one image-only page, return the `TextItem[]` that
 * downstream layout analysis will consume. Coordinates MUST be in PDF user-space
 * (matching what pdfjs produces for text-selectable pages) so the layout
 * analyzer treats OCR pages and text pages identically.
 */
export interface OcrAdapter {
    /**
     * OCR one page. Return an empty array only if the page is genuinely blank; empty
     * output on a page with visible text confuses the reconciler downstream.
     *
     * Throw if the OCR engine fails — the extractor catches and reports the error
     * so scenarios fail loudly rather than silently comparing partial data.
     */
    ocrPage(ctx: OcrPageContext): Promise<TextItem[]>;
}

/** Default adapter — fires only when `spec.ocrFallback` is on and no adapter was registered. */
export class NoOpOcrAdapter implements OcrAdapter {
    async ocrPage(ctx: OcrPageContext): Promise<TextItem[]> {
        throw new Error(
            `NoOpOcrAdapter: page ${ctx.pageNumber} of ${ctx.filePath} has zero selectable text ` +
            `and \`spec.ocrFallback\` is on, but no OcrAdapter was registered. ` +
            `Install an OCR engine (e.g. tesseract.js) and register an adapter via ` +
            `CSReportValidationService.registerOcrAdapter().`,
        );
    }
}
