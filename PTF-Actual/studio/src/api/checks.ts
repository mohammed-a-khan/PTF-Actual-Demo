/**
 * The API workspace's evaluation of rule, schema and database checks and of saved values, with the
 * same meaning as the project code the Studio writes for a test (codegen/helper.ts: ApiResponseChecks),
 * so a check that passes on Send passes in the test run. A test runs both on the same cases.
 */
import { schemaErrors } from './schema';
import type { ApiCheck, ApiExtract, DbItemsRule, Expected, Operator } from './model';
import { JsonPath } from './jsonPath';
import { expectedText, valueRef } from './feature';
import type { ApiResponse, CheckResult, Values } from './send';
import { fill } from './send';

export type Rows = Array<Record<string, unknown>>;
/** Runs a query (a DB_QUERY_<name> of the project, or SQL) on a connection of the project's environment. */
/** sql: the SQL to use when the project has no DB_QUERY_<query> yet (a check not saved yet). */
export type QueryRows = (connection: string, query: string, params: unknown[], sql?: string) => Promise<Rows>;

type Compare = 'auto' | 'text' | 'number' | 'date' | 'datetime';
interface Opts { compare?: Compare; tolerance?: number; ignoreCase?: boolean }

const isDate = (v: unknown): v is Date => v instanceof Date;
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function num(v: unknown): number | null {
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return Number(v);
    if (v === null || v === undefined || typeof v === 'boolean' || isDate(v)) return null;
    const s = String(v).trim();
    return s !== '' && !isNaN(Number(s)) ? Number(s) : null;
}
function day(v: unknown): string | null {
    if (isDate(v)) return isNaN(v.getTime()) ? null : ymd(v);
    const s = String(v ?? '').trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const t = Date.parse(s);
    return isNaN(t) ? null : ymd(new Date(t));
}
function moment(v: unknown): number | null {
    if (isDate(v)) return isNaN(v.getTime()) ? null : v.getTime();
    if (typeof v !== 'string' || !/\d{4}-\d{2}-\d{2}/.test(v)) return null;
    const t = Date.parse(v.trim().replace(' ', 'T'));
    return isNaN(t) ? null : t;
}
function json(s: string): unknown { try { return JSON.parse(s); } catch { return s; } }
export function show(v: unknown): string {
    if (v === undefined) return '(missing)';
    if (isDate(v)) return v.toISOString();
    return JSON.stringify(v);
}

