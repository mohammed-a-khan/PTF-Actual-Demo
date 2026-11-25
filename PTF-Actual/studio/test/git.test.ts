/**
 * End-to-end tests against real temporary Git repositories (and a bare "remote").
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { GitService } from '../src/git/service';
import { runGit } from '../src/git/run';
import { addToAllowlist } from '../src/scanner/allowlist';
import { installHooks } from '../src/git/hooks';

let tmp: string;
const SECRET_LINE = 'const login = { password: "Tr0ub4dor&3" };\n';

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-studio-git-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

async function newRepo(name: string): Promise<{ dir: string; git: GitService; remote: string }> {
    const remote = path.join(tmp, `${name}.git`);
    const dir = path.join(tmp, name);
    await runGit(['init', '-q', '--bare', '-b', 'main', remote], { cwd: tmp });
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    for (const [k, v] of [['user.name', 'Test User'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false']]) {
        await runGit(['config', k, v], { cwd: dir });
    }
    await runGit(['remote', 'add', 'origin', remote], { cwd: dir });
    return { dir, git: await GitService.open(dir), remote };
}

const write = (dir: string, file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
};
const lastMessage = async (dir: string) => (await runGit(['log', '-1', '--format=%B'], { cwd: dir })).stdout;

test('clean commit and first push set the upstream', async () => {
    const { dir, git } = await newRepo('clean');
    write(dir, 'src/a.ts', 'export const a = 1;\n');
    await git.stage(['src/a.ts']);
    const st = await git.status();
    assert.deepEqual(st.files.map((f) => [f.path, f.staged]), [['src/a.ts', 'A']]);
    const c = await git.commit('Add a');
    assert.equal(c.status, 'ok');
    const p = await git.push();
    assert.equal(p.status, 'ok', JSON.stringify(p));
    const after = await git.status();
    assert.equal(after.upstream, 'origin/main');
    assert.equal(after.ahead, 0);
    assert.equal((await git.log()).length, 1);
});

test('commit with a secret is blocked; override needs a reason and the reviewed digest', async () => {
    const { dir, git } = await newRepo('blocked');
    write(dir, 'src/login.ts', SECRET_LINE);
    await git.stage(['src/login.ts']);

    const r1 = await git.commit('Add login');
    assert.equal(r1.status, 'blocked');
    if (r1.status !== 'blocked') return;
    assert.equal(r1.findings.length, 1);
    assert.equal(r1.findings[0].file, 'src/login.ts');
    assert.equal(r1.findings[0].line, 1);
    assert.ok(!JSON.stringify(r1).includes('Tr0ub4dor&3'), 'raw value must not leave the service');
    assert.equal(r1.overrideAllowed, true);

    const short = await git.commit('Add login', { reason: 'ok', digest: r1.digest });
    assert.equal(short.status, 'rejected');

    const stale = await git.commit('Add login', { reason: 'Known test account', digest: 'not-the-digest' });
    assert.equal(stale.status, 'blocked');

    const ok = await git.commit('Add login', { reason: 'Known test account on local mock', digest: r1.digest });
    assert.equal(ok.status, 'ok');
    assert.match(await lastMessage(dir), /\n\nSecret-Scan-Override: Known test account on local mock\n*$/);
});

test('override is bound to content: changing the staged secret invalidates it', async () => {
    const { dir, git } = await newRepo('rebind');
    write(dir, 'a.ts', SECRET_LINE);
    await git.stage(['a.ts']);
    const r1 = await git.commit('x');
    assert.equal(r1.status, 'blocked');
    write(dir, 'a.ts', 'const login = { password: "Other!Value9" };\n');
    await git.stage(['a.ts']);
    const r2 = await git.commit('x', { reason: 'reviewed earlier finding', digest: r1.status === 'blocked' ? r1.digest : '' });
    assert.equal(r2.status, 'blocked');
});

test('team policy can forbid overrides', async () => {
    const { dir, git } = await newRepo('policy');
    write(dir, '.cs-studio/policy.json', JSON.stringify({ secretScan: { allowOverride: false } }));
    write(dir, 'a.ts', SECRET_LINE);
    await git.stage(['a.ts']);
    const r1 = await git.commit('x');
    assert.equal(r1.status, 'blocked');
    if (r1.status !== 'blocked') return;
    assert.equal(r1.overrideAllowed, false);
    const r2 = await git.commit('x', { reason: 'please let me commit', digest: r1.digest });
    assert.equal(r2.status, 'rejected');
});

test('allowlisted finding no longer blocks', async () => {
    const { dir, git } = await newRepo('allow');
    write(dir, 'a.ts', SECRET_LINE);
    await git.stage(['a.ts']);
    const r1 = await git.commit('x');
    assert.equal(r1.status, 'blocked');
    if (r1.status !== 'blocked') return;
    addToAllowlist(dir, { fingerprint: r1.findings[0].fingerprint, ruleId: r1.findings[0].ruleId, file: 'a.ts', reason: 'public demo password', addedBy: 'Test User', addedAt: new Date().toISOString() });
    await git.stage(['a.ts', '.cs-studio/secret-allowlist.json']);
    assert.equal((await git.commit('x')).status, 'ok');
    assert.ok(!fs.readFileSync(path.join(dir, '.cs-studio/secret-allowlist.json'), 'utf8').includes('Tr0ub4dor'));
});

test('stored secret values are caught even without a pattern', async () => {
    const dir = (await newRepo('known')).dir;
    const git = await GitService.open(dir, { knownSecrets: () => [{ name: 'QA_PWD', value: 'bluehorse42' }] });
    write(dir, 'notes.md', 'qa login: bluehorse42\n');
    await git.stage(['notes.md']);
    const r = await git.commit('notes');
    assert.equal(r.status, 'blocked');
    if (r.status === 'blocked') assert.equal(r.findings[0].ruleId, 'known-secret-value');
});

test('push re-scans commits made outside the Studio', async () => {
    const { dir, git } = await newRepo('push');
    write(dir, 'ok.ts', 'export {};\n');
    await git.stage(['ok.ts']);
    await git.commit('base');
    assert.equal((await git.push()).status, 'ok');
    // A plain command-line commit (no hooks installed) sneaks a secret in.
    write(dir, 'src/login.ts', SECRET_LINE);
    await runGit(['add', '.'], { cwd: dir });
    await runGit(['commit', '-q', '-m', 'cli commit'], { cwd: dir });
    const p1 = await git.push();
    assert.equal(p1.status, 'blocked');
    if (p1.status !== 'blocked') return;
    assert.equal(p1.findings[0].file, 'src/login.ts');
    const p2 = await git.push({ reason: 'Mock server password, not real', digest: p1.digest });
    assert.equal(p2.status, 'ok', JSON.stringify(p2));
});

test('unstage works before the first commit and after', async () => {
    const { dir, git } = await newRepo('unstage');
    write(dir, 'a.ts', '1\n');
    await git.stage(['a.ts']);
    await git.unstage(['a.ts']);
    assert.equal((await git.status()).files[0].untracked, true);
    await git.stage(['a.ts']);
    await git.commit('a');
    write(dir, 'a.ts', '2\n');
    await git.stage(['a.ts']);
    await git.unstage(['a.ts']);
    const f = (await git.status()).files[0];
    assert.deepEqual([f.staged, f.unstaged], ['.', 'M']);
});

test('branches, merge conflict, three versions, resolve, commit', async () => {
    const { dir, git } = await newRepo('merge');
    write(dir, 'f.txt', 'line1\nshared\nline3\n');
    await git.stage(['f.txt']);
    await git.commit('base');
    await git.createBranch('feature/x');
    write(dir, 'f.txt', 'line1\nfeature change\nline3\n');
    await git.stage(['f.txt']);
    await git.commit('feature');
    await git.switchBranch('main');
    write(dir, 'f.txt', 'line1\nmain change\nline3\n');
    await git.stage(['f.txt']);
    await git.commit('main');

    const names = (await git.branches()).filter((b) => !b.remote).map((b) => b.name).sort();
    assert.deepEqual(names, ['feature/x', 'main']);

    const m = await git.merge('feature/x');
    assert.equal(m.status, 'conflicts');
    assert.deepEqual(m.conflicts, ['f.txt']);
    const v = await git.conflictVersions('f.txt');
    assert.match(v.base!, /shared/);
    assert.match(v.ours!, /main change/);
    assert.match(v.theirs!, /feature change/);

    await git.resolveConflict('f.txt', { content: 'line1\nmain change\nfeature change\nline3\n' });
    assert.equal((await git.status()).hasConflicts, false);
    const c = await git.commit('Merge feature/x');
    assert.equal(c.status, 'ok');
    assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'line1\nmain change\nfeature change\nline3\n');
});

test('invalid branch names and paths outside the repo are refused', async () => {
    const { git } = await newRepo('guard');
    await assert.rejects(git.createBranch('bad..name'));
    await assert.rejects(git.createBranch('-x'));
    assert.throws(() => git.safePath('../outside.txt'));
});

test('pull reports conflicts', async () => {
    const { dir, git, remote } = await newRepo('pull');
    write(dir, 'f.txt', 'a\n');
    await git.stage(['f.txt']);
    await git.commit('base');
    await git.push();
    // A teammate pushes a change.
    const other = path.join(tmp, 'pull-other');
    await runGit(['clone', '-q', remote, other], { cwd: tmp });
    await runGit(['-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'commit', '-q', '--allow-empty', '-m', 'noop'], { cwd: other });
    fs.writeFileSync(path.join(other, 'f.txt'), 'teammate\n');
    await runGit(['-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'commit', '-q', '-am', 'theirs'], { cwd: other });
    await runGit(['push', '-q'], { cwd: other });
    // We change the same line locally.
    write(dir, 'f.txt', 'mine\n');
    await git.stage(['f.txt']);
    await git.commit('mine');
    const pushed = await git.push();
    assert.equal(pushed.status, 'rejected');
    if (pushed.status === 'rejected') assert.match(pushed.message, /Pull first/);
    const p = await git.pull();
    assert.equal(p.status, 'conflicts');
    await git.resolveConflict('f.txt', 'theirs');
    assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'teammate\n');
});

test('installed hooks block command-line commits and record overrides', async () => {
    const { dir } = await newRepo('hooks');
    fs.writeFileSync(path.join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\necho previous-hook-ran > "$(git rev-parse --git-dir)/prev-ran"\n', { mode: 0o755 });
    const cli = path.resolve(__dirname, '../src/cli.js');
    await installHooks(dir, { cliPath: cli });
    assert.ok(fs.existsSync(path.join(dir, '.git/hooks/pre-commit.cs-studio-previous')));

    write(dir, 'src/login.ts', SECRET_LINE);
    await runGit(['add', '.'], { cwd: dir });
    const blocked = spawnSync('git', ['commit', '-m', 'from cli'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CS_STUDIO_HOME: path.join(tmp, 'home-hooks'), CS_STUDIO_OVERRIDE_REASON: '' } });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /Secret scan stopped this commit/);
    assert.ok(!blocked.stderr.includes('Tr0ub4dor&3'));
    assert.ok(fs.existsSync(path.join(dir, '.git/prev-ran')), 'existing hook is chained');

    const ok = spawnSync('git', ['commit', '-m', 'from cli'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CS_STUDIO_HOME: path.join(tmp, 'home-hooks'), CS_STUDIO_OVERRIDE_REASON: 'Fixture for the login mock' } });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(await lastMessage(dir), /Secret-Scan-Override: Fixture for the login mock/);

    // The Studio's own commit (already reviewed) passes the hook without a second prompt.
    const git = await GitService.open(dir);
    write(dir, 'src/b.ts', 'const x = { token: "Zz9!abcdefg" };\n');
    await git.stage(['src/b.ts']);
    const r = await git.commit('studio commit');
    assert.equal(r.status, 'blocked');
    if (r.status !== 'blocked') return;
    const done = await git.commit('studio commit', { reason: 'Reviewed in the Studio', digest: r.digest });
    assert.equal(done.status, 'ok', JSON.stringify(done));
    const msg = await lastMessage(dir);
    assert.equal((msg.match(/Secret-Scan-Override/g) ?? []).length, 1, msg);
});

test('merge: status carries git\'s merge message; conflict versions include the marked-up working file', async () => {
    const { dir, git } = await newRepo('merge-msg');
    write(dir, 'c.env', 'A=1\nTIMEOUT=30000\nB=2\n');
    await git.stage(['c.env']); await git.commit('base');
    await git.createBranch('feature/t');
    write(dir, 'c.env', 'A=1\nTIMEOUT=60000\nB=2\n'); await git.stage(['c.env']); await git.commit('t');
    await git.switchBranch('main');
    write(dir, 'c.env', 'A=1\nTIMEOUT=45000\nB=2\n'); await git.stage(['c.env']); await git.commit('m');
    assert.equal((await git.merge('feature/t')).status, 'conflicts');
    const st = await git.status();
    assert.equal(st.mergeMessage, "Merge branch 'feature/t'");
    const v = await git.conflictVersions('c.env');
    assert.match(v.working!, /<<<<<<< HEAD\nTIMEOUT=45000\n=======\nTIMEOUT=60000\n>>>>>>> feature\/t\n/);
});

test('a merge resolved to the current version can still be committed', async () => {
    const { dir, git } = await newRepo('merge-same');
    write(dir, 'c.env', 'T=1\n'); await git.stage(['c.env']); await git.commit('base');
    await git.createBranch('f'); write(dir, 'c.env', 'T=2\n'); await git.stage(['c.env']); await git.commit('f');
    await git.switchBranch('main'); write(dir, 'c.env', 'T=3\n'); await git.stage(['c.env']); await git.commit('m');
    await git.merge('f');
    await git.resolveConflict('c.env', 'ours');
    const st = await git.status();
    const r = await git.commit(st.mergeMessage!);
    assert.equal(r.status, 'ok', JSON.stringify(r));
    assert.equal((await runGit(['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd: dir })).stdout.trim().split(' ').length, 3, 'two parents');
});
