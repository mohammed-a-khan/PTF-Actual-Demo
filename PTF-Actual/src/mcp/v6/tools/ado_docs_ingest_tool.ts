/**
 * cs_qa_docs_ingest — parses REQUIREMENT documents, SPEC files, CONFIG, and
 * DATA fixtures into `.cs-qa/source-model/docs.json`, the docs-side complement
 * to the code-side `.cs-qa/source-model/model.json` produced by
 * cs_qa_source_ingest.
 *
 * Handled formats — every parser is a real byte-level implementation, no stubs:
 *   .md    → headings, checkbox items, pipe tables, fenced json/xml/sql blocks
 *   .txt   → line-based Given/When/Then + [REQ-...] + AC: + bullet lines
 *   .docx  → mammoth (lazy) → markdown → dispatch
 *   .pdf   → pdf-parse (lazy) → text → dispatch to txt parser
 *   .xlsx  → SheetJS (lazy) → per-sheet dataTable + requirement-column detection
 *   .csv   → hand-rolled RFC 4180 parser → dataTable
 *   .json  → dataTable | apiFixtures | configEntries (heuristic)
 *   .xml   → Spring beans / MyBatis mappers / log4j / web.xml (xml2js or regex)
 *   .sql   → DDL extractor (CREATE/ALTER + PK/FK + INSERT seeds → dataTables)
 *
 * When `mergeWithSourceModel` is true (default), the docs model is merged with
 * an existing `.cs-qa/source-model/model.json` into `merged.json`, and a
 * requirement→endpoint / requirement→screen cross-reference is computed with
 * token-overlap scoring (kept when score ≥ 0.3).
 *
 * Every extracted item cites `sourceFile` + `sourceLocation`. Files exceeding
 * `maxFileBytes` are skipped with a warning. Files that fail parsing land in
 * `parseErrors[]` — never silently dropped. Optional npm packages that fail to
 * load surface a warning with an install hint; the rest of the run continues.
 *
 * Pure on-prem safe file IO — no network.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { bulkExecute } from './_helpers/bulk_batcher';
import { loadModel } from './ado_source_ingest_tool';

// =============================================================================
// Public model shape.
// =============================================================================

const RequirementStatementSchema = z.object({
    id: z.string(),
    kind: z.enum(['requirement', 'ac', 'note', 'title']),
    text: z.string(),
    sourceFile: z.string(),
    sourceLocation: z.string(),
    tags: z.array(z.string()).default([]),
    linkedRequirements: z.array(z.string()).default([]),
});

const DataTableSchema = z.object({
    id: z.string(),
    tableName: z.string(),
    sourceFile: z.string(),
    sourceLocation: z.string(),
    columns: z.array(z.object({ name: z.string(), type: z.string().nullable().optional() })),
    rows: z.array(z.array(z.any())),
    rowCount: z.number(),
    columnCount: z.number(),
});

const SqlSchemaSchema = z.object({
    tableName: z.string(),
    sourceFile: z.string(),
    lineNumber: z.number(),
    operation: z.enum(['CREATE', 'ALTER', 'DROP']),
    columns: z.array(z.object({
        name: z.string(),
        type: z.string(),
        nullable: z.boolean(),
        isPk: z.boolean(),
        isFk: z.boolean(),
        fkTarget: z.string().nullable(),
        default: z.string().nullable(),
    })),
});

const ConfigEntrySchema = z.object({
    key: z.string(),
    value: z.string(),
    sourceFile: z.string(),
    sourceLocation: z.string(),
    configKind: z.enum(['json', 'xml', 'sql']),
});

const ApiFixtureSchema = z.object({
    name: z.string(),
    sourceFile: z.string(),
    contentType: z.enum(['json', 'xml', 'graphql-response']),
    payloadPreview: z.string(),
});

const DocsModelSchema = z.object({
    ingestedAt: z.string(),
    docsRoot: z.string(),
    filesDiscovered: z.number(),
    filesParsed: z.number(),
    formatsDetected: z.array(z.string()),
    requirementStatements: z.array(RequirementStatementSchema),
    dataTables: z.array(DataTableSchema),
    sqlSchema: z.array(SqlSchemaSchema),
    configEntries: z.array(ConfigEntrySchema),
    apiFixtures: z.array(ApiFixtureSchema),
    warnings: z.array(z.string()),
    parseErrors: z.array(z.object({ filePath: z.string(), error: z.string() })),
});

export type DocsModel = z.infer<typeof DocsModelSchema>;

// =============================================================================
// File walker.
// =============================================================================

const DEFAULT_EXCLUDES = new Set(['node_modules', 'dist', 'build', 'target', 'out', 'bin', 'obj', '.git', '.idea', '.vscode', '.gradle']);
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

type DocKind = 'md' | 'txt' | 'docx' | 'pdf' | 'xlsx' | 'csv' | 'json' | 'xml' | 'sql' | 'other';

interface DiscoveredFile {
    absPath: string;
    ext: string;
    kind: DocKind;
    size: number;
}

function classifyExt(absPath: string): DocKind {
    const lower = absPath.toLowerCase();
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
    if (lower.endsWith('.txt')) return 'txt';
    if (lower.endsWith('.docx')) return 'docx';
    if (lower.endsWith('.pdf')) return 'pdf';
    if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'xlsx';
    if (lower.endsWith('.csv')) return 'csv';
    if (lower.endsWith('.json')) return 'json';
    if (lower.endsWith('.hbm.xml')) return 'other'; // handled by source-ingest
    if (lower.endsWith('.xml')) return 'xml';
    if (lower.endsWith('.sql')) return 'sql';
    return 'other';
}

function walkTree(root: string, excludes: Set<string>): DiscoveredFile[] {
    const out: DiscoveredFile[] = [];
    const queue: string[] = [root];
    while (queue.length > 0) {
        const dir = queue.shift() as string;
        let ents: fs.Dirent[];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { continue; }
        for (const e of ents) {
            if (excludes.has(e.name)) continue;
            if (e.name.startsWith('.') && e.name !== '.env.example') continue;
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) queue.push(abs);
            else if (e.isFile()) {
                let stat: fs.Stats;
                try { stat = fs.statSync(abs); } catch { continue; }
                const kind = classifyExt(abs);
                if (kind === 'other') continue;
                out.push({ absPath: abs, ext: path.extname(e.name), kind, size: stat.size });
            }
        }
    }
    return out;
}

function readTextSafe(abs: string, maxBytes: number): { content: string | null; warning?: string } {
    try {
        const st = fs.statSync(abs);
        if (st.size > maxBytes) return { content: null, warning: `skipped-large-file (${st.size} bytes > ${maxBytes}): ${abs}` };
        return { content: fs.readFileSync(abs, 'utf-8') };
    } catch (e) {
        return { content: null, warning: `read-failed: ${abs}: ${(e as Error).message}` };
    }
}

function readBinarySafe(abs: string, maxBytes: number): { buffer: Buffer | null; warning?: string } {
    try {
        const st = fs.statSync(abs);
        if (st.size > maxBytes) return { buffer: null, warning: `skipped-large-file (${st.size} bytes > ${maxBytes}): ${abs}` };
        return { buffer: fs.readFileSync(abs) };
    } catch (e) {
        return { buffer: null, warning: `read-failed: ${abs}: ${(e as Error).message}` };
    }
}

// =============================================================================
// State + id helpers.
// =============================================================================

interface DocsState {
    requirementStatements: z.infer<typeof RequirementStatementSchema>[];
    dataTables: z.infer<typeof DataTableSchema>[];
    sqlSchema: z.infer<typeof SqlSchemaSchema>[];
    configEntries: z.infer<typeof ConfigEntrySchema>[];
    apiFixtures: z.infer<typeof ApiFixtureSchema>[];
    warnings: string[];
    parseErrors: Array<{ filePath: string; error: string }>;
    formatsDetected: Set<string>;
    counters: {
        req: number; table: number; sql: number; cfg: number; api: number;
    };
}

function newState(): DocsState {
    return {
        requirementStatements: [], dataTables: [], sqlSchema: [], configEntries: [], apiFixtures: [],
        warnings: [], parseErrors: [], formatsDetected: new Set(),
        counters: { req: 0, table: 0, sql: 0, cfg: 0, api: 0 },
    };
}

function nextReqId(state: DocsState, kind: string): string { return `req-${kind}-${++state.counters.req}`; }
function nextTableId(state: DocsState): string { return `table-${++state.counters.table}`; }

function pushWarning(state: DocsState, msg: string): void { state.warnings.push(msg); }
function pushParseError(state: DocsState, file: string, err: Error): void {
    state.parseErrors.push({ filePath: file, error: err.message });
}

// =============================================================================
// Markdown parser — headings, checkboxes, pipe tables, fenced code blocks.
// =============================================================================

interface MdFence {
    lang: string;
    body: string;
    startLine: number;
    endLine: number;
}

function parseMarkdown(state: DocsState, file: DiscoveredFile, content: string): void {
    state.formatsDetected.add('md');
    const lines = content.split(/\r?\n/);
    const headingPath: string[] = ['', '', '', '', '', ''];
    let inFence = false;
    let fenceLang = '';
    let fenceStart = 0;
    let fenceBuffer: string[] = [];
    const fences: MdFence[] = [];

    // Table parsing state (pipe tables — GFM style).
    let tableBuffer: string[] = [];
    let tableStart = 0;

    function flushTable(): void {
        if (tableBuffer.length < 2) { tableBuffer = []; return; }
        // Row 1 = header, row 2 = alignment marker (---), rest = data.
        const header = splitPipeRow(tableBuffer[0]);
        const isAlignmentRow = /^\|?\s*:?-{2,}:?(\s*\|\s*:?-{2,}:?)*\s*\|?\s*$/.test(tableBuffer[1]);
        if (!isAlignmentRow) { tableBuffer = []; return; }
        const rows = tableBuffer.slice(2).map(splitPipeRow);
        const tableName = headingPath.filter(Boolean).slice(-1)[0] || `table-at-line-${tableStart + 1}`;
        const columns = header.map((h) => ({ name: h.trim(), type: null }));
        state.dataTables.push({
            id: nextTableId(state),
            tableName,
            sourceFile: file.absPath,
            sourceLocation: `line ${tableStart + 1} under "${headingPath.filter(Boolean).join(' > ')}"`,
            columns,
            rows,
            rowCount: rows.length,
            columnCount: header.length,
        });
        tableBuffer = [];
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fenceMatch = /^```(\S*)\s*$/.exec(line);
        if (fenceMatch) {
            if (!inFence) {
                inFence = true;
                fenceLang = fenceMatch[1].toLowerCase();
                fenceStart = i;
                fenceBuffer = [];
            } else {
                fences.push({ lang: fenceLang, body: fenceBuffer.join('\n'), startLine: fenceStart + 1, endLine: i + 1 });
                inFence = false;
                fenceLang = '';
                fenceBuffer = [];
            }
            flushTable();
            continue;
        }
        if (inFence) { fenceBuffer.push(line); continue; }

        // Pipe-table detection: two or more '|' in the line.
        if (/\|.*\|/.test(line) && line.trim().length > 0) {
            if (tableBuffer.length === 0) tableStart = i;
            tableBuffer.push(line);
            continue;
        } else if (tableBuffer.length > 0) {
            flushTable();
        }

        // Heading.
        const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (h) {
            const level = h[1].length;
            const title = h[2].trim();
            headingPath[level - 1] = title;
            for (let k = level; k < headingPath.length; k++) headingPath[k] = '';
            const tags = extractInlineTags(title);
            state.requirementStatements.push({
                id: nextReqId(state, 'title'),
                kind: 'title',
                text: title,
                sourceFile: file.absPath,
                sourceLocation: `line ${i + 1}`,
                tags,
                linkedRequirements: extractLinkedIds(title),
            });
            continue;
        }

        // Checkbox item — treat as AC.
        const cb = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line);
        if (cb) {
            const text = cb[2].trim();
            state.requirementStatements.push({
                id: nextReqId(state, 'ac'),
                kind: 'ac',
                text,
                sourceFile: file.absPath,
                sourceLocation: `line ${i + 1} under "${headingPath.filter(Boolean).join(' > ')}"`,
                tags: ['checkbox', cb[1].trim() === '' ? 'unchecked' : 'checked', ...extractInlineTags(text)],
                linkedRequirements: extractLinkedIds(text),
            });
            continue;
        }

        // Recognised prose markers.
        const trimmed = line.trim();
        if (/^\[REQ-[A-Z0-9_-]+\]/i.test(trimmed) || /^AC\s*[:\-]/i.test(trimmed)) {
            state.requirementStatements.push({
                id: nextReqId(state, 'requirement'),
                kind: 'requirement',
                text: trimmed,
                sourceFile: file.absPath,
                sourceLocation: `line ${i + 1}`,
                tags: extractInlineTags(trimmed),
                linkedRequirements: extractLinkedIds(trimmed),
            });
            continue;
        }
    }
    // Trailing table + fence flushes.
    flushTable();
    if (inFence) {
        pushWarning(state, `${file.absPath}: unterminated code fence started at line ${fenceStart + 1}`);
    }

    // Dispatch fenced code blocks.
    for (const f of fences) {
        const nested: DiscoveredFile = {
            absPath: `${file.absPath}#L${f.startLine}-${f.endLine}`,
            ext: '.' + f.lang,
            kind: 'other',
            size: f.body.length,
        };
        if (f.lang === 'json') {
            try { parseJsonBody(state, nested, f.body, `line ${f.startLine}-${f.endLine} of ${path.basename(file.absPath)}`); }
            catch (e) { pushParseError(state, nested.absPath, e as Error); }
        } else if (f.lang === 'xml') {
            parseXmlBody(state, nested, f.body).catch((e) => pushParseError(state, nested.absPath, e as Error));
        } else if (f.lang === 'sql') {
            parseSqlBody(state, nested, f.body);
        }
    }
}

function splitPipeRow(row: string): string[] {
    let s = row.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    const cells: string[] = [];
    let cur = '';
    let escaped = false;
    for (const ch of s) {
        if (escaped) { cur += ch; escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '|') { cells.push(cur.trim()); cur = ''; }
        else cur += ch;
    }
    cells.push(cur.trim());
    return cells;
}

function extractInlineTags(text: string): string[] {
    const tags = new Set<string>();
    const priority = /\b(P[0-3]|Critical|High|Medium|Low)\b/gi;
    let m;
    while ((m = priority.exec(text))) tags.add(m[0].toLowerCase());
    if (/\b(Given|When|Then|And|But)\b/.test(text)) tags.add('gherkin');
    return Array.from(tags);
}

function extractLinkedIds(text: string): string[] {
    const ids = new Set<string>();
    const re = /\b(REQ|AC|US|TC|BUG|STORY)-[A-Z0-9_-]+/gi;
    let m;
    while ((m = re.exec(text))) ids.add(m[0].toUpperCase());
    return Array.from(ids);
}

// =============================================================================
// Plain-text parser — line-based bullet + Gherkin extraction.
// =============================================================================

function parseText(state: DocsState, file: DiscoveredFile, content: string): void {
    state.formatsDetected.add('txt');
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = raw.trim();
        if (!line) continue;

        let kind: 'requirement' | 'ac' | 'note' | null = null;
        if (/^\[REQ-[A-Z0-9_-]+\]/i.test(line)) kind = 'requirement';
        else if (/^AC\s*[:\-]/i.test(line)) kind = 'ac';
        else if (/^(Given|When|Then|And|But)\s+/.test(line)) kind = 'ac';
        else if (/^As\s+(a|an)\s+/i.test(line)) kind = 'requirement';
        else if (/^[-*]\s+/.test(line)) kind = 'note';

        if (kind) {
            state.requirementStatements.push({
                id: nextReqId(state, kind),
                kind,
                text: line.replace(/^[-*]\s+/, ''),
                sourceFile: file.absPath,
                sourceLocation: `line ${i + 1}`,
                tags: extractInlineTags(line),
                linkedRequirements: extractLinkedIds(line),
            });
        } else if (line.length > 20) {
            state.requirementStatements.push({
                id: nextReqId(state, 'note'),
                kind: 'note',
                text: line,
                sourceFile: file.absPath,
                sourceLocation: `line ${i + 1}`,
                tags: extractInlineTags(line),
                linkedRequirements: extractLinkedIds(line),
            });
        }
    }
}

// =============================================================================
// CSV parser — hand-rolled RFC 4180 (quoted, embedded commas, escaped quotes).
// =============================================================================

export function parseCsvBody(content: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < content.length; i++) {
        const ch = content[i];
        if (inQuote) {
            if (ch === '"') {
                if (content[i + 1] === '"') { cur += '"'; i++; }
                else inQuote = false;
            } else cur += ch;
            continue;
        }
        if (ch === '"') { inQuote = true; continue; }
        if (ch === ',') { row.push(cur); cur = ''; continue; }
        if (ch === '\r') continue;
        if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; continue; }
        cur += ch;
    }
    if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
    // Trim a trailing empty row (file ended with newline).
    while (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
    return rows;
}

function parseCsv(state: DocsState, file: DiscoveredFile, content: string): void {
    state.formatsDetected.add('csv');
    const rows = parseCsvBody(content);
    if (rows.length === 0) return;
    const header = rows[0];
    const dataRows = rows.slice(1);
    const tableName = path.basename(file.absPath).replace(/\.[^.]+$/, '');
    state.dataTables.push({
        id: nextTableId(state),
        tableName,
        sourceFile: file.absPath,
        sourceLocation: 'row 1 (header)',
        columns: header.map((h) => ({ name: h.trim(), type: null })),
        rows: dataRows,
        rowCount: dataRows.length,
        columnCount: header.length,
    });
    maybeExtractRequirementsFromTable(state, file, header, dataRows, 'csv row');
}

// =============================================================================
// JSON parser — shape-heuristic: array-of-objects / api fixture / config entries.
// =============================================================================

function parseJsonBody(state: DocsState, file: DiscoveredFile, content: string, locationBase: string): void {
    state.formatsDetected.add('json');
    let parsed: unknown;
    try { parsed = JSON.parse(content); }
    catch (e) { pushParseError(state, file.absPath, e as Error); return; }

    // Skip OpenAPI / Swagger — the code-side tool handles that.
    if (isOpenApi(parsed)) {
        pushWarning(state, `${file.absPath}: skipped OpenAPI/Swagger document — use cs_qa_source_ingest / cs_qa_import_openapi for API specs.`);
        return;
    }

    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
        // Array of objects → data table.
        const keys = new Set<string>();
        for (const row of parsed as Record<string, unknown>[]) for (const k of Object.keys(row)) keys.add(k);
        const columns = Array.from(keys).map((k) => ({ name: k, type: null }));
        const rows = (parsed as Record<string, unknown>[]).map((r) => columns.map((c) => r[c.name] ?? null));
        state.dataTables.push({
            id: nextTableId(state),
            tableName: path.basename(file.absPath).replace(/\.[^.]+$/, ''),
            sourceFile: file.absPath,
            sourceLocation: locationBase,
            columns,
            rows,
            rowCount: rows.length,
            columnCount: columns.length,
        });
        return;
    }

    // API-fixture heuristic — object with data{} or errors[] or graphql-shape.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const looksLikeApi = 'data' in obj || 'errors' in obj || 'response' in obj || 'items' in obj;
        if (looksLikeApi) {
            const isGraphql = 'data' in obj && ('errors' in obj || Object.keys(obj).length <= 3);
            state.apiFixtures.push({
                name: path.basename(file.absPath).replace(/\.[^.]+$/, ''),
                sourceFile: file.absPath,
                contentType: isGraphql ? 'graphql-response' : 'json',
                payloadPreview: JSON.stringify(obj).slice(0, 500),
            });
            return;
        }
        // Otherwise treat every top-level key as a config entry.
        for (const [k, v] of Object.entries(obj)) {
            state.configEntries.push({
                key: k,
                value: typeof v === 'object' ? JSON.stringify(v) : String(v),
                sourceFile: file.absPath,
                sourceLocation: locationBase,
                configKind: 'json',
            });
        }
    }
}

function parseJson(state: DocsState, file: DiscoveredFile, content: string): void {
    parseJsonBody(state, file, content, 'file');
}

function isOpenApi(v: unknown): boolean {
    if (!v || typeof v !== 'object') return false;
    const o = v as Record<string, unknown>;
    if (typeof o.openapi === 'string') return true;
    if (typeof o.swagger === 'string') return true;
    if (o.paths && typeof o.paths === 'object' && o.info && typeof o.info === 'object') return true;
    return false;
}

// =============================================================================
// XML parser — xml2js (lazy) with regex fallback.
// =============================================================================

interface XmlLib {
    parseStringPromise(s: string): Promise<Record<string, unknown>>;
}

function tryLoadXml2js(state: DocsState): XmlLib | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const x = require('xml2js') as { Parser: new (opts: Record<string, unknown>) => { parseStringPromise(s: string): Promise<Record<string, unknown>> } };
        const p = new x.Parser({ explicitArray: false, mergeAttrs: false, attrkey: '$', charkey: '_' });
        return { parseStringPromise: (s) => p.parseStringPromise(s) };
    } catch {
        pushWarning(state, 'xml2js not installed — using regex fallback for XML. Install with: npm i -D xml2js @types/xml2js');
        return null;
    }
}

async function parseXml(state: DocsState, file: DiscoveredFile, content: string): Promise<void> {
    state.formatsDetected.add('xml');
    await parseXmlBody(state, file, content);
}

async function parseXmlBody(state: DocsState, file: DiscoveredFile, content: string): Promise<void> {
    // Try xml2js.
    const lib = tryLoadXml2js(state);
    if (lib) {
        try {
            const parsed = await lib.parseStringPromise(content);
            const root = firstValue(parsed);
            extractXmlEntities(state, file, root);
            return;
        } catch (e) {
            pushParseError(state, file.absPath, e as Error);
            // Fall through to regex.
        }
    }
    extractXmlEntitiesRegex(state, file, content);
}

function firstValue(o: unknown): unknown {
    if (!o || typeof o !== 'object') return o;
    const keys = Object.keys(o as Record<string, unknown>);
    if (keys.length === 0) return o;
    return (o as Record<string, unknown>)[keys[0]];
}

function extractXmlEntities(state: DocsState, file: DiscoveredFile, root: unknown): void {
    if (!root || typeof root !== 'object') return;
    const r = root as Record<string, unknown>;

    // Spring beans.
    const beans = coerceArray(r.bean);
    for (const b of beans) {
        const attrs = (b as Record<string, unknown>).$ as Record<string, string> | undefined;
        if (!attrs) continue;
        state.configEntries.push({
            key: `spring.bean.${attrs.id || attrs.name || 'anonymous'}`,
            value: attrs.class || '',
            sourceFile: file.absPath,
            sourceLocation: `bean id=${attrs.id || attrs.name || '?'}`,
            configKind: 'xml',
        });
    }

    // MyBatis mapper statements.
    for (const kind of ['select', 'insert', 'update', 'delete']) {
        const stmts = coerceArray(r[kind]);
        for (const s of stmts) {
            const attrs = (s as Record<string, unknown>).$ as Record<string, string> | undefined;
            if (!attrs || !attrs.id) continue;
            state.configEntries.push({
                key: `mybatis.${kind}.${attrs.id}`,
                value: [`parameterType=${attrs.parameterType || ''}`, `resultType=${attrs.resultType || ''}`].join('; '),
                sourceFile: file.absPath,
                sourceLocation: `${kind} id=${attrs.id}`,
                configKind: 'xml',
            });
        }
    }

    // log4j loggers.
    const loggers = coerceArray(r.logger).concat(coerceArray(r.Logger));
    for (const l of loggers) {
        const attrs = (l as Record<string, unknown>).$ as Record<string, string> | undefined;
        if (!attrs) continue;
        state.configEntries.push({
            key: `log4j.logger.${attrs.name || attrs.id || 'anonymous'}`,
            value: attrs.level || attrs.additivity || '',
            sourceFile: file.absPath,
            sourceLocation: `logger name=${attrs.name || '?'}`,
            configKind: 'xml',
        });
    }

    // web.xml servlets / filters / listeners.
    for (const kind of ['servlet', 'filter', 'listener']) {
        const items = coerceArray(r[kind]);
        for (const it of items) {
            const el = it as Record<string, unknown>;
            const name = (el[`${kind}-name`] as string) || '';
            const cls = (el[`${kind}-class`] as string) || '';
            state.configEntries.push({
                key: `webxml.${kind}.${name || 'anonymous'}`,
                value: cls,
                sourceFile: file.absPath,
                sourceLocation: `${kind}-name=${name || '?'}`,
                configKind: 'xml',
            });
        }
    }
}

function coerceArray(v: unknown): unknown[] {
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v : [v];
}

function extractXmlEntitiesRegex(state: DocsState, file: DiscoveredFile, content: string): void {
    // Regex fallback — extract Spring beans + MyBatis statements + web.xml
    // servlets. Line numbers computed by scanning the file.
    const lineOf = (idx: number) => content.slice(0, idx).split(/\n/).length;

    const beanRe = /<bean\b([^>]*)\/?>/gi;
    let m;
    while ((m = beanRe.exec(content))) {
        const attrs = parseAttrs(m[1]);
        state.configEntries.push({
            key: `spring.bean.${attrs.id || attrs.name || 'anonymous'}`,
            value: attrs.class || '',
            sourceFile: file.absPath,
            sourceLocation: `line ${lineOf(m.index)}`,
            configKind: 'xml',
        });
    }

    for (const kind of ['select', 'insert', 'update', 'delete']) {
        const re = new RegExp(`<${kind}\\b([^>]*)>`, 'gi');
        let m2;
        while ((m2 = re.exec(content))) {
            const attrs = parseAttrs(m2[1]);
            if (!attrs.id) continue;
            state.configEntries.push({
                key: `mybatis.${kind}.${attrs.id}`,
                value: [`parameterType=${attrs.parameterType || ''}`, `resultType=${attrs.resultType || ''}`].join('; '),
                sourceFile: file.absPath,
                sourceLocation: `line ${lineOf(m2.index)}`,
                configKind: 'xml',
            });
        }
    }

    // web.xml — <servlet><servlet-name>X</servlet-name><servlet-class>Y</servlet-class>
    for (const kind of ['servlet', 'filter']) {
        const re = new RegExp(`<${kind}>[\\s\\S]*?<${kind}-name>([^<]+)</${kind}-name>[\\s\\S]*?<${kind}-class>([^<]+)</${kind}-class>[\\s\\S]*?</${kind}>`, 'gi');
        let m3;
        while ((m3 = re.exec(content))) {
            state.configEntries.push({
                key: `webxml.${kind}.${m3[1].trim()}`,
                value: m3[2].trim(),
                sourceFile: file.absPath,
                sourceLocation: `line ${lineOf(m3.index)}`,
                configKind: 'xml',
            });
        }
    }
}

function parseAttrs(attrString: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = /([A-Za-z_:][\w.:-]*)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(attrString))) out[m[1]] = m[2];
    return out;
}

// =============================================================================
// SQL parser — DDL extractor + optional INSERT seeds.
// =============================================================================

function parseSql(state: DocsState, file: DiscoveredFile, content: string): void {
    state.formatsDetected.add('sql');
    parseSqlBody(state, file, content);
}

function parseSqlBody(state: DocsState, file: DiscoveredFile, content: string): void {
    // Strip line comments and block comments to simplify.
    const stripped = content
        .replace(/--[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');

    const stmtLineOf = (idx: number) => content.slice(0, idx).split(/\n/).length;

    // CREATE TABLE.
    const createRe = /\bCREATE\s+(?:GLOBAL\s+TEMPORARY\s+|TEMPORARY\s+|TEMP\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w.]+)["`]?\s*\(([\s\S]*?)\)\s*(?:;|$)/gi;
    let m;
    while ((m = createRe.exec(stripped))) {
        const tableName = m[1].split('.').pop() as string;
        const body = m[2];
        const columns = parseColumnBody(body);
        state.sqlSchema.push({
            tableName,
            sourceFile: file.absPath,
            lineNumber: stmtLineOf(m.index),
            operation: 'CREATE',
            columns,
        });
    }

    // ALTER TABLE ... ADD COLUMN.
    const alterAddRe = /\bALTER\s+TABLE\s+["`]?([\w.]+)["`]?\s+ADD\s+(?:COLUMN\s+)?["`]?(\w+)["`]?\s+([\w()]+(?:\s+NOT\s+NULL|\s+NULL)?)/gi;
    let m2;
    while ((m2 = alterAddRe.exec(stripped))) {
        const tableName = m2[1].split('.').pop() as string;
        state.sqlSchema.push({
            tableName,
            sourceFile: file.absPath,
            lineNumber: stmtLineOf(m2.index),
            operation: 'ALTER',
            columns: [{
                name: m2[2],
                type: m2[3].replace(/\s+(NOT\s+NULL|NULL)$/i, '').trim(),
                nullable: !/NOT\s+NULL/i.test(m2[3]),
                isPk: false, isFk: false, fkTarget: null, default: null,
            }],
        });
    }

    // DROP TABLE.
    const dropRe = /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?([\w.]+)["`]?/gi;
    let m3;
    while ((m3 = dropRe.exec(stripped))) {
        const tableName = m3[1].split('.').pop() as string;
        state.sqlSchema.push({
            tableName,
            sourceFile: file.absPath,
            lineNumber: stmtLineOf(m3.index),
            operation: 'DROP',
            columns: [],
        });
    }

    // INSERT INTO seeds → dataTable.
    const insertRe = /\bINSERT\s+INTO\s+["`]?([\w.]+)["`]?\s*\(([^)]+)\)\s*VALUES\s*([\s\S]*?);/gi;
    let m4;
    while ((m4 = insertRe.exec(stripped))) {
        const tableName = m4[1].split('.').pop() as string;
        const cols = m4[2].split(',').map((c) => c.trim().replace(/["`]/g, ''));
        const valuesStr = m4[3];
        const rows = parseInsertValues(valuesStr);
        if (rows.length > 0) {
            state.dataTables.push({
                id: nextTableId(state),
                tableName: `${tableName} (seed)`,
                sourceFile: file.absPath,
                sourceLocation: `line ${stmtLineOf(m4.index)} (INSERT)`,
                columns: cols.map((c) => ({ name: c, type: null })),
                rows,
                rowCount: rows.length,
                columnCount: cols.length,
            });
        }
    }
}

function parseColumnBody(body: string): z.infer<typeof SqlSchemaSchema>['columns'] {
    // Split by top-level commas (skip inside parens for VARCHAR(255) etc).
    const parts: string[] = [];
    let cur = '';
    let depth = 0;
    for (const ch of body) {
        if (ch === '(') { depth++; cur += ch; continue; }
        if (ch === ')') { depth--; cur += ch; continue; }
        if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim().length > 0) parts.push(cur);

    const cols: z.infer<typeof SqlSchemaSchema>['columns'] = [];
    // Track PK from PRIMARY KEY(col1, col2) constraint.
    const pkCols = new Set<string>();
    // Track FK from FOREIGN KEY(col) REFERENCES tab(col) constraint.
    const fkMap = new Map<string, string>();

    for (const part of parts) {
        const p = part.trim();
        if (!p) continue;

        // Table-level constraints.
        const pkM = /^PRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(p);
        if (pkM) { for (const c of pkM[1].split(',')) pkCols.add(c.trim().replace(/["`]/g, '')); continue; }
        const fkM = /^FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+["`]?([\w.]+)["`]?(?:\s*\(([^)]+)\))?/i.exec(p);
        if (fkM) {
            const col = fkM[1].split(',')[0].trim().replace(/["`]/g, '');
            fkMap.set(col, fkM[2]);
            continue;
        }
        if (/^(UNIQUE|CHECK|CONSTRAINT|INDEX|KEY)\b/i.test(p)) continue;

        // Regular column: NAME TYPE [MODIFIERS...]
        const colM = /^["`]?(\w+)["`]?\s+([\w()]+)([\s\S]*)$/.exec(p);
        if (!colM) continue;
        const rest = colM[3];
        const inlinePk = /\bPRIMARY\s+KEY\b/i.test(rest);
        const inlineNotNull = /\bNOT\s+NULL\b/i.test(rest);
        const inlineFkM = /REFERENCES\s+["`]?([\w.]+)["`]?/i.exec(rest);
        const defaultM = /\bDEFAULT\s+((?:'[^']*'|[^\s,]+))/i.exec(rest);
        cols.push({
            name: colM[1],
            type: colM[2],
            nullable: !inlineNotNull && !inlinePk,
            isPk: inlinePk,
            isFk: !!inlineFkM,
            fkTarget: inlineFkM ? inlineFkM[1] : null,
            default: defaultM ? defaultM[1] : null,
        });
    }
    // Apply table-level PK + FK.
    for (const c of cols) {
        if (pkCols.has(c.name)) { c.isPk = true; c.nullable = false; }
        if (fkMap.has(c.name)) { c.isFk = true; c.fkTarget = fkMap.get(c.name) as string; }
    }
    return cols;
}

function parseInsertValues(valuesStr: string): unknown[][] {
    const rows: unknown[][] = [];
    let i = 0;
    while (i < valuesStr.length) {
        while (i < valuesStr.length && /[\s,]/.test(valuesStr[i])) i++;
        if (valuesStr[i] !== '(') { i++; continue; }
        i++;
        const cur: unknown[] = [];
        let field = '';
        let inStr = false;
        while (i < valuesStr.length) {
            const ch = valuesStr[i];
            if (inStr) {
                if (ch === "'") {
                    if (valuesStr[i + 1] === "'") { field += "'"; i += 2; continue; }
                    inStr = false; i++; continue;
                }
                field += ch; i++; continue;
            }
            if (ch === "'") { inStr = true; i++; continue; }
            if (ch === ',') { cur.push(coerceSqlLiteral(field)); field = ''; i++; continue; }
            if (ch === ')') { cur.push(coerceSqlLiteral(field)); i++; break; }
            field += ch; i++;
        }
        rows.push(cur);
    }
    return rows;
}

function coerceSqlLiteral(s: string): unknown {
    const t = s.trim();
    if (t === '' || /^NULL$/i.test(t)) return null;
    if (/^-?\d+$/.test(t)) return Number(t);
    if (/^-?\d+\.\d+$/.test(t)) return Number(t);
    return t;
}

// =============================================================================
// Optional-format loaders — DOCX (mammoth), PDF (pdf-parse), XLSX (SheetJS).
// =============================================================================

interface MammothLib {
    convertToMarkdown(opts: { buffer: Buffer }): Promise<{ value: string }>;
}

interface PdfParseFn {
    (buf: Buffer): Promise<{ text: string }>;
}

async function parseDocx(state: DocsState, file: DiscoveredFile, buffer: Buffer): Promise<void> {
    state.formatsDetected.add('docx');
    let mammoth: MammothLib;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        mammoth = require('mammoth') as MammothLib;
    } catch {
        pushWarning(state, `${file.absPath}: mammoth not installed — .docx cannot be parsed. Install with: npm i -D mammoth`);
        return;
    }
    try {
        const res = await mammoth.convertToMarkdown({ buffer });
        const md = res.value || '';
        // Reuse the markdown parser but keep original filename.
        parseMarkdown(state, file, md);
    } catch (e) {
        pushParseError(state, file.absPath, e as Error);
    }
}

async function parsePdf(state: DocsState, file: DiscoveredFile, buffer: Buffer): Promise<void> {
    state.formatsDetected.add('pdf');
    let pdfParse: PdfParseFn;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        pdfParse = require('pdf-parse') as PdfParseFn;
    } catch {
        pushWarning(state, `${file.absPath}: pdf-parse not installed — .pdf cannot be parsed. Install with: npm i -D pdf-parse`);
        return;
    }
    try {
        const res = await pdfParse(buffer);
        parseText(state, file, res.text || '');
    } catch (e) {
        pushParseError(state, file.absPath, e as Error);
    }
}

interface XlsxLib {
    read: (buf: Buffer, opts: Record<string, unknown>) => { SheetNames: string[]; Sheets: Record<string, unknown> };
    utils: { sheet_to_json: (sheet: unknown, opts: Record<string, unknown>) => unknown[][] };
}

function parseXlsx(state: DocsState, file: DiscoveredFile, buffer: Buffer): void {
    state.formatsDetected.add('xlsx');
    let xlsx: XlsxLib | null = null;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        xlsx = require('xlsx') as XlsxLib;
    } catch {
        pushWarning(state, `${file.absPath}: xlsx not installed — spreadsheets cannot be parsed. Install with: npm i -D xlsx`);
        return;
    }
    try {
        const wb = xlsx.read(buffer, { type: 'buffer' });
        for (const sheetName of wb.SheetNames) {
            const sheet = wb.Sheets[sheetName];
            const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false }) as unknown[][];
            if (rows.length === 0) continue;
            const header = rows[0].map((h) => String(h ?? '').trim());
            const dataRows = rows.slice(1);
            state.dataTables.push({
                id: nextTableId(state),
                tableName: sheetName,
                sourceFile: file.absPath,
                sourceLocation: `sheet '${sheetName}' row 1 (header)`,
                columns: header.map((h) => ({ name: h, type: null })),
                rows: dataRows,
                rowCount: dataRows.length,
                columnCount: header.length,
            });
            maybeExtractRequirementsFromTable(state, file, header, dataRows.map((r) => r.map((c) => c === undefined ? null : c)), `sheet '${sheetName}' row`);
        }
    } catch (e) {
        pushParseError(state, file.absPath, e as Error);
    }
}

// =============================================================================
// Requirement-column heuristic — used for CSV and XLSX.
// =============================================================================

const REQ_HEADER_RE = /^(requirement|acceptance\s*criteri[oa]n?|ac|description|priority|test\s*case|scenario|story)$/i;

function maybeExtractRequirementsFromTable(
    state: DocsState,
    file: DiscoveredFile,
    header: string[],
    rows: unknown[][],
    locBase: string,
): void {
    const reqColIdx = header.findIndex((h) => REQ_HEADER_RE.test((h || '').trim()));
    if (reqColIdx < 0) return;
    const priorityIdx = header.findIndex((h) => /priority/i.test(h));
    const idIdx = header.findIndex((h) => /^(id|req[-_ ]?id|ac[-_ ]?id)$/i.test(h));
    for (let i = 0; i < rows.length; i++) {
        const text = String(rows[i][reqColIdx] ?? '').trim();
        if (!text) continue;
        const tags: string[] = [];
        if (priorityIdx >= 0) {
            const p = String(rows[i][priorityIdx] ?? '').trim();
            if (p) tags.push(`priority:${p.toLowerCase()}`);
        }
        const linked: string[] = [];
        if (idIdx >= 0) {
            const id = String(rows[i][idIdx] ?? '').trim();
            if (id) linked.push(id);
        }
        for (const t of extractInlineTags(text)) tags.push(t);
        for (const l of extractLinkedIds(text)) linked.push(l);
        const kind: 'requirement' | 'ac' = /^ac/i.test(header[reqColIdx].trim()) ? 'ac' : 'requirement';
        state.requirementStatements.push({
            id: nextReqId(state, kind),
            kind,
            text,
            sourceFile: file.absPath,
            sourceLocation: `${locBase} ${i + 2}`,
            tags: Array.from(new Set(tags)),
            linkedRequirements: Array.from(new Set(linked)),
        });
    }
}

// =============================================================================
// Merger.
// =============================================================================

interface MergedModel {
    mergedAt: string;
    sourceModel: unknown | null;
    docsModel: DocsModel;
    crossReferences: Array<{
        requirementId: string;
        matchedEndpoint?: string;
        matchedScreen?: string;
        score: number;
    }>;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'is', 'are', 'be', 'to', 'of', 'in', 'on', 'for', 'with', 'as', 'by', 'at', 'from', 'that', 'this', 'it', 'its', 'user', 'system', 'can', 'should', 'must', 'shall', 'will']);

function tokenize(s: string): Set<string> {
    const out = new Set<string>();
    // Split camelCase / PascalCase first (viewEmployee → view Employee).
    const decamel = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    for (const raw of decamel.toLowerCase().split(/[^a-z0-9]+/)) {
        if (!raw || raw.length < 3) continue;
        if (STOPWORDS.has(raw)) continue;
        // Light plural stripping so "employees" matches "employee".
        const stem = raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw;
        out.add(stem);
    }
    return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
}

function buildMerged(docsModel: DocsModel, sourceModel: unknown | null): MergedModel {
    const refs: MergedModel['crossReferences'] = [];
    if (sourceModel && typeof sourceModel === 'object') {
        const sm = sourceModel as { endpoints?: Array<{ id: string; verb: string; path: string; methodName: string }>; screens?: Array<{ id: string; screenName: string }> };
        const endpoints = sm.endpoints || [];
        const screens = sm.screens || [];
        for (const req of docsModel.requirementStatements) {
            if (req.kind === 'title') continue;
            const reqToks = tokenize(req.text);
            if (reqToks.size === 0) continue;
            let bestEndpoint: { id: string; score: number } | null = null;
            for (const ep of endpoints) {
                const epToks = tokenize(`${ep.path} ${ep.methodName} ${ep.verb}`);
                const score = jaccard(reqToks, epToks);
                if (score >= 0.3 && (!bestEndpoint || score > bestEndpoint.score)) {
                    bestEndpoint = { id: ep.id, score };
                }
            }
            let bestScreen: { id: string; score: number } | null = null;
            for (const scr of screens) {
                const scrToks = tokenize(scr.screenName);
                const score = jaccard(reqToks, scrToks);
                if (score >= 0.3 && (!bestScreen || score > bestScreen.score)) {
                    bestScreen = { id: scr.id, score };
                }
            }
            if (bestEndpoint || bestScreen) {
                refs.push({
                    requirementId: req.id,
                    matchedEndpoint: bestEndpoint ? bestEndpoint.id : undefined,
                    matchedScreen: bestScreen ? bestScreen.id : undefined,
                    score: Math.max(bestEndpoint?.score || 0, bestScreen?.score || 0),
                });
            }
        }
    }
    return {
        mergedAt: new Date().toISOString(),
        sourceModel: sourceModel || null,
        docsModel,
        crossReferences: refs,
    };
}

// =============================================================================
// Registration.
// =============================================================================

registerPrimitive({
    name: 'cs_qa_docs_ingest',
    description: 'Walk a docs tree (or explicit file list) and extract requirement statements, data tables, SQL DDL, config entries, and API fixtures to .cs-qa/source-model/docs.json. Handles .md, .txt, .docx, .pdf, .xlsx, .csv, .json, .xml, .sql — real byte-level parsers, no stubs. Every extracted item cites sourceFile + sourceLocation. When mergeWithSourceModel=true (default), merges with the code-side model.json into merged.json with token-overlap cross-references between requirements and endpoints/screens.',
    inputSchema: z.object({
        docsRoot: z.string().min(1).optional(),
        docsPaths: z.array(z.string().min(1)).optional(),
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
        outputPath: z.string().optional(),
        mergeWithSourceModel: z.boolean().default(true),
        maxFileBytes: z.number().int().positive().max(200 * 1024 * 1024).default(DEFAULT_MAX_BYTES),
        dryRun: z.boolean().default(false),
    }).refine((v) => (v.docsRoot ? 1 : 0) + (v.docsPaths && v.docsPaths.length > 0 ? 1 : 0) === 1, {
        message: 'Provide exactly one of docsRoot or docsPaths (XOR).',
    }),
    outputSchema: z.object({
        ok: z.boolean(),
        outputPath: z.string().nullable(),
        mergedPath: z.string().nullable(),
        filesDiscovered: z.number(),
        filesParsed: z.number(),
        formatsDetected: z.array(z.string()),
        counts: z.object({
            requirementStatements: z.number(),
            dataTables: z.number(),
            sqlSchema: z.number(),
            configEntries: z.number(),
            apiFixtures: z.number(),
            crossReferences: z.number(),
        }),
        warnings: z.array(z.string()),
        parseErrors: z.array(z.object({ filePath: z.string(), error: z.string() })),
        note: z.string().optional(),
        modelPreview: DocsModelSchema.optional(),
    }),
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_docs_ingest', { workspaceRoot: ctx.workspaceRoot });
        const excludes = new Set([...DEFAULT_EXCLUDES, ...(input.exclude || [])]);
        const state = newState();

        // Resolve input set.
        const discovered: DiscoveredFile[] = [];
        let docsRootResolved = '';
        if (input.docsRoot) {
            docsRootResolved = path.isAbsolute(input.docsRoot) ? input.docsRoot : path.join(ctx.workspaceRoot, input.docsRoot);
            if (!fs.existsSync(docsRootResolved)) {
                return {
                    ok: false, outputPath: null, mergedPath: null,
                    filesDiscovered: 0, filesParsed: 0, formatsDetected: [],
                    counts: { requirementStatements: 0, dataTables: 0, sqlSchema: 0, configEntries: 0, apiFixtures: 0, crossReferences: 0 },
                    warnings: [], parseErrors: [],
                    note: `docsRoot does not exist: ${docsRootResolved}`,
                };
            }
            for (const f of walkTree(docsRootResolved, excludes)) discovered.push(f);
        } else if (input.docsPaths) {
            docsRootResolved = ctx.workspaceRoot;
            for (const p of input.docsPaths) {
                const abs = path.isAbsolute(p) ? p : path.join(ctx.workspaceRoot, p);
                if (!fs.existsSync(abs)) { pushWarning(state, `docsPaths entry does not exist: ${abs}`); continue; }
                let stat: fs.Stats;
                try { stat = fs.statSync(abs); } catch (e) { pushWarning(state, `stat-failed: ${abs}: ${(e as Error).message}`); continue; }
                const kind = classifyExt(abs);
                if (kind === 'other') { pushWarning(state, `unsupported extension (ignored): ${abs}`); continue; }
                discovered.push({ absPath: abs, ext: path.extname(abs), kind, size: stat.size });
            }
        }

        // Include glob narrowing (basename substring + wildcard support).
        const includeFilters = input.include || [];
        const filtered = includeFilters.length === 0 ? discovered : discovered.filter((f) => {
            const rel = path.relative(docsRootResolved, f.absPath);
            return includeFilters.some((pat) => {
                const glob = pat.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
                return new RegExp('^' + glob + '$').test(rel) || rel.includes(pat) || path.basename(f.absPath).includes(pat);
            });
        });

        log.info('docs-ingest: discovered', { count: filtered.length, root: docsRootResolved });

        // Text-based files → concurrent batch.
        const textFiles = filtered.filter((f) => ['md', 'txt', 'csv', 'json', 'sql'].includes(f.kind));
        await bulkExecute(textFiles, {
            chunkSize: 20,
            concurrency: 8,
            workFn: async (chunk) => {
                for (const f of chunk) {
                    const rd = readTextSafe(f.absPath, input.maxFileBytes);
                    if (rd.warning) pushWarning(state, rd.warning);
                    if (rd.content === null) continue;
                    try {
                        if (f.kind === 'md') parseMarkdown(state, f, rd.content);
                        else if (f.kind === 'txt') parseText(state, f, rd.content);
                        else if (f.kind === 'csv') parseCsv(state, f, rd.content);
                        else if (f.kind === 'json') parseJson(state, f, rd.content);
                        else if (f.kind === 'sql') parseSql(state, f, rd.content);
                    } catch (e) { pushParseError(state, f.absPath, e as Error); }
                }
                return chunk.map(() => null);
            },
        });

        // XML — async (xml2js lazy load).
        const xmlFiles = filtered.filter((f) => f.kind === 'xml');
        await bulkExecute(xmlFiles, {
            chunkSize: 10,
            concurrency: 8,
            workFn: async (chunk) => {
                for (const f of chunk) {
                    const rd = readTextSafe(f.absPath, input.maxFileBytes);
                    if (rd.warning) pushWarning(state, rd.warning);
                    if (rd.content === null) continue;
                    try { await parseXml(state, f, rd.content); }
                    catch (e) { pushParseError(state, f.absPath, e as Error); }
                }
                return chunk.map(() => null);
            },
        });

        // Binary files — .docx, .pdf, .xlsx (lazy loaders inside each parser).
        const binFiles = filtered.filter((f) => ['docx', 'pdf', 'xlsx'].includes(f.kind));
        await bulkExecute(binFiles, {
            chunkSize: 5,
            concurrency: 4,
            workFn: async (chunk) => {
                for (const f of chunk) {
                    const rd = readBinarySafe(f.absPath, input.maxFileBytes);
                    if (rd.warning) pushWarning(state, rd.warning);
                    if (rd.buffer === null) continue;
                    try {
                        if (f.kind === 'docx') await parseDocx(state, f, rd.buffer);
                        else if (f.kind === 'pdf') await parsePdf(state, f, rd.buffer);
                        else if (f.kind === 'xlsx') parseXlsx(state, f, rd.buffer);
                    } catch (e) { pushParseError(state, f.absPath, e as Error); }
                }
                return chunk.map(() => null);
            },
        });

        // Assemble model + persist.
        const model: DocsModel = {
            ingestedAt: new Date().toISOString(),
            docsRoot: docsRootResolved,
            filesDiscovered: discovered.length,
            filesParsed: filtered.length,
            formatsDetected: Array.from(state.formatsDetected).sort(),
            requirementStatements: state.requirementStatements,
            dataTables: state.dataTables,
            sqlSchema: state.sqlSchema,
            configEntries: state.configEntries,
            apiFixtures: state.apiFixtures,
            warnings: state.warnings,
            parseErrors: state.parseErrors,
        };

        const outAbs = input.outputPath
            ? (path.isAbsolute(input.outputPath) ? input.outputPath : path.join(ctx.workspaceRoot, input.outputPath))
            : path.join(ctx.workspaceRoot, '.cs-qa', 'source-model', 'docs.json');

        let mergedPath: string | null = null;
        let crossReferences = 0;

        if (!input.dryRun) {
            try {
                fs.mkdirSync(path.dirname(outAbs), { recursive: true });
                fs.writeFileSync(outAbs, JSON.stringify(model, null, 2), 'utf-8');
            } catch (e) {
                pushWarning(state, 'write-failed: ' + (e as Error).message);
            }

            if (input.mergeWithSourceModel) {
                const smPath = path.join(ctx.workspaceRoot, '.cs-qa', 'source-model', 'model.json');
                let sm: unknown = null;
                if (fs.existsSync(smPath)) {
                    sm = loadModel(smPath);
                    if (sm === null) pushWarning(state, `existing model.json failed schema validation: ${smPath}`);
                }
                const merged = buildMerged(model, sm);
                crossReferences = merged.crossReferences.length;
                mergedPath = path.join(path.dirname(outAbs), 'merged.json');
                try {
                    fs.writeFileSync(mergedPath, JSON.stringify(merged, null, 2), 'utf-8');
                } catch (e) {
                    pushWarning(state, 'merge-write-failed: ' + (e as Error).message);
                    mergedPath = null;
                }
            }
        } else if (input.mergeWithSourceModel) {
            const smPath = path.join(ctx.workspaceRoot, '.cs-qa', 'source-model', 'model.json');
            const sm = fs.existsSync(smPath) ? loadModel(smPath) : null;
            crossReferences = buildMerged(model, sm).crossReferences.length;
        }

        return {
            ok: true,
            outputPath: input.dryRun ? null : outAbs,
            mergedPath,
            filesDiscovered: discovered.length,
            filesParsed: filtered.length,
            formatsDetected: Array.from(state.formatsDetected).sort(),
            counts: {
                requirementStatements: state.requirementStatements.length,
                dataTables: state.dataTables.length,
                sqlSchema: state.sqlSchema.length,
                configEntries: state.configEntries.length,
                apiFixtures: state.apiFixtures.length,
                crossReferences,
            },
            warnings: state.warnings,
            parseErrors: state.parseErrors,
            note: `Formats: [${Array.from(state.formatsDetected).sort().join(', ') || 'none'}]. ${state.requirementStatements.length} requirements, ${state.dataTables.length} data tables, ${state.sqlSchema.length} SQL DDL, ${state.configEntries.length} config entries, ${state.apiFixtures.length} API fixtures extracted from ${filtered.length} files.`,
            modelPreview: input.dryRun ? model : undefined,
        };
    },
});

export { DocsModelSchema, buildMerged };
