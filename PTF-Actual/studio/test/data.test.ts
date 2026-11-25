import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { asText, describeSource, procedureCall, textRows, validSource } from '../src/data/source';
import { LoadEngine } from '../src/load/engine';
import { newScenario, validScenario } from '../src/load/scenario';
import { newRequest } from '../src/api/model';

test('validSource: each kind and its required parts; no paths outside the project', () => {
    assert.equal(validSource({ kind: 'file', file: 'test/p/data/users.xlsx', sheet: 'Login' }).sheet, 'Login');
    assert.throws(() => validSource({ kind: 'file', file: '../secrets.csv' }), /file in the project/);
    assert.throws(() => validSource({ kind: 'file', file: '/etc/passwd.csv' }), /file in the project/);
    assert.throws(() => validSource({ kind: 'file', file: 'notes.txt' }), /file in the project/);
    assert.throws(() => validSource({ kind: 'query', connection: 'SHOP', sql: ' ' }), /the query/);
    assert.throws(() => validSource({ kind: 'query', connection: 'a b', sql: 'select 1' }), /connection/);
    assert.ok(validSource({ kind: 'procedure', connection: 'SHOP', procedure: 'sales.get_orders', params: ['10', '{config:STATUS}'] }));
    assert.throws(() => validSource({ kind: 'procedure', connection: 'SHOP', procedure: 'x; DROP TABLE y' }), /procedure name/);
    assert.throws(() => validSource({ kind: 'api', collection: 'test/p/api/c.collection.json' }), /request/);
    assert.ok(validSource({ kind: 'generate', generate: '50:id=number,email=email' }));
    assert.throws(() => validSource({ kind: 'generate', generate: '500000:id=number' }), /at most/);
    assert.throws(() => validSource({ kind: 'file', file: 'a.csv', limit: 0 }), /limit/);
    assert.throws(() => validSource({ kind: 'ftp' }), /unknown kind/);
});

test('procedureCall: as the framework calls procedures, per database', () => {
    assert.equal(procedureCall('sqlserver', 'sales.get_orders', 2), 'EXEC sales.get_orders ?, ?');
    assert.equal(procedureCall('sqlserver', 'dbo.p', 0), 'EXEC dbo.p');
    assert.equal(procedureCall('mysql', 'get_orders', 1), 'CALL get_orders(?)');
    assert.equal(procedureCall('postgresql', 'sales.order_count', 1), 'SELECT * FROM sales.order_count(?)');
    assert.equal(procedureCall('postgresql', 'sales.touch', 1, 'procedure'), 'CALL sales.touch(?)');
    assert.equal(procedureCall('oracle', 'pkg.rows_of', 1), 'SELECT * FROM TABLE(pkg.rows_of(?))');
    assert.equal(procedureCall('redis', 'x', 0), 'FCALL x 0', 'a Redis 7 function');
    assert.throws(() => procedureCall('cassandra', 'x', 0), /not available/);
});

test('textRows / asText: values as the requests use them; columns in order', () => {
    const r = textRows([{ id: 1, at: new Date('2026-01-02T03:04:05.000Z'), on: true, n: null, o: { a: [1] }, big: 12345678901234567890n, bin: Buffer.from([1, 255]) }, { id: 2, extra: 'x' }, 'plain']);
    assert.deepEqual(r.columns, ['id', 'at', 'on', 'n', 'o', 'big', 'bin', 'extra', 'value']);
    assert.deepEqual(r.rows[0], { id: '1', at: '2026-01-02T03:04:05.000Z', on: 'true', n: '', o: '{"a":[1]}', big: '12345678901234567890', bin: '01ff' });
    assert.deepEqual(r.rows[2], { value: 'plain' });
    assert.equal(asText(undefined), '');
    assert.equal(describeSource({ kind: 'procedure', connection: 'SHOP', procedure: 'p', params: ['1'], filter: 'a=1', limit: 5 }), 'SHOP: p(1) (where a=1, first 5)');
});

test('scenario: data from any source; "unique" uses each row once and ends the test', async () => {
    const sc = newScenario('S', 'test/p/api/c.collection.json');
    assert.ok(validScenario({ ...sc, data: { source: { kind: 'query', connection: 'SHOP', sql: 'select id from accounts' }, mode: 'unique' } }));
    assert.throws(() => validScenario({ ...sc, data: { source: { kind: 'query', connection: 'SHOP' }, mode: 'unique' } }), /the query/);
    assert.throws(() => validScenario({ ...sc, data: { file: 'a.csv', mode: 'everyOther' } }), /how data rows are used/);
    const seen: string[] = [];
    const s = http.createServer((req, res) => { seen.push(new URL(req.url!, 'http://x').searchParams.get('id')!); setTimeout(() => res.end('{}'), 5); });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    try {
        const port = (s.address() as { port: number }).port;
        const req = { ...newRequest('Get', 'get'), url: `http://127.0.0.1:${port}/a`, query: [{ key: 'id', value: '{{id}}' }] };
        const rows = Array.from({ length: 23 }, (_, i) => ({ id: String(i + 1) }));
        const r = await new LoadEngine({ scenario: { ...validScenario({ ...sc, policy: { type: 'constant', users: 4, duration: 30 }, thinkTime: { min: 0, max: 0 }, data: { source: { kind: 'generate', generate: '1' }, mode: 'unique' } }) },
            collection: { baseUrl: '', auth: { type: 'none' } }, requests: [req], values: { vars: {}, config: {}, env: {} }, rows }).run();
        assert.equal(r.stopReason, 'data-used');
        assert.deepEqual([...seen].sort((a, b) => Number(a) - Number(b)), rows.map((x) => x.id), 'each row exactly once');
        assert.ok(r.elapsed < 10, `ended early (${r.elapsed} s)`);
    } finally { s.close(); }
});
