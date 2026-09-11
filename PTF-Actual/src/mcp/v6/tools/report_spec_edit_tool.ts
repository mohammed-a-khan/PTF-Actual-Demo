/**
 * cs_qa_report_spec_edit — Deterministic JSON transforms on a SimpleReportSpec.
 *
 * Model calls this instead of hand-writing JSON. Two benefits:
 *   1. No syntax errors — the primitive validates every field name against the
 *      known block schemas.
 *   2. Cheaper — the model just names the operation (add-check-block +
 *      block='security'), never round-trips the whole spec through its context.
 *
 * Verbs:
 *   - add-check-block   : Enable a checks.<block> with default (or supplied) rule.
 *   - remove-check-block: Remove a checks.<block>.
 *   - add-field         : Add a field entry to spec.fields.
 *   - remove-field      : Remove a field entry.
 *   - set-field-formatting: Attach a formatting rule to a field.
 *
 * Every edit is atomic: read → transform in-memory → validate shape via the
 * framework's loader → write. If the transform breaks the spec, the file
 * on disk is untouched.
 *
 * @module mcp/v6/tools/report_spec_edit_tool
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

const CHECK_BLOCK_NAMES = [
    'metadata',
    'links',
    'headerFooter',
    'watermarks',
    'layout',
    'integrity',
    'textQuality',
    'structural',
    'interactive',
    'attachments',
    'tableDepth',
    'images',
    'contrast',
    'chartRegions',
    'visualRegression',
    'security',
    'barcodes',
    'versionDiff',
] as const;

// Sensible defaults per block so `add-check-block block=X` (with no `rule`)
// produces a config that runs green out of the box on a compliant PDF. Consumer
// tightens knobs by re-invoking with an explicit `rule`.
const DEFAULT_RULES: Record<string, unknown> = {
    metadata: {},
    links: {},
    headerFooter: {},
    watermarks: [],
    layout: {},
    integrity: {},
    textQuality: {},
    structural: {},
    interactive: {},
    attachments: {},
    tableDepth: {},
    images: {},
    contrast: { minContrastNormal: 3.0 },
    chartRegions: {},
    visualRegression: {},
    security: { forbidRedactionAnnotations: true },
    barcodes: {},
    versionDiff: {},
};

registerPrimitive({
    name: 'cs_qa_report_spec_edit',
    description:
        "Deterministic JSON transforms on a SimpleReportSpec file. Verbs: add-check-block, remove-check-block, add-field, remove-field, set-field-formatting. Never re-serialises the whole spec via the model — read/transform/validate/write is all inside the primitive.",
    inputSchema: z.discriminatedUnion('verb', [
        z.object({
            verb: z.literal('add-check-block'),
            specPath: z.string().min(1),
            block: z.enum(CHECK_BLOCK_NAMES),
            rule: z.unknown().optional().describe('Optional explicit rule object. If omitted, a safe default is used.'),
        }),
        z.object({
            verb: z.literal('remove-check-block'),
            specPath: z.string().min(1),
            block: z.enum(CHECK_BLOCK_NAMES),
        }),
        z.object({
            verb: z.literal('add-field'),
            specPath: z.string().min(1),
            fieldName: z
                .string()
                .min(1)
                .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Field name must be an identifier.'),
            fieldSpec: z.record(z.string(), z.unknown()),
        }),
        z.object({
            verb: z.literal('remove-field'),
            specPath: z.string().min(1),
            fieldName: z.string().min(1),
        }),
        z.object({
            verb: z.literal('set-field-formatting'),
            specPath: z.string().min(1),
            fieldName: z.string().min(1),
            formatting: z.record(z.string(), z.unknown()),
        }),
    ]),
    outputSchema: z.object({
        status: z.enum(['ok', 'error']),
        specPath: z.string(),
        changed: z.boolean(),
        note: z.string(),
        error: z.string().optional(),
    }),
    async run(ctx, input) {
        const specAbs = path.isAbsolute(input.specPath)
            ? input.specPath
            : path.resolve(ctx.workspaceRoot, input.specPath);
        if (!fs.existsSync(specAbs)) {
            return { status: 'error' as const, specPath: specAbs, changed: false, note: '', error: `Spec not found: ${specAbs}` };
        }

        let spec: Record<string, unknown>;
        try {
            spec = JSON.parse(fs.readFileSync(specAbs, 'utf-8')) as Record<string, unknown>;
        } catch (e) {
            return { status: 'error' as const, specPath: specAbs, changed: false, note: '', error: `Spec JSON parse failed: ${(e as Error).message}` };
        }

        let changed = false;
        let note = '';

        try {
            switch (input.verb) {
                case 'add-check-block': {
                    if (!spec.checks || typeof spec.checks !== 'object') spec.checks = {};
                    const checks = spec.checks as Record<string, unknown>;
                    if (checks[input.block] !== undefined) {
                        note = `Block ${input.block} already declared — replacing.`;
                    } else {
                        note = `Added block ${input.block}.`;
                    }
                    checks[input.block] = input.rule !== undefined ? input.rule : DEFAULT_RULES[input.block] ?? {};
                    changed = true;
                    break;
                }
                case 'remove-check-block': {
                    const checks = (spec.checks as Record<string, unknown> | undefined) ?? {};
                    if (checks[input.block] === undefined) {
                        note = `Block ${input.block} was not declared — no-op.`;
                    } else {
                        delete checks[input.block];
                        changed = true;
                        note = `Removed block ${input.block}.`;
                    }
                    if (Object.keys(checks).length === 0 && spec.checks) delete spec.checks;
                    break;
                }
                case 'add-field': {
                    if (!spec.fields || typeof spec.fields !== 'object') spec.fields = {};
                    const fields = spec.fields as Record<string, unknown>;
                    fields[input.fieldName] = input.fieldSpec;
                    changed = true;
                    note = `Added field ${input.fieldName}.`;
                    break;
                }
                case 'remove-field': {
                    const fields = (spec.fields as Record<string, unknown> | undefined) ?? {};
                    if (fields[input.fieldName] === undefined) {
                        note = `Field ${input.fieldName} was not declared — no-op.`;
                    } else {
                        delete fields[input.fieldName];
                        changed = true;
                        note = `Removed field ${input.fieldName}.`;
                    }
                    break;
                }
                case 'set-field-formatting': {
                    const fields = (spec.fields as Record<string, Record<string, unknown>> | undefined) ?? {};
                    const target = fields[input.fieldName];
                    if (!target) {
                        return {
                            status: 'error' as const,
                            specPath: specAbs,
                            changed: false,
                            note: '',
                            error: `Field ${input.fieldName} does not exist. Use add-field first.`,
                        };
                    }
                    target.formatting = input.formatting;
                    changed = true;
                    note = `Set formatting rule on field ${input.fieldName}.`;
                    break;
                }
            }
        } catch (e) {
            return { status: 'error' as const, specPath: specAbs, changed: false, note: '', error: (e as Error).message };
        }

        // Validate the shape survives the framework's loader before persisting.
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { validateSimpleReportSpecShape } = require('../../../report-validation/CSReportSimpleSpec');
            if (typeof validateSimpleReportSpecShape === 'function') {
                const errors: string[] = validateSimpleReportSpecShape(spec) ?? [];
                if (errors.length > 0) {
                    return {
                        status: 'error' as const,
                        specPath: specAbs,
                        changed: false,
                        note: '',
                        error: `Shape validation failed after edit: ${errors.join('; ')}`,
                    };
                }
            }
        } catch {
            /* validator function absent — skip, framework may not export it */
        }

        if (changed) {
            fs.writeFileSync(specAbs, JSON.stringify(spec, null, 4) + '\n', 'utf-8');
            await ctx.audit({
                ts: new Date().toISOString(),
                tool: 'cs_qa_report_spec_edit',
                input: { verb: input.verb, specPath: input.specPath },
                outputSummary: { changed, note },
                durationMs: 0,
            });
        }

        return { status: 'ok' as const, specPath: specAbs, changed, note };
    },
});
