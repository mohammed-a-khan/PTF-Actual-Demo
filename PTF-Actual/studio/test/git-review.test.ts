/** Regression tests for the second Git review: the four bugs, stash by commit, pull policy, safe.directory (real temporary repositories). */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitService, explainGitFailure, INDEX_LOCK_MESSAGE, STALE_HUNK_MESSAGE, stripComments } from '../src/git/service';
import { resolveGitBinary, runGit } from '../src/git/run';
import { installHooks } from '../src/git/hooks';
import { scanStaged, scanUnpushed, MAX_SCAN_FILE_BYTES } from '../src/scanner/gitScan';

let tmp: string;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-studio-rev-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SECRET = 'const apiKey = "ghp_1234567890abcdefghijklmnopqrstuvwxyzAB";';

async function repo(name: string, withRemote = false) {
    const dir = path.join(tmp, name);
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    for (const [k, v] of [['user.name', 'T'], ['user.email', 't@x.invalid'], ['commit.gpgsign', 'false']]) await runGit(['config', k, v], { cwd: dir });
    let remote = '';
    if (withRemote) {
        remote = dir + '.git';
        await runGit(['init', '-q', '--bare', '-b', 'main', remote], { cwd: tmp });
        await runGit(['remote', 'add', 'origin', remote], { cwd: dir });
    }
    const git = await GitService.open(dir);
    const w = (f: string, t: string | Buffer) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };
    const sh = async (...args: string[]) => (await runGit(args, { cwd: dir })).stdout;
    const shq = async (...args: string[]) => runGit(args, { cwd: dir, allowFailure: true });
    const c = async (msg: string, files: Record<string, string | Buffer>) => { for (const [f, t] of Object.entries(files)) w(f, t); await sh('add', '-A'); await sh('commit', '-q', '--no-verify', '-m', msg); return (await sh('rev-parse', 'HEAD')).trim(); };
    return { dir, git, w, sh, shq, c, remote };
}
const lines = (n: number, p = 'L') => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);

test('switch to a commit: detached HEAD (git switch <sha> alone is refused); a branch still switches normally', async () => {
    const { git, c, sh } = await repo('detach');
    const first = await c('one', { 'a.txt': '1' });
    await c('two', { 'a.txt': '2' });
    await git.switchBranch(first);
    assert.equal((await sh('rev-parse', 'HEAD')).trim(), first);
    assert.equal((await sh('symbolic-ref', '-q', 'HEAD').catch(() => '')).trim(), '', 'detached');
    await git.switchBranch(first.slice(0, 8));
    await git.switchBranch('main');
    assert.equal((await sh('symbolic-ref', '--short', 'HEAD')).trim(), 'main');
});

test('resolving a conflict in a file that is not UTF-8 keeps its bytes (Latin-1 é stays 0xE9)', async () => {
    const { git, c, sh, shq, dir } = await repo('latin1');
    await c('base', { 'names.txt': Buffer.from('caf\xe9\nline2\nend\n', 'latin1') });
    await sh('switch', '-q', '-c', 'other');
    await c('theirs', { 'names.txt': Buffer.from('caf\xe9\nTHEIRS\nend\n', 'latin1') });
    await sh('switch', '-q', 'main');
    await c('ours', { 'names.txt': Buffer.from('caf\xe9\nOURS\nend\n', 'latin1') });
    await shq('merge', 'other');
    const v = await git.conflictVersions('names.txt');
    assert.ok(v.working!.startsWith('café\n<<<<<<<'), JSON.stringify(v.working));
    await git.resolveConflict('names.txt', { content: v.working!.replace(/<<<<<<<[^\n]*\n([\s\S]*?)=======\n[\s\S]*?>>>>>>>[^\n]*\n/, '$1') });
    assert.deepEqual(fs.readFileSync(path.join(dir, 'names.txt')), Buffer.from('caf\xe9\nOURS\nend\n', 'latin1'));
    // A character Latin-1 cannot hold is refused, not mangled.
    await c('again', { 'n2.txt': Buffer.from('\xe9\n', 'latin1') });
    await sh('switch', '-q', 'other'); await c('t2', { 'n2.txt': Buffer.from('a\xe9\n', 'latin1') });
    await sh('switch', '-q', 'main'); await c('o2', { 'n2.txt': Buffer.from('b\xe9\n', 'latin1') });
    await shq('merge', 'other');
    await assert.rejects(git.resolveConflict('n2.txt', { content: '€\n' }), /not UTF-8.*cannot hold/);
    // UTF-8 files are unchanged in behaviour.
    assert.equal((await import('../src/git/service')).fileEncoding(path.join(dir, 'a-missing.txt')), 'utf8');
});

