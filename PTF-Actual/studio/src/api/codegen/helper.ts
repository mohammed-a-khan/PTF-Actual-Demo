/**
 * The project code the API workspace writes for checks the framework's built-in steps do not have:
 * a helper (test/<project>/helpers/ApiResponseChecks.ts) and its generic steps
 * (test/<project>/steps/api-response-checks.steps.ts). Plain TypeScript in the framework's style, the
 * project's own to read and change: it uses only the framework's public API (CSApiContextManager,
 * CSJsonPath, CSBDDContext, CSDBUtils, CSReporter).
 */

export const HELPER_CLASS = 'ApiResponseChecks';
export const HELPER_FILE = 'ApiResponseChecks.ts';
export const CHECK_STEPS_FILE = 'api-response-checks.steps.ts';

/** The helper, importing from the framework package `pkg`. */
export function helperText(pkg: string): string {
    return `/**
 * Checks of API responses for the project's API features (written by CS Test Studio; the project's own
 * code to read and change).
 *
 * A value reference names a value of the last response:
 *   $.path        a JSON path ($.items[0].id, $.items[?(@.sku=='A1')].qty, $.items[*].id)
 *   xml:/a/b      an XML path (/order/status, /order/@id, /order/items/item[2]/sku)
 *   header:Name   a header        cookie:name   a cookie the response sets
 *   status        the status      time          milliseconds      size   bytes      body   the text
 *
 * An expected value may hold {{name}}: a value saved earlier in the scenario (user saves …) or set as
 * test data. <column> (a Scenario Outline's data) and {config:KEY} are filled in by the framework first.
 *
 * Comparisons ("compare"):
 *   auto      numbers as numbers, a database date with a date of the response by the day, else text
 *   text      the same text           number   within a tolerance (0.0001)
 *   date      the same day            datetime the same moment
 */
import { CSApiContextManager, CSJsonPath } from '${pkg}/api';
import { CSBDDContext } from '${pkg}/bdd';
import { CSDBUtils } from '${pkg}/database-utils';
import { CSReporter } from '${pkg}/reporting';

export type Compare = 'auto' | 'text' | 'number' | 'date' | 'datetime';

export type Operator =
    | 'equals' | 'notEquals' | 'contains' | 'notContains' | 'matches' | 'exists' | 'notExists'
    | 'empty' | 'notEmpty' | 'type' | 'count' | 'greater' | 'less' | 'atLeast' | 'atMost' | 'between' | 'oneOf';

export interface CheckOptions { compare?: Compare; tolerance?: number; ignoreCase?: boolean }

/** Each item of a list in the response against the rows a database query returns for it. */
export interface ItemsQueryRule {
    /** The list: a JSON path ($.orders). */
    items: string;
    /** DB_<connection>_* settings of the project. */
    connection: string;
    /** A DB_QUERY_<name> of the project (or SQL). */
    query: string;
    /** For each item: an item field (orderNo, header.code), {{saved}}, or text in quotes ('WEB'). */
    params: string[];
    /** The item's list compared with the rows (lines); none: the item itself with the first row. */
    rows?: string;
    /** How a row is found for an element: the element's field and the row's column (compared as compare). */
    matchBy?: { field: string; column: string; compare?: Compare };
    /** The number of elements equals the number of rows. */
    count?: boolean;
    fields: Array<{ field: string; column: string; compare?: Compare; tolerance?: number }>;
    /** When the query returns no rows: the item's fields expected (field, value); none: no rows is a failure. */
    whenNoRows?: Array<[string, string]>;
}

/** A test data value prepared before a request: the row's value, or when it is empty a default. */
export interface PrepareRule {
    name: string;
    whenEmpty: 'query' | 'today' | 'previousBusinessDay' | 'text';
    format?: string;
    value?: string;
    connection?: string;
    query?: string;
    params?: string[];
    column?: string;
    /** query: every row's column as a list (else the first row's). */
    list?: boolean;
}

export class ${HELPER_CLASS} {
    private static instance: ${HELPER_CLASS};

    public static getInstance(): ${HELPER_CLASS} {
        if (!${HELPER_CLASS}.instance) ${HELPER_CLASS}.instance = new ${HELPER_CLASS}();
        return ${HELPER_CLASS}.instance;
    }

    // ---- the response ----

    public response(): any {
        const response = CSApiContextManager.getInstance().getCurrentContext()?.getLastResponse();
        if (!response) throw new Error('No response: send a request first.');
        return response;
    }

    /** The body (JSON parsed). */
    public body(): any {
        const r = this.response();
        const b = r.body !== undefined ? r.body : r.data;
        if (typeof b === 'string') { try { return JSON.parse(b); } catch { return b; } }
        return b;
    }

    /** The body as received (text). */
    public text(): string {
        const r = this.response();
        if (typeof r.rawBody === 'string') return r.rawBody;
        const b = r.body !== undefined ? r.body : r.data;
        if (b === undefined || b === null) return '';
        if (typeof b === 'string') return b;
        if (Buffer.isBuffer(b)) return b.toString('utf8');
        return JSON.stringify(b);
    }

    /** The value a reference names (see the top of this file). */
    public value(ref: string): any {
        const r = ref.trim();
        if (r.startsWith('$')) return this.path(this.body(), r);
        const at = r.indexOf(':');
        const kind = (at < 0 ? r : r.slice(0, at)).trim().toLowerCase();
        const name = at < 0 ? '' : r.slice(at + 1).trim();
        const response = this.response();
        switch (kind) {
            case 'status': return response.status;
            case 'time': return response.duration;
            case 'size': return typeof response.size === 'number' ? response.size : Buffer.byteLength(this.text());
            case 'body': return this.text();
            case 'header': {
                const headers = response.headers ?? {};
                const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
                const v = key ? headers[key] : undefined;
                return Array.isArray(v) ? v.join(', ') : v;
            }
            case 'cookie': {
                const cookies: Array<{ name: string; value: string }> = response.cookies
                    ?? ([] as string[]).concat(response.headers?.['set-cookie'] ?? []).map((c: string) => { const [nv] = c.split(';'); const i = nv.indexOf('='); return { name: nv.slice(0, i).trim(), value: nv.slice(i + 1).trim() }; });
                return cookies.find((c) => c.name === name)?.value;
            }
            case 'xml': return this.xml(this.text(), name);
        }
        throw new Error(\`Unknown value reference "\${ref}": use $.path, xml:/path, header:Name, cookie:name, status, time, size or body.\`);
    }

    /** A JSON path of data: one value; a path that selects several gives its single match, or the list. */
    public path(data: any, path: string): any {
        const q = CSJsonPath.query(data, path);
        if (!q.multi) return q.values.length ? q.values[0] : undefined;
        return q.values.length === 1 ? q.values[0] : q.values.length ? q.values : undefined;
    }

    /** A field of an item: a name or a path inside it (code, error.code, lines.length, $.a[0]). */
    public field(item: any, field: string): any {
        const f = field.trim();
        return this.path(item, f.startsWith('$') ? f : \`$.\${f}\`);
    }

    /** {{name}}: a value saved earlier in the scenario (API values first, then test data). */
    public resolve(text: string): string {
        if (typeof text !== 'string') return text;
        const api = CSApiContextManager.getInstance().getCurrentContext();
        const bdd = CSBDDContext.getInstance();
        return text.replace(/\\{\\{\\s*([\\w.-]+)\\s*\\}\\}/g, (m, name: string) => {
            let v = api?.getVariable(name);
            if (v === undefined) v = bdd.get(name);
            if (v === undefined) { const row = bdd.get('currentRow'); if (row && typeof row === 'object' && name in row) v = row[name]; }
            if (v === undefined) throw new Error(\`\${m} has no value: save it first (user saves …) or set it as test data.\`);
            return typeof v === 'string' ? v : JSON.stringify(v);
        });
    }

    // ---- comparisons ----

    /** Whether two values are the same (see "compare" at the top of this file). */
    public same(actual: any, expected: any, o: CheckOptions = {}): boolean {
        const mode = o.compare ?? 'auto';
        if (actual === undefined) return false;
        if (mode === 'number') {
            const a = this.num(actual), b = this.num(expected);
            return a !== null && b !== null && Math.abs(a - b) <= (o.tolerance ?? 0.0001) + 1e-12;
        }
        if (mode === 'date') { const a = this.day(actual), b = this.day(expected); return a !== null && a === b; }
        if (mode === 'datetime') { const a = this.moment(actual), b = this.moment(expected); return a !== null && a === b; }
        if (mode === 'auto') {
            if (expected instanceof Date || actual instanceof Date) {
                const dateOnly = (v: any) => typeof v === 'string' && /^\\d{4}-\\d{2}-\\d{2}$/.test(v.trim());
                return dateOnly(actual) || dateOnly(expected) ? this.same(actual, expected, { compare: 'date' }) : this.same(actual, expected, { compare: 'datetime' });
            }
            if (actual === null || expected === null) return actual === expected || String(actual) === String(expected);
            if (typeof actual === 'boolean' || typeof expected === 'boolean') return String(actual) === String(expected);
            const a = this.num(actual), b = this.num(expected);
            if (a !== null && b !== null) return Math.abs(a - b) <= (o.tolerance ?? 0) + 1e-12;
            if (typeof actual === 'object' || typeof expected === 'object') return JSON.stringify(actual) === JSON.stringify(typeof expected === 'string' ? this.json(expected) : expected);
        }
        const a = String(actual), b = String(expected);
        return o.ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b;
    }

    /** A value of the response checked with an operator; the failure says what was found. */
    public check(ref: string, op: Operator, expected?: string, o: CheckOptions & { to?: string } = {}): void {
        const actual = this.value(ref);
        const exp = expected === undefined ? undefined : this.resolve(expected);
        const to = o.to === undefined ? undefined : this.resolve(o.to);
        const shown = this.show(actual);
        const text = actual === undefined || actual === null ? '' : typeof actual === 'string' ? actual : JSON.stringify(actual);
        const ic = (s: string) => (o.ignoreCase ? s.toLowerCase() : s);
        const num = (v: any) => { const n = this.num(v); if (n === null) throw new Error(\`\${ref}: \${this.show(v)} is not a number\`); return n; };
        const order = (v: any) => (o.compare === 'date' || o.compare === 'datetime' || (o.compare === undefined && this.moment(v) !== null && this.num(v) === null) ? this.moment(v) ?? num(v) : num(v));
        let pass: boolean;
        let wanted: string;
        switch (op) {
            case 'equals': pass = this.same(actual, exp, o); wanted = \`to be \${this.show(exp)}\`; break;
            case 'notEquals': pass = actual !== undefined && !this.same(actual, exp, o); wanted = \`not to be \${this.show(exp)}\`; break;
            case 'contains': pass = actual !== undefined && (Array.isArray(actual) ? actual.some((x) => this.same(x, exp, o)) : ic(text).includes(ic(exp ?? ''))); wanted = \`to contain \${this.show(exp)}\`; break;
            case 'notContains': pass = actual !== undefined && !(Array.isArray(actual) ? actual.some((x) => this.same(x, exp, o)) : ic(text).includes(ic(exp ?? ''))); wanted = \`not to contain \${this.show(exp)}\`; break;
            case 'matches': pass = actual !== undefined && new RegExp(exp ?? '', o.ignoreCase ? 'i' : '').test(text); wanted = \`to match /\${exp}/\`; break;
            case 'exists': pass = actual !== undefined; wanted = 'to exist'; break;
            case 'notExists': pass = actual === undefined; wanted = 'not to exist'; break;
            case 'empty': pass = actual === undefined || actual === null || (Array.isArray(actual) ? actual.length === 0 : typeof actual === 'object' ? Object.keys(actual).length === 0 : String(actual).trim() === ''); wanted = 'to be empty'; break;
            case 'notEmpty': pass = !(actual === undefined || actual === null || (Array.isArray(actual) ? actual.length === 0 : typeof actual === 'object' ? Object.keys(actual).length === 0 : String(actual).trim() === '')); wanted = 'not to be empty'; break;
            case 'type': { const t = actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual; pass = t === (exp ?? '').toLowerCase(); wanted = \`to be of type \${exp}\`; break; }
            case 'count': { const n = Array.isArray(actual) ? actual.length : actual === undefined ? 0 : 1; pass = n === num(exp); wanted = \`to have \${exp} item(s) (has \${n})\`; break; }
            case 'greater': pass = actual !== undefined && order(actual) > order(exp); wanted = \`to be greater than \${exp}\`; break;
            case 'less': pass = actual !== undefined && order(actual) < order(exp); wanted = \`to be less than \${exp}\`; break;
            case 'atLeast': pass = actual !== undefined && order(actual) >= order(exp); wanted = \`to be at least \${exp}\`; break;
            case 'atMost': pass = actual !== undefined && order(actual) <= order(exp); wanted = \`to be at most \${exp}\`; break;
            case 'between': pass = actual !== undefined && order(actual) >= order(exp) && order(actual) <= order(to); wanted = \`to be between \${exp} and \${to}\`; break;
            case 'oneOf': { const options = (exp ?? '').split(',').map((x) => x.trim()); pass = actual !== undefined && options.some((x) => this.same(actual, x, o)); wanted = \`to be one of \${options.join(', ')}\`; break; }
            default: throw new Error(\`Unknown operator \${op}\`);
        }
        if (!pass) throw new Error(\`\${ref} was expected \${wanted}, but was \${shown}\`);
        const said: Record<string, string> = { equals: \`is \${this.show(exp)}\`, notEquals: \`is not \${this.show(exp)}\`, contains: \`contains \${this.show(exp)}\`, notContains: \`does not contain \${this.show(exp)}\`, matches: \`matches /\${exp}/\`, exists: 'exists', notExists: 'does not exist', empty: 'is empty', notEmpty: 'is not empty', type: \`is of type \${exp}\`, count: \`has \${exp} item(s)\`, greater: \`is greater than \${exp}\`, less: \`is less than \${exp}\`, atLeast: \`is at least \${exp}\`, atMost: \`is at most \${exp}\`, between: \`is between \${exp} and \${to}\`, oneOf: \`is one of \${exp}\` };
        CSReporter.pass(\`\${ref} \${said[op]}\${op === 'equals' || op === 'exists' || op === 'notEmpty' ? '' : \` (\${shown})\`}\`);
    }

    // ---- the database ----

    /** The rows of a query (a DB_QUERY_<name> of the project, or SQL) on a connection; {{name}} in parameters filled. */
    public async rows(connection: string, query: string, params: any[] = []): Promise<Record<string, any>[]> {
        const values = params.map((p) => (typeof p === 'string' ? this.resolve(p) : p));
        const result = await CSDBUtils.executeQuery(connection, query, values);
        return result.rows ?? [];
    }

    /** A column of a row, whatever its case (Oracle returns upper case). */
    public column(row: Record<string, any>, name: string): any {
        if (name in row) return row[name];
        const key = Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase());
        return key === undefined ? undefined : row[key];
    }

    /** A value of the response equals a column of the first row a query returns. */
    public async checkQuery(ref: string, column: string, connection: string, query: string, params: string[], o: CheckOptions = {}): Promise<void> {
        const rows = await this.rows(connection, query, params);
        if (!rows.length) throw new Error(\`\${query} returned no rows (parameters: \${params.map((p) => this.resolve(p)).join(', ') || 'none'})\`);
        const expected = this.column(rows[0], column);
        const actual = this.value(ref);
        if (!this.same(actual, expected, o)) throw new Error(\`\${ref} was expected to be \${this.show(expected)} (\${query}.\${column}), but was \${this.show(actual)}\`);
        CSReporter.pass(\`\${ref} is \${this.show(actual)} (\${query}.\${column})\`);
    }

    /** Each item of a list in the response against the rows a query returns for it (see ItemsQueryRule). */
    public async checkItemsAgainstQuery(rule: ItemsQueryRule): Promise<void> {
        const list = this.path(this.body(), rule.items);
        const items: any[] = Array.isArray(list) ? list : list === undefined ? [] : [list];
        if (!items.length) throw new Error(\`\${rule.items} has no items\`);
        const errors: string[] = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const params = rule.params.map((p) => this.param(item, p));
            const label = \`\${rule.items}[\${i}] (\${params.map((p) => this.show(p)).join(', ')})\`;
            const rows = await this.rows(rule.connection, rule.query, params);
            if (!rows.length) {
                if (!rule.whenNoRows) { errors.push(\`\${label}: \${rule.query} returned no rows\`); continue; }
                for (const [field, value] of rule.whenNoRows) {
                    const actual = this.field(item, field);
                    if (!this.same(actual, this.resolve(value))) errors.push(\`\${label}: no rows in the database, \${field} was expected to be \${value}, but was \${this.show(actual)}\`);
                }
                continue;
            }
            const elements: any[] = rule.rows ? ([] as any[]).concat(this.field(item, rule.rows) ?? []) : [item];
            if (rule.count && elements.length !== rows.length) errors.push(\`\${label}: \${rule.rows ?? 'items'} has \${elements.length}, the database \${rows.length} row(s)\`);
            elements.forEach((element, k) => {
                let row: Record<string, any> | undefined;
                if (rule.matchBy) {
                    const key = this.field(element, rule.matchBy.field);
                    row = rows.find((r) => this.same(key, this.column(r, rule.matchBy!.column), { compare: rule.matchBy!.compare ?? 'auto' }));
                    if (!row) { errors.push(\`\${label}: no database row with \${rule.matchBy.column} = \${this.show(key)} (\${rule.matchBy.field} of element \${k})\`); return; }
                } else row = rows[k] ?? rows[0];
                for (const f of rule.fields) {
                    const actual = this.field(element, f.field), expected = this.column(row, f.column);
                    if (!this.same(actual, expected, { compare: f.compare ?? 'auto', tolerance: f.tolerance })) errors.push(\`\${label}\${rule.rows ? \`.\${rule.rows}[\${k}]\` : ''}.\${f.field}: the database has \${this.show(expected)} (\${f.column}), the response \${this.show(actual)}\`);
                }
            });
        }
        if (errors.length) throw new Error(\`\${errors.length} difference(s) with the database:\\n  \${errors.join('\\n  ')}\`);
        CSReporter.pass(\`\${items.length} item(s) of \${rule.items} match \${rule.query}\`);
    }

    // ---- test data ----

    /** Test data values prepared before a request: the row's value, or a default when it is empty. */
    public async prepare(rules: PrepareRule[]): Promise<void> {
        const bdd = CSBDDContext.getInstance();
        const api = CSApiContextManager.getInstance().getCurrentContext();
        const row = bdd.get('currentRow') ?? {};
        for (const r of rules) {
            let value: any = r.name in row ? row[r.name] : bdd.get(r.name);
            const empty = value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && !value.length);
            if (empty) {
                if (r.whenEmpty === 'text') value = this.resolve(r.value ?? '');
                else if (r.whenEmpty === 'today') value = this.formatDate(new Date(), r.format);
                else if (r.whenEmpty === 'previousBusinessDay') value = this.formatDate(this.previousBusinessDay(new Date()), r.format);
                else {
                    const rows = await this.rows(r.connection ?? '', r.query ?? '', r.params ?? []);
                    const col = (x: Record<string, any>) => (r.column ? this.column(x, r.column) : Object.values(x)[0]);
                    value = r.list ? rows.map(col) : rows.length ? col(rows[0]) : undefined;
                    if (value === undefined) throw new Error(\`\${r.name}: \${r.query} returned no rows\`);
                    if (value instanceof Date) value = this.formatDate(value, r.format);
                }
                CSReporter.info(\`\${r.name} was empty: \${JSON.stringify(value)}\`);
            }
            bdd.set(r.name, value);
            api?.setVariable(r.name, value);
        }
    }

    public formatDate(d: Date, format = 'YYYY-MM-DD'): string {
        const p = (n: number) => String(n).padStart(2, '0');
        return format.replace(/YYYY/g, String(d.getFullYear())).replace(/MM/g, p(d.getMonth() + 1)).replace(/DD/g, p(d.getDate()));
    }

    public previousBusinessDay(d: Date): Date {
        const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        do x.setDate(x.getDate() - 1); while (x.getDay() === 0 || x.getDay() === 6);
        return x;
    }

    // ---- inner ----

    /** A query parameter for an item: 'text', {{saved}}, or the item's field. */
    private param(item: any, p: string): any {
        const t = p.trim();
        if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return this.resolve(t.slice(1, -1));
        if (/^\\{\\{.+\\}\\}$/.test(t)) return this.resolve(t);
        return this.field(item, t);
    }

    private num(v: any): number | null {
        if (typeof v === 'number') return v;
        if (typeof v === 'bigint') return Number(v);
        if (v === null || v === undefined || typeof v === 'boolean' || v instanceof Date) return null;
        const s = String(v).trim();
        return s !== '' && !isNaN(Number(s)) ? Number(s) : null;
    }

    /** The day of a date (local date of a database date; the written day of an ISO text). */
    private day(v: any): string | null {
        if (v instanceof Date) { if (isNaN(v.getTime())) return null; return this.formatDate(v); }
        const s = String(v ?? '').trim();
        const m = /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(s);
        if (m) return \`\${m[1]}-\${m[2]}-\${m[3]}\`;
        const t = Date.parse(s);
        return isNaN(t) ? null : this.formatDate(new Date(t));
    }

    private moment(v: any): number | null {
        if (v instanceof Date) return isNaN(v.getTime()) ? null : v.getTime();
        if (typeof v !== 'string' || !/\\d{4}-\\d{2}-\\d{2}/.test(v)) return null;
        const t = Date.parse(v.trim().replace(' ', 'T'));
        return isNaN(t) ? null : t;
    }

    private json(s: string): any { try { return JSON.parse(s); } catch { return s; } }

    private show(v: any): string {
        if (v === undefined) return '(missing)';
        if (v instanceof Date) return v.toISOString();
        return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
    }

    /** An XML path of a document: /a/b, /a/b[2], /a/@attr, //b (anywhere); the text of the first match. */
    private xml(text: string, path: string): any {
        type El = { name: string; attrs: Record<string, string>; children: El[]; text: string };
        const root: El = { name: '#document', attrs: {}, children: [], text: '' };
        const stack: El[] = [root];
        const re = /<!--[\\s\\S]*?-->|<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|<\\?[\\s\\S]*?\\?>|<!DOCTYPE[^>]*>|<\\/\\s*([\\w:.-]+)\\s*>|<([\\w:.-]+)((?:\\s+[\\w:.-]+\\s*=\\s*(?:"[^"]*"|'[^']*'))*)\\s*(\\/?)>|([^<]+)/g;
        const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
            const top = stack[stack.length - 1];
            if (m[1] !== undefined) top.text += m[1];
            else if (m[2]) { if (stack.length > 1) stack.pop(); }
            else if (m[3]) {
                const attrs: Record<string, string> = {};
                for (const a of (m[4] ?? '').matchAll(/([\\w:.-]+)\\s*=\\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3] ?? '');
                const el: El = { name: m[3], attrs, children: [], text: '' };
                top.children.push(el);
                if (!m[5]) stack.push(el);
            } else if (m[6] !== undefined) top.text += decode(m[6]);
        }
        const all = (e: El): string => e.text + e.children.map(all).join('');
        const descendants = (e: El): El[] => e.children.flatMap((c) => [c, ...descendants(c)]);
        let nodes: El[] = [root];
        const parts = path.trim().replace(/^\\/\\//, '/§/').split('/').filter(Boolean);
        for (let i = 0; i < parts.length; i++) {
            let part = parts[i];
            let deep = false;
            if (part === '§') { deep = true; part = parts[++i]; }
            if (part.startsWith('@')) { const v = nodes.map((n) => n.attrs[part.slice(1)]).find((x) => x !== undefined); return v; }
            const pm = /^([\\w:.*-]+)(?:\\[(\\d+)\\])?$/.exec(part);
            if (!pm) throw new Error(\`Unsupported XML path part "\${part}" in \${path}\`);
            const pick = (list: El[]) => list.filter((c) => pm[1] === '*' || c.name === pm[1] || c.name.endsWith(\`:\${pm[1]}\`));
            nodes = nodes.flatMap((n) => { const found = pick(deep ? descendants(n) : n.children); return pm[2] ? (found[Number(pm[2]) - 1] ? [found[Number(pm[2]) - 1]] : []) : found; });
        }
        return nodes.length ? all(nodes[0]).trim() : undefined;
    }
}
`;
}

