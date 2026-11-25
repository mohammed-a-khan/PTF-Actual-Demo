import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { cellValue, compareRows, compareVitals, describeComparison, normalise } from '../src/db/compare';

test('compare data: the database worker\'s cells as values; rows by key across databases; vital checks', () => {
    // The worker's cells: dates, big numbers and binary as {$t, v}.
    assert.equal(cellValue({ $t: 'date', v: '2026-01-02T10:00:00.000Z' }), '2026-01-02T10:00:00.000Z');
    assert.equal(cellValue({ $t: 'bin', v: 'beef', n: 2 }), '0xbeef');
    assert.equal(cellValue(null), null);
    assert.equal(normalise(cellValue({ $t: 'num', v: '10.50' })), normalise(10.5));
    const pg = [{ order_id: 1, total: '10.50', created_at: { $t: 'date', v: '2026-01-02T10:00:00.000Z' }, active: true }, { order_id: 2, total: '7.00', created_at: { $t: 'date', v: '2026-01-03T10:00:00.000Z' }, active: false }];
    const ms = [{ ORDER_ID: 2, TOTAL: 7, CREATED_AT: '2026-01-03 10:00:00', ACTIVE: 0 }, { ORDER_ID: 1, TOTAL: 10.5, CREATED_AT: '2026-01-02 10:00:00', ACTIVE: 1 }];
    const rows = (x: Array<Record<string, unknown>>) => x.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cellValue(v)])));
    const r = compareRows(rows(pg), rows(ms), { keys: ['order_id'] });
    assert.ok(r.passed, describeComparison(r));
    assert.deepEqual(r.columnsCompared, ['total', 'created_at', 'active']);
    assert.ok(compareVitals(rows(pg), rows(ms)).passed);
    const changed = compareRows(rows(pg), rows([{ ...ms[0], TOTAL: 7.5 }, ms[1]]), { keys: ['order_id'] });
    assert.equal(describeComparison(changed).split('\n')[1], 'order_id=2: total is 7.00 in the source, 7.5 in the target');
});

test('compare data side by side: rows that changed, are missing or extra, with the columns that differ', () => {
    const { alignRows } = require('../src/db/compare') as typeof import('../src/db/compare');
    const qa = [{ order_id: 1, total: '10.50' }, { order_id: 2, total: '20.00' }, { order_id: 3, total: '5.25' }];
    const uat = [{ order_id: 1, total: 10.5 }, { order_id: 2, total: 20.1 }, { order_id: 4, total: 7 }];
    const a = alignRows(qa, uat, { keys: ['order_id'] });
    assert.deepEqual(a.rows.map((r) => [r.key, r.status, r.differing.join(',')]), [['order_id=2', 'differs', 'total'], ['order_id=3', 'missing', ''], ['order_id=4', 'extra', '']]);
    assert.equal(alignRows(qa, uat, { keys: ['order_id'], same: true }).rows.at(-1)?.status, 'same');
});

