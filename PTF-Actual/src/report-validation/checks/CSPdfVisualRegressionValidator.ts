/**
 * PDF visual-regression validator (Phase 4 / §11).
 *
 * Renders every page of the PDF to a PNG raster and compares pixel-by-pixel
 * against a persisted baseline. Failing pages produce a diff image and a
 * pixel-count finding.
 *
 * Runtime deps are BOTH soft-imported so the framework compiles and unit-runs
 * even when a consumer hasn't opted into rendering. On first call we
 * dynamically load:
 *
 *   - `@napi-rs/canvas` — MIT, prebuilt binaries, no native compile
 *   - `pixelmatch`     — ISC, pure JS pixel comparator
 *
 * When either fails to load we return a single `MISSING_RENDER_DEP` finding
 * so the consumer sees exactly which optional dep to `npm i`.
 *
 * Baseline directory layout:
 *   <baselineDir>/<pdfBaseName>/page-<N>.png     — golden image
 *   <outputDir>/<pdfBaseName>/page-<N>.actual.png — this run
 *   <outputDir>/<pdfBaseName>/page-<N>.diff.png   — diff overlay
 *
 * On first-ever run against a baseline (no golden yet), the actual PNG is
 * copied to the baseline directory and the run passes with a MISSING_BASELINE
 * warning-level finding — consumers explicitly opt into "record baseline"
 * with `updateBaseline: true`.
 *
 * @module report-validation/checks/CSPdfVisualRegressionValidator
 */

import * as fs from 'fs';
import * as path from 'path';

export interface VisualRegressionRule {
    /** Directory of golden PNGs to diff against. */
    baselineDir: string;
    /** Where to write .actual / .diff PNGs. */
    outputDir: string;
    /** Maximum allowed different-pixel ratio per page (0..1). Default 0.001 (0.1%). */
    maxPixelDiffRatio?: number;
    /** pixelmatch threshold — 0 strict, 1 lax. Default 0.1. */
    matchThreshold?: number;
    /** If true, overwrite the baseline with this run's output. Use to record new baselines. */
    updateBaseline?: boolean;
    /** Optional page selector — only these 1-indexed pages are diffed. */
    pages?: number[];
    /** Render scale — dpi ≈ 72 * scale. Default 2 (144 dpi). */
    scale?: number;
}

export interface VisualRegressionFinding {
    kind: 'PIXEL_DIFF_ABOVE_THRESHOLD' | 'MISSING_BASELINE' | 'BASELINE_UPDATED' | 'MISSING_RENDER_DEP';
    message: string;
    page?: number;
    baselinePath?: string;
    actualPath?: string;
    diffPath?: string;
    diffRatio?: number;
    expected?: string;
    actual?: string;
}

export async function validateVisualRegression(
    pdfPath: string,
    rule: VisualRegressionRule,
): Promise<VisualRegressionFinding[]> {
    if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let canvas: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let pixelmatch: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let PNG: any;
    try {
        canvas = await new Function('return import("@napi-rs/canvas")')();
        pixelmatch = (await new Function('return import("pixelmatch")')()).default;
        PNG = (await new Function('return import("pngjs")')()).PNG;
    } catch (e) {
        return [
            {
                kind: 'MISSING_RENDER_DEP',
                message: `Visual regression requires optional dev deps to be installed: ${(e as Error).message}. Run \`npm i -D @napi-rs/canvas pixelmatch pngjs\`.`,
            },
        ];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfjs: any = await new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")')();
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;

    const findings: VisualRegressionFinding[] = [];
    const scale = rule.scale ?? 2;
    const maxRatio = rule.maxPixelDiffRatio ?? 0.001;
    const threshold = rule.matchThreshold ?? 0.1;

    const baseName = path.basename(pdfPath, path.extname(pdfPath));
    const baselineRoot = path.join(rule.baselineDir, baseName);
    const outputRoot = path.join(rule.outputDir, baseName);
    fs.mkdirSync(baselineRoot, { recursive: true });
    fs.mkdirSync(outputRoot, { recursive: true });

    const pagesToRender = rule.pages ?? Array.from({ length: doc.numPages }, (_, i) => i + 1);

    for (const p of pagesToRender) {
        if (p < 1 || p > doc.numPages) continue;
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale });
        const width = Math.ceil(viewport.width);
        const height = Math.ceil(viewport.height);
        const cnv = canvas.createCanvas(width, height);
        const ctx = cnv.getContext('2d');
        // white background so semi-transparent pages don't look weird.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const actualPng = cnv.toBuffer('image/png');
        const actualPath = path.join(outputRoot, `page-${p}.actual.png`);
        fs.writeFileSync(actualPath, actualPng);

        const baselinePath = path.join(baselineRoot, `page-${p}.png`);
        if (!fs.existsSync(baselinePath) || rule.updateBaseline) {
            fs.writeFileSync(baselinePath, actualPng);
            findings.push({
                kind: rule.updateBaseline ? 'BASELINE_UPDATED' : 'MISSING_BASELINE',
                message: rule.updateBaseline
                    ? `Baseline page ${p} overwritten (updateBaseline: true).`
                    : `Baseline page ${p} did not exist — recorded from this run. Rerun to diff.`,
                page: p,
                baselinePath,
                actualPath,
            });
            continue;
        }

        // Decode both PNGs into raw RGBA.
        const baselineBuf = fs.readFileSync(baselinePath);
        const b = PNG.sync.read(baselineBuf);
        const a = PNG.sync.read(actualPng);
        if (b.width !== a.width || b.height !== a.height) {
            findings.push({
                kind: 'PIXEL_DIFF_ABOVE_THRESHOLD',
                message: `Page ${p} dimensions differ: baseline ${b.width}×${b.height} vs actual ${a.width}×${a.height}`,
                page: p,
                baselinePath,
                actualPath,
                expected: `${b.width}×${b.height}`,
                actual: `${a.width}×${a.height}`,
            });
            continue;
        }
        const diff = new PNG({ width: a.width, height: a.height });
        const diffCount = pixelmatch(b.data, a.data, diff.data, a.width, a.height, { threshold });
        const total = a.width * a.height;
        const ratio = total === 0 ? 0 : diffCount / total;
        const diffPath = path.join(outputRoot, `page-${p}.diff.png`);
        fs.writeFileSync(diffPath, PNG.sync.write(diff));
        if (ratio > maxRatio) {
            findings.push({
                kind: 'PIXEL_DIFF_ABOVE_THRESHOLD',
                message: `Page ${p} pixel-diff ${(ratio * 100).toFixed(3)}% exceeds max ${(maxRatio * 100).toFixed(3)}%`,
                page: p,
                baselinePath,
                actualPath,
                diffPath,
                diffRatio: ratio,
                expected: `≤ ${(maxRatio * 100).toFixed(3)}%`,
                actual: `${(ratio * 100).toFixed(3)}%`,
            });
        }
    }
    try {
        await doc.destroy();
    } catch {
        /* best-effort */
    }
    return findings;
}