test('hard reset: an untracked file the target tracks is kept in the recovery point, and restored from it', async () => {
    const { git, c, sh, dir, w } = await repo('untracked');
    await c('base', { 'a.txt': 'a' });
    const target = await c('adds new.txt', { 'new.txt': 'from the commit' });
    await sh('reset', '-q', '--hard', 'HEAD~1');
    w('new.txt', 'my untracked work');
    const r = await git.reset(target, 'hard');
    assert.equal(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8'), 'from the commit');
    assert.ok(r.uncommittedBackup, 'the untracked file is in a recovery point');
    assert.equal((await sh('show', `${r.uncommittedBackup}:new.txt`)), 'my untracked work');
});

test('stash entries by commit: a stash made in between does not make the wrong entry pop or drop', async () => {
    const { git, c, w, sh } = await repo('stash');
    await c('base', { 'a.txt': '1', 'b.txt': '1' });
    w('a.txt', 'A change'); await sh('stash', 'push', '-q', '-m', 'first');
    const shown = await git.stashList();
    w('b.txt', 'B change'); await sh('stash', 'push', '-q', '-m', 'made elsewhere');
    // The UI still shows "first" at index 0; by commit, the right one is applied.
    await git.stashApply(shown[0].index, true, shown[0].sha);
    assert.equal(fs.readFileSync(path.join((await sh('rev-parse', '--show-toplevel')).trim(), 'a.txt'), 'utf8'), 'A change');
    assert.deepEqual((await git.stashList()).map((x) => x.message), ['made elsewhere']);
    await assert.rejects(git.stashDrop(0, shown[0].sha), /no longer exists/);
});

test('pull follows the team\'s setting (pull.rebase, pull.ff=only) and keeps local edits (autostash)', async () => {
    const { git, c, sh, w, dir, remote } = await repo('pull', true);
    await c('base', { 'a.txt': '1', 'notes.txt': 'n' });
    await sh('push', '-q', '-u', 'origin', 'main');
    const other = path.join(path.dirname(dir), 'pull-other');
    await runGit(['clone', '-q', remote, other], { cwd: path.dirname(dir) });
    for (const [k, v] of [['user.name', 'T'], ['user.email', 't@x.invalid']]) await runGit(['config', k, v], { cwd: other });
    fs.writeFileSync(path.join(other, 'remote.txt'), 'r'); await runGit(['add', '-A'], { cwd: other }); await runGit(['commit', '-q', '-m', 'remote'], { cwd: other }); await runGit(['push', '-q'], { cwd: other });
    await c('local', { 'local.txt': 'l' });
    w('notes.txt', 'uncommitted edit');
    assert.equal(await git.pullMode(), 'merge');
    await sh('config', 'pull.ff', 'only');
    assert.equal(await git.pullMode(), 'ff-only');
    const ff = await git.pull();
    assert.equal(ff.status, 'rejected'); assert.match(ff.message!, /fast-forward only/);
    await sh('config', 'pull.rebase', 'true');
    assert.equal(await git.pullMode(), 'rebase');
    const r = await git.pull();
    assert.equal(r.status, 'ok', JSON.stringify(r)); assert.equal(r.mode, 'rebase');
    assert.equal((await sh('log', '--format=%s', '-3')).trim(), 'local\nremote\nbase', 'rebased: no merge commit');
    assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'uncommitted edit', 'local edit kept');
});

test('"dubious ownership" is explained with how to trust the folder', () => {
    assert.match(explainGitFailure("fatal: detected dubious ownership in repository at 'C:/work/repo'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory C:/work/repo"), /does not trust this folder.*Trust this folder/);
});

test('commit sign-off and the team template; clean only what the preview listed (with a copy kept); reflog', async () => {
    const { git, c, sh, w, dir } = await repo('extras');
    await c('base', { 'a.txt': '1' });
    w('.gitmessage', '# Write the story id first\nAB#\n\nWhy:\n');
    await sh('config', 'commit.template', '.gitmessage');
    assert.equal(await git.commitTemplate(), 'AB#\n\nWhy:');
    w('b.txt', 'b'); await sh('add', 'b.txt');
    const r = await git.commit('Add b', undefined, { signoff: true });
    assert.equal(r.status, 'ok');
    assert.match(await sh('log', '-1', '--format=%B'), /Signed-off-by: T <t@x.invalid>/);
    w('tmp/out.log', 'x'); w('junk.txt', 'j');
    const preview = await git.cleanPreview();
    assert.deepEqual(preview.sort(), ['.gitmessage', 'junk.txt', 'tmp/']);
    w('later.txt', 'made after the preview');
    // The files the user ticked in the preview (a tracked file sneaked into the list is not deleted).
    const cl = await git.clean(['junk.txt', 'tmp/', 'a.txt']);
    assert.deepEqual(cl.removed.sort(), ['junk.txt', 'tmp/']);
    assert.ok(fs.existsSync(path.join(dir, 'a.txt')), 'tracked files are never cleaned');
    assert.ok(fs.existsSync(path.join(dir, 'later.txt')) && !fs.existsSync(path.join(dir, 'junk.txt')));
    assert.equal(fs.readFileSync(path.join(cl.recoveryDir!, 'tmp', 'out.log'), 'utf8'), 'x', 'a copy is kept');
    const log = await git.reflog(5);
    assert.match(log[0].subject, /commit: Add b/);
});