/** The generic steps (the helper's checks, saved values), importing from the framework package `pkg`. */
export function checkStepsText(pkg: string): string {
    const step = (pattern: string, args: string, body: string) => `    @CSBDDStepDef('${pattern}')\n    async ${args} {\n        ${body}\n    }\n`;
    const cmp = (name: string, op: string) => step(`the response value {string} should ${name} {string}`, `${op}(ref: string, expected: string): Promise<void>`, `this.checks.check(ref, '${op}', expected);`);
    return `/**
 * Steps for API responses (written by CS Test Studio; the project's own code to read and change). They
 * use ${HELPER_CLASS} (helpers/${HELPER_FILE}); a value reference is $.path, xml:/path, header:Name,
 * cookie:name, status, time, size or body.
 */
import { CSBDDStepDef, StepDefinitions } from '${pkg}/bdd';
import { CSApiContextManager } from '${pkg}/api';
import { CSReporter } from '${pkg}/reporting';
import { ${HELPER_CLASS} } from '../helpers/${HELPER_FILE.replace(/\.ts$/, '')}';

@StepDefinitions
export class ApiResponseCheckSteps {
    private checks = ${HELPER_CLASS}.getInstance();

${[
        cmp('be', 'equals'),
        cmp('not be', 'notEquals'),
        cmp('contain', 'contains'),
        cmp('not contain', 'notContains'),
        cmp('match', 'matches'),
        cmp('be of type', 'type'),
        cmp('be greater than', 'greater'),
        cmp('be less than', 'less'),
        cmp('be at least', 'atLeast'),
        cmp('be at most', 'atMost'),
        cmp('be one of', 'oneOf'),
        step('the response value {string} should have {string} items', 'count(ref: string, expected: string): Promise<void>', "this.checks.check(ref, 'count', expected);"),
        step('the response value {string} should exist', 'exists(ref: string): Promise<void>', "this.checks.check(ref, 'exists');"),
        step('the response value {string} should not exist', 'notExists(ref: string): Promise<void>', "this.checks.check(ref, 'notExists');"),
        step('the response value {string} should be empty', 'empty(ref: string): Promise<void>', "this.checks.check(ref, 'empty');"),
        step('the response value {string} should not be empty', 'notEmpty(ref: string): Promise<void>', "this.checks.check(ref, 'notEmpty');"),
        step('the response value {string} should be between {string} and {string}', 'between(ref: string, from: string, to: string): Promise<void>', "this.checks.check(ref, 'between', from, { to });"),
        step('the response value {string} should be {string} ignoring case', 'equalsIgnoringCase(ref: string, expected: string): Promise<void>', "this.checks.check(ref, 'equals', expected, { ignoreCase: true });"),
        step('the response value {string} should be the number {string} within {string}', 'equalsNumber(ref: string, expected: string, tolerance: string): Promise<void>', "this.checks.check(ref, 'equals', expected, { compare: 'number', tolerance: Number(tolerance) });"),
        step('the response value {string} should be the date {string}', 'equalsDate(ref: string, expected: string): Promise<void>', "this.checks.check(ref, 'equals', expected, { compare: 'date' });"),
        step('the response value {string} should be the moment {string}', 'equalsMoment(ref: string, expected: string): Promise<void>', "this.checks.check(ref, 'equals', expected, { compare: 'datetime' });"),
        step('the response value {string} should be the {string} of query {string} on {string}', 'equalsQuery(ref: string, column: string, query: string, connection: string): Promise<void>', 'await this.checks.checkQuery(ref, column, connection, query, []);'),
        step('the response value {string} should be the {string} of query {string} on {string} with parameters {string}', 'equalsQueryWith(ref: string, column: string, query: string, connection: string, params: string): Promise<void>', "await this.checks.checkQuery(ref, column, connection, query, params.split('|').map((p) => p.trim()));"),
        step('user saves the response value {string} as {string}', `save(ref: string, name: string): Promise<void>`, `const value = this.checks.value(ref);
        if (value === undefined) throw new Error(\`\${ref}: nothing to save as \${name}\`);
        CSApiContextManager.getInstance().getCurrentContext().setVariable(name, value);
        CSReporter.pass(\`\${name} = \${JSON.stringify(value)} (\${ref})\`);`),
        step('user saves the match of {string} in the response as {string}', `saveMatch(pattern: string, name: string): Promise<void>`, `const m = new RegExp(pattern).exec(this.checks.text());
        if (!m) throw new Error(\`/\${pattern}/ is not in the response: nothing to save as \${name}\`);
        const value = m[1] !== undefined ? m[1] : m[0];
        CSApiContextManager.getInstance().getCurrentContext().setVariable(name, value);
        CSReporter.pass(\`\${name} = \${JSON.stringify(value)} (/\${pattern}/)\`);`),
    ].join('\n')}}
`;
}
