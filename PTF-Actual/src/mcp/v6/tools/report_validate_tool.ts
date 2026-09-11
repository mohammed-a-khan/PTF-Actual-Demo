/**
 * cs_qa_report_validate — Run the SimpleReportSpec validator against a PDF.
 *
 * Wraps `validatePdfAgainstSpec` (framework v1.50+). Returns a TIGHT envelope:
 * pass/fail flag + per-block finding counts + path to the HTML report file
 * the framework auto-drops next to the run. Full findings live in a resource
 * pointed to by `resourceRef` so the model can pull only what it needs
 * (avoids blowing token budget on 300-finding reports).
 *
 * Reads the spec from either an explicit `specPath` OR by name via the
 * standard resolver (`config/report-specs` recursive walk).
 *
 * @module mcp/v6/tools/report_validate_tool
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

function resourcesDir(ctx: { workspaceRoot: string }): string {
    return path.join(ctx.workspaceRoot, '.cct-qa', 'resources');
}

registerPrimitive({
    name: 'cs_qa_report_validate',
    description:
        "Validate a PDF against a SimpleReportSpec. Returns pass/fail + per-block finding counts + HTML report path. Full findings are stored as a resource for on-demand retrieval (avoids flooding the model context with hundreds of finding rows). Verbs: validate.",
    inputSchema: z.object({
        verb: z.literal('validate'),
        pdfPath: z.string().min(1),
        specName: z
            .string()
            .optional()
            .describe(
                'Spec name (looked up under REPORT_SPECS_DIR, default config/report-specs, recursive). Exactly one of specName / specPath is required.',
            ),
        specPath: z
            .string()
            .optional()
            .describe('Absolute or workspace-relative JSON file path. Skips the name lookup.'),
        expectedValues: z
            .record(z.string(), z.unknown())
            .default({})
            .describe(
                'Bag of expected field values, keyed by spec field name. Fields present in the spec but missing here are extracted but not asserted (informational).',
            ),
        specsDir: z
            .string()
            .default('config/report-specs')
            .describe('Root directory for name-based spec lookup.'),
    }),
    outputSchema: z.object({
        status: z.enum(['ok', 'error']),
        passed: z.boolean(),
        summary: z.object({
            fields: z.object({ total: z.number(), matches: z.number(), mismatches: z.number(), missing: z.number() }),
            tables: z.object({ total: z.number(), matches: z.number(), mismatches: z.number(), missing: z.number() }),
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
        firstFailures: z
            .array(
                z.object({
                    block: z.string(),
                    kind: z.string(),
                    message: z.string(),
                }),
            )
            .describe('Up to 10 sample finding rows so the model can reason without pulling the resource.'),
        htmlReportPath: z.string().optional(),
        jsonReportPath: z.string().optional(),
        resourceRef: z.string().optional(),
        warnings: z.array(z.string()),
        error: z.string().optional(),
    }),
    async run(ctx, input) {
        const pdfAbs = path.isAbsolute(input.pdfPath)
            ? input.pdfPath
            : path.resolve(ctx.workspaceRoot, input.pdfPath);
        if (!fs.existsSync(pdfAbs)) {
            return zeroSummary({ status: 'error', error: `PDF not found: ${pdfAbs}` });
        }
        if (!input.specName && !input.specPath) {
            return zeroSummary({ status: 'error', error: 'Provide exactly one of specName or specPath.' });
        }

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const specModule = require('../../../report-validation/CSReportSimpleSpec');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const validatorModule = require('../../../report-validation/CSReportSimpleValidator');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const reporterModule = require('../../../report-validation/CSReportSimpleValidatorReporter');

        let spec: unknown;
        try {
            if (input.specPath) {
                const specAbs = path.isAbsolute(input.specPath)
                    ? input.specPath
                    : path.resolve(ctx.workspaceRoot, input.specPath);
                spec = JSON.parse(fs.readFileSync(specAbs, 'utf-8'));
            } else {
                const dirAbs = path.isAbsolute(input.specsDir)
                    ? input.specsDir
                    : path.resolve(ctx.workspaceRoot, input.specsDir);
                spec = specModule.loadSimpleReportSpec(input.specName as string, dirAbs);
            }
        } catch (e) {
            return zeroSummary({ status: 'error', error: `Spec load failed: ${(e as Error).message}` });
        }

        // Run validation.
        let result: unknown;
        try {
            result = await validatorModule.validatePdfAgainstSpec({
                pdfPath: pdfAbs,
                spec,
                expectedValues: input.expectedValues,
            });
        } catch (e) {
            return zeroSummary({ status: 'error', error: `Validation failed to run: ${(e as Error).message}` });
        }

        const r = result as ValidationResult;

        // Persist full result as a resource so the model can pull details later.
        fs.mkdirSync(resourcesDir(ctx), { recursive: true });
        const stamp = ctx.invocationId.slice(0, 8);
        const resourcePath = path.join(
            resourcesDir(ctx),
            `report-validate-${path.basename(pdfAbs, path.extname(pdfAbs))}-${stamp}.json`,
        );
        fs.writeFileSync(resourcePath, JSON.stringify(r, null, 2), 'utf-8');

        // Also emit the HTML report next to the run outputs.
        let htmlReportPath: string | undefined;
        let jsonReportPath: string | undefined;
        try {
            const reportsDir = path.join(ctx.workspaceRoot, 'reports', 'report-validation');
            htmlReportPath = path.join(reportsDir, `${r.summary.specName}-${Date.now()}.html`);
            const write = reporterModule.writeSimpleValidatorHtmlReport(r, {
                outputPath: htmlReportPath,
                writeJsonCopy: true,
            });
            htmlReportPath = write.htmlPath;
            jsonReportPath = write.jsonPath;
        } catch (e) {
            r.warnings = [...(r.warnings ?? []), `HTML report emit failed: ${(e as Error).message}`];
        }

        // Assemble tight summary + sample findings.
        const firstFailures = collectFirstFailures(r, 10);
        const summary = {
            fields: {
                total: r.summary.totalFields,
                matches: r.summary.fieldMatches,
                mismatches: r.summary.fieldMismatches,
                missing: r.summary.fieldMissing,
            },
            tables: {
                total: r.summary.totalTables,
                matches: r.summary.tableMatches,
                mismatches: r.summary.tableMismatches,
                missing: r.summary.tableMissing,
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

        await ctx.audit({
            ts: new Date().toISOString(),
            tool: 'cs_qa_report_validate',
            input: { pdfPath: input.pdfPath, specName: input.specName ?? input.specPath },
            outputSummary: { passed: r.summary.passed, ...summary },
            durationMs: 0,
        });

        return {
            status: 'ok' as const,
            passed: r.summary.passed,
            summary,
            firstFailures,
            htmlReportPath,
            jsonReportPath,
            resourceRef: resourcePath,
            warnings: r.warnings ?? [],
        };
    },
});

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface FindingRow {
    kind: string;
    message: string;
}
interface Phase1 {
    metadata: FindingRow[];
    links: FindingRow[];
    headerFooter: FindingRow[];
    watermarks: FindingRow[];
    layout: FindingRow[];
    integrity: FindingRow[];
    textQuality: FindingRow[];
}
interface Phase3 {
    structural: FindingRow[];
    interactive: FindingRow[];
    attachments: FindingRow[];
    tableDepthFindings: FindingRow[];
    tableDepth: Record<string, unknown>;
}
interface Phase4 {
    images: FindingRow[];
    contrast: FindingRow[];
    chartRegions: FindingRow[];
    visualRegression: Array<FindingRow & { kind: string }>;
}
interface ValidationResult {
    summary: {
        pdfPath: string;
        specName: string;
        totalFields: number;
        fieldMatches: number;
        fieldMismatches: number;
        fieldMissing: number;
        totalTables: number;
        tableMatches: number;
        tableMismatches: number;
        tableMissing: number;
        formattingDriftCount: number;
        passed: boolean;
    };
    fields: Array<{ name: string; status: string; extracted: string | null; expected: string | null }>;
    tables: Array<{ name: string; status: string }>;
    warnings?: string[];
    phase1: Phase1;
    phase3: Phase3;
    phase4: Phase4;
    phase5: { security: FindingRow[]; barcodes: FindingRow[] };
    phase6: { versionDiff: FindingRow[] };
}

function collectFirstFailures(r: ValidationResult, max: number): Array<{ block: string; kind: string; message: string }> {
    const out: Array<{ block: string; kind: string; message: string }> = [];
    const push = (block: string, arr: FindingRow[]) => {
        for (const f of arr) {
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

function zeroSummary(overrides: { status: 'ok' | 'error'; error?: string }): {
    status: 'ok' | 'error';
    passed: boolean;
    summary: {
        fields: { total: number; matches: number; mismatches: number; missing: number };
        tables: { total: number; matches: number; mismatches: number; missing: number };
        formattingDriftCount: number;
        phase1: {
            metadata: number;
            links: number;
            headerFooter: number;
            watermarks: number;
            layout: number;
            integrity: number;
            textQuality: number;
        };
        phase3: { structural: number; interactive: number; attachments: number; tableDepth: number };
        phase4: { images: number; contrast: number; chartRegions: number; visualRegression: number };
        phase5: { security: number; barcodes: number };
        phase6: { versionDiff: number };
    };
    firstFailures: Array<{ block: string; kind: string; message: string }>;
    warnings: string[];
    error?: string;
} {
    return {
        status: overrides.status,
        passed: false,
        summary: {
            fields: { total: 0, matches: 0, mismatches: 0, missing: 0 },
            tables: { total: 0, matches: 0, mismatches: 0, missing: 0 },
            formattingDriftCount: 0,
            phase1: { metadata: 0, links: 0, headerFooter: 0, watermarks: 0, layout: 0, integrity: 0, textQuality: 0 },
            phase3: { structural: 0, interactive: 0, attachments: 0, tableDepth: 0 },
            phase4: { images: 0, contrast: 0, chartRegions: 0, visualRegression: 0 },
            phase5: { security: 0, barcodes: 0 },
            phase6: { versionDiff: 0 },
        },
        firstFailures: [],
        warnings: [],
        error: overrides.error,
    };
}