/** Whether two values are the same (the helper's same()). */
export function same(actual: unknown, expected: unknown, o: Opts = {}): boolean {
    const mode = o.compare ?? 'auto';
    if (actual === undefined) return false;
    if (mode === 'number') { const a = num(actual), b = num(expected); return a !== null && b !== null && Math.abs(a - b) <= (o.tolerance ?? 0.0001) + 1e-12; }
    if (mode === 'date') { const a = day(actual), b = day(expected); return a !== null && a === b; }
    if (mode === 'datetime') { const a = moment(actual), b = moment(expected); return a !== null && a === b; }
    if (mode === 'auto') {
        if (isDate(expected) || isDate(actual)) {
            const dateOnly = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
            return dateOnly(actual) || dateOnly(expected) ? same(actual, expected, { compare: 'date' }) : same(actual, expected, { compare: 'datetime' });
        }
        if (actual === null || expected === null) return actual === expected || String(actual) === String(expected);
        if (typeof actual === 'boolean' || typeof expected === 'boolean') return String(actual) === String(expected);
        const a = num(actual), b = num(expected);
        if (a !== null && b !== null) return Math.abs(a - b) <= (o.tolerance ?? 0) + 1e-12;
        if (typeof actual === 'object' || typeof expected === 'object') return JSON.stringify(actual) === JSON.stringify(typeof expected === 'string' ? json(expected) : expected);
    }
    const a = String(actual), b = String(expected);
    return o.ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** A JSON path of data: one value; a path that selects several gives its single match, or the list. */
export function pathValue(data: unknown, path: string): unknown {
    try {
        const q = JsonPath.query(data, path);
        if (!q.multi) return q.values.length ? q.values[0] : undefined;
        return q.values.length === 1 ? q.values[0] : q.values.length ? q.values : undefined;
    } catch { return undefined; }
}
export function fieldValue(item: unknown, field: string): unknown {
    const f = field.trim();
    return pathValue(item, f.startsWith('$') ? f : `$.${f}`);
}

/** The value of a reference ($.path, xml:/path, header:Name, cookie:name, status, time, size, body). */
export function responseValue(r: ApiResponse, ref: string): unknown {
    const s = ref.trim();
    if (s.startsWith('$')) return pathValue(r.json !== undefined ? r.json : json(r.body), s);
    const at = s.indexOf(':');
    const kind = (at < 0 ? s : s.slice(0, at)).trim().toLowerCase();
    const name = at < 0 ? '' : s.slice(at + 1).trim();
    switch (kind) {
        case 'status': return r.status;
        case 'time': return r.timeMs;
        case 'size': return r.size;
        case 'body': return r.body;
        case 'header': { const k = Object.keys(r.headers).find((x) => x.toLowerCase() === name.toLowerCase()); return k ? r.headers[k] : undefined; }
        case 'cookie': return cookies(r).find((c) => c.name === name)?.value;
        case 'xml': return xmlValue(r.body, name);
    }
    throw new Error(`Unknown value reference "${ref}"`);
}

function cookies(r: ApiResponse): Array<{ name: string; value: string }> {
    const all = r.setCookies ?? (r.headers['set-cookie'] ? r.headers['set-cookie'].split(/,(?=\s*[^;,=\s]+=)/) : []);
    return all.map((c) => { const [nv] = c.split(';'); const i = nv.indexOf('='); return { name: nv.slice(0, i).trim(), value: nv.slice(i + 1).trim() }; });
}

/** An XML path: /a/b, /a/b[2], /a/@attr, //b; the text of the first match (the helper's xml()). */
export function xmlValue(text: string, path: string): unknown {
    type El = { name: string; attrs: Record<string, string>; children: El[]; text: string };
    const root: El = { name: '#document', attrs: {}, children: [], text: '' };
    const stack: El[] = [root];
    const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        const top = stack[stack.length - 1];
        if (m[1] !== undefined) top.text += m[1];
        else if (m[2]) { if (stack.length > 1) stack.pop(); }
        else if (m[3]) {
            const attrs: Record<string, string> = {};
            for (const a of (m[4] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3] ?? '');
            const el: El = { name: m[3], attrs, children: [], text: '' };
            top.children.push(el);
            if (!m[5]) stack.push(el);
        } else if (m[6] !== undefined) top.text += decode(m[6]);
    }
    const all = (e: El): string => e.text + e.children.map(all).join('');
    const descendants = (e: El): El[] => e.children.flatMap((c) => [c, ...descendants(c)]);
    let nodes: El[] = [root];
    const parts = path.trim().replace(/^\/\//, '/§/').split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
        let part = parts[i];
        let deep = false;
        if (part === '§') { deep = true; part = parts[++i]; }
        if (part.startsWith('@')) return nodes.map((n) => n.attrs[part.slice(1)]).find((x) => x !== undefined);
        const pm = /^([\w:.*-]+)(?:\[(\d+)\])?$/.exec(part);
        if (!pm) throw new Error(`Unsupported XML path part "${part}" in ${path}`);
        const pick = (list: El[]) => list.filter((c) => pm[1] === '*' || c.name === pm[1] || c.name.endsWith(`:${pm[1]}`));
        nodes = nodes.flatMap((n) => { const found = pick(deep ? descendants(n) : n.children); return pm[2] ? (found[Number(pm[2]) - 1] ? [found[Number(pm[2]) - 1]] : []) : found; });
    }
    return nodes.length ? all(nodes[0]).trim() : undefined;
}