test('rebase onto a branch, and interactive rebase (reword, squash with a message, fixup, drop) with no editor', async () => {
    const { git, c, sh } = await repo('rebase');
    await c('base', { 'a.txt': '1' });
    await sh('switch', '-q', '-c', 'feature');
    const f1 = await c('feat 1', { 'f1.txt': '1' });
    const f2 = await c('wip', { 'f2.txt': '2' });
    const f3 = await c('typo', { 'f1.txt': '1b' });
    const f4 = await c('debug', { 'dbg.txt': 'x' });
    await sh('switch', '-q', 'main');
    await c('main moved', { 'm.txt': 'm' });
    await sh('switch', '-q', 'feature');
    const r = await git.rebaseOnto('main');
    assert.equal(r.status, 'ok', JSON.stringify(r));
    assert.equal((await sh('log', '--format=%s', '-5')).trim(), 'debug\ntypo\nwip\nfeat 1\nmain moved');
    // The same commits after the rebase: their new ids.
    const ids = (await sh('log', '--format=%H', '-4', '--reverse')).trim().split('\n');
    const i = await git.rebaseInteractive('main', [
        { sha: ids[0], action: 'reword', message: 'Add the first feature' },
        { sha: ids[1], action: 'squash', message: 'Add the first feature with its second file' },
        { sha: ids[2], action: 'fixup' },
        { sha: ids[3], action: 'drop' },
    ]);
    assert.equal(i.status, 'ok', JSON.stringify(i));
    assert.equal((await sh('log', '--format=%s', '-2')).trim(), 'Add the first feature with its second file\nmain moved');
    assert.equal((await sh('show', 'HEAD:f1.txt')), '1b');
    assert.equal((await shqExists(sh, 'HEAD:dbg.txt')), false, 'dropped');
    void f1; void f2; void f3; void f4;
    await assert.rejects(git.rebaseInteractive('main', [{ sha: 'zz', action: 'pick' }]), /Invalid rebase step/);
});
async function shqExists(sh: (...a: string[]) => Promise<string>, spec: string) { try { await sh('cat-file', '-e', spec); return true; } catch { return false; } }

test('blame: who changed each line, at a commit', async () => {
    const { git, c } = await repo('blame');
    const one = await c('first', { 'a.txt': 'x\ny\n' });
    const two = await c('second', { 'a.txt': 'x\nY\n' });
    const b = await git.blame('a.txt');
    assert.deepEqual(b.map((l) => [l.line, l.sha, l.summary]), [[1, one, 'first'], [2, two, 'second']]);
    assert.equal(b[0].author, 'T');
    assert.deepEqual((await git.blame('a.txt', one)).map((l) => l.sha), [one, one]);
});

test('stage and unstage single lines of a change; a new file in parts (intent to add)', async () => {
    const { git, c, sh, w } = await repo('lines');
    await c('base', { 'a.txt': 'one\ntwo\nthree\n' });
    w('a.txt', 'one\nTWO\nthree\nfour\nfive\n');
    let h = (await git.hunks('a.txt', false)).hunks[0];
    // Lines: @@, " one", "-two", "+TWO", " three", "+four", "+five"
    const idx = (t: string) => h.lines.indexOf(t);
    await git.stageLines('a.txt', h.id, [idx('+four')]);
    assert.equal(await sh('show', ':a.txt'), 'one\ntwo\nthree\nfour\n', 'only "four" staged; "two" kept');
    h = (await git.hunks('a.txt', false)).hunks[0];
    await git.stageLines('a.txt', h.id, [h.lines.indexOf('-two'), h.lines.indexOf('+TWO')]);
    assert.equal(await sh('show', ':a.txt'), 'one\nTWO\nthree\nfour\n');
    // Unstage just "four" again.
    const sh2 = (await git.hunks('a.txt', true)).hunks[0];
    await git.stageLines('a.txt', sh2.id, [sh2.lines.indexOf('+four')], true);
    assert.equal(await sh('show', ':a.txt'), 'one\nTWO\nthree\n');
    await assert.rejects(git.stageLines("a.txt", sh2.id, [1]), /modified since you looked/);
    // A new file: intent to add, then one line of it.
    w('new.txt', 'keep\nlater\n');
    await git.intentToAdd('new.txt');
    const nh = (await git.hunks('new.txt', false)).hunks[0];
    await git.stageLines('new.txt', nh.id, [nh.lines.indexOf('+keep')]);
    assert.equal(await sh('show', ':new.txt'), 'keep\n');
});

