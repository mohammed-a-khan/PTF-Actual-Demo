/**
 * PDF checks: open any PDF of the repository, see what the framework reads from it (fields, tables, text, form
 * fields), compare it with a source (test data file, database query or procedure, API request, another PDF, values
 * typed in) — whole document or one record per row — and save the check as a framework test.
 *
 * The comparison is the framework's own (report-validation/compare): the repository's installed framework when it
 * has it, else the framework the Studio was shipped with, so the result is what the test steps will report.
 */
import { UserError } from '../core/errors';
import * as fs from 'fs';
import * as path from 'path';
import { frameworkPackage } from '../framework/package';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type CompareModule = any;

/** Where the comparison module is found: the repository's framework, the Studio's own package, or a folder given in CS_STUDIO_FRAMEWORK_DIR. */
export function compareModuleDir(repoRoot: string): { dir: string; from: 'project' | 'studio' } | null {
    const rel = path.join('dist', 'report-validation', 'compare', 'index.js');
    const fw = frameworkPackage(repoRoot)?.dir;
    if (fw && fs.existsSync(path.join(fw, rel))) return { dir: fw, from: 'project' };
    for (const d of [process.env['CS_STUDIO_FRAMEWORK_DIR'], path.resolve(__dirname, '..', '..', '..', '..'), path.resolve(__dirname, '..', '..', '..')]) {
        if (d && fs.existsSync(path.join(d, rel))) return { dir: d, from: 'studio' };
    }
    return null;
}

const cache = new Map<string, CompareModule>();
export function compareModule(repoRoot: string): CompareModule {
    const found = compareModuleDir(repoRoot);
    if (!found) throw new UserError('PDF checks need the framework\'s PDF comparison (framework 1.55.0 or later). Update @mdakhan.mak/cs-playwright-test-framework in this repository (npm install).');
    const file = path.join(found.dir, 'dist', 'report-validation', 'compare', 'index.js');
    if (!cache.has(file)) {
        // The CS PDF engine reads every PDF without pdfjs, unless the project chose an engine.
        if (!process.env['REPORT_PDF_ENGINE']) process.env['REPORT_PDF_ENGINE'] = 'native';
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        cache.set(file, require(file));
    }
    return cache.get(file);
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg']);
/** PDFs in the repository (reports and downloads included), newest first. */
export function listPdfs(repoRoot: string, max = 1000): Array<{ path: string; size: number; modified: string }> {
    const out: Array<{ path: string; size: number; mtime: number }> = [];
    const walk = (dir: string, depth: number) => {
        if (depth > 12 || out.length >= max * 4) return;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1); continue; }
            if (!/\.pdf$/i.test(e.name)) continue;
            try { const st = fs.statSync(path.join(dir, e.name)); out.push({ path: path.relative(repoRoot, path.join(dir, e.name)).split(path.sep).join('/'), size: st.size, mtime: st.mtimeMs }); } catch { /* gone */ }
        }
    };
    walk(repoRoot, 0);
    return out.sort((a, b) => b.mtime - a.mtime).slice(0, max).map((x) => ({ path: x.path, size: x.size, modified: new Date(x.mtime).toISOString() }));
}

/** A PDF path inside the repository (no escaping it). */
export function pdfPathIn(repoRoot: string, rel: string): string {
    const abs = path.resolve(repoRoot, rel);
    const root = path.resolve(repoRoot);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('The PDF must be inside the repository.');
    if (!/\.pdf$/i.test(abs)) throw new Error('Not a PDF file.');
    if (!fs.existsSync(abs)) throw new Error(`Not found: ${rel}`);
    return abs;
}

export interface InspectResult {
    pages: number;
    fields: Array<{ label: string; value: string; page: number }>;
    tables: Array<{ name: string; columns: string[]; rows: string[][]; page?: number }>;
    formFields: Array<{ name: string; label: string | null; type: string; value: string }>;
    lines: Array<{ page: number; text: string }>;
    linesTotal: number;
}

/** Label: value pairs printed on the page ("Invoice No: 123", or a label cell followed by its value cell). */
export function detectFields(lines: Array<{ page: number; cells: string[] }>): InspectResult['fields'] {
    const out: InspectResult['fields'] = [];
    const seen = new Set<string>();
    const add = (label: string, value: string, page: number) => {
        label = label.trim(); value = value.trim();
        if (!label || !value || label.length > 40 || /^\d/.test(label) || seen.has(label.toLowerCase())) return;
        seen.add(label.toLowerCase());
        out.push({ label, value, page });
    };
    for (const l of lines) {
        l.cells.forEach((c, i) => {
            // Several pairs in one cell: "Invoice No: 123 Date: 2026-01-02".
            // A later label in the same cell is one word, or a word and a short or lower-case one ("Date:", "Invoice No:", "Due date:").
            const NEXT = String.raw`\s+(?:\p{L}[\p{L}\p{N}.#-]*(?:\s+(?:\p{Ll}[\p{L}]*|\p{L}{1,3}\.?))?)[:：]\s`;
            const pairs = [...c.matchAll(new RegExp(String.raw`([\p{L}][\p{L}\p{N} ().%#/&'-]{0,39}?)\s*[:：]\s*(.+?)(?=${NEXT}|$)`, 'gu'))];
            if (pairs.length) { for (const m of pairs) add(m[1], m[2], l.page); return; }
            const lab = /^([\p{L}][^:：]{0,39})[:：]$/u.exec(c);
            if (lab && l.cells[i + 1]) add(lab[1], l.cells[i + 1], l.page);
        });
    }
    return out.slice(0, 300);
}

