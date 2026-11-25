/**
 * A query and its result → a framework feature that checks them with the framework's own database
 * steps only (no step code): connect to the alias, run the query (from its .sql file, inline, or with
 * parameters), then the chosen checks: row count, columns, the rows (a data table), first-row values.
 * Expected values follow how the steps compare (see cells.expectedText); values a step cannot state
 * exactly are left out and reported.
 */
import { Cell, Column, expectedText } from './cells';
import { countParams, stripSql } from './safety';
import { quote } from '../api/feature';

export interface DbFeatureInput {
    name: string;
    alias: string;
    /** A saved query file (repository path) or the SQL itself. */
    file?: string;
    sql?: string;
    params?: string[];
    result: { columns: Column[]; rows: Cell[][]; total: number; truncated: boolean };
    checks: { rowCount: 'exact' | 'atLeast' | 'none'; columns: boolean; rows: number; firstRow: boolean };
    tags?: string[];
}
export interface DbFeatureResult { text: string; warnings: string[] }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'query';
/** Interpolated by the steps before comparing ({config:X}, ${X}, <random>…): such text is not literal. */
const INTERPOLATED = /\{[^{}\s]*\}|\$\{|<(random|timestamp|uuid|date|env|generate)\b/i;

/** A value usable in a step table cell (trimmed, interpolated, | separates cells). */
function tableValue(c: Cell): string | null {
    const t = expectedText(c);
    if (t === null || t !== t.trim() || /[|\\]/.test(t) || INTERPOLATED.test(t)) return null;
    return t;
}

export function dbFeature(i: DbFeatureInput): DbFeatureResult {
    const warnings: string[] = [];
    const q = (s: string, where: string) => {
        const x = quote(s);
        if (x === null) warnings.push(`${where}: the text ${/[\r\n]/.test(s) ? 'has a line break' : 'contains both " and \''}, which a step cannot hold.`);
        return x;
    };
    const lines: string[] = [];
    lines.push(['@database', `@${slug(i.name)}`, ...(i.tags ?? [])].join(' '));
    lines.push(`Feature: ${i.name.replace(/\s+/g, ' ').trim()}`, '');
    lines.push(`  Scenario: ${i.name.replace(/\s+/g, ' ').trim()}`);
    const alias = q(i.alias, 'Connection');
    lines.push(`    Given user connects to ${alias ?? '"?"'} database`);

    // The query.
    const params = i.params ?? [];
    const sql = (i.sql ?? '').trim();
    if (params.length) {
        // No step runs a file with parameters: the query goes inline (one line).
        if (/--/.test(stripSql(sql).replace(/'[^']*'/g, '')) || /'[^']*\n[^']*'/.test(sql)) warnings.push('The query has -- comments or a text over several lines: with parameters it must be written on one line. Remove the comments, or save it without parameters.');
        const one = sql.replace(/\s*\n\s*/g, ' ');
        const sq = q(one, 'Query');
        lines.push(`    When user executes parameterized query ${sq ?? '"?"'} with parameters:`);
        for (const p of params) lines.push(`      | ${p.replace(/\|/g, '\\|')} |`);
        if (countParams(sql) !== params.length) warnings.push(`The query has ${countParams(sql)} ? placeholder(s) and ${params.length} parameter value(s).`);
    } else if (i.file) {
        lines.push(`    When user executes query from file ${q(i.file, 'File') ?? '"?"'}`);
    } else {
        if (/\n/.test(sql)) warnings.push('A multi-line query is best saved as a .sql file (Save), so the test runs the file.');
        const one = sql.replace(/\s*\n\s*/g, ' ');
        lines.push(`    When user executes query ${q(one, 'Query') ?? '"?"'}`);
    }
    if (INTERPOLATED.test(sql)) warnings.push('The query contains {…} or <…> placeholders: the framework fills them in from the configuration before running it (as the Studio did).');

    const { columns, rows, total, truncated } = i.result;
    // Row count.
    if (i.checks.rowCount !== 'none') {
        if (truncated && i.checks.rowCount === 'exact') warnings.push(`Only the first ${rows.length} of ${total} rows were fetched; the row count check uses the full count (${total}).`);
        if (total === 0) lines.push('    Then the query result should be empty');
        else lines.push(`    Then the query result should have ${i.checks.rowCount === 'atLeast' ? 'at least ' : ''}${total} rows`);
    }
    const kw = () => (lines[lines.length - 1].trim().startsWith('When') ? 'Then' : 'And');
    // Columns.
    if (i.checks.columns && columns.length) {
        const bad = columns.filter((c) => /[|\\]/.test(c.name) || c.name !== c.name.trim());
        if (bad.length) warnings.push(`Column names with | or spaces at the ends cannot go in a table: ${bad.map((c) => c.name).join(', ')}.`);
        else {
            lines.push(`    ${kw()} the result should have columns:`);
            for (const c of columns) lines.push(`      | ${c.name} |`);
        }
    }
    // Rows as a table: the step also checks that the result has exactly that many rows.
    if (i.checks.rows > 0 && rows.length) {
        if (total > i.checks.rows || truncated) warnings.push(`The result has ${total} rows: a table of expected rows needs all of them (the step compares the row count). Choose "first row values" instead, or narrow the query to at most ${i.checks.rows} rows.`);
        else {
            const usable = columns.map((c, ci) => ({ c, ci })).filter(({ c, ci }) => !/[|\\]/.test(c.name) && rows.every((r) => tableValue(r[ci]) !== null));
            const skipped = columns.filter((_, ci) => !usable.some((u) => u.ci === ci));
            if (skipped.length) warnings.push(`Not checked in the table (values a step cannot state exactly: binary, JSON, long or multi-line text, {…}): ${skipped.map((c) => c.name).join(', ')}.`);
            if (usable.length) {
                lines.push(`    ${kw()} the result should match:`);
                const cells = [usable.map((u) => u.c.name), ...rows.map((r) => usable.map((u) => tableValue(r[u.ci])!))];
                const width = usable.map((_, k) => Math.max(...cells.map((row) => row[k].length)));
                for (const row of cells) lines.push(`      | ${row.map((v, k) => v.padEnd(width[k])).join(' | ')} |`);
            }
        }
    }
    // First-row values, one step each.
    if (i.checks.firstRow && rows.length) {
        const skipped: string[] = [];
        columns.forEach((c, ci) => {
            const t = expectedText(rows[0][ci]);
            if (t === null || INTERPOLATED.test(t)) { skipped.push(c.name); return; }
            const col = quote(c.name), val = quote(t);
            if (col === null || val === null) { skipped.push(c.name); return; }
            lines.push(t === 'null' ? `    ${kw()} the value in row 1 column ${col} should be null` : `    ${kw()} the value in row 1 column ${col} should be ${val}`);
        });
        if (skipped.length) warnings.push(`First-row values not checked (not expressible exactly in a step): ${skipped.join(', ')}.`);
    }
    lines.push('    And user disconnects from database', '');
    return { text: lines.join('\n'), warnings };
}

export const featureSlug = slug;
