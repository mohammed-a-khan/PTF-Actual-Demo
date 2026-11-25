/** Regression tests for the Git-layer review findings (real temporary repositories). */
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
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-studio-fix-')); });
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

// ---------------------------------------------------------------- item 2: diff config

for (const cfg of [['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true']]) {
    test(`user config ${cfg[0]} does not break scanning, diffs or hunk staging`, async () => {
        const { git, w, sh, c } = await repo('cfg-' + cfg[0]);
        await c('i', { 'r.md': 'x\n', 'src/a.ts': lines(20).join('\n') + '\n' });
        await sh('config', cfg[0], cfg[1]);
        w('src/new.ts', SECRET + '\n');
        await sh('add', 'src/new.ts');
        const res = await scanStaged(path.join(tmp, 'cfg-' + cfg[0]));
        assert.deepEqual(res.findings.map((f) => `${f.file}:${f.line}`), ['src/new.ts:1']);
        const d = await git.diff('src/new.ts', true);
        assert.match(d, /^\+\+\+ b\/src\/new\.ts$/m);
        const L = lines(20); L[1] = 'X2'; L[17] = 'X18';
        w('src/a.ts', L.join('\n') + '\n');
        await git.stageHunks('src/a.ts', [1]);
        assert.match(await sh('diff', '--cached', '--no-prefix', '--', 'src/a.ts'), /\+X18/);
    });
}

// ---------------------------------------------------------------- item 3: scan bypasses

test('scan: .gitattributes "-diff"/binary cannot hide a text file from the scan', async () => {
    const { dir, w, sh, c } = await repo('scan-attr');
    await c('i', { '.gitattributes': 'secrets.txt -diff\n*.cfg binary\n' });
    w('secrets.txt', SECRET + '\n');
    w('app.cfg', 'x\n' + SECRET + '\n');
    await sh('add', '-A');
    const res = await scanStaged(dir);
    assert.deepEqual(res.findings.map((f) => `${f.file}:${f.line}`).sort(), ['app.cfg:2', 'secrets.txt:1']);
});

test('scan: real binary content (NUL bytes) is still skipped under --text', async () => {
    const { dir, w, sh, c } = await repo('scan-bin');
    await c('i', { 'r.md': 'x\n' });
    w('blob.bin', Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('\n' + SECRET + '\0\n')]));
    await sh('add', '-A');
    const res = await scanStaged(dir);
    assert.equal(res.findings.length, 0);
});

test('scanUnpushed: a secret added while resolving a merge conflict is found (remerge-diff)', async () => {
    const { dir, sh, shq, w, c } = await repo('scan-merge');
    await c('i', { 'a.txt': '1\n2\n3\n' });
    await sh('switch', '-q', '-c', 'side');
    await c('s', { 'a.txt': 'side\n2\n3\n' });
    await sh('switch', '-q', 'main');
    await c('f', { 'a.txt': '1\n2\nfeat\n' });
    await shq('merge', '--no-ff', '--no-commit', 'side');
    w('a.txt', `side\n2\nfeat\n${SECRET}\n`);
    await sh('add', 'a.txt');
    await sh('commit', '-q', '--no-verify', '-m', 'merge side');
    const res = await scanUnpushed(dir);
    const merge = (await sh('rev-parse', 'HEAD')).trim();
    assert.deepEqual(res.findingsByCommit[merge].map((f) => `${f.ruleId}@${f.file}:${f.line}`), ['github-token@a.txt:4']);
});

test('scan: a file too large to scan becomes a finding instead of an error', async () => {
    const { dir, w, sh, c, git } = await repo('scan-big');
    await c('i', { 'r.md': 'x\n' });
    const row = '{"r":"abcdefghij"}\n';
    w('fixtures/huge.json', row.repeat(Math.ceil((MAX_SCAN_FILE_BYTES + 1024) / row.length)));
    w('src/small.ts', SECRET + '\n');
    await sh('add', '-A');
    const res = await scanStaged(dir);
    assert.deepEqual(res.findings.map((f) => `${f.ruleId}@${f.file}`).sort(), ['file-too-large-to-scan@fixtures/huge.json', 'github-token@src/small.ts']);
    assert.equal(res.warnings.length, 1);
    const r = await git.commit('add fixture');
    assert.equal(r.status, 'blocked');
});

