import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

function memRoot(): string {
    return process.env.CS_QA_V6_HOME
        ? path.join(process.env.CS_QA_V6_HOME, 'memory')
        : path.join(os.homedir(), '.cs-qa', 'v6', 'memory');
}

function scopeDir(scope: 'global' | 'project', projectSlug?: string): string {
    if (scope === 'project' && projectSlug) return path.join(memRoot(), 'project', projectSlug);
    return path.join(memRoot(), 'global');
}

interface MemoryEntry {
    id: string;
    ts: string;
    kind: string;
    tags: string[];
    content: string;
    source?: string;
}

registerPrimitive({
    name: 'cs_qa_memory',
    description: 'Persistent memory across runs. Verbs: remember (write a learned pattern/heal/fact), recall (search by tags or keywords), forget (delete by id). Scoped as global or project:<slug>. Use for: learned heals ("in <app> login step text is X"), framework quirks discovered at runtime, recurring failure patterns, resolved unknowns.',
    inputSchema: z.discriminatedUnion('verb', [
        z.object({
            verb: z.literal('remember'),
            scope: z.enum(['global', 'project']).default('project'),
            projectSlug: z.string().optional(),
            kind: z.string().min(1).max(60),
            tags: z.array(z.string()).default([]),
            content: z.string().min(3).max(4000),
            source: z.string().optional(),
        }),
        z.object({
            verb: z.literal('recall'),
            scope: z.enum(['global', 'project', 'both']).default('both'),
            projectSlug: z.string().optional(),
            query: z.string().optional(),
            tags: z.array(z.string()).optional(),
            kind: z.string().optional(),
            maxResults: z.number().int().positive().max(50).default(20),
        }),
        z.object({
            verb: z.literal('forget'),
            scope: z.enum(['global', 'project']).default('project'),
            projectSlug: z.string().optional(),
            id: z.string().min(1),
        }),
    ]),
    outputSchema: z.union([
        z.object({ verb: z.literal('remember'), id: z.string(), scope: z.string(), file: z.string() }),
        z.object({ verb: z.literal('recall'), matches: z.array(z.object({
            id: z.string(), ts: z.string(), kind: z.string(), tags: z.array(z.string()),
            content: z.string(), source: z.string().optional(), scope: z.string(),
        })), scannedFiles: z.number() }),
        z.object({ verb: z.literal('forget'), id: z.string(), removed: z.boolean() }),
    ]),
    run: async (_ctx, input) => {
        if (input.verb === 'remember') {
            const dir = scopeDir(input.scope, input.projectSlug);
            fs.mkdirSync(dir, { recursive: true });
            const entry: MemoryEntry = {
                id: `mem_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
                ts: new Date().toISOString(),
                kind: input.kind,
                tags: input.tags,
                content: input.content,
                source: input.source,
            };
            const file = path.join(dir, 'patterns.jsonl');
            fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
            return { verb: 'remember' as const, id: entry.id, scope: input.scope, file };
        }
        if (input.verb === 'recall') {
            const dirs: Array<{ dir: string; scope: string }> = [];
            if (input.scope === 'global' || input.scope === 'both') dirs.push({ dir: scopeDir('global'), scope: 'global' });
            if (input.scope === 'project' || input.scope === 'both') {
                if (input.projectSlug) dirs.push({ dir: scopeDir('project', input.projectSlug), scope: `project:${input.projectSlug}` });
            }
            const matches: Array<{ id: string; ts: string; kind: string; tags: string[]; content: string; source?: string; scope: string }> = [];
            let scannedFiles = 0;
            for (const { dir, scope } of dirs) {
                const file = path.join(dir, 'patterns.jsonl');
                if (!fs.existsSync(file)) continue;
                scannedFiles++;
                const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
                for (const line of lines) {
                    let e: MemoryEntry;
                    try { e = JSON.parse(line) as MemoryEntry; } catch { continue; }
                    if (input.kind && e.kind !== input.kind) continue;
                    if (input.tags && input.tags.length > 0 && !input.tags.every((t) => e.tags.includes(t))) continue;
                    if (input.query) {
                        const q = input.query.toLowerCase();
                        const hay = (e.content + ' ' + e.tags.join(' ') + ' ' + e.kind).toLowerCase();
                        if (!hay.includes(q)) continue;
                    }
                    matches.push({ id: e.id, ts: e.ts, kind: e.kind, tags: e.tags, content: e.content, source: e.source, scope });
                }
            }
            matches.sort((a, b) => b.ts.localeCompare(a.ts));
            return { verb: 'recall' as const, matches: matches.slice(0, input.maxResults), scannedFiles };
        }
        // forget
        const dir = scopeDir(input.scope, input.projectSlug);
        const file = path.join(dir, 'patterns.jsonl');
        if (!fs.existsSync(file)) return { verb: 'forget' as const, id: input.id, removed: false };
        const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
        const kept: string[] = [];
        let removed = false;
        for (const line of lines) {
            try {
                const e = JSON.parse(line) as MemoryEntry;
                if (e.id === input.id) { removed = true; continue; }
                kept.push(line);
            } catch { kept.push(line); }
        }
        fs.writeFileSync(file, kept.join('\n') + (kept.length > 0 ? '\n' : ''), 'utf-8');
        return { verb: 'forget' as const, id: input.id, removed };
    },
});
