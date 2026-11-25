/**
 * CREATE scripts of tables, views, procedures and functions, as a database tool writes them.
 *  - MySQL / MariaDB: the server's own SHOW CREATE …;
 *  - Oracle: DBMS_METADATA.GET_DDL;
 *  - SQL Server and PostgreSQL have no "show create table": the script is built from the catalogue
 *    (columns with types, identity, defaults and computed columns; primary key, unique, foreign key and
 *    check constraints; other indexes). Views, procedures and functions use the stored definition.
 * Names go to the catalogue queries as parameters; in the script they are quoted for the database.
 */
import type { DbType } from './connections';
import type { ObjectKind } from './schema';

export interface DdlQuery { key: string; sql: string; params: unknown[] }
type Rows = Array<Record<string, unknown>>;

const pick = (r: Record<string, unknown>, k: string) => r[k] ?? r[k.toUpperCase()] ?? r[k.toLowerCase()];
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const yes = (v: unknown) => v === true || v === 1 || v === '1' || v === 't' || v === 'true' || v === 'YES' || v === 'Y';

export const quoteName = (type: DbType | string, name: string): string =>
    type === 'sqlserver' ? `[${name.replace(/]/g, ']]')}]` : type === 'mysql' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`;

/** The catalogue queries one script needs. */
export function ddlQueries(type: DbType | string, kind: ObjectKind, schema: string, name: string): DdlQuery[] {
    const q = (n: string) => quoteName(type, n);
    switch (type) {
        case 'mysql': {
            const what = kind === 'view' ? 'VIEW' : kind === 'procedure' ? 'PROCEDURE' : kind === 'function' ? 'FUNCTION' : 'TABLE';
            return [{ key: 'show', sql: `SHOW CREATE ${what} ${schema ? `${q(schema)}.` : ''}${q(name)}`, params: [] }];
        }
        case 'oracle':
            // The owner as a third argument: objects of other schemas (the login's own when none).
            return schema
                ? [{ key: 'ddl', sql: 'SELECT DBMS_METADATA.GET_DDL(?, ?, ?) AS ddl FROM DUAL', params: [kind.toUpperCase(), name, schema] }]
                : [{ key: 'ddl', sql: 'SELECT DBMS_METADATA.GET_DDL(?, ?) AS ddl FROM DUAL', params: [kind.toUpperCase(), name] }];
        case 'sqlserver': {
            const obj = "OBJECT_ID(QUOTENAME(?) + '.' + QUOTENAME(?))";
            if (kind !== 'table') return [{ key: 'module', sql: `SELECT m.definition FROM sys.sql_modules m WHERE m.object_id = ${obj}`, params: [schema, name] }];
            return [
                { key: 'columns', params: [schema, name], sql: `SELECT c.column_id, c.name, t.name AS type_name, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity,
  CAST(ic.seed_value AS varchar(40)) AS seed, CAST(ic.increment_value AS varchar(40)) AS incr, dc.name AS default_name, dc.definition AS default_def,
  cc.definition AS computed_def, cc.is_persisted
FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
WHERE c.object_id = ${obj} ORDER BY c.column_id` },
                { key: 'indexes', params: [schema, name], sql: `SELECT i.index_id, i.name AS index_name, i.is_primary_key, i.is_unique_constraint, i.is_unique, i.type_desc, i.filter_definition,
  ic.key_ordinal, ic.is_descending_key, ic.is_included_column, col.name AS column_name
FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
WHERE i.object_id = ${obj} AND i.type > 0 ORDER BY i.index_id, ic.is_included_column, ic.key_ordinal, ic.index_column_id` },
                { key: 'fks', params: [schema, name], sql: `SELECT fk.name AS fk_name, fkc.constraint_column_id, pc.name AS column_name, rs.name AS ref_schema, rt.name AS ref_table, rc.name AS ref_column,
  fk.delete_referential_action_desc AS on_delete, fk.update_referential_action_desc AS on_update
FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
WHERE fk.parent_object_id = ${obj} ORDER BY fk.name, fkc.constraint_column_id` },
                { key: 'checks', params: [schema, name], sql: `SELECT cc.name AS check_name, cc.definition FROM sys.check_constraints cc WHERE cc.parent_object_id = ${obj} ORDER BY cc.name` },
            ];
        }
        case 'postgresql': {
            const rel = "(quote_ident(CAST(? AS text)) || '.' || quote_ident(CAST(? AS text)))::regclass";
            if (kind === 'view') return [{ key: 'view', sql: `SELECT pg_get_viewdef(${rel}, true) AS definition, (SELECT c.relkind FROM pg_class c WHERE c.oid = ${rel}) AS relkind`, params: [schema, name, schema, name] }];
            if (kind !== 'table') return [{ key: 'routines', sql: `SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ? AND p.proname = ? ORDER BY p.oid`, params: [schema, name] }];
            return [
                { key: 'columns', params: [schema, name], sql: `SELECT a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS type_name, a.attnotnull AS not_null,
  pg_get_expr(d.adbin, d.adrelid) AS default_def, a.attidentity AS identity, a.attgenerated AS generated
FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = ${rel} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum` },
                { key: 'constraints', params: [schema, name], sql: `SELECT c.conname AS constraint_name, c.contype AS kind, pg_get_constraintdef(c.oid, true) AS definition
FROM pg_constraint c WHERE c.conrelid = ${rel} ORDER BY CASE c.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, c.conname` },
                { key: 'indexes', params: [schema, name], sql: `SELECT pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i
WHERE i.indrelid = ${rel} AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid) ORDER BY i.indexrelid` },
            ];
        }
        default: return [];
    }
}

function sqlServerType(r: Record<string, unknown>): string {
    const t = str(pick(r, 'type_name')).toLowerCase();
    const len = Number(pick(r, 'max_length')), p = Number(pick(r, 'precision')), s = Number(pick(r, 'scale'));
    if (['varchar', 'char', 'varbinary', 'binary'].includes(t)) return `${t}(${len === -1 ? 'max' : len})`;
    if (['nvarchar', 'nchar'].includes(t)) return `${t}(${len === -1 ? 'max' : len / 2})`;
    if (['decimal', 'numeric'].includes(t)) return `${t}(${p}, ${s})`;
    if (['datetime2', 'time', 'datetimeoffset'].includes(t)) return s === 7 ? t : `${t}(${s})`;
    return t;
}

/** The script from the catalogue rows of ddlQueries (by key). */
export function buildDdl(type: DbType | string, kind: ObjectKind, schema: string, name: string, rows: Record<string, Rows>): string {
    const q = (n: string) => quoteName(type, n);
    const full = schema ? `${q(schema)}.${q(name)}` : q(name);
    if (type === 'mysql') {
        const r = rows.show?.[0] ?? {};
        const key = Object.keys(r).find((k) => /^create (table|view|procedure|function)$/i.test(k));
        const text = key ? str(r[key]) : '';
        if (!text) throw new Error(`${name}: no definition (the login may not be allowed to see it).`);
        return `${text};\n`;
    }
    if (type === 'oracle') {
        const text = str(pick(rows.ddl?.[0] ?? {}, 'ddl')).trim();
        if (!text) throw new Error(`${name}: no definition returned.`);
        return `${text}${text.endsWith(';') || text.endsWith('/') ? '' : ';'}\n`;
    }
    if (type === 'sqlserver') {
        if (kind !== 'table') {
            const def = str(pick(rows.module?.[0] ?? {}, 'definition')).trim();
            if (!def) throw new Error(`${schema}.${name}: no definition (it may be encrypted, or the login lacks VIEW DEFINITION).`);
            return `${def}\nGO\n`;
        }
        const cols = rows.columns ?? [];
        if (!cols.length) throw new Error(`${schema}.${name}: no columns found.`);
        const lines = cols.map((c) => {
            const nm = q(str(pick(c, 'name')));
            const computed = str(pick(c, 'computed_def'));
            if (computed) return `    ${nm} AS ${computed}${yes(pick(c, 'is_persisted')) ? ' PERSISTED' : ''}`;
            let l = `    ${nm} ${sqlServerType(c)}`;
            if (yes(pick(c, 'is_identity'))) l += ` IDENTITY(${str(pick(c, 'seed')) || 1}, ${str(pick(c, 'incr')) || 1})`;
            l += yes(pick(c, 'is_nullable')) ? ' NULL' : ' NOT NULL';
            const def = str(pick(c, 'default_def'));
            if (def) l += ` CONSTRAINT ${q(str(pick(c, 'default_name')))} DEFAULT ${def}`;
            return l;
        });
        // Indexes: group the column rows per index.
        const idx = new Map<string, { name: string; pk: boolean; uq: boolean; unique: boolean; kind: string; filter: string; keys: string[]; include: string[] }>();
        for (const r of rows.indexes ?? []) {
            const k = str(pick(r, 'index_id'));
            if (!idx.has(k)) idx.set(k, { name: str(pick(r, 'index_name')), pk: yes(pick(r, 'is_primary_key')), uq: yes(pick(r, 'is_unique_constraint')), unique: yes(pick(r, 'is_unique')), kind: str(pick(r, 'type_desc')).toUpperCase(), filter: str(pick(r, 'filter_definition')), keys: [], include: [] });
            const e = idx.get(k)!;
            const col = q(str(pick(r, 'column_name')));
            if (yes(pick(r, 'is_included_column'))) e.include.push(col); else e.keys.push(`${col}${yes(pick(r, 'is_descending_key')) ? ' DESC' : ''}`);
        }
        const clustered = (k: string) => (k.startsWith('CLUSTERED') ? 'CLUSTERED' : 'NONCLUSTERED');
        for (const e of idx.values()) if (e.pk || e.uq) lines.push(`    CONSTRAINT ${q(e.name)} ${e.pk ? 'PRIMARY KEY' : 'UNIQUE'} ${clustered(e.kind)} (${e.keys.join(', ')})`);
        for (const c of rows.checks ?? []) lines.push(`    CONSTRAINT ${q(str(pick(c, 'check_name')))} CHECK ${str(pick(c, 'definition'))}`);
        const out = [`CREATE TABLE ${full} (\n${lines.join(',\n')}\n);`, 'GO'];
        // Foreign keys after the table (they may point to tables created later).
        const fks = new Map<string, { cols: string[]; refs: string[]; table: string; del: string; upd: string }>();
        for (const r of rows.fks ?? []) {
            const k = str(pick(r, 'fk_name'));
            if (!fks.has(k)) fks.set(k, { cols: [], refs: [], table: `${q(str(pick(r, 'ref_schema')))}.${q(str(pick(r, 'ref_table')))}`, del: str(pick(r, 'on_delete')), upd: str(pick(r, 'on_update')) });
            fks.get(k)!.cols.push(q(str(pick(r, 'column_name')))); fks.get(k)!.refs.push(q(str(pick(r, 'ref_column'))));
        }
        const action = (a: string) => a.replace(/_/g, ' ');
        for (const [k, f] of fks) out.push(`ALTER TABLE ${full} ADD CONSTRAINT ${q(k)} FOREIGN KEY (${f.cols.join(', ')}) REFERENCES ${f.table} (${f.refs.join(', ')})${f.del && f.del !== 'NO_ACTION' ? ` ON DELETE ${action(f.del)}` : ''}${f.upd && f.upd !== 'NO_ACTION' ? ` ON UPDATE ${action(f.upd)}` : ''};`, 'GO');
        for (const e of idx.values()) if (!e.pk && !e.uq) out.push(`CREATE ${e.unique ? 'UNIQUE ' : ''}${clustered(e.kind)} INDEX ${q(e.name)} ON ${full} (${e.keys.join(', ')})${e.include.length ? ` INCLUDE (${e.include.join(', ')})` : ''}${e.filter ? ` WHERE ${e.filter}` : ''};`, 'GO');
        return out.join('\n') + '\n';
    }
    if (type === 'postgresql') {
        if (kind === 'view') {
            const r = rows.view?.[0] ?? {};
            const def = str(pick(r, 'definition')).trim();
            if (!def) throw new Error(`${schema}.${name}: no definition.`);
            return `CREATE OR REPLACE ${str(pick(r, 'relkind')) === 'm' ? 'MATERIALIZED VIEW' : 'VIEW'} ${full} AS\n${def.replace(/;?\s*$/, ';')}\n`;
        }
        if (kind !== 'table') {
            const defs = (rows.routines ?? []).map((r) => str(pick(r, 'definition')).trim()).filter(Boolean);
            if (!defs.length) throw new Error(`${schema}.${name}: no definition.`);
            return defs.map((d) => `${d.replace(/;?\s*$/, '')};`).join('\n\n') + '\n';
        }
        const cols = rows.columns ?? [];
        if (!cols.length) throw new Error(`${schema}.${name}: no columns found.`);
        let sequences = false;
        const lines = cols.map((c) => {
            const typeName = str(pick(c, 'type_name'));
            const ident = str(pick(c, 'identity')), gen = str(pick(c, 'generated')), def = str(pick(c, 'default_def'));
            // A column fed by its own sequence (serial): written as serial, which creates the sequence.
            const serial = /^nextval\('[^']*_seq'::regclass\)$/.test(def) && ({ integer: 'serial', bigint: 'bigserial', smallint: 'smallserial' } as Record<string, string>)[typeName];
            let l = `    ${q(str(pick(c, 'column_name')))} ${serial || typeName}`;
            if (serial) { /* the sequence comes with the type */ }
            else if (gen === 's' && def) l += ` GENERATED ALWAYS AS (${def}) STORED`;
            else if (ident === 'a' || ident === 'd') l += ` GENERATED ${ident === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
            else if (def) { l += ` DEFAULT ${def}`; if (/nextval\(/i.test(def)) sequences = true; }
            if (yes(pick(c, 'not_null'))) l += ' NOT NULL';
            return l;
        });
        const fkLines: string[] = [];
        for (const c of rows.constraints ?? []) {
            const kind = str(pick(c, 'kind')), line = `CONSTRAINT ${q(str(pick(c, 'constraint_name')))} ${str(pick(c, 'definition'))}`;
            if (kind === 'n') continue; // NOT NULL constraints (PostgreSQL 18) are on the columns already
            if (kind === 'f') fkLines.push(`ALTER TABLE ${full} ADD ${line};`); else lines.push(`    ${line}`);
        }
        const out = [`CREATE TABLE ${full} (\n${lines.join(',\n')}\n);`, ...fkLines, ...(rows.indexes ?? []).map((r) => `${str(pick(r, 'definition'))};`)];
        if (sequences) out.push('-- Some defaults use shared sequences (nextval): create those sequences first.');
        return out.join('\n') + '\n';
    }
    throw new Error(`Scripts are not available for ${type}.`);
}
