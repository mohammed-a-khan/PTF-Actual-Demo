import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

function ragRoot(): string {
    return process.env.CS_QA_V6_HOME
        ? path.join(process.env.CS_QA_V6_HOME, 'rag')
        : path.join(os.homedir(), '.cs-qa', 'v6', 'rag');
}

interface IndexEntry {
    id: string;
    corpus: string;
    file: string;
    startLine: number;
    endLine: number;
    tags: string[];
    text: string;
}

function loadCorpus(corpus: string): IndexEntry[] {
    const file = path.join(ragRoot(), `${corpus}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as IndexEntry);
}

function saveCorpus(corpus: string, entries: IndexEntry[]): void {
    const file = path.join(ragRoot(), `${corpus}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

function chunk(text: string, startLine: number): Array<{ text: string; startLine: number; endLine: number }> {
    const lines = text.split('\n');
    const out: Array<{ text: string; startLine: number; endLine: number }> = [];
    const CHUNK_LINES = 40;
    const OVERLAP = 6;
    for (let i = 0; i < lines.length; i += CHUNK_LINES - OVERLAP) {
        const end = Math.min(lines.length, i + CHUNK_LINES);
        const t = lines.slice(i, end).join('\n');
        if (t.trim().length < 30) continue;
        out.push({ text: t, startLine: startLine + i, endLine: startLine + end - 1 });
        if (end === lines.length) break;
    }
    return out;
}

function inferTags(filePath: string, content: string): string[] {
    const tags: string[] = [];
    if (/\.feature$/.test(filePath)) tags.push('feature');
    if (/\.steps\.ts$/.test(filePath)) tags.push('step-def');
    if (/[Pp]age\.ts$/.test(filePath)) tags.push('page-object');
    if (/\.env$/.test(filePath)) tags.push('config');
    if (/\.md$/.test(filePath)) tags.push('doc');
    if (/@CSBDDStepDef/.test(content)) tags.push('bdd-step');
    if (/@CSPage/.test(content)) tags.push('page-decorator');
    if (/@CSGetElement/.test(content)) tags.push('element-decorator');
    if (/CSBasePage/.test(content)) tags.push('page-inheritance');
    if (/CSDBUtils/.test(content)) tags.push('db');
    if (/executeQuery|executeNamedQuery|executeSingleRow/.test(content)) tags.push('db-query');
    return tags;
}

function walkFiles(root: string, exts: Set<string>): string[] {
    const out: string[] = [];
    const stack = [root];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
            if (ent.name === 'node_modules' || ent.name.startsWith('.git') || ent.name === 'dist' || ent.name === 'reports') continue;
            const p = path.join(dir, ent.name);
            if (ent.isDirectory()) stack.push(p);
            else if (exts.has(path.extname(ent.name))) out.push(p);
        }
    }
    return out;
}

registerPrimitive({
    name: 'cs_qa_rag',
    description: 'RAG index over consumer projects + framework docs. Verbs: build (index a corpus by pointing at root paths), search (FTS-style search across a corpus with optional tag filter), list (list built corpora). Corpora are named — build one per consumer/module (e.g. one per test project, one for framework-docs). search returns matching chunks with file path, line range, tags, and excerpt.',
    inputSchema: z.discriminatedUnion('verb', [
        z.object({
            verb: z.literal('build'),
            corpus: z.string().min(1).max(40),
            roots: z.array(z.string()).min(1),
            extensions: z.array(z.string()).default(['.ts', '.tsx', '.md', '.feature', '.json', '.env']),
        }),
        z.object({
            verb: z.literal('search'),
            corpus: z.string().min(1),
            query: z.string().min(1),
            tags: z.array(z.string()).optional(),
            maxResults: z.number().int().positive().max(50).default(15),
        }),
        z.object({ verb: z.literal('list') }),
    ]),
    outputSchema: z.union([
        z.object({ verb: z.literal('build'), corpus: z.string(), filesIndexed: z.number(), chunksIndexed: z.number(), sizeKb: z.number() }),
        z.object({
            verb: z.literal('search'),
            corpus: z.string(),
            matches: z.array(z.object({
                file: z.string(), startLine: z.number(), endLine: z.number(),
                tags: z.array(z.string()), snippet: z.string(), score: z.number(),
            })),
        }),
        z.object({ verb: z.literal('list'), corpora: z.array(z.object({ name: z.string(), entries: z.number(), sizeKb: z.number() })) }),
    ]),
    run: async (_ctx, input) => {
        fs.mkdirSync(ragRoot(), { recursive: true });
        if (input.verb === 'list') {
            const files = fs.existsSync(ragRoot()) ? fs.readdirSync(ragRoot()).filter((f) => f.endsWith('.jsonl')) : [];
            const corpora = files.map((f) => {
                const p = path.join(ragRoot(), f);
                const stat = fs.statSync(p);
                const entries = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).length;
                return { name: f.replace(/\.jsonl$/, ''), entries, sizeKb: Math.round(stat.size / 1024) };
            });
            return { verb: 'list' as const, corpora };
        }
        if (input.verb === 'build') {
            const exts = new Set(input.extensions);
            const allFiles: string[] = [];
            for (const root of input.roots) {
                if (!fs.existsSync(root)) continue;
                allFiles.push(...walkFiles(root, exts));
            }
            const entries: IndexEntry[] = [];
            for (const abs of allFiles) {
                let content: string;
                try { content = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
                if (content.length > 500_000) continue;
                const tags = inferTags(abs, content);
                for (const c of chunk(content, 1)) {
                    entries.push({
                        id: `${entries.length}`,
                        corpus: input.corpus,
                        file: abs,
                        startLine: c.startLine,
                        endLine: c.endLine,
                        tags,
                        text: c.text,
                    });
                }
            }
            saveCorpus(input.corpus, entries);
            const stat = fs.statSync(path.join(ragRoot(), `${input.corpus}.jsonl`));
            return { verb: 'build' as const, corpus: input.corpus, filesIndexed: allFiles.length, chunksIndexed: entries.length, sizeKb: Math.round(stat.size / 1024) };
        }
        const entries = loadCorpus(input.corpus);
        const qTokens = input.query.toLowerCase().split(/[\s\W_]+/).filter((t) => t.length >= 2);
        const scored: Array<{ e: IndexEntry; score: number }> = [];
        for (const e of entries) {
            if (input.tags && input.tags.length > 0 && !input.tags.every((t) => e.tags.includes(t))) continue;
            const hay = e.text.toLowerCase();
            let score = 0;
            for (const t of qTokens) {
                const count = (hay.match(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
                if (count > 0) score += count;
            }
            if (score > 0) scored.push({ e, score });
        }
        scored.sort((a, b) => b.score - a.score);
        return {
            verb: 'search' as const,
            corpus: input.corpus,
            matches: scored.slice(0, input.maxResults).map(({ e, score }) => ({
                file: e.file, startLine: e.startLine, endLine: e.endLine,
                tags: e.tags, snippet: e.text.length > 800 ? e.text.slice(0, 800) + '…' : e.text,
                score,
            })),
        };
    },
});
