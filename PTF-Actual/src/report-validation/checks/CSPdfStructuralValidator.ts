/**
 * PDF structural validator (§4).
 *
 * Enumerates and asserts against structural PDF features via pdfjs:
 *   - Bookmarks / outline tree — labels, targets, hierarchy depth
 *   - Optional Content Groups (layers) — presence + visibility
 *   - Page labels (roman-numeral prefaces, appendix numbering, etc.)
 *   - Annotation inventory (highlight/note/ink/popup — non-Link subtypes)
 *
 * Link annotations are covered by `CSPdfLinkValidator` — this module ignores
 * subtype 'Link' to keep concerns separated.
 *
 * @module report-validation/checks/CSPdfStructuralValidator
 */

import * as fs from 'fs';

export interface StructuralRule {
    /** Assert the flattened bookmark count. */
    bookmarkCount?: number;
    /** Assert every listed label appears as a bookmark title (case-sensitive substring match). */
    bookmarksInclude?: string[];
    /** Maximum bookmark tree depth (1-indexed root). */
    maxBookmarkDepth?: number;
    /** Assert every listed layer name exists (case-sensitive). */
    layersInclude?: string[];
    /** Assert layer count. */
    layerCount?: number;
    /** Assert page-label prefix at a given page index (e.g. { 1: "i", 2: "ii", 5: "1" }). */
    pageLabels?: Record<number, string>;
    /** Assert total annotation count (excluding Link subtype). */
    annotationCount?: number;
    /** Any annotation subtype in this list is FORBIDDEN. */
    forbiddenAnnotationSubtypes?: string[];
}

export interface StructuralFinding {
    kind:
        | 'BOOKMARK_COUNT_DRIFT'
        | 'BOOKMARK_MISSING'
        | 'BOOKMARK_DEPTH_EXCEEDED'
        | 'LAYER_MISSING'
        | 'LAYER_COUNT_DRIFT'
        | 'PAGE_LABEL_DRIFT'
        | 'ANNOTATION_COUNT_DRIFT'
        | 'ANNOTATION_FORBIDDEN';
    message: string;
    expected?: string;
    actual?: string;
    page?: number;
}

export interface StructuralInventory {
    bookmarks: Array<{ title: string; depth: number; hasTarget: boolean }>;
    layers: string[];
    pageLabels: string[];
    annotations: Array<{ page: number; subtype: string; contents?: string }>;
}

export async function readStructuralInventory(pdfPath: string): Promise<StructuralInventory> {
    if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const importDyn: any = new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")')();
    const pdfjs = await importDyn;
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;

    // Bookmarks — pdfjs `getOutline()` returns nested {title, dest?, url?, items?}.
    const bookmarks: StructuralInventory['bookmarks'] = [];
    const outline = await doc.getOutline().catch(() => null);
    if (outline) walkOutline(outline, 1, bookmarks);

    // Layers via OCG (optional content groups). pdfjs `getOptionalContentConfig()`.
    let layers: string[] = [];
    try {
        const cfg = await doc.getOptionalContentConfig();
        if (cfg) {
            const groups: unknown = (cfg as unknown as { getGroups?: () => Map<string, unknown> }).getGroups?.();
            if (groups instanceof Map) {
                for (const [, v] of groups) {
                    const g = v as { name?: string };
                    if (g && typeof g.name === 'string') layers.push(g.name);
                }
            }
        }
    } catch {
        /* not all PDFs have OCGs */
    }

    // Page labels — pdfjs `getPageLabels()` returns string[] indexed page-1.
    let pageLabels: string[] = [];
    try {
        pageLabels = (await doc.getPageLabels()) ?? [];
    } catch {
        /* not all PDFs have page labels */
    }

    // Annotations — enumerate per page, exclude Link (covered elsewhere).
    const annotations: StructuralInventory['annotations'] = [];
    for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const anns = await page.getAnnotations();
        for (const a of anns) {
            if (!a || a.subtype === 'Link') continue;
            annotations.push({
                page: p,
                subtype: String(a.subtype ?? 'Unknown'),
                contents: typeof a.contents === 'string' ? a.contents : undefined,
            });
        }
    }
    try {
        await doc.destroy();
    } catch {
        /* best-effort */
    }
    return { bookmarks, layers, pageLabels, annotations };
}

