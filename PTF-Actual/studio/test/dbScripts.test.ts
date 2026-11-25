import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildDdl, ddlQueries } from '../src/db/ddl';
import { insertScript, literal, tableOfQuery } from '../src/db/inserts';
import { dangerous, splitGo } from '../src/db/safety';

test('dangerous: DROP, TRUNCATE, DELETE / UPDATE without WHERE; everything else runs', () => {
    assert.equal(dangerous('DROP TABLE dbo.orders', 'sqlserver'), 'DROP TABLE');
    assert.equal(dangerous('truncate table t', 'postgresql'), 'TRUNCATE');
    assert.match(dangerous('DELETE FROM orders', 'mysql') ?? '', /without WHERE/);
    assert.match(dangerous('UPDATE orders SET x = 1', 'mysql') ?? '', /without WHERE/);
    assert.equal(dangerous('DELETE FROM orders WHERE id = 5', 'mysql'), null);
    assert.equal(dangerous("UPDATE t SET note = 'DROP TABLE x' WHERE id = 1", 'mysql'), null);
    assert.equal(dangerous('INSERT INTO t VALUES (1)', 'mysql'), null);
    assert.equal(dangerous('EXEC dbo.load_orders', 'sqlserver'), null);
    assert.match(dangerous('WITH x AS (SELECT 1) DELETE FROM t', 'sqlserver') ?? '', /without WHERE/);
    assert.equal(dangerous('db.orders.deleteMany({})', 'mongodb'), 'drops or empties a collection');
    assert.equal(dangerous('FLUSHALL', 'redis'), 'empties the database');
});

test('splitGo: SSMS batches, GO n, GO inside text is not a separator', () => {
    assert.deepEqual(splitGo('CREATE TABLE a (x int)\nGO\nCREATE VIEW v AS SELECT x FROM a\ngo\n'), ['CREATE TABLE a (x int)', 'CREATE VIEW v AS SELECT x FROM a']);
    assert.deepEqual(splitGo('INSERT t VALUES (1)\nGO 3'), ['INSERT t VALUES (1)', 'INSERT t VALUES (1)', 'INSERT t VALUES (1)']);
    assert.deepEqual(splitGo("SELECT 'GO' AS w\nSELECT 2"), ["SELECT 'GO' AS w\nSELECT 2"]);
});

test('ddlQueries: catalogue queries per database, names passed as parameters', () => {
    assert.match(ddlQueries('mysql', 'table', 'shop', 'orders')[0].sql, /^SHOW CREATE TABLE `shop`\.`orders`/);
    const ss = ddlQueries('sqlserver', 'table', 'dbo', 'orders');
    assert.deepEqual(ss.map((x) => x.key).sort(), ['checks', 'columns', 'fks', 'indexes']);
    assert.ok(ss.every((x) => x.params.includes('orders') && !x.sql.includes('orders')));
    assert.deepEqual(ddlQueries('oracle', 'view', 'HR', 'EMP_V')[0].params, ['VIEW', 'EMP_V', 'HR']);
});

test('buildDdl: SQL Server table with identity, defaults, keys, checks, FKs and indexes', () => {
    const sql = buildDdl('sqlserver', 'table', 'dbo', 'orders', {
        columns: [
            { name: 'id', type_name: 'int', max_length: 4, precision: 10, scale: 0, is_nullable: false, is_identity: true, seed: 1, incr: 1 },
            { name: 'name', type_name: 'nvarchar', max_length: 200, is_nullable: true },
            { name: 'amount', type_name: 'decimal', precision: 12, scale: 2, is_nullable: false, default_def: '((0))', default_name: 'DF_orders_amount' },
            { name: 'total', computed_def: '([amount]*(2))', is_persisted: true },
            { name: 'customer_id', type_name: 'int', is_nullable: false },
        ],
        indexes: [
            { index_id: 1, index_name: 'PK_orders', is_primary_key: true, type_desc: 'CLUSTERED', column_name: 'id' },
            { index_id: 2, index_name: 'IX_orders_name', type_desc: 'NONCLUSTERED', column_name: 'name', filter_definition: '([name] IS NOT NULL)' },
            { index_id: 2, index_name: 'IX_orders_name', type_desc: 'NONCLUSTERED', column_name: 'amount', is_included_column: true },
        ],
        checks: [{ check_name: 'CK_amount', definition: '([amount]>=(0))' }],
        fks: [{ fk_name: 'FK_orders_customers', column_name: 'customer_id', ref_schema: 'dbo', ref_table: 'customers', ref_column: 'id', on_delete: 'CASCADE', on_update: 'NO_ACTION' }],
    });
    assert.match(sql, /\[id\] int IDENTITY\(1, 1\) NOT NULL/);
    assert.match(sql, /\[name\] nvarchar\(100\) NULL/);
    assert.match(sql, /\[amount\] decimal\(12, 2\) NOT NULL CONSTRAINT \[DF_orders_amount\] DEFAULT \(\(0\)\)/);
    assert.match(sql, /\[total\] AS \(\[amount\]\*\(2\)\) PERSISTED/);
    assert.match(sql, /CONSTRAINT \[PK_orders\] PRIMARY KEY CLUSTERED \(\[id\]\)/);
    assert.match(sql, /CONSTRAINT \[CK_amount\] CHECK/);
    assert.match(sql, /FOREIGN KEY \(\[customer_id\]\) REFERENCES \[dbo\]\.\[customers\] \(\[id\]\) ON DELETE CASCADE;/);
    assert.match(sql, /CREATE NONCLUSTERED INDEX \[IX_orders_name\] ON \[dbo\]\.\[orders\] \(\[name\]\) INCLUDE \(\[amount\]\) WHERE \(\[name\] IS NOT NULL\);/);
    assert.equal(splitGo(sql).length, 3);
});

