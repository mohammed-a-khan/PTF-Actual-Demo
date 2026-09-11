/**
 * PDF barcode validator (Phase 5 / §11).
 *
 * Decodes 1D/2D barcodes visible on rendered PDF pages using `@zxing/library`
 * (Apache-2.0). Assertions:
 *   - Barcode count / per-page count
 *   - Every named barcode text must appear (case-sensitive equality)
 *   - Every payload must be checksum-valid (delegated to zxing decoder)
 *   - Format allow-list (QR_CODE / CODE_128 / EAN_13 / PDF_417 …)
 *
 * Both `@napi-rs/canvas` (for rasterizing the page) and `@zxing/library`
 * are soft-imported so the framework compiles + runs without them; a
 * missing dep surfaces exactly one MISSING_BARCODE_DEP finding.
 *
 * @module report-validation/checks/CSPdfBarcodeValidator
 */

import * as fs from 'fs';

export interface BarcodeRule {
    /** Assert total barcode count. */
    barcodeCount?: number;
    /** Assert per-page barcode count. */
    barcodeCountByPage?: Record<number, number>;
    /** Every payload must be present (exact text match). */
    payloadsMustExist?: string[];
    /** Format allow-list. Empty ⇒ any format allowed. */
    formatsAllowed?: string[];
    /** Render scale — dpi ≈ 72 * scale. Default 3 (216 dpi, needed for reliable decode). */
    scale?: number;
}

export interface BarcodeFinding {
    kind:
        | 'BARCODE_COUNT_DRIFT'
        | 'BARCODE_PAGE_COUNT_DRIFT'
        | 'BARCODE_PAYLOAD_MISSING'
        | 'BARCODE_FORMAT_FORBIDDEN'
        | 'MISSING_BARCODE_DEP';
    message: string;
    page?: number;
    expected?: string;
    actual?: string;
    format?: string;
    payload?: string;
}

export interface BarcodeInventory {
    barcodes: Array<{ page: number; text: string; format: string }>;
}

export async function readBarcodeInventory(pdfPath: string, scale = 3): Promise<BarcodeInventory> {
    if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let canvas: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let zxing: any;
    try {
        canvas = await new Function('return import("@napi-rs/canvas")')();
        zxing = await new Function('return import("@zxing/library")')();
    } catch {
        throw new Error(
            'Barcode validation requires optional dev deps. Run: npm i -D @napi-rs/canvas @zxing/library',
        );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfjs: any = await new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")')();
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;

    const barcodes: BarcodeInventory['barcodes'] = [];
    const reader = new zxing.MultiFormatReader();
    const hints = new Map();
    hints.set(zxing.DecodeHintType.TRY_HARDER, true);
    reader.setHints(hints);
    const LuminanceSourceCtor = zxing.RGBLuminanceSource;
    const BinaryBitmap = zxing.BinaryBitmap;
    const HybridBinarizer = zxing.HybridBinarizer;

    for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale });
        const width = Math.ceil(viewport.width);
        const height = Math.ceil(viewport.height);
        const cnv = canvas.createCanvas(width, height);
        const ctx = cnv.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const imgData = ctx.getImageData(0, 0, width, height);
        // ZXing expects a plain RGB (no alpha) luminance source in some builds; try both.
        try {
            const source = new LuminanceSourceCtor(imgData.data as unknown as Uint8ClampedArray, width, height);
            const bitmap = new BinaryBitmap(new HybridBinarizer(source));
            const result = reader.decode(bitmap);
            if (result && typeof result.getText === 'function') {
                barcodes.push({
                    page: p,
                    text: String(result.getText()),
                    format: String(result.getBarcodeFormat?.() ?? 'UNKNOWN'),
                });
            }
        } catch {
            /* no barcode on this page */
        } finally {
            reader.reset();
        }
    }
    try {
        await doc.destroy();
    } catch {
        /* best-effort */
    }
    return { barcodes };
}

export async function validateBarcodes(pdfPath: string, rule: BarcodeRule): Promise<BarcodeFinding[]> {
    let inv: BarcodeInventory;
    try {
        inv = await readBarcodeInventory(pdfPath, rule.scale ?? 3);
    } catch (e) {
        return [
            {
                kind: 'MISSING_BARCODE_DEP',
                message: (e as Error).message,
            },
        ];
    }

    const findings: BarcodeFinding[] = [];
    if (rule.barcodeCount !== undefined && inv.barcodes.length !== rule.barcodeCount) {
        findings.push({
            kind: 'BARCODE_COUNT_DRIFT',
            message: `Expected ${rule.barcodeCount} barcodes, found ${inv.barcodes.length}`,
            expected: String(rule.barcodeCount),
            actual: String(inv.barcodes.length),
        });
    }
    if (rule.barcodeCountByPage) {
        const byPage: Record<number, number> = {};
        for (const b of inv.barcodes) byPage[b.page] = (byPage[b.page] ?? 0) + 1;
        for (const [pStr, expected] of Object.entries(rule.barcodeCountByPage)) {
            const p = parseInt(pStr, 10);
            const actual = byPage[p] ?? 0;
            if (actual !== expected) {
                findings.push({
                    kind: 'BARCODE_PAGE_COUNT_DRIFT',
                    message: `Page ${p} expected ${expected} barcode(s), found ${actual}`,
                    page: p,
                    expected: String(expected),
                    actual: String(actual),
                });
            }
        }
    }
    if (rule.payloadsMustExist) {
        const seen = new Set(inv.barcodes.map((b) => b.text));
        for (const req of rule.payloadsMustExist) {
            if (!seen.has(req)) {
                findings.push({
                    kind: 'BARCODE_PAYLOAD_MISSING',
                    message: `Expected barcode payload "${req}" not decoded`,
                    payload: req,
                    expected: req,
                });
            }
        }
    }
    if (rule.formatsAllowed && rule.formatsAllowed.length > 0) {
        const allowed = new Set(rule.formatsAllowed);
        for (const b of inv.barcodes) {
            if (!allowed.has(b.format)) {
                findings.push({
                    kind: 'BARCODE_FORMAT_FORBIDDEN',
                    message: `Barcode format "${b.format}" on page ${b.page} not on allow-list`,
                    page: b.page,
                    format: b.format,
                    payload: b.text,
                    actual: b.format,
                });
            }
        }
    }
    return findings;
}
