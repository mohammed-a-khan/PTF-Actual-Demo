/**
 * cs_qa_report_reconcile — Cell-level PDF-vs-PDF reconciliation (v1.53).
 *
 * Wraps `reconcilePdfsFromRules` — takes two PDFs + a rules JSON, returns
 * pass/fail + finding counts + up to 20 sample failures + resource ref to
 * full findings list.
 *
 * @module mcp/v6/tools/report_reconcile_tool
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

function resourcesDir(ctx: { workspaceRoot: string }): string {
    return path.join(ctx.workspaceRoot, '.cct-qa', 'resources');
}

registerPrimitive({
    name: 'cs_qa_report_reconcile',
    description:
        "Cell-level PDF-vs-PDF reconciliation with tolerance + aliases + known-differences. Consumer supplies candidate PDF, reference PDF, and a rules JSON declaring sections + columns + tolerances + aliases + knownDifferences. Framework auto-matches sections/columns by name/alias/fuzzy (strict threshold). Verbs: reconcile.",
    inputSchema: z.object({
        verb: z.literal('reconcile'),
        candidatePdfPath: z.string().min(1),
        referencePdfPath: z.string().min(1),
        rulesPath: z.string().min(1),
    }),
    outputSchema: z.object({
        status: z.enum(['ok', 'error']),
        passed: z.boolean(),
        summary: z.object({
            sectionsCompared: z.number(),
            columnsCompared: z.number(),
            rowsCompared: z.number(),
            cellsCompared: z.number(),
            cellMismatches: z.number(),
            rowMissing: z.number(),
            sectionMissing: z.number(),
            columnMissing: z.number(),
            knownDifferencesMatched: z.number(),
        }),
        ledger: z.object({
            totalRows: z.number(),
            passRows: z.number(),
            failRows: z.number(),
            knownDiffRows: z.number(),
        }),
        firstFindings: z.array(
            z.object({
                kind: z.string(),
                section: z.string(),
                column: z.string().optional(),
                key: z.string().optional(),
                candidateValue: z.string().optional(),
                referenceValue: z.string().optional(),
                delta: z.number().optional(),
                tolerance: z.number().optional(),
                reason: z.string().optional(),
            }),
        ),
        unmatchedCounts: z.object({
            sectionsInReferenceOnly: z.number(),
            sectionsInCandidateOnly: z.number(),
            columnsInReferenceOnly: z.number(),
        }),
        resourceRef: z.string().optional(),
        htmlReportPath: z.string().optional(),
        warnings: z.array(z.string()),
        error: z.string().optional(),
    }),
    async run(ctx, input) {
        const candAbs = path.isAbsolute(input.candidatePdfPath)
            ? input.candidatePdfPath
            : path.resolve(ctx.workspaceRoot, input.candidatePdfPath);
        const refAbs = path.isAbsolute(input.referencePdfPath)
            ? input.referencePdfPath
            : path.resolve(ctx.workspaceRoot, input.referencePdfPath);
        const rulesAbs = path.isAbsolute(input.rulesPath)
            ? input.rulesPath
            : path.resolve(ctx.workspaceRoot, input.rulesPath);
        if (!fs.existsSync(candAbs)) return zero('error', `Candidate PDF not found: ${candAbs}`);
        if (!fs.existsSync(refAbs)) return zero('error', `Reference PDF not found: ${refAbs}`);
        if (!fs.existsSync(rulesAbs)) return zero('error', `Rules JSON not found: ${rulesAbs}`);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { reconcilePdfsFromRules } = require('../../../report-validation/CSPdfPairReconciler');
        try {
            const result = await reconcilePdfsFromRules({
                candidatePdfPath: candAbs,
                referencePdfPath: refAbs,
                rulesPath: rulesAbs,
            });
            fs.mkdirSync(resourcesDir(ctx), { recursive: true });
            const stamp = ctx.invocationId.slice(0, 8);
            const resourceRef = path.join(
                resourcesDir(ctx),
                `report-reconcile-${path.basename(candAbs, path.extname(candAbs))}-${stamp}.json`,
            );
            fs.writeFileSync(resourceRef, JSON.stringify(result, null, 2), 'utf-8');

            // Emit the side-by-side ledger HTML alongside the JSON resource so
            // Copilot can hand the reviewer a rendered audit — the same
            // artefact the BDD auto step produces via CSPdfReconcileReporter.
            let htmlReportPath: string | undefined;
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { writeReconcileHtmlReport } = require('../../../report-validation/CSPdfReconcileReporter');
                const write = writeReconcileHtmlReport(result, {
                    label: `${path.basename(candAbs)} vs ${path.basename(refAbs)}`,
                    outputPath: path.join(
                        resourcesDir(ctx),
                        `report-reconcile-${path.basename(candAbs, path.extname(candAbs))}-${stamp}.html`,
                    ),
                    writeJsonCopy: false,
                });
                htmlReportPath = write.htmlPath;
            } catch { /* reporter unavailable — resource JSON still written */ }

            // Roll up the ledger into small counters — full ledger stays in the
            // resource JSON for pagination downstream.
            const ledgerRows: Array<{ cells: Array<{ outcome: string }> }> = Array.isArray(result.ledger) ? result.ledger : [];
            let passRows = 0, failRows = 0, knownDiffRows = 0;
            for (const r of ledgerRows) {
                let worst: 'pass' | 'fail' | 'known' = 'pass';
                for (const c of r.cells) {
                    if (c.outcome === 'MISMATCH' || c.outcome === 'MISSING_CANDIDATE' || c.outcome === 'MISSING_REFERENCE') {
                        worst = 'fail'; break;
                    }
                    if (c.outcome === 'KNOWN_DIFFERENCE') worst = 'known';
                }
                if (worst === 'fail') failRows++;
                else if (worst === 'known') knownDiffRows++;
                else passRows++;
            }
            const firstFindings = result.findings
                .filter((f: { kind: string }) => f.kind !== 'KNOWN_DIFFERENCE_MATCHED')
                .slice(0, 20)
                .map((f: {
                    kind: string;
                    section: string;
                    column?: string;
                    key?: string;
                    candidateValue?: string;
                    referenceValue?: string;
                    delta?: number;
                    tolerance?: number;
                    reason?: string;
                }) => ({
                    kind: f.kind,
                    section: f.section,
                    column: f.column,
                    key: f.key,
                    candidateValue: f.candidateValue,
                    referenceValue: f.referenceValue,
                    delta: f.delta,
                    tolerance: f.tolerance,
                    reason: f.reason,
                }));
            await ctx.audit({
                ts: new Date().toISOString(),
                tool: 'cs_qa_report_reconcile',
                input: { candidatePdfPath: input.candidatePdfPath, referencePdfPath: input.referencePdfPath, rulesPath: input.rulesPath },
                outputSummary: { passed: result.passed, ...result.summary },
                durationMs: 0,
            });
            return {
                status: 'ok' as const,
                passed: result.passed,
                summary: {
                    sectionsCompared: result.summary.sectionsCompared,
                    columnsCompared: result.summary.columnsCompared,
                    rowsCompared: result.summary.rowsCompared,
                    cellsCompared: result.summary.cellsCompared,
                    cellMismatches: result.summary.cellMismatches,
                    rowMissing: result.summary.rowMissing,
                    sectionMissing: result.summary.sectionMissing,
                    columnMissing: result.summary.columnMissing,
                    knownDifferencesMatched: result.summary.knownDifferencesMatched,
                },
                ledger: {
                    totalRows: ledgerRows.length,
                    passRows,
                    failRows,
                    knownDiffRows,
                },
                firstFindings,
                unmatchedCounts: {
                    sectionsInReferenceOnly: result.unmatched.sectionsInReferenceOnly.length,
                    sectionsInCandidateOnly: result.unmatched.sectionsInCandidateOnly.length,
                    columnsInReferenceOnly: result.unmatched.columnsInReferenceOnly.length,
                },
                resourceRef,
                htmlReportPath,
                warnings: result.warnings,
            };
        } catch (e) {
            return zero('error', (e as Error).message);
        }
    },
});

function zero(status: 'ok' | 'error', error?: string) {
    return {
        status,
        passed: false,
        summary: {
            sectionsCompared: 0,
            columnsCompared: 0,
            rowsCompared: 0,
            cellsCompared: 0,
            cellMismatches: 0,
            rowMissing: 0,
            sectionMissing: 0,
            columnMissing: 0,
            knownDifferencesMatched: 0,
        },
        ledger: { totalRows: 0, passRows: 0, failRows: 0, knownDiffRows: 0 },
        firstFindings: [],
        unmatchedCounts: { sectionsInReferenceOnly: 0, sectionsInCandidateOnly: 0, columnsInReferenceOnly: 0 },
        warnings: [],
        error,
    };
}