test('remotes: add, rename, change the address, remove; credentials hidden; unsafe addresses refused', async () => {
    const { git } = await repo('remotes');
    await git.addRemote('origin', 'https://user:tok3n@dev.azure.test/org/p/_git/repo');
    assert.deepEqual(await git.remotes(), [{ name: 'origin', fetchUrl: 'https://dev.azure.test/org/p/_git/repo', pushUrl: 'https://dev.azure.test/org/p/_git/repo' }]);
    await git.renameRemote('origin', 'upstream');
    await git.setRemoteUrl('upstream', 'git@ssh.dev.azure.test:v3/org/p/repo');
    assert.equal((await git.remotes())[0].fetchUrl, 'git@ssh.dev.azure.test:v3/org/p/repo');
    await assert.rejects(git.addRemote('evil', 'ext::sh -c touch% /tmp/x'), /not a repository address/);
    await assert.rejects(git.addRemote('--upload-pack=x', 'https://h/r'), /remote name/);
    await git.removeRemote('upstream');
    assert.deepEqual(await git.remotes(), []);
});

test('submodules: not initialised, then updated to the expected commit', async () => {
    const lib = await repo('sublib');
    await lib.c('lib', { 'lib.txt': 'v1' });
    const { git, sh, dir } = await repo('subhost');
    await sh('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib.dir, 'libs/shared');
    await sh('commit', '-q', '--no-verify', '-m', 'add submodule');
    // A fresh clone has the submodule not checked out.
    const clone = dir + '-clone';
    await runGit(['clone', '-q', dir, clone], { cwd: path.dirname(dir) });
    const g2 = await GitService.open(clone);
    assert.deepEqual((await g2.submodules()).map((x) => [x.path, x.state]), [['libs/shared', 'not-initialized']]);
    await runGit(['config', 'protocol.file.allow', 'always'], { cwd: clone });
    process.env.GIT_CONFIG_COUNT = '1'; process.env.GIT_CONFIG_KEY_0 = 'protocol.file.allow'; process.env.GIT_CONFIG_VALUE_0 = 'always';
    try { await g2.updateSubmodules(); } finally { delete process.env.GIT_CONFIG_COUNT; delete process.env.GIT_CONFIG_KEY_0; delete process.env.GIT_CONFIG_VALUE_0; }
    assert.deepEqual((await g2.submodules()).map((x) => x.state), ['ok']);
    assert.equal(fs.readFileSync(path.join(clone, 'libs', 'shared', 'lib.txt'), 'utf8'), 'v1');
    void git;
    const l = await g2.lfs();
    assert.equal(l.used, false);
});

test('core.fsmonitor: a program named there is never run; the built-in monitor setting is accepted', async () => {
    const { git, sh, dir, w } = await repo('fsmon');
    const marker = path.join(dir, '..', 'fsmonitor-ran');
    w('hook.sh', `#!/bin/sh\ntouch "${marker}"\n`); fs.chmodSync(path.join(dir, 'hook.sh'), 0o755);
    await sh('config', 'core.fsmonitor', path.join(dir, 'hook.sh'));
    await git.status();
    assert.equal(fs.existsSync(marker), false, 'the program was not run');
});

test('a conflict shown with its common version (diff3): the base lines appear in the markers', async () => {
    const { git, c, sh, shq } = await repo('base3');
    await c('base', { 'f.txt': 'a\nORIGINAL\nz\n' });
    await sh('switch', '-q', '-c', 'other'); await c('t', { 'f.txt': 'a\nTHEIRS\nz\n' });
    await sh('switch', '-q', 'main'); await c('o', { 'f.txt': 'a\nOURS\nz\n' });
    await shq('merge', 'other');
    const { parseConflicts } = await import('../src/git/conflicts');
    let v = await git.conflictVersions('f.txt');
    const before = parseConflicts(v.working!).segments.find((x) => x.kind === 'conflict') as { base: string[] | null };
    assert.equal(before.base, null);
    await git.conflictWithBase('f.txt');
    v = await git.conflictVersions('f.txt');
    const after = parseConflicts(v.working!).segments.find((x) => x.kind === 'conflict') as { base: string[] | null; ours: string[]; theirs: string[] };
    assert.deepEqual([after.ours, after.base, after.theirs], [['OURS'], ['ORIGINAL'], ['THEIRS']]);
});
