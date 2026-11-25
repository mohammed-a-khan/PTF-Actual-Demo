/** A request's history from Git: added, changed (with a diff), renamed and moved (same id), comments not counted as changes, the file renamed, removed. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runGit } from '../src/git/run';
import { requestHistory } from '../src/api/requestHistory';
import { newCollection, newRequest, ApiCollection } from '../src/api/model';

test('the changes of one request, newest first', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rh-'));
    try {
        const g = (...a: string[]) => runGit(a, { cwd: dir });
        await g('init', '-q', '-b', 'main'); await g('config', 'user.name', 'Ada'); await g('config', 'user.email', 'ada@example.test');
        const rel = 'test/shop/api/shop.collection.json';
        fs.mkdirSync(path.join(dir, 'test/shop/api'), { recursive: true });
        const c: ApiCollection = { ...newCollection('Shop'), items: [{ ...newRequest('Other'), id: 'other', url: '/x' }] };
        const commit = async (msg: string, file = rel) => { fs.writeFileSync(path.join(dir, file), JSON.stringify(c, null, 2)); await g('add', '-A'); await g('commit', '-q', '-m', msg); };
        await commit('Start');
        c.items.push({ ...newRequest('Get order'), id: 'get', url: '/orders/{{id}}' });
        await commit('Add Get order');
        (c.items[1] as { url: string }).url = '/v2/orders/{{id}}';
        await commit('Use v2');
        (c.items[0] as { url: string }).url = '/y';
        await commit('Only another request');
        (c.items[1] as { comments?: unknown }).comments = [{ id: 'm1', author: 'Ada', at: '2026-01-01T00:00:00Z', text: 'Why v2?' }];
        await commit('A comment');
        const moved = c.items.pop()!;
        c.items.push({ kind: 'folder', id: 'f', name: 'Orders', items: [{ ...moved, name: 'Get one order' }] });
        await commit('Rename and move');
        await g('mv', rel, 'test/shop/api/orders.collection.json');
        await g('commit', '-q', '-m', 'Rename the file');
        (c.items[1] as { items: unknown[] }).items = [];
        await commit('Remove it', 'test/shop/api/orders.collection.json');
        const h = await requestHistory(dir, 'test/shop/api/orders.collection.json', 'get');
        assert.deepEqual(h.map((x) => `${x.kind}: ${x.message} (${x.author})`), ['removed: Remove it (Ada)', 'changed: Rename and move (Ada)', 'changed: Use v2 (Ada)', 'added: Add Get order (Ada)']);
        const v2 = h.find((x) => x.message === 'Use v2')!;
        assert.match(v2.diff, /^-\s+"url": "\/orders\/\{\{id\}\}",?$/m);
        assert.match(v2.diff, /^\+\s+"url": "\/v2\/orders\/\{\{id\}\}",?$/m);
        assert.deepEqual([v2.added, v2.removed], [1, 1]);
        assert.match(h.find((x) => x.message === 'Rename and move')!.diff, /^\+\s+"name": "Get one order",?$/m);
        assert.deepEqual(await requestHistory(dir, 'test/shop/api/orders.collection.json', 'nope'), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