test('scan: .pem stored with Git LFS is still detected from the working-tree content', async () => {
    const { dir, w, sh, c } = await repo('scan-lfs');
    await c('i', { 'r.md': 'x\n' });
    const clean = path.join(tmp, 'fakelfs.sh');
    fs.writeFileSync(clean, '#!/bin/sh\nc=$(cat | sha256sum | cut -d" " -f1)\nprintf "version https://git-lfs.github.com/spec/v1\\noid sha256:%s\\nsize 99\\n" "$c"\n', { mode: 0o755 });
    await sh('config', 'filter.lfs.clean', clean);
    await sh('config', 'filter.lfs.smudge', 'cat');
    w('.gitattributes', '*.pem filter=lfs diff=lfs merge=lfs -text\n');
    w('certs/client.pem', '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n');
    await sh('add', '-A');
    assert.match(await sh('show', ':certs/client.pem'), /^version https:\/\/git-lfs/);
    const res = await scanStaged(dir);
    assert.ok(res.findings.some((f) => f.ruleId === 'pem-private-key-file' && f.file === 'certs/client.pem'), JSON.stringify(res.findings.map((f) => f.ruleId)));
});

// ---------------------------------------------------------------- item 4: hunks

test('hunks: Latin-1 bytes round-trip when staging a hunk', async () => {
    const { dir, git, c, w, sh } = await repo('hunk-latin1');
    const base = Buffer.from(lines(20).join('\n') + '\n', 'latin1');
    await c('i', { 'f.properties': base });
    const L = lines(20); L[0] = 'name=José'; L[18] = 'other=Müller';
    w('f.properties', Buffer.from(L.join('\n') + '\n', 'latin1'));
    await git.stageHunks('f.properties', [0]);
    const blob = (await runGit(['show', ':f.properties'], { cwd: dir, encoding: 'buffer' })).stdoutBuffer!;
    assert.equal(blob.subarray(0, 10).toString('hex'), Buffer.from('name=José\n', 'latin1').toString('hex'));
    assert.ok(!(await sh('diff', '--cached')).includes('Müller'));
});

test('hunks: ids protect against staging a change that was modified since it was shown', async () => {
    const { git, c, w, sh } = await repo('hunk-stale');
    await c('i', { 'f.txt': lines(40).join('\n') + '\n' });
    const M = lines(40); M[30] = 'WANTED';
    w('f.txt', M.join('\n') + '\n');
    const seen = await git.hunks('f.txt', false);
    assert.equal(seen.hunks.length, 1);
    assert.match(seen.hunks[0].id, /^[0-9a-f]{32}$/);
    M[28] = 'UNREVIEWED'; // close by: the same hunk now contains an unreviewed change
    w('f.txt', M.join('\n') + '\n');
    await assert.rejects(git.stageHunks('f.txt', [seen.hunks[0].id]), (e: Error) => e.message === STALE_HUNK_MESSAGE);
    assert.equal(await sh('diff', '--cached'), '');
    // A current id still works.
    const now = await git.hunks('f.txt', false);
    assert.equal(now.hunks.length, 1);
    await git.stageHunks('f.txt', [now.hunks[0].id]);
    assert.match(await sh('diff', '--cached'), /\+WANTED/);
});

test('hunks: an unchanged hunk keeps its id when another part of the file changes', async () => {
    const { git, c, w, sh } = await repo('hunk-stable');
    await c('i', { 'f.txt': lines(40).join('\n') + '\n' });
    const M = lines(40); M[30] = 'WANTED';
    w('f.txt', M.join('\n') + '\n');
    const seen = await git.hunks('f.txt', false);
    M[2] = 'OTHER';
    w('f.txt', M.join('\n') + '\n');
    await git.stageHunks('f.txt', [seen.hunks[0].id]);
    assert.match(await sh('diff', '--cached'), /\+WANTED/);
    assert.doesNotMatch(await sh('diff', '--cached'), /OTHER/);
});

