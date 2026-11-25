/** Tags whose name is also a branch's name (QA round 3, M2), and clear tag errors. */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitService } from '../src/git/service';
import { runGit } from '../src/git/run';

let tmp: string;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-studio-tags-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function repo(name: string) {
    const dir = path.join(tmp, name);
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    for (const [k, v] of [['user.name', 'T'], ['user.email', 't@x.invalid'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) await runGit(['config', k, v], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    await runGit(['add', '-A'], { cwd: dir });
    await runGit(['commit', '-q', '--no-verify', '-m', 'i'], { cwd: dir });
    const git = await GitService.open(dir);
    const sh = async (...args: string[]) => (await runGit(args, { cwd: dir })).stdout;
    return { dir, git, sh };
}

test('a tag cannot take the name of a branch', async () => {
    const { git, sh } = await repo('clash');
    await sh('branch', 'bad-name');
    await assert.rejects(git.createTag('bad-name', 'HEAD'), /branch named "bad-name"/);
    assert.equal((await git.tags()).length, 0);
});

test('an existing tag that shares a branch name is listed by its own name and can be deleted', async () => {
    const { git, sh } = await repo('existing');
    await sh('branch', 'bad-name');
    await sh('tag', 'bad-name');
    await sh('tag', '-a', 'rel', '-m', 'release');
    const names = (await git.tags()).map((t) => t.name).sort();
    assert.deepEqual(names, ['bad-name', 'rel']);
    await git.deleteTag('bad-name', false);
    assert.equal((await sh('tag', '--list')).trim(), 'rel');
    // The branch is untouched.
    assert.match(await sh('branch', '--list', 'bad-name'), /bad-name/);
    // A list from an older version showed it as "tags/<name>": that still deletes it.
    await sh('tag', 'bad-name');
    await git.deleteTag('tags/bad-name', false);
    assert.equal((await sh('tag', '--list')).trim(), 'rel');
    await assert.rejects(git.deleteTag('nope', false), /no tag named "nope"/);
});

test('tag errors say what is wrong', async () => {
    const { git } = await repo('errors');
    await assert.rejects(git.createTag('-x', 'HEAD'), /must not start with "-"/);
    await assert.rejects(git.createTag('a..b', 'HEAD'), /not a valid tag name/);
    await assert.rejects(git.createTag('ok', 'nope-rev'), /"nope-rev" is not a branch, tag or commit/);
    await git.createTag('ok', 'HEAD', 'msg');
    await assert.rejects(git.createTag('ok', 'HEAD'), /exists already/);
});
