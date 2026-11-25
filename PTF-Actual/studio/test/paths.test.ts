import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { safeRepoPath } from '../src/core/safePath';
import { Workspace } from '../src/workspace/files';
import { createEnvironment, removeKey, setValue, envEntries } from '../src/env/edit';

const mk = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-paths-')));

test('symbolic links cannot take a save or delete outside the project', async () => {
    const root = mk(); const outside = mk();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'keep');
    fs.mkdirSync(path.join(root, 'config/p/environments'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'linkdir'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'config/p/environments/dev.env'));
    fs.writeFileSync(path.join(root, 'real.ts'), 'x');
    fs.symlinkSync(path.join(root, 'real.ts'), path.join(root, 'alias.ts'));
    const ws = new Workspace(root);
    assert.throws(() => ws.write('linkdir/secret.txt', 'pwned', null), /outside the project/);
    assert.throws(() => ws.write('linkdir/new.txt', 'pwned', null), /outside the project/);
    assert.throws(() => ws.read('linkdir/secret.txt'), /outside the project/);
    assert.throws(() => ws.write('alias.ts', 'y', ws.read('real.ts').hash), /is a link/);
    await assert.rejects(ws.remove('linkdir/secret.txt'), /outside the project/);
    assert.throws(() => setValue(root, 'config/p/environments/dev.env', 'A', '1'), /outside|link/);
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'keep');
    assert.ok(!fs.existsSync(path.join(outside, 'new.txt')));
});

test('.git in any spelling and Windows-special names are refused', () => {
    const root = mk();
    fs.mkdirSync(path.join(root, '.git'));
    for (const p of ['.git/config', '.GIT/config', '.git./config', 'GIT~1/config', '.git::$INDEX_ALLOCATION/config', 'sub/.git/hooks/pre-commit', 'a/con', 'a/NUL.txt', 'a/file. ', 'a/x:stream'])
        assert.throws(() => safeRepoPath(root, p, { write: true }), /./, p);
    for (const p of ['.github/workflows/ci.yml', 'test/a.steps.ts', 'docs/console.md', 'gitignore.txt'])
        assert.equal(safeRepoPath(root, p, { write: true }), path.join(root, p));
});

test('env edits: multi-line values, key validation, project override of a shared environment', () => {
    const root = mk();
    const w = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); };
    w('config/common/environments/qa.env', 'BASE_URL=https://qa\nCERT="-----BEGIN-----\nabc\n-----END-----"\nDB_PASSWORD=hunter22\nNOTE="a\nb"\n');
    w('config/orders/common/common.env', 'PROJECT=orders\n');
    assert.deepEqual(envEntries(['A=1', 'B="x', 'C=2', '"', 'D=3']).map((e) => [e.key, e.start, e.end]), [['A', 0, 0], ['B', 1, 3], ['D', 4, 4]]);
    // qa exists only in common → a project override can be created, copied from common.
    const r = createEnvironment(root, 'orders', 'qa', 'qa');
    const text = fs.readFileSync(path.join(root, r.file), 'utf8');
    assert.match(text, /NOTE="a\nb"/);
    assert.match(text, /DB_PASSWORD=\{env:QA_DB_PASSWORD\}/);
    assert.doesNotMatch(text, /hunter22/);
    assert.throws(() => createEnvironment(root, 'orders', 'qa', 'qa'), /already exists/);
    // Removing a multi-line value removes all its lines.
    assert.equal(removeKey(root, r.file, 'NOTE'), 2);
    assert.doesNotMatch(fs.readFileSync(path.join(root, r.file), 'utf8'), /^b"$/m);
    assert.throws(() => removeKey(root, r.file, 'A)|(.*'), /not a valid setting name/);
});

test('programs in a copied .git/config are listed, and fsmonitor never runs', async () => {
    const { execFileSync } = await import('child_process');
    const { programsInRepoConfig } = await import('../src/git/repoConfig');
    const { runGit } = await import('../src/git/run');
    const root = mk();
    execFileSync('git', ['init', '-q'], { cwd: root });
    const marker = path.join(root, 'fsmonitor-ran');
    const script = path.join(root, 'mon.sh');
    fs.writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
    execFileSync('git', ['config', 'core.fsmonitor', script], { cwd: root });
    execFileSync('git', ['config', 'filter.x.smudge', 'evil-cmd'], { cwd: root });
    execFileSync('git', ['config', 'alias.st', 'status'], { cwd: root });
    const found = (await programsInRepoConfig(root)).map((e) => e.key).sort();
    assert.deepEqual(found, ['core.fsmonitor', 'filter.x.smudge']);
    await runGit(['status', '--porcelain'], { cwd: root });
    assert.ok(!fs.existsSync(marker), 'fsmonitor program must not run');
});
