/**
 * cs_qa_report_reconcile_pdf_db — Reconcile a PDF against reference DB rows
 * loaded via a consumer-supplied helper module.
 *
 * The framework never talks to the DB directly. Consumer's helper module
 * (per `feedback_db_calls_in_db_helper_only`) owns SQL / stored procedures /
 * connection lifecycle. Framework just calls `helper.methodName(params)` and
 * expects Row[] OR {resultSets: Row[][]} back.
 *
 * See CSPdfDbReconciler.ts for the rules JSON schema.
 *
 * @module mcp/v6/tools/report_reconcile_pdf_db_tool
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

function resourcesDir(ctx: { workspaceRoot: string }): string {
    return path.join(ctx.workspaceRoot, '.cct-qa', 'resources');
}

registerPrimitive({
    name: 'cs_qa_report_reconcile_pdf_db',
    description:
        "Reconcile a candidate PDF against reference rows loaded from a DB via a consumer-supplied helper module. Framework never talks to the DB directly — consumer's helper owns SQL/stored-procs/connections. Two modes: (a) rulesPath — hand-authored rules JSON with per-section method/params; (b) auto — zero-JSON: pass helperModule + method + params, framework auto-detects the matching PDF section and composes keyColumns. Verbs: reconcile.",
    inputSchema: z.object({
        verb: z.literal('reconcile'),
        candidatePdfPath: z.string().min(1),
        // Advanced mode — hand-authored rules JSON (still supported).
        rulesPath: z.string().optional().describe('Path to a rules JSON with a referenceDataSource block. Mutually exclusive with helperModule.'),
        // Zero-JSON auto mode — matches reconcilePdfDbAuto.
        helperModule: z.string().optional().describe('Helper module name (looked up under HELPERS_PATH) or explicit path. Requires `method`.'),
        helperClassName: z.string().optional().describe('Class exported from the module — defaults to same-as-module-name.'),
        method: z.string().optional().describe('Method to call on the helper instance (returns Row[] or {resultSets: Row[][]}).'),
        params: z.record(z.string(), z.unknown()).optional().describe('Params passed to the helper method.'),
        sectionHint: z.string().optional().describe('Optional PDF section title to match rows against — auto-detected when omitted.'),
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
        resourceRef: z.string().optional(),
        htmlReportPath: z.string().optional(),
        warnings: z.array(z.string()),
        error: z.string().optional(),
    }),
    async run(ctx, input) {
        const candAbs = path.isAbsolute(input.candidatePdfPath)
            ? input.candidatePdfPath
            : path.resolve(ctx.workspaceRoot, input.candidatePdfPath);
        if (!fs.existsSync(candAbs)) return zero('error', `Candidate PDF not found: ${candAbs}`);

        // Validate mutual exclusivity between the rules-based path and the
        // auto-mode helper path. At least one must be supplied.
        const hasRules = Boolean(input.rulesPath);
        const hasAuto = Boolean(input.helperModule && input.method);
        if (!hasRules && !hasAuto) {
            return zero('error', 'Provide either `rulesPath` (advanced) OR `helperModule` + `method` (auto). Got neither.');
        }
        if (hasRules && hasAuto) {
            return zero('error', 'Provide EITHER `rulesPath` OR the auto-mode `helperModule`+`method` — not both.');
        }
        let rulesAbs = '';
        if (hasRules) {
            rulesAbs = path.isAbsolute(input.rulesPath!)
                ? input.rulesPath!
                : path.resolve(ctx.workspaceRoot, input.rulesPath!);
            if (!fs.existsSync(rulesAbs)) return zero('error', `Rules JSON not found: ${rulesAbs}`);
        }

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { reconcilePdfDbFromRules, reconcilePdfDbAuto } = require('../../../report-validation/CSPdfDbReconciler');
        // The helper module inside the rules JSON is resolved relative to
        // `CS_QA_WORKSPACE_ROOT || process.cwd()`. Set the env var so the
        // consumer's helper module path resolves correctly when invoked via MCP.
        const prevRoot = process.env.CS_QA_WORKSPACE_ROOT;
        process.env.CS_QA_WORKSPACE_ROOT = ctx.workspaceRoot;
        try {
            const result = hasRules
                ? await reconcilePdfDbFromRules({
                      candidatePdfPath: candAbs,
                      rulesPath: rulesAbs,
                  })
                : await reconcilePdfDbAuto({
                      candidatePdfPath: candAbs,
                      helperModule: input.helperModule!,
                      helperClassName: input.helperClassName,
                      method: input.method!,
                      params: input.params ?? {},
                      sectionHint: input.sectionHint,
                  });
            fs.mkdirSync(resourcesDir(ctx), { recursive: true });
            const stamp = ctx.invocationId.slice(0, 8);
            const resourceRef = path.join(
                resourcesDir(ctx),
                `report-reconcile-pdf-db-${path.basename(candAbs, path.extname(candAbs))}-${stamp}.json`,
            );
            fs.writeFileSync(resourceRef, JSON.stringify(result, null, 2), 'utf-8');

            // Emit the ledger HTML alongside the JSON resource — same
            // renderer used by the BDD auto step.
            let htmlReportPath: string | undefined;
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { writeReconcileHtmlReport } = require('../../../report-validation/CSPdfReconcileReporter');
                const label = hasRules
                    ? `${path.basename(candAbs)} vs DB (${path.basename(rulesAbs)})`
                    : `${path.basename(candAbs)} vs DB (${input.helperModule}.${input.method})`;
                const write = writeReconcileHtmlReport(result, {
                    label,
                    outputPath: path.join(
                        resourcesDir(ctx),
                        `report-reconcile-pdf-db-${path.basename(candAbs, path.extname(candAbs))}-${stamp}.html`,
                    ),
                    writeJsonCopy: false,
                });
                htmlReportPath = write.htmlPath;
            } catch { /* reporter unavailable — resource JSON still written */ }

            // Row-outcome roll-up for the compact ledger summary.
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
                tool: 'cs_qa_report_reconcile_pdf_db',
                input: {
                    candidatePdfPath: input.candidatePdfPath,
                    rulesPath: input.rulesPath,
                    helperModule: input.helperModule,
                    method: input.method,
                },
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
                ledger: { totalRows: ledgerRows.length, passRows, failRows, knownDiffRows },
                firstFindings,
                resourceRef,
                htmlReportPath,
                warnings: result.warnings,
            };
        } catch (e) {
            return zero('error', (e as Error).message);
        } finally {
            if (prevRoot === undefined) delete process.env.CS_QA_WORKSPACE_ROOT;
            else process.env.CS_QA_WORKSPACE_ROOT = prevRoot;
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
        warnings: [],
        error,
    };
}
