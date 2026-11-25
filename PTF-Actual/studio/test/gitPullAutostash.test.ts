/**
 * QA round 6 (datagit): pull with uncommitted edits that clash, fetch that says what arrived, commit to the branch the
 * screen showed, tag push twice, branch names that read like a remote branch. Real repositories: a bare remote, this
 * computer's clone and a teammate's clone.
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitService } from '../src/git/service';
import { runGit } from '../src/git/run';

let tmp: string;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-studio-qa6-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function clone(remote: string, dir: string) {
    await runGit(['clone', '-q', remote, dir], { cwd: tmp });
    for (const [k, v] of [['user.name', 'T'], ['user.email', 't@x.invalid'], ['commit.gpgsign', 'false'], ['pull.rebase', 'false']]) await runGit(['config', k, v], { cwd: dir });
    const sh = async (...args: string[]) => (await runGit(args, { cwd: dir })).stdout;
    const w = (f: string, t: string) => fs.writeFileSync(path.join(dir, f), t);
    const r = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
    return { dir, sh, w, r, git: await GitService.open(dir) };
}

/** A bare remote with one commit, "me" (this computer) and "mate" (a teammate), both cloned from it. */
async function team(name: string) {
    const remote = path.join(tmp, name + '.git');
    await runGit(['init', '-q', '--bare', '-b', 'main', remote], { cwd: tmp });
    const seed = path.join(tmp, name + '-seed');
    await runGit(['init', '-q', '-b', 'main', seed], { cwd: tmp });
    for (const [k, v] of [['user.name', 'S'], ['user.email', 's@x.invalid'], ['commit.gpgsign', 'false']]) await runGit(['config', k, v], { cwd: seed });
    fs.writeFileSync(path.join(seed, 'a.feature'), 'line 1\nline 2\nline 3\nline 4\n');
    fs.writeFileSync(path.join(seed, 'other.txt'), 'x\n');
    await runGit(['add', '-A'], { cwd: seed });
    await runGit(['commit', '-q', '-m', 'init'], { cwd: seed });
    await runGit(['push', '-q', remote, 'main'], { cwd: seed });
    return { remote, me: await clone(remote, path.join(tmp, name + '-me')), mate: await clone(remote, path.join(tmp, name + '-mate')) };
}

async function clash(name: string) {
    const t = await team(name);
    t.mate.w('a.feature', 'line 1\nline 2\nline 3 THEIRS\nline 4\n');
    await t.mate.sh('commit', '-q', '-am', 'teammate edits line 3');
    await t.mate.sh('push', '-q');
    // Uncommitted here: the same line, and another file that does not clash.
    t.me.w('a.feature', 'line 1\nline 2\nline 3 MINE\nline 4\n');
    t.me.w('other.txt', 'x\nmine too\n');
    await t.me.git.fetch();
    const before = (await t.me.sh('rev-parse', 'HEAD')).trim();
    return { ...t, before };
}

test('pull: uncommitted edits that clash are reported as such, not as "pulled", with the sides named right', async () => {
    const t = await clash('clash');
    const r = await t.me.git.pull();
    assert.equal(r.status, 'conflicts');
    assert.equal(r.localEdits, true);
    assert.equal(r.pulled, 1);
    assert.deepEqual(r.conflicts, ['a.feature']);
    assert.match(r.message ?? '', /your uncommitted edits clash with the pulled changes/);
    assert.match(r.message ?? '', /No merge is running/);
    const st = await t.me.git.status();
    assert.equal(st.operation, null, 'no merge is running');
    assert.ok(st.pullStash, 'the pull is remembered');
    assert.equal(st.pullStash!.before, t.before);
    assert.equal(st.pullStash!.headMoved, false);
    assert.equal(st.pullStash!.ref, 'stash@{0}');
    const v = await t.me.git.conflictVersions('a.feature');
    assert.equal(v.localEdits, true);
    assert.match(v.ours ?? '', /THEIRS/, 'stage 2 is the pulled version');
    assert.match(v.theirs ?? '', /MINE/, 'stage 3 is your own edit');
});

test('pull clash: Abort undoes the pull (branch and edits as before) and leaves no stash entry', async () => {
    const t = await clash('undo');
    await t.me.git.pull();
    // "Abort merge" / "Abort" in the Changes list: no merge is running, so it is the undo.
    const res = await t.me.git.abortOperation();
    assert.match(res.message ?? '', /Undid the pull/);
    assert.equal((await t.me.sh('rev-parse', 'HEAD')).trim(), t.before);
    assert.equal(t.me.r('a.feature'), 'line 1\nline 2\nline 3 MINE\nline 4\n');
    assert.equal(t.me.r('other.txt'), 'x\nmine too\n');
    assert.equal((await t.me.sh('stash', 'list')).trim(), '', 'no stray stash entry');
    const st = await t.me.git.status();
    assert.equal(st.hasConflicts, false);
    assert.equal(st.pullStash, undefined);
    assert.equal(st.behind, 1, 'the pulled commit is still on the remote branch');
    // A recovery point of the pulled position was saved.
    assert.ok((await t.me.git.backups()).length >= 1);
    // Nothing more to undo.
    await assert.rejects(t.me.git.undoPullAutostash(), /no pull to undo/);
});

