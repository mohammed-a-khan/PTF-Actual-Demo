/**
 * Browsing and reading MongoDB and Redis like the SQL databases, so the schema browser and the data compare work
 * on them too:
 *  - MongoDB: its collections are the tables; the columns are the fields of a sample of documents (_id the key);
 *    a row is a document, a nested value is shown and compared as JSON.
 *  - Redis: the keys, grouped by their first part (user:1, user:2 → "user:*"; keys without ":" → "(no prefix)"),
 *    are the tables; a row is a key with its type and value (a hash, list, set, sorted set or stream as JSON), so
 *    two environments' keys compare by name.
 * Through the drivers' own clients (the framework's adapters hold them), whatever commands the framework knows.
 */

/** The part of node-redis used here. */
export interface RedisLike { sendCommand(args: string[]): Promise<unknown> }
/** The part of the MongoDB driver's Db used here. */
export interface MongoDbLike {
    databaseName?: string;
    listCollections(filter?: unknown, options?: unknown): { toArray(): Promise<Array<{ name: string; type?: string }>> };
    collection(name: string): {
        estimatedDocumentCount(): Promise<number>;
        find(filter: unknown, options?: unknown): { limit(n: number): { toArray(): Promise<Array<Record<string, unknown>>> } };
    };
}

export interface NoSqlObject { schema: string; name: string; kind: 'table' | 'view'; rows?: number }
export interface NoSqlColumn { name: string; key: boolean; type: string; nullable: boolean }
export interface NoSqlRows { columns: Array<{ name: string; type?: string }>; rows: Array<Record<string, unknown>>; total: number; truncated: boolean }

export const NO_PREFIX = '(no prefix)';
/** The group of a Redis key: its first part and *, or (no prefix). */
export const redisGroup = (key: string) => (key.includes(':') ? `${key.slice(0, key.indexOf(':'))}:*` : NO_PREFIX);

/** Every key matching the pattern (SCAN, never KEYS), up to max. */
async function scan(r: RedisLike, pattern: string, max: number): Promise<{ keys: string[]; more: boolean }> {
    const keys: string[] = [];
    let cursor = '0';
    do {
        const res = await r.sendCommand(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '1000']) as [string | Buffer, Array<string | Buffer>];
        cursor = String(res[0]);
        for (const k of res[1]) { keys.push(String(k)); if (keys.length > max) return { keys: keys.slice(0, max), more: true }; }
    } while (cursor !== '0');
    return { keys, more: false };
}

/** The key groups of a Redis database, with how many keys each has. */
export async function redisObjects(r: RedisLike, maxKeys = 200_000): Promise<{ objects: NoSqlObject[]; capped: boolean }> {
    const { keys, more } = await scan(r, '*', maxKeys);
    const groups = new Map<string, number>();
    for (const k of keys) groups.set(redisGroup(k), (groups.get(redisGroup(k)) ?? 0) + 1);
    const objects = [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([name, rows]) => ({ schema: '', name, kind: 'table' as const, rows }));
    return { objects, capped: more };
}

export const REDIS_COLUMNS: NoSqlColumn[] = [
    { name: 'key', key: true, type: 'string', nullable: false },
    { name: 'type', key: false, type: 'string', nullable: false },
    { name: 'value', key: false, type: 'string', nullable: true },
];

const str = (x: unknown) => (Buffer.isBuffer(x) ? x.toString('utf8') : String(x));
const pairs = (flat: unknown[]) => { const o: Record<string, string> = {}; for (let i = 0; i + 1 < flat.length; i += 2) o[str(flat[i])] = str(flat[i + 1]); return o; };

/** A key's value as text: a string as it is; other types as JSON, in an order that does not depend on the server. */
export async function redisValue(r: RedisLike, key: string, type: string): Promise<string | null> {
    switch (type) {
        case 'string': { const v = await r.sendCommand(['GET', key]); return v === null || v === undefined ? null : str(v); }
        case 'hash': { const o = pairs(await r.sendCommand(['HGETALL', key]) as unknown[]); return JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]))); }
        case 'list': return JSON.stringify((await r.sendCommand(['LRANGE', key, '0', '-1']) as unknown[]).map(str));
        case 'set': return JSON.stringify((await r.sendCommand(['SMEMBERS', key]) as unknown[]).map(str).sort());
        case 'zset': {
            const flat = await r.sendCommand(['ZRANGE', key, '0', '-1', 'WITHSCORES']) as unknown[];
            const out: Array<[string, number]> = [];
            for (let i = 0; i + 1 < flat.length; i += 2) out.push([str(flat[i]), Number(str(flat[i + 1]))]);
            return JSON.stringify(out);
        }
        case 'stream': {
            const entries = await r.sendCommand(['XRANGE', key, '-', '+', 'COUNT', '1000']) as Array<[unknown, unknown[]]>;
            return JSON.stringify(entries.map(([id, f]) => ({ id: str(id), ...pairs(f) })));
        }
        default: return null;
    }
}