export async function inspectPdf(mod: CompareModule, abs: string, password?: string): Promise<InspectResult> {
    const c = await mod.CSPdfContent.load(abs, password ? { password } : {});
    return {
        pages: c.pageCount,
        fields: detectFields(c.lines),
        tables: c.tables.slice(0, 50).map((t: InspectResult['tables'][number]) => ({ ...t, rows: t.rows.slice(0, 500) })),
        formFields: c.formFields,
        lines: c.lines.slice(0, 2000).map((l: { page: number; text: string }) => ({ page: l.page, text: l.text })),
        linesTotal: c.lines.length,
    };
}

// ---- Gherkin for a check (the framework's CSPdfCompareSteps).

export type CheckSource =
    | { kind: 'file'; file: string; sheet?: string }
    | { kind: 'query'; connection: string; sql: string }
    | { kind: 'pdf'; file: string }
    | { kind: 'values'; rows: string[][] }
    | { kind: 'api'; response: string; at?: string };

export interface CheckOptions {
    key?: string; tolerance?: number; caseSensitive?: boolean; dayFirst?: boolean; keyColumns?: string[]; extraRows?: boolean; rowOrder?: boolean;
    ignore?: string[]; pages?: string;
}

const q = (s: string) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const cell = (s: string) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** The options as a "PDF comparison options:" table (empty when there are none). */
export function optionLines(o: CheckOptions): string[] {
    const rows: Array<[string, string]> = [];
    if (o.keyColumns?.length) rows.push(['key columns', o.keyColumns.join(', ')]);
    if (o.tolerance) rows.push(['tolerance', String(o.tolerance)]);
    if (o.caseSensitive) rows.push(['case sensitive', 'true']);
    if (o.dayFirst) rows.push(['day first', 'true']);
    if (o.extraRows) rows.push(['extra rows', 'fail']);
    if (o.rowOrder) rows.push(['row order', 'true']);
    for (const i of o.ignore ?? []) if (i.trim()) rows.push(['ignore', i.trim()]);
    if (o.pages?.trim()) rows.push(['pages', o.pages.trim()]);
    if (!rows.length) return [];
    const w = Math.max(...rows.map((r) => r[0].length)), wv = Math.max(...rows.map((r) => cell(r[1]).length));
    return ['Given PDF comparison options:', ...rows.map(([k, v]) => `  | ${k.padEnd(w)} | ${cell(v).padEnd(wv)} |`)];
}

/** The step(s) that run this check in a test (the PDF path as given, project-relative). */
export function checkSteps(pdf: string, s: CheckSource, o: CheckOptions = {}): string[] {
    const P = q(pdf);
    const key = o.key?.trim();
    const lines = optionLines(o);
    const then = (t: string) => lines.push(`${lines.length ? 'And' : 'Then'} ${t}`);
    if (s.kind === 'file') {
        const sheet = s.sheet ? ` sheet ${q(s.sheet)}` : '';
        then(key ? `the PDF ${P} matches each record of the data file ${q(s.file)}${sheet} keyed by ${q(key)}` : `the PDF ${P} matches the data file ${q(s.file)}${sheet}`);
    } else if (s.kind === 'query') {
        const sql = s.sql.replace(/\s+/g, ' ').trim();
        then(key ? `the PDF ${P} matches each row of the query ${q(sql)} on connection ${q(s.connection)} keyed by ${q(key)}` : `the PDF ${P} matches the query ${q(sql)} on connection ${q(s.connection)}`);
    } else if (s.kind === 'api') {
        then(key ? `the PDF ${P} matches each record of the API response ${q(s.response)} at path ${q(s.at || '$')} keyed by ${q(key)}`
            : s.at ? `the PDF ${P} matches the API response ${q(s.response)} at path ${q(s.at)}` : `the PDF ${P} matches the API response ${q(s.response)}`);
    } else if (s.kind === 'pdf') {
        then(`the PDF ${P} matches the PDF ${q(s.file)}`);
    } else {
        const rows = s.rows.filter((r) => r.some((c) => String(c ?? '').trim()));
        if (!rows.length) throw new Error('Add at least one expected value.');
        const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => cell(r[i] ?? '').length)));
        then(`the PDF ${P} shows:`);
        for (const r of rows) lines.push(`  | ${r.map((c, i) => cell(c ?? '').padEnd(widths[i])).join(' | ')} |`);
    }
    return lines;
}

export function checkFeature(name: string, pdf: string, s: CheckSource, o: CheckOptions = {}, tags: string[] = []): string {
    const steps = checkSteps(pdf, s, o);
    return [
        ...(tags.length ? [tags.map((t) => (t.startsWith('@') ? t : `@${t}`)).join(' ')] : ['@pdf-check']),
        `Feature: ${name}`,
        '',
        `  Scenario: ${name}`,
        ...steps.map((l) => `    ${l}`),
        '',
    ].join('\n');
}

/** The feature file's name: letters of any language kept (a name like 订单 is not reduced to "pdf-check"). */
export const pdfFeatureSlug = (s: string) => s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 80).replace(/-$/, '') || 'pdf-check';
