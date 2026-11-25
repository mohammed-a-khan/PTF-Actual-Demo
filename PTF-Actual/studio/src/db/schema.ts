/**
 * What is in a database: tables, views, procedures and functions, and a table's columns. The framework
 * has no listing API, so these are the catalogue queries of each database (run through the same
 * connection as everything else, read-only). Names are passed as parameters, never pasted into SQL.
 * Row counts are the catalogue's estimates (no COUNT(*) on large tables).
 */
import type { DbType } from './connections';

export type ObjectKind = 'table' | 'view' | 'procedure' | 'function';
export interface DbObject { schema: string; name: string; kind: ObjectKind; rows?: number }
export interface DbColumnInfo { name: string; type: string; nullable: boolean; key: boolean; default?: string }

export const OBJECT_LIMIT = 20000;

export function objectsSql(type: DbType | string): string | null {
    switch (type) {
        case 'sqlserver': return `SELECT TOP ${OBJECT_LIMIT} s.name AS schema_name, o.name AS object_name,
  CASE o.type WHEN 'U' THEN 'table' WHEN 'V' THEN 'view' WHEN 'P' THEN 'procedure' ELSE 'function' END AS kind,
  (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS row_estimate
FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF') AND o.is_ms_shipped = 0
ORDER BY s.name, o.name`;
        case 'postgresql': return `SELECT n.nspname AS schema_name, c.relname AS object_name,
  CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'view' ELSE 'table' END AS kind,
  CASE WHEN c.relkind IN ('r', 'p') THEN GREATEST(c.reltuples, 0)::bigint END AS row_estimate
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
UNION ALL
SELECT n.nspname, p.proname, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END, NULL
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind IN ('f', 'p')
ORDER BY 1, 2 LIMIT ${OBJECT_LIMIT}`;
        case 'mysql': return `SELECT table_schema AS schema_name, table_name AS object_name, CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END AS kind, table_rows AS row_estimate
FROM information_schema.tables WHERE table_schema = DATABASE()
UNION ALL
SELECT routine_schema, routine_name, LOWER(routine_type), NULL FROM information_schema.routines WHERE routine_schema = DATABASE()
ORDER BY 1, 2 LIMIT ${OBJECT_LIMIT}`;
        case 'oracle': return `SELECT USER AS schema_name, object_name, LOWER(object_type) AS kind, NULL AS row_estimate FROM user_objects
WHERE object_type IN ('TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION') ORDER BY object_name FETCH FIRST ${OBJECT_LIMIT} ROWS ONLY`;
        default: return null;
    }
}

/** Columns of one table or view: [sql, params]. */
export function columnsSql(type: DbType | string, schema: string, table: string): [string, unknown[]] | null {
    switch (type) {
        case 'sqlserver': return [`SELECT c.name AS column_name,
  t.name + CASE WHEN t.name IN ('varchar', 'char', 'varbinary', 'binary') THEN '(' + CASE c.max_length WHEN -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')'
    WHEN t.name IN ('nvarchar', 'nchar') THEN '(' + CASE c.max_length WHEN -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')'
    WHEN t.name IN ('decimal', 'numeric') THEN '(' + CAST(c.precision AS varchar(5)) + ',' + CAST(c.scale AS varchar(5)) + ')' ELSE '' END AS data_type,
  c.is_nullable AS nullable,
  CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
    WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END AS is_key,
  OBJECT_DEFINITION(c.default_object_id) AS column_default
FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID(QUOTENAME(?) + '.' + QUOTENAME(?)) ORDER BY c.column_id`, [schema, table]];
        case 'postgresql': return [`SELECT c.column_name, c.data_type || COALESCE('(' || c.character_maximum_length || ')', '') AS data_type, c.is_nullable = 'YES' AS nullable,
  EXISTS (SELECT 1 FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema AND tc.table_name = c.table_name AND k.column_name = c.column_name) AS is_key,
  c.column_default
FROM information_schema.columns c WHERE c.table_schema = ? AND c.table_name = ? ORDER BY c.ordinal_position`, [schema, table]];
        case 'mysql': return [`SELECT column_name AS column_name, column_type AS data_type, is_nullable = 'YES' AS nullable, column_key = 'PRI' AS is_key, column_default AS column_default
FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`, [schema, table]];
        case 'oracle': return [`SELECT column_name, data_type || CASE WHEN data_type IN ('VARCHAR2', 'CHAR', 'NVARCHAR2') THEN '(' || data_length || ')' END AS data_type,
  CASE nullable WHEN 'Y' THEN 1 ELSE 0 END AS nullable,
  CASE WHEN EXISTS (SELECT 1 FROM user_constraints uc JOIN user_cons_columns cc ON cc.constraint_name = uc.constraint_name
    WHERE uc.constraint_type = 'P' AND uc.table_name = t.table_name AND cc.column_name = t.column_name) THEN 1 ELSE 0 END AS is_key, NULL AS column_default
FROM user_tab_columns t WHERE table_name = ? ORDER BY column_id`, [table]];
        default: return null;
    }
}

/** Rows of the catalogue queries → objects / columns (column names differ in case between databases). */
const pick = (r: Record<string, unknown>, k: string) => r[k] ?? r[k.toUpperCase()] ?? r[k.toLowerCase()];
const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 't' || v === 'true' || v === 'YES';

export function toObjects(rows: Array<Record<string, unknown>>): DbObject[] {
    return rows.map((r) => {
        const est = pick(r, 'row_estimate');
        const kind = String(pick(r, 'kind') ?? 'table').toLowerCase();
        return { schema: String(pick(r, 'schema_name') ?? ''), name: String(pick(r, 'object_name') ?? ''), kind: (['table', 'view', 'procedure', 'function'].includes(kind) ? kind : 'table') as ObjectKind,
            ...(est !== null && est !== undefined && Number.isFinite(Number(est)) ? { rows: Number(est) } : {}) };
    });
}

export function toColumns(rows: Array<Record<string, unknown>>): DbColumnInfo[] {
    return rows.map((r) => {
        const d = pick(r, 'column_default');
        return { name: String(pick(r, 'column_name') ?? ''), type: String(pick(r, 'data_type') ?? ''), nullable: truthy(pick(r, 'nullable')), key: truthy(pick(r, 'is_key')), ...(d !== null && d !== undefined ? { default: String(d) } : {}) };
    });
}

/** A first query for a table or view (each database's way of limiting rows; names quoted). */
export function selectSql(type: DbType | string, schema: string, table: string, limit = 100): string {
    switch (type) {
        case 'sqlserver': return `SELECT TOP ${limit} * FROM [${schema.replace(/]/g, ']]')}].[${table.replace(/]/g, ']]')}]`;
        case 'postgresql': return `SELECT * FROM "${schema.replace(/"/g, '""')}"."${table.replace(/"/g, '""')}" LIMIT ${limit}`;
        case 'mysql': return `SELECT * FROM \`${table.replace(/`/g, '``')}\` LIMIT ${limit}`;
        case 'oracle': return `SELECT * FROM "${table.replace(/"/g, '""')}" FETCH FIRST ${limit} ROWS ONLY`;
        case 'mongodb': return `db.${table}.find({}).limit(${limit})`;
        default: return '';
    }
}
