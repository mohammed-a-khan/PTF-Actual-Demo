/**
 * cs_qa_report_recon_init — Auto-generate a starter reconciliation rules JSON.
 *
 * Delegates entirely to the framework's `generateReconciliationRulesFromPair`
 * so all v1.53 improvements land automatically here:
 *   - Data-driven composite key-column picker (uniqueness × length-capacity ×
 *     stability × coverage; no domain regexes)
 *   - 0.85 fuzzy alias detection on section/column names with a relaxed 0.70
 *     fallback for auto-mode
 *   - Locale-agnostic `isNumericLike` / `isDateLike` for kind sniffing
 *   - `autoMode: true` in emitted rules so the reconciler applies subset-view
 *     skipping, total-row skipping, and value/key normalization
 *
 * Consumer receives a starter rules JSON plus an `_unmatched` audit block
 * with the 3 nearest suggestions per unmatched section — reviews, edits
 * aliases where needed, deletes `_unmatched`, then feeds to
 * cs_qa_report_reconcile.
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
        "Auto-generate a starter reconciliation rules JSON from a PDF pair. Delegates to the framework's `generateReconciliationRulesFromPair` — same composite-key picker + fuzzy alias detection + locale-agnostic kind sniffing the zero-config BDD step uses. Emits an `_unmatched` audit block listing sections/columns present on one side only with 3 nearest suggestions. Consumer edits + feeds to cs_qa_report_reconcile. Verbs: init.",
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

        try {
            // Delegate to the framework — single source of truth for the
            // heuristics + auto-mode flag. Also do a parallel raw analysis so
            // the tool can enrich the emitted JSON with per-section column
            // counts + a rich `_unmatched` audit block for consumer review.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { generateReconciliationRulesFromPair, reconcileAnalyzedReports } = require('../../../report-validation/CSPdfPairReconciler');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { extractPagesFromPdf } = require('../../../report-validation/CSReportPdfExtractor');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { analyzeReport } = require('../../../report-validation/CSReportPdfLayoutAnalyzer');

            const rules = await generateReconciliationRulesFromPair({
                candidatePdfPath: candAbs,
                referencePdfPath: refAbs,
                fuzzyThreshold: input.fuzzyThreshold,
            });

            // Compute per-section column counts + `_unmatched` audit by piggy-
            // backing on the reconciler's own resolution pass (dry-run — we
            // reuse its unmatched calculation without gating on findings).
            const [candPages, refPages] = await Promise.all([extractPagesFromPdf(candAbs), extractPagesFromPdf(refAbs)]);
            const candAnalyzed = analyzeReport(candPages);
            const refAnalyzed = analyzeReport(refPages);
            const probe = reconcileAnalyzedReports({
                candidatePdf: candAbs,
                referencePdf: refAbs,
                candidateAnalyzed: candAnalyzed,
                referenceAnalyzed: refAnalyzed,
                rules,
            });

            const candSections = mergeByTitle(candAnalyzed);
            const refSections = mergeByTitle(refAnalyzed);
            const columnsPerSection: Record<string, { candidate: number; reference: number; matchedAutomatically: number }> = {};
            for (const [canonicalName, sec] of Object.entries(rules.sections)) {
                const s = sec as { aliases?: string[]; columns: Record<string, unknown> };
                const refSec = refSections.get(canonicalName);
                const candSec = candSections.get(s.aliases?.[0] ?? canonicalName);
                columnsPerSection[canonicalName] = {
                    candidate: candSec?.columns.length ?? 0,
                    reference: refSec?.columns.length ?? 0,
                    matchedAutomatically: Object.keys(s.columns).length,
                };
            }

            // Emit a self-describing starter document that carries the raw
            // framework-generated rules plus a review-friendly `_unmatched`
            // audit block. The consumer edits + deletes `_unmatched` before
            // feeding to cs_qa_report_reconcile.
            const starter = {
                _meta: {
                    ...(rules._meta ?? {}),
                    candidateSource: `pdf:${path.basename(candAbs)}`,
                    referenceSource: `pdf:${path.basename(refAbs)}`,
                    description: `Auto-generated starter rules (v1.53 heuristics, fuzzyThreshold ${input.fuzzyThreshold}).`,
                },
                globalTolerance: rules.globalTolerance ?? { currency: 0.01, percentage: 0.001, count: 0, number: 0.01 },
                aliasFuzzyThreshold: rules.aliasFuzzyThreshold ?? input.fuzzyThreshold,
                autoMode: rules.autoMode ?? true,
                ignoreSections: rules.ignoreSections ?? [],
                ignoreColumns: rules.ignoreColumns ?? [],
                sections: rules.sections,
                knownDifferences: rules.knownDifferences ?? [],
                _unmatched: {
                    sectionsInReferenceOnly: probe.unmatched.sectionsInReferenceOnly,
                    sectionsInCandidateOnly: probe.unmatched.sectionsInCandidateOnly,
                    columnsInReferenceOnly: probe.unmatched.columnsInReferenceOnly,
                    _note: 'Review + move needed aliases into `sections[X].aliases` or `sections[X].columns[Y].aliases`, then DELETE this `_unmatched` block.',
                },
            };
            fs.mkdirSync(path.dirname(outAbs), { recursive: true });
            fs.writeFileSync(outAbs, JSON.stringify(starter, null, 4) + '\n', 'utf-8');

            const matchedSections = Object.keys(rules.sections).length;
            await ctx.audit({
                ts: new Date().toISOString(),
                tool: 'cs_qa_report_recon_init',
                input: { candidatePdfPath: input.candidatePdfPath, referencePdfPath: input.referencePdfPath, outPath: input.outPath, fuzzyThreshold: input.fuzzyThreshold },
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
                    sectionsInReferenceOnly: probe.unmatched.sectionsInReferenceOnly.length,
                    sectionsInCandidateOnly: probe.unmatched.sectionsInCandidateOnly.length,
                    columnsInReferenceOnly: probe.unmatched.columnsInReferenceOnly.length,
                },
                note: `Wrote ${outAbs}. Review the _unmatched block; add aliases where needed; delete the _unmatched block; then feed to cs_qa_report_reconcile.`,
            };
        } catch (e) {
            return errZero(outAbs, (e as Error).message);
        }
    },
});

function mergeByTitle(analyzed: { pages: Array<{ sections: Array<{ title: string; columns: Array<{ header: string | null }> }> }> }): Map<string, { title: string; columns: Array<{ header: string | null }> }> {
    const out = new Map<string, { title: string; columns: Array<{ header: string | null }> }>();
    for (const page of analyzed.pages) {
        for (const sec of page.sections) {
            const title = (sec.title ?? '').trim();
            if (!title || out.has(title)) continue;
            out.set(title, sec);
        }
    }
    return out;
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
