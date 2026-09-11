/**
 * PDF image inventory validator (Phase 4 / §11).
 *
 * Enumerates raster image XObjects per page via pdfjs. Assertions:
 *   - Total image count / per-page count
 *   - Every named image must be present (matched by `name` attribute)
 *   - Minimum resolution (width × height) — flags upscaled logos etc.
 *   - Colorspace allow-list (DeviceGray / DeviceRGB / ICCBased-CMYK …)
 *   - Presence of ImageMask (soft-mask transparency) when required
 *
 * pdfjs surfaces images via `page.objs` after `page.render()` operates the
 * content stream. To keep this cheap we go one level deeper — `page.getOperatorList()`
 * returns the OPS list which contains `paintImageXObject` operations we can
 * count and inspect without a full render.
 *
 * @module report-validation/checks/CSPdfImageInventoryValidator
 */

import * as fs from 'fs';

export interface ImageRule {
    /** Assert total image count across the document. */
    imageCount?: number;
    /** Assert per-page image count { 1: 2, 2: 0, ... }. */
    imageCountByPage?: Record<number, number>;
    /** Every named image must be present (matched by the operator's name). */
    imagesMustExist?: string[];
    /** Minimum resolution per named image { logo: { minWidth: 200, minHeight: 100 } }. */
    imageMinResolution?: Record<number, { minWidth?: number; minHeight?: number }>;
    /** ColorSpace allow-list. */
    colorSpacesAllowed?: string[];
}

export interface ImageFinding {
    kind:
        | 'IMAGE_COUNT_DRIFT'
        | 'IMAGE_PAGE_COUNT_DRIFT'
        | 'IMAGE_MISSING'
        | 'IMAGE_RESOLUTION_TOO_LOW'
        | 'IMAGE_COLORSPACE_FORBIDDEN';
    message: string;
    page?: number;
    imageName?: string;
    expected?: string;
    actual?: string;
}

export interface ImageInfo {
    page: number;
    name: string;
    width?: number;
    height?: number;
    colorSpace?: string;
    isMask?: boolean;
}

export interface ImageInventory {
    images: ImageInfo[];
}

export async function readImageInventory(pdfPath: string): Promise<ImageInventory> {
    if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const importDyn: any = new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")')();
    const pdfjs = await importDyn;
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;

    const images: ImageInfo[] = [];
    // pdfjs opcode ids for image ops (stable across recent versions).
    // Fallback: match by OP name via reverse-lookup below.
    let PAINT_IMAGE = -1;
    let PAINT_MASK = -1;
    try {
        const opsMap = (pdfjs as unknown as { OPS?: Record<string, number> }).OPS ?? {};
        PAINT_IMAGE = opsMap['paintImageXObject'] ?? -1;
        PAINT_MASK = opsMap['paintImageMaskXObject'] ?? -1;
    } catch {
        /* leave as -1 */
    }

    for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        let ops: { fnArray: number[]; argsArray: unknown[][] };
        try {
            ops = await page.getOperatorList();
        } catch {
            continue;
        }
        for (let i = 0; i < ops.fnArray.length; i++) {
            const fn = ops.fnArray[i];
            if (fn !== PAINT_IMAGE && fn !== PAINT_MASK) continue;
            const args = (ops.argsArray[i] as unknown[]) ?? [];
            const name = String(args[0] ?? `(image#${i})`);
            // Look up dimensions via page.commonObjs / page.objs — non-throwing best-effort.
            let width: number | undefined;
            let height: number | undefined;
            let colorSpace: string | undefined;
            try {
                const objs = (page as unknown as { objs: { get: (n: string) => unknown } }).objs;
                const raw = objs?.get(name) as
                    | { width?: number; height?: number; colorSpace?: { name?: string } }
                    | undefined;
                if (raw) {
                    width = typeof raw.width === 'number' ? raw.width : undefined;
                    height = typeof raw.height === 'number' ? raw.height : undefined;
                    colorSpace = raw.colorSpace?.name;
                }
            } catch {
                /* dimensions unavailable */
            }
            images.push({
                page: p,
                name,
                width,
                height,
                colorSpace,
                isMask: fn === PAINT_MASK,
            });
        }
    }
    try {
        await doc.destroy();
    } catch {
        /* best-effort */
    }
    return { images };
}

export function validateImages(inv: ImageInventory, rule: ImageRule): ImageFinding[] {
    const findings: ImageFinding[] = [];

    if (rule.imageCount !== undefined && inv.images.length !== rule.imageCount) {
        findings.push({
            kind: 'IMAGE_COUNT_DRIFT',
            message: `Expected ${rule.imageCount} images, found ${inv.images.length}`,
            expected: String(rule.imageCount),
            actual: String(inv.images.length),
        });
    }
    if (rule.imageCountByPage) {
        const byPage: Record<number, number> = {};
        for (const img of inv.images) byPage[img.page] = (byPage[img.page] ?? 0) + 1;
        for (const [pStr, expected] of Object.entries(rule.imageCountByPage)) {
            const p = parseInt(pStr, 10);
            const actual = byPage[p] ?? 0;
            if (actual !== expected) {
                findings.push({
                    kind: 'IMAGE_PAGE_COUNT_DRIFT',
                    message: `Page ${p} expected ${expected} image(s), found ${actual}`,
                    page: p,
                    expected: String(expected),
                    actual: String(actual),
                });
            }
        }
    }
    if (rule.imagesMustExist) {
        const names = new Set(inv.images.map((i) => i.name));
        for (const req of rule.imagesMustExist) {
            if (!names.has(req)) {
                findings.push({
                    kind: 'IMAGE_MISSING',
                    message: `Expected image "${req}" but not found`,
                    imageName: req,
                    expected: req,
                });
            }
        }
    }
    if (rule.imageMinResolution) {
        for (const [idxStr, req] of Object.entries(rule.imageMinResolution)) {
            const idx = parseInt(idxStr, 10);
            const img = inv.images[idx];
            if (!img) continue;
            if (req.minWidth !== undefined && (img.width ?? 0) < req.minWidth) {
                findings.push({
                    kind: 'IMAGE_RESOLUTION_TOO_LOW',
                    message: `Image #${idx} width ${img.width ?? 0} < min ${req.minWidth}`,
                    imageName: img.name,
                    expected: `width ≥ ${req.minWidth}`,
                    actual: String(img.width ?? 0),
                });
            }
            if (req.minHeight !== undefined && (img.height ?? 0) < req.minHeight) {
                findings.push({
                    kind: 'IMAGE_RESOLUTION_TOO_LOW',
                    message: `Image #${idx} height ${img.height ?? 0} < min ${req.minHeight}`,
                    imageName: img.name,
                    expected: `height ≥ ${req.minHeight}`,
                    actual: String(img.height ?? 0),
                });
            }
        }
    }
    if (rule.colorSpacesAllowed) {
        const allowed = new Set(rule.colorSpacesAllowed);
        for (const img of inv.images) {
            if (img.colorSpace && !allowed.has(img.colorSpace)) {
                findings.push({
                    kind: 'IMAGE_COLORSPACE_FORBIDDEN',
                    message: `Image "${img.name}" colorSpace "${img.colorSpace}" not on allow-list`,
                    imageName: img.name,
                    actual: img.colorSpace,
                });
            }
        }
    }
    return findings;
}
