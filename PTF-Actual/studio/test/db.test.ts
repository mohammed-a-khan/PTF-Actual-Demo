import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classify, countParams, stripSql } from '../src/db/safety';
import { listConnections, protectedEnvironment } from '../src/db/connections';
import { cellText, columnsOf, expectedText, toCell } from '../src/db/cells';
import { dbFeature } from '../src/db/feature';
import { columnsSql, objectsSql, selectSql, toColumns, toObjects } from '../src/db/schema';
import { DbSessions } from '../src/db/sessions';

test('classify: reads vs changes, ignoring strings, quoted names and comments', () => {
    const r = (sql: string, t = 'sqlserver') => classify(sql, t).kind;
    assert.equal(r("SELECT * FROM orders WHERE note = 'DELETE everything; DROP TABLE x'"), 'read');
    assert.equal(r('SELECT [update], "delete" FROM t -- DROP TABLE t'), 'read');
    assert.equal(r('/* UPDATE t SET a = 1 */ SELECT 1'), 'read');
    assert.equal(r("SELECT REPLACE(name, 'a', 'b'), comment, lock_flag FROM t"), 'read', 'functions and columns named like keywords');
    assert.equal(r('WITH x AS (SELECT 1 AS a) SELECT * FROM x'), 'read');
    assert.equal(r('SELECT 1; SELECT 2'), 'read');
    assert.equal(r('select * from t for update'), 'change');
    assert.equal(r('UPDATE t SET a = 1'), 'change');
    assert.equal(r('  delete from t'), 'change');
    assert.equal(r('WITH x AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM x)'), 'change');
    assert.equal(r('SELECT * INTO backup_t FROM t'), 'change');
    assert.equal(r('EXEC sales.get_customer_orders 1'), 'change', 'procedures may write');
    assert.equal(r('SELECT 1; DROP TABLE t'), 'change');
    assert.equal(r('TRUNCATE TABLE t'), 'change');
    assert.equal(r("SELECT $$ DROP TABLE t $$ AS body", 'postgresql'), 'read', 'dollar-quoted text');
    assert.equal(r('SHOW TABLES', 'mysql'), 'read');
    assert.equal(r("SELECT * FROM t INTO OUTFILE '/tmp/x'", 'mysql'), 'change');
    assert.equal(r('db.orders.find({ status: "NEW" }).limit(10)', 'mongodb'), 'read');
    assert.equal(r('db.orders.deleteMany({})', 'mongodb'), 'change');
    assert.equal(r('db.orders.aggregate([{ $match: {} }, { $out: "x" }])', 'mongodb'), 'change');
    assert.equal(r('GET user:1', 'redis'), 'read');
    assert.equal(r('DEL user:1', 'redis'), 'change');
    assert.equal(classify('UPDATE t SET a = 1', 'sqlserver').reason, 'UPDATE statement');
    assert.equal(r("DECLARE @c CHAR(2) = 'GB'; SET NOCOUNT ON; SELECT * FROM t WHERE country = @c"), 'read', 'T-SQL variables and options');
    assert.equal(r("WAITFOR DELAY '00:00:01'; SELECT 1"), 'read');
    assert.equal(r('DECLARE @id INT = 1; UPDATE t SET a = 1 WHERE id = @id'), 'change');
    assert.equal(r('SET @x = (SELECT 1); DELETE FROM t'), 'change');
    assert.equal(r("DECLARE @x INT = 1; SELECT 1", 'postgresql'), 'change', 'only T-SQL scripts start this way');
    assert.equal(countParams("SELECT * FROM t WHERE a = ? AND b = '?' AND c = ? -- ?"), 2);
    assert.equal(stripSql("a 'it''s' b").replace(/\s+/g, ' ').trim(), 'a x b');
});

