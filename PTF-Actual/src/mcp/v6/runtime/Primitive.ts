import { z } from 'zod';

export interface PrimitiveContext {
    workspaceRoot: string;
    invocationId: string;
    audit: (event: AuditEvent) => Promise<void>;
    elicit: (opts: ElicitOpts) => Promise<ElicitResult>;
}

export interface AuditEvent {
    ts: string;
    tool: string;
    input: unknown;
    outputSummary: unknown;
    durationMs: number;
    error?: string;
}

export interface ElicitOpts {
    message: string;
    schema: 'text' | 'confirm' | 'choice';
    choices?: string[];
    default?: string | boolean;
}

export interface ElicitResult {
    accepted: boolean;
    value?: string | boolean;
}

export interface Primitive<TInput, TOutput> {
    name: string;
    description: string;
    inputSchema: z.ZodType<TInput>;
    outputSchema: z.ZodType<TOutput>;
    run(ctx: PrimitiveContext, input: TInput): Promise<TOutput>;
}

const REGISTRY = new Map<string, Primitive<unknown, unknown>>();

export function registerPrimitive<TIn, TOut>(p: Primitive<TIn, TOut>): void {
    REGISTRY.set(p.name, p as unknown as Primitive<unknown, unknown>);
}

export function listPrimitives(): Primitive<unknown, unknown>[] {
    return Array.from(REGISTRY.values());
}

export function getPrimitive(name: string): Primitive<unknown, unknown> | undefined {
    return REGISTRY.get(name);
}

export function _resetRegistry(): void {
    REGISTRY.clear();
}