test('pull clash: the merge abort route does the same undo instead of a silent no-op', async () => {
    const t = await clash('undo-merge');
    await t.me.git.pull();
    const res = await t.me.git.abortMerge();
    assert.match(res.message ?? '', /Undid the pull/);
    assert.equal((await t.me.sh('rev-parse', 'HEAD')).trim(), t.before);
});

test('pull clash: resolving the last file keeps your edits on top of the pulled commit and removes the stash copy', async () => {
    const t = await clash('resolve');
    await t.me.git.pull();
    // "Mine" (your edit) is git's "theirs" here.
    const r = await t.me.git.resolveConflict('a.feature', 'theirs');
    assert.match(r.message ?? '', /All clashes are resolved/);
    assert.equal(t.me.r('a.feature'), 'line 1\nline 2\nline 3 MINE\nline 4\n');
    assert.equal(t.me.r('other.txt'), 'x\nmine too\n');
    assert.equal((await t.me.sh('stash', 'list')).trim(), '');
    const st = await t.me.git.status();
    assert.equal(st.pullStash, undefined);
    assert.equal(st.behind, 0);
    assert.equal(st.hasConflicts, false);
    // The edits are uncommitted changes again (not staged), as before the pull.
    assert.deepEqual(st.files.map((f) => `${f.path}:${f.staged}${f.unstaged}`).sort(), ['a.feature:.M', 'other.txt:.M']);
});

test('pull clash resolved elsewhere (staged by hand): finish removes the stash copy; undo after a commit is refused', async () => {
    const t = await clash('finish');
    await t.me.git.pull();
    t.me.w('a.feature', 'line 1\nline 2\nline 3 both\nline 4\n');
    await t.me.sh('add', 'a.feature');
    assert.ok((await t.me.git.status()).pullStash, 'still remembered: the copy is in the stash');
    await t.me.sh('commit', '-q', '-m', 'resolved by hand');
    const st = await t.me.git.status();
    assert.equal(st.pullStash?.headMoved, true);
    await assert.rejects(t.me.git.undoPullAutostash(), /can no longer be undone/);
    const f = await t.me.git.finishPullAutostash();
    assert.match(f.message, /was removed/);
    assert.equal((await t.me.sh('stash', 'list')).trim(), '');
    assert.equal((await t.me.git.status()).pullStash, undefined);
});

test('pull: edits that do not clash are put back and it is a plain "ok"', async () => {
    const t = await team('noclash');
    t.mate.w('a.feature', 'line 1 THEIRS\nline 2\nline 3\nline 4\n');
    await t.mate.sh('commit', '-q', '-am', 'mate');
    await t.mate.sh('push', '-q');
    t.me.w('other.txt', 'x\nmine\n');
    const r = await t.me.git.pull();
    assert.equal(r.status, 'ok');
    assert.equal(r.localEdits, undefined);
    assert.equal((await t.me.sh('stash', 'list')).trim(), '');
    assert.equal((await t.me.git.status()).pullStash, undefined);
});

test('fetch says how many new commits arrived (and nothing on a second fetch)', async () => {
    const t = await team('fetch');
    let f = await t.me.git.fetch();
    assert.equal(f.newCommits, 0);
    for (const n of [1, 2]) { t.mate.w('other.txt', `x\n${n}\n`); await t.mate.sh('commit', '-q', '-am', `mate ${n}`); }
    await t.mate.sh('push', '-q');
    await t.mate.sh('push', '-q', 'origin', 'HEAD:refs/heads/feature/x');
    f = await t.me.git.fetch();
    assert.equal(f.newCommits, 2);
    assert.deepEqual(f.updated, ['origin/main']);
    assert.deepEqual(f.added, ['origin/feature/x']);
    assert.equal(f.behind, 2);
    assert.equal(f.upstream, 'origin/main');
    f = await t.me.git.fetch();
    assert.equal(f.newCommits, 0);
    assert.deepEqual(f.updated, []);
    // A remote branch deleted on the remote.
    await t.mate.sh('push', '-q', 'origin', '--delete', 'feature/x');
    f = await t.me.git.fetch();
    assert.deepEqual(f.removed, ['origin/feature/x']);
    assert.equal(f.newCommits, 0);
});