/** A value checked with an operator (the helper's check()): the failure message, or null when it passes. */
export function checkValue(ref: string, actual: unknown, op: Operator, exp: unknown, o: Opts & { to?: unknown } = {}): { pass: boolean; message: string } {
    const text = actual === undefined || actual === null ? '' : typeof actual === 'string' ? actual : JSON.stringify(actual);
    const ic = (s: string) => (o.ignoreCase ? s.toLowerCase() : s);
    const n = (v: unknown) => { const x = num(v); if (x === null) throw new Error(`${show(v)} is not a number`); return x; };
    const order = (v: unknown) => (o.compare === 'date' || o.compare === 'datetime' || (o.compare === undefined && moment(v) !== null && num(v) === null) ? moment(v) ?? n(v) : n(v));
    const empty = actual === undefined || actual === null || (Array.isArray(actual) ? actual.length === 0 : typeof actual === 'object' ? Object.keys(actual as object).length === 0 : String(actual).trim() === '');
    const e = typeof exp === 'string' ? exp : String(exp ?? '');
    let pass: boolean, wanted: string;
    try {
        switch (op) {
            case 'equals': pass = same(actual, exp, o); wanted = `to be ${show(exp)}`; break;
            case 'notEquals': pass = actual !== undefined && !same(actual, exp, o); wanted = `not to be ${show(exp)}`; break;
            case 'contains': pass = actual !== undefined && (Array.isArray(actual) ? actual.some((x) => same(x, exp, o)) : ic(text).includes(ic(e))); wanted = `to contain ${show(exp)}`; break;
            case 'notContains': pass = actual !== undefined && !(Array.isArray(actual) ? actual.some((x) => same(x, exp, o)) : ic(text).includes(ic(e))); wanted = `not to contain ${show(exp)}`; break;
            case 'matches': pass = actual !== undefined && new RegExp(e, o.ignoreCase ? 'i' : '').test(text); wanted = `to match /${e}/`; break;
            case 'exists': pass = actual !== undefined; wanted = 'to exist'; break;
            case 'notExists': pass = actual === undefined; wanted = 'not to exist'; break;
            case 'empty': pass = empty; wanted = 'to be empty'; break;
            case 'notEmpty': pass = !empty; wanted = 'not to be empty'; break;
            case 'type': { const t = actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual; pass = t === e.toLowerCase(); wanted = `to be of type ${e}`; break; }
            case 'count': { const c = Array.isArray(actual) ? actual.length : actual === undefined ? 0 : 1; pass = c === n(exp); wanted = `to have ${e} item(s) (has ${c})`; break; }
            case 'greater': pass = actual !== undefined && order(actual) > order(exp); wanted = `to be greater than ${e}`; break;
            case 'less': pass = actual !== undefined && order(actual) < order(exp); wanted = `to be less than ${e}`; break;
            case 'atLeast': pass = actual !== undefined && order(actual) >= order(exp); wanted = `to be at least ${e}`; break;
            case 'atMost': pass = actual !== undefined && order(actual) <= order(exp); wanted = `to be at most ${e}`; break;
            case 'between': pass = actual !== undefined && order(actual) >= order(exp) && order(actual) <= order(o.to); wanted = `to be between ${e} and ${String(o.to)}`; break;
            case 'oneOf': { const options = e.split(',').map((x) => x.trim()); pass = actual !== undefined && options.some((x) => same(actual, x, o)); wanted = `to be one of ${options.join(', ')}`; break; }
            default: return { pass: false, message: `Unknown operator ${op}` };
        }
    } catch (err) { return { pass: false, message: `${ref}: ${(err as Error).message}` }; }
    const said: Record<string, string> = { equals: `is ${show(exp)}`, notEquals: `is not ${show(exp)}`, contains: `contains ${show(exp)}`, notContains: `does not contain ${show(exp)}`, matches: `matches /${e}/`, exists: 'exists', notExists: 'does not exist', empty: 'is empty', notEmpty: 'is not empty', type: `is of type ${e}`, count: `has ${e} item(s)`, greater: `is greater than ${e}`, less: `is less than ${e}`, atLeast: `is at least ${e}`, atMost: `is at most ${e}`, between: `is between ${e} and ${String(o.to)}`, oneOf: `is one of ${e.split(',').map((x) => x.trim()).join(', ')}` };
    return { pass, message: pass ? `${ref} ${said[op]}${op === 'equals' || op === 'exists' || op === 'notEmpty' ? '' : ` (${show(actual)})`}` : `${ref} was expected ${wanted}, but was ${show(actual)}` };
}

/** An expected value's text with {{saved}}, <column> and {config:} filled in. */
function expectedFilled(e: Expected | undefined, v: Values): string {
    return fill(expectedText(e), v);
}