test('connections: aliases from DB_<ALIAS>_TYPE and DATABASE_CONNECTIONS, defaults and problems like the framework', () => {
    const list = listConnections({
        DB_ORDERS_TYPE: 'postgresql', DB_ORDERS_HOST: 'pg.local', DB_ORDERS_DATABASE: 'orders', DB_ORDERS_USERNAME: 'u', DB_ORDERS_PASSWORD: 'p', DB_ORDERS_STUDIO_READONLY: 'true',
        DB_LEGACY_HOST: 'sql01', DB_LEGACY_DATABASE: 'crm', DB_LEGACY_TRUSTED_CONNECTION: 'true', DB_LEGACY_TYPE: 'sqlserver', DB_LEGACY_REQUEST_TIMEOUT: '45000',
        DATABASE_CONNECTIONS: 'orders, broken', DB_ODD_TYPE: 'db2', DB_QUERY_TYPE: 'not a connection',
    });
    assert.deepEqual(list.map((c) => c.alias), ['BROKEN', 'LEGACY', 'ODD', 'ORDERS']);
    const o = list.find((c) => c.alias === 'ORDERS')!;
    assert.deepEqual([o.type, o.port, o.passwordSet, o.readOnlyByConfig, o.problems], ['postgresql', 5432, true, true, []]);
    const l = list.find((c) => c.alias === 'LEGACY')!;
    assert.deepEqual([l.port, l.trusted, l.problems, l.queryTimeoutMs], [1433, true, [], 45000]);
    assert.deepEqual(list.find((c) => c.alias === 'BROKEN')!.problems, ['DB_BROKEN_HOST is missing.', 'DB_BROKEN_DATABASE is missing.', 'DB_BROKEN_USERNAME is missing.', 'DB_BROKEN_PASSWORD is missing (or DB_BROKEN_TRUSTED_CONNECTION=true for Windows authentication).']);
    assert.match(list.find((c) => c.alias === 'ODD')!.problems[0], /DB_ODD_TYPE is "db2"/);
    assert.ok(!JSON.stringify(list).includes('"p"'), 'no password value');
    for (const e of ['prod', 'PROD', 'production', 'prd', 'live', 'uk-prod', 'prod2', 'prod_eu']) assert.ok(protectedEnvironment(e, {}), e);
    for (const e of ['dev', 'sit', 'uat', 'preprod-like', 'product', 'qa']) assert.equal(protectedEnvironment(e, {}), e === 'preprod-like' ? protectedEnvironment(e, {}) : null, e);
    assert.match(protectedEnvironment('uat', { STUDIO_DB_READONLY: 'true' })!, /STUDIO_DB_READONLY/);
});

test('cells: driver values to JSON, readable types, and the text a step needs to expect them', () => {
    const d = new Date('2026-11-01T10:20:30.000Z');
    assert.deepEqual(toCell(d), { $t: 'date', v: '2026-11-01T10:20:30.000Z' });
    assert.deepEqual(toCell(Buffer.from([0x89, 0x50])), { $t: 'bin', v: '8950', n: 2 });
    assert.deepEqual(toCell(12n), { $t: 'big', v: '12' });
    assert.deepEqual(toCell({ tier: 1 }), { $t: 'json', v: '{"tier":1}' });
    assert.equal((toCell('x'.repeat(40000)) as { n: number }).n, 40000);
    assert.equal(toCell(undefined), null);
    assert.deepEqual(columnsOf({ fields: [{ name: 'a', dataType: 23 }, { name: 'b', type: 'NEWDECIMAL' }, { name: 'c', dataType: 'string' }], rows: [{ a: 1, b: '1.50', c: d }] }), [{ name: 'a', type: 'integer' }, { name: 'b', type: 'newdecimal' }, { name: 'c', type: 'date' }]);
    assert.deepEqual(columnsOf({ rows: [{ x: 1, y: null }] }), [{ name: 'x', type: 'number' }, { name: 'y', type: '' }]);
    assert.equal(expectedText(null), 'null');
    assert.equal(expectedText(10.5), '10.5');
    assert.equal(expectedText('10.50'), '10.50');
    assert.equal(expectedText(true), 'true');
    assert.equal(expectedText({ $t: 'date', v: d.toISOString() }), '2026-11-01T10:20:30.000Z');
    assert.equal(expectedText('2026-13-45 not a date'), null);
    assert.equal(expectedText('null'), null);
    assert.equal(expectedText('a\nb'), null);
    assert.equal(expectedText({ $t: 'json', v: '{}' }), null);
    assert.equal(cellText({ $t: 'bin', v: 'ff', n: 1 }), '0xff');
});

