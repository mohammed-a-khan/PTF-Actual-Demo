/**
 * cs_qa_report_recon_init — Auto-generate a starter reconciliation rules JSON.
 *
 * Extracts section + column layouts from BOTH the candidate PDF and the
 * reference PDF, applies strict fuzzy alias detection (threshold ≥ 0.85),
 * emits a starter rules JSON:
 *   - Auto-generated `sections` block: only high-confidence matches
 *   - `_unmatched` block: sections/columns in reference not resolvable on
 *     candidate, with the 3 nearest fuzzy suggestions per unmatched item
 *   - Empty `knownDifferences: []` for consumer to fill
 *   - Sensible `globalTolerance` defaults ({currency:0.01, percentage:0.001, count:0})
 *
 * Consumer reviews `_unmatched`, decides which to add as aliases, deletes
 * `_unmatched` block. Ready to feed to `cs_qa_report_reconcile`.
 *
 * @module mcp/v6/tools/report_recon_init_tool
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

registerPrimitive({
    name: 'cs_qa_report_recon_init',
    description:
        "Auto-generate a starter reconciliation rules JSON from a PDF pair. Extracts sections + columns from both, auto-matches high-confidence pairs (fuzzy threshold ≥ 0.85), and emits an `_unmatched` block listing what needs consumer input with 3 nearest suggestions per unmatched item. Consumer edits + feeds to cs_qa_report_reconcile. Verbs: init.",
    inputSchema: z.object({
        verb: z.literal('init'),
        candidatePdfPath: z.string().min(1),
        referencePdfPath: z.string().min(1),
        outPath: z.string().min(1).describe('Where to write the starter rules JSON.'),
        force: z.boolean().default(false),
        fuzzyThreshold: z
            .number()
            .min(0.5)
            .max(1.0)
            .default(0.85)
            .describe('Levenshtein similarity threshold for auto-alias detection. Strict = 0.85 (default).'),
    }),
    outputSchema: z.object({
        status: z.enum(['ok', 'skipped', 'error']),
        written: z.boolean(),
        outPath: z.string(),
        sectionsDetected: z.object({ candidate: z.number(), reference: z.number(), matchedAutomatically: z.number() }),
        columnsPerSection: z.record(z.string(), z.object({ candidate: z.number(), reference: z.number(), matchedAutomatically: z.number() })),
        unmatchedCounts: z.object({
            sectionsInReferenceOnly: z.number(),
            sectionsInCandidateOnly: z.number(),
            columnsInReferenceOnly: z.number(),
        }),
        note: z.string(),
        error: z.string().optional(),
    }),
    async run(ctx, input) {
        const candAbs = path.isAbsolute(input.candidatePdfPath)
            ? input.candidatePdfPath
            : path.resolve(ctx.workspaceRoot, input.candidatePdfPath);
        const refAbs = path.isAbsolute(input.referencePdfPath)
            ? input.referencePdfPath
            : path.resolve(ctx.workspaceRoot, input.referencePdfPath);
        const outAbs = path.isAbsolute(input.outPath) ? input.outPath : path.resolve(ctx.workspaceRoot, input.outPath);

        if (!fs.existsSync(candAbs)) return errZero(outAbs, `Candidate PDF not found: ${candAbs}`);
        if (!fs.existsSync(refAbs)) return errZero(outAbs, `Reference PDF not found: ${refAbs}`);
        if (!input.force && fs.existsSync(outAbs)) {
            return {
                status: 'skipped' as const,
                written: false,
                outPath: outAbs,
                sectionsDetected: { candidate: 0, reference: 0, matchedAutomatically: 0 },
                columnsPerSection: {},
                unmatchedCounts: { sectionsInReferenceOnly: 0, sectionsInCandidateOnly: 0, columnsInReferenceOnly: 0 },
                note: `Refusing to overwrite ${outAbs}. Pass force:true to overwrite.`,
            };
        }

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { extractPagesFromPdf } = require('../../../report-validation/CSReportPdfExtractor');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { analyzeReport } = require('../../../report-validation/CSReportPdfLayoutAnalyzer');

        try {
            const [candPages, refPages] = await Promise.all([extractPagesFromPdf(candAbs), extractPagesFromPdf(refAbs)]);
            const candAnalyzed = analyzeReport(candPages);
            const refAnalyzed = analyzeReport(refPages);

            const candSections = flattenSections(candAnalyzed);
            const refSections = flattenSections(refAnalyzed);
            const threshold = input.fuzzyThreshold;

            // Match reference-side sections to candidate-side; canonical name = reference name.
            const sectionRules: Record<string, unknown> = {};
            const sectionsInReferenceOnly: Array<{ name: string; nearestOnCandidate: string[] }> = [];
            const columnsPerSection: Record<string, { candidate: number; reference: number; matchedAutomatically: number }> = {};
            let matchedSections = 0;

            for (const [refTitle, refSec] of refSections.entries()) {
                const nearest = candSections
                    ? Array.from(candSections.keys())
                          .map((c) => ({ c, s: similarityRatio(refTitle.toLowerCase(), c.toLowerCase()) }))
                          .sort((a, b) => b.s - a.s)
                    : [];
                const bestMatch = nearest[0];
                if (bestMatch && bestMatch.s >= threshold) {
                    matchedSections++;
                    const candSec = candSections.get(bestMatch.c);
                    if (!candSec) continue;
                    const rule = buildSectionRule(refSec, candSec, threshold);
                    // Skip sections with no detectable columns OR no keyColumn — nothing meaningful
                    // to reconcile, and the reconciler shape-validator rejects keyColumns:[].
                    if (rule.keyColumns.length === 0 || Object.keys(rule.columns).length === 0) {
                        continue;
                    }
                    if (bestMatch.c !== refTitle) rule.aliases = [bestMatch.c];
                    sectionRules[refTitle] = rule;
                    columnsPerSection[refTitle] = {
                        candidate: candSec.columns.length,
                        reference: refSec.columns.length,
                        matchedAutomatically: Object.keys(rule.columns as Record<string, unknown>).length,
                    };
                } else {
                    sectionsInReferenceOnly.push({
                        name: refTitle,
                        nearestOnCandidate: nearest.slice(0, 3).map((x) => x.c),
                    });
                }
            }
            const sectionsInCandidateOnly = Array.from(candSections.keys()).filter((t) => {
                const matched = Object.entries(sectionRules).some(([, rule]) => {
                    const r = rule as { aliases?: string[] };
                    return r.aliases?.includes(t);
                });
                return !matched && !refSections.has(t);
            });

            // Aggregate columns-in-reference-only across sections
            const columnsInReferenceOnly: Array<{ section: string; name: string; nearestOnCandidate: string[] }> = [];
            for (const [refTitle, rule] of Object.entries(sectionRules)) {
                const r = rule as { aliases?: string[]; columns: Record<string, { aliases?: string[] }> };
                const refSec = refSections.get(refTitle);
                const candSec = candSections.get(r.aliases?.[0] ?? refTitle);
                if (!refSec || !candSec) continue;
                const candCols = candSec.columns.map((c: { header: string | null }) => (c.header ?? '').trim()).filter((h: string) => h.length > 0);
                const declared = new Set<string>();
                for (const colRule of Object.values(r.columns)) {
                    // Rule keys are the reference-side column names; the candidate-side match may be an alias
                    if (colRule.aliases) for (const a of colRule.aliases) declared.add(a);
                }
                for (const refCol of refSec.columns) {
                    const refColName = (refCol.header ?? '').trim();
                    if (!refColName) continue;
                    const declaredMatch = candCols.find((c: string) => c === refColName || declared.has(c));
                    if (declaredMatch) continue;
                    columnsInReferenceOnly.push({
                        section: refTitle,
                        name: refColName,
                        nearestOnCandidate: candCols
                            .map((c: string) => ({ c, s: similarityRatio(refColName.toLowerCase(), c.toLowerCase()) }))
                            .sort((a: { s: number }, b: { s: number }) => b.s - a.s)
                            .slice(0, 3)
                            .map((x: { c: string }) => x.c),
                    });
                }
            }

            const starter = {
                _meta: {
                    candidateSource: `pdf:${path.basename(candAbs)}`,
                    referenceSource: `pdf:${path.basename(refAbs)}`,
                    description: 'Auto-generated starter rules — review _unmatched and add aliases where appropriate.',
                    fuzzyThreshold: threshold,
                },
                globalTolerance: { currency: 0.01, percentage: 0.001, count: 0, number: 0.01 },
                ignoreSections: [] as string[],
                ignoreColumns: [] as string[],
                sections: sectionRules,
                knownDifferences: [] as unknown[],
                _unmatched: {
                    sectionsInReferenceOnly,
                    sectionsInCandidateOnly,
                    columnsInReferenceOnly,
                    _note: 'Review + move needed aliases into `sections[X].aliases` or `sections[X].columns[Y].aliases`, then DELETE this `_unmatched` block.',
                },
            };
            fs.mkdirSync(path.dirname(outAbs), { recursive: true });
            fs.writeFileSync(outAbs, JSON.stringify(starter, null, 4) + '\n', 'utf-8');

            await ctx.audit({
                ts: new Date().toISOString(),
                tool: 'cs_qa_report_recon_init',
                input: { candidatePdfPath: input.candidatePdfPath, referencePdfPath: input.referencePdfPath, outPath: input.outPath, fuzzyThreshold: threshold },
                outputSummary: { matchedSections, refSections: refSections.size, candSections: candSections.size },
                durationMs: 0,
            });

            return {
                status: 'ok' as const,
                written: true,
                outPath: outAbs,
                sectionsDetected: {
                    candidate: candSections.size,
                    reference: refSections.size,
                    matchedAutomatically: matchedSections,
                },
                columnsPerSection,
                unmatchedCounts: {
                    sectionsInReferenceOnly: sectionsInReferenceOnly.length,
                    sectionsInCandidateOnly: sectionsInCandidateOnly.length,
                    columnsInReferenceOnly: columnsInReferenceOnly.length,
                },
                note: `Wrote ${outAbs}. Review the _unmatched block; add aliases where needed; delete the _unmatched block; then feed to cs_qa_report_reconcile.`,
            };
        } catch (e) {
            return errZero(outAbs, (e as Error).message);
        }
    },
});

function flattenSections(analyzed: { pages: Array<{ sections: Array<{ title: string; columns: Array<{ header: string | null }>; tableRows: Array<{ cells: Array<string | null> }> }> }> }): Map<string, { title: string; columns: Array<{ header: string | null }>; tableRows: Array<{ cells: Array<string | null> }> }> {
    const out = new Map<string, { title: string; columns: Array<{ header: string | null }>; tableRows: Array<{ cells: Array<string | null> }> }>();
    for (const page of analyzed.pages) {
        for (const sec of page.sections) {
            const title = (sec.title ?? '').trim();
            if (!title || out.has(title)) continue;
            out.set(title, sec);
        }
    }
    return out;
}

function buildSectionRule(
    refSec: { columns: Array<{ header: string | null }>; tableRows: Array<{ cells: Array<string | null> }> },
    candSec: { columns: Array<{ header: string | null }>; tableRows: Array<{ cells: Array<string | null> }> },
    threshold: number,
): { keyColumns: string[]; columns: Record<string, { aliases?: string[]; tolerance?: number; kind?: string }>; aliases?: string[] } {
    const refCols = refSec.columns.map((c) => (c.header ?? '').trim()).filter((h) => h.length > 0);
    const candCols = candSec.columns.map((c) => (c.header ?? '').trim()).filter((h) => h.length > 0);
    const columns: Record<string, { aliases?: string[]; tolerance?: number; kind?: string }> = {};
    for (const refCol of refCols) {
        // Find best candidate match
        const nearest = candCols
            .map((c) => ({ c, s: similarityRatio(refCol.toLowerCase(), c.toLowerCase()) }))
            .sort((a, b) => b.s - a.s);
        const best = nearest[0];
        if (best && best.s >= threshold) {
            const rule: { aliases?: string[]; kind?: string } = {};
            if (best.c !== refCol) rule.aliases = [best.c];
            // Sniff kind from first non-empty row
            const kind = sniffColumnKind(refSec, refCols.indexOf(refCol));
            if (kind) rule.kind = kind;
            columns[refCol] = rule;
        }
    }
    // Auto-detect keyColumns: first non-numeric column with high cardinality
    const keyColumns = detectKeyColumns(refSec, refCols);
    return { keyColumns, columns };
}

function sniffColumnKind(sec: { tableRows: Array<{ cells: Array<string | null> }> }, colIdx: number): 'number' | 'date' | 'string' | undefined {
    if (colIdx < 0) return undefined;
    for (const row of sec.tableRows.slice(0, 10)) {
        const v = row.cells[colIdx];
        if (v === null || v === undefined || String(v).trim() === '') continue;
        const s = String(v).trim();
        if (/^\(?\s*(USD\s*)?\$?-?\d[\d,]*\.?\d*\)?$/.test(s.replace(/\s/g, ''))) return 'number';
        if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(s)) return 'date';
        return 'string';
    }
    return undefined;
}

function detectKeyColumns(sec: { tableRows: Array<{ cells: Array<string | null> }> }, cols: string[]): string[] {
    // Best-effort: first non-numeric column with distinct-count / rowCount >= 0.5
    const rows = sec.tableRows;
    for (let i = 0; i < cols.length; i++) {
        const kind = sniffColumnKind(sec, i);
        if (kind === 'number' || kind === 'date') continue;
        const values = new Set<string>();
        let nonEmpty = 0;
        for (const row of rows) {
            const v = row.cells[i];
            if (v === null || v === undefined || String(v).trim() === '') continue;
            values.add(String(v).trim());
            nonEmpty++;
        }
        if (nonEmpty === 0) continue;
        if (values.size / nonEmpty >= 0.5) return [cols[i]];
    }
    // Fallback: first non-empty column
    return cols[0] ? [cols[0]] : [];
}

function similarityRatio(a: string, b: string): number {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
    }
    const dist = dp[m][n];
    return 1 - dist / Math.max(m, n);
}

function errZero(outAbs: string, error: string) {
    return {
        status: 'error' as const,
        written: false,
        outPath: outAbs,
        sectionsDetected: { candidate: 0, reference: 0, matchedAutomatically: 0 },
        columnsPerSection: {},
        unmatchedCounts: { sectionsInReferenceOnly: 0, sectionsInCandidateOnly: 0, columnsInReferenceOnly: 0 },
        note: '',
        error,
    };
}