test('buildDdl: PostgreSQL serial, identity, constraints, FKs after the table, view and function', () => {
    const sql = buildDdl('postgresql', 'table', 'public', 'orders', {
        columns: [
            { column_name: 'id', type_name: 'integer', default_def: "nextval('orders_id_seq'::regclass)", not_null: true },
            { column_name: 'code', type_name: 'bigint', identity: 'a', not_null: true },
            { column_name: 'qty', type_name: 'integer', default_def: '1' },
            { column_name: 'doubled', type_name: 'integer', generated: 's', default_def: '(qty * 2)' },
        ],
        constraints: [
            { constraint_name: 'orders_pkey', kind: 'p', definition: 'PRIMARY KEY (id)' },
            { constraint_name: 'orders_customer_fk', kind: 'f', definition: 'FOREIGN KEY (qty) REFERENCES customers(id)' },
        ],
        indexes: [{ definition: 'CREATE INDEX ix_qty ON public.orders USING btree (qty)' }],
    });
    assert.match(sql, /"id" serial NOT NULL/);
    assert.match(sql, /"code" bigint GENERATED ALWAYS AS IDENTITY NOT NULL/);
    assert.match(sql, /"qty" integer DEFAULT 1/);
    assert.match(sql, /"doubled" integer GENERATED ALWAYS AS \(\(qty \* 2\)\) STORED/);
    assert.ok(sql.indexOf('ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_customer_fk"') > sql.indexOf(');'));
    assert.match(sql, /CREATE INDEX ix_qty .*;\n/);
    assert.match(buildDdl('postgresql', 'view', 'public', 'v', { view: [{ definition: ' SELECT 1;', relkind: 'v' }] }), /^CREATE OR REPLACE VIEW "public"\."v" AS\nSELECT 1;/);
    assert.throws(() => buildDdl('sqlserver', 'procedure', 'dbo', 'p', { module: [] }), /VIEW DEFINITION/);
    assert.equal(buildDdl('mysql', 'table', '', 'orders', { show: [{ Table: 'orders', 'Create Table': 'CREATE TABLE `orders` (x int)' }] }), 'CREATE TABLE `orders` (x int);\n');
});

test('literal: each database’s syntax', () => {
    assert.equal(literal('sqlserver', "O'Brien"), "'O''Brien'");
    assert.equal(literal('sqlserver', 'Zürich'), "N'Zürich'");
    assert.equal(literal('postgresql', 'Zürich'), "'Zürich'");
    assert.equal(literal('postgresql', true), 'TRUE');
    assert.equal(literal('mysql', false), '0');
    assert.equal(literal('mysql', '12.50', { name: 'amount', type: 'decimal' }), '12.50');
    assert.equal(literal('mysql', '12.50', { name: 'code', type: 'varchar' }), "'12.50'");
    const d = { $t: 'date' as const, v: '2026-11-01T10:20:30.123Z' };
    assert.equal(literal('mysql', d), "'2026-11-01 10:20:30.123'");
    assert.equal(literal('sqlserver', d), "'2026-11-01T10:20:30.123'");
    assert.equal(literal('oracle', d), "TIMESTAMP '2026-11-01 10:20:30.123'");
    assert.equal(literal('postgresql', { $t: 'bin', v: 'cafe', n: 2 }), "'\\xcafe'::bytea");
    assert.equal(literal('sqlserver', { $t: 'bin', v: 'cafe', n: 2 }), '0xcafe');
    assert.equal(literal('sqlserver', { $t: 'bin', v: 'cafe', n: 200 }), null);
    assert.equal(literal('mysql', { $t: 'text', v: 'x', n: 99999 }), null);
    assert.equal(literal('mysql', null), 'NULL');
});

test('insertScript: rows per statement, chosen columns, identity insert, Oracle INSERT ALL, warnings', () => {
    const cols = [{ name: 'id', type: 'int' }, { name: 'name', type: 'nvarchar' }, { name: 'doc', type: 'varbinary' }];
    const rows = [[1, 'a', null], [2, 'b', { $t: 'bin' as const, v: '00', n: 500 }], [3, null, null]];
    const one = insertScript('sqlserver', cols, rows, { table: 'dbo.items', columns: ['id', 'name'], identityInsert: true });
    assert.equal(one.statements, 3);
    assert.equal(one.sql.split('\n')[0], 'SET IDENTITY_INSERT [dbo].[items] ON;');
    assert.match(one.sql, /INSERT INTO \[dbo\]\.\[items\] \(\[id\], \[name\]\) VALUES \(3, NULL\);/);
    assert.deepEqual(one.warnings, []);
    const multi = insertScript('postgresql', cols, rows, { table: 'items', rowsPerStatement: 2 });
    assert.equal(multi.statements, 2);
    assert.match(multi.warnings[0], /doc/);
    const ora = insertScript('oracle', cols.slice(0, 2), rows, { table: 'ITEMS', rowsPerStatement: 10 });
    assert.match(ora.sql, /^INSERT ALL\n {4}INTO "ITEMS"/);
    assert.match(ora.sql, /SELECT 1 FROM DUAL;\n$/);
    assert.throws(() => insertScript('mysql', cols, rows, { table: ' ' }), /Name the table/);
    assert.equal(tableOfQuery('SELECT TOP 10 * FROM [dbo].[orders] o WHERE 1=1'), '[dbo].[orders]');
    assert.equal(tableOfQuery('select * from shop.orders'), 'shop.orders');
});