test('hunks: binary files are reported as binary before "no longer there"', async () => {
    const { git, c, w } = await repo('hunk-bin');
    await c('i', { 'b.dat': Buffer.from([0, 1, 2, 3]) });
    w('b.dat', Buffer.from([0, 1, 2, 4, 5]));
    const h = await git.hunks('b.dat', false);
    assert.equal(h.binary, true);
    await assert.rejects(git.stageHunks('b.dat', [0]), /Binary files can only be staged whole/);
});

test('hunks: a staged rename shows real hunks and unstaging one keeps the rename', async () => {
    const { git, c, sh, w } = await repo('hunk-rename');
    const L = lines(30, 'l');
    await c('i', { 'old.ts': L.join('\n') + '\n' });
    await sh('mv', 'old.ts', 'new.ts');
    const M = [...L]; M[2] = 'A'; M[25] = 'B';
    w('new.ts', M.join('\n') + '\n');
    await sh('add', 'new.ts');
    const h = await git.hunks('new.ts', true);
    assert.equal(h.hunks.length, 2);
    assert.ok(h.header.some((x) => x.startsWith('rename from')));
    await git.stageHunks('new.ts', [h.hunks[0].id], true);
    const st = await sh('status', '--porcelain');
    assert.match(st, /^RM old\.ts -> new\.ts$/m);
    assert.match(await sh('diff', '--cached', '-M'), /\+B/);
    assert.doesNotMatch(await sh('diff', '--cached', '-M'), /\+A$/m);
    // commit/compare views of a renamed file show the real change, not a whole new file
    await sh('add', 'new.ts');
    await sh('commit', '-q', '--no-verify', '-m', 'rename');
    const cd = await git.commitFileDiff('HEAD', 'new.ts');
    assert.match(cd, /rename from old\.ts/);
    assert.doesNotMatch(cd, /new file mode/);
    const cmp = await git.compareFileDiff('HEAD~1', 'HEAD', 'new.ts');
    assert.match(cmp, /rename from old\.ts/);
});

test('hunks: textconv drivers are not used (patch must match the real bytes)', async () => {
    const { git, c, w, sh } = await repo('hunk-textconv');
    await c('i', { '.gitattributes': '*.txt diff=upper\n', 'f.txt': lines(20).join('\n') + '\n' });
    await sh('config', 'diff.upper.textconv', 'tr a-z A-Z <');
    const L = lines(20); L[0] = 'changed';
    w('f.txt', L.join('\n') + '\n');
    const h = await git.hunks('f.txt', false);
    assert.ok(h.hunks[0].lines.includes('+changed'));
    await git.stageHunks('f.txt', [h.hunks[0].id]);
    assert.match(await sh('show', ':f.txt'), /^changed\n/);
});

// ---------------------------------------------------------------- item 5: branch from remote, push

test('branch created from a remote branch under another name pushes under its own name', async () => {
    const { git, c, sh } = await repo('push-name', true);
    await c('i', { 'a.txt': '1\n' });
    await sh('push', '-q', '-u', 'origin', 'main');
    await git.createBranch('local-name', { from: 'origin/main' });
    assert.equal((await git.status()).upstream, null, 'no tracking of a differently named branch');
    await c('z', { 'z.txt': 'z\n' });
    const p = await git.push();
    assert.equal(p.status, 'ok', JSON.stringify(p));
    assert.equal((await git.status()).upstream, 'origin/local-name');
    // A branch whose upstream already has another name (set up outside the Studio) also works.
    await sh('switch', '-q', '--track', '-c', 'other', 'origin/main');
    await c('o', { 'o.txt': 'o\n' });
    const p2 = await git.push();
    assert.equal(p2.status, 'ok', JSON.stringify(p2));
    assert.match(await sh('ls-remote', '--heads', 'origin'), /refs\/heads\/other/);
    // Same name: tracks.
    await sh('push', '-q', 'origin', 'main:refs/heads/feat');
    await sh('fetch', '-q');
    await git.createBranch('feat', { from: 'origin/feat' });
    assert.equal((await git.status()).upstream, 'origin/feat');
});

