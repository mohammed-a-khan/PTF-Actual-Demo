import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { listPrimitives, getPrimitive } from '../runtime/Primitive';
import { execute } from '../runtime/execute';
import { zodToJsonSchema } from './zod-to-json-schema';
import type { ElicitOpts, ElicitResult } from '../runtime/Primitive';

import '../tools';

const SERVER_NAME = '@mdakhan.mak/cs-qa-v6';
const SERVER_VERSION = '5.0.0-alpha';

export async function startV6Server(): Promise<void> {
    // MCP protocol supports `elicitation` capability but the installed SDK's
    // ServerCapabilities type does not yet include it — cast to keep runtime
    // behavior (still-supporting the elicitation channel for clients that
    // enable it, like older Copilot builds) without a TS wall.
    const server = new Server(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { capabilities: { tools: {}, elicitation: {} } as never },
    );

    const elicit = async (opts: ElicitOpts): Promise<ElicitResult> => {
        try {
            const request = {
                message: opts.message,
                requestedSchema: buildElicitSchema(opts),
            };
            const res = await (server as unknown as {
                request: (msg: unknown, schemaHint: unknown) => Promise<unknown>;
            }).request({ method: 'elicitation/create', params: request }, {} as unknown);
            const r = res as { action?: string; content?: Record<string, unknown> };
            if (r.action === 'accept' && r.content) {
                const v = r.content.value;
                return { accepted: true, value: v as string | boolean };
            }
            return { accepted: false };
        } catch {
            return { accepted: false };
        }
    };

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: listPrimitives().map((p) => ({
                name: p.name,
                description: p.description,
                inputSchema: zodToJsonSchema(p.inputSchema) as { type: 'object' },
            })),
        };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        const args = request.params.arguments ?? {};
        const primitive = getPrimitive(name);
        if (!primitive) {
            return {
                isError: true,
                structuredContent: { error: { code: 'unknown-tool', message: `Unknown tool: ${name}` } },
            } as unknown as { structuredContent: unknown };
        }
        const invocationId = `${name}-${Date.now()}`;
        const result = await execute(primitive, args, {
            workspaceRoot: process.cwd(),
            invocationId,
            elicit,
        });
        if (!result.ok) {
            return {
                isError: true,
                structuredContent: { error: { code: result.error, issues: result.issues ?? [] } },
            } as unknown as { structuredContent: unknown };
        }
        return { structuredContent: { result: result.output } } as unknown as { structuredContent: unknown };
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

function buildElicitSchema(opts: ElicitOpts): Record<string, unknown> {
    if (opts.schema === 'confirm') {
        return {
            type: 'object',
            properties: { value: { type: 'boolean', default: opts.default ?? false } },
            required: ['value'],
        };
    }
    if (opts.schema === 'choice') {
        return {
            type: 'object',
            properties: { value: { type: 'string', enum: opts.choices ?? [], default: opts.default } },
            required: ['value'],
        };
    }
    return {
        type: 'object',
        properties: { value: { type: 'string', default: opts.default ?? '' } },
        required: ['value'],
    };
}
