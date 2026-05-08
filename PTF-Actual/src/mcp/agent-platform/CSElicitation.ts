/**
 * Agentic Test Platform — Elicitation helper
 *
 * Thin wrapper around `context.elicitation.create()` that handles:
 *
 *   - Host capability detection (Copilot 1.102+ supports it; older
 *     hosts and other clients may not)
 *   - The three outcome shapes (`accept` / `decline` / `cancel`)
 *   - Schema constraints from the MCP spec (flat object only, no
 *     nested objects, no arrays of objects beyond enum-arrays, no
 *     password / token fields in form mode)
 *   - Standard schema builders for the common ADO + URL+creds flows:
 *     `pickOne`, `pickMany`, `confirm`, `text`
 *
 * **Why not call `context.elicitation.create()` directly?** The
 * raw API is generic — every caller would have to handle capability
 * detection, build the `requestedSchema` JSON, parse the action
 * variants, and decide what to do on decline / cancel. This helper
 * collapses that to a single typed call per question.
 *
 * **Capability check.** If the host doesn't expose elicitation
 * (`context.elicitation` is undefined), the helper returns
 * `{ supported: false, ... }` so callers can pick a fallback path
 * (process everything, ask the user via a BLOCKED return, etc.).
 *
 * **MCP schema rules** (from spec 2025-06-18):
 *   - `requestedSchema.type` MUST be `'object'`
 *   - `properties` are limited to primitives: string, number, integer,
 *     boolean, single-select enum, multi-select via `array` of enums
 *   - No nested objects, no arrays-of-objects (other than enum-arrays)
 *   - Form mode MUST NOT request passwords / tokens / API keys —
 *     use URL mode for credentials, or pass via env vars instead
 *
 * @module agent-platform/CSElicitation
 */

import { MCPElicitationResult, MCPSchemaProperty, MCPToolContext } from '../types/CSMCPTypes';

// ============================================================================
// Public Types
// ============================================================================

export type ElicitOutcome<T> =
    | { supported: false }
    | { supported: true; action: 'accept'; content: T }
    | { supported: true; action: 'decline' }
    | { supported: true; action: 'cancel' };

/** A single option in a pick-one or pick-many list. `value` becomes the returned string. */
export interface ElicitOption {
    value: string;
    title: string;
    description?: string;
}

// ============================================================================
// CSElicitation
// ============================================================================

export class CSElicitation {
    /**
     * Capability check. True iff the host has advertised elicitation
     * support during init. Always check before calling `ask*` — the
     * helpers also check internally and return `supported: false`,
     * but knowing up-front lets callers skip building the schema.
     */
    public static isSupported(context: MCPToolContext): boolean {
        return typeof context.elicitation?.create === 'function';
    }

    /**
     * Pick one value from a closed list. Returns the chosen `value`
     * string on accept; falls back to `defaultValue` if supplied and
     * elicitation isn't supported.
     *
     * @example
     *   const r = await CSElicitation.pickOne(ctx, {
     *     message: 'Which environment?',
     *     fieldName: 'env',
     *     options: [
     *       { value: 'dev', title: 'Development' },
     *       { value: 'sit', title: 'System Integration' },
     *       { value: 'uat', title: 'User Acceptance' },
     *     ],
     *   });
     *   if (r.supported && r.action === 'accept') console.log(r.content.env);
     */
    public static async pickOne(
        context: MCPToolContext,
        params: {
            message: string;
            fieldName?: string;
            description?: string;
            options: ElicitOption[];
            defaultValue?: string;
        },
    ): Promise<ElicitOutcome<{ [k: string]: string }>> {
        if (!CSElicitation.isSupported(context)) return { supported: false };
        const fieldName = params.fieldName ?? 'choice';

        const enumValues = params.options.map((o) => o.value);
        const enumNames = params.options.map((o) => o.title);

        const property: MCPSchemaProperty = {
            type: 'string',
            description: params.description,
            enum: enumValues,
            enumNames,
        };
        if (params.defaultValue && enumValues.includes(params.defaultValue)) {
            property.default = params.defaultValue;
        }

        return CSElicitation.callElicit(context, {
            message: params.message,
            requestedSchema: {
                type: 'object',
                properties: { [fieldName]: property },
                required: [fieldName],
            },
        });
    }

