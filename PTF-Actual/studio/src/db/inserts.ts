/**
 * INSERT statements from a query result, in the database's own literal syntax: text quoted (N'…' on
 * SQL Server), numbers bare, NULL, booleans (1/0 or TRUE/FALSE), dates as ISO literals, JSON as text,
 * binary as hex. Values the result does not hold whole (binary over 64 bytes, text cut at 32 KB) are
 * written as NULL and listed in the warnings.
 */
import type { DbType } from './connections';
import type { Cell, Column } from './cellTypes';
import { quoteName } from './ddl';

export interface InsertOptions {
    /** Table name as typed (schema.table or table); each part quoted for the database. */
    table: string;
    /** Columns to include (all when empty). */
    columns?: string[];
    /** Rows per INSERT (1 = one statement per row; SQL Server allows at most 1000). */
    rowsPerStatement?: number;
    /** SQL Server: wrap with SET IDENTITY_INSERT ON/OFF (explicit values for an identity column). */
    identityInsert?: boolean;
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** A cell as a SQL literal; null when the result does not hold the whole value. */
export function literal(type: DbType | string, c: Cell, column?: Column): string | null {
    if (c === null) return 'NULL';
    if (typeof c === 'number') return Number.isFinite(c) ? String(c) : 'NULL';
    if (typeof c === 'boolean') return type === 'postgresql' ? (c ? 'TRUE' : 'FALSE') : c ? '1' : '0';
    if (typeof c === 'string') {
        // Numeric text from DECIMAL / NUMERIC columns stays a number.
        if (column && /^(numeric|decimal|newdecimal|money|number)/i.test(column.type) && /^-?\d+(\.\d+)?$/.test(c)) return c;
        return type === 'sqlserver' && /[^\x00-\x7f]/.test(c) ? `N${quote(c)}` : quote(c);
    }
    switch (c.$t) {
        case 'big': return c.v;
        case 'date': {
            const iso = c.v; // 2026-11-01T10:20:30.123Z
            if (type === 'mysql') return quote(iso.replace('T', ' ').replace(/Z$/, ''));
            if (type === 'sqlserver') return quote(iso.replace(/Z$/, ''));
            if (type === 'oracle') return `TIMESTAMP ${quote(iso.replace('T', ' ').replace(/Z$/, ''))}`;
            return quote(iso);
        }
        case 'json': return type === 'sqlserver' && /[^\x00-\x7f]/.test(c.v) ? `N${quote(c.v)}` : quote(c.v);
        case 'bin': {
            if (c.n > c.v.length / 2) return null;
            return type === 'postgresql' ? `'\\x${c.v}'::bytea` : type === 'oracle' ? `HEXTORAW('${c.v}')` : type === 'mysql' ? `X'${c.v}'` : `0x${c.v}`;
        }
        case 'text': return null;
        default: return null;
    }
}

export function insertScript(type: DbType | string, columns: Column[], rows: Cell[][], o: InsertOptions): { sql: string; statements: number; warnings: string[] } {
    const table = o.table.trim();
    if (!table) throw new Error('Name the table to insert into.');
    const target = table.split('.').map((p) => (/^[[`"]/.test(p) ? p : quoteName(type, p))).join('.');
    const idx = columns.map((c, i) => ({ c, i })).filter(({ c }) => !o.columns?.length || o.columns.includes(c.name));
    if (!idx.length) throw new Error('Choose at least one column.');
    const per = Math.max(1, Math.min(o.rowsPerStatement ?? 1, type === 'sqlserver' ? 1000 : 10000));
    const warnings: string[] = [];
    const incomplete = new Set<string>();
    const values = rows.map((r) => `(${idx.map(({ c, i }) => {
        const v = literal(type, r[i] ?? null, c);
        if (v === null) { incomplete.add(c.name); return 'NULL'; }
        return v;
    }).join(', ')})`);
    if (incomplete.size) warnings.push(`Written as NULL because the result does not hold the whole value (binary over 64 bytes or text over 32 KB): ${[...incomplete].join(', ')}.`);
    const cols = idx.map(({ c }) => quoteName(type, c.name)).join(', ');
    const out: string[] = [];
    if (o.identityInsert && type === 'sqlserver') out.push(`SET IDENTITY_INSERT ${target} ON;`);
    let statements = 0;
    if (type === 'oracle' && per > 1) {
        // Oracle: INSERT ALL … SELECT 1 FROM DUAL for several rows.
        for (let k = 0; k < values.length; k += per) {
            out.push(`INSERT ALL\n${values.slice(k, k + per).map((v) => `    INTO ${target} (${cols}) VALUES ${v}`).join('\n')}\nSELECT 1 FROM DUAL;`);
            statements++;
        }
    } else {
        for (let k = 0; k < values.length; k += per) {
            const chunk = values.slice(k, k + per);
            out.push(chunk.length === 1 ? `INSERT INTO ${target} (${cols}) VALUES ${chunk[0]};` : `INSERT INTO ${target} (${cols}) VALUES\n    ${chunk.join(',\n    ')};`);
            statements++;
        }
    }
    if (o.identityInsert && type === 'sqlserver') out.push(`SET IDENTITY_INSERT ${target} OFF;`);
    const dates = idx.some(({ c }) => /date|time/i.test(c.type)) || rows.some((r) => idx.some(({ i }) => (r[i] as { $t?: string } | null)?.$t === 'date'));
    if ((type === 'sqlserver' || type === 'postgresql') && dates && values.length) warnings.push('Date and time values are copied to the millisecond (the drivers give JavaScript dates): finer fractions of a second are not kept.');
    if (type === 'mysql' && dates && values.length) warnings.push('Dates are written in UTC as the driver read them: check the connection time zone if the server stores local times.');
    return { sql: out.join('\n') + '\n', statements, warnings };
}

/** The table a simple query reads from (FROM schema.table), as the default target. */
export function tableOfQuery(sql: string): string {
    const m = /\bfrom\s+((?:[\w$#]+|\[[^\]]+\]|"[^"]+"|`[^`]+`)(?:\s*\.\s*(?:[\w$#]+|\[[^\]]+\]|"[^"]+"|`[^`]+`)){0,2})/i.exec(sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' '));
    return m ? m[1].replace(/\s+/g, '') : '';
}