/** Checks of the kinds the workspace evaluates here (rule, schema, dbItems); others: null. */
export async function evaluateExtra(ch: ApiCheck, r: ApiResponse, v: Values, queryRows?: QueryRows): Promise<CheckResult | null> {
    if (ch.kind === 'schema') return schemaCheck(ch, r, v);
    if (ch.kind === 'dbItems') {
        if (!ch.db) return { check: ch, pass: false, message: 'The database check is not set up.' };
        if (!queryRows) return { check: ch, pass: false, message: 'The database check needs the project\'s database connection.' };
        const errors = await itemsAgainstQuery(ch.db, r, v, queryRows).catch((e: Error) => [e.message]);
        return { check: ch, pass: !errors.length, message: errors.length ? `${errors.length} difference(s) with the database: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? '; …' : ''}` : `Each ${ch.db.title || 'item'} of ${ch.db.items} matches ${ch.db.query}` };
    }
    if (ch.kind !== 'rule') return null;
    // A JSON path that cannot be read is said as such, not reported as a value that is missing.
    const path = (ch.target ?? '').trim();
    if ((ch.source ?? 'json') === 'json' && path && (() => { try { JsonPath.parse(path); return false; } catch { return true; } })())
        return { check: ch, pass: false, message: `"${path}" is not a JSON path: start with $ and use .name or [index] (for example $.items[0].id)` };
    const ref = valueRef(ch);
    let actual: unknown;
    try { actual = responseValue(r, ref); } catch (e) { return { check: ch, pass: false, message: (e as Error).message }; }
    const o: Opts = { compare: ch.compare && ch.compare !== 'text' ? ch.compare : ch.compare === 'text' ? 'text' : undefined, tolerance: ch.tolerance, ignoreCase: ch.ignoreCase };
    if (ch.expected?.from === 'query') {
        const e = ch.expected;
        if (!queryRows) return { check: ch, pass: false, actual: show(actual), message: 'This check needs the project\'s database connection.' };
        try {
            const rows = await queryRows(e.connection ?? '', e.query ?? '', (e.params ?? []).filter((p) => p.trim()).map((p) => fill(p, v)));
            if (!rows.length) return { check: ch, pass: false, actual: show(actual), message: `${e.query} returned no rows` };
            const expected = column(rows[0], e.column ?? '');
            const pass = same(actual, expected, o);
            return { check: ch, pass, actual: show(actual), message: pass ? `${ref} is ${show(actual)} (${e.query}.${e.column})` : `${ref} was expected to be ${show(expected)} (${e.query}.${e.column}), but was ${show(actual)}` };
        } catch (err) { return { check: ch, pass: false, actual: show(actual), message: (err as Error).message }; }
    }
    const res = checkValue(ref, actual, ch.op ?? 'equals', expectedFilled(ch.expected, v), { ...o, to: ch.expected2 ? expectedFilled(ch.expected2, v) : undefined });
    return { check: ch, pass: res.pass, actual: show(actual), message: res.message };
}

export function column(row: Record<string, unknown>, name: string): unknown {
    if (name in row) return row[name];
    const key = Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : row[key];
}

