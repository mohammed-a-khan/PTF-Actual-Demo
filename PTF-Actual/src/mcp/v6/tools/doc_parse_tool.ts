import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

function toWorkspacePath(workspaceRoot: string, rel: string): string {
    const abs = path.resolve(workspaceRoot, rel);
    const wsAbs = path.resolve(workspaceRoot);
    if (!abs.startsWith(wsAbs + path.sep) && abs !== wsAbs) {
        throw new Error(`path escape: '${rel}' resolves outside workspace root`);
    }
    return abs;
}

function tryRequire(name: string): unknown | null {
    try { return require(name); } catch { return null; }
}

registerPrimitive({
    name: 'cs_qa_doc_parse',
    description: 'Parse requirement documents into plain text + structured sections. Verbs: parse (auto-detect kind from extension), extract-sections (regex-based section headers). Supports .txt, .md, .csv, .json, .pdf, .docx, .xlsx. PDF/DOCX/XLSX parsing requires respective node modules — falls back gracefully with a note if unavailable.',
    inputSchema: z.discriminatedUnion('verb', [
        z.object({ verb: z.literal('parse'), path: z.string().min(1), maxBytes: z.number().int().positive().max(2_000_000).default(500_000) }),
        z.object({ verb: z.literal('extract-sections'), path: z.string().min(1), sectionRegex: z.string().default('^(#{1,3}|[A-Z][A-Z0-9 _-]{2,}:)\\s*(.+)$') }),
    ]),
    outputSchema: z.object({
        path: z.string(),
        kind: z.string(),
        sizeBytes: z.number(),
        text: z.string(),
        sections: z.array(z.object({ heading: z.string(), startLine: z.number(), body: z.string() })).optional(),
        truncated: z.boolean(),
        note: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const abs = toWorkspacePath(ctx.workspaceRoot, input.path);
        const ext = path.extname(abs).toLowerCase();
        const stat = fs.statSync(abs);
        const kind = ext.replace('.', '') || 'unknown';
        const maxBytes = input.verb === 'parse' ? input.maxBytes : 500_000;

        let text = '';
        let note: string | undefined;
        let truncated = false;

        if (['.txt', '.md', '.csv', '.json'].includes(ext)) {
            const buf = fs.readFileSync(abs);
            truncated = buf.length > maxBytes;
            text = truncated ? buf.slice(0, maxBytes).toString('utf-8') : buf.toString('utf-8');
        } else if (ext === '.pdf') {
            const pdfParse = tryRequire('pdf-parse') as ((buf: Buffer) => Promise<{ text: string }>) | null;
            if (!pdfParse) {
                note = 'pdf-parse module not installed. Run: npm i -D pdf-parse';
            } else {
                const buf = fs.readFileSync(abs);
                const result = await pdfParse(buf);
                text = result.text ?? '';
                truncated = text.length > maxBytes;
                if (truncated) text = text.slice(0, maxBytes);
            }
        } else if (ext === '.docx') {
            const mammoth = tryRequire('mammoth') as { extractRawText: (opts: { path: string }) => Promise<{ value: string }> } | null;
            if (!mammoth) {
                note = 'mammoth module not installed. Run: npm i -D mammoth';
            } else {
                const result = await mammoth.extractRawText({ path: abs });
                text = result.value ?? '';
                truncated = text.length > maxBytes;
                if (truncated) text = text.slice(0, maxBytes);
            }
        } else if (ext === '.xlsx' || ext === '.xls') {
            const xlsx = tryRequire('xlsx') as { readFile: (p: string) => unknown; utils: { sheet_to_csv: (s: unknown) => string } } | null;
            if (!xlsx) {
                note = 'xlsx module not installed. Run: npm i -D xlsx';
            } else {
                const wb = xlsx.readFile(abs) as { SheetNames: string[]; Sheets: Record<string, unknown> };
                text = wb.SheetNames.map((name) => `## Sheet: ${name}\n${xlsx.utils.sheet_to_csv(wb.Sheets[name])}`).join('\n\n');
                truncated = text.length > maxBytes;
                if (truncated) text = text.slice(0, maxBytes);
            }
        } else {
            note = `Unsupported extension: ${ext}. Supported: .txt, .md, .csv, .json, .pdf, .docx, .xlsx.`;
        }

        let sections: Array<{ heading: string; startLine: number; body: string }> | undefined;
        if (input.verb === 'extract-sections' && text.length > 0) {
            const re = new RegExp(input.sectionRegex, 'gm');
            const lines = text.split('\n');
            const heads: Array<{ heading: string; startLine: number }> = [];
            for (let i = 0; i < lines.length; i++) {
                const m = new RegExp(input.sectionRegex).exec(lines[i]);
                if (m) heads.push({ heading: m[2] ?? m[0], startLine: i + 1 });
            }
            sections = heads.map((h, idx) => {
                const end = idx + 1 < heads.length ? heads[idx + 1].startLine - 1 : lines.length;
                return { heading: h.heading, startLine: h.startLine, body: lines.slice(h.startLine, end).join('\n') };
            });
            re.lastIndex = 0;
        }

        return {
            path: input.path, kind, sizeBytes: stat.size, text,
            sections, truncated, note,
        };
    },
});
