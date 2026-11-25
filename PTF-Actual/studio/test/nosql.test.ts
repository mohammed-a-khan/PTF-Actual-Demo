import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mongoCell, mongoColumns, MongoDbLike, mongoObjects, mongoRows, NO_PREFIX, redisGroup, redisItems, RedisLike, redisObjects, redisRows } from '../src/db/nosql';
import { procedureCall } from '../src/data/source';
import { listConnections } from '../src/db/connections';

/** A Redis server in memory, answering the commands as node-redis' sendCommand gives them. */
function fakeRedis(data: Record<string, { type: string; v: unknown }>): RedisLike & { sent: string[][] } {
    const sent: string[][] = [];
    const glob = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    return {
        sent,
        async sendCommand(a: string[]) {
            sent.push(a);
            const [cmd, ...x] = a;
            if (cmd === 'SCAN') {
                // Two pages, as a real server may answer.
                const keys = Object.keys(data).filter((k) => glob(x[2]).test(k));
                const half = Math.ceil(keys.length / 2);
                return x[0] === '0' ? ['17', keys.slice(0, half)] : ['0', keys.slice(half)];
            }
            const e = data[x[0]];
            if (cmd === 'TYPE') return e ? e.type : 'none';
            if (cmd === 'GET') return e?.v;
            if (cmd === 'HGETALL') return Object.entries(e.v as Record<string, string>).flat();
            if (cmd === 'LRANGE' || cmd === 'SMEMBERS') return e.v;
            if (cmd === 'ZRANGE') return (e.v as Array<[string, number]>).flatMap(([m, s]) => [m, String(s)]);
            throw new Error(`fake: ${cmd}`);
        },
    };
}

test('Redis: keys grouped as tables; a group read as rows (key, type, value), values in a stable order', async () => {
    const r = fakeRedis({
        'user:2': { type: 'hash', v: { name: 'Bob', city: 'Leeds' } }, 'user:1': { type: 'hash', v: { city: 'York', name: 'Ann' } },
        'queue:orders': { type: 'list', v: ['SO-1', 'SO-2'] }, 'tags:mug': { type: 'set', v: ['gift', 'blue'] },
        board: { type: 'zset', v: [['ann', 10], ['bob', 20]] }, flag: { type: 'string', v: 'on' },
    });
    assert.deepEqual([redisGroup('user:1:cart'), redisGroup('flag')], ['user:*', NO_PREFIX]);
    const o = await redisObjects(r);
    assert.deepEqual(o.objects.map((x) => [x.name, x.rows]), [[NO_PREFIX, 2], ['queue:*', 1], ['tags:*', 1], ['user:*', 2]]);
    assert.equal(o.capped, false);
    assert.ok(r.sent.every((c) => c[0] !== 'KEYS'), 'SCAN, never KEYS (which blocks a server)');
    const u = await redisRows(r, 'user:*', 100);
    assert.deepEqual(u.rows, [{ key: 'user:1', type: 'hash', value: '{"city":"York","name":"Ann"}' }, { key: 'user:2', type: 'hash', value: '{"city":"Leeds","name":"Bob"}' }], 'fields sorted: the same hash compares equal whatever the server order');
    const n = await redisRows(r, NO_PREFIX, 100);
    assert.deepEqual(n.rows.map((x) => [x.key, x.value]), [['board', '[["ann",10],["bob",20]]'], ['flag', 'on']]);
    assert.equal((await redisRows(r, 'tags:*', 100)).rows[0].value, '["blue","gift"]', 'a set sorted');
    assert.equal((await redisRows(r, 'user:*', 1)).truncated, true);
    // A function's reply (FCALL): each item a row; a JSON object item gives columns.
    assert.deepEqual(redisItems([{ item_0: '{"id":"user:3","name":"Cy"}' }, { item_1: 'plain' }]), [{ id: 'user:3', name: 'Cy' }, { value: 'plain' }]);
    assert.equal(procedureCall('redis', 'users_in', 2), 'FCALL users_in 0 $1 $2');
    assert.throws(() => procedureCall('mongodb', 'x', 0), /MongoDB has no stored procedures: use a query source with the aggregation/);
});

test('MongoDB: collections as tables; fields of a sample as columns (_id the key); documents as rows', async () => {
    const oid = (h: string) => ({ _bsontype: 'ObjectId', toHexString: () => h, toString: () => h });
    const docs: Record<string, Array<Record<string, unknown>>> = {
        orders: [
            { _id: oid('a1'), number: 'SO-1', total: 10.5, lines: [{ sku: 'M', qty: 2 }], placed: new Date('2026-01-02T00:00:00Z') },
            { _id: oid('a2'), number: 'SO-2', total: 7, note: 'gift' },
        ],
    };
    const db: MongoDbLike = {
        databaseName: 'shop',
        listCollections: () => ({ toArray: async () => [{ name: 'orders' }, { name: 'open_orders', type: 'view' }, { name: 'system.views' }] }),
        collection: (name: string) => ({ estimatedDocumentCount: async () => (docs[name] ?? []).length, find: () => ({ limit: (n: number) => ({ toArray: async () => (docs[name] ?? []).slice(0, n) }) }) }),
    };
    assert.deepEqual(await mongoObjects(db), [{ schema: 'shop', name: 'open_orders', kind: 'view' }, { schema: 'shop', name: 'orders', kind: 'table', rows: 2 }]);
    const cols = await mongoColumns(db, 'orders');
    assert.deepEqual(cols.map((c) => [c.name, c.key, c.type, c.nullable]), [['_id', true, 'objectId', false], ['number', false, 'string', false], ['total', false, 'number', false], ['lines', false, 'array', true], ['placed', false, 'date', true], ['note', false, 'string', true]]);
    const rows = await mongoRows(db, 'orders', 10);
    assert.deepEqual(rows.columns.map((c) => c.name), ['_id', 'number', 'total', 'lines', 'placed', 'note']);
    assert.deepEqual(rows.rows[0], { _id: 'a1', number: 'SO-1', total: 10.5, lines: '[{"sku":"M","qty":2}]', placed: new Date('2026-01-02T00:00:00Z'), note: null });
    assert.equal((await mongoRows(db, 'orders', 1)).truncated, true);
    assert.equal(mongoCell({ _bsontype: 'Decimal128', toString: () => '10.50' }), '10.50');
});

test('connections: Redis needs only a host; MongoDB a host and database (credentials only when the server asks)', () => {
    const c = listConnections({ DB_CACHE_TYPE: 'redis', DB_CACHE_HOST: 'h', DB_DOCS_TYPE: 'mongodb', DB_DOCS_HOST: 'h', DB_SQL_TYPE: 'postgresql', DB_SQL_HOST: 'h', DB_SQL_DATABASE: 'd' });
    const p = Object.fromEntries(c.map((x) => [x.alias, x.problems]));
    assert.deepEqual(p.CACHE, []);
    assert.deepEqual(p.DOCS, ['DB_DOCS_DATABASE is missing.']);
    assert.deepEqual(p.SQL, ['DB_SQL_USERNAME is missing.', 'DB_SQL_PASSWORD is missing (or DB_SQL_TRUSTED_CONNECTION=true for Windows authentication).']);
});