    /**
     * Pick many values from a closed list (multi-select). Returns an
     * array of chosen `value` strings on accept.
     */
    public static async pickMany(
        context: MCPToolContext,
        params: {
            message: string;
            fieldName?: string;
            description?: string;
            options: ElicitOption[];
            minPicks?: number;
            maxPicks?: number;
        },
    ): Promise<ElicitOutcome<{ [k: string]: string[] }>> {
        if (!CSElicitation.isSupported(context)) return { supported: false };
        const fieldName = params.fieldName ?? 'choices';

        const enumValues = params.options.map((o) => o.value);
        const enumNames = params.options.map((o) => o.title);

        const property: MCPSchemaProperty = {
            type: 'array',
            description: params.description,
            items: {
                type: 'string',
                enum: enumValues,
                enumNames,
            } as MCPSchemaProperty,
        };
        if (typeof params.minPicks === 'number') {
            property.minItems = params.minPicks;
        }
        if (typeof params.maxPicks === 'number') {
            property.maxItems = params.maxPicks;
        }

        return CSElicitation.callElicit(context, {
            message: params.message,
            requestedSchema: {
                type: 'object',
                properties: { [fieldName]: property },
                required: [fieldName],
            },
        });
    }

    /**
     * Yes / no confirmation. Returns boolean on accept.
     */
    public static async confirm(
        context: MCPToolContext,
        params: {
            message: string;
            fieldName?: string;
            description?: string;
            defaultValue?: boolean;
        },
    ): Promise<ElicitOutcome<{ [k: string]: boolean }>> {
        if (!CSElicitation.isSupported(context)) return { supported: false };
        const fieldName = params.fieldName ?? 'confirm';

        const property: MCPSchemaProperty = {
            type: 'boolean',
            description: params.description,
        };
        if (typeof params.defaultValue === 'boolean') {
            property.default = params.defaultValue;
        }

        return CSElicitation.callElicit(context, {
            message: params.message,
            requestedSchema: {
                type: 'object',
                properties: { [fieldName]: property },
                required: [fieldName],
            },
        });
    }

    /**
     * Free-text input. NEVER use for passwords / tokens / API keys —
     * the MCP spec forbids form-mode elicitation of secrets. For
     * credentials, accept them through env vars / mcp.json `inputs`
     * (which use VS Code SecretStorage) instead.
     */
    public static async text(
        context: MCPToolContext,
        params: {
            message: string;
            fieldName?: string;
            description?: string;
            minLength?: number;
            maxLength?: number;
            pattern?: string;
            format?: 'email' | 'uri' | 'date' | 'date-time';
        },
    ): Promise<ElicitOutcome<{ [k: string]: string }>> {
        if (!CSElicitation.isSupported(context)) return { supported: false };
        const fieldName = params.fieldName ?? 'value';

        const property: MCPSchemaProperty = {
            type: 'string',
            description: params.description,
        };
        if (typeof params.minLength === 'number') {
            property.minLength = params.minLength;
        }
        if (typeof params.maxLength === 'number') {
            property.maxLength = params.maxLength;
        }
        if (params.pattern) {
            property.pattern = params.pattern;
        }
        if (params.format) {
            property.format = params.format;
        }

        return CSElicitation.callElicit(context, {
            message: params.message,
            requestedSchema: {
                type: 'object',
                properties: { [fieldName]: property },
                required: [fieldName],
            },
        });
    }

    // ---------------------------------------------------------------------
    // Internal: actual MCP elicitation/create call
    // ---------------------------------------------------------------------

    private static async callElicit<T>(
        context: MCPToolContext,
        request: { message: string; requestedSchema: { type: 'object'; properties: Record<string, MCPSchemaProperty>; required?: string[] } },
    ): Promise<ElicitOutcome<T>> {
        try {
            const result: MCPElicitationResult = await context.elicitation!.create(request);
            switch (result.action) {
                case 'accept':
                    return {
                        supported: true,
                        action: 'accept',
                        content: (result.content ?? {}) as T,
                    };
                case 'decline':
                    return { supported: true, action: 'decline' };
                case 'cancel':
                default:
                    return { supported: true, action: 'cancel' };
            }
        } catch (err) {
            // Treat any error from the host the same as cancel — the tool
            // run continues with a fallback path.
            context.log(
                'warning',
                `CSElicitation: host returned error on elicit; treating as cancel`,
                { error: err instanceof Error ? err.message : String(err) },
            );
            return { supported: true, action: 'cancel' };
        }
    }
}