function walkOutline(
    items: Array<{ title: string; dest?: unknown; url?: string; items?: Array<unknown> }>,
    depth: number,
    out: StructuralInventory['bookmarks'],
): void {
    for (const item of items) {
        out.push({
            title: item.title,
            depth,
            hasTarget: item.dest !== undefined || item.url !== undefined,
        });
        if (item.items && item.items.length > 0) {
            walkOutline(
                item.items as Array<{ title: string; dest?: unknown; url?: string; items?: Array<unknown> }>,
                depth + 1,
                out,
            );
        }
    }
}

export function validateStructural(inv: StructuralInventory, rule: StructuralRule): StructuralFinding[] {
    const findings: StructuralFinding[] = [];

    if (rule.bookmarkCount !== undefined && inv.bookmarks.length !== rule.bookmarkCount) {
        findings.push({
            kind: 'BOOKMARK_COUNT_DRIFT',
            message: `Expected ${rule.bookmarkCount} bookmarks, found ${inv.bookmarks.length}`,
            expected: String(rule.bookmarkCount),
            actual: String(inv.bookmarks.length),
        });
    }
    if (rule.bookmarksInclude) {
        const titles = inv.bookmarks.map((b) => b.title);
        for (const req of rule.bookmarksInclude) {
            if (!titles.some((t) => t.includes(req))) {
                findings.push({
                    kind: 'BOOKMARK_MISSING',
                    message: `Required bookmark "${req}" not found`,
                    expected: req,
                });
            }
        }
    }
    if (rule.maxBookmarkDepth !== undefined) {
        for (const b of inv.bookmarks) {
            if (b.depth > rule.maxBookmarkDepth) {
                findings.push({
                    kind: 'BOOKMARK_DEPTH_EXCEEDED',
                    message: `Bookmark "${b.title}" is nested at depth ${b.depth}, exceeds max ${rule.maxBookmarkDepth}`,
                    expected: `≤ ${rule.maxBookmarkDepth}`,
                    actual: String(b.depth),
                });
            }
        }
    }
    if (rule.layerCount !== undefined && inv.layers.length !== rule.layerCount) {
        findings.push({
            kind: 'LAYER_COUNT_DRIFT',
            message: `Expected ${rule.layerCount} layers, found ${inv.layers.length}`,
            expected: String(rule.layerCount),
            actual: String(inv.layers.length),
        });
    }
    if (rule.layersInclude) {
        for (const req of rule.layersInclude) {
            if (!inv.layers.includes(req)) {
                findings.push({
                    kind: 'LAYER_MISSING',
                    message: `Required layer "${req}" not found`,
                    expected: req,
                });
            }
        }
    }
    if (rule.pageLabels) {
        for (const [pStr, expected] of Object.entries(rule.pageLabels)) {
            const idx = parseInt(pStr, 10) - 1;
            const actual = inv.pageLabels[idx];
            if (actual !== expected) {
                findings.push({
                    kind: 'PAGE_LABEL_DRIFT',
                    message: `Page ${idx + 1} label mismatch`,
                    page: idx + 1,
                    expected,
                    actual: actual ?? '(none)',
                });
            }
        }
    }
    if (rule.annotationCount !== undefined && inv.annotations.length !== rule.annotationCount) {
        findings.push({
            kind: 'ANNOTATION_COUNT_DRIFT',
            message: `Expected ${rule.annotationCount} non-Link annotations, found ${inv.annotations.length}`,
            expected: String(rule.annotationCount),
            actual: String(inv.annotations.length),
        });
    }
    if (rule.forbiddenAnnotationSubtypes) {
        const forbid = new Set(rule.forbiddenAnnotationSubtypes);
        for (const a of inv.annotations) {
            if (forbid.has(a.subtype)) {
                findings.push({
                    kind: 'ANNOTATION_FORBIDDEN',
                    message: `Forbidden annotation subtype "${a.subtype}" on page ${a.page}`,
                    page: a.page,
                    actual: a.subtype,
                });
            }
        }
    }
    return findings;
}
