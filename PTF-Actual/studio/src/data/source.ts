/**
 * Test data for API runs and load tests, from every source the framework reads (CSDataProvider):
 * CSV, Excel, JSON (JSONPath), XML, generated rows; and from the project's databases: a query (with
 * ? parameters) or a stored procedure / function, run through the project's own connection settings;
 * and from an API: a saved request whose response holds the rows. Each row's columns are used as
 * {{column}} in the requests. Files, filters, `<random>` / `<config:KEY>` placeholders and ENCRYPTED:
 * values are handled by the framework installed in the repository, as in a test run.
 */
import type { DbType } from '../db/connections';

export type DataKind = 'file' | 'query' | 'procedure' | 'api' | 'generate';

export interface DataSource {
    kind: DataKind;
    /** file: a .csv, .xlsx/.xls, .json or .xml (project-relative; {env} allowed, as in the framework). */
    file?: string;
    /** Excel sheet. */
    sheet?: string;
    /** JSON: JSONPath to the rows ($.data.users[*]); api: path to the rows in the response. */
    path?: string;
    /** XML: XPath to the row elements. */
    xpath?: string;
    /** CSV delimiter (default ,). */
    delimiter?: string;
    /** query / procedure: connection alias (DB_<ALIAS>_*). */
    connection?: string;
    /** query: SQL (or a saved query's text); ? parameters. */
    sql?: string;
    /** procedure: name (schema.name). */
    procedure?: string;
    /** query / procedure: parameter values ({config:…}, {env:…} allowed). */
    params?: string[];
    /** api: collection file and request id. */
    collection?: string;
    request?: string;
    /** generate: rows:template, e.g. 50:id=number,email=email,name=name */
    generate?: string;
    /** Framework filter: status=active;amount>100 (AND with ; or &, OR with |), operators = != > < >= <= ~ (contains). */
    filter?: string;
    /** Rows to keep (after the filter). */
    limit?: number;
    /** Shuffle the rows before the limit. */
    randomize?: boolean;
}

export interface DataRows { columns: string[]; rows: Array<Record<string, string>>; total: number }

const FILE = /\.(csv|xlsx|xls|json|xml)$/i;
const SAFE_PATH = (f: string) => !f.includes('..') && !/^([a-z]:)?[\\/]/i.test(f) && f.length <= 300;

