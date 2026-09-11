/**
 * PDF page-layout validator (§2).
 *
 * Reads page-level geometry from pdfjs: `numPages`, per-page `view`
 * (MediaBox), rotation, and derived orientation (portrait/landscape).
 * Detects blank pages (page has fewer than N text items — configurable).
 *
 * @module report-validation/checks/CSPdfLayoutValidator
 */

import * as fs from 'fs';

export interface LayoutRule {
    /** Assert the total page count. */
    pageCount?: number;
    /** Assert the page count is ≥ this. */
    minPageCount?: number;
    /** Assert the page count is ≤ this. */
    maxPageCount?: number;
    /** Every page must have this orientation. */
    orientation?: 'portrait' | 'landscape';
    /** Every page must be one of these standard sizes (case-insensitive). */
    pageSize?: 'Letter' | 'Legal' | 'A4' | 'A3' | 'Tabloid';
    /** MediaBox width tolerance in PDF points (default 2). */
    sizeTolerance?: number;
    /**
     * Assert no page is "blank" — has < `minTextItemsPerPage` text items.
     * Common source of extraction bugs where a page silently renders empty.
     */
    minTextItemsPerPage?: number;
}

export interface LayoutFinding {
    kind:
        | 'LAYOUT_PAGE_COUNT_DRIFT'
        | 'LAYOUT_ORIENTATION_DRIFT'
        | 'LAYOUT_PAGE_SIZE_DRIFT'
        | 'LAYOUT_BLANK_PAGE';
    message: string;
    page?: number;
    expected?: string;
    actual?: string;
}

interface RawLayoutInfo {
    pageCount: number;
    pages: Array<{ pageNumber: number; width: number; height: number; rotation: number; textItemCount: number }>;
}

const STANDARD_PAGE_SIZES: Record<string, { width: number; height: number }> = {
    letter: { width: 612, height: 792 },
    legal: { width: 612, height: 1008 },
    a4: { width: 595, height: 842 },
    a3: { width: 842, height: 1191 },
    tabloid: { width: 792, height: 1224 },
};

export async function readLayoutInfo(pdfPath: string): Promise<RawLayoutInfo> {
    if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const importDyn: any = new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")')();
    const pdfjs = await importDyn;
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
    const pages: RawLayoutInfo['pages'] = [];
    for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const [x1, y1, x2, y2] = page.view;
        const width = x2 - x1;
        const height = y2 - y1;
        const content = await page.getTextContent();
        pages.push({
            pageNumber: p,
            width,
            height,
            rotation: page.rotate ?? 0,
            textItemCount: content.items.length,
        });
    }
    try {
        await doc.destroy();
    } catch {
        /* best-effort */
    }
    return { pageCount: doc.numPages, pages };
}

export function validateLayout(info: RawLayoutInfo, rule: LayoutRule): LayoutFinding[] {
    const findings: LayoutFinding[] = [];
    const tol = rule.sizeTolerance ?? 2;

    if (rule.pageCount !== undefined && info.pageCount !== rule.pageCount) {
        findings.push({
            kind: 'LAYOUT_PAGE_COUNT_DRIFT',
            message: `Expected ${rule.pageCount} page(s), got ${info.pageCount}`,
            expected: String(rule.pageCount),
            actual: String(info.pageCount),
        });
    }
    if (rule.minPageCount !== undefined && info.pageCount < rule.minPageCount) {
        findings.push({
            kind: 'LAYOUT_PAGE_COUNT_DRIFT',
            message: `Expected ≥ ${rule.minPageCount} page(s), got ${info.pageCount}`,
            expected: `≥ ${rule.minPageCount}`,
            actual: String(info.pageCount),
        });
    }
    if (rule.maxPageCount !== undefined && info.pageCount > rule.maxPageCount) {
        findings.push({
            kind: 'LAYOUT_PAGE_COUNT_DRIFT',
            message: `Expected ≤ ${rule.maxPageCount} page(s), got ${info.pageCount}`,
            expected: `≤ ${rule.maxPageCount}`,
            actual: String(info.pageCount),
        });
    }

    for (const p of info.pages) {
        if (rule.orientation) {
            // Accounting for /Rotate: a landscape page rendered rotated is portrait post-rotation.
            const effectiveIsLandscape =
                (p.width > p.height && (p.rotation === 0 || p.rotation === 180)) ||
                (p.height > p.width && (p.rotation === 90 || p.rotation === 270));
            const actual = effectiveIsLandscape ? 'landscape' : 'portrait';
            if (actual !== rule.orientation) {
                findings.push({
                    kind: 'LAYOUT_ORIENTATION_DRIFT',
                    message: `Page ${p.pageNumber} orientation "${actual}" (expected "${rule.orientation}")`,
                    page: p.pageNumber,
                    expected: rule.orientation,
                    actual,
                });
            }
        }
        if (rule.pageSize) {
            const std = STANDARD_PAGE_SIZES[rule.pageSize.toLowerCase()];
            if (std) {
                const matches =
                    (Math.abs(p.width - std.width) <= tol && Math.abs(p.height - std.height) <= tol) ||
                    // Landscape orientation of the same size
                    (Math.abs(p.width - std.height) <= tol && Math.abs(p.height - std.width) <= tol);
                if (!matches) {
                    findings.push({
                        kind: 'LAYOUT_PAGE_SIZE_DRIFT',
                        message: `Page ${p.pageNumber} size ${p.width}×${p.height}pt does not match ${rule.pageSize} (${std.width}×${std.height})`,
                        page: p.pageNumber,
                        expected: `${rule.pageSize} (${std.width}×${std.height})`,
                        actual: `${p.width}×${p.height}`,
                    });
                }
            }
        }
        if (rule.minTextItemsPerPage !== undefined && p.textItemCount < rule.minTextItemsPerPage) {
            findings.push({
                kind: 'LAYOUT_BLANK_PAGE',
                message: `Page ${p.pageNumber} appears blank (${p.textItemCount} text items, expected ≥ ${rule.minTextItemsPerPage})`,
                page: p.pageNumber,
                expected: `≥ ${rule.minTextItemsPerPage} text items`,
                actual: `${p.textItemCount}`,
            });
        }
    }

    return findings;
}
