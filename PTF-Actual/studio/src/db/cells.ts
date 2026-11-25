/**
 * Query results as they go to the browser: every value becomes plain JSON (dates, binary data, big
 * integers, JSON documents and very long texts are tagged), column types get readable names, and the
 * values a framework step would compare are worked out here (see expectedText).
 */

import type { Cell, Column } from './cellTypes';
export type { Cell, Column } from './cellTypes';

const MAX_TEXT = 32 * 1024;

export function toCell(v: unknown): Cell {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return { $t: 'big', v: v.toString() };
    if (typeof v === 'string') return v.length > MAX_TEXT ? { $t: 'text', v: v.slice(0, MAX_TEXT), n: v.length } : v;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid Date' : { $t: 'date', v: v.toISOString() };
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) { const b = Buffer.from(v as Uint8Array); return { $t: 'bin', v: b.subarray(0, 64).toString('hex'), n: b.length }; }
    try {
        const s = JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
        return { $t: 'json', v: s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s };
    } catch { return String(v); }
}

/** PostgreSQL type ids (pg_type.oid) of the common types. */
const PG_TYPES: Record<number, string> = {
    16: 'boolean', 17: 'bytea', 18: 'char', 19: 'name', 20: 'bigint', 21: 'smallint', 23: 'integer', 25: 'text', 26: 'oid', 114: 'json', 142: 'xml',
    700: 'real', 701: 'double precision', 790: 'money', 1042: 'char', 1043: 'varchar', 1082: 'date', 1083: 'time', 1114: 'timestamp', 1184: 'timestamptz',
    1186: 'interval', 1266: 'timetz', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb', 1000: 'boolean[]', 1005: 'smallint[]', 1007: 'integer[]', 1009: 'text[]', 1016: 'bigint[]', 1015: 'varchar[]',
};

/** Column names and types from a framework QueryResult (each adapter describes fields its own way). */
export function columnsOf(result: { fields?: Array<Record<string, unknown>>; rows?: Array<Record<string, unknown>> }): Column[] {
    const fields = Array.isArray(result.fields) ? result.fields : [];
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const names = fields.length ? fields.map((f) => String(f.name ?? '')) : rows.length ? Object.keys(rows[0]) : [];
    return names.map((name, i) => {
        const f = fields[i] ?? {};
        const t = f.dataType ?? f.type ?? f.dbType;
        let type = typeof t === 'number' ? PG_TYPES[t] ?? `type ${t}` : typeof t === 'string' ? t.toLowerCase() : '';
        if (!type || type === 'string') {
            const v = rows.find((r) => r[name] !== null && r[name] !== undefined)?.[name];
            type = v === undefined ? (type || '') : v instanceof Date ? 'date' : Buffer.isBuffer(v) ? 'binary' : typeof v === 'object' ? 'json' : typeof v;
        }
        return { name, type };
    });
}

/**
 * The text a framework step needs to expect this value ("the value in row 1 column "x" should be "…"),
 * following how the steps compare (DataValidationSteps.valuesEqual / convertExpectedValue):
 * null ↔ "null", numbers within 0.001, "YYYY-MM-DD…" read as a date, otherwise text.
 * null when no step text can express it exactly (binary, JSON, cut texts, text that would be read as a
 * date or a number but is not one).
 */
export function expectedText(c: Cell): string | null {
    if (c === null) return 'null';
    if (typeof c === 'number') return String(c);
    if (typeof c === 'boolean') return String(c);
    if (typeof c === 'string') {
        if (/^\d{4}-\d{2}-\d{2}/.test(c)) return Number.isNaN(Date.parse(c)) ? null : c; // compared as a date
        if (/^(null|true|false|'')$/i.test(c)) return null;                                // turned into null / a boolean / ''
        if (c === '') return null;                                                         // an empty step value would not match
        if (/[\r\n]/.test(c)) return null;                                                 // a step value is one line
        return c;                                                                          // numeric text ("10.50") compares as a number: fine
    }
    if (c.$t === 'date') return c.v;
    if (c.$t === 'big') return c.v;
    return null;
}

/** A cell as text for exports (CSV / Excel) and copying. */
export function cellText(c: Cell): string {
    if (c === null) return '';
    if (typeof c !== 'object') return String(c);
    if (c.$t === 'bin') return `0x${c.v}${c.n > 64 ? '…' : ''}`;
    return c.v;
}