/** Each item against the rows of its query (the helper's checkItemsAgainstQuery): the differences. */
export async function itemsAgainstQuery(rule: DbItemsRule, r: ApiResponse, v: Values, queryRows: QueryRows): Promise<string[]> {
    const list = responseValue(r, rule.items.trim());
    const items: unknown[] = Array.isArray(list) ? list : list === undefined ? [] : [list];
    if (!items.length) return [`${rule.items} has no items`];
    const errors: string[] = [];
    const fields = rule.fields.filter((f) => f.field.trim() && f.column.trim());
    const matchCompare = (rule.fields.find((f) => f.field === rule.matchBy?.field)?.compare ?? 'auto') as Compare;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const params = rule.params.map((p) => p.trim()).filter(Boolean).map((p) => {
            if ((p.startsWith("'") && p.endsWith("'")) || (p.startsWith('"') && p.endsWith('"'))) return fill(p.slice(1, -1), v);
            if (/^\{\{.+\}\}$/.test(p) || /^<.+>$/.test(p)) return fill(p, v);
            return fieldValue(item, p);
        });
        const label = `${rule.items}[${i}] (${params.map(show).join(', ')})`;
        const rows = await queryRows(rule.connection, rule.query, params, rule.sql);
        if (!rows.length) {
            if (!rule.whenNoRows?.length) { errors.push(`${label}: ${rule.query} returned no rows`); continue; }
            for (const w of rule.whenNoRows.filter((x) => x.field.trim())) {
                const actual = fieldValue(item, w.field);
                if (!same(actual, fill(w.value, v))) errors.push(`${label}: no rows in the database, ${w.field} was expected to be ${w.value}, but was ${show(actual)}`);
            }
            continue;
        }
        const elements: unknown[] = rule.rows?.trim() ? ([] as unknown[]).concat(fieldValue(item, rule.rows) ?? []) : [item];
        if (rule.count && elements.length !== rows.length) errors.push(`${label}: ${rule.rows || 'items'} has ${elements.length}, the database ${rows.length} row(s)`);
        elements.forEach((el, k) => {
            let row: Record<string, unknown> | undefined;
            if (rule.matchBy?.field?.trim() && rule.matchBy.column?.trim()) {
                const key = fieldValue(el, rule.matchBy.field);
                row = rows.find((x) => same(key, column(x, rule.matchBy!.column), { compare: matchCompare }));
                if (!row) { errors.push(`${label}: no database row with ${rule.matchBy.column} = ${show(key)} (${rule.matchBy.field} of element ${k})`); return; }
            } else row = rows[k] ?? rows[0];
            for (const f of fields) {
                const actual = fieldValue(el, f.field), expected = column(row, f.column);
                if (!same(actual, expected, { compare: f.compare, tolerance: f.tolerance })) errors.push(`${label}${rule.rows ? `.${rule.rows}[${k}]` : ''}.${f.field}: the database has ${show(expected)} (${f.column}), the response ${show(actual)}`);
            }
        });
    }
    return errors;
}

/**
 * A JSON schema check, with the framework's engine (Ajv, see schema.ts). A schema file is found as the framework's
 * step finds it: an absolute path, TEST_DATA_PATH (default ./test-data)/api/schemas/<file>, then <file> from the
 * project folder.
 */
