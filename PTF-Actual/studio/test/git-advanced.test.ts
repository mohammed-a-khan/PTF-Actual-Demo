/** TortoiseGit-parity operations against real temporary repositories. */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitService, assertRev } from '../src/git/service';
import { runGit } from '../src/git/run';

let tmp: string;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-studio-adv-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function repo(name: string, withRemote = false) {
    const dir = path.join(tmp, name);
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    for (const [k, v] of [['user.name', 'T'], ['user.email', 't@x.invalid'], ['commit.gpgsign', 'false']]) await runGit(['config', k, v], { cwd: dir });
    if (withRemote) { await runGit(['init', '-q', '--bare', '-b', 'main', dir + '.git'], { cwd: tmp }); await runGit(['remote', 'add', 'origin', dir + '.git'], { cwd: dir }); }
    const git = await GitService.open(dir);
    const w = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };
    const c = async (msg: string, files: Record<string, string>) => { for (const [f, t] of Object.entries(files)) w(f, t); await git.stage(Object.keys(files)); const r = await git.commit(msg); assert.equal(r.status, 'ok', JSON.stringify(r)); return (r as { sha: string }).sha; };
    const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
    return { dir, git, w, c, read };
}

test('history: graph, labels, filters; commit details; compare', async () => {
    const { git, c } = await repo('hist');
    const a = await c('Base', { 'a.txt': '1\n' });
    await git.createBranch('feature/x');
    await c('Feature work', { 'b.txt': 'b\n' });
    await git.switchBranch('main');
    await c('Main work', { 'a.txt': '2\n' });
    await git.createTag('v1.0', 'HEAD', 'First release');
    await git.merge('feature/x', { noFastForward: true });
    const h = await git.history({ all: true });
    assert.equal(h.commits.length, 4);
    assert.equal(h.commits[0].parents.length, 2, 'merge commit first');
    assert.ok(h.commits[0].refs.some((r) => r.kind === 'head'));
    assert.ok(h.commits.some((x) => x.refs.some((r) => r.kind === 'tag' && r.name === 'v1.0')));
    assert.equal(Math.max(...h.graph.map((g) => g.width)), 2, 'two lanes');
    assert.equal((await git.history({ text: 'feature', field: 'message' })).commits.length, 2, 'Feature work + merge message');
    assert.equal((await git.history({ text: 'b.txt', field: 'path' })).commits.length, 1);
    assert.equal((await git.history({ limit: 1 })).more, true);

    const d = await git.commitDetails(a);
    assert.equal(d.message, 'Base');
    assert.deepEqual(d.files, [{ status: 'A', path: 'a.txt' }]);
    assert.match(await git.commitFileDiff(a, 'a.txt'), /\+1/);
    const m = await git.commitDetails('HEAD');
    assert.deepEqual(m.files.map((f) => f.path), ['b.txt'], 'merge shows what the merge brought in');
    assert.deepEqual((await git.compare('v1.0', 'HEAD')).map((f) => f.path), ['b.txt']);
    assert.match(await git.compareFileDiff('feature/x', 'main', 'a.txt'), /-1\n\+2/);
});

test('revert and cherry-pick, including a conflict that is resolved and continued', async () => {
    const { git, c, read } = await repo('pick');
    await c('Base', { 'a.txt': 'one\n' });
    const bad = await c('Bad change', { 'b.txt': 'oops\n' });
    assert.equal((await git.revert(bad)).status, 'ok');
    assert.ok(!fs.existsSync(path.join(git.repoRoot, 'b.txt')));
    assert.match((await git.history()).commits[0].subject, /^Revert "Bad change"/);

    await git.createBranch('feature');
    const f1 = await c('Feature edits a', { 'a.txt': 'feature\n' });
    const f2 = await c('Feature adds c', { 'c.txt': 'c\n' });
    await git.switchBranch('main');
    await c('Main edits a', { 'a.txt': 'main\n' });
    const r = await git.cherryPick([f1, f2]);
    assert.equal(r.status, 'conflicts');
    assert.equal(r.operation, 'cherry-pick');
    assert.equal((await git.status()).operation, 'cherry-pick');
    await git.resolveConflict('a.txt', 'theirs');
    const cont = await git.continueOperation();
    assert.equal(cont.status, 'ok', JSON.stringify(cont));
    assert.equal(read('a.txt'), 'feature\n');
    assert.equal(read('c.txt'), 'c\n', 'second commit applied after continue');
    assert.equal((await git.status()).operation, null);
});