test('relaxed rules: column patterns per table, dates to the second / minute / day', () => {
    const { ignoreRule } = require('../src/db/compare') as typeof import('../src/db/compare');
    const skip = ignoreRule(['*_at', 'audit_?ser', 'orders.notes', '*.row_version'], 'public.orders');
    assert.deepEqual(['loaded_at', 'AUDIT_USER', 'notes', 'row_version', 'status', 'created'].map(skip), [true, true, true, true, false, false]);
    const other = ignoreRule(['orders.notes'], 'customers');
    assert.equal(other('notes'), false, 'a table-qualified pattern leaves other tables alone');
    assert.equal(ignoreRule(['a.b+c'])('xb+c'), false, 'regex characters are literal');
    const qa = [{ id: 1, created: '2026-01-02T09:15:10.000Z', day: '2026-01-02', loaded_at: 'x' }];
    const uat = [{ id: 1, created: '2026-01-02T09:15:50.000Z', day: '2026-01-02', loaded_at: 'y' }];
    const run = (dates?: 'exact' | 'second' | 'minute' | 'day') => compareRows(qa, uat, { keys: ['id'], ignore: ['*_at'], dates }).passed;
    assert.deepEqual([run(), run('second'), run('minute'), run('day')], [false, false, true, true]);
    assert.ok(compareRows([{ id: 1, created: '2026-01-02T09:00:00Z' }], [{ id: 1, created: '2026-01-02T23:00:00Z' }], { keys: ['id'], dates: 'day' }).passed);
    // The day as written, whatever the offset; a DATE column (local midnight) on its local day.
    assert.equal(normalise('2024-01-02T01:00:00+05:00', { dates: 'day' }), '2024-01-02');
    assert.equal(normalise(new Date(2024, 0, 2), { dates: 'day' }), '2024-01-02');
    // "second" rounds (SQL Server datetime keeps 1/300 s).
    assert.equal(normalise('2024-01-02 03:04:05.997', { dates: 'second' }), normalise('2024-01-02T03:04:06Z', { dates: 'second' }));
    assert.notEqual(normalise('2024-01-02 03:04:05.400', { dates: 'second' }), normalise('2024-01-02T03:04:06Z', { dates: 'second' }));
});

test('relaxed rules route: saved in the project\'s common.env, read back, removed when cleared', async () => {
    const fs = await import('fs'); const os = await import('os'); const path = await import('path');
    const { createServer } = await import('../src/server/server');
    const { runGit } = await import('../src/git/run');
    const { SecretStore } = await import('../src/secrets/store');
    const { KeyFileProtector } = await import('../src/secrets/protector');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-rules-'));
    try {
        const dir = path.join(tmp, 'shop-tests');
        await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        const w = (p: string, t: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); };
        w('config/shop/common/common.env', 'PROJECT=shop\nDB_ENABLED=true\n');
        w('config/shop/environments/qa.env', 'BASE_URL=http://localhost\n');
        const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
        const srv = createServer({ repoRoot: dir, store, userName: 'T', token: 'tk' });
        const call = async (method: string, url: string, payload?: unknown) => { const r = await srv.app.inject({ method: method as any, url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload: payload as any } : {}) }); return { status: r.statusCode, json: r.json() as any }; };
        // A name that is not a column or pattern is refused (not dropped without a word); names in any language are kept.
        const refused = await call('PUT', '/api/db/compare/rules', { project: 'shop', ignore: ['*_at', 'bad;drop'], dates: 'day' });
        assert.equal(refused.status, 400);
        assert.match(JSON.stringify(refused.json), /Not a column name or pattern: \\"bad;drop\\"/);
        const saved = await call('PUT', '/api/db/compare/rules', { project: 'shop', ignore: ['*_at', ' audit_* ', ''], dates: 'day' });
        assert.equal(saved.status, 200, JSON.stringify(saved.json));
        assert.deepEqual(saved.json, { file: 'config/shop/common/common.env', ignore: ['*_at', 'audit_*'], dates: 'day' });
        const env = fs.readFileSync(path.join(dir, 'config/shop/common/common.env'), 'utf8');
        assert.match(env, /^DB_COMPARE_IGNORE=.*\*_at, audit_\*/m);
        assert.match(env, /^DB_COMPARE_DATES=day$/m);
        assert.match(env, /^PROJECT=shop$/m, 'the other keys stay');
        const read = await call('GET', '/api/db/compare/rules?project=shop&environment=qa');
        assert.equal(read.status, 200, JSON.stringify(read.json));
        assert.deepEqual([read.json.ignore, read.json.dates], [['*_at', 'audit_*'], 'day']);
        await call('PUT', '/api/db/compare/rules', { project: 'shop', ignore: [], dates: 'exact' });
        assert.doesNotMatch(fs.readFileSync(path.join(dir, 'config/shop/common/common.env'), 'utf8'), /DB_COMPARE_/);
        await srv.app.close();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
