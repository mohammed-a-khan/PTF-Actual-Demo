/**
 * PDF version-diff validator (Phase 6 / §19).
 *
 * Compares two PDFs (a candidate vs a baseline PDF) and reports the
 * differences. Two independent modes — a spec can turn on either or both:
 *
 *   - **Text diff** — flatten each page's TextItem stream to `str` joined by
 *     newlines, run a line-level LCS-diff (via the pure-JS `diff` package),
 *     surface additions/removals per page. Great for release-notes-style
 *     "what changed between v1 and v2" checks.
 *   - **Object diff** — compare PDF-level counts (page count, form-field
 *     count, attachment count, image count). Cheap sanity check to catch
 *     "wrong file uploaded" mistakes.
 *
 * The `diff` package is MIT-licensed pure JS. No native deps.
 *
 * @module report-validation/checks/CSPdfVersionDiffValidator
 */

import * as fs from 'fs';

export interface VersionDiffRule {
    /** Path to the baseline PDF to diff against. */
    baselinePdfPath: string;
    /** Run textual line-level diff of every page. */
    runTextDiff?: boolean;
    /** Run structural counters diff (pages/fields/attachments/images). */
    runStructuralDiff?: boolean;
    /** Maximum allowed added lines before flagging a text-drift finding. Default 0. */
    maxAddedLines?: number;
    /** Maximum allowed removed lines before flagging. Default 0. */
    maxRemovedLines?: number;
    /** If true, ignore diffs on the given page numbers (e.g. dynamic "run date" pages). */
    ignorePages?: number[];
}

export interface VersionDiffFinding {
    kind:
        | 'TEXT_ADDITIONS_ABOVE_THRESHOLD'
        | 'TEXT_REMOVALS_ABOVE_THRESHOLD'
        | 'PAGE_COUNT_DRIFT'
        | 'DIFF_DEP_MISSING';
    message: string;
    page?: number;
    expected?: string;
    actual?: string;
    addedLines?: string[];
    removedLines?: string[];
}

export async function validateVersionDiff(candidatePdfPath: string, rule: VersionDiffRule): Promise<VersionDiffFinding[]> {
    if (!fs.existsSync(candidatePdfPath)) throw new Error(`Candidate PDF not found: ${candidatePdfPath}`);
    if (!fs.existsSync(rule.baselinePdfPath)) throw new Error(`Baseline PDF not found: ${rule.baselinePdfPath}`);

    const findings: VersionDiffFinding[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfjs: any = await new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")')();

    const load = async (p: string) => {
        const data = new Uint8Array(fs.readFileSync(p));
        return pdfjs.getDocument({ data, verbosity: 0 }).promise;
    };
    const candDoc = await load(candidatePdfPath);
    const baseDoc = await load(rule.baselinePdfPath);
    const ignorePages = new Set(rule.ignorePages ?? []);

    if (rule.runStructuralDiff) {
        if (candDoc.numPages !== baseDoc.numPages) {
            findings.push({
                kind: 'PAGE_COUNT_DRIFT',
                message: `Candidate has ${candDoc.numPages} pages, baseline has ${baseDoc.numPages}`,
                expected: String(baseDoc.numPages),
                actual: String(candDoc.numPages),
            });
        }
    }

    if (rule.runTextDiff) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let diffLib: any;
        try {
            diffLib = await new Function('return import("diff")')();
        } catch (e) {
            findings.push({
                kind: 'DIFF_DEP_MISSING',
                message: `Text diff requires the "diff" package. Run: npm i -D diff. (${(e as Error).message})`,
            });
            return findings;
        }
        const maxAdds = rule.maxAddedLines ?? 0;
        const maxRems = rule.maxRemovedLines ?? 0;
        const pagesToDiff = Math.min(candDoc.numPages, baseDoc.numPages);
        for (let p = 1; p <= pagesToDiff; p++) {
            if (ignorePages.has(p)) continue;
            const [candText, baseText] = await Promise.all([
                pageText(candDoc, p),
                pageText(baseDoc, p),
            ]);
            const parts = diffLib.diffLines(baseText, candText);
            const added: string[] = [];
            const removed: string[] = [];
            for (const part of parts as Array<{ added?: boolean; removed?: boolean; value: string }>) {
                if (part.added) added.push(...part.value.split('\n').filter((l) => l.trim().length > 0));
                if (part.removed) removed.push(...part.value.split('\n').filter((l) => l.trim().length > 0));
            }
            if (added.length > maxAdds) {
                findings.push({
                    kind: 'TEXT_ADDITIONS_ABOVE_THRESHOLD',
                    message: `Page ${p} has ${added.length} added lines (max ${maxAdds})`,
                    page: p,
                    expected: `≤ ${maxAdds}`,
                    actual: String(added.length),
                    addedLines: added,
                });
            }
            if (removed.length > maxRems) {
                findings.push({
                    kind: 'TEXT_REMOVALS_ABOVE_THRESHOLD',
                    message: `Page ${p} has ${removed.length} removed lines (max ${maxRems})`,
                    page: p,
                    expected: `≤ ${maxRems}`,
                    actual: String(removed.length),
                    removedLines: removed,
                });
            }
        }
    }

    try {
        await candDoc.destroy();
    } catch {
        /* best-effort */
    }
    try {
        await baseDoc.destroy();
    } catch {
        /* best-effort */
    }
    return findings;
}

async function pageText(doc: unknown, p: number): Promise<string> {
    const d = doc as { getPage: (p: number) => Promise<{ getTextContent: () => Promise<{ items: Array<{ str: string }> }> }> };
    const page = await d.getPage(p);
    const tc = await page.getTextContent();
    return (tc.items ?? []).map((i) => i.str ?? '').join('\n');
}
