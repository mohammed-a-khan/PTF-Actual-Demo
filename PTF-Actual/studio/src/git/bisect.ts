/**
 * Which commit broke a test: Git's own bisect, in a separate copy of the repository next to the project (the user's
 * branch and unsaved work stay as they are). The test is run at the two ends first:
 *  - at the "good" commit it must pass (else the search would blame the wrong commit: pick an earlier one);
 *  - at the "bad" commit, as committed, it must fail (else the failure comes from uncommitted changes, or is flaky).
 * Then each step runs the test at the middle commit and tells Git good / bad / skip (could not run there, e.g. the
 * scenario did not exist yet), until Git names the first bad commit, or the commits it could not decide between.
 */
import * as fs from 'fs';
import * as path from 'path';
import { runGit } from './run';
import { prepareCopy, removeCopy } from './prWorktree';
import { UserError } from '../core/errors';

export type Outcome = 'pass' | 'fail' | 'skip';
export interface BisectStep { commit: string; subject: string; outcome: Outcome; note?: string; run?: string; end?: 'good' | 'bad' }
export interface CommitInfo { commit: string; subject: string; author: string; date: string; files: string[] }
export interface BisectState {
    state: 'running' | 'found' | 'inconclusive' | 'error' | 'stopped';
    good: string; bad: string;
    /** Commits between the two ends (good excluded). */
    commits: number;
    /** Runs Git expects at most, the two end checks included. */
    estimate: number;
    steps: BisectStep[];
    current?: { commit: string; subject: string };
    result?: CommitInfo;
    /** No single commit: these could each be the first bad one (they were skipped). */
    candidates?: Array<{ commit: string; subject: string }>;
    message?: string;
    startedAt: string; endedAt?: string;
}
export type TestAt = (commit: string, dir: string) => Promise<{ outcome: Outcome; note?: string; run?: string }>;

const REV = /^[\w./~^@{}-]{1,200}$/;
const git = (cwd: string, args: string[], allowFailure = false) => runGit(args, { cwd, allowFailure, env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 10 * 60_000 });

async function resolve(repoRoot: string, rev: string, what: string): Promise<string> {
    if (!REV.test(rev) || rev.startsWith('-')) throw new UserError(`Not a commit: ${rev}`);
    const r = await git(repoRoot, ['rev-parse', '--verify', '-q', `${rev}^{commit}`], true);
    if (r.code !== 0) throw new UserError(`The ${what} commit ${rev} is not in this repository.`);
    return r.stdout.trim();
}
const subjectOf = async (dir: string, c: string) => (await git(dir, ['show', '-s', '--format=%s', c], true)).stdout.trim();

