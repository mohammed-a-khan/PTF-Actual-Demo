/**
 * SQL as an action of a request (and of a load test's user path): a statement run on one of the project's database
 * connections (DB_<ALIAS>_TYPE, _HOST, _PORT, _DATABASE, _USERNAME, _PASSWORD as the framework reads them), with the
 * project's own driver (pg, mysql2, mssql, oracledb). Each exchange opens its own connection, as each virtual user
 * of a load test would. The result is a message: { rows, rowCount, affected }.
 * Production-like environments (and STUDIO_DB_READONLY=true, DB_<ALIAS>_STUDIO_READONLY=true) only run reads, as on
 * the Database screen.
 */
import { classify } from '../db/safety';
import { listConnections, protectedEnvironment } from '../db/connections';

export interface SqlResult { rows: Array<Record<string, unknown>>; rowCount: number; affected?: number }
export interface SqlConn { query(sql: string): Promise<SqlResult>; close(): Promise<void> }
export type SqlOpener = (alias: string) => Promise<SqlConn>;

const MAX_ROWS = 1000;

/** The connection alias of a db:// address (db://ORDERS, or just ORDERS). */
export function sqlAlias(url: string): string {
    const a = url.trim().replace(/^db:\/\//i, '').replace(/\/+$/, '').toUpperCase();
    if (!/^[A-Z0-9_]{1,64}$/.test(a)) throw new Error(`A database address is db://ALIAS (a DB_<ALIAS>_TYPE connection of the project); got ${url}.`);
    return a;
}

function driver<T>(projectRoot: string | undefined, name: string): T {
    for (const paths of [projectRoot ? [projectRoot] : [], [__dirname]]) {
        try { return require(require.resolve(name, { paths })) as T; } catch { /* next */ }
    }
    throw new Error(`The ${name} driver is not installed in this repository: npm install ${name}`);
}

const yes = (s?: string) => /^(true|1|yes)$/i.test(s ?? '');

/**
 * Opens connections with the project's settings. `config` is the resolved configuration of the project and
 * environment (secrets filled in); `environment` its name (production-like names only run reads).
 */
export function sqlOpener(o: { config: Record<string, string>; environment?: string; projectRoot?: string; timeoutMs: number }): SqlOpener {
    return async (alias) => {
        const c = listConnections(o.config).find((x) => x.alias === alias);
        if (!c) throw new Error(`No connection ${alias} (DB_${alias}_TYPE is not set for this environment).`);
        if (c.problems.length) throw new Error(c.problems.join(' '));
        const k = (n: string) => o.config[`DB_${alias}_${n}`] ?? '';
        const password = k('PASSWORD');
        if (/^ENCRYPTED:/.test(password)) throw new Error(`DB_${alias}_PASSWORD is an ENCRYPTED: value; keep it as a secret ({env:NAME}) to use the connection here.`);
        const readOnly = protectedEnvironment(o.environment ?? o.config.ENVIRONMENT ?? '', o.config) ?? (c.readOnlyByConfig ? `DB_${alias}_STUDIO_READONLY=true` : null);
        const timeout = Math.max(1000, Math.min(c.queryTimeoutMs, o.timeoutMs * 4));
        const guard = (sql: string) => {
            if (!readOnly) return;
            const kind = classify(sql, c.type);
            if (kind.kind === 'change') throw new Error(`This looks like a change (${kind.reason}). Only reads run here: ${readOnly}.`);
        };
        const cap = (rows: Array<Record<string, unknown>>) => rows.slice(0, MAX_ROWS);
        const ssl = yes(k('SSL')) || yes(k('ENCRYPT'));
        if (c.type === 'postgresql') {
            const pg = driver<{ Client: new (o: object) => { connect(): Promise<void>; query(s: string): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null; command: string }>; end(): Promise<void> } }>(o.projectRoot, 'pg');
            const client = new pg.Client({ host: c.host, port: c.port, database: c.database, user: c.username, password, statement_timeout: timeout, connectionTimeoutMillis: o.timeoutMs, ...(ssl ? { ssl: { rejectUnauthorized: !yes(k('TRUST_SERVER_CERTIFICATE')) } } : {}) });
            await client.connect();
            if (readOnly) await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
            return {
                query: async (sql) => { guard(sql); const all = await client.query(sql) as unknown; const r = (Array.isArray(all) ? all[all.length - 1] : all) as { rows: Array<Record<string, unknown>>; rowCount: number | null; command: string }; return /^(SELECT|SHOW|WITH|VALUES|EXPLAIN)/i.test(r.command ?? '') || r.rows.length ? { rows: cap(r.rows), rowCount: r.rows.length } : { rows: [], rowCount: 0, affected: r.rowCount ?? 0 }; },
                close: () => client.end().catch(() => undefined),
            };
        }
        if (c.type === 'mysql') {
            const my = driver<{ createConnection(o: object): Promise<{ query(s: string): Promise<[unknown, unknown]>; end(): Promise<void> }> }>(o.projectRoot, 'mysql2/promise');
            const conn = await my.createConnection({ host: c.host, port: c.port, database: c.database, user: c.username, password, connectTimeout: o.timeoutMs, ...(ssl ? { ssl: { rejectUnauthorized: !yes(k('TRUST_SERVER_CERTIFICATE')) } } : {}) });
            if (readOnly) await conn.query('SET SESSION TRANSACTION READ ONLY');
            return {
                query: async (sql) => { guard(sql); const [r] = await conn.query(sql); return Array.isArray(r) ? { rows: cap(r as Array<Record<string, unknown>>), rowCount: r.length } : { rows: [], rowCount: 0, affected: (r as { affectedRows?: number }).affectedRows ?? 0 }; },
                close: () => conn.end().catch(() => undefined),
            };
        }
        if (c.type === 'sqlserver') {
            const ms = driver<{ ConnectionPool: new (o: object) => { connect(): Promise<{ request(): { query(s: string): Promise<{ recordset?: Array<Record<string, unknown>>; rowsAffected: number[] }> }; close(): Promise<void> }> } }>(o.projectRoot, 'mssql');
            const pool = await new ms.ConnectionPool({ server: c.host, port: c.port, database: c.database, user: c.username, password, connectionTimeout: o.timeoutMs, requestTimeout: timeout, pool: { max: 1 },
                options: { encrypt: k('ENCRYPT') ? yes(k('ENCRYPT')) : true, trustServerCertificate: yes(k('TRUST_SERVER_CERTIFICATE')) } }).connect();
            return {
                query: async (sql) => { guard(sql); const r = await pool.request().query(sql); return r.recordset ? { rows: cap(r.recordset), rowCount: r.recordset.length } : { rows: [], rowCount: 0, affected: r.rowsAffected.reduce((a, b) => a + b, 0) }; },
                close: () => pool.close().catch(() => undefined),
            };
        }
        if (c.type === 'oracle') {
            const ora = driver<{ OUT_FORMAT_OBJECT: number; getConnection(o: object): Promise<{ execute(s: string, b: unknown[], o: object): Promise<{ rows?: Array<Record<string, unknown>>; rowsAffected?: number }>; close(): Promise<void> }> }>(o.projectRoot, 'oracledb');
            const conn = await ora.getConnection({ user: c.username, password, connectString: k('CONNECT_STRING') || `${c.host}:${c.port}/${c.database}` });
            return {
                query: async (sql) => { guard(sql); const r = await conn.execute(sql.replace(/;\s*$/, ''), [], { outFormat: ora.OUT_FORMAT_OBJECT, autoCommit: true, maxRows: MAX_ROWS }); return r.rows ? { rows: r.rows, rowCount: r.rows.length } : { rows: [], rowCount: 0, affected: r.rowsAffected ?? 0 }; },
                close: () => conn.close().catch(() => undefined),
            };
        }
        throw new Error(`SQL actions run on SQL Server, PostgreSQL, MySQL and Oracle connections; ${alias} is ${c.type}.`);
    };
}