export function validSource(x: unknown): DataSource {
    const s = x as DataSource;
    const fail = (m: string): never => { throw new Error(`Test data: ${m}.`); };
    if (!s || typeof s !== 'object') fail('no source');
    if (!['file', 'query', 'procedure', 'api', 'generate'].includes(s.kind)) fail('unknown kind of source');
    const text = (v: unknown, name: string, max = 300) => { if (v !== undefined && (typeof v !== 'string' || v.length > max)) fail(name); };
    for (const [k, max] of [['sheet', 100], ['path', 300], ['xpath', 300], ['delimiter', 3], ['filter', 1000], ['connection', 64], ['procedure', 256], ['request', 80], ['generate', 1000]] as const) text(s[k], k, max);
    text(s.sql, 'query', 100_000);
    if (s.params !== undefined && (!Array.isArray(s.params) || s.params.length > 100 || s.params.some((p) => typeof p !== 'string' || p.length > 4000))) fail('parameters');
    if (s.limit !== undefined && !(Number.isInteger(s.limit) && s.limit >= 1 && s.limit <= 1_000_000)) fail('limit (1 to 1 000 000)');
    if (s.randomize !== undefined && typeof s.randomize !== 'boolean') fail('randomize');
    switch (s.kind) {
        case 'file':
            if (typeof s.file !== 'string' || !FILE.test(s.file) || !SAFE_PATH(s.file)) fail('a .csv, .xlsx, .xls, .json or .xml file in the project');
            break;
        case 'query':
            if (!s.connection || !/^[A-Za-z0-9_]+$/.test(s.connection)) fail('connection');
            if (!s.sql?.trim()) fail('the query');
            break;
        case 'procedure':
            if (!s.connection || !/^[A-Za-z0-9_]+$/.test(s.connection)) fail('connection');
            if (!s.procedure || !/^[\w$#]+(\.[\w$#]+){0,2}$/.test(s.procedure)) fail('procedure name (schema.name)');
            break;
        case 'api':
            if (typeof s.collection !== 'string' || !/^test\/[A-Za-z0-9][\w.-]*\/api\/[\w.-]+\.collection\.json$/.test(s.collection)) fail('collection');
            if (!s.request) fail('request');
            break;
        case 'generate':
            if (!s.generate || !/^\d{1,6}(:[\w]+(=[\w]+)?(,[\w]+(=[\w]+)?)*)?$/.test(s.generate.replace(/\s+/g, ''))) fail('generate: rows:column=type,… (e.g. 50:id=number,email=email)');
            if (Number((s.generate ?? '').split(':')[0]) > 100_000) fail('at most 100 000 generated rows');
            break;
    }
    return s;
}

/** A short description (lists, reports). */
export function describeSource(s: DataSource): string {
    const extra = [s.filter ? `where ${s.filter}` : '', s.randomize ? 'shuffled' : '', s.limit ? `first ${s.limit}` : ''].filter(Boolean).join(', ');
    const what = s.kind === 'file' ? `${s.file}${s.sheet ? ` [${s.sheet}]` : ''}${s.path ? ` ${s.path}` : ''}${s.xpath ? ` ${s.xpath}` : ''}`
        : s.kind === 'query' ? `${s.connection}: ${(s.sql ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)}`
            : s.kind === 'procedure' ? `${s.connection}: ${s.procedure}(${(s.params ?? []).join(', ')})`
                : s.kind === 'api' ? `${s.collection} › ${s.request}${s.path ? ` ${s.path}` : ''}` : `generated ${s.generate}`;
    return extra ? `${what} (${extra})` : what;
}

/**
 * The statement that calls a procedure with n parameters, as the framework's executeStoredProcedure
 * builds it (EXEC on SQL Server, CALL on MySQL/MariaDB); on PostgreSQL a function's rows are read with
 * SELECT * FROM name(…) and a procedure is CALLed; on Oracle, a function returning rows (pipelined or
 * a table type) is read with SELECT * FROM TABLE(name(…)).
 */
export function procedureCall(type: DbType | string, name: string, n: number, routine: 'function' | 'procedure' = 'function'): string {
    const q = Array.from({ length: n }, () => '?').join(', ');
    switch (type) {
        case 'sqlserver': return n ? `EXEC ${name} ${q}` : `EXEC ${name}`;
        case 'mysql': return `CALL ${name}(${q})`;
        case 'postgresql': return routine === 'procedure' ? `CALL ${name}(${q})` : `SELECT * FROM ${name}(${q})`;
        case 'oracle': return `SELECT * FROM TABLE(${name}(${q}))`;
        // Redis 7 functions (FUNCTION LOAD): FCALL name 0 arg1 arg2 (the framework fills $1, $2).
        case 'redis': return `FCALL ${name} 0${Array.from({ length: n }, (_x, i) => ` $${i + 1}`).join('')}`;
        // MongoDB has no stored procedures: its server-side logic is an aggregation pipeline, which a query source runs.
        case 'mongodb': throw new Error('MongoDB has no stored procedures: use a query source with the aggregation (db.<collection>.aggregate([...])).');
        default: throw new Error(`Stored procedures are not available for ${type}.`);
    }
}

/** A value as text for {{column}}: dates as ISO times, binary as hex, objects as JSON, null as empty. */
export function asText(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return v.toString('hex');
    if (v instanceof Uint8Array) return Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('');
    try { return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)); } catch { return String(v); }
}

/** Rows of any shape as text rows; columns in first-seen order. Arrays of scalars become { value }. */
export function textRows(rows: unknown[]): DataRows {
    const columns: string[] = [];
    const seen = new Set<string>();
    const out = rows.map((r) => {
        const obj = r !== null && typeof r === 'object' && !Array.isArray(r) ? r as Record<string, unknown> : { value: r };
        const t: Record<string, string> = {};
        for (const [k, v] of Object.entries(obj)) { if (!seen.has(k)) { seen.add(k); columns.push(k); } t[k] = asText(v); }
        return t;
    });
    return { columns, rows: out, total: out.length };
}