// ---------------------------------------------------------------- item 6: modify/delete

test('modify/delete conflict: taking the deleting side deletes the file', async () => {
    const { git, c, sh, dir } = await repo('moddel');
    await c('i', { 'md.txt': 'base\n', 'dm.txt': 'base\n' });
    await sh('switch', '-q', '-c', 'theirs');
    fs.rmSync(path.join(dir, 'dm.txt'));
    await c('t', { 'md.txt': 'theirs change\n' });
    await sh('switch', '-q', 'main');
    fs.rmSync(path.join(dir, 'md.txt'));
    await c('o', { 'dm.txt': 'ours change\n' });
    const m = await git.merge('theirs');
    assert.equal(m.status, 'conflicts');
    const v = await git.conflictVersions('md.txt');
    assert.equal(v.deletedOurs, true);
    assert.equal(v.deletedTheirs, false);
    const r1 = await git.resolveConflict('md.txt', 'ours');
    assert.equal(r1.deleted, true);
    assert.equal(fs.existsSync(path.join(dir, 'md.txt')), false);
    const r2 = await git.resolveConflict('dm.txt', 'theirs');
    assert.equal(r2.deleted, true);
    const st = await git.status();
    assert.equal(st.hasConflicts, false);
    assert.deepEqual(st.files.map((f) => `${f.staged} ${f.path}`), ['D dm.txt']);
});

// ---------------------------------------------------------------- item 7: reset during conflicts

test('hard reset during a conflicted merge snapshots the work and is not blocked', async () => {
    const { git, c, sh, w } = await repo('reset-conflict');
    await c('i', { 'a.txt': '1\n' });
    await sh('switch', '-q', '-c', 't');
    await c('t', { 'a.txt': 't\n' });
    await sh('switch', '-q', 'main');
    await c('o', { 'a.txt': 'o\n' });
    await git.merge('t');
    w('notes.txt', 'my unsaved notes\n');
    await sh('add', 'notes.txt');
    const r = await git.reset('HEAD', 'hard');
    assert.ok(r.uncommittedBackup, 'snapshot was made');
    assert.equal((await git.status()).operation, null);
    assert.match(await sh('show', `${r.uncommittedBackup}:notes.txt`), /my unsaved notes/);
    await git.restoreBackup(r.uncommittedBackup!);
    assert.equal(fs.readFileSync(path.join(tmp, 'reset-conflict', 'notes.txt'), 'utf8'), 'my unsaved notes\n');
});

test('recovery points are created without overwriting (parallel resets get distinct refs)', async () => {
    const { git, c, sh } = await repo('reset-par');
    await c('i', { 'a.txt': '1\n' });
    const refs = await Promise.all([1, 2, 3, 4].map(() => git.reset('HEAD', 'soft').then((x) => x.backup)));
    assert.equal(new Set(refs).size, 4);
    assert.equal((await sh('for-each-ref', 'refs/cs-studio/backups')).trim().split('\n').length, 4);
});

// ---------------------------------------------------------------- item 8: empty revert continue

test('continue after a revert whose resolution is empty skips with "revert --skip"', async () => {
    const { git, c } = await repo('rev-empty');
    await c('i', { 'a.txt': '1\n' });
    const c2 = await c('two', { 'a.txt': '2\n' });
    await c('three', { 'a.txt': '3\n' });
    const r = await git.revert(c2);
    assert.equal(r.status, 'conflicts');
    await git.resolveConflict('a.txt', 'ours');
    const k = await git.continueOperation();
    assert.equal(k.status, 'ok', JSON.stringify(k));
    assert.equal((await git.status()).operation, null);
});

