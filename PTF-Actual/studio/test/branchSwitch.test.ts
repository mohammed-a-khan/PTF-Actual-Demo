/** Switching branches with uncommitted changes: take them along, or keep them on the branch left (offered back on return). */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitService } from '../src/git/service';
import { runGit } from '../src/git/run';

test('switch: a clash names the files; "keep them here" stashes, switches, and the changes are offered back on return', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-switch-'));
    const dir = path.join(tmp, 'r');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    for (const [k, v] of [['user.name', 'T'], ['user.email', 't@x.invalid']]) await runGit(['config', k, v], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'results.json'), '{"runs":1}\n');
    await runGit(['add', '.'], { cwd: dir }); await runGit(['commit', '-qm', 'one'], { cwd: dir });
    await runGit(['switch', '-qc', 'feature'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'results.json'), '{"runs":2}\n');
    await runGit(['commit', '-qam', 'two'], { cwd: dir });
    const git = await GitService.open(dir);
    // Uncommitted edits to a file main has another version of, and a new file.
    fs.writeFileSync(path.join(dir, 'results.json'), '{"runs":3}\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'new\n');
    await assert.rejects(git.switchBranch('main'), /main has other versions of this file: results\.json\. Stash the changes on this branch and switch/);
    assert.equal((await git.status()).branch, 'feature', 'not switched');
    const r = await git.switchBranch('main', { stash: true });
    assert.deepEqual([r.stashed, r.autoStash], [true, null]);
    const st = await git.status();
    assert.deepEqual([st.branch, st.files.length], ['main', 0], 'on main with nothing carried over');
    const back = await git.switchBranch('feature');
    assert.equal(back.autoStash?.message, 'cs-studio: left on feature', 'back on feature: its changes are offered');
    await git.stashApply(back.autoStash!.index, true, back.autoStash!.sha);
    assert.equal(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'), '{"runs":3}\n');
    assert.ok(fs.existsSync(path.join(dir, 'notes.txt')), 'new files kept too');
    // Taking changes along still works when nothing clashes.
    fs.writeFileSync(path.join(dir, 'results.json'), '{"runs":2}\n');
    assert.equal((await git.switchBranch('main')).stashed, false);
    assert.equal((await git.status()).files.some((f) => f.path === 'notes.txt'), true, 'carried along');
    fs.rmSync(tmp, { recursive: true, force: true });
});
