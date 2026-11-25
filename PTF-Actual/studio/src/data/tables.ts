/**
 * Test data files as tables (columns and rows of text), read and written the way the framework reads
 * them: JSON (rows at a JSONPath such as $.data[*]), CSV (the repository's csv-parse, as the framework's
 * CSCsvUtility), Excel (the repository's SheetJS, as CSExcelUtility; other sheets of a workbook are
 * kept), XML (read only). Values are read raw: ENCRYPTED: values and <random>-style placeholders stay as
 * they are (the framework resolves them in a run), so writing the rows back changes nothing else.
 */
import * as fs from 'fs';
import * as path from 'path';
import { xlsx as writeXlsx } from '../core/xlsx';

export type TableFormat = 'json' | 'csv' | 'excel' | 'xml';
export interface Table { columns: string[]; rows: Array<Record<string, string>>; sheets?: string[] }

export const formatOf = (file: string): TableFormat | null =>
    /\.json$/i.test(file) ? 'json' : /\.csv$/i.test(file) ? 'csv' : /\.xlsx?$/i.test(file) ? 'excel' : /\.xml$/i.test(file) ? 'xml' : null;

/** A package installed in the repository (the framework's dependencies), or null. */
export function repoModule<T = any>(repoRoot: string, name: string): T | null { // eslint-disable-line @typescript-eslint/no-explicit-any
    for (let dir = path.resolve(repoRoot); ; dir = path.dirname(dir)) {
        const p = path.join(dir, 'node_modules', name);
        if (fs.existsSync(path.join(p, 'package.json'))) { try { return require(p) as T; } catch { return null; } }
        if (path.dirname(dir) === dir) return null;
    }
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const columnsOf = (rows: Array<Record<string, unknown>>) => { const c: string[] = []; for (const r of rows) for (const k of Object.keys(r)) if (!c.includes(k)) c.push(k); return c; };

/** Simple JSONPaths the Studio can also write: $.a.b[*] (rows at a property path); $[*] or $ (the root array). */
export function jsonRowsPath(p: string | undefined): string[] | null {
    const s = (p ?? '$.data[*]').trim();
    if (s === '$' || s === '$[*]') return [];
    const m = /^\$((?:\.[A-Za-z_$][\w$-]*)+)\[\*\]$/.exec(s);
    return m ? m[1].slice(1).split('.') : null;
}

/** CSV text (RFC 4180): a field with the delimiter, a quote or a line break is quoted. */
export function toCsv(columns: string[], rows: Array<Record<string, string>>, delimiter = ','): string {
    const f = (v: string) => (v.includes(delimiter) || /["\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    return [columns.map(f).join(delimiter), ...rows.map((r) => columns.map((c) => f(r[c] ?? '')).join(delimiter))].join('\n') + '\n';
}

/** Parse CSV text (RFC 4180; the first row names the columns). */
export function parseCsv(src: string, delimiter = ','): Table {
    const recs: string[][] = [];
    let rec: string[] = [], field = '', q = false, i = 0;
    const s = src.replace(/^﻿/, '');
    for (; i < s.length; i++) {
        const ch = s[i];
        if (q) {
            if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch;
        } else if (ch === '"' && field === '') q = true;
        else if (s.startsWith(delimiter, i)) { rec.push(field); field = ''; i += delimiter.length - 1; }
        else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; rec.push(field); field = ''; if (rec.some((x) => x !== '')) recs.push(rec); rec = []; }
        else field += ch;
    }
    if (field !== '' || rec.length) { rec.push(field); if (rec.some((x) => x !== '')) recs.push(rec); }
    const columns = recs.shift() ?? [];
    return { columns, rows: recs.map((r) => Object.fromEntries(columns.map((c, k) => [c, r[k] ?? '']))) };
}

/** Read a data file of the repository as a table (modules: where xlsx / csv-parse are installed, default the repository). */
export function readTable(repoRoot: string, file: string, o: { sheet?: string; path?: string; delimiter?: string; modules?: string } = {}): Table {
    const abs = path.join(repoRoot, file);
    const fmt = formatOf(file);
    if (!fmt) throw new Error(`${file}: test data files are .json, .csv, .xlsx, .xls or .xml.`);
    if (fmt === 'excel') {
        const X = repoModule(o.modules ?? repoRoot, 'xlsx');
        if (!X) throw new Error('Excel files are read with the framework\'s xlsx package: run npm install in the repository.');
        const wb = X.read(fs.readFileSync(abs), { type: 'buffer' });
        const name = o.sheet || wb.SheetNames[0];
        const ws = wb.Sheets[name];
        if (!ws) throw new Error(`${file} has no sheet "${name}" (sheets: ${wb.SheetNames.join(', ')}).`);
        const aoa: unknown[][] = X.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
        const columns = (aoa.shift() ?? []).map(text);
        return { columns, rows: aoa.map((r) => Object.fromEntries(columns.map((c, k) => [c, text(r[k])]))), sheets: wb.SheetNames };
    }
    const src = fs.readFileSync(abs, 'utf8');
    if (fmt === 'csv') {
        const P = repoModule<{ parse: (s: string, o: object) => Array<Record<string, unknown>> }>(o.modules ?? repoRoot, 'csv-parse/sync');
        if (P) {
            const rows = P.parse(src, { columns: true, skip_empty_lines: true, delimiter: o.delimiter || ',', bom: true, relax_column_count: true });
            const header = parseCsv(src.split(/\r?\n/)[0] + '\n', o.delimiter || ',').columns;
            return { columns: header.length ? header : columnsOf(rows), rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, text(v)]))) };
        }
        return parseCsv(src, o.delimiter || ',');
    }
    if (fmt === 'json') {
        const j = JSON.parse(src) as unknown;
        const at = jsonRowsPath(o.path);
        if (!at) throw new Error(`${file}: the JSONPath ${o.path} is not one the Studio can write (use $.name[*]).`);
        let v: unknown = j;
        for (const k of at) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
        if (v === undefined) return { columns: [], rows: [] };
        if (!Array.isArray(v)) throw new Error(`${file}: ${o.path ?? '$.data[*]'} is not a list of rows.`);
        const rows = v.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r));
        return { columns: columnsOf(rows), rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, text(x)]))) };
    }
    // XML: rows are the repeated child elements of the document element; columns their child elements.
    const body = src.replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
    const rows: Array<Record<string, string>> = [];
    for (const m of body.matchAll(/<(\w[\w.-]*)(?:\s[^>]*)?>((?:(?!<\1[\s>])[\s\S])*?)<\/\1>/g)) {
        const cells = [...m[2].matchAll(/<(\w[\w.-]*)(?:\s[^>]*)?>([^<]*)<\/\1>/g)];
        if (cells.length && cells.length === (m[2].match(/<\w/g) ?? []).length) rows.push(Object.fromEntries(cells.map((c) => [c[1], c[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')])));
    }
    return { columns: columnsOf(rows), rows };
}

/** The JSON file with the rows at their path (the rest of the document kept). */
export function writeJson(old: string | null, rowsPath: string | undefined, columns: string[], rows: Array<Record<string, string>>): string {
    const at = jsonRowsPath(rowsPath) ?? ['data'];
    const out = rows.map((r) => Object.fromEntries(columns.filter((c) => c in r).map((c) => [c, r[c]])));
    if (!at.length) return `${JSON.stringify(out, null, 2)}\n`;
    let doc: Record<string, unknown> = {};
    if (old !== null) { try { const j = JSON.parse(old); if (j && typeof j === 'object' && !Array.isArray(j)) doc = j; } catch { /* replaced */ } }
    let cur = doc;
    for (const k of at.slice(0, -1)) { if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {}; cur = cur[k] as Record<string, unknown>; }
    cur[at[at.length - 1]] = out;
    return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * The workbook bytes for a sheet given as CSV text: the existing workbook with that sheet replaced (its
 * other sheets kept) through the repository's SheetJS; a new workbook without it.
 */
export function workbookBytes(repoRoot: string, file: string, sheet: string, csv: string, modules = repoRoot): Buffer {
    const t = parseCsv(csv);
    const aoa = [t.columns, ...t.rows.map((r) => t.columns.map((c) => r[c] ?? ''))];
    const X = repoModule(modules, 'xlsx');
    if (!X) return writeXlsx([{ name: sheet, columns: t.columns, rows: aoa.slice(1) }]);
    const abs = path.join(repoRoot, file);
    const wb = fs.existsSync(abs) ? X.read(fs.readFileSync(abs), { type: 'buffer' }) : X.utils.book_new();
    const ws = X.utils.aoa_to_sheet(aoa);
    if (wb.Sheets[sheet]) wb.Sheets[sheet] = ws; else X.utils.book_append_sheet(wb, ws, sheet);
    return X.write(wb, { type: 'buffer', bookType: /\.xls$/i.test(file) ? 'biff8' : 'xlsx' }) as Buffer;
}
