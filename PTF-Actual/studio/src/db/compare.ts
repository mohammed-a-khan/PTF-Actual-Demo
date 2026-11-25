/**
 * Comparing data (mirror of the framework's database/compare/CSDataCompare.ts: keep the two in step, so the Studio
 * compares as the framework's step does). Below the mirror: the Studio's cells (see worker.ts) as values.
 */

export type Row = Record<string, unknown>;

export interface CompareOptions {
    /** Key columns (source names): rows are matched by them. None: rows are matched in order. */
    keys?: string[];
    /** Only these columns (source names); default: every column both have, except the keys. */
    columns?: string[];
    /**
     * Columns left out: names or patterns, case not minded: `loaded_at`, `*_at`, `audit_*`, `created_?y`; a table's own
     * with its name: `orders.notes`, `orders.*_flag` (see ignoreRule).
     */
    ignore?: string[];
    /** The table compared (for the ignore patterns that name a table). */
    table?: string;
    /** Dates and times compared to the second, minute or day (load times, time zones); default exact. */
    dates?: DatePrecision;
    /** Source column → target column, where the names differ. */
    map?: Record<string, string>;
    /** Numbers equal within this difference (default 0). */
    tolerance?: number;
    /** Text compared without case (default false). */
    ignoreCase?: boolean;
    /** Text compared without leading and trailing spaces (default true: CHAR columns are padded). */
    trim?: boolean;
    /** The most differences kept in the result (default 100). */
    maxDifferences?: number;
}

export type DatePrecision = 'exact' | 'second' | 'minute' | 'day';
export const DATE_PRECISIONS: DatePrecision[] = ['exact', 'second', 'minute', 'day'];

/**
 * Whether a column is left out: by name or pattern (* any characters, ? one), case not minded. A pattern with a dot
 * applies to a table only (orders.notes, orders.*_at, *.row_version); the table is matched by its name, with or
 * without its schema.
 */
export function ignoreRule(patterns: string[] = [], table?: string): (column: string) => boolean {
    const re = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
    const t = (table ?? '').toLowerCase(), tShort = t.split('.').pop() ?? '';
    const rules = patterns.map((x) => x.trim()).filter(Boolean).map((x) => {
        const dot = x.lastIndexOf('.');
        if (dot <= 0) return { col: re(x) };
        return { table: re(x.slice(0, dot)), col: re(x.slice(dot + 1)) };
    });
    return (column: string) => rules.some((r) => r.col.test(column) && (!r.table || (!!t && (r.table.test(t) || r.table.test(tShort)))));
}

export interface CellDifference { key: string; column: string; source: unknown; target: unknown }

export interface CompareResult {
    passed: boolean;
    sourceRows: number;
    targetRows: number;
    matched: number;
    /** Keys of source rows the target does not have. */
    missingInTarget: string[];
    /** Keys of target rows the source does not have. */
    extraInTarget: string[];
    /** Values that differ (matched rows). */
    differences: CellDifference[];
    /** Rows (keys) with at least one difference. */
    rowsDiffering: number;
    /** Keys that appear more than once (a key that is not unique cannot match rows). */
    duplicateKeys: { source: string[]; target: string[] };
    columnsCompared: string[];
    /** Columns only one side has (not compared). */
    onlyInSource: string[];
    onlyInTarget: string[];
    /** More differences than kept. */
    truncated: boolean;
}