test('revert of a change that is already undone reports "nothing new"', async () => {
    const { git, c, dir, sh } = await repo('rev-noop');
    await c('i', { 'a.txt': '1\n' });
    const added = await c('add b', { 'b.txt': 'b\n' });
    fs.rmSync(path.join(dir, 'b.txt'));
    await sh('commit', '-q', '-am', 'manual undo');
    const r = await git.revert(added);
    assert.equal(r.status, 'ok', JSON.stringify(r));
    assert.match(r.message ?? '', /already/);
});

// ---------------------------------------------------------------- item 9: rebase / am

test('rebase started elsewhere: status exposes the swapped sides; git am is detected and aborted', async () => {
    const { git, c, sh, shq } = await repo('rebase-info');
    await c('i', { 'a.txt': 'base\n' });
    await sh('switch', '-q', '-c', 'feature');
    await c('feat', { 'a.txt': 'MINE\n' });
    await sh('switch', '-q', 'main');
    await c('up', { 'a.txt': 'upstream\n' });
    await sh('switch', '-q', 'feature');
    await shq('rebase', 'main');
    const st = await git.status();
    assert.equal(st.operation, 'rebase');
    assert.equal(st.sidesSwapped, true);
    assert.equal(st.rebaseBranch, 'feature');
    assert.equal(st.rebaseOnto, 'main');
    const v = await git.conflictVersions('a.txt');
    assert.equal(v.operation, 'rebase');
    assert.equal(v.sidesSwapped, true);
    assert.equal(v.ours, 'upstream\n');
    await git.abortOperation();
    assert.equal((await git.status()).operation, null);

    // git am that stops on a conflict
    const patch = await sh('format-patch', '-1', '--stdout', 'feature');
    await sh('switch', '-q', 'main');
    await runGit(['am'], { cwd: path.join(tmp, 'rebase-info'), input: patch, allowFailure: true });
    assert.equal((await git.status()).operation, 'am');
    await git.abortOperation();
    assert.equal((await git.status()).operation, null);
});

test('rebase and git am continue in the Studio: each conflicted commit resolved and continued; a commit can be skipped', async () => {
    const { git, c, sh, shq } = await repo('rebase-cont');
    await c('i', { 'a.txt': 'base\n', 'b.txt': 'base\n', 'c.txt': 'base\n' });
    await sh('switch', '-q', '-c', 'feature');
    await c('feat a', { 'a.txt': 'MINE a\n' });
    await c('feat b', { 'b.txt': 'MINE b\n' });
    await c('feat c', { 'c.txt': 'MINE c\n' });
    await sh('switch', '-q', 'main');
    await c('up', { 'a.txt': 'upstream a\n', 'b.txt': 'upstream b\n', 'c.txt': 'upstream c\n' });
    await sh('switch', '-q', 'feature');
    await shq('rebase', 'main');
    assert.equal((await git.status()).operation, 'rebase');
    // 1st commit: keep mine (during a rebase "theirs" is the commit being applied).
    await git.resolveConflict('a.txt', 'theirs');
    let k = await git.continueOperation();
    assert.equal(k.status, 'rejected', 'the next commit stops on its conflict');
    assert.deepEqual(k.conflicts, ['b.txt']);
    // 2nd commit: skip it.
    const sk = await git.skipOperation();
    assert.equal(sk.status, 'conflicts');
    assert.deepEqual(sk.conflicts, ['c.txt']);
    // 3rd commit: keep upstream: the commit becomes empty and is left out by itself.
    await git.resolveConflict('c.txt', 'ours');
    k = await git.continueOperation();
    assert.equal(k.status, 'ok', JSON.stringify(k));
    assert.equal((await git.status()).operation, null);
    assert.equal((await sh('log', '--format=%s', 'main..feature')).trim(), 'feat a');
    assert.equal((await sh('show', 'feature:a.txt')).trim(), 'MINE a');
    assert.equal((await sh('show', 'feature:b.txt')).trim(), 'upstream b');

    // git am: resolve and continue.
    const patch = await sh('format-patch', '-1', '--stdout', 'HEAD');
    await sh('switch', '-q', '-c', 'other', 'main~1');
    await c('other side', { 'a.txt': 'other\n' });
    await runGit(['am', '-3'], { cwd: path.join(tmp, 'rebase-cont'), input: patch, allowFailure: true });
    assert.equal((await git.status()).operation, 'am');
    await git.resolveConflict('a.txt', 'theirs');
    k = await git.continueOperation();
    assert.equal(k.status, 'ok', JSON.stringify(k));
    assert.equal((await git.status()).operation, null);
    assert.equal((await sh('log', '-1', '--format=%s')).trim(), 'feat a');
    assert.equal((await sh('show', 'HEAD:a.txt')).trim(), 'MINE a');
    assert.equal((await git.skipOperation()).status, 'rejected', 'nothing in progress');
});

