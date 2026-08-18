import { z } from 'zod';

/**
 * Convert a Zod schema to a JSON Schema (draft-2020-12) using Zod v4's
 * built-in converter. Falls back to a minimal object shape on any error so
 * the MCP ListTools response never crashes even for exotic schemas.
 *
 * Uses `io: 'input'` so fields with `.default()` are treated as OPTIONAL in
 * the emitted schema (Zod's default `io: 'output'` marks them required, which
 * confuses MCP clients like Copilot into sending redundant fields — or,
 * worse, thinking they can't be omitted). Also strips `additionalProperties`
 * gating that Zod adds by default so a client can add a harmless extra
 * without a wholesale schema-validation failure at the transport layer.
 */
export function zodToJsonSchema(schema: z.ZodType<unknown>): unknown {
    try {
        const toJson = (z as unknown as { toJSONSchema?: (s: z.ZodType<unknown>, opts?: Record<string, unknown>) => unknown }).toJSONSchema;
        if (typeof toJson === 'function') {
            const raw = toJson(schema, { io: 'input' });
            return relaxAdditionalProperties(raw);
        }
    } catch {
        // fall through
    }
    return { type: 'object', additionalProperties: true };
}

/**
 * Recursively remove `additionalProperties: false` from object schemas — MCP
 * clients occasionally add wrapper properties (e.g. `__source`, `_meta`) that
 * a strict schema would reject at the transport layer without ever reaching
 * the tool. Keeping it permissive at the JSON-schema layer is safe because
 * Zod itself still validates at runtime.
 */
function relaxAdditionalProperties(node: unknown): unknown {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(relaxAdditionalProperties);
    const obj = node as Record<string, unknown>;
    if (obj.type === 'object' && obj.additionalProperties === false) delete obj.additionalProperties;
    for (const k of Object.keys(obj)) obj[k] = relaxAdditionalProperties(obj[k]);
    return obj;
}