/** The keys of a group (or a pattern) with their type and value, sorted by key. */
export async function redisRows(r: RedisLike, group: string, max: number): Promise<NoSqlRows> {
    const pattern = group === NO_PREFIX ? '*' : group;
    if (!/^[^\s]{1,512}$/.test(pattern)) throw new Error('Invalid key pattern.');
    const found = await scan(r, pattern, group === NO_PREFIX ? Math.max(max * 50, 200_000) : max + 1);
    let keys = group === NO_PREFIX ? found.keys.filter((k) => !k.includes(':')) : found.keys;
    keys = [...new Set(keys)].sort();
    const truncated = keys.length > max || (group === NO_PREFIX && found.more);
    const rows: Array<Record<string, unknown>> = [];
    for (const key of keys.slice(0, max)) {
        const type = str(await r.sendCommand(['TYPE', key]));
        if (type === 'none') continue; // expired meanwhile
        rows.push({ key, type, value: await redisValue(r, key, type) });
    }
    return { columns: REDIS_COLUMNS.map((c) => ({ name: c.name, type: c.type })), rows, total: rows.length, truncated };
}

/** A MongoDB value as a cell: an ObjectId as its hex, dates as they are, nested documents and arrays as JSON. */
export function mongoCell(v: unknown): unknown {
    if (v === null || v === undefined) return v ?? null;
    if (v instanceof Date || typeof v !== 'object') return v;
    const o = v as { _bsontype?: string; toHexString?: () => string; toString?: () => string };
    if (o._bsontype === 'ObjectId' || o._bsontype === 'ObjectID') return o.toHexString ? o.toHexString() : String(v);
    if (o._bsontype === 'Decimal128' || o._bsontype === 'Long' || o._bsontype === 'Int32' || o._bsontype === 'Double') return String(v);
    if (Buffer.isBuffer(v)) return v;
    return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && (x._bsontype === 'ObjectId' || x._bsontype === 'ObjectID') ? String(x) : x));
}

const typeOf = (v: unknown) => (v === null || v === undefined ? '' : v instanceof Date ? 'date' : Array.isArray(v) ? 'array'
    : typeof v === 'object' ? ((v as { _bsontype?: string })._bsontype === 'ObjectId' ? 'objectId' : (v as { _bsontype?: string })._bsontype ? String((v as { _bsontype?: string })._bsontype).toLowerCase() : 'object') : typeof v);

export async function mongoObjects(db: MongoDbLike): Promise<NoSqlObject[]> {
    const list = (await db.listCollections({}, { nameOnly: false }).toArray()).filter((c) => !c.name.startsWith('system.'));
    const out: NoSqlObject[] = [];
    for (const c of list.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 2000)) {
        const view = c.type === 'view';
        out.push({ schema: db.databaseName ?? '', name: c.name, kind: view ? 'view' : 'table', ...(view ? {} : { rows: await db.collection(c.name).estimatedDocumentCount().catch(() => undefined as unknown as number) }) });
    }
    return out;
}

/** The fields of a sample of documents, in the order first seen (_id first, the key). */
export async function mongoColumns(db: MongoDbLike, collection: string, sample = 200): Promise<NoSqlColumn[]> {
    const docs = await db.collection(collection).find({}).limit(sample).toArray();
    const cols = new Map<string, { types: Set<string>; missing: boolean }>();
    for (const d of docs) for (const [k, v] of Object.entries(d)) {
        const c = cols.get(k) ?? { types: new Set<string>(), missing: false };
        if (typeOf(v)) c.types.add(typeOf(v));
        cols.set(k, c);
    }
    for (const [k, c] of cols) if (docs.some((d) => !(k in d) || d[k] === null)) c.missing = true;
    const names = [...cols.keys()].sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : 0));
    return names.map((n) => ({ name: n, key: n === '_id', type: [...cols.get(n)!.types].join('|') || 'null', nullable: cols.get(n)!.missing }));
}

/** The documents of a collection as rows (every field seen as a column). */
export async function mongoRows(db: MongoDbLike, collection: string, max: number): Promise<NoSqlRows> {
    const docs = await db.collection(collection).find({}, { sort: { _id: 1 } }).limit(max + 1).toArray();
    const names: string[] = [];
    for (const d of docs) for (const k of Object.keys(d)) if (!names.includes(k)) names.push(k);
    names.sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : 0));
    const rows = docs.slice(0, max).map((d) => Object.fromEntries(names.map((n) => [n, n in d ? mongoCell(d[n]) : null])));
    return { columns: names.map((n) => ({ name: n })), rows, total: rows.length, truncated: docs.length > max };
}

/** The items of a Redis reply as rows: a JSON object item is its fields; anything else is { value }. */
export function redisItems(rows: unknown[]): unknown[] {
    const items = rows.flatMap((r) => (r && typeof r === 'object' && !Array.isArray(r) ? Object.values(r as Record<string, unknown>) : [r])).flat();
    return items.map((v) => {
        if (typeof v === 'string' && /^\s*\{/.test(v)) { try { const o = JSON.parse(v); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch { /* text */ } }
        return { value: v };
    });
}