// ---------------------------------------------------------------- item 10: hooks

test('hooks: refuse to install into a tracked core.hooksPath (husky) and leave it untouched', async () => {
    const { dir, c, sh } = await repo('hooks-husky');
    await c('i', { 'a.txt': '1\n', '.husky/pre-commit': '#!/bin/sh\necho husky\n' });
    await sh('config', 'core.hooksPath', '.husky');
    await assert.rejects(installHooks(dir, { cliPath: '/x/cli.js', nodePath: '/bin/true' }), (e: Error) => e.name === 'UserError' && /core\.hooksPath=\.husky/.test(e.message) && /hook run pre-commit/.test(e.message));
    assert.equal(await sh('status', '--porcelain'), '');
    assert.equal(fs.readFileSync(path.join(dir, '.husky/pre-commit'), 'utf8'), '#!/bin/sh\necho husky\n');
});

test('hooks: refuse a core.hooksPath outside the repository', async () => {
    const { dir, c, sh } = await repo('hooks-shared');
    await c('i', { 'a.txt': '1\n' });
    const shared = path.join(tmp, 'shared-hooks');
    fs.mkdirSync(shared, { recursive: true });
    await sh('config', 'core.hooksPath', shared);
    await assert.rejects(installHooks(dir, { cliPath: '/x/cli.js', nodePath: '/bin/true' }), /outside this repository/);
    assert.deepEqual(fs.readdirSync(shared), []);
});

// ---------------------------------------------------------------- item 11: names

test('valid git names with # and non-ASCII characters are accepted', async () => {
    const { git, c, sh } = await repo('names');
    await c('i', { 'a.txt': '1\n' });
    await sh('branch', 'fix#123');
    await git.createBranch('tâche', { from: 'fix#123', switchTo: false });
    await git.switchBranch('tâche');
    assert.equal((await git.status()).branch, 'tâche');
    await git.switchBranch('main');
    assert.equal((await git.deleteBranch('fix#123')).status, 'ok');
    await assert.rejects(git.createBranch('x', { from: '--orphan' }), /not a valid/);
    await assert.rejects(git.switchBranch('-f'), /not a valid/);
});

// ---------------------------------------------------------------- item 12: history

test('history: full ref names, firstParent and filtered parents, author search with "["', async () => {
    const { git, c, sh } = await repo('hist-refs');
    await c('i', { 'a.txt': '1\n' });
    await git.createBranch('feature/x');
    await c('feat', { 'b.txt': 'b\n' });
    await git.switchBranch('main');
    await c('main work', { 'a.txt': '2\n' });
    await sh('merge', '-q', '--no-ff', '-m', 'merge feature', 'feature/x');
    const h = await git.history({ all: true });
    const refs = h.commits.flatMap((x) => x.refs);
    assert.ok(refs.some((r) => r.name === 'feature/x' && r.kind === 'branch'), JSON.stringify(refs));
    const fp = await git.history({ firstParent: true });
    assert.ok(fp.commits.every((x) => x.parents.length <= 1));
    assert.equal(Math.max(...fp.graph.map((g) => g.width)), 1);
    const grep = await git.history({ text: 'merge', field: 'message' });
    assert.equal(grep.commits.length, 1);
    assert.deepEqual(grep.commits[0].parents, [], 'parents not in the result are dropped');
    assert.equal(grep.graph[0].width, 1);
    const author = await git.history({ text: '[', field: 'author' });
    assert.equal(author.commits.length, 0);
    const bypath = await git.history({ text: 'b.txt', field: 'path', all: true });
    assert.deepEqual(bypath.commits.map((x) => x.subject), ['feat']);
});