test('feature: connect, query (file / inline / parameters), chosen checks, exact expected values, warnings', () => {
    const result = { columns: [{ name: 'customer_id', type: 'integer' }, { name: 'name', type: 'string' }, { name: 'credit', type: 'number' }, { name: 'created', type: 'date' }, { name: 'photo', type: 'binary' }],
        rows: [[1, 'Asha | Rao', 10.5, { $t: 'date', v: '2026-11-01T00:00:00.000Z' }, { $t: 'bin', v: 'ff', n: 1 }], [2, "O'Brien", null, { $t: 'date', v: '2026-11-02T00:00:00.000Z' }, null]] as never,
        total: 2, truncated: false };
    const f = dbFeature({ name: 'Customers check', alias: 'SHOP', file: 'test/p/queries/customers.sql', result, checks: { rowCount: 'exact', columns: true, rows: 2, firstRow: true } });
    const t = f.text;
    assert.match(t, /^@database @customers-check\nFeature: Customers check/);
    assert.match(t, /Given user connects to "SHOP" database\n {4}When user executes query from file "test\/p\/queries\/customers.sql"\n {4}Then the query result should have 2 rows\n {4}And the result should have columns:\n {6}\| customer_id \|/);
    assert.match(t, /And the result should match:\n {6}\| customer_id \| credit \| created +\|\n {6}\| 1 +\| 10\.5 +\| 2026-11-01T00:00:00\.000Z \|\n {6}\| 2 +\| null +\| 2026-11-02T00:00:00\.000Z \|/);
    assert.ok(f.warnings.some((w) => /name, photo/.test(w)), 'name (has |) and photo (binary) are left out of the table');
    assert.match(t, /And the value in row 1 column "name" should be "Asha \| Rao"/);
    assert.match(t, /And the value in row 1 column "credit" should be "10.5"/);
    assert.ok(!/column "photo"/.test(t));
    assert.match(t, /And user disconnects from database\n$/);
    const p = dbFeature({ name: 'By id', alias: 'SHOP', sql: 'SELECT name\nFROM c WHERE id = ?', params: ['42'], result: { ...result, rows: [result.rows[1]], total: 1 }, checks: { rowCount: 'atLeast', columns: false, rows: 0, firstRow: true } });
    assert.match(p.text, /When user executes parameterized query "SELECT name FROM c WHERE id = \?" with parameters:\n {6}\| 42 \|\n {4}Then the query result should have at least 1 rows/);
    assert.match(p.text, /And the value in row 1 column "name" should be "O'Brien"/);
    assert.match(p.text, /And the value in row 1 column "credit" should be null/);
    const big = dbFeature({ name: 'Big', alias: 'SHOP', sql: 'SELECT * FROM orders', result: { ...result, total: 50000, truncated: true }, checks: { rowCount: 'exact', columns: false, rows: 2, firstRow: false } });
    assert.ok(!/should match/.test(big.text) && big.warnings.some((w) => /needs all of them/.test(w)));
    assert.match(big.text, /should have 50000 rows/);
    const empty = dbFeature({ name: 'None', alias: 'SHOP', sql: "SELECT * FROM t WHERE x = '{config:REGION}'", result: { columns: [], rows: [], total: 0, truncated: false }, checks: { rowCount: 'exact', columns: true, rows: 0, firstRow: true } });
    assert.match(empty.text, /Then the query result should be empty/);
    assert.ok(empty.warnings.some((w) => /fills them in/.test(w)));
});