test('commit goes only to the branch the screen showed', async () => {
    const t = await team('expect');
    await t.me.sh('switch', '-q', '-c', 'bad-name');
    t.me.w('other.txt', 'x\nstaged\n');
    await t.me.sh('add', 'other.txt');
    const no = await t.me.git.commit('msg', undefined, { expectBranch: 'main' });
    assert.equal(no.status, 'rejected');
    assert.match((no as { message: string }).message, /This tab shows main but bad-name is checked out now/);
    assert.equal((await t.me.sh('log', '--oneline')).trim().split('\n').length, 1, 'nothing committed');
    const ok = await t.me.git.commit('msg', undefined, { expectBranch: 'bad-name' });
    assert.equal(ok.status, 'ok');
    // Detached: the screen said a detached commit.
    await t.me.sh('switch', '-q', '--detach');
    t.me.w('other.txt', 'x\nagain\n');
    await t.me.sh('add', 'other.txt');
    const det = await t.me.git.commit('msg', undefined, { expectBranch: 'bad-name' });
    assert.match((det as { message: string }).message, /bad-name but a detached commit is checked out/);
    assert.equal((await t.me.git.commit('msg', undefined, { expectBranch: null })).status, 'ok');
});

test('tags: pushed or not is shown; pushing twice (a double click) is not an error', async () => {
    const t = await team('tags');
    await t.me.git.createTag('v1', 'HEAD', 'release one');
    await t.me.git.createTag('local-only', 'HEAD');
    let tags = await t.me.git.tags();
    assert.equal(tags.find((x) => x.name === 'v1')?.onRemote, 'no');
    assert.equal('object' in tags[0], false);
    const [a, b] = await Promise.all([t.me.git.pushTag('v1'), t.me.git.pushTag('v1')]);
    assert.ok(!a.already || !b.already, 'one of them pushed');
    assert.deepEqual(await t.me.git.pushTag('v1'), { already: true });
    tags = await t.me.git.tags();
    assert.equal(tags.find((x) => x.name === 'v1')?.onRemote, 'yes');
    assert.equal(tags.find((x) => x.name === 'local-only')?.onRemote, 'no');
    // The teammate has a different tag of the same name on the remote.
    await t.mate.sh('tag', 'local-only', 'HEAD~0');
    t.mate.w('other.txt', 'y\n'); await t.mate.sh('commit', '-q', '-am', 'm');
    await t.mate.sh('tag', '-f', 'local-only');
    await t.mate.sh('push', '-q', 'origin', 'refs/tags/local-only');
    tags = await t.me.git.tags();
    assert.equal(tags.find((x) => x.name === 'local-only')?.onRemote, 'different');
    await assert.rejects(t.me.git.pushTag('local-only'));
});

test('a branch name that reads like a remote branch (origin/main) is refused', async () => {
    const t = await team('names');
    await assert.rejects(t.me.git.createBranch('origin/main'), /reads like the remote branch origin\/main/);
    await assert.rejects(t.me.git.createBranch('origin/new-thing'), /starts with the remote name "origin\/"/);
    await assert.rejects(t.me.git.renameBranch('main', 'origin/x'), /remote name/);
    await t.me.git.createBranch('feature/origin-ok');
    assert.equal((await t.me.git.status()).branch, 'feature/origin-ok');
});

test('pull clash in rebase mode is reported and undone the same way', async () => {
    const t = await clash('rebase');
    const r = await t.me.git.pull('rebase');
    assert.equal(r.status, 'conflicts');
    assert.equal(r.localEdits, true);
    assert.equal((await t.me.git.status()).operation, null);
    await t.me.git.undoPullAutostash();
    assert.equal((await t.me.sh('rev-parse', 'HEAD')).trim(), t.before);
    assert.equal(t.me.r('a.feature'), 'line 1\nline 2\nline 3 MINE\nline 4\n');
    assert.equal((await t.me.sh('stash', 'list')).trim(), '');
});

test('an older stash entry stays untouched by a pull clash and its undo', async () => {
    const t = await clash('older');
    // An unrelated stash made before (a new file, so the edits stay).
    fs.writeFileSync(path.join(t.me.dir, 'kept.txt'), 'k\n');
    await t.me.sh('add', 'kept.txt');
    await t.me.sh('stash', 'push', '-q', '-m', 'mine from before', '--', 'kept.txt');
    await t.me.git.pull();
    assert.equal((await t.me.git.status()).pullStash?.ref, 'stash@{0}');
    await t.me.git.abortOperation();
    const list = (await t.me.sh('stash', 'list')).trim().split('\n');
    assert.equal(list.length, 1);
    assert.match(list[0], /mine from before/);
});
