/** Review of an agent's edits in the editor (as VS Code's Keep / Undo): changed blocks, baselines, keep and undo. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runGit } from '../src/git/run';
import { changeCount, hunksOf, keepHunk, undoHunk } from '../src/agents/hunks';
import { writeFakeCopilotSdk } from './fakeCopilot';

test('changed blocks: added, changed and removed lines; one undone or kept on its own; a new file; nothing when the same', () => {
    const before = 'a\nb\nc\nd\ne';
    const after = 'a\nB\nc\ne\nf';
    const h = hunksOf(before, after);
    assert.deepEqual(h.map((x) => [x.afterStart, x.afterCount, x.removed, x.added]), [[1, 1, ['b'], ['B']], [3, 0, ['d'], []], [4, 1, [], ['f']]]);
    assert.equal(undoHunk(before, after, h[0].id), 'a\nb\nc\ne\nf', 'the first change undone, the others stay');
    assert.equal(undoHunk(before, after, h[1].id), 'a\nB\nc\nd\ne\nf', 'removed lines come back where they were');
    const kept = keepHunk(before, after, h[2].id);
    assert.equal(kept, 'a\nb\nc\nd\ne\nf');
    assert.deepEqual(hunksOf(kept, after).map((x) => x.added), [['B'], []], 'a kept change is no longer shown; the others are');
    assert.deepEqual(changeCount(before, after), { added: 2, removed: 2 });
    assert.deepEqual(hunksOf(null, 'x\ny').map((x) => [x.afterStart, x.added]), [[0, ['x', 'y']]], 'a new file: all its lines');
    assert.deepEqual(hunksOf('same', 'same'), []);
    assert.equal(hunksOf(before, after)[0].id, h[0].id, 'ids are stable for the same change');
    assert.equal(undoHunk(before, after, 'gone'), after, 'an unknown change changes nothing');
});

test('an agent\'s edits: kept from before its first change (your own uncommitted edits stay), one change kept, a file undone, a new file removed', async () => {
    delete (global as { __fakeCopilot?: unknown }).__fakeCopilot;
    const { createServer } = await import('../src/server/server');
    const { SecretStore } = await import('../src/secrets/store');
    const { KeyFileProtector } = await import('../src/secrets/protector');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-review-'));
    const dir = path.join(tmp, 'repo'), home = path.join(tmp, 'home');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    for (const [k, v] of [['user.name', 'Tester'], ['user.email', 't@example.test']]) await runGit(['config', k, v], { cwd: dir });
    fs.mkdirSync(path.join(dir, 'test/shop/features'), { recursive: true });
    const feature = path.join(dir, 'test/shop/features/pay.feature');
    fs.writeFileSync(feature, 'Feature: Pay\n  Scenario: card\n    Given a cart\n');
    await runGit(['add', '-A'], { cwd: dir }); await runGit(['commit', '-q', '-m', 'init'], { cwd: dir });
    // The person's own edit, not committed: the agent's review must not count it, and Undo must not lose it.
    fs.writeFileSync(feature, 'Feature: Pay\n  Scenario: card\n    Given a full cart\n');
    writeFakeCopilotSdk(path.join(home, 'agents-runtime'));
    const store = new SecretStore(home, new KeyFileProtector(path.join(home, 'keys', 'secrets.key')));
    const srv = createServer({ repoRoot: dir, store, userName: 'Tester', token: 'tk', home });
    const call = async (method: string, url: string, payload?: unknown) => {
        const r = await srv.app.inject({ method: method as never, url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload: payload as never } : {}) });
        return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return r.body; } })() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    try {
        const s = await call('POST', '/api/agents/sessions', { title: 'Copilot' });
        assert.equal(s.status, 200, JSON.stringify(s.json));
        const id = s.json.id as string;
        assert.equal((await call('POST', `/api/agents/sessions/${id}/auto-approve`, { on: true })).status, 200);
        const cfg = (global as unknown as { __fakeCopilot: { lastConfig: any } }).__fakeCopilot.lastConfig; // eslint-disable-line @typescript-eslint/no-explicit-any
        // The agent asks to change the feature and to create a page; approved; then writes them (as Copilot's edit tool does).
        assert.notEqual((await cfg.onPermissionRequest({ kind: 'write', fileName: feature })).kind, 'reject');
        fs.writeFileSync(feature, 'Feature: Pay\n  @smoke\n  Scenario: card\n    Given a full cart\n    When I pay by card\n');
        const page = path.join(dir, 'test/shop/pages/PayPage.ts');
        assert.notEqual((await cfg.onPermissionRequest({ kind: 'write', fileName: page })).kind, 'reject');
        fs.mkdirSync(path.dirname(page), { recursive: true }); fs.writeFileSync(page, 'export class PayPage {}\n');

        let r = await call('GET', '/api/agents/review');
        assert.equal(r.status, 200);
        const byPath = (p: string) => r.json.files.find((f: { path: string }) => f.path === p);
        const f = byPath('test/shop/features/pay.feature');
        assert.equal(f.session, id); assert.equal(f.title, 'Copilot'); assert.equal(f.state, 'modified');
        assert.equal(f.before, 'Feature: Pay\n  Scenario: card\n    Given a full cart\n', 'the file before the agent: with the person\'s own edit');
        assert.deepEqual([f.added, f.removed], [2, 0]);
        assert.equal(byPath('test/shop/pages/PayPage.ts').state, 'new');
        assert.equal(byPath('test/shop/pages/PayPage.ts').before, null);

        // Keep one change (the tag): only the other one is left to review.
        const h = hunksOf(f.before, f.after);
        assert.equal(h.length, 2);
        assert.equal((await call('POST', `/api/agents/sessions/${id}/review/keep`, { path: f.path, baseline: keepHunk(f.before, f.after, h[0].id) })).status, 200);
        r = await call('GET', '/api/agents/review');
        assert.deepEqual(hunksOf(byPath(f.path).before, byPath(f.path).after).map((x) => x.added), [['    When I pay by card']]);

        // Undo the feature: back to before the agent with the kept change (the person's own edit is still there).
        const u = await call('POST', `/api/agents/sessions/${id}/review/undo`, { path: f.path });
        assert.equal(u.status, 200); assert.equal(u.json.files, 1); assert.ok(fs.existsSync(path.join(u.json.recoveryDir, f.path)), 'a copy is kept');
        assert.equal(fs.readFileSync(feature, 'utf8'), 'Feature: Pay\n  @smoke\n  Scenario: card\n    Given a full cart\n');
        // Undo all: the page it created is removed.
        assert.equal((await call('POST', `/api/agents/sessions/${id}/review/undo`, {})).json.files, 1);
        assert.equal(fs.existsSync(page), false);
        r = await call('GET', '/api/agents/review');
        assert.deepEqual(r.json.files, [], 'nothing left to review');

        // Only the conversation's own files.
        assert.equal((await call('POST', `/api/agents/sessions/${id}/review/undo`, { path: 'README.md' })).status, 400);
        // The agent changes it again: a new baseline (the file now), Keep all clears it.
        assert.notEqual((await cfg.onPermissionRequest({ kind: 'write', fileName: feature })).kind, 'reject');
        fs.writeFileSync(feature, 'Feature: Pay\n');
        r = await call('GET', '/api/agents/review');
        assert.equal(byPath(f.path).before, 'Feature: Pay\n  @smoke\n  Scenario: card\n    Given a full cart\n');
        assert.equal((await call('POST', `/api/agents/sessions/${id}/review/keep`, {})).status, 200);
        assert.deepEqual((await call('GET', '/api/agents/review')).json.files, []);
    } finally { await srv.app.close(); delete (global as { __fakeCopilot?: unknown }).__fakeCopilot; fs.rmSync(tmp, { recursive: true, force: true }); }
});