export async function commitInfo(dir: string, c: string): Promise<CommitInfo> {
    const [h, s, a, d] = (await git(dir, ['show', '-s', '--format=%H%x00%s%x00%an%x00%aI', c])).stdout.trim().split('\0');
    const files = (await git(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', '--first-parent', c], true)).stdout.split('\n').filter(Boolean);
    return { commit: h, subject: s, author: a, date: d, files: [...new Set(files)].slice(0, 100) };
}

/** Check the two ends and count the commits between them (nothing is run). */
export async function bisectRange(repoRoot: string, good: string, bad: string): Promise<{ good: string; bad: string; commits: number; estimate: number }> {
    const g = await resolve(repoRoot, good, 'good'), b = await resolve(repoRoot, bad, 'failing');
    if (g === b) throw new UserError('Choose two different commits.');
    if ((await git(repoRoot, ['merge-base', '--is-ancestor', g, b], true)).code !== 0) throw new UserError(`${good} is not an earlier commit of ${bad}: choose a commit from the failing commit's history.`);
    const commits = Number((await git(repoRoot, ['rev-list', '--count', `${g}..${b}`])).stdout.trim());
    return { good: g, bad: b, commits, estimate: 2 + Math.ceil(Math.log2(Math.max(1, commits))) };
}

export async function runBisect(o: {
    repoRoot: string; dir: string; good: string; bad: string; test: TestAt;
    onChange?: (s: BisectState) => void; stopped?: () => boolean; maxSteps?: number;
}): Promise<BisectState> {
    const range = await bisectRange(o.repoRoot, o.good, o.bad);
    const s: BisectState = { state: 'running', good: range.good, bad: range.bad, commits: range.commits, estimate: range.estimate, steps: [], startedAt: new Date().toISOString() };
    const changed = () => o.onChange?.(JSON.parse(JSON.stringify(s)) as BisectState);
    const end = (state: BisectState['state'], message?: string) => { s.state = state; if (message) s.message = message; delete s.current; s.endedAt = new Date().toISOString(); changed(); return s; };
    changed();
    // A fresh copy of the repository (an earlier search's is replaced).
    if (fs.existsSync(o.dir)) await removeCopy(o.repoRoot, o.dir);
    await git(o.repoRoot, ['worktree', 'prune'], true);
    fs.mkdirSync(path.dirname(o.dir), { recursive: true });
    const add = await git(o.repoRoot, ['worktree', 'add', '--detach', '--force', o.dir, range.bad], true);
    if (add.code !== 0) return end('error', `Could not make a copy of the repository: ${add.stderr.trim().split('\n').pop()}`);
    try {
        await prepareCopy(o.repoRoot, o.dir);
        const at = async (commit: string, endName?: 'good' | 'bad'): Promise<BisectStep> => {
            const subject = await subjectOf(o.dir, commit);
            s.current = { commit, subject }; changed();
            const r = await o.test(commit, o.dir);
            const step: BisectStep = { commit, subject, outcome: r.outcome, ...(r.note ? { note: r.note } : {}), ...(r.run ? { run: r.run } : {}), ...(endName ? { end: endName } : {}) };
            s.steps.push(step); delete s.current; changed();
            return step;
        };
        // The ends.
        await git(o.dir, ['checkout', '-q', '--detach', '--force', range.good]);
        const g = await at(range.good, 'good');
        if (o.stopped?.()) return end('stopped');
        if (g.outcome === 'fail') return end('inconclusive', 'It fails at the "good" commit too, so the commit that broke it is earlier: choose an earlier good commit.');
        if (g.outcome === 'skip') return end('inconclusive', `It could not run at the "good" commit${g.note ? ` (${g.note})` : ''}: choose another good commit.`);
        await git(o.dir, ['checkout', '-q', '--detach', '--force', range.bad]);
        const b = await at(range.bad, 'bad');
        if (o.stopped?.()) return end('stopped');
        if (b.outcome === 'pass') return end('inconclusive', 'It passes at the failing commit as committed: the failure comes from changes that are not committed, or the test is flaky (passes and fails on the same code).');
        if (b.outcome === 'skip') return end('inconclusive', `It could not run at the failing commit${b.note ? ` (${b.note})` : ''}.`);
        if (range.commits === 1) { s.result = await commitInfo(o.dir, range.bad); return end('found'); }
        // The search.
        let out = (await git(o.dir, ['bisect', 'start', range.bad, range.good])).stdout;
        for (let i = 0; i < (o.maxSteps ?? 64); i++) {
            const first = /^([0-9a-f]{40}) is the first bad commit/m.exec(out);
            if (first) { s.result = await commitInfo(o.dir, first[1]); return end('found'); }
            if (/only 'skip'ped commits left/.test(out)) {
                const hashes = [...out.matchAll(/^([0-9a-f]{40})$/gm)].map((m) => m[1]);
                s.candidates = await Promise.all(hashes.slice(0, 20).map(async (c) => ({ commit: c, subject: await subjectOf(o.dir, c) })));
                return end('inconclusive', 'The test could not run at some commits, so Git cannot tell which of these broke it.');
            }
            if (o.stopped?.()) return end('stopped');
            const head = (await git(o.dir, ['rev-parse', 'HEAD'])).stdout.trim();
            const step = await at(head);
            if (o.stopped?.()) return end('stopped');
            const r = await git(o.dir, ['bisect', step.outcome === 'pass' ? 'good' : step.outcome === 'fail' ? 'bad' : 'skip'], true);
            if (r.code !== 0 && !/first bad commit|skip/.test(r.stdout + r.stderr)) return end('error', `git bisect: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
            out = r.stdout + r.stderr;
        }
        return end('error', 'The search took more steps than expected.');
    } catch (e) {
        return end('error', (e as Error).message);
    } finally {
        await removeCopy(o.repoRoot, o.dir).catch(() => undefined);
    }
}