function schemaCheck(ch: ApiCheck, r: ApiResponse, v: Values): CheckResult {
    let schema: unknown;
    const file = ch.schemaFile?.trim();
    if (file) {
        if (!v.readFile) return { check: ch, pass: false, message: `The schema file ${file} cannot be read here.` };
        const base = (v.env.TEST_DATA_PATH || 'test-data').replace(/^\.\//, '').replace(/[\\/]+$/, '');
        let text: string | undefined;
        for (const rel of [`${base}/api/schemas/${file}`, file]) { try { text = v.readFile(rel).toString('utf8'); break; } catch { /* next */ } }
        if (text === undefined) return { check: ch, pass: false, message: `Schema file not found: ${file} (looked in ${base}/api/schemas and the project folder).` };
        try { schema = JSON.parse(text); } catch (e) { return { check: ch, pass: false, message: `${file} is not valid JSON: ${(e as Error).message}` }; }
    } else {
        try { schema = JSON.parse(ch.schema ?? ''); } catch (e) { return { check: ch, pass: false, message: `The schema is not valid JSON: ${(e as Error).message}` }; }
    }
    const errors = schemaErrors(r.json !== undefined ? r.json : json(r.body), schema);
    return { check: ch, pass: !errors.length, message: errors.length ? `Schema${file ? ` ${file}` : ''}: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? `; … (${errors.length} in all)` : ''}` : `The body matches the schema${file ? ` ${file}` : ''}` };
}

/** A saved value of the kinds the workspace reads here (cookie, status, xml, regex, body); others: undefined. */
export function extractExtra(x: ApiExtract, r: ApiResponse): { found: boolean; value?: unknown } | undefined {
    switch (x.from) {
        case 'cookie': case 'status': case 'xml': case 'body': {
            const v = responseValue(r, valueRef({ source: x.from, target: x.path }));
            return { found: v !== undefined, value: v };
        }
        case 'regex': {
            try { const m = new RegExp(x.path).exec(r.body); return m ? { found: true, value: m[1] !== undefined ? m[1] : m[0] } : { found: false }; } catch { return { found: false }; }
        }
        default: return undefined;
    }
}

/**
 * Prepared test data (the helper's prepare()): a field the row leaves empty takes its default (a query's
 * first value or every row's as a list, today, the previous business day, or a text). Sets values.vars.
 */
export async function prepareValues(rules: import('./model').ApiPrepare[] | undefined, v: Values, queryRows?: QueryRows, now = new Date()): Promise<string[]> {
    const notes: string[] = [];
    const fmt = (d: Date, f = 'YYYY-MM-DD') => f.replace(/YYYY/g, String(d.getFullYear())).replace(/MM/g, pad(d.getMonth() + 1)).replace(/DD/g, pad(d.getDate()));
    for (const r of (rules ?? []).filter((x) => x.name.trim())) {
        const name = r.name.trim();
        const current = v.row && name in v.row ? v.row[name] : v.vars[name];
        let empty = current === undefined || current.trim() === '';
        if (!empty) { try { const j = JSON.parse(current); if (Array.isArray(j) && !j.length) empty = true; } catch { /* text */ } }
        if (!empty) { v.vars[name] = current; continue; }
        let value: unknown;
        if (r.whenEmpty === 'text') value = fill(r.value ?? '', v);
        else if (r.whenEmpty === 'today') value = fmt(now, r.format);
        else if (r.whenEmpty === 'previousBusinessDay') { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate()); do d.setDate(d.getDate() - 1); while (d.getDay() === 0 || d.getDay() === 6); value = fmt(d, r.format); }
        else {
            if (!queryRows) throw new Error(`${name}: its default comes from the database (${r.query}): the project's database connection is needed.`);
            const rows = await queryRows(r.connection ?? '', r.query ?? '', (r.params ?? []).filter((p) => p.trim()).map((p) => fill(p, v)));
            const col = (x: Record<string, unknown>) => (r.column?.trim() ? column(x, r.column.trim()) : Object.values(x)[0]);
            value = r.list ? rows.map(col) : rows.length ? col(rows[0]) : undefined;
            if (value === undefined) throw new Error(`${name}: ${r.query} returned no rows`);
            if (isDate(value)) value = fmt(value, r.format);
        }
        v.vars[name] = typeof value === 'string' ? value : JSON.stringify(value, (_k, x) => (x instanceof Date ? fmt(x, r.format) : x));
        notes.push(`${name} was empty: ${v.vars[name].slice(0, 200)}`);
    }
    return notes;
}

/** A database cell as the worker sends it, back to the adapter's value (a date as a Date). */
export function fromCell(c: unknown): unknown {
    if (c && typeof c === 'object' && '$t' in (c as Record<string, unknown>)) {
        const x = c as { $t: string; v: string };
        if (x.$t === 'date') return new Date(x.v);
        if (x.$t === 'json') { try { return JSON.parse(x.v); } catch { return x.v; } }
        return x.v;
    }
    return c;
}

/**
 * Rows chosen by an Examples filter as the framework reads it: conditions separated by ; (all must
 * hold), each column=value, column!=value, column>value or column<value.
 */
export function filterRows(rows: Array<Record<string, string>>, filter?: string): Array<Record<string, string>> {
    const conds = (filter ?? '').split(/[;&]/).map((x) => x.trim()).filter(Boolean).map((c) => {
        const m = /^([^!=<>]+?)\s*(!=|>=|<=|=|>|<)\s*(.*)$/.exec(c);
        return m ? { col: m[1].trim(), op: m[2], val: m[3].trim().replace(/^['"]|['"]$/g, '') } : null;
    }).filter((x): x is { col: string; op: string; val: string } => !!x);
    return rows.filter((r) => conds.every(({ col, op, val }) => {
        const a = String(r[col] ?? '');
        const na = Number(a), nb = Number(val), num = a.trim() !== '' && val !== '' && !isNaN(na) && !isNaN(nb);
        switch (op) {
            case '=': return a === val;
            case '!=': return a !== val;
            case '>': return num ? na > nb : a > val;
            case '<': return num ? na < nb : a < val;
            case '>=': return num ? na >= nb : a >= val;
            default: return num ? na <= nb : a <= val;
        }
    }));
}
