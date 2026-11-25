/**
 * Is a statement a read or a change? Used to keep the Database screen read-only unless changes are
 * allowed (and confirmed). Strings, quoted names and comments are ignored, so `WHERE note = 'DELETE'`
 * is a read. When in doubt (procedure calls, unknown commands) it is a change.
 * This is a guard against mistakes, not a security boundary: the database login's permissions are.
 */
import type { DbType } from './connections';

export interface Classified { kind: 'read' | 'change'; statements: number; keywords: string[]; reason?: string }

/** The text without strings, quoted names and comments (each replaced by a space). */
export function stripSql(sql: string): string {
    let out = '';
    for (let i = 0; i < sql.length;) {
        const c = sql[i], n = sql[i + 1];
        if (c === '-' && n === '-') { const e = sql.indexOf('\n', i); i = e < 0 ? sql.length : e; out += ' '; continue; }
        if (c === '/' && n === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? sql.length : e + 2; out += ' '; continue; }
        if (c === "'" || c === '"' || c === '`' || c === '[') {
            const close = c === '[' ? ']' : c;
            let j = i + 1;
            for (; j < sql.length; j++) { if (sql[j] === close) { if (close !== ']' && sql[j + 1] === close) { j++; continue; } break; } }
            i = j + 1; out += ' x '; continue;
        }
        if (c === '$') { const m = /^\$(\w*)\$/.exec(sql.slice(i)); if (m) { const e = sql.indexOf(m[0], i + m[0].length); i = e < 0 ? sql.length : e + m[0].length; out += ' x '; continue; } }
        out += c; i++;
    }
    return out;
}

const READ_START = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'VALUES', 'TABLE', 'USE']);
/** T-SQL scripts that only read often start with variables, session options, waits or messages. */
const SQLSERVER_READ_START = new Set(['DECLARE', 'SET', 'WAITFOR', 'PRINT']);
/** Inside a SELECT / WITH: words that only appear when the statement writes (WITH … DELETE, SELECT … EXEC). */
const CHANGE_WORDS = /\b(INSERT\s+INTO|INSERT|UPDATE\s+\w|DELETE\s+FROM|DELETE|MERGE\s+INTO|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE)\b/i;