test('reset keeps recovery points; restore brings everything back', async () => {
    const { git, c, w, read } = await repo('reset');
    await c('One', { 'a.txt': '1\n' });
    const two = await c('Two', { 'a.txt': '2\n' });
    w('a.txt', 'uncommitted\n');
    const res = await git.reset('HEAD~1', 'hard');
    assert.equal(read('a.txt'), '1\n');
    assert.ok(res.uncommittedBackup);
    const backups = await git.backups();
    assert.ok(backups.some((b) => b.ref === res.backup && b.sha === two));
    await git.restoreBackup(res.backup);
    assert.equal(read('a.txt'), '2\n');
    await git.restoreBackup(res.uncommittedBackup!);
    assert.equal(read('a.txt'), 'uncommitted\n');
    const soft = await git.reset('HEAD~1', 'soft');
    assert.ok(soft.backup && !soft.uncommittedBackup);
    assert.equal((await git.status()).files[0].staged, 'M', 'soft keeps the change staged');
});

test('discard keeps a recovery copy; restore file from a commit', async () => {
    const { git, c, w, read, dir } = await repo('discard');
    const one = await c('One', { 'a.txt': '1\n' });
    await c('Two', { 'a.txt': '2\n' });
    w('a.txt', 'edited\n'); w('new.txt', 'new\n');
    const r = await git.discard(['a.txt', 'new.txt']);
    assert.equal(read('a.txt'), '2\n');
    assert.ok(!fs.existsSync(path.join(dir, 'new.txt')));
    assert.equal(fs.readFileSync(path.join(r.recoveryDir, 'a.txt'), 'utf8'), 'edited\n');
    assert.equal(fs.readFileSync(path.join(r.recoveryDir, 'new.txt'), 'utf8'), 'new\n');
    await git.restoreFileFrom(one, 'a.txt');
    assert.equal(read('a.txt'), '1\n');
});

test('stage and unstage individual hunks', async () => {
    const { git, c, w } = await repo('hunks');
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    await c('Base', { 'f.txt': lines.join('\n') + '\n' });
    const edited = [...lines]; edited[1] = 'CHANGED 2'; edited[25] = 'CHANGED 26';
    w('f.txt', edited.join('\n') + '\n');
    const h = await git.hunks('f.txt', false);
    assert.equal(h.hunks.length, 2);
    await git.stageHunks('f.txt', [1]);
    const staged = await git.diff('f.txt', true);
    assert.match(staged, /\+CHANGED 26/);
    assert.doesNotMatch(staged, /CHANGED 2\n/);
    assert.match(await git.diff('f.txt', false), /\+CHANGED 2\n/);
    await git.stageHunks('f.txt', [0], true);
    assert.equal(await git.diff('f.txt', true), '');
});

