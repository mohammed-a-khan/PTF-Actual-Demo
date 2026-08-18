import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

registerPrimitive({
    name: 'cs_qa_search',
    description: 'Grep-style content search across a directory tree. Use to find framework patterns, existing test-def signatures, page-object conventions, matching selectors, or any known-string reference. Returns matching lines with 2 lines of context, capped.',
    inputSchema: z.object({
        query: z.string().min(1),
        root: z.string().default('.'),
        globs: z.array(z.string()).default(['**/*.ts', '**/*.tsx', '**/*.md', '**/*.feature', '**/*.json']),
        maxHits: z.number().int().positive().max(200).default(50),
        regex: z.boolean().default(false),
        caseInsensitive: z.boolean().default(false),
    }),
    outputSchema: z.object({
        query: z.string(),
        rootScanned: z.string(),
        filesScanned: z.number(),
        hits: z.array(z.object({
            file: z.string(),
            line: z.number(),
            snippet: z.string(),
        })),
        truncated: z.boolean(),
    }),
    run: async (ctx, input) => {
        const rootAbs = path.resolve(ctx.workspaceRoot, input.root);
        const re = input.regex
            ? new RegExp(input.query, input.caseInsensitive ? 'i' : '')
            : new RegExp(escapeRegex(input.query), input.caseInsensitive ? 'i' : '');
        const hits: Array<{ file: string; line: number; snippet: string }> = [];
        let filesScanned = 0;
        let truncated = false;
        const walk = (dir: string): void => {
            if (hits.length >= input.maxHits) { truncated = true; return; }
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const ent of entries) {
                if (ent.name === 'node_modules' || ent.name.startsWith('.git')) continue;
                const p = path.join(dir, ent.name);
                if (ent.isDirectory()) { walk(p); continue; }
                const rel = path.relative(ctx.workspaceRoot, p).replace(/\\/g, '/');
                if (!input.globs.some((g) => matchesGlob(rel, g))) continue;
                filesScanned++;
                let content: string;
                try { content = fs.readFileSync(p, 'utf-8'); } catch { continue; }
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (!re.test(lines[i])) continue;
                    if (hits.length >= input.maxHits) { truncated = true; return; }
                    const start = Math.max(0, i - 1);
                    const end = Math.min(lines.length, i + 2);
                    hits.push({ file: rel, line: i + 1, snippet: lines.slice(start, end).join('\n') });
                }
            }
        };
        walk(rootAbs);
        return { query: input.query, rootScanned: input.root, filesScanned, hits, truncated };
    },
});

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesGlob(name: string, glob: string): boolean {
    const re = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*') + '$');
    return re.test(name);
}