export function classify(sql: string, type: DbType | string): Classified {
    const text = sql.trim();
    if (type === 'mongodb') {
        const m = /\.\s*(\w+)\s*\(/g;
        const ops = [...text.matchAll(m)].map((x) => x[1]);
        const read = new Set(['find', 'findOne', 'aggregate', 'count', 'countDocuments', 'estimatedDocumentCount', 'distinct', 'getCollectionNames', 'listCollections', 'stats', 'limit', 'skip', 'sort', 'project', 'toArray']);
        const bad = ops.filter((o) => !read.has(o));
        if (/\$(out|merge)\b/.test(text)) return { kind: 'change', statements: 1, keywords: ['$out/$merge'], reason: 'an aggregation that writes ($out / $merge)' };
        return bad.length || !ops.length ? { kind: 'change', statements: 1, keywords: bad, reason: bad.length ? `${bad.join(', ')}` : 'not a read operation' } : { kind: 'read', statements: 1, keywords: ops };
    }
    if (type === 'redis') {
        const cmds = text.split(/\r?\n|;/).map((l) => l.trim().split(/\s+/)[0]?.toUpperCase()).filter(Boolean);
        const read = new Set(['GET', 'MGET', 'HGET', 'HGETALL', 'HMGET', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'EXISTS', 'TYPE', 'TTL', 'PTTL', 'STRLEN', 'LRANGE', 'LLEN', 'LINDEX', 'SMEMBERS', 'SISMEMBER', 'SCARD', 'ZRANGE', 'ZRANGEBYSCORE', 'ZREVRANGE', 'ZCARD', 'ZSCORE', 'ZRANK', 'SCAN', 'HSCAN', 'SSCAN', 'ZSCAN', 'KEYS', 'DBSIZE', 'INFO', 'PING', 'ECHO', 'TIME', 'XRANGE', 'XLEN', 'GETRANGE']);
        const bad = cmds.filter((c) => !read.has(c));
        return bad.length || !cmds.length ? { kind: 'change', statements: cmds.length, keywords: bad, reason: bad.join(', ') || 'no command' } : { kind: 'read', statements: cmds.length, keywords: cmds };
    }
    const bare = stripSql(text);
    const statements = bare.split(';').map((s) => s.trim()).filter(Boolean);
    if (!statements.length) return { kind: 'read', statements: 0, keywords: [] };
    const keywords: string[] = [];
    for (const st of statements) {
        const first = (/^\(*\s*([A-Za-z]+)/.exec(st)?.[1] ?? '').toUpperCase();
        keywords.push(first);
        if (!READ_START.has(first) && !(type === 'sqlserver' && SQLSERVER_READ_START.has(first))) return { kind: 'change', statements: statements.length, keywords, reason: first ? `${first} statement` : 'not a query' };
        // WITH … UPDATE/DELETE, SELECT … INTO new_table, SELECT … FOR UPDATE: changes too.
        const word = CHANGE_WORDS.exec(st.replace(/\bFOR\s+UPDATE\b/gi, ' '));
        if (word && !(first === 'USE' && statements.length > 1)) return { kind: 'change', statements: statements.length, keywords, reason: `contains ${word[1].split(/\s+/)[0].toUpperCase()}` };
        if (/\bINTO\b/i.test(st) && first === 'SELECT' && !/\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(st)) return { kind: 'change', statements: statements.length, keywords, reason: 'SELECT … INTO creates a table' };
        if (/\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(st)) return { kind: 'change', statements: statements.length, keywords, reason: 'writes a file on the server' };
        if (/\bFOR\s+(UPDATE|SHARE)\b/i.test(st)) return { kind: 'change', statements: statements.length, keywords, reason: 'FOR UPDATE locks rows' };
        if (first === 'USE' && type !== 'sqlserver' && type !== 'mysql') return { kind: 'change', statements: statements.length, keywords, reason: 'USE statement' };
    }
    return { kind: 'read', statements: statements.length, keywords };
}

/**
 * Statements that remove a whole table's data or the table itself: DROP, TRUNCATE, and DELETE or UPDATE
 * without a WHERE clause. They run after one confirmation (as in database tools); everything else runs
 * as the login's permissions allow. null when there is none.
 */
export function dangerous(sql: string, type: DbType | string): string | null {
    if (type === 'mongodb') return /\.(drop|dropDatabase|deleteMany\(\s*\{\s*\})|remove\(\s*\{\s*\}/.test(sql) ? 'drops or empties a collection' : null;
    if (type === 'redis') return /^\s*(FLUSHALL|FLUSHDB)\b/im.test(sql) ? 'empties the database' : null;
    for (const st of stripSql(sql).split(';').map((s) => s.trim()).filter(Boolean)) {
        const w = (/^\(*\s*([A-Za-z]+)/.exec(st)?.[1] ?? '').toUpperCase();
        if (w === 'DROP') return `DROP ${(/^DROP\s+(\w+)/i.exec(st)?.[1] ?? '').toUpperCase()}`.trim();
        if (w === 'TRUNCATE') return 'TRUNCATE';
        if ((w === 'DELETE' || w === 'UPDATE') && !/\bWHERE\b/i.test(st)) return `${w} without WHERE (every row)`;
        if (/\b(DELETE|UPDATE)\b/i.test(st) && w === 'WITH' && !/\bWHERE\b/i.test(st.slice(st.search(/\b(DELETE|UPDATE)\b/i)))) return 'DELETE / UPDATE without WHERE (every row)';
    }
    return null;
}

/** Number of `?` parameters outside strings and comments. */
export function countParams(sql: string): number {
    return (stripSql(sql).match(/\?/g) ?? []).length;
}

/** T-SQL batches: the text between lines that hold only GO (optionally with a count, as in SSMS). */
export function splitGo(sql: string): string[] {
    const out: string[] = [];
    let cur: string[] = [];
    for (const line of sql.split(/\r?\n/)) {
        const m = /^\s*GO(?:\s+(\d+))?\s*;?\s*$/i.exec(line);
        if (!m) { cur.push(line); continue; }
        const text = cur.join('\n');
        if (text.trim()) for (let i = 0; i < Math.min(Number(m[1] ?? 1), 1000); i++) out.push(text);
        cur = [];
    }
    if (cur.join('\n').trim()) out.push(cur.join('\n'));
    return out.length ? out : [sql];
}
