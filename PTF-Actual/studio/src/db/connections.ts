/**
 * The project's database connections, read the way the framework reads them for its database steps
 * (CSDatabaseManager.getDefaultConfig): DB_<ALIAS>_TYPE, _HOST, _PORT, _DATABASE, _USERNAME, _PASSWORD,
 * _TRUSTED_CONNECTION, _ENCRYPT, _TRUST_SERVER_CERTIFICATE, _CONNECTION_TIMEOUT, _REQUEST_TIMEOUT.
 * Aliases are the keys DB_<ALIAS>_TYPE, plus the names listed in DATABASE_CONNECTIONS.
 * Passwords are never returned: only whether one is set.
 */

export type DbType = 'sqlserver' | 'mysql' | 'postgresql' | 'oracle' | 'mongodb' | 'redis';
export const DB_TYPES: DbType[] = ['sqlserver', 'mysql', 'postgresql', 'oracle', 'mongodb', 'redis'];

/** The npm driver each type needs in the project (the framework loads it from there). */
export const DRIVER: Record<DbType, string> = { sqlserver: 'mssql', mysql: 'mysql2', postgresql: 'pg', oracle: 'oracledb', mongodb: 'mongodb', redis: 'redis' };
const DEFAULT_PORT: Record<DbType, number> = { sqlserver: 1433, mysql: 3306, postgresql: 5432, oracle: 1521, mongodb: 27017, redis: 6379 };

export interface DbConnectionInfo {
    alias: string;
    type: DbType | string;
    host: string;
    port: number;
    database: string;
    username: string;
    passwordSet: boolean;
    trusted: boolean;
    /** Things that stop the framework from connecting (missing keys, unknown type). */
    problems: string[];
    /** Changes are never allowed from the Studio for this connection (DB_<ALIAS>_STUDIO_READONLY=true). */
    readOnlyByConfig: boolean;
    queryTimeoutMs: number;
}

export function listConnections(values: Record<string, string>): DbConnectionInfo[] {
    const get = (k: string) => values[k] ?? values[k.toUpperCase()] ?? '';
    const aliases = new Set<string>();
    for (const k of Object.keys(values)) { const m = /^DB_(.+)_TYPE$/.exec(k); if (m && m[1] !== 'QUERY') aliases.add(m[1].toUpperCase()); }
    for (const a of get('DATABASE_CONNECTIONS').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)) aliases.add(a);
    return [...aliases].sort().map((U) => {
        const k = (name: string) => get(`DB_${U}_${name}`);
        const problems: string[] = [];
        const type = (k('TYPE') || 'sqlserver').toLowerCase();
        if (!DB_TYPES.includes(type as DbType)) problems.push(`DB_${U}_TYPE is "${type}"; the framework knows ${DB_TYPES.join(', ')}.`);
        const trusted = String(k('TRUSTED_CONNECTION')) === 'true';
        if (!k('HOST')) problems.push(`DB_${U}_HOST is missing.`);
        // Redis: a database number and credentials are optional (many servers have none); MongoDB: a database, and
        // credentials when the server asks for them.
        const noSql = type === 'redis' || type === 'mongodb';
        if (!k('DATABASE') && type !== 'redis') problems.push(`DB_${U}_DATABASE is missing.`);
        if (!trusted && !noSql && !k('USERNAME')) problems.push(`DB_${U}_USERNAME is missing.`);
        if (!trusted && !noSql && !k('PASSWORD')) problems.push(`DB_${U}_PASSWORD is missing (or DB_${U}_TRUSTED_CONNECTION=true for Windows authentication).`);
        const port = parseInt(k('PORT'), 10);
        const timeout = parseInt(k('REQUEST_TIMEOUT'), 10);
        return {
            alias: U, type, host: k('HOST'), port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT[type as DbType] ?? 0,
            database: k('DATABASE'), username: k('USERNAME'), passwordSet: !!k('PASSWORD'), trusted, problems,
            readOnlyByConfig: /^(true|1|yes)$/i.test(k('STUDIO_READONLY')),
            queryTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 15000,
        };
    });
}

/**
 * Environments where the Studio never runs changes (whatever the connection says): names that look
 * like production, and projects/environments with STUDIO_DB_READONLY=true.
 */
export function protectedEnvironment(environment: string, values: Record<string, string>): string | null {
    if (/(^|[-_.])(prod|prd|production|live)([-_.]|\d|$)/i.test(environment)) return `"${environment}" looks like a production environment`;
    if (/^(true|1|yes)$/i.test(values.STUDIO_DB_READONLY ?? '')) return `STUDIO_DB_READONLY=true for ${environment}`;
    return null;
}
