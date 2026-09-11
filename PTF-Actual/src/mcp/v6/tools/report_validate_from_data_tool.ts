/**
 * cs_qa_report_validate_from_data — Test-data-first PDF validation.
 *
 * The 80% case. Consumer supplies:
 *   - a PDF
 *   - a JSON where top-level keys ARE the labels as they appear in the PDF
 *
 * Framework auto-extracts each label via the AUTO cascade
 * (inline → right → below), compares extracted vs expected, returns a tight
 * envelope with pass/fail + per-phase finding counts + HTML report path.
 *
 * No spec file. No consumer step-def. No scenario outline data-driven glue.
 * See `docs/report-validation/TEST-DATA-FIRST-QUICKSTART.md` for the JSON
 * contract (reserved `_checks` / `_presence` / `_tables` / `_formatting` blocks).
 *
 * @module mcp/v6/tools/report_validate_from_data_tool
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

function resourcesDir(ctx: { workspaceRoot: string }): string {
    return path.join(ctx.workspaceRoot, '.cct-qa', 'resources');
}

registerPrimitive({
    name: 'cs_qa_report_validate_from_data',
    description:
        "Test-data-first PDF validation. Consumer supplies a PDF path + a test-data JSON where keys ARE the PDF labels. No spec file needed. Framework auto-extracts each label via the AUTO cascade (inline→right→below), compares, applies any _checks / _presence blocks, returns a tight envelope with pass/fail + finding counts + HTML report path. Verbs: validate.",
    inputSchema: z.object({
        verb: z.literal('validate'),
        pdfPath: z.string().min(1),
        dataPath: z.string().min(1).describe('Path to the test-data JSON. Keys = PDF labels; reserved keys start with `_`.'),
        specName: z.string().optional().describe('Override the synthesised spec name. Default: dataPath basename.'),
    }),
    outputSchema: z.object({
        status: z.enum(['ok', 'error']),
        passed: z.boolean(),
        summary: z.object({
            fields: z.object({ total: z.number(), matches: z.number(), mismatches: z.number(), missing: z.number() }),
            formattingDriftCount: z.number(),
            phase1: z.object({
                metadata: z.number(),
                links: z.number(),
                headerFooter: z.number(),
                watermarks: z.number(),
                layout: z.number(),
                integrity: z.number(),
                textQuality: z.number(),
            }),
            phase3: z.object({
                structural: z.number(),
                interactive: z.number(),
                attachments: z.number(),
                tableDepth: z.number(),
            }),
            phase4: z.object({
                images: z.number(),
                contrast: z.number(),
                chartRegions: z.number(),
                visualRegression: z.number(),
            }),
            phase5: z.object({ security: z.number(), barcodes: z.number() }),
            phase6: z.object({ versionDiff: z.number() }),
        }),
        firstFailures: z.array(z.object({ block: z.string(), kind: z.string(), message: z.string() })),
        htmlReportPath: z.string().optional(),
        resourceRef: z.string().optional(),
        warnings: z.array(z.string()),
        error: z.string().optional(),
    }),
    async run(ctx, input) {
        const pdfAbs = path.isAbsolute(input.pdfPath) ? input.pdfPath : path.resolve(ctx.workspaceRoot, input.pdfPath);
        const dataAbs = path.isAbsolute(input.dataPath)
            ? input.dataPath
            : path.resolve(ctx.workspaceRoot, input.dataPath);
        if (!fs.existsSync(pdfAbs)) return zeroEnvelope('error', `PDF not found: ${pdfAbs}`);
        if (!fs.existsSync(dataAbs)) return zeroEnvelope('error', `Test-data JSON not found: ${dataAbs}`);

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { validatePdfFromDataFile } = require('../../../report-validation/CSReportSimpleValidatorFromData');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const reporterModule = require('../../../report-validation/CSReportSimpleValidatorReporter');
        let result: ValidationResult;
        try {
            result = await validatePdfFromDataFile({ pdfPath: pdfAbs, dataPath: dataAbs, specName: input.specName });
        } catch (e) {
            return zeroEnvelope('error', (e as Error).message);
        }

        // Persist full findings as a resource + emit HTML report.
        fs.mkdirSync(resourcesDir(ctx), { recursive: true });
        const stamp = ctx.invocationId.slice(0, 8);
        const resourceRef = path.join(
            resourcesDir(ctx),
            `report-validate-from-data-${path.basename(pdfAbs, path.extname(pdfAbs))}-${stamp}.json`,
        );
        fs.writeFileSync(resourceRef, JSON.stringify(result, null, 2), 'utf-8');

        let htmlReportPath: string | undefined;
        try {
            const reportsDir = path.join(ctx.workspaceRoot, 'reports', 'report-validation');
            htmlReportPath = path.join(reportsDir, `${result.summary.specName}-${Date.now()}.html`);
            const write = reporterModule.writeSimpleValidatorHtmlReport(result, {
                outputPath: htmlReportPath,
                writeJsonCopy: true,
            });
            htmlReportPath = write.htmlPath;
        } catch (e) {
            result.warnings = [...(result.warnings ?? []), `HTML report emit failed: ${(e as Error).message}`];
        }

        const firstFailures = collectFirstFailures(result, 10);
        const summary = summariseResult(result);
        await ctx.audit({
            ts: new Date().toISOString(),
            tool: 'cs_qa_report_validate_from_data',
            input: { pdfPath: input.pdfPath, dataPath: input.dataPath },
            outputSummary: { passed: result.summary.passed, ...summary },
            durationMs: 0,
        });
        return {
            status: 'ok' as const,
            passed: result.summary.passed,
            summary,
            firstFailures,
            htmlReportPath,
            resourceRef,
            warnings: result.warnings ?? [],
        };
    },
});

// --------------------------------------------------------------------------
// Shared shapes (kept minimal — full types live in the framework module).
// --------------------------------------------------------------------------

interface FindingRow {
    kind: string;
    message: string;
}
interface ValidationResult {
    summary: {
        pdfPath: string;
        specName: string;
        totalFields: number;
        fieldMatches: number;
        fieldMismatches: number;
        fieldMissing: number;
        formattingDriftCount: number;
        passed: boolean;
    };
    fields: Array<{ name: string; status: string; extracted: string | null; expected: string | null }>;
    warnings?: string[];
    phase1: {
        metadata: FindingRow[];
        links: FindingRow[];
        headerFooter: FindingRow[];
        watermarks: FindingRow[];
        layout: FindingRow[];
        integrity: FindingRow[];
        textQuality: FindingRow[];
    };
    phase3: {
        structural: FindingRow[];
        interactive: FindingRow[];
        attachments: FindingRow[];
        tableDepthFindings: FindingRow[];
    };
    phase4: {
        images: FindingRow[];
        contrast: FindingRow[];
        chartRegions: FindingRow[];
        visualRegression: Array<FindingRow & { kind: string }>;
    };
    phase5: { security: FindingRow[]; barcodes: FindingRow[] };
    phase6: { versionDiff: FindingRow[] };
}

function summariseResult(r: ValidationResult) {
    return {
        fields: {
            total: r.summary.totalFields,
            matches: r.summary.fieldMatches,
            mismatches: r.summary.fieldMismatches,
            missing: r.summary.fieldMissing,
        },
        formattingDriftCount: r.summary.formattingDriftCount,
        phase1: {
            metadata: r.phase1.metadata.length,
            links: r.phase1.links.length,
            headerFooter: r.phase1.headerFooter.length,
            watermarks: r.phase1.watermarks.length,
            layout: r.phase1.layout.length,
            integrity: r.phase1.integrity.length,
            textQuality: r.phase1.textQuality.length,
        },
        phase3: {
            structural: r.phase3.structural.length,
            interactive: r.phase3.interactive.length,
            attachments: r.phase3.attachments.length,
            tableDepth: r.phase3.tableDepthFindings.length,
        },
        phase4: {
            images: r.phase4.images.length,
            contrast: r.phase4.contrast.length,
            chartRegions: r.phase4.chartRegions.length,
            visualRegression: r.phase4.visualRegression.length,
        },
        phase5: { security: r.phase5.security.length, barcodes: r.phase5.barcodes.length },
        phase6: { versionDiff: r.phase6.versionDiff.length },
    };
}

function collectFirstFailures(r: ValidationResult, max: number): Array<{ block: string; kind: string; message: string }> {
    const out: Array<{ block: string; kind: string; message: string }> = [];
    const push = (block: string, arr: FindingRow[]) => {
        for (const f of arr ?? []) {
            if (out.length >= max) return;
            out.push({ block, kind: f.kind, message: f.message });
        }
    };
    for (const f of r.fields) {
        if (out.length >= max) break;
        if (f.status === 'mismatch' || f.status === 'missing-in-pdf') {
            out.push({
                block: 'field',
                kind: f.status.toUpperCase(),
                message: `${f.name}: expected="${f.expected}" extracted="${f.extracted}"`,
            });
        }
    }
    push('phase1.metadata', r.phase1.metadata);
    push('phase1.links', r.phase1.links);
    push('phase1.headerFooter', r.phase1.headerFooter);
    push('phase1.watermarks', r.phase1.watermarks);
    push('phase1.layout', r.phase1.layout);
    push('phase1.integrity', r.phase1.integrity);
    push('phase1.textQuality', r.phase1.textQuality);
    push('phase3.structural', r.phase3.structural);
    push('phase3.interactive', r.phase3.interactive);
    push('phase3.attachments', r.phase3.attachments);
    push('phase3.tableDepth', r.phase3.tableDepthFindings);
    push('phase4.images', r.phase4.images);
    push('phase4.contrast', r.phase4.contrast);
    push('phase4.chartRegions', r.phase4.chartRegions);
    push(
        'phase4.visualRegression',
        r.phase4.visualRegression.filter((f) => f.kind !== 'BASELINE_UPDATED' && f.kind !== 'MISSING_BASELINE'),
    );
    push('phase5.security', r.phase5.security);
    push('phase5.barcodes', r.phase5.barcodes);
    push('phase6.versionDiff', r.phase6.versionDiff);
    return out;
}

function zeroEnvelope(status: 'ok' | 'error', error?: string) {
    return {
        status,
        passed: false,
        summary: {
            fields: { total: 0, matches: 0, mismatches: 0, missing: 0 },
            formattingDriftCount: 0,
            phase1: { metadata: 0, links: 0, headerFooter: 0, watermarks: 0, layout: 0, integrity: 0, textQuality: 0 },
            phase3: { structural: 0, interactive: 0, attachments: 0, tableDepth: 0 },
            phase4: { images: 0, contrast: 0, chartRegions: 0, visualRegression: 0 },
            phase5: { security: 0, barcodes: 0 },
            phase6: { versionDiff: 0 },
        },
        firstFailures: [],
        warnings: [],
        error,
    };
}