test('stash: save with new files, list, show, apply, pop, drop', async () => {
    const { git, c, w, read, dir } = await repo('stash');
    await c('Base', { 'a.txt': '1\n' });
    w('a.txt', 'wip\n'); w('n.txt', 'new\n');
    await git.stashSave('half-done login test', true);
    assert.equal(read('a.txt'), '1\n');
    assert.ok(!fs.existsSync(path.join(dir, 'n.txt')));
    const list = await git.stashList();
    assert.equal(list.length, 1);
    assert.equal(list[0].message, 'half-done login test');
    assert.deepEqual((await git.stashFiles(0)).map((f) => f.path).sort(), ['a.txt', 'n.txt']);
    assert.match(await git.stashFileDiff(0, 'a.txt'), /\+wip/);
    assert.equal((await git.stashApply(0, false)).status, 'ok');
    assert.equal(read('a.txt'), 'wip\n');
    assert.equal((await git.stashList()).length, 1, 'apply keeps the entry');
    await git.discard(['a.txt', 'n.txt']);
    assert.equal((await git.stashApply(0, true)).status, 'ok');
    assert.equal((await git.stashList()).length, 0, 'pop removes it');
    await assert.rejects(git.stashSave('', false).then(() => git.stashSave('', false)), /no changes/);
    await git.stashDrop(0);
});

test('tags, branch delete/rename, push with tags', async () => {
    const { git, c, dir } = await repo('tags', true);
    await c('Base', { 'a.txt': '1\n' });
    await git.push();
    await git.createTag('v1', 'HEAD', 'Release 1');
    await git.createTag('light', 'HEAD');
    const t = await git.tags();
    assert.deepEqual(t.map((x) => [x.name, x.annotated]).sort(), [['light', false], ['v1', true]]);
    await git.pushTag('v1');
    assert.match((await runGit(['tag'], { cwd: dir + '.git' })).stdout, /v1/);
    await git.deleteTag('v1', true);
    assert.doesNotMatch((await runGit(['tag'], { cwd: dir + '.git' })).stdout, /v1/);
    await assert.rejects(git.createTag('bad..tag', 'HEAD'));

    await git.createBranch('topic');
    await c('Topic only', { 't.txt': 't\n' });
    await git.switchBranch('main');
    assert.equal((await git.deleteBranch('topic')).status, 'not-merged');
    await git.renameBranch('topic', 'topic-renamed');
    assert.ok((await git.branches()).some((b) => b.name === 'topic-renamed'));
    assert.equal((await git.deleteBranch('topic-renamed', true)).status, 'ok');
});

test('amend refuses pushed commits unless confirmed; force-with-lease push', async () => {
    const { git, c } = await repo('amend', true);
    await c('Base', { 'a.txt': '1\n' });
    const r1 = await git.commit('Base (better message)', undefined, { amend: true });
    assert.equal(r1.status, 'ok');
    assert.equal((await git.history()).commits[0].subject, 'Base (better message)');
    await git.push();
    const r2 = await git.commit('Again', undefined, { amend: true });
    assert.equal(r2.status, 'rejected');
    const r3 = await git.commit('Again', undefined, { amend: true, allowRewritePushed: true });
    assert.equal(r3.status, 'ok');
    const plain = await git.push();
    assert.equal(plain.status, 'rejected', 'normal push refuses rewritten history');
    assert.equal((await git.push(undefined, { forceWithLease: true })).status, 'ok');
});

test('merge options: squash and no-commit', async () => {
    const { git, c } = await repo('mopts');
    await c('Base', { 'a.txt': '1\n' });
    await git.createBranch('f'); await c('F1', { 'b.txt': 'b\n' }); await git.switchBranch('main');
    const r = await git.merge('f', { squash: true });
    assert.equal(r.status, 'ok');
    assert.equal((await git.status()).files[0].staged, 'A', 'squash leaves changes staged, no merge commit');
    assert.equal((await git.history()).commits.length, 1);
});

test('refs that look like options or ranges are refused', () => {
    for (const bad of ['--upload-pack=x', '-n', 'a..b', 'a...b', 'x y', '', 'a\nb', 'a\0b']) assert.throws(() => assertRev(bad), bad);
    // Valid git names that the old character whitelist refused.
    for (const ok of ['main', 'feature/x', 'v1.0', 'HEAD~1', 'HEAD^2', 'stash@{0}', 'origin/main', 'abc123', 'fix#123', 'tâche', 'v1.0+build,1', 'a;b']) assertRev(ok);
});