// ---------------------------------------------------------------- items 14-18

test('merge message strips comments using core.commentChar', async () => {
    assert.equal(stripComments("Merge branch 't'\n\n; Conflicts:\n;\ta.txt\n", ';'), "Merge branch 't'");
    assert.equal(stripComments('#123 fix\n', ';'), '#123 fix');
    const { git, c, sh } = await repo('commentchar');
    await sh('config', 'core.commentChar', ';');
    await c('i', { 'a.txt': '1\n' });
    await sh('switch', '-q', '-c', 't');
    await c('t', { 'a.txt': 't\n' });
    await sh('switch', '-q', 'main');
    await c('o', { 'a.txt': 'o\n' });
    await git.merge('t');
    await git.resolveConflict('a.txt', 'ours');
    assert.equal((await git.status()).mergeMessage, "Merge branch 't'");
    const r = await git.continueOperation();
    assert.equal(r.status, 'ok');
    assert.doesNotMatch(await sh('log', '-1', '--format=%B'), /^;/m);
});

test('tags: annotated tags and tags of tags resolve to the commit', async () => {
    const { git, c, sh } = await repo('tags');
    const head = await c('i', { 'a.txt': '1\n' });
    await sh('tag', '-a', 'ann', '-m', 'm');
    await sh('tag', '-a', 'tagoftag', '-m', 'nested', 'ann');
    const t = await git.tags();
    assert.equal(t.find((x) => x.name === 'ann')!.sha, head);
    assert.equal(t.find((x) => x.name === 'tagoftag')!.sha, head);
});

test('stashFiles: untracked files with non-ASCII names are listed unquoted', async () => {
    const { git, c, w } = await repo('stash-u');
    await c('i', { 'a.txt': '1\n' });
    w('résumé "x".txt', 'u\n');
    w('a.txt', '2\n');
    await git.stashSave('', true);
    const files = await git.stashFiles(0);
    assert.deepEqual(files.map((f) => f.path).sort(), ['a.txt', 'résumé "x".txt']);
});

test('upstream gone is reported by status() and branches()', async () => {
    const { git, c, sh, remote } = await repo('gone', true);
    await c('i', { 'a.txt': '1\n' });
    await sh('push', '-q', '-u', 'origin', 'main');
    await sh('switch', '-q', '-c', 'feat');
    await sh('push', '-q', '-u', 'origin', 'feat');
    assert.equal((await git.status()).upstreamGone, false);
    await runGit(['branch', '-D', 'feat'], { cwd: remote });
    await git.fetch();
    assert.equal((await git.status()).upstreamGone, true);
    assert.equal((await git.branches()).find((b) => b.name === 'feat')!.upstreamGone, true);
    assert.equal((await git.branches()).find((b) => b.name === 'main')!.upstreamGone, false);
});

test('cherry-pick of a merge commit uses the first parent as mainline', async () => {
    const { git, c, sh } = await repo('cp-merge');
    await c('i', { 'a.txt': '1\n' });
    await sh('switch', '-q', '-c', 'f');
    await c('fb', { 'b.txt': 'b\n' });
    await sh('switch', '-q', 'main');
    await c('mc', { 'c.txt': 'c\n' });
    await sh('merge', '-q', '--no-ff', '-m', 'merge f', 'f');
    const merge = (await sh('rev-parse', 'HEAD')).trim();
    await sh('switch', '-q', '-c', 'other', 'HEAD~1');
    const r = await git.cherryPick([merge]);
    assert.equal(r.status, 'ok', JSON.stringify(r));
    assert.match(await sh('ls-files'), /b\.txt/);
});

// ---------------------------------------------------------------- item 20: errors / lock