test('schema: catalogue queries per database, names as parameters, rows to objects and columns', () => {
    for (const t of ['sqlserver', 'postgresql', 'mysql', 'oracle']) { assert.ok(objectsSql(t)); assert.ok(columnsSql(t, 's', 't')); }
    assert.equal(objectsSql('redis'), null);
    assert.deepEqual(columnsSql('postgresql', "a'b", 'c')![1], ["a'b", 'c'], 'names are parameters');
    assert.equal(selectSql('sqlserver', 'sales', 'or]ders', 100), 'SELECT TOP 100 * FROM [sales].[or]]ders]');
    assert.equal(selectSql('postgresql', 'sales', 'x"y'), 'SELECT * FROM "sales"."x""y" LIMIT 100');
    assert.equal(selectSql('mysql', 'db', 'orders', 5), 'SELECT * FROM `orders` LIMIT 5');
    assert.deepEqual(toObjects([{ SCHEMA_NAME: 'S', OBJECT_NAME: 'T', KIND: 'TABLE', ROW_ESTIMATE: '12' }, { schema_name: 's', object_name: 'p', kind: 'procedure', row_estimate: null }]),
        [{ schema: 'S', name: 'T', kind: 'table', rows: 12 }, { schema: 's', name: 'p', kind: 'procedure' }]);
    assert.deepEqual(toColumns([{ column_name: 'id', data_type: 'int', nullable: 0, is_key: 1, column_default: null }, { column_name: 'n', data_type: 'text', nullable: true, is_key: false, column_default: "'x'" }]),
        [{ name: 'id', type: 'int', nullable: false, key: true }, { name: 'n', type: 'text', nullable: true, key: false, default: "'x'" }]);
});

test('sessions: one process per project/environment, answers, deadline stops it, Stop, environment passed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbs-'));
    const worker = path.join(dir, 'fake-worker.js');
    fs.writeFileSync(worker, `process.on('message', (m) => {
  if (m.op === 'env') return process.send({ id: m.id, result: { secret: process.env.LAB_SECRET, project: process.env.PROJECT, args: process.argv.slice(2), cwd: process.cwd() } });
  if (m.op === 'slow') return setTimeout(() => process.send({ id: m.id, result: 'late' }), 60000);
  if (m.op === 'fail') return process.send({ id: m.id, error: 'boom', code: 'X' });
  if (m.op === 'oom') { const a = []; for (;;) a.push(new Array(1e6).fill(1)); }
  process.send({ id: m.id, result: { pid: process.pid } });
}); process.send({ ready: true });`);
    const s = new DbSessions({ repoRoot: dir, env: (p, e) => ({ LAB_SECRET: `s-${p}-${e}` }), workerFile: worker, memoryMb: 64 });
    try {
        const a = await s.request<{ pid: number }>('p', 'dev', { op: 'x' }, 5000);
        const b = await s.request<{ pid: number }>('p', 'dev', { op: 'x' }, 5000);
        const c = await s.request<{ pid: number }>('p', 'sit', { op: 'x' }, 5000);
        assert.equal(a.pid, b.pid); assert.notEqual(a.pid, c.pid);
        assert.deepEqual(await s.request('p', 'dev', { op: 'env' }, 5000), { secret: 's-p-dev', project: 'p', args: ['p', 'dev'], cwd: fs.realpathSync(dir) });
        await assert.rejects(s.request('p', 'dev', { op: 'fail' }, 5000), (e: Error & { code?: string }) => e.message === 'boom' && e.code === 'X');
        const t = Date.now();
        await assert.rejects(s.request('p', 'dev', { op: 'slow' }, 500), /No answer within 1 s: the query was stopped/);
        assert.ok(Date.now() - t < 2000);
        const d = await s.request<{ pid: number }>('p', 'dev', { op: 'x' }, 5000);
        assert.notEqual(d.pid, a.pid, 'a new process after the stop');
        const slow = s.request('p', 'dev', { op: 'slow' }, 30000);
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(s.running('p', 'dev'), true);
        assert.equal(s.stop('p', 'dev'), true);
        await assert.rejects(slow, /Stopped/);
        await assert.rejects(s.request('p', 'big', { op: 'oom' }, 30000), /too large for the Studio/);
    } finally { s.stopAll(); fs.rmSync(dir, { recursive: true, force: true }); }
});
