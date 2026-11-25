/**
 * The Database screen's query process: one per project + environment, started in the repository
 * folder. It loads the project's own installed framework and database drivers, loads the configuration
 * exactly as a test run of that project/environment does (CSConfigurationManager.initialize: config
 * files, {env:…} secrets from this process's environment, ENCRYPTED: values), and connects and queries
 * the way the database steps do: CSDatabaseManager.createConnection(alias), then the adapter's query.
 *
 * Read-only connections are also read-only on the server where the database allows it:
 *  - PostgreSQL / MySQL / MariaDB: the session's transactions are READ ONLY (writes fail on the server);
 *  - SQL Server: each batch runs in a transaction that is always rolled back;
 *  - Oracle: rolled back after each statement (the framework does not commit on its own).
 * A separate process keeps a huge result or a hung driver away from the Studio: it can be stopped.
 */
import * as fs from 'fs';
import * as path from 'path';
import { columnsOf, toCell } from './cells';
import { columnsSql, objectsSql, toColumns, toObjects } from './schema';
import { mongoColumns, MongoDbLike, mongoObjects, mongoRows, REDIS_COLUMNS, redisItems, redisObjects, RedisLike, redisRows } from './nosql';
import { splitGo, stripSql } from './safety';
import { buildDdl, ddlQueries } from './ddl';
import { DataSource, procedureCall, textRows } from '../data/source';
import { frameworkPackage } from '../framework/package';

interface Req { id: number; op: 'query' | 'objects' | 'columns' | 'rows' | 'ping' | 'close' | 'ddl' | 'data' | 'encrypt'; values?: string[]; source?: DataSource; rows?: unknown[]; kind?: 'table' | 'view' | 'procedure' | 'function'; alias?: string; sql?: string; params?: unknown[]; maxRows?: number; timeoutMs?: number; mode?: 'read' | 'change'; schema?: string; table?: string }

const [, , project, environment] = process.argv;
type Db = { getConnection(): Promise<unknown>; getAdapter(): { query(c: unknown, sql: string, p?: unknown[], o?: { timeout?: number }): Promise<Record<string, unknown>> }; disconnect(): Promise<void>; getType?(): string };
const open = new Map<string, { db: Db; conn: unknown; adapter: ReturnType<Db['getAdapter']>; type: string }>();
let fw: { base: string; manager: { createConnection(alias: string): Promise<Db> }; config: { get(k: string, d?: string): string; interpolate(v: string, ctx?: Map<string, unknown>): string } } | null = null;

/** Parameter values as the parameterized-query step converts them (QueryExecutionSteps.convertParameterValue). */
export function convertParam(value: string): unknown {
    if (value.toLowerCase() === 'null') return null;
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return new Date(value);
    return value;
}

async function framework() {
    if (fw) return fw;
    // The package's exports do not include package.json: look for it in node_modules from the
    // repository folder upwards (as Node resolves packages; covers hoisted workspaces).
    // @mdakhan.mak, or the framework under another npm scope.
    const found = frameworkPackage(process.cwd());
    const base = found && fs.existsSync(path.join(found.dir, 'dist', 'lib', 'database.js')) ? found.dir : '';
    if (!base) throw new Error('The framework (@mdakhan.mak/cs-playwright-test-framework) is not installed in this repository: run npm install.');
    /* eslint-disable @typescript-eslint/no-var-requires */
    const core = require(path.join(base, 'dist', 'lib', 'core.js'));
    const database = require(path.join(base, 'dist', 'lib', 'database.js'));
    const config = core.CSConfigurationManager.getInstance();
    await config.initialize({ project, env: environment });
    fw = { base, manager: database.CSDatabaseManager.getInstance(), config };
    return fw;
}

/** First lines of an error (the framework appends long troubleshooting text). */
const short = (e: unknown) => String((e as Error)?.message ?? e).split('\n').filter((l) => l.trim()).slice(0, 4).join('\n');