test('index.lock errors are explained; removeStaleLock only removes old locks', async () => {
    assert.equal(explainGitFailure("fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running"), INDEX_LOCK_MESSAGE);
    const { git, c, dir, w } = await repo('lock');
    await c('i', { 'a.txt': '1\n' });
    const lock = path.join(dir, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    w('a.txt', '2\n');
    await assert.rejects(git.stage(['a.txt']));
    const r = await git.commit('x').catch((e: Error) => e);
    assert.ok(r);
    assert.equal((await git.removeStaleLock()).removed, false, 'recent lock kept');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    assert.equal((await git.removeStaleLock()).removed, true);
    assert.equal(fs.existsSync(lock), false);
    await git.stage(['a.txt']);
});

test('fetch failures are explained', async () => {
    const { git, sh } = await repo('fetch-fail');
    await sh('remote', 'add', 'origin', path.join(tmp, 'does-not-exist.git'));
    await assert.rejects(git.fetch(), /Git could not reach the remote repository/);
});

// ---------------------------------------------------------------- H3: git binary resolution

test('git binary: absolute PATH entries only; a git in the working directory is never used', () => {
    const bin = path.join(tmp, 'bin-a');
    const cwdDir = path.join(tmp, 'evil-cwd');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(cwdDir, { recursive: true });
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(cwdDir, 'git'), '#!/bin/sh\n', { mode: 0o755 });
    const prev = process.cwd();
    process.chdir(cwdDir);
    try {
        assert.equal(resolveGitBinary({ PATH: ['', '.', 'relative/dir', bin].join(':') }, 'linux'), path.join(bin, 'git'));
        assert.equal(resolveGitBinary({ PATH: ['.', ''].join(':') }, 'linux'), 'git');
        assert.equal(resolveGitBinary({ PATH: bin, CS_STUDIO_GIT: '/opt/git/bin/git' }, 'linux'), '/opt/git/bin/git');
    } finally { process.chdir(prev); }
    // Windows: git.exe / PATHEXT variants, drive-absolute entries only.
    const winBin = path.join(tmp, 'winbin');
    fs.mkdirSync(winBin, { recursive: true });
    fs.writeFileSync(path.join(winBin, 'git.exe'), '');
    if (process.platform === 'win32') {
        assert.equal(resolveGitBinary({ Path: `.;relative;${winBin}`, PATHEXT: '.COM;.EXE' }, 'win32'), path.join(winBin, 'git.exe'));
    } else {
        assert.equal(resolveGitBinary({ Path: '.;relative', PATHEXT: '.COM;.EXE' }, 'win32'), 'git');
    }
});

test('while a merge is unfinished, starting a revert, cherry-pick, merge or switch says so clearly', async () => {
    const { git, c, sh } = await repo('busy-merge');
    const first = await c('i', { 'a.txt': '1\n' });
    await sh('switch', '-q', '-c', 't');
    await c('t', { 'a.txt': 't\n' });
    await sh('switch', '-q', 'main');
    await c('o', { 'a.txt': 'o\n' });
    assert.equal((await git.merge('t')).status, 'conflicts');
    for (const attempt of [() => git.revert(first), () => git.cherryPick([first]), () => git.merge('t'), () => git.switchBranch('t')]) {
        await assert.rejects(attempt(), /A merge is still in progress\. Finish it first .* or abort it, before you/);
    }
    assert.equal((await git.status()).operation, 'merge');
});

test('pop keeps staged files staged (and still works when the staged part cannot be restored)', async () => {
    const { git, c, sh, w } = await repo('stash-index');
    await c('i', { 'a.txt': '1\n', 'b.txt': '1\n' });
    w('a.txt', 'staged\n'); await sh('add', 'a.txt');
    w('b.txt', 'unstaged\n');
    await git.stashSave('mixed', true);
    assert.equal((await git.stashApply(0, true)).status, 'ok');
    const st = await git.status();
    assert.deepEqual(st.files.map((f) => `${f.staged}${f.unstaged} ${f.path}`).sort(), ['.M b.txt', 'M. a.txt']);
});
