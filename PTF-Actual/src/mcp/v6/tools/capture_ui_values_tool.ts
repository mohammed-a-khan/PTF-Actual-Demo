/**
 * cs_qa_capture_ui_values — Side-buffer for UI-captured expected values.
 *
 * Supports the "ui-capture" pattern for report validation: as data-entry
 * step-defs fill fields on a form, they record what they typed into a
 * per-run buffer. At validate time, the buffer becomes the expectedValues
 * bag for the SimpleReportSpec validator — no separate test-data file
 * needed.
 *
 * Storage is `.cct-qa/ui-capture-<runId>.jsonl` — one JSON object per line,
 * append-only. Reads collect the LATEST value per fieldName (later writes
 * win — supports "re-enter the field" flows).
 *
 * Verbs:
 *   - record  : Persist { fieldName, value } to the run's buffer.
 *   - dump    : Return the assembled bag (fieldName → latest value).
 *   - clear   : Delete the buffer for a given runId.
 *   - list    : List runIds with active buffers on disk.
 *
 * @module mcp/v6/tools/capture_ui_values_tool
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

function bufferPath(workspaceRoot: string, runId: string): string {
    return path.join(workspaceRoot, '.cct-qa', `ui-capture-${runId}.jsonl`);
}

registerPrimitive({
    name: 'cs_qa_capture_ui_values',
    description:
        'Per-run side-buffer for UI-captured expected values. Data-entry step-defs call verb=record to remember what they typed; validate-time reads via verb=dump to build expectedValues bag. File-backed (.cct-qa/ui-capture-<runId>.jsonl), append-only, last-write-wins per field. Verbs: record, dump, clear, list.',
    inputSchema: z.discriminatedUnion('verb', [
        z.object({
            verb: z.literal('record'),
            runId: z.string().min(1).max(120),
            fieldName: z.string().min(1).max(120),
            value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
            source: z
                .string()
                .max(80)
                .default('ui-fill')
                .describe('Free-text tag — where the capture came from (ui-fill, ui-select, ui-fetch, etc).'),
        }),
        z.object({ verb: z.literal('dump'), runId: z.string().min(1).max(120) }),
        z.object({ verb: z.literal('clear'), runId: z.string().min(1).max(120) }),
        z.object({ verb: z.literal('list') }),
    ]),
    outputSchema: z.union([
        z.object({
            status: z.enum(['ok', 'error']),
            verb: z.literal('record'),
            runId: z.string(),
            fieldName: z.string(),
            error: z.string().optional(),
        }),
        z.object({
            status: z.enum(['ok', 'error']),
            verb: z.literal('dump'),
            runId: z.string(),
            fieldCount: z.number(),
            bag: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
            error: z.string().optional(),
        }),
        z.object({
            status: z.enum(['ok', 'error']),
            verb: z.literal('clear'),
            runId: z.string(),
            deleted: z.boolean(),
            error: z.string().optional(),
        }),
        z.object({
            status: z.enum(['ok', 'error']),
            verb: z.literal('list'),
            runIds: z.array(z.string()),
            error: z.string().optional(),
        }),
    ]),
    async run(ctx, input) {
        try {
            if (input.verb === 'record') {
                const p = bufferPath(ctx.workspaceRoot, input.runId);
                fs.mkdirSync(path.dirname(p), { recursive: true });
                const row = {
                    ts: new Date().toISOString(),
                    fieldName: input.fieldName,
                    value: input.value,
                    source: input.source,
                };
                fs.appendFileSync(p, JSON.stringify(row) + '\n', 'utf-8');
                return { status: 'ok' as const, verb: 'record' as const, runId: input.runId, fieldName: input.fieldName };
            }
            if (input.verb === 'dump') {
                const p = bufferPath(ctx.workspaceRoot, input.runId);
                if (!fs.existsSync(p)) {
                    return { status: 'ok' as const, verb: 'dump' as const, runId: input.runId, fieldCount: 0, bag: {} };
                }
                const bag: Record<string, string | number | boolean | null> = {};
                const lines = fs.readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
                for (const l of lines) {
                    try {
                        const row = JSON.parse(l) as { fieldName?: string; value?: string | number | boolean | null };
                        if (row.fieldName !== undefined) bag[row.fieldName] = row.value ?? null;
                    } catch {
                        /* skip malformed line */
                    }
                }
                return {
                    status: 'ok' as const,
                    verb: 'dump' as const,
                    runId: input.runId,
                    fieldCount: Object.keys(bag).length,
                    bag,
                };
            }
            if (input.verb === 'clear') {
                const p = bufferPath(ctx.workspaceRoot, input.runId);
                const existed = fs.existsSync(p);
                if (existed) fs.unlinkSync(p);
                return { status: 'ok' as const, verb: 'clear' as const, runId: input.runId, deleted: existed };
            }
            // list
            const dir = path.join(ctx.workspaceRoot, '.cct-qa');
            if (!fs.existsSync(dir)) return { status: 'ok' as const, verb: 'list' as const, runIds: [] };
            const runIds = fs
                .readdirSync(dir)
                .filter((f) => f.startsWith('ui-capture-') && f.endsWith('.jsonl'))
                .map((f) => f.slice('ui-capture-'.length, -'.jsonl'.length));
            return { status: 'ok' as const, verb: 'list' as const, runIds };
        } catch (e) {
            const err = (e as Error).message;
            if (input.verb === 'record')
                return { status: 'error' as const, verb: 'record' as const, runId: input.runId, fieldName: input.fieldName, error: err };
            if (input.verb === 'dump')
                return { status: 'error' as const, verb: 'dump' as const, runId: input.runId, fieldCount: 0, bag: {}, error: err };
            if (input.verb === 'clear')
                return { status: 'error' as const, verb: 'clear' as const, runId: input.runId, deleted: false, error: err };
            return { status: 'error' as const, verb: 'list' as const, runIds: [], error: err };
        }
    },
});
