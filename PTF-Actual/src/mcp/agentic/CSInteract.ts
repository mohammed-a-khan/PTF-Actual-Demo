/**
 * Agentic SDLC Platform — Interaction helper
 *
 * Renders catalog input fields through MCP elicitation when the host
 * supports it (VS Code: enum fields become native dropdowns, booleans
 * become toggles, strings become input boxes) and degrades to a numbered
 * text menu / question block the agent relays verbatim everywhere else
 * (JetBrains, CLI hosts).
 *
 * Users never write prompts either way — they pick options.
 *
 * @module agentic/CSInteract
 */

import { CSElicitation } from '../agent-platform/CSElicitation';
import { MCPSchemaProperty, MCPToolContext } from '../types/CSMCPTypes';
import { ModeInputField, PendingQuestion, TextMenu } from './types';

export type FieldAnswers = Record<string, string | number | boolean>;

export type InteractOutcome =
    | { kind: 'answers'; answers: FieldAnswers }
    | { kind: 'declined' }
    | { kind: 'unsupported' };

export class CSInteract {
    public static supported(context: MCPToolContext): boolean {
        return CSElicitation.isSupported(context);
    }

    /**
     * Ask a multi-field form via a single elicitation request. Enum fields
     * render as dropdowns. Returns 'unsupported' when the host lacks
     * elicitation so the caller can fall back to a text question.
     */
    public static async form(
        context: MCPToolContext,
        message: string,
        fields: ModeInputField[],
    ): Promise<InteractOutcome> {
        if (!CSInteract.supported(context)) return { kind: 'unsupported' };
        if (fields.length === 0) return { kind: 'answers', answers: {} };

        const properties: Record<string, MCPSchemaProperty> = {};
        const required: string[] = [];
        for (const f of fields) {
            const prop: MCPSchemaProperty = {
                type: f.type === 'enum' ? 'string' : f.type,
                title: f.title,
                description: f.description,
            } as MCPSchemaProperty;
            if (f.type === 'enum' && f.options) {
                prop.enum = f.options;
                (prop as MCPSchemaProperty & { enumNames?: string[] }).enumNames =
                    f.optionTitles ?? f.options;
            }
            if (f.pattern) prop.pattern = f.pattern;
            if (f.default !== undefined) prop.default = f.default as string;
            properties[f.id] = prop;
            if (f.required) required.push(f.id);
        }

        try {
            const result = await context.elicitation!.create({
                message,
                requestedSchema: { type: 'object', properties, required },
            });
            if (result.action === 'accept') {
                const answers: FieldAnswers = {};
                const content = (result.content ?? {}) as Record<string, unknown>;
                for (const f of fields) {
                    const v = content[f.id];
                    if (v === undefined || v === null || v === '') continue;
                    answers[f.id] =
                        f.type === 'boolean'
                            ? v === true || v === 'true'
                            : f.type === 'number'
                              ? Number(v)
                              : String(v);
                }
                return { kind: 'answers', answers };
            }
            return { kind: 'declined' };
        } catch {
            // Host advertised elicitation but failed the request — fall back.
            return { kind: 'unsupported' };
        }
    }

    /** Pick one option (mode selector). */
    public static async pick(
        context: MCPToolContext,
        message: string,
        options: Array<{ value: string; title: string; description?: string }>,
    ): Promise<{ kind: 'picked'; value: string } | { kind: 'declined' } | { kind: 'unsupported' }> {
        if (!CSInteract.supported(context)) return { kind: 'unsupported' };
        const result = await CSElicitation.pickOne(context, {
            message,
            fieldName: 'choice',
            options,
        });
        if (!result.supported) return { kind: 'unsupported' };
        if (result.action === 'accept') {
            const value = result.content['choice'];
            if (typeof value === 'string' && value.length > 0) return { kind: 'picked', value };
        }
        return { kind: 'declined' };
    }

    /** Render a PendingQuestion into a compact text block (fallback path). */
    public static questionText(question: PendingQuestion): string {
        const lines = [question.message, ''];
        for (const f of question.fields) {
            let line = `- ${f.id}${f.required ? ' (required)' : ''}: ${f.description}`;
            if (f.type === 'enum' && f.options) {
                line += ` [${f.options.join(' | ')}]`;
            }
            if (f.default !== undefined) line += ` (default: ${String(f.default)})`;
            lines.push(line);
        }
        return lines.join('\n');
    }

    /** Render a TextMenu into the exact block the agent shows verbatim. */
    public static menuText(menu: TextMenu): string {
        return [
            menu.title,
            '',
            ...menu.options.map((o) => `${o.n}. ${o.label}${o.hint ? ` — ${o.hint}` : ''}`),
            '',
            menu.prompt,
        ].join('\n');
    }
}
