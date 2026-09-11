/**
 * cs_qa_report_spec_init — Generate a starter SimpleReportSpec from a sample PDF.
 *
 * Thin wrapper around `runReportSpecInit` (the CLI adapter shipped in v1.50.0).
 * The heavy lifting — PDF parse → field detection → table detection →
 * starter `checks:` block emission — lives in the framework module. This
 * primitive exists so Copilot can invoke it via MCP with a typed contract
 * instead of shelling out to the CLI.
 *
 * Returns a small envelope — filename, counts, which starter checks were
 * enabled. The full spec content is on disk at `outPath` for the model to
 * read via `cs_qa_fs` when it needs to inspect / edit specific fields.
 *
 * @module mcp/v6/tools/report_spec_init_tool
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

registerPrimitive({
    name: 'cs_qa_report_spec_init',
    description:
        'Generate a starter SimpleReportSpec JSON file from a sample PDF report. Uses the framework\'s CSReportSimpleSpecGenerator — auto-detects fields, tables, presence markers, and emits a safe starter `checks:` block based on facts the sample already satisfies (page count, header/footer identity, text-quality scan). The output is a starting point the consumer edits + commits. Verbs: init.',
    inputSchema: z.object({
        verb: z.literal('init'),
        pdfPath: z.string().min(1).describe('Absolute or workspace-relative path to the sample PDF.'),
        outPath: z
            .string()
            .min(1)
            .describe('Destination JSON file path (parent dirs auto-created). Typically config/report-specs/<name>.json.'),
        specName: z
            .string()
            .optional()
            .describe('Spec name written into the JSON. Default: kebab-case of PDF filename.'),
        force: z
            .boolean()
            .default(false)
            .describe('Overwrite an existing outPath. Default false — refuses if the file exists.'),
        dryRun: z
            .boolean()
            .default(false)
            .describe('Print what would be written without touching disk.'),
        includeTemplateMarkers: z
            .boolean()
            .default(true)
            .describe('Emit presenceOfText markers for fixed template strings.'),
        includeLabeledFields: z
            .boolean()
            .default(true)
            .describe('Emit label-anchored extract fields.'),
        includeTables: z.boolean().default(true).describe('Emit table specs.'),
        maxTemplateMarkers: z
            .number()
            .int()
            .positive()
            .max(200)
            .default(30)
            .describe('Cap on presence-marker emission to avoid 200-field auto-specs.'),
        minRowsForTable: z
            .number()
            .int()
            .positive()
            .max(50)
            .default(2)
            .describe('Minimum row count to treat a section as a table.'),
    }),
    outputSchema: z.object({
        status: z.enum(['ok', 'skipped', 'error']),
        written: z.boolean(),
        outPath: z.string(),
        fieldsEmitted: z.number(),
        tablesEmitted: z.number(),
        presenceMarkersEmitted: z.number(),
        checksEnabled: z.array(z.string()),
        dryRun: z.boolean(),
        notes: z.array(z.string()),
        skippedReason: z.string().optional(),
        error: z.string().optional(),
    }),
    async run(ctx, input) {
        const outAbs = path.isAbsolute(input.outPath)
            ? input.outPath
            : path.resolve(ctx.workspaceRoot, input.outPath);
        const pdfAbs = path.isAbsolute(input.pdfPath)
            ? input.pdfPath
            : path.resolve(ctx.workspaceRoot, input.pdfPath);

        // Refuse quietly if outPath exists and force is false — same policy as the CLI.
        if (!input.force && !input.dryRun && fs.existsSync(outAbs)) {
            return {
                status: 'skipped' as const,
                written: false,
                outPath: outAbs,
                fieldsEmitted: 0,
                tablesEmitted: 0,
                presenceMarkersEmitted: 0,
                checksEnabled: [],
                dryRun: false,
                notes: [],
                skippedReason: `Refusing to overwrite existing file: ${outAbs}. Pass force:true to overwrite.`,
            };
        }
        if (!fs.existsSync(pdfAbs)) {
            return {
                status: 'error' as const,
                written: false,
                outPath: outAbs,
                fieldsEmitted: 0,
                tablesEmitted: 0,
                presenceMarkersEmitted: 0,
                checksEnabled: [],
                dryRun: input.dryRun,
                notes: [],
                error: `PDF not found: ${pdfAbs}`,
            };
        }

        // Soft-import the framework's generator — the entire report-validation
        // module ships in the same package. Kept as a runtime require so the
        // MCP module still loads if the report-validation subpath ever moves.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { runReportSpecInit } = require('../../../report-validation/CSReportSimpleSpecGeneratorCli');

        try {
            const result = await runReportSpecInit({
                pdfPath: pdfAbs,
                outPath: outAbs,
                specName: input.specName,
                force: input.force,
                dryRun: input.dryRun,
                includeTemplateMarkers: input.includeTemplateMarkers,
                includeLabeledFields: input.includeLabeledFields,
                includeTables: input.includeTables,
                maxTemplateMarkers: input.maxTemplateMarkers,
                minRowsForTable: input.minRowsForTable,
            });
            if (result.skippedReason) {
                return {
                    status: 'skipped' as const,
                    written: false,
                    outPath: outAbs,
                    fieldsEmitted: 0,
                    tablesEmitted: 0,
                    presenceMarkersEmitted: 0,
                    checksEnabled: [],
                    dryRun: input.dryRun,
                    notes: [],
                    skippedReason: result.skippedReason,
                };
            }
            // Read the emitted spec to introspect which check blocks are enabled.
            // Cheap: the file was just written and is at most a few hundred KB.
            let checksEnabled: string[] = [];
            if (!input.dryRun && fs.existsSync(outAbs)) {
                try {
                    const spec = JSON.parse(fs.readFileSync(outAbs, 'utf-8'));
                    if (spec.checks && typeof spec.checks === 'object') {
                        checksEnabled = Object.keys(spec.checks);
                    }
                } catch {
                    /* parse failed — leave checksEnabled empty */
                }
            }
            await ctx.audit({
                ts: new Date().toISOString(),
                tool: 'cs_qa_report_spec_init',
                input: { pdfPath: input.pdfPath, outPath: input.outPath, force: input.force, dryRun: input.dryRun },
                outputSummary: {
                    fieldsEmitted: result.fieldsEmitted,
                    tablesEmitted: result.tablesEmitted,
                    checksEnabled,
                },
                durationMs: 0,
            });
            return {
                status: 'ok' as const,
                written: !input.dryRun,
                outPath: outAbs,
                fieldsEmitted: result.fieldsEmitted,
                tablesEmitted: result.tablesEmitted,
                presenceMarkersEmitted: result.presenceMarkersEmitted,
                checksEnabled,
                dryRun: input.dryRun,
                notes: result.notes ?? [],
            };
        } catch (e) {
            return {
                status: 'error' as const,
                written: false,
                outPath: outAbs,
                fieldsEmitted: 0,
                tablesEmitted: 0,
                presenceMarkersEmitted: 0,
                checksEnabled: [],
                dryRun: input.dryRun,
                notes: [],
                error: (e as Error).message,
            };
        }
    },
});
