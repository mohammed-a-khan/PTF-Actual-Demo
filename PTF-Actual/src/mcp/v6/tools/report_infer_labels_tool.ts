/**
 * cs_qa_report_infer_labels — What PDF labels does my test data NOT cover?
 *
 * Scans a PDF for plausible label candidates (colon-suffix or Title/ALLCAPS
 * short strings) and returns those NOT present in the caller's `knownLabels`
 * list. Two use-cases:
 *
 *   1. Consumer runs it standalone: "did I miss anything the PDF has?"
 *   2. Agent invokes it inside `/generate-pdf-tests` to pre-populate the
 *      test-data JSON template with detected labels the consumer just fills.
 *
 * Cheap — runs the extractor once, does regex classification, returns a
 * bounded list. No spec required.
 *
 * @module mcp/v6/tools/report_infer_labels_tool
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

registerPrimitive({
    name: 'cs_qa_report_infer_labels',
    description:
        "Scan a PDF for plausible label candidates and return those not in the caller's knownLabels list. Used by /generate-pdf-tests to pre-populate test-data JSON templates, and standalone for 'did I miss anything?' audits. Verbs: infer.",
    inputSchema: z.object({
        verb: z.literal('infer'),
        pdfPath: z.string().min(1),
        knownLabels: z
            .array(z.string())
            .default([])
            .describe('Case-insensitive labels the caller already covers. Detected labels matching any are excluded.'),
        max: z.number().int().positive().max(500).default(100).describe('Cap on returned labels.'),
    }),
    outputSchema: z.object({
        status: z.enum(['ok', 'error']),
        pdfPath: z.string(),
        detectedCount: z.number(),
        labels: z.array(
            z.object({
                label: z.string(),
                page: z.number(),
                suggestedReadFrom: z.enum(['inline', 'right', 'below', 'belowLine', 'leftOf']),
            }),
        ),
        error: z.string().optional(),
    }),
    async run(ctx, input) {
        const pdfAbs = path.isAbsolute(input.pdfPath) ? input.pdfPath : path.resolve(ctx.workspaceRoot, input.pdfPath);
        if (!fs.existsSync(pdfAbs)) {
            return {
                status: 'error' as const,
                pdfPath: pdfAbs,
                detectedCount: 0,
                labels: [],
                error: `PDF not found: ${pdfAbs}`,
            };
        }
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { inferLabels } = require('../../../report-validation/CSReportSimpleValidatorFromData');
        try {
            const all: Array<{ label: string; page: number; suggestedReadFrom: 'inline' | 'right' | 'below' | 'belowLine' | 'leftOf' }> =
                await inferLabels(pdfAbs, input.knownLabels);
            const capped = all.slice(0, input.max);
            await ctx.audit({
                ts: new Date().toISOString(),
                tool: 'cs_qa_report_infer_labels',
                input: { pdfPath: input.pdfPath, knownLabelCount: input.knownLabels.length, max: input.max },
                outputSummary: { detectedCount: all.length, returned: capped.length },
                durationMs: 0,
            });
            return {
                status: 'ok' as const,
                pdfPath: pdfAbs,
                detectedCount: all.length,
                labels: capped,
            };
        } catch (e) {
            return {
                status: 'error' as const,
                pdfPath: pdfAbs,
                detectedCount: 0,
                labels: [],
                error: (e as Error).message,
            };
        }
    },
});
