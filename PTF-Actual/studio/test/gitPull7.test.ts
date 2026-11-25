/**
 * QA round 7 (datagit): a rebase-mode pull counts only the commits that came from the remote; during a pull clash the
 * edits that do not clash stay unstaged (so "Commit 1 file" never shows); Fetch says what changed in the remote's tags.
 * Real repositories: a bare remote, this computer's clone and a teammate's clone.
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitService } from '../src/git/service';
import { runGit } from '../src/git/run';

let tmp: string;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-studio-qa7-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function clone(remote: string, dir: string) {
    await runGit(['clone', '-q', remote, dir], { cwd: tmp });
    for (const [k, v] of [['user.name', 'T'], ['user.email', 't@x.invalid'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'], ['pull.rebase', 'false']]) await runGit(['config', k, v], { cwd: dir });
    const sh = async (...args: string[]) => (await runGit(args, { cwd: dir })).stdout;
    const w = (f: string, t: string) => fs.writeFileSync(path.join(dir, f), t);
    return { dir, sh, w, git: await GitService.open(dir) };
}

async function team(name: string) {
    const remote = path.join(tmp, name + '.git');
    await runGit(['init', '-q', '--bare', '-b', 'main', remote], { cwd: tmp });
    const seed = path.join(tmp, name + '-seed');
    await runGit(['init', '-q', '-b', 'main', seed], { cwd: tmp });
    for (const [k, v] of [['user.name', 'S'], ['user.email', 's@x.invalid'], ['commit.gpgsign', 'false']]) await runGit(['config', k, v], { cwd: seed });
    fs.writeFileSync(path.join(seed, 'a.feature'), 'line 1\nline 2\nline 3\nline 4\n');
    fs.writeFileSync(path.join(seed, 'b.feature'), 'b 1\nb 2\nb 3\n');
    fs.writeFileSync(path.join(seed, 'other.txt'), 'x\n');
    fs.writeFileSync(path.join(seed, 'mine.txt'), 'm\n');
    await runGit(['add', '-A'], { cwd: seed });
    await runGit(['commit', '-q', '-m', 'init'], { cwd: seed });
    await runGit(['push', '-q', remote, 'main'], { cwd: seed });
    return { remote, me: await clone(remote, path.join(tmp, name + '-me')), mate: await clone(remote, path.join(tmp, name + '-mate')) };
}

const stateOf = async (git: GitService) => (await git.status()).files.map((f) => `${f.path}:${f.conflicted ? 'U' : f.staged + f.unstaged}`).sort();

test('rebase-mode pull clash: only the commits that came from the remote are counted, not your own replayed ones', async () => {
    const t = await team('rebase-count');
    // One commit of my own, not pushed.
    t.me.w('mine.txt', 'm\nmy commit\n');
    await t.me.sh('commit', '-q', '-am', 'my own commit');
    // The teammate pushes one commit.
    t.mate.w('a.feature', 'line 1\nline 2\nline 3 THEIRS\nline 4\n');
    await t.mate.sh('commit', '-q', '-am', 'teammate');
    await t.mate.sh('push', '-q');
    const f = await t.me.git.fetch();
    assert.equal(f.newCommits, 1);
    // A clashing uncommitted edit, then Pull (rebase).
    t.me.w('a.feature', 'line 1\nline 2\nline 3 MINE\nline 4\n');
    const r = await t.me.git.pull('rebase');
    assert.equal(r.status, 'conflicts');
    assert.equal(r.pulled, 1, 'my own rebased commit is not counted as pulled');
    assert.match(r.message ?? '', /^1 commit was pulled/);
    assert.match(r.message ?? '', /Yours = your edit, Pulled = the pulled version/);
    // Undo still goes back to my commit.
    await t.me.git.undoPullAutostash();
    assert.match(await t.me.sh('log', '-1', '--format=%s'), /my own commit/);
});

test('merge-mode pull clash: the count is the pulled commits (no merge commit, no own commits)', async () => {
    const t = await team('merge-count');
    for (const n of [1, 2]) { t.mate.w('a.feature', `line 1\nline 2\nline 3 THEIRS ${n}\nline 4\n`); await t.mate.sh('commit', '-q', '-am', `mate ${n}`); }
    await t.mate.sh('push', '-q');
    t.me.w('a.feature', 'line 1\nline 2\nline 3 MINE\nline 4\n');
    const r = await t.me.git.pull('merge');
    assert.equal(r.status, 'conflicts');
    assert.equal(r.pulled, 2);
});

test('pull clash: an edit that does not clash stays an unstaged change; a resolved file too while others still clash', async () => {
    const t = await team('unstaged');
    t.mate.w('a.feature', 'line 1\nline 2\nline 3 THEIRS\nline 4\n');
    t.mate.w('b.feature', 'b 1\nb 2 THEIRS\nb 3\n');
    await t.mate.sh('commit', '-q', '-am', 'teammate');
    await t.mate.sh('push', '-q');
    t.me.w('a.feature', 'line 1\nline 2\nline 3 MINE\nline 4\n');
    t.me.w('b.feature', 'b 1\nb 2 MINE\nb 3\n');
    t.me.w('other.txt', 'x\nmine too\n');
    const r = await t.me.git.pull();
    assert.equal(r.status, 'conflicts');
    assert.deepEqual(await stateOf(t.me.git), ['a.feature:U', 'b.feature:U', 'other.txt:.M'], 'nothing staged: no "Commit 1 file" during the clash');
    // Resolve one of the two: it is an uncommitted edit, not staged; the other still clashes.
    await t.me.git.resolveConflict('a.feature', 'theirs');
    assert.deepEqual(await stateOf(t.me.git), ['a.feature:.M', 'b.feature:U', 'other.txt:.M']);
    assert.ok((await t.me.git.status()).pullStash, 'still remembered');
    // The last one finishes it, every edit unstaged.
    const fin = await t.me.git.resolveConflict('b.feature', 'theirs');
    assert.match(fin.message ?? '', /All clashes are resolved/);
    assert.deepEqual(await stateOf(t.me.git), ['a.feature:.M', 'b.feature:.M', 'other.txt:.M']);
    assert.equal((await t.me.sh('stash', 'list')).trim(), '');
});

test('fetch says which tags are new, moved or deleted on the remote (and nothing on a second fetch)', async () => {
    const t = await team('tags');
    await t.me.git.createTag('mine', 'HEAD', 'mine');
    await t.me.git.pushTag('mine');
    await t.me.git.createTag('clash', 'HEAD');
    await t.me.git.pushTag('clash');
    let f = await t.me.git.fetch();
    assert.deepEqual([f.tagsAdded, f.tagsChanged, f.tagsRemoved], [[], [], []]);
    // The teammate: a new tag, "clash" moved to another commit, "mine" deleted.
    await t.mate.sh('fetch', '-q', '--tags');
    await t.mate.sh('tag', 'mate-tag');
    t.mate.w('other.txt', 'y\n'); await t.mate.sh('commit', '-q', '-am', 'm');
    await t.mate.sh('tag', '-f', 'clash');
    await t.mate.sh('push', '-q', '-f', 'origin', 'refs/tags/mate-tag', 'refs/tags/clash');
    await t.mate.sh('push', '-q', 'origin', '--delete', 'refs/tags/mine');
    f = await t.me.git.fetch();
    assert.deepEqual(f.tagsAdded, ['mate-tag']);
    assert.deepEqual(f.tagsChanged, ['clash']);
    assert.deepEqual(f.tagsRemoved, ['mine']);
    f = await t.me.git.fetch();
    assert.deepEqual([f.tagsAdded, f.tagsChanged, f.tagsRemoved], [[], [], []]);
    // A tag on a commit no branch has (git would not bring it along) arrives too.
    t.mate.w('other.txt', 'z\n'); await t.mate.sh('commit', '-q', '-am', 'not pushed');
    await t.mate.sh('tag', 'loose');
    await t.mate.sh('push', '-q', 'origin', 'refs/tags/loose');
    await t.me.git.tags(); // the list being shown does not take the news away from Fetch
    f = await t.me.git.fetch();
    assert.deepEqual(f.tagsAdded, ['loose']);
    const tags = await t.me.git.tags();
    assert.equal(tags.find((x) => x.name === 'loose')?.onRemote, 'yes');
    assert.equal(tags.find((x) => x.name === 'mate-tag')?.onRemote, 'yes');
    assert.equal(tags.find((x) => x.name === 'clash')?.onRemote, 'different');
    assert.equal(tags.find((x) => x.name === 'mine')?.onRemote, 'no');
});
