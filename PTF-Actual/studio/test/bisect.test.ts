/**
 * Which commit broke a test: the ends checked first (passes at "good", fails at "bad" as committed), then Git's
 * bisect in a separate copy, skipping commits where the test cannot run; the user's working copy untouched.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bisectRange, runBisect, TestAt } from '../src/git/bisect';
import { runGit } from '../src/git/run';

async function repoWith(contents: Array<string | null>): Promise<{ dir: string; tmp: string; commits: string[] }> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bis-'));
    const dir = path.join(tmp, 'repo');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    const g = (a: string[]) => runGit(['-c', 'user.name=T', '-c', 'user.email=t@x.invalid', ...a], { cwd: dir });
    const commits: string[] = [];
    for (const [i, c] of contents.entries()) {
        if (c === null) fs.rmSync(path.join(dir, 'value.txt'), { force: true }); else fs.writeFileSync(path.join(dir, 'value.txt'), c);
        fs.writeFileSync(path.join(dir, `f${i}.txt`), String(i));
        await g(['add', '-A']); await g(['commit', '-qm', `Change ${i}`]);
        commits.push((await runGit(['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim());
    }
    return { dir, tmp, commits };
}
/** The "test": passes while value.txt says ok; cannot run without it. */
const check: TestAt = async (_c, dir) => {
    const f = path.join(dir, 'value.txt');
    if (!fs.existsSync(f)) return { outcome: 'skip', note: 'the scenario is not there' };
    return { outcome: fs.readFileSync(f, 'utf8') === 'ok' ? 'pass' : 'fail' };
};

test('finds the first bad commit, the working copy untouched, the copy removed', async () => {
    const { dir, tmp, commits } = await repoWith(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'bad', 'bad', 'bad', 'bad', 'bad', 'bad']);
    try {
        fs.writeFileSync(path.join(dir, 'f0.txt'), 'my unsaved work');
        const copy = path.join(dir, '.git', 'cs-studio', 'pr', '_bisect');
        const seen: string[] = [];
        const states: string[] = [];
        const s = await runBisect({ repoRoot: dir, dir: copy, good: commits[0], bad: 'main', test: async (c, d) => { seen.push(c); return check(c, d); }, onChange: (x) => states.push(x.state) });
        assert.equal(s.state, 'found', s.message);
        assert.equal(s.result!.commit, commits[6]);
        assert.equal(s.result!.subject, 'Change 6');
        assert.deepEqual(s.result!.files.sort(), ['f6.txt', 'value.txt']);
        assert.deepEqual(s.steps.slice(0, 2).map((x) => [x.end, x.outcome]), [['good', 'pass'], ['bad', 'fail']]);
        assert.ok(s.steps.length <= s.estimate, `${s.steps.length} runs, estimate ${s.estimate}`);
        assert.equal(s.commits, 11);
        assert.equal(states.at(-1), 'found');
        // The user's own copy: same branch, same unsaved change; the separate copy gone.
        assert.equal((await runGit(['branch', '--show-current'], { cwd: dir })).stdout.trim(), 'main');
        assert.equal(fs.readFileSync(path.join(dir, 'f0.txt'), 'utf8'), 'my unsaved work');
        assert.ok(!fs.existsSync(copy));
        assert.equal((await runGit(['worktree', 'list'], { cwd: dir })).stdout.trim().split('\n').length, 1);
        assert.equal((await runGit(['for-each-ref', 'refs/bisect'], { cwd: dir })).stdout.trim(), '');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the ends: fails at good, passes at bad, a range the wrong way round; skipped commits', async () => {
    const { dir, tmp, commits } = await repoWith(['ok', 'ok', null, null, 'bad', 'bad', 'bad']);
    try {
        const copy = path.join(tmp, 'copy');
        await assert.rejects(bisectRange(dir, commits[5], commits[1]), /not an earlier commit/);
        await assert.rejects(bisectRange(dir, '--output=x', commits[1]), /Not a commit/);
        await assert.rejects(bisectRange(dir, 'nope', commits[1]), /not in this repository/);
        let s = await runBisect({ repoRoot: dir, dir: copy, good: commits[4], bad: commits[6], test: check });
        assert.deepEqual([s.state, s.steps.length], ['inconclusive', 1]);
        assert.match(s.message!, /fails at the "good" commit too/);
        s = await runBisect({ repoRoot: dir, dir: copy, good: commits[0], bad: commits[1], test: check });
        assert.match(s.message!, /passes at the failing commit as committed/);
        // Commits 2 and 3 cannot run: Git cannot tell which of 2, 3, 4 broke it.
        s = await runBisect({ repoRoot: dir, dir: copy, good: commits[1], bad: commits[6], test: check });
        assert.equal(s.state, 'inconclusive', JSON.stringify(s));
        assert.deepEqual(s.candidates!.map((c) => c.commit).sort(), [commits[2], commits[3], commits[4]].sort());
        assert.ok(s.steps.some((x) => x.outcome === 'skip' && x.note === 'the scenario is not there'));
        // Stopped part way.
        let n = 0;
        s = await runBisect({ repoRoot: dir, dir: copy, good: commits[0], bad: commits[6], test: check, stopped: () => ++n > 2 });
        assert.equal(s.state, 'stopped');
        assert.ok(!fs.existsSync(copy));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
