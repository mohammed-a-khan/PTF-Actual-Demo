/**
 * Editing a work item from the Studio: what it can be set to (the type's states, iterations, areas, the teams'
 * people); a save sends only the changed fields, checks the revision read (a newer change by someone else is not
 * overwritten), and adds the comment.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runGit } from '../src/git/run';
import { SecretStore } from '../src/secrets/store';
import { KeyFileProtector } from '../src/secrets/protector';

test('options, then a save: only the changes, with the revision check and the comment', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wi-'));
    const dir = path.join(tmp, 'repo');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    fs.mkdirSync(path.join(dir, 'config/shop/environments'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config/global.env'), 'BASE_URL=http://localhost\nADO_ORGANIZATION=acme\nADO_PROJECT=qa\n');
    fs.writeFileSync(path.join(dir, 'config/shop/environments/qa.env'), 'ENVIRONMENT=qa\n');
    const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
    store.set({ name: 'ADO_PAT' }, 'pat-1');
    const calls: Array<{ m: string; p: string; b: unknown }> = [];
    let current = 7;
    const transport = async (req: { url: string; method: string; body?: string }) => {
        const u = new URL(req.url);
        const json = (b: unknown) => ({ status: 200, body: JSON.stringify(b) });
        calls.push({ m: req.method, p: u.pathname.replace(/^.*_apis\//, ''), b: req.body ? JSON.parse(req.body) : undefined });
        if (/workitemtypes\/Bug\/states$/.test(u.pathname)) return json({ value: [{ name: 'New', category: 'Proposed' }, { name: 'Active', category: 'InProgress' }, { name: 'Closed', category: 'Completed' }, { name: 'Removed', category: 'Removed' }] });
        if (/classificationnodes\/Iterations$/.test(u.pathname)) return json({ name: 'qa', path: '\\qa\\Iteration', children: [{ name: 'Sprint 1', path: '\\qa\\Iteration\\Sprint 1' }, { name: 'Sprint 2', path: '\\qa\\Iteration\\Sprint 2' }] });
        if (/classificationnodes\/Areas$/.test(u.pathname)) return json({ name: 'qa', path: '\\qa\\Area', children: [{ name: 'Web', path: '\\qa\\Area\\Web' }] });
        if (/projects\/qa\/teams$/.test(u.pathname)) return json({ value: [{ id: 't1' }] });
        if (/teams\/t1\/members$/.test(u.pathname)) return json({ value: [{ identity: { displayName: 'Ann', uniqueName: 'ann@lab.test' } }, { identity: { displayName: 'Team', isContainer: true } }] });
        if (req.method === 'PATCH' && /wit\/workitems\/41$/.test(u.pathname)) {
            const ops = JSON.parse(req.body ?? '[]') as Array<{ op: string; path: string; value: unknown }>;
            const t = ops.find((o) => o.op === 'test');
            if (t && t.value !== current) return { status: 412, body: JSON.stringify({ message: 'The precondition test failed for /rev' }) };
            current++;
            return json({ id: 41, rev: current });
        }
        if (req.method === 'POST' && /workItems\/41\/comments$/.test(u.pathname)) return json({ id: 1 });
        return { status: 404, body: '' };
    };
    const { createServer } = await import('../src/server/server');
    const s = createServer({ repoRoot: dir, store, userName: 'T', adoTransport: transport, token: 'tk' });
    const call = async (method: 'GET' | 'PATCH', url: string, payload?: object) => { const r = await s.app.inject({ method, url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload } : {}) }); return { status: r.statusCode, json: JSON.parse(r.body) }; };
    try {
        const o = await call('GET', '/api/ado/workitems/41/edit-options?type=Bug&project=shop&env=qa');
        assert.equal(o.status, 200, JSON.stringify(o.json));
        assert.deepEqual(o.json.states.map((x: { name: string }) => x.name), ['New', 'Active', 'Closed']);
        assert.deepEqual(o.json.iterations, ['qa', 'qa\\Sprint 1', 'qa\\Sprint 2']);
        assert.deepEqual(o.json.areas, ['qa', 'qa\\Web']);
        assert.deepEqual(o.json.people, [{ name: 'Ann', email: 'ann@lab.test' }]);
        const base = { project: 'shop', env: 'qa', confirm: true };
        assert.match((await call('PATCH', '/api/ado/workitems/41', { changes: { state: 'Active' } })).json.error, /Confirm/);
        const r = await call('PATCH', '/api/ado/workitems/41', { ...base, rev: 7, changes: { state: 'Active', assignedTo: 'ann@lab.test', iteration: 'qa\\Sprint 2', tags: ['regression', 'a;b'], comment: 'Picked up in Sprint 2' } });
        assert.deepEqual([r.status, r.json], [200, { ok: true, rev: 8 }]);
        const patch = calls.find((c) => c.m === 'PATCH')!.b as Array<{ op: string; path: string; value: unknown }>;
        assert.deepEqual(patch, [{ op: 'test', path: '/rev', value: 7 }, { op: 'add', path: '/fields/System.State', value: 'Active' }, { op: 'add', path: '/fields/System.AssignedTo', value: 'ann@lab.test' },
            { op: 'add', path: '/fields/System.IterationPath', value: 'qa\\Sprint 2' }, { op: 'add', path: '/fields/System.Tags', value: 'regression; a b' }]);
        assert.deepEqual(calls.find((c) => c.m === 'POST' && /comments/.test(c.p))!.b, { text: 'Picked up in Sprint 2' });
        // Someone else saved in between: refused, nothing overwritten.
        const stale = await call('PATCH', '/api/ado/workitems/41', { ...base, rev: 7, changes: { state: 'Closed' } });
        assert.equal(stale.status, 400);
        assert.match(stale.json.error, /Someone changed this work item after you opened it/);
        // Unassign.
        await call('PATCH', '/api/ado/workitems/41', { ...base, rev: 8, changes: { assignedTo: '' } });
        assert.deepEqual((calls.filter((c) => c.m === 'PATCH').at(-1)!.b as unknown[])[1], { op: 'add', path: '/fields/System.AssignedTo', value: '' });
    } finally { await s.app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