/** A value as data (see the top of the file). */
export function normalise(v: unknown, o: Pick<CompareOptions, 'trim' | 'ignoreCase' | 'dates'> = {}): string | number | null {
    if (v === null || v === undefined) return null;
    // An instant to the precision asked for (2024-01-02T03:04:05.123Z → 2024-01-02 at "day").
    // "second" rounds to the nearest second (SQL Server keeps datetime to 1/300 s: 05.997 is 06).
    const at = (iso: string) => (o.dates === 'day' ? iso.slice(0, 10) : o.dates === 'minute' ? iso.slice(0, 16)
        : o.dates === 'second' ? new Date(Math.round(Date.parse(iso) / 1000) * 1000).toISOString().slice(0, 19) : iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
    if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v instanceof Date) {
        if (Number.isNaN(v.getTime())) return null;
        // "day": a DATE column comes from the driver as local midnight; its day is the local one (else the UTC day).
        if (o.dates === 'day' && v.getHours() === 0 && v.getMinutes() === 0 && v.getSeconds() === 0 && v.getMilliseconds() === 0) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
        return at(v.toISOString());
    }
    if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`;
    if (typeof v === 'object') {
        // A decimal type of a driver (Decimal.js, Big…): its text.
        const t = String(v);
        return t === '[object Object]' ? JSON.stringify(v) : normalise(t, o);
    }
    let t = String(v);
    if (o.trim !== false) t = t.trim();
    // A number written as text (not a code with a leading zero: 01234 stays text).
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t) && !/^[-+]?0\d/.test(t)) { const n = Number(t); if (Number.isFinite(n)) return n; }
    // ISO date-times: the same instant written another way (2024-01-02T03:04:05Z, 2024-01-02 03:04:05.000).
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(t)) {
        // "day": the day as written (2024-01-02T01:00+05:00 is on the 2nd where it was written).
        if (o.dates === 'day') return t.slice(0, 10);
        const d = new Date(/[Zz]|[+-]\d{2}:?\d{2}$/.test(t) ? t.replace(' ', 'T') : `${t.replace(' ', 'T')}Z`);
        if (!Number.isNaN(d.getTime())) return at(d.toISOString());
    }
    // A date alone (2024-01-02) at "day" precision is the same as a time on that day.
    if (o.dates === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    return o.ignoreCase ? t.toLowerCase() : t;
}

const same = (a: string | number | null, b: string | number | null, tolerance: number) =>
    a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tolerance + Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)));

/** A row's columns by lower-case name (the name as the row has it). */
const columnsOf = (rows: Row[]) => {
    const m = new Map<string, string>();
    for (const r of rows.slice(0, 50)) for (const k of Object.keys(r)) if (!m.has(k.toLowerCase())) m.set(k.toLowerCase(), k);
    return m;
};
/** A value as the message shows it: text in quotes (its spaces visible), numbers and dates as they are. */
const show = (v: unknown) => (v === null || v === undefined ? 'null' : v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? `0x${v.toString('hex').slice(0, 40)}`
    : typeof v === 'string' && typeof normalise(v, { trim: false }) !== 'number' ? JSON.stringify(v.length > 200 ? `${v.slice(0, 200)}…` : v) : String(v));
export const showValue = show;

/** How two results are matched: their columns, the key of a row, a value as data (shared by compareRows and alignRows). */
function layout(source: Row[], target: Row[], opts: CompareOptions) {
    const o = { trim: true, ignoreCase: false, tolerance: 0, maxDifferences: 100, ...opts };
    const sCols = columnsOf(source), tCols = columnsOf(target);
    const mapLower = new Map(Object.entries(o.map ?? {}).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]));
    const targetOf = (s: string) => mapLower.get(s) ?? s;
    const keys = (o.keys ?? []).map((k) => k.toLowerCase());
    for (const k of keys) {
        if (source.length && !sCols.has(k)) throw new Error(`The source has no key column "${k}" (it has ${[...sCols.values()].join(', ')}).`);
        if (target.length && !tCols.has(targetOf(k))) throw new Error(`The target has no key column "${targetOf(k)}" (it has ${[...tCols.values()].join(', ')}).`);
    }
    const ignored = ignoreRule(o.ignore, o.table);
    const ignore = { has: (c: string) => ignored(c) };
    const wanted = o.columns?.map((c) => c.toLowerCase());
    const both = [...sCols.keys()].filter((c) => tCols.has(targetOf(c)));
    const columns = (wanted ?? both).filter((c) => !keys.includes(c) && !ignore.has(c));
    if (wanted) for (const c of wanted) if (!both.includes(c) && (source.length || target.length)) throw new Error(`The column "${c}" is not in both results.`);
    const mappedTargets = new Set([...sCols.keys()].map(targetOf));
    const onlyInSource = [...sCols.keys()].filter((c) => !tCols.has(targetOf(c)) && !ignore.has(c)).map((c) => sCols.get(c)!);
    const onlyInTarget = [...tCols.keys()].filter((c) => !mappedTargets.has(c) && !ignore.has(c)).map((c) => tCols.get(c)!);

    const val = (row: Row, cols: Map<string, string>, lower: string) => normalise(row[cols.get(lower) ?? lower], o);
    const keyOf = (row: Row, cols: Map<string, string>, side: 's' | 't', i: number) =>
        keys.length ? keys.map((k) => { const v = val(row, cols, side === 's' ? k : targetOf(k)); return `${sCols.get(k) ?? k}=${v === null ? 'null' : v}`; }).join(', ') : `row ${i + 1}`;
    const index = (rows: Row[], cols: Map<string, string>, side: 's' | 't') => {
        const m = new Map<string, Row>(); const dup = new Set<string>();
        rows.forEach((r, i) => { const k = keyOf(r, cols, side, i); if (m.has(k)) dup.add(k); else m.set(k, r); });
        return { m, dup: [...dup] };
    };
    return { o, sCols, tCols, targetOf, columns, onlyInSource, onlyInTarget, val, index };
}

/** Compare the rows of a source and a target (see CompareOptions). */
export function compareRows(source: Row[], target: Row[], opts: CompareOptions = {}): CompareResult {
    const { o, sCols, tCols, targetOf, columns, onlyInSource, onlyInTarget, val, index } = layout(source, target, opts);
    const s = index(source, sCols, 's'), t = index(target, tCols, 't');
    const missingInTarget = [...s.m.keys()].filter((k) => !t.m.has(k));
    const extraInTarget = [...t.m.keys()].filter((k) => !s.m.has(k));
    const differences: CellDifference[] = [];
    let matched = 0, rowsDiffering = 0, truncated = false;
    for (const [k, sr] of s.m) {
        const tr = t.m.get(k);
        if (!tr) continue;
        matched++;
        let differs = false;
        for (const c of columns) {
            const a = val(sr, sCols, c), b = val(tr, tCols, targetOf(c));
            if (same(a, b, o.tolerance)) continue;
            differs = true;
            if (differences.length < o.maxDifferences) differences.push({ key: k, column: sCols.get(c) ?? c, source: show(sr[sCols.get(c) ?? c]), target: show(tr[tCols.get(targetOf(c)) ?? targetOf(c)]) });
            else truncated = true;
        }
        if (differs) rowsDiffering++;
    }
    const passed = !missingInTarget.length && !extraInTarget.length && !rowsDiffering && !s.dup.length && !t.dup.length;
    return {
        passed, sourceRows: source.length, targetRows: target.length, matched, missingInTarget, extraInTarget, differences, rowsDiffering,
        duplicateKeys: { source: s.dup, target: t.dup }, columnsCompared: columns.map((c) => sCols.get(c) ?? c), onlyInSource, onlyInTarget, truncated,
    };
}

export interface AlignedRow {
    /** The row's key (order_id=4), or its position without keys. */
    key: string;
    status: 'differs' | 'missing' | 'extra' | 'same';
    source?: Row;
    target?: Row;
    /** The columns (source names) whose values differ. */
    differing: string[];
}

/**
 * The rows of a source and a target side by side (matched as compareRows matches them): the ones that differ, are
 * missing in the target or only in the target, first (at most limit); with same: true, the matching ones after them.
 */
export function alignRows(source: Row[], target: Row[], opts: CompareOptions & { limit?: number; same?: boolean } = {}): { rows: AlignedRow[]; truncated: boolean; columns: string[]; targetColumn: Record<string, string> } {
    const { o, sCols, tCols, targetOf, columns, val, index } = layout(source, target, opts);
    const s = index(source, sCols, 's'), t = index(target, tCols, 't');
    const limit = Math.max(1, opts.limit ?? 500);
    const out: AlignedRow[] = [], alike: AlignedRow[] = [];
    let truncated = false;
    const push = (r: AlignedRow) => { if (out.length < limit) out.push(r); else truncated = true; };
    for (const [k, sr] of s.m) {
        const tr = t.m.get(k);
        if (!tr) { push({ key: k, status: 'missing', source: sr, differing: [] }); continue; }
        const differing = columns.filter((c) => !same(val(sr, sCols, c), val(tr, tCols, targetOf(c)), o.tolerance)).map((c) => sCols.get(c) ?? c);
        if (differing.length) push({ key: k, status: 'differs', source: sr, target: tr, differing });
        else if (opts.same && alike.length < limit) alike.push({ key: k, status: 'same', source: sr, target: tr, differing: [] });
    }
    for (const [k, tr] of t.m) if (!s.m.has(k)) push({ key: k, status: 'extra', target: tr, differing: [] });
    const rows = [...out, ...alike.slice(0, Math.max(0, limit - out.length))];
    return { rows, truncated, columns: columns.map((c) => sCols.get(c) ?? c), targetColumn: Object.fromEntries(columns.map((c) => [sCols.get(c) ?? c, tCols.get(targetOf(c)) ?? targetOf(c)])) };
}

/** The result in a few lines (the step's message and the report). */
export function describeComparison(r: CompareResult, limit = 10): string {
    const lines = [`Source ${r.sourceRows} rows, target ${r.targetRows} rows: ${r.matched} matched${r.rowsDiffering ? `, ${r.rowsDiffering} with different values` : ''}${r.missingInTarget.length ? `, ${r.missingInTarget.length} missing in the target` : ''}${r.extraInTarget.length ? `, ${r.extraInTarget.length} only in the target` : ''}.`];
    if (r.duplicateKeys.source.length || r.duplicateKeys.target.length) lines.push(`Keys that are not unique: ${[...r.duplicateKeys.source.map((k) => `${k} (source)`), ...r.duplicateKeys.target.map((k) => `${k} (target)`)].slice(0, limit).join('; ')}`);
    if (r.missingInTarget.length) lines.push(`Missing in the target: ${r.missingInTarget.slice(0, limit).join('; ')}${r.missingInTarget.length > limit ? ' …' : ''}`);
    if (r.extraInTarget.length) lines.push(`Only in the target: ${r.extraInTarget.slice(0, limit).join('; ')}${r.extraInTarget.length > limit ? ' …' : ''}`);
    for (const d of r.differences.slice(0, limit)) lines.push(`${d.key}: ${d.column} is ${d.source} in the source, ${d.target} in the target`);
    if (r.differences.length > limit || r.truncated) lines.push('… more differences');
    if (r.onlyInSource.length || r.onlyInTarget.length) lines.push(`Not compared (in one only): ${[...r.onlyInSource.map((c) => `${c} (source)`), ...r.onlyInTarget.map((c) => `${c} (target)`)].join(', ')}`);
    return lines.join('\n');
}

export type VitalCheck = 'count' | 'nulls' | 'distinct' | 'sum' | 'min' | 'max';
export const VITAL_CHECKS: VitalCheck[] = ['count', 'nulls', 'distinct', 'sum', 'min', 'max'];
export interface ColumnVitals { nulls: number; distinct: number; sum?: number; min?: string | number; max?: string | number }
export interface Vitals { count: number; columns: Record<string, ColumnVitals> }

/** The vital checks of rows: their count; per column the empty values, distinct values, and sum, min, max. */
export function vitalsOf(rows: Row[], o: Pick<CompareOptions, 'trim' | 'ignoreCase' | 'dates'> = {}): Vitals {
    const cols = columnsOf(rows);
    const out: Vitals = { count: rows.length, columns: {} };
    for (const [lower, name] of cols) {
        const vals = rows.map((r) => normalise(r[name], o));
        const present = vals.filter((v): v is string | number => v !== null);
        const numbers = present.every((v) => typeof v === 'number') && present.length > 0;
        const v: ColumnVitals = { nulls: vals.length - present.length, distinct: new Set(present.map((x) => `${typeof x}:${x}`)).size };
        if (numbers) { const n = present as number[]; v.sum = n.reduce((a, b) => a + b, 0); v.min = Math.min(...n); v.max = Math.max(...n); }
        else if (present.length) { const t = present.map(String).sort(); v.min = t[0]; v.max = t[t.length - 1]; }
        out.columns[lower] = v;
    }
    return out;
}

export interface VitalDifference { check: VitalCheck; column?: string; source: unknown; target: unknown }

/** The vital checks of a source and a target compared: what differs. */
export function compareVitals(source: Row[], target: Row[], opts: CompareOptions & { checks?: VitalCheck[] } = {}): { passed: boolean; differences: VitalDifference[]; source: Vitals; target: Vitals } {
    const o = { tolerance: 0, ...opts };
    const checks = new Set(o.checks ?? VITAL_CHECKS);
    const s = vitalsOf(source, o), t = vitalsOf(target, o);
    const differences: VitalDifference[] = [];
    if (checks.has('count') && s.count !== t.count) differences.push({ check: 'count', source: s.count, target: t.count });
    const mapLower = new Map(Object.entries(o.map ?? {}).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]));
    const ignored = ignoreRule(o.ignore, o.table);
    const ignore = { has: (c: string) => ignored(c) };
    const wanted = o.columns?.map((c) => c.toLowerCase());
    for (const c of Object.keys(s.columns)) {
        if (ignore.has(c) || (wanted && !wanted.includes(c))) continue;
        const tv = t.columns[mapLower.get(c) ?? c];
        if (!tv) continue;
        const sv = s.columns[c];
        for (const k of ['nulls', 'distinct', 'sum', 'min', 'max'] as const) {
            if (!checks.has(k)) continue;
            const a = sv[k] ?? null, b = tv[k] ?? null;
            if (!same(a as never, b as never, o.tolerance)) differences.push({ check: k, column: c, source: a, target: b });
        }
    }
    return { passed: !differences.length, differences, source: s, target: t };
}

/** Options from a step's table (| option | value |): keys, columns, ignore, map, tolerance, ignore case, trim, checks. */
export function compareOptionsFrom(rows: string[][]): CompareOptions & { checks?: VitalCheck[] } {
    const o: CompareOptions & { checks?: VitalCheck[] } = {};
    const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
    const yes = (v: string) => /^(true|yes|y|1|on)$/i.test(v.trim());
    for (const r of rows) {
        const [k, v = ''] = r.map((x) => String(x ?? '').trim());
        const key = k.toLowerCase().replace(/[\s_-]+/g, '');
        if (!key || key === 'option') continue;
        if (key === 'key' || key === 'keys') o.keys = list(v);
        else if (key === 'columns' || key === 'column') o.columns = list(v);
        else if (key === 'ignore' || key === 'ignorecolumns') o.ignore = list(v);
        else if (key === 'map' || key === 'columnmap') o.map = Object.fromEntries(list(v).map((p) => p.split(/\s*(?:=|->|→)\s*/)).filter((p) => p.length === 2 && p[0] && p[1]) as Array<[string, string]>);
        else if (key === 'tolerance') { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`tolerance: a number, not "${v}"`); o.tolerance = n; }
        else if (key === 'ignorecase') o.ignoreCase = yes(v);
        else if (key === 'dates' || key === 'dateprecision') { const d = v.toLowerCase(); if (!DATE_PRECISIONS.includes(d as DatePrecision)) throw new Error(`dates: ${DATE_PRECISIONS.join(', ')}, not "${v}"`); o.dates = d as DatePrecision; }
        else if (key === 'trim') o.trim = yes(v);
        else if (key === 'checks') { const c = list(v).map((x) => x.toLowerCase()); const bad = c.filter((x) => !VITAL_CHECKS.includes(x as VitalCheck)); if (bad.length) throw new Error(`checks: ${bad.join(', ')} (use ${VITAL_CHECKS.join(', ')})`); o.checks = c as VitalCheck[]; }
        else throw new Error(`Unknown option "${k}" (use keys, columns, ignore, map, tolerance, ignore case, trim, dates, checks).`);
    }
    return o;
}

/** A cell of the Studio's database worker (dates, big numbers, JSON, binary as {$t, v}) as a value to compare. */
export function cellValue(c: unknown): unknown {
    if (c && typeof c === 'object' && '$t' in (c as Record<string, unknown>)) {
        const x = c as { $t: string; v: string };
        return x.$t === 'bin' ? `0x${x.v}` : x.v;
    }
    return c;
}
