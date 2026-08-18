import { appendAudit } from './audit';
import type { Primitive, PrimitiveContext } from './Primitive';

export interface ExecuteOptions {
    workspaceRoot: string;
    invocationId: string;
    elicit?: PrimitiveContext['elicit'];
}

export async function execute<TIn, TOut>(
    primitive: Primitive<TIn, TOut>,
    rawInput: unknown,
    opts: ExecuteOptions,
): Promise<{ ok: true; output: TOut } | { ok: false; error: string; issues?: unknown[] }> {
    const started = Date.now();
    const parsed = primitive.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
        return { ok: false, error: 'input-schema-failed', issues: parsed.error.issues };
    }
    // Preserve destructive-op confirmation bypasses that individual tool
    // schemas may not declare. Zod strips unknown keys by default; without
    // this, `confirmed:true` from the caller would silently vanish and every
    // destructive tool would re-prompt via elicitation — which does not work
    // in MCP clients (like Copilot Chat) that don't implement the
    // elicitation capability. Two-phase confirmation lives on the input.
    if (rawInput && typeof rawInput === 'object' && parsed.data && typeof parsed.data === 'object') {
        const src = rawInput as Record<string, unknown>;
        const dst = parsed.data as Record<string, unknown>;
        for (const key of ['confirmed', 'bugCreationStrategy']) {
            if (src[key] !== undefined && dst[key] === undefined) dst[key] = src[key];
        }
    }
    const ctx: PrimitiveContext = {
        workspaceRoot: opts.workspaceRoot,
        invocationId: opts.invocationId,
        audit: appendAudit,
        elicit: opts.elicit ?? (async () => ({ accepted: false })),
    };
    try {
        const output = await primitive.run(ctx, parsed.data);
        const verified = primitive.outputSchema.safeParse(output);
        if (!verified.success) {
            await appendAudit({
                ts: new Date().toISOString(),
                tool: primitive.name,
                input: parsed.data,
                outputSummary: { schemaFailed: true },
                durationMs: Date.now() - started,
                error: 'output-schema-failed',
            });
            return { ok: false, error: 'output-schema-failed', issues: verified.error.issues };
        }
        await appendAudit({
            ts: new Date().toISOString(),
            tool: primitive.name,
            input: parsed.data,
            outputSummary: summarize(output),
            durationMs: Date.now() - started,
        });
        return { ok: true, output };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await appendAudit({
            ts: new Date().toISOString(),
            tool: primitive.name,
            input: parsed.data,
            outputSummary: null,
            durationMs: Date.now() - started,
            error: msg,
        });
        return { ok: false, error: msg };
    }
}

function summarize(output: unknown): unknown {
    if (output && typeof output === 'object') {
        const o = output as Record<string, unknown>;
        const summary: Record<string, unknown> = {};
        for (const key of Object.keys(o)) {
            const v = o[key];
            if (typeof v === 'string') summary[key] = v.length > 200 ? v.slice(0, 200) + '…' : v;
            else if (Array.isArray(v)) summary[key] = `array[${v.length}]`;
            else if (v && typeof v === 'object') summary[key] = 'object';
            else summary[key] = v;
        }
        return summary;
    }
    return output;
}