async function connection(alias: string, mode: 'read' | 'change') {
    const key = `${alias}|${mode}`;
    const hit = open.get(key);
    if (hit) return hit;
    const f = await framework();
    // Each call opens its own connection (the manager only remembers the last one per alias): the
    // read-only and the change connection of an alias are separate.
    const db = await f.manager.createConnection(alias);
    const conn = await db.getConnection();
    const adapter = db.getAdapter();
    const type = (f.config.get(`DB_${alias.toUpperCase()}_TYPE`, 'sqlserver') || 'sqlserver').toLowerCase();
    if (mode === 'read') {
        if (type === 'postgresql') await adapter.query(conn, 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
        if (type === 'mysql') await adapter.query(conn, 'SET SESSION TRANSACTION READ ONLY');
    }
    const entry = { db, conn, adapter, type };
    open.set(key, entry);
    return entry;
}

/** The driver's own client the framework's adapter holds (MongoDB Db, node-redis client). */
function nativeOf(c: { adapter: unknown; type: string }): { mongo: MongoDbLike; redis: RedisLike } {
    const a = c.adapter as { db?: MongoDbLike; client?: RedisLike };
    if (c.type === 'mongodb' && !a.db) throw new Error('The framework\'s MongoDB connection has no database open.');
    if (c.type === 'redis' && !a.client) throw new Error('The framework\'s Redis connection is not open.');
    return { mongo: a.db as MongoDbLike, redis: a.client as RedisLike };
}

async function close(alias?: string) {
    for (const [k, c] of [...open]) {
        if (alias && !k.startsWith(`${alias}|`)) continue;
        open.delete(k);
        await c.db.disconnect().catch(() => { /* already gone */ });
    }
}

/** The framework's data provider (files, generated rows, filters, placeholders, decryption). */
type Provider = { loadData(o: Record<string, unknown>): Promise<unknown[]>; cache: Map<string, unknown>; applyStringFilter(d: unknown[], f: string): unknown[]; shuffleArray(d: unknown[]): unknown[]; processDynamicValues(d: unknown[]): unknown[] };
async function provider(): Promise<Provider> {
    const f = await framework();
    return require(path.join(f.base, 'dist', 'data', 'CSDataProvider.js')).CSDataProvider.getInstance();
}

/** Rows of a statement: the first result set (MySQL CALL gives [rows, status]). */
function resultRows(res: Record<string, unknown>): unknown[] {
    const rows = Array.isArray(res.rows) ? res.rows : [];
    if (rows.length && Array.isArray(rows[0])) return rows[0] as unknown[];
    if (Array.isArray(res.recordsets) && res.recordsets.length && !rows.length) return (res.recordsets as unknown[][]).find((x) => x.length) ?? [];
    return rows;
}

/** Run one statement for test data, read only where the query screen is (rolled back on SQL Server / Oracle). */
async function dataStatement(alias: string, mode: 'read' | 'change', sql: string, params: unknown[], timeout: number): Promise<unknown[]> {
    const c = await connection(alias, mode);
    const wrap = mode === 'read' && c.type === 'sqlserver';
    try {
        const res = await c.adapter.query(c.conn, wrap ? `SET XACT_ABORT ON; BEGIN TRANSACTION;\n${sql}\n;\nIF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;` : sql, params, { timeout });
        if (c.type === 'oracle') await c.adapter.query(c.conn, mode === 'read' ? 'ROLLBACK' : 'COMMIT').catch(() => { /* nothing open */ });
        return resultRows(res);
    } catch (e) {
        if (wrap) await c.adapter.query(c.conn, 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION').catch(() => { /* gone */ });
        if (c.type === 'oracle') await c.adapter.query(c.conn, 'ROLLBACK').catch(() => { /* gone */ });
        throw e;
    }
}

async function loadData(r: Req) {
    const s = r.source!;
    const p = await provider();
    p.cache.clear(); // files change between runs: always read them again
    const mode = r.mode === 'change' ? 'change' : 'read';
    const timeout = Math.max(1000, Math.min(Number(r.timeoutMs) || 300000, 3600000));
    const options = { filter: s.filter || undefined, filterExpression: s.filter || undefined, randomize: s.randomize || undefined, limit: s.limit || undefined };
    if (s.kind === 'file') return textRows(await p.loadData({ source: s.file, sheet: s.sheet || undefined, path: s.path || undefined, xpath: s.xpath || undefined, delimiter: s.delimiter || undefined, ...options }));
    if (s.kind === 'generate') return textRows(await p.loadData({ source: `generate:${String(s.generate).replace(/\s+/g, '')}`, ...options }));
    let rows: unknown[];
    if (s.kind === 'api') rows = r.rows ?? [];
    else {
        const cfg = (await framework()).config;
        const alias = String(s.connection ?? '').toUpperCase();
        const params = (s.params ?? []).map((x) => convertParam(cfg.interpolate(String(x ?? '').trim(), new Map())));
        if (s.kind === 'query') rows = await dataStatement(alias, mode, cfg.interpolate(String(s.sql), new Map()), params, timeout);
        else {
            const c = await connection(alias, mode);
            try { rows = await dataStatement(alias, mode, procedureCall(c.type, String(s.procedure), params.length), params, timeout); }
            catch (e) {
                // PostgreSQL: a procedure (not a function) is CALLed.
                if (c.type !== 'postgresql' || !/is a procedure/i.test(String((e as Error).message))) throw e;
                rows = await dataStatement(alias, mode, procedureCall(c.type, String(s.procedure), params.length, 'procedure'), params, timeout);
            }
            // A Redis function returns a list: each item a row (a JSON object item gives its fields as columns).
            if (c.type === 'redis') rows = redisItems(rows);
        }
    }
    // The framework's own filter, shuffle, limit and placeholders, as for its file sources.
    if (s.filter) rows = p.applyStringFilter(rows, s.filter);
    if (s.randomize) rows = p.shuffleArray(rows);
    if (s.limit) rows = rows.slice(0, s.limit);
    return textRows(p.processDynamicValues(textRows(rows).rows));
}

async function run(r: Req): Promise<unknown> {
    if (r.op === 'close') { await close(r.alias); return { closed: true }; }
    if (r.op === 'data') return loadData(r);
    // ENCRYPTED: values made by the project's own framework (the format its version decrypts).
    if (r.op === 'encrypt') {
        const f = await framework();
        const util = require(path.join(f.base, 'dist', 'utils', 'CSEncryptionUtil.js')).CSEncryptionUtil.getInstance();
        return { values: (r.values ?? []).map((v) => { const out = util.encrypt(String(v)); if (!/^ENCRYPTED:/.test(out)) throw new Error('The framework could not encrypt a value.'); return out; }) };
    }
    const alias = String(r.alias ?? '').toUpperCase();
    if (!/^[A-Z0-9_]{1,64}$/.test(alias)) throw new Error('Invalid connection name.');
    if (r.op === 'ping') {
        const t = Date.now();
        const c = await connection(alias, 'read');
        const sql = c.type === 'oracle' ? 'SELECT 1 AS ok FROM DUAL' : c.type === 'mongodb' ? '{ "ping": 1 }' : c.type === 'redis' ? 'PING' : 'SELECT 1 AS ok';
        await c.adapter.query(c.conn, sql, [], { timeout: 15000 });
        return { ok: true, ms: Date.now() - t, type: c.type };
    }
    if (r.op === 'objects') {
        const c = await connection(alias, 'read');
        // MongoDB collections; Redis key groups (user:*).
        if (c.type === 'mongodb') return { objects: await mongoObjects(nativeOf(c).mongo), type: c.type };
        if (c.type === 'redis') { const o = await redisObjects(nativeOf(c).redis); return { objects: o.objects, type: c.type, ...(o.capped ? { capped: true } : {}) }; }
        const sql = objectsSql(c.type);
        if (!sql) return { objects: [], unsupported: true, type: c.type };
        const res = await c.adapter.query(c.conn, sql, [], { timeout: 60000 });
        return { objects: toObjects((res.rows ?? []) as Array<Record<string, unknown>>), type: c.type };
    }
    if (r.op === 'ddl') {
        const c = await connection(alias, 'read');
        const kind = r.kind ?? 'table';
        const qs = ddlQueries(c.type, kind, String(r.schema ?? ''), String(r.table ?? ''));
        if (!qs.length) throw new Error(`Scripts are not available for ${c.type}.`);
        const rows: Record<string, Array<Record<string, unknown>>> = {};
        for (const q of qs) rows[q.key] = ((await c.adapter.query(c.conn, q.sql, q.params, { timeout: 60000 })).rows ?? []) as Array<Record<string, unknown>>;
        return { sql: buildDdl(c.type, kind, String(r.schema ?? ''), String(r.table ?? ''), rows) };
    }
    if (r.op === 'columns') {
        const c = await connection(alias, 'read');
        if (c.type === 'mongodb') return { columns: await mongoColumns(nativeOf(c).mongo, String(r.table ?? '')) };
        if (c.type === 'redis') return { columns: REDIS_COLUMNS };
        const q = columnsSql(c.type, String(r.schema ?? ''), String(r.table ?? ''));
        if (!q) return { columns: [] };
        const res = await c.adapter.query(c.conn, q[0], q[1], { timeout: 30000 });
        return { columns: toColumns((res.rows ?? []) as Array<Record<string, unknown>>) };
    }
    // The rows of a MongoDB collection or a Redis key group (as a query's result), for the data compare.
    if (r.op === 'rows') {
        const c = await connection(alias, 'read');
        const max = Math.max(1, Math.min(Number(r.maxRows) || 500, 200000));
        const t0 = Date.now();
        const got = c.type === 'mongodb' ? await mongoRows(nativeOf(c).mongo, String(r.table ?? ''), max)
            : c.type === 'redis' ? await redisRows(nativeOf(c).redis, String(r.table ?? ''), max)
                : (() => { throw new Error(`Rows of ${c.type} are read with a query.`); })();
        return { columns: got.columns, rows: got.rows.map((row) => got.columns.map((col) => toCell(row[col.name]))), total: got.total, truncated: got.truncated, ms: Date.now() - t0 };
    }
    // Query.
    const mode = r.mode === 'change' ? 'change' : 'read';
    const c = await connection(alias, mode);
    const maxRows = Math.max(1, Math.min(Number(r.maxRows) || 500, 100000));
    const timeout = Math.max(1000, Math.min(Number(r.timeoutMs) || 30000, 3600000));
    const typed = String(r.sql ?? '');
    // The query steps fill in {config:KEY}, {env:NAME}, ${VAR}, <random>… before running a query: so does the Studio.
    const original = (await framework()).config.interpolate(typed, new Map());
    const sqlServerReadOnly = mode === 'read' && c.type === 'sqlserver';
    // SQL Server scripts (SSMS, generated scripts) separate batches with GO lines: they run in turn;
    // read only (production), each batch runs in a transaction that is always rolled back.
    const batches = (c.type === 'sqlserver' ? splitGo(original) : [original])
        .map((b) => (sqlServerReadOnly ? `SET XACT_ABORT ON; BEGIN TRANSACTION;\n${b}\n;\nIF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;` : b));
    const t0 = Date.now();
    let res: Record<string, unknown> = {};
    try {
        const cfg = (await framework()).config;
        const params = Array.isArray(r.params) ? r.params.map((p) => convertParam(cfg.interpolate(String(p ?? '').trim(), new Map()))) : [];
        if (batches.length > 1 && params.length) throw new Error('A script with GO separators cannot take ? parameters.');
        for (const b of batches) res = await c.adapter.query(c.conn, b, params, { timeout });
        if (c.type === 'oracle') await c.adapter.query(c.conn, mode === 'read' ? 'ROLLBACK' : 'COMMIT').catch(() => { /* nothing open */ });
    } catch (e) {
        if (sqlServerReadOnly) await c.adapter.query(c.conn, 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION').catch(() => { /* gone */ });
        if (c.type === 'oracle') await c.adapter.query(c.conn, 'ROLLBACK').catch(() => { /* gone */ });
        throw e;
    }
    const ms = Date.now() - t0;
    // Redis: a list reply (KEYS, LRANGE, FCALL…) comes as { item_0 }, { item_1 }…: one row per item (a JSON object item as columns).
    const redisList = c.type === 'redis' && Array.isArray(res.rows) && (res.rows as Array<Record<string, unknown>>).some((x) => x && typeof x === 'object' && Object.keys(x).some((k) => /^item_\d+$/.test(k)));
    const rows = redisList ? redisItems(res.rows as unknown[]) as Array<Record<string, unknown>> : Array.isArray(res.rows) ? (res.rows as Array<Record<string, unknown>>) : [];
    if (redisList) delete res.fields;
    const command = (/^\(*\s*([A-Za-z]+)/.exec(stripSql(original).trim())?.[1] ?? String(res.command ?? '')).toUpperCase();
    // Rows changed: only for statements that return no rows (drivers also count the rows a SELECT returns).
    const affected = rows.length ? undefined : typeof res.affectedRows === 'number' ? res.affectedRows : typeof res.rowCount === 'number' ? res.rowCount : undefined;
    const columns = columnsOf({ fields: res.fields as Array<Record<string, unknown>>, rows });
    const shown = rows.slice(0, maxRows).map((row) => columns.map((col) => toCell(row[col.name])));
    return {
        columns, rows: shown, total: rows.length, truncated: rows.length > maxRows, ms,
        command, affected, type: c.type, ...(original !== typed ? { interpolated: true } : {}),
        // Read-only on SQL Server: whatever the batch changed was rolled back.
        ...(sqlServerReadOnly && !rows.length && (affected ?? 0) > 0 ? { rolledBack: true } : {}),
    };
}

process.on('message', (r: Req) => {
    void run(r).then(
        (result) => process.send?.({ id: r.id, result }),
        (e) => process.send?.({ id: r.id, error: short(e), code: (e as { code?: string })?.code }),
    ).then(() => { if (r.op === 'close' && !r.alias) process.exit(0); });
});
process.on('disconnect', () => { void close().finally(() => process.exit(0)); });
process.send?.({ ready: true });
