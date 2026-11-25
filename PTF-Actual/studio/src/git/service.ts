/**
 * Git service: every Git operation the Studio offers, using standard Git terms.
 * Commit and push are gated by the secret scan; an override is only accepted for the exact set of
 * findings the user reviewed (bound by a digest) and is recorded in the commit as a trailer.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitError, runGit } from './run';
import { LOG_FORMAT, LogEntry, parseLog, parseStatusV2, RepoStatus } from './parse';
import { GRAPH_LOG_FORMAT, GraphRow, layoutGraph, LogCommit, parseGraphLog } from './graph';
import { scanStaged, scanUnpushed } from '../scanner/gitScan';
import { allowlistSet } from '../scanner/allowlist';
import { OVERRIDE_TRAILER, overrideRefusal, readPolicy, validateOverrideReason } from '../scanner/policy';
import { findingsDigest, toPublic } from '../scanner/scanner';
import { KnownSecret, PublicFinding, RawFinding } from '../scanner/types';
import { UserError } from '../core/errors';

/** Environment variable the Studio sets when it runs `git commit` after its own scan. */
export const APPROVED_DIGEST_ENV = 'CS_STUDIO_SCAN_APPROVED';

export interface Override {
    reason: string;
    /** Digest returned with the blocked result; must still match the current findings. */
    digest: string;
}

export type GateResult =
    | { status: 'ok'; sha?: string; output?: string; overridden?: boolean }
    | { status: 'blocked'; findings: PublicFinding[]; digest: string; overrideAllowed: boolean; overrideRefusal: string | null }
    | { status: 'rejected'; message: string };

export interface BranchInfo {
    name: string;
    current: boolean;
    upstream: string | null;
    sha: string;
    remote: boolean;
    /** An upstream is configured but the remote branch was deleted. */
    upstreamGone: boolean;
}

export interface GitServiceOptions {
    /** Supplies the user's stored secret values for exact-match scanning (never logged). */
    knownSecrets?: () => Promise<KnownSecret[]> | KnownSecret[];
}

const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };
/**
 * Flags for every diff/show whose patch text is parsed or fed back to `git apply`: the user's
 * diff.noprefix / diff.mnemonicPrefix / external diff / color settings must not change the format.
 */
const PATCH = ['--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];
/** Global option: show non-ASCII paths as they are instead of "\303\251"-quoted. */
const NOQ = ['-c', 'core.quotePath=false'];
const ZERO_OID = '0000000000000000000000000000000000000000';
export const STALE_HUNK_MESSAGE = 'This change was modified since you looked at it. Refresh and try again.';

/** Push (a branch or a tag) in a repository without a remote. */
export const NO_REMOTE_TO_PUSH = 'This repository has no remote to push to. Add one in Source control › Branches & tags › Remotes.';

export class GitService {
    constructor(public readonly repoRoot: string, private readonly opts: GitServiceOptions = {}) {}

    static async open(dir: string, opts?: GitServiceOptions): Promise<GitService> {
        const r = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir });
        // path.resolve: on Windows Git prints E:/project; file paths elsewhere use E:\\project.
        return new GitService(path.resolve(r.stdout.trim()), opts);
    }

    private git(args: string[], extra: Partial<Parameters<typeof runGit>[1]> = {}) {
        return runGit(args, { cwd: this.repoRoot, ...extra });
    }

    // ---------------------------------------------------------------- read

    async status(): Promise<StatusResult> {
        const r = await this.git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
        const st: StatusResult = { ...parseStatusV2(r.stdout), operation: await this.operation() };
        if (st.operation === 'rebase') Object.assign(st, await this.rebaseInfo());
        // During a merge, git has already written the proper message ("Merge branch 'x'").
        const mp = path.resolve(this.repoRoot, (await this.git(['rev-parse', '--git-path', 'MERGE_MSG'])).stdout.trim());
        if (fs.existsSync(mp)) {
            const msg = stripComments(fs.readFileSync(mp, 'utf8'), await this.commentChar());
            if (msg) st.mergeMessage = msg;
        }
        return st;
    }

    /** core.commentChar ('#' by default; 'auto' means git picks one not used in the message). */
    private async commentChar(): Promise<string | 'auto'> {
        const r = await this.git(['config', '--get', 'core.commentChar'], { allowFailure: true });
        const v = r.stdout.replace(/\r?\n$/, '');
        if (r.code !== 0 || !v) return '#';
        return v === 'auto' ? 'auto' : v;
    }

    /**
     * During a rebase git's "ours" is the upstream being rebased onto and "theirs" is your own
     * commit being replayed. Git's semantics are kept; this tells the UI how to label the sides.
     */
    private async rebaseInfo(): Promise<RebaseInfo> {
        const info: RebaseInfo = { sidesSwapped: true, rebaseBranch: null, rebaseOnto: null };
        for (const dir of ['rebase-merge', 'rebase-apply']) {
            const base = path.resolve(this.repoRoot, (await this.git(['rev-parse', '--git-path', dir])).stdout.trim());
            if (!fs.existsSync(base)) continue;
            const read = (f: string) => { try { return fs.readFileSync(path.join(base, f), 'utf8').trim() || null; } catch { return null; } };
            const head = read('head-name');
            info.rebaseBranch = head && head !== 'detached HEAD' ? head.replace(/^refs\/heads\//, '') : null;
            const onto = read('onto');
            if (onto) {
                // Show a branch name for the commit we rebase onto when one points at it.
                const names = (await this.git(['for-each-ref', '--points-at', onto, '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], { allowFailure: true })).stdout.split('\n').filter(Boolean);
                info.rebaseOnto = names[0] ?? onto;
            }
            break;
        }
        return info;
    }

    async branches(): Promise<BranchInfo[]> {
        const r = await this.git(['for-each-ref', '--format=%(refname)%1f%(HEAD)%1f%(upstream:short)%1f%(objectname)%1f%(upstream:track)', 'refs/heads', 'refs/remotes']);
        const out: BranchInfo[] = [];
        for (const line of r.stdout.split('\n')) {
            if (!line) continue;
            const [ref, head, upstream, sha, track] = line.split('\x1f');
            if (ref.endsWith('/HEAD')) continue;
            const remote = ref.startsWith('refs/remotes/');
            out.push({ name: ref.replace(/^refs\/(heads|remotes)\//, ''), current: head === '*', upstream: upstream || null, sha, remote, upstreamGone: (track ?? '').trim() === '[gone]' });
        }
        return out;
    }

    async log(opts: { limit?: number; ref?: string; path?: string } = {}): Promise<LogEntry[]> {
        const head = await this.git(['rev-parse', '--verify', '-q', opts.ref ?? 'HEAD'], { allowFailure: true });
        if (head.code !== 0) return [];
        const args = ['log', `--format=${LOG_FORMAT}`, `-n`, String(opts.limit ?? 50), opts.ref ?? 'HEAD'];
        if (opts.path) args.push('--', opts.path);
        const r = await this.git(args, { env: LITERAL });
        return parseLog(r.stdout);
    }

    /** Unified diff of one file: staged (index vs HEAD) or unstaged (worktree vs index). */
    async diff(file: string, staged: boolean, opts: DiffOptions = {}): Promise<string> {
        if (!staged) {
            const tracked = await this.git(['ls-files', '--error-unmatch', '--', file], { allowFailure: true, env: LITERAL });
            if (tracked.code !== 0) {
                // New (untracked) file: show it as entirely added. Exit code 1 means "differences found".
                const r = await this.git([...NOQ, 'diff', ...PATCH, '--no-index', '--', '/dev/null', file], { allowFailure: true });
                return r.stdout;
            }
        }
        const args = [...NOQ, 'diff', ...PATCH, ...diffFlags(opts)];
        if (staged) args.push('--cached', '-M');
        args.push('--', ...(staged ? await this.stagedRenamePaths(file) : [file]));
        return (await this.git(args, { env: LITERAL })).stdout;
    }

    /** [origPath, path] when `file` is the new name of a staged rename, else [file]. */
    private async stagedRenamePaths(file: string): Promise<string[]> {
        const r = await this.git(['diff', '--cached', '-M', '--name-status', '-z', '--no-ext-diff'], { allowFailure: true });
        return renamePathsFrom(r.stdout, file);
    }

    /** Same, for a diff between revisions (commit / compare views). */
    private async rangeRenamePaths(range: string[], file: string): Promise<string[]> {
        const r = await this.git(['diff', '-M', '--name-status', '-z', '--no-ext-diff', ...range, '--'], { allowFailure: true });
        return r.code === 0 ? renamePathsFrom(r.stdout, file) : [file];
    }

    // ---------------------------------------------------------------- stage

    async stage(paths: string[]): Promise<void> {
        if (paths.length === 0) return;
        await this.git(['add', '-A', '--', ...paths], { env: LITERAL });
    }

    async unstage(paths: string[]): Promise<void> {
        if (paths.length === 0) return;
        const head = await this.git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true });
        if (head.code === 0) await this.git(['restore', '--staged', '--', ...paths], { env: LITERAL });
        else await this.git(['rm', '--cached', '-r', '-q', '--', ...paths], { env: LITERAL }); // no commits yet
    }

    // ---------------------------------------------------------------- scan

    private async scanOptions() {
        const known = this.opts.knownSecrets ? await this.opts.knownSecrets() : [];
        return { knownSecrets: known, allowlist: allowlistSet(this.repoRoot) };
    }

    async scanStaged(): Promise<{ raw: RawFinding[]; findings: PublicFinding[]; digest: string }> {
        const res = await scanStaged(this.repoRoot, await this.scanOptions());
        return { raw: res.findings, findings: res.findings.map((f, i) => toPublic(f, `f${i + 1}`)), digest: findingsDigest(res.findings) };
    }

    // ---------------------------------------------------------------- commit

    async commit(message: string, override?: Override, opts: { amend?: boolean; allowRewritePushed?: boolean; signoff?: boolean } = {}): Promise<GateResult> {
        const msg = message.replace(/\r\n/g, '\n').trim();
        if (!msg) return { status: 'rejected', message: 'Please write a commit message.' };

        const staged = await this.git(['diff', '--cached', '--quiet'], { allowFailure: true });
        const head = await this.git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true });
        const merging = (await this.git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFailure: true })).code === 0;
        if (opts.amend) {
            if (head.code !== 0) return { status: 'rejected', message: 'There is no commit to amend yet.' };
            if (merging) return { status: 'rejected', message: 'Finish the merge before amending.' };
            if (!opts.allowRewritePushed && await this.isPushed('HEAD')) {
                return { status: 'rejected', message: 'The last commit is already pushed. Amending it rewrites shared history; confirm to amend anyway (you will then need to push with force-with-lease).' };
            }
        } else if (staged.code === 0 && head.code === 0 && !merging) return { status: 'rejected', message: 'Nothing is staged. Stage the files you want to include first.' };

        const scan = await this.scanStaged();
        const gate = this.evaluateGate(scan.raw, scan.findings, scan.digest, override);
        if (gate) return gate;

        const args = ['commit', '-F', '-'];
        if (opts.amend) args.push('--amend');
        if (opts.signoff) args.push('--signoff');
        if (override && scan.raw.length > 0) args.push('--trailer', `${OVERRIDE_TRAILER}: ${oneLine(override.reason)}`);
        const r = await this.git(args, { input: msg + '\n', env: { [APPROVED_DIGEST_ENV]: scan.digest }, allowFailure: true });
        if (r.code !== 0) return { status: 'rejected', message: explainGitFailure(r.stderr || r.stdout) };
        const sha = (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
        return { status: 'ok', sha, overridden: scan.raw.length > 0 };
    }

    /** null = proceed; otherwise the result to return. */
    private evaluateGate(raw: RawFinding[], findings: PublicFinding[], digest: string, override?: Override): GateResult | null {
        if (raw.length === 0) return null;
        const policy = readPolicy(this.repoRoot);
        const refusal = overrideRefusal(policy, raw);
        if (!override) return { status: 'blocked', findings, digest, overrideAllowed: refusal === null, overrideRefusal: refusal };
        if (refusal) return { status: 'rejected', message: refusal };
        const bad = validateOverrideReason(override.reason);
        if (bad) return { status: 'rejected', message: bad };
        if (override.digest !== digest) {
            return { status: 'blocked', findings, digest, overrideAllowed: true, overrideRefusal: null };
        }
        return null;
    }

    // ---------------------------------------------------------------- push / pull / fetch

    async push(override?: Override, opts: { forceWithLease?: boolean; tags?: boolean } = {}): Promise<GateResult> {
        const st = await this.status();
        if (!st.branch) return { status: 'rejected', message: 'You are not on a branch (detached HEAD). Create or switch to a branch first.' };
        // No remote: said first (not a secret scan of commits that cannot go anywhere).
        if (!(await this.defaultRemote())) return { status: 'rejected', message: NO_REMOTE_TO_PUSH };

        const policy = readPolicy(this.repoRoot);
        let overridden = false;
        if (policy.scanOnPush) {
            const res = await scanUnpushed(this.repoRoot, await this.scanOptions());
            const findings = res.findings.map((f, i) => toPublic(f, `f${i + 1}`));
            const digest = findingsDigest(res.findings);
            const gate = this.evaluateGate(res.findings, findings, digest, override);
            if (gate) return gate;
            overridden = res.findings.length > 0;
        }

        const args = ['push', '--porcelain'];
        // force-with-lease: overwrite the remote branch ONLY if it is still where we last saw it,
        // so a teammate's newer commits are never thrown away silently.
        // --force-if-includes: also refuse when the remote has commits this computer fetched but never looked at
        // (a background fetch would otherwise make the lease pass and throw them away).
        if (opts.forceWithLease) args.push('--force-with-lease', '--force-if-includes');
        if (opts.tags) args.push('--follow-tags');
        const up = await this.upstreamConfig(st.branch);
        if (!st.upstream || !up || up.remote === '.') {
            const remote = await this.defaultRemote();
            if (!remote) return { status: 'rejected', message: NO_REMOTE_TO_PUSH };
            args.push('--set-upstream', remote, `HEAD:refs/heads/${st.branch}`);
        } else if (up.merge !== `refs/heads/${st.branch}`) {
            // The upstream has another name (branch created from origin/main, say): a plain push
            // is refused by push.default=simple. Publish under the local name and track that.
            args.push('--set-upstream', up.remote, `HEAD:refs/heads/${st.branch}`);
        }
        const r = await this.git(args, { allowFailure: true, timeoutMs: 600_000 });
        if (r.code !== 0) return { status: 'rejected', message: explainGitFailure(r.stderr || r.stdout) };
        return { status: 'ok', output: r.stdout, overridden };
    }

    async fetch(): Promise<void> {
        const r = await this.git(['fetch', '--all', '--prune'], { timeoutMs: 600_000, allowFailure: true });
        if (r.code !== 0) throw new GitError(explainGitFailure(r.stderr || r.stdout), ['fetch'], r.code, r.stderr);
    }

    /**
     * Delete .git/index.lock left behind by a crashed Git process — only when it is older than
     * 60 seconds (a running Git would not hold it that long for normal operations).
     */
    async removeStaleLock(): Promise<{ removed: boolean; message: string }> {
        const lock = path.resolve(this.repoRoot, (await this.git(['rev-parse', '--git-path', 'index.lock'])).stdout.trim());
        let st: fs.Stats;
        try { st = fs.statSync(lock); } catch { return { removed: false, message: 'There is no lock file; nothing to do.' }; }
        const age = Date.now() - st.mtimeMs;
        if (age < 60_000) return { removed: false, message: 'The lock is recent, so another Git program may still be working. Wait a minute and try again.' };
        fs.rmSync(lock, { force: true });
        return { removed: true, message: 'Removed the stale lock left by an earlier Git process.' };
    }

    private async upstreamConfig(branch: string): Promise<{ remote: string; merge: string } | null> {
        const get = async (k: string) => {
            const r = await this.git(['config', '--get', `branch.${branch}.${k}`], { allowFailure: true });
            return r.code === 0 ? r.stdout.trim() : '';
        };
        const remote = await get('remote');
        const merge = await get('merge');
        return remote && merge ? { remote, merge } : null;
    }

    /** Pull = fetch + merge of the upstream. Conflicts are reported, not hidden. */
    /**
     * How this repository pulls, as the team configured it: branch.<name>.rebase, else pull.rebase (true, merges,
     * interactive: rebase), pull.ff=only (fast-forward only), else merge.
     */
    /** The team's commit message template (commit.template), comment lines removed; '' when none. */
    async commitTemplate(): Promise<string> {
        const p = (await this.git(['config', '--path', '--get', 'commit.template'], { allowFailure: true })).stdout.trim();
        if (!p) return '';
        const abs = path.isAbsolute(p) ? p : path.join(this.repoRoot, p);
        try { return stripComments(fs.readFileSync(abs, 'utf8')).replace(/\s+$/, ''); } catch { return ''; }
    }

    /** Untracked files `clean` would delete (ignored ones too when asked), without deleting anything. */
    async cleanPreview(ignored = false): Promise<string[]> {
        const r = await this.git(['clean', '-n', '-d', ...(ignored ? ['-x'] : []), '--', '.'], { env: LITERAL });
        return r.stdout.split('\n').map((l) => l.replace(/^Would remove /, '').trim()).filter(Boolean);
    }

    /**
     * Delete the untracked files the preview listed (only those: a file created since is kept). A copy of each is
     * kept in the recovery folder first, as for discarding edits.
     */
    async clean(files: string[], ignored = false): Promise<{ removed: string[]; recoveryDir?: string }> {
        const now = new Set(await this.cleanPreview(ignored));
        const chosen = files.filter((f) => now.has(f));
        if (!chosen.length) return { removed: [] };
        const recoveryDir = path.resolve(this.repoRoot, (await this.git(['rev-parse', '--git-path', `cs-studio/recovery/${new Date().toISOString().replace(/[:.]/g, '-')}-clean`])).stdout.trim());
        for (const f of chosen) {
            const abs = this.safePath(f.replace(/\/$/, ''));
            if (fs.existsSync(abs)) fs.cpSync(abs, path.join(recoveryDir, f), { recursive: true });
        }
        await this.git(['clean', '-f', '-d', ...(ignored ? ['-x'] : []), '--', ...chosen], { env: LITERAL });
        return { removed: chosen, recoveryDir };
    }

    /** Where HEAD has been (reflog): to undo a commit, merge, rebase or a deleted branch's last position. */
    async reflog(limit = 100): Promise<Array<{ sha: string; ref: string; date: string; subject: string }>> {
        const r = await this.git(['reflog', '-n', String(Math.min(Math.max(limit, 1), 1000)), '--format=%H%x1f%gd%x1f%cI%x1f%gs'], { allowFailure: true });
        return r.stdout.split('\n').filter(Boolean).map((l) => { const [sha, ref, date, subject] = l.split('\x1f'); return { sha, ref, date, subject }; });
    }

    /** Rebase the current branch onto another (its commits replayed on top); conflicts go to the usual banner. */
    async rebaseOnto(branch: string): Promise<{ status: 'ok' | 'conflicts' | 'rejected'; message?: string; conflicts?: string[] }> {
        assertRev(branch);
        await this.assertIdle('rebase');
        if (!(await this.status()).branch) return { status: 'rejected', message: 'Switch to a branch first (you are on a commit, not a branch).' };
        const r = await this.git(['rebase', '--autostash', branch], { allowFailure: true, timeoutMs: 600_000 });
        return this.afterMerge(r);
    }

    /**
     * Interactive rebase without an editor: the todo list chosen in the UI (pick, reword, squash, fixup, drop, in
     * order) is written for git (GIT_SEQUENCE_EDITOR copies it); new messages for reword/squash come from the list.
     */
    async rebaseInteractive(base: string, todo: Array<{ sha: string; action: 'pick' | 'reword' | 'squash' | 'fixup' | 'drop'; message?: string }>): Promise<{ status: 'ok' | 'conflicts' | 'rejected'; message?: string; conflicts?: string[] }> {
        assertRev(base);
        await this.assertIdle('rebase');
        if (!todo.length) return { status: 'rejected', message: 'Nothing to rebase.' };
        for (const t of todo) { if (!/^[0-9a-f]{7,40}$/i.test(t.sha) || !['pick', 'reword', 'squash', 'fixup', 'drop'].includes(t.action)) throw new UserError('Invalid rebase step.'); }
        if (todo[0].action === 'squash' || todo[0].action === 'fixup') return { status: 'rejected', message: 'The first commit cannot be squashed into an earlier one.' };
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-studio-rebase-'));
        try {
            // reword/squash with a message: "exec git commit --amend -F <file>" after the step (no editor opens).
            const lines: string[] = [];
            todo.forEach((t, i) => {
                const act = t.action === 'reword' ? 'pick' : t.action === 'squash' && t.message ? 'fixup' : t.action;
                lines.push(`${act} ${t.sha}`);
                if ((t.action === 'reword' || t.action === 'squash') && t.message?.trim()) {
                    const f = path.join(dir, `msg-${i}.txt`);
                    fs.writeFileSync(f, t.message.trim() + '\n');
                    lines.push(`exec git commit --amend --no-verify -q -F "${f.replace(/\\/g, '/')}"`);
                }
            });
            const todoFile = path.join(dir, 'todo');
            fs.writeFileSync(todoFile, lines.join('\n') + '\n');
            const copy = path.join(dir, 'editor.js');
            fs.writeFileSync(copy, `require('fs').copyFileSync(${JSON.stringify(todoFile)}, process.argv[2]);\n`);
            const editor = `"${process.execPath.replace(/\\/g, '/')}" "${copy.replace(/\\/g, '/')}"`;
            const r = await this.git(['rebase', '-i', '--autostash', base], { allowFailure: true, timeoutMs: 600_000, env: { GIT_SEQUENCE_EDITOR: editor, GIT_EDITOR: 'true' } });
            return this.afterMerge(r);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    /** The commits after `base` up to HEAD, oldest first (what an interactive rebase from there would replay). */
    async commitsSince(base: string): Promise<Array<{ sha: string; subject: string; body: string; merge: boolean }>> {
        assertRev(base);
        const r = await this.git(['log', '--reverse', '--format=%H%x1f%P%x1f%s%x1f%b%x1e', `${base}..HEAD`]);
        return r.stdout.split('\x1e').map((x) => x.replace(/^\n/, '')).filter(Boolean).map((l) => { const [sha, parents, subject, body] = l.split('\x1f'); return { sha, subject, body: (body ?? '').trim(), merge: parents.trim().split(' ').length > 1 }; });
    }

    /** Who last changed each line of a file (at a commit, or the working copy). */
    async blame(file: string, rev?: string): Promise<Array<{ line: number; sha: string; author: string; date: string; summary: string }>> {
        this.safePath(file);
        if (rev) assertRev(rev);
        let r: Awaited<ReturnType<typeof this.git>>;
        try { r = await this.git(['blame', '--line-porcelain', ...(rev ? [rev] : []), '--', file], { env: LITERAL }); }
        catch (e) {
            // A file Git does not know yet (new, not committed): nobody has changed it in a commit.
            if (/no such path|no such ref|bad revision/i.test((e as Error).message)) throw new UserError(`${file} is not in any commit yet: save and commit it first, then "Who changed this" shows each line's commit.`);
            throw e;
        }
        const out: Array<{ line: number; sha: string; author: string; date: string; summary: string }> = [];
        let cur: { sha: string; line: number; author?: string; time?: number; summary?: string } | null = null;
        for (const l of r.stdout.split('\n')) {
            const h = /^([0-9a-f]{40}) \d+ (\d+)/.exec(l);
            if (h) { cur = { sha: h[1], line: Number(h[2]) }; continue; }
            if (!cur) continue;
            if (l.startsWith('author ')) cur.author = l.slice(7);
            else if (l.startsWith('author-time ')) cur.time = Number(l.slice(12));
            else if (l.startsWith('summary ')) cur.summary = l.slice(8);
            else if (l.startsWith('\t')) { out.push({ line: cur.line, sha: cur.sha, author: cur.author ?? '', date: cur.time ? new Date(cur.time * 1000).toISOString() : '', summary: cur.summary ?? '' }); cur = null; }
        }
        return out;
    }

    // ---------------------------------------------------------------- remotes, submodules, LFS

    /** The remotes with their fetch and push addresses (credentials in a URL are hidden). */
    async remotes(): Promise<Array<{ name: string; fetchUrl: string; pushUrl: string }>> {
        const r = await this.git(['remote', '-v'], { allowFailure: true });
        const by = new Map<string, { name: string; fetchUrl: string; pushUrl: string }>();
        for (const l of r.stdout.split('\n')) {
            const m = /^(\S+)\t(\S+) \((fetch|push)\)/.exec(l);
            if (!m) continue;
            const e = by.get(m[1]) ?? { name: m[1], fetchUrl: '', pushUrl: '' };
            const url = hideUrlCredentials(m[2]);
            if (m[3] === 'fetch') e.fetchUrl = url; else e.pushUrl = url;
            by.set(m[1], e);
        }
        return [...by.values()];
    }

    async addRemote(name: string, url: string): Promise<void> {
        assertRemoteName(name); assertRemoteUrl(url);
        await this.git(['remote', 'add', '--', name, url]);
    }
    async removeRemote(name: string): Promise<void> { assertRemoteName(name); await this.git(['remote', 'remove', '--', name]); }
    async renameRemote(from: string, to: string): Promise<void> { assertRemoteName(from); assertRemoteName(to); await this.git(['remote', 'rename', '--', from, to]); }
    async setRemoteUrl(name: string, url: string): Promise<void> { assertRemoteName(name); assertRemoteUrl(url); await this.git(['remote', 'set-url', '--', name, url]); }

    /** Submodules: path, commit expected, and whether they are initialised / at that commit / changed. */
    async submodules(): Promise<Array<{ path: string; sha: string; state: 'ok' | 'not-initialized' | 'different-commit' | 'conflict' }>> {
        const r = await this.git(['submodule', 'status'], { allowFailure: true });
        return r.stdout.split('\n').filter((l) => l.trim()).map((l) => {
            const m = /^([ +\-U])([0-9a-f]{40}) (\S+)/.exec(l);
            const c = m?.[1] ?? ' ';
            return { path: m?.[3] ?? l.trim(), sha: m?.[2] ?? '', state: c === '-' ? 'not-initialized' : c === '+' ? 'different-commit' : c === 'U' ? 'conflict' : 'ok' };
        });
    }
    /** Fetch and check out the submodules at the commits this repository expects (update --init --recursive). */
    async updateSubmodules(): Promise<void> {
        const r = await this.git(['submodule', 'update', '--init', '--recursive'], { allowFailure: true, timeoutMs: 900_000 });
        if (r.code !== 0) throw new GitError(explainGitFailure(r.stderr), ['submodule', 'update'], r.code, r.stderr);
    }

    /** Git LFS: used by this repository (.gitattributes filter=lfs), the git-lfs tool installed, files not downloaded yet. */
    async lfs(): Promise<{ used: boolean; installed: boolean; missing: string[] }> {
        let used = false;
        try { used = /filter=lfs/.test(fs.readFileSync(path.join(this.repoRoot, '.gitattributes'), 'utf8')); } catch { /* none */ }
        const v = await this.git(['lfs', 'version'], { allowFailure: true });
        const installed = v.code === 0;
        if (!used || !installed) return { used, installed, missing: [] };
        // "-" after the oid: a pointer file (content not downloaded); "*": the real content.
        const ls = await this.git(['lfs', 'ls-files'], { allowFailure: true });
        const missing = ls.stdout.split('\n').map((l) => /^[0-9a-f]+ - (.+)$/.exec(l.trim())?.[1]).filter((x): x is string => !!x);
        return { used, installed, missing };
    }
    async lfsPull(): Promise<void> {
        const r = await this.git(['lfs', 'pull'], { allowFailure: true, timeoutMs: 1_800_000 });
        if (r.code !== 0) throw new GitError(explainGitFailure(r.stderr), ['lfs', 'pull'], r.code, r.stderr);
    }

    /** Trust this repository folder for git (safe.directory, the user's global setting), after a "dubious ownership" refusal. */
    async trustFolder(): Promise<void> {
        const dir = this.repoRoot.replace(/\\/g, '/');
        const have = (await this.git(['config', '--global', '--get-all', 'safe.directory'], { allowFailure: true })).stdout.split('\n').map((x) => x.trim());
        if (!have.includes(dir) && !have.includes('*')) await this.git(['config', '--global', '--add', 'safe.directory', dir]);
    }

    async pullMode(): Promise<'merge' | 'rebase' | 'ff-only'> {
        const cfg = async (k: string) => (await this.git(['config', '--get', k], { allowFailure: true })).stdout.trim().toLowerCase();
        const branch = (await this.git(['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true })).stdout.trim();
        const rebase = (branch && /^[\w./-]+$/.test(branch) ? await cfg(`branch.${branch}.rebase`) : '') || await cfg('pull.rebase');
        if (['true', 'merges', 'interactive', 'i', 'm'].includes(rebase)) return 'rebase';
        if (await cfg('pull.ff') === 'only') return 'ff-only';
        return 'merge';
    }

    /** Pull the way the team configured it (or as asked), local edits put aside and back (--autostash). */
    async pull(mode?: 'merge' | 'rebase' | 'ff-only'): Promise<{ status: 'ok' | 'conflicts' | 'rejected'; message?: string; conflicts?: string[]; mode?: string }> {
        await this.assertIdle('pull');
        const m = mode ?? await this.pullMode();
        const how = m === 'rebase' ? ['--rebase'] : m === 'ff-only' ? ['--ff-only'] : ['--no-rebase', '--no-edit'];
        const r = await this.git(['pull', ...how, '--autostash'], { allowFailure: true, timeoutMs: 600_000 });
        if (m === 'ff-only' && r.code !== 0 && /not possible to fast-forward|diverging branches/i.test(r.stderr)) {
            return { status: 'rejected', mode: m, message: 'This repository pulls fast-forward only (pull.ff=only), and your branch has commits the remote does not: rebase onto it, or merge it, first.' };
        }
        return { ...(await this.afterMerge(r)), mode: m };
    }

    // ---------------------------------------------------------------- branches / merge

    async createBranch(name: string, opts: { from?: string; switchTo?: boolean } = {}): Promise<void> {
        await this.assertBranchName(name);
        if (opts.from) assertRev(opts.from);
        // Track the start point only when it is the remote branch of the same name (origin/x -> x);
        // otherwise a later push would be refused (or go to the wrong branch).
        const track = opts.from && await this.isSameNameRemoteBranch(opts.from, name) ? '--track' : '--no-track';
        const start = opts.from ? [opts.from] : [];
        if (opts.switchTo ?? true) await this.git(['switch', track, '-c', name, ...start]);
        else await this.git(['branch', track, name, ...start]);
    }

    private async isSameNameRemoteBranch(from: string, name: string): Promise<boolean> {
        const full = (await this.git(['rev-parse', '--symbolic-full-name', '--verify', '--quiet', from], { allowFailure: true })).stdout.trim();
        if (!full.startsWith('refs/remotes/')) return false;
        const rest = full.slice('refs/remotes/'.length);
        const remotes = (await this.git(['remote'])).stdout.split('\n').map((x) => x.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
        const remote = remotes.find((r) => rest.startsWith(r + '/'));
        return !!remote && rest.slice(remote.length + 1) === name;
    }

    async switchBranch(name: string): Promise<void> {
        await this.assertIdle('switch branches');
        assertRev(name);
        // A commit (not a branch): switch to it detached ("git switch <sha>" refuses: "a branch is expected").
        const isBranch = (await this.git(['show-ref', '--verify', '-q', `refs/heads/${name}`], { allowFailure: true })).code === 0;
        const isCommit = !isBranch && /^[0-9a-f]{4,40}$/i.test(name) && (await this.git(['rev-parse', '--verify', '-q', '--end-of-options', `${name}^{commit}`], { allowFailure: true })).code === 0;
        const args = isCommit ? ['switch', '--detach', name] : ['switch', name];
        const r = await this.git(args, { allowFailure: true });
        if (r.code !== 0) throw new GitError(explainGitFailure(r.stderr), args, r.code, r.stderr);
    }

    async deleteBranch(name: string, force = false): Promise<{ status: 'ok' | 'not-merged'; message?: string }> {
        assertRev(name);
        const r = await this.git(['branch', force ? '-D' : '-d', '--', name], { allowFailure: true });
        if (r.code === 0) return { status: 'ok' };
        if (/not fully merged/.test(r.stderr)) return { status: 'not-merged', message: `${name} has commits that are not in any other branch. Deleting it loses them (they stay recoverable for a while). Delete anyway?` };
        throw new GitError(explainGitFailure(r.stderr), ['branch', '-d'], r.code, r.stderr);
    }

    async renameBranch(from: string, to: string): Promise<void> {
        assertRev(from);
        await this.assertBranchName(to, 'rename');
        await this.git(['branch', '-m', '--', from, to]);
    }

    async deleteRemoteBranch(remoteBranch: string): Promise<void> {
        const [remote, ...rest] = remoteBranch.split('/');
        const branch = rest.join('/');
        assertRev(remote); assertRev(branch);
        const r = await this.git(['push', remote, '--delete', branch], { allowFailure: true, timeoutMs: 600_000 });
        if (r.code !== 0) throw new GitError(explainGitFailure(r.stderr), ['push', '--delete'], r.code, r.stderr);
    }

    async setUpstream(upstream: string): Promise<void> {
        assertRev(upstream);
        await this.git(['branch', `--set-upstream-to=${upstream}`]);
    }

    async merge(branch: string, opts: { noFastForward?: boolean; squash?: boolean; noCommit?: boolean } = {}): Promise<{ status: 'ok' | 'conflicts' | 'rejected'; message?: string; conflicts?: string[] }> {
        assertRev(branch);
        await this.assertIdle('merge another branch');
        const args = ['merge', '--no-edit'];
        if (opts.squash) args.push('--squash');
        else {
            if (opts.noFastForward) args.push('--no-ff');
            if (opts.noCommit) args.push('--no-commit');
        }
        const r = await this.git([...args, '--end-of-options', branch], { allowFailure: true });
        return this.afterMerge(r);
    }

    async abortMerge(): Promise<void> {
        await this.git(['merge', '--abort']);
    }

    /** Resolve a conflicted file by taking one side whole, or by writing the user's merged text. */
    async resolveConflict(file: string, choice: 'ours' | 'theirs' | { content: string }): Promise<{ deleted: boolean; message?: string }> {
        const abs = this.safePath(file);
        if (typeof choice === 'string') {
            if (choice !== 'ours' && choice !== 'theirs') throw new UserError('Unknown choice.');
            const stages = await this.conflictStages(file);
            if (!stages.has(choice === 'ours' ? 2 : 3)) {
                // Modify/delete conflict and the chosen side deleted the file: resolve by deleting it.
                await this.git(['rm', '--cached', '-q', '--', file], { env: LITERAL });
                fs.rmSync(abs, { force: true });
                return { deleted: true, message: `${file} was deleted on the ${choice === 'ours' ? 'current' : 'incoming'} side, so it has been deleted.` };
            }
            await this.git(['checkout', `--${choice}`, '--', file], { env: LITERAL });
        } else {
            // Written back in the file's own encoding: UTF-8, else a one-byte encoding (Latin-1 / Windows-1252),
            // as conflictVersions read it; a character the file's encoding cannot hold is refused, not mangled.
            const enc = fileEncoding(abs);
            if (enc === 'latin1' && /[^\u0000-\u00ff]/.test(choice.content)) throw new UserError(`${file} is not UTF-8 (a one-byte encoding): the merged text has characters it cannot hold. Take one side whole, or change the file's encoding first.`);
            fs.writeFileSync(abs, Buffer.from(choice.content, enc));
        }
        await this.git(['add', '--', file], { env: LITERAL });
        return { deleted: false };
    }

    /**
     * Write a conflicted file's markers again with the common base of each block (diff3 style), so the merge view
     * can show what both sides started from. Edits made to the file since the conflict are replaced (git checkout
     * --conflict=diff3); the file must still be unresolved.
     */
    async conflictWithBase(file: string): Promise<void> {
        this.safePath(file);
        const stages = await this.conflictStages(file);
        if (!stages.has(1) || !stages.has(2) || !stages.has(3)) throw new UserError('This conflict has no common version to show (the file was added or deleted on one side).');
        await this.git(['checkout', '--conflict=diff3', '--', file], { env: LITERAL });
    }

    /** Which index stages (1 base, 2 ours, 3 theirs) exist for a conflicted file. */
    private async conflictStages(file: string): Promise<Set<number>> {
        const r = await this.git(['ls-files', '-u', '-z', '--', file], { env: LITERAL });
        const set = new Set<number>();
        for (const rec of r.stdout.split('\0')) {
            const m = /^\d+ [0-9a-f]+ (\d)\t/.exec(rec);
            if (m) set.add(Number(m[1]));
        }
        return set;
    }

    /** The three versions of a conflicted file: base, ours (current branch) and theirs (incoming). */
    async conflictVersions(file: string): Promise<ConflictVersions> {
        const get = async (stage: number) => {
            const r = await this.git(['show', `:${stage}:${file}`], { allowFailure: true });
            return r.code === 0 ? r.stdout : null;
        };
        // The working copy holds git's own merge result with <<<<<<< ======= >>>>>>> markers around
        // only the parts that conflict — the UI shows just those blocks.
        const abs = this.safePath(file);
        let working: string | null = null;
        try { if (fs.statSync(abs).size <= 5 * 1024 * 1024) working = fs.readFileSync(abs).toString(fileEncoding(abs)); } catch { /* deleted on one side */ }
        const stages = await this.conflictStages(file);
        const operation = await this.operation();
        const res: ConflictVersions = {
            base: await get(1), ours: await get(2), theirs: await get(3), working,
            deletedOurs: stages.size > 0 && !stages.has(2),
            deletedTheirs: stages.size > 0 && !stages.has(3),
            operation,
        };
        if (operation === 'rebase') Object.assign(res, await this.rebaseInfo());
        return res;
    }

    // ---------------------------------------------------------------- history

    async history(q: HistoryQuery = {}): Promise<{ commits: LogCommit[]; graph: GraphRow[]; more: boolean }> {
        const head = await this.git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true });
        if (head.code !== 0 && !q.all) return { commits: [], graph: [], more: false };
        const limit = Math.min(Math.max(q.limit ?? 300, 1), 5000);
        const args = ['log', `--format=${GRAPH_LOG_FORMAT}`, '--topo-order', '--decorate=full', `-n`, String(limit + 1)];
        if (q.skip) args.push(`--skip=${Math.max(0, q.skip)}`);
        const pathFilter = !!(q.text && q.field === 'path') || !!q.path;
        // Filters that hide commits without rewriting parents: lines must only join shown commits.
        const hidesCommits = !!(q.text && q.field !== 'path') || !!q.since || !!q.until || !!q.noMerges;
        if (q.text) {
            // --fixed-strings: the text is not a regular expression ("[" must not be a git error).
            if (q.field === 'author') args.push(`--author=${q.text}`, '-i', '--fixed-strings');
            else if (q.field !== 'path') args.push(`--grep=${q.text}`, '-i', '--fixed-strings');
        }
        // Path filters: let git rewrite parents to the nearest shown ancestor.
        if (pathFilter && !q.path) args.push('--parents');
        if (q.since && /^\d{4}-\d{2}-\d{2}$/.test(q.since)) args.push(`--since=${q.since}`);
        if (q.until && /^\d{4}-\d{2}-\d{2}$/.test(q.until)) args.push(`--until=${q.until} 23:59:59`);
        if (q.firstParent) args.push('--first-parent');
        if (q.noMerges) args.push('--no-merges');
        if (q.all) args.push('--all');
        else if (q.refs?.length) { q.refs.forEach(assertRev); args.push('--end-of-options', ...q.refs); }
        else args.push('HEAD');
        if (q.text && q.field === 'path') args.push('--', q.text);
        else if (q.path) args.push('--follow', '--', q.path);
        const r = await this.git(args, { env: q.field === 'path' || q.path ? LITERAL : {}, allowFailure: true });
        if (r.code !== 0) throw new GitError(explainGitFailure(r.stderr), ['log'], r.code, r.stderr);
        const all = parseGraphLog(r.stdout);
        const more = all.length > limit;
        const commits = all.slice(0, limit);
        if (q.firstParent) for (const c of commits) c.parents = c.parents.slice(0, 1);
        // --follow cannot rewrite parents, so treat it like the other filters.
        if (hidesCommits || q.path) {
            const shown = new Set(all.map((c) => c.sha));
            for (const c of commits) c.parents = c.parents.filter((p) => shown.has(p));
        }
        return { commits, graph: layoutGraph(commits), more };
    }

    async commitDetails(rev: string): Promise<CommitDetails> {
        assertRev(rev);
        const r = await this.git(['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%cI%x1f%B', rev, '--']);
        const [sha, parents, authorName, authorEmail, date, committerName, committerDate, body] = r.stdout.split('\x1f');
        const ps = parents ? parents.trim().split(' ').filter(Boolean) : [];
        const files = ps.length
            ? await this.nameStatus([ps[0], sha])
            : await this.nameStatus(['--root', sha], true);
        const remote = await this.isPushed(sha);
        const branches = (await this.git(['branch', '-a', '--contains', sha, '--format=%(refname:short)'], { allowFailure: true })).stdout.split('\n').filter(Boolean);
        return { sha, parents: ps, authorName, authorEmail, date, committerName, committerDate, message: (body ?? '').trim(), files, pushed: remote, branches };
    }

    /** Diff of one file inside a commit (against its first parent). */
    async commitFileDiff(rev: string, file: string, opts: DiffOptions = {}): Promise<string> {
        assertRev(rev);
        const ps = (await this.git(['show', '-s', '--format=%P', '--end-of-options', rev, '--'])).stdout.trim().split(' ').filter(Boolean);
        const paths = ps.length ? await this.rangeRenamePaths([ps[0], rev], file) : [file];
        const args = ps.length
            ? [...NOQ, 'diff', ...PATCH, '-M', ...diffFlags(opts), ps[0], rev, '--', ...paths]
            : [...NOQ, 'show', ...PATCH, '--format=', ...diffFlags(opts), '--end-of-options', rev, '--', file];
        return (await this.git(args, { env: LITERAL })).stdout;
    }

    /** Files that differ between two revisions; `b` = WORKTREE compares with your working files. */
    async compare(a: string, b: string, threeDot = false): Promise<NameStatus[]> {
        assertRev(a);
        if (b === 'WORKTREE') return this.nameStatus([a]);
        assertRev(b);
        return this.nameStatus([threeDot ? `${a}...${b}` : a, ...(threeDot ? [] : [b])]);
    }

    async compareFileDiff(a: string, b: string, file: string, threeDot = false, opts: DiffOptions = {}): Promise<string> {
        assertRev(a);
        const range = b === 'WORKTREE' ? [a] : (assertRev(b), threeDot ? [`${a}...${b}`] : [a, b]);
        const paths = await this.rangeRenamePaths(range, file);
        return (await this.git([...NOQ, 'diff', ...PATCH, '-M', ...diffFlags(opts), ...range, '--', ...paths], { env: LITERAL })).stdout;
    }

    async recentMessages(limit = 25): Promise<string[]> {
        const head = await this.git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true });
        if (head.code !== 0) return [];
        const r = await this.git(['log', '-n', '200', '--no-merges', '--format=%B%x1e']);
        const seen = new Set<string>();
        const out: string[] = [];
        for (const m of r.stdout.split('\x1e').map((x) => x.trim()).filter(Boolean)) {
            const clean = m.split('\n').filter((l) => !/^[A-Za-z-]+: /.test(l) || !/^(Secret-Scan-Override|Signed-off-by|Co-authored-by):/i.test(l)).join('\n').trim();
            if (!seen.has(clean)) { seen.add(clean); out.push(clean); }
            if (out.length >= limit) break;
        }
        return out;
    }

    // ---------------------------------------------------------------- undo-type operations

    /** Undo a commit by adding a new commit that reverses it (safe for pushed history). */
    async revert(rev: string): Promise<SequencerResult> {
        assertRev(rev);
        await this.assertIdle('revert a commit');
        const ps = await this.parentsOf(rev);
        const args = ['revert', '--no-edit', ...(ps.length > 1 ? ['-m', '1'] : []), '--end-of-options', rev];
        return this.afterSequencer(await this.git(args, { allowFailure: true, env: { GIT_EDITOR: 'true' } }), 'revert');
    }

    /** Copy commits onto the current branch (oldest first). */
    async cherryPick(revs: string[]): Promise<SequencerResult> {
        if (!revs.length) throw new UserError('Choose at least one commit.');
        await this.assertIdle('cherry-pick');
        revs.forEach(assertRev);
        // A merge commit can only be copied relative to one parent: use the mainline (-m 1), as for
        // revert. git applies -m to every commit picked in one run, so pick merges separately.
        const groups: Array<{ revs: string[]; merge: boolean }> = [];
        for (const r of revs) {
            const merge = (await this.parentsOf(r)).length > 1;
            const last = groups[groups.length - 1];
            if (last && last.merge === merge && !merge) last.revs.push(r);
            else groups.push({ revs: [r], merge });
        }
        let res: SequencerResult = { status: 'ok' };
        const messages: string[] = [];
        for (const g of groups) {
            res = await this.afterSequencer(await this.git(['cherry-pick', ...(g.merge ? ['-m', '1'] : []), '--end-of-options', ...g.revs], { allowFailure: true, env: { GIT_EDITOR: 'true' } }), 'cherry-pick');
            if (res.message) messages.push(res.message);
            if (res.status !== 'ok') return res;
        }
        return { ...res, message: messages.filter(Boolean).join('\n') || res.message };
    }

    private async parentsOf(rev: string): Promise<string[]> {
        return (await this.git(['show', '-s', '--format=%P', '--end-of-options', rev, '--'])).stdout.trim().split(' ').filter(Boolean);
    }

    /** Finish a cherry-pick / revert / merge / rebase / git am after conflicts are resolved (scan-gated like a commit). */
    async continueOperation(override?: Override): Promise<GateResult & { conflicts?: string[] }> {
        const op = await this.operation();
        if (!op) return { status: 'rejected', message: 'Nothing is in progress.' };
        const st = await this.status();
        if (st.hasConflicts) return { status: 'rejected', message: 'Resolve every conflict first.' };
        const scan = await this.scanStaged();
        const gate = this.evaluateGate(scan.raw, scan.findings, scan.digest, override);
        if (gate) return gate;
        if (op === 'merge') return this.commit(st.mergeMessage ?? 'Merge', override);
        // Rebase and git am: the resolved commit is made, then the next ones are applied (each may stop on conflicts).
        const r = await this.git([op, '--continue'], { allowFailure: true, env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', [APPROVED_DIGEST_ENV]: scan.digest } });
        const res = await this.afterSequencer(r, op);
        if (res.status === 'conflicts') return { status: 'rejected', message: 'The next commit also has conflicts. Resolve them and continue again.', conflicts: res.conflicts };
        if (res.status === 'rejected') return { status: 'rejected', message: res.message ?? 'Git could not continue.' };
        return { status: 'ok', sha: (await this.git(['rev-parse', 'HEAD'])).stdout.trim(), output: res.message, overridden: scan.raw.length > 0 };
    }

    /** Leave out the commit (or patch) being applied and carry on with the rest of the operation. */
    async skipOperation(): Promise<SequencerResult> {
        const op = await this.operation();
        if (!op) return { status: 'rejected', message: 'Nothing is in progress.' };
        if (op === 'merge') return { status: 'rejected', message: 'A merge has no commit to skip: resolve it or abort it.' };
        // The commit's conflicted changes are dropped with it.
        if (op === 'am') await this.git(['reset', '-q', '--hard', 'HEAD'], { allowFailure: true });
        return this.afterSequencer(await this.git([op, '--skip'], { allowFailure: true, env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } }), op);
    }

    async abortOperation(): Promise<void> {
        const op = await this.operation();
        if (!op) return;
        const r = await this.git([op, '--abort'], { allowFailure: true });
        if (r.code !== 0) throw new GitError(explainGitFailure(r.stderr || r.stdout), [op, '--abort'], r.code, r.stderr);
    }

    /**
     * Move the current branch to another commit. Before doing anything a recovery point is saved:
     * refs/cs-studio/backups/<time> (the old position) and, for a hard reset with uncommitted
     * work, refs/cs-studio/backups/<time>-uncommitted (a snapshot of that work).
     */
    async reset(rev: string, mode: 'soft' | 'mixed' | 'hard'): Promise<{ backup: string; uncommittedBackup?: string }> {
        if (!rev.startsWith('refs/cs-studio/backups/')) assertRev(rev);
        if (!['soft', 'mixed', 'hard'].includes(mode)) throw new UserError('Unknown reset mode.');
        // Resolve the target first: a new recovery point must never change where we are going.
        const target = (await this.git(['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`])).stdout.trim();
        const headSha = (await this.git(['rev-parse', '--verify', 'HEAD'])).stdout.trim();
        const backup = await this.createBackupRef(headSha, `before reset --${mode} ${rev}`);
        let uncommittedBackup: string | undefined;
        if (mode === 'hard') {
            // Best effort: a snapshot that cannot be made must never block the reset.
            // Untracked files too: one with the path of a file the target tracks is overwritten by the reset.
            const snap = await this.snapshotUncommitted(`before reset --hard ${rev}`, true).catch(() => null);
            if (snap) {
                uncommittedBackup = await this.createRefOnce(`${backup}-uncommitted`, snap, 'uncommitted work before reset --hard')
                    ?? await this.createBackupRef(snap, 'uncommitted work before reset --hard', '-uncommitted').catch(() => undefined);
            }
        }
        await this.git(['reset', `--${mode}`, target, '--']);
        return { backup, uncommittedBackup };
    }

    /** Create refs/cs-studio/backups/<time>[-n]<suffix> -> sha; never overwrites an existing ref. */
    private async createBackupRef(sha: string, msg: string, suffix = ''): Promise<string> {
        const base = `refs/cs-studio/backups/${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').replace('Z', '')}`;
        for (let i = 0; i < 1000; i++) {
            const ref = (i === 0 ? base : `${base}-${i}`) + suffix;
            // Leave room for the "-uncommitted" companion of a plain backup.
            if (!suffix && (await this.git(['show-ref', '--verify', '-q', `${ref}-uncommitted`], { allowFailure: true })).code === 0) continue;
            if (await this.createRefOnce(ref, sha, msg)) return ref;
        }
        throw new UserError('Could not create a recovery point. Try again.');
    }

    /** `update-ref <ref> <sha> <zero>`: succeeds only if the ref does not exist yet. */
    private async createRefOnce(ref: string, sha: string, msg: string): Promise<string | undefined> {
        const r = await this.git(['update-ref', '-m', msg, ref, sha, ZERO_OID], { allowFailure: true });
        if (r.code === 0) return ref;
        if ((await this.git(['show-ref', '--verify', '-q', ref], { allowFailure: true })).code === 0) return undefined; // taken
        // Another failure (e.g. a ref lock held by a parallel call): let the caller try another name.
        if (/lock|exists/i.test(r.stderr)) return undefined;
        throw new GitError(explainGitFailure(r.stderr), ['update-ref'], r.code, r.stderr);
    }

    /**
     * A stash-shaped commit holding the uncommitted work, or null when there is none. `git stash
     * create` refuses while the index has unmerged entries (a conflicted merge); then the working
     * tree is snapshotted through a temporary index instead.
     */
    private async snapshotUncommitted(msg: string, withUntracked = false): Promise<string | null> {
        // "stash create" leaves untracked files out: with them, the temporary index below (add -A) is used.
        if (!withUntracked) {
            const r = await this.git(['stash', 'create', msg], { allowFailure: true });
            if (r.code === 0) return r.stdout.trim() || null;
        }
        const head = (await this.git(['rev-parse', '--verify', 'HEAD'])).stdout.trim();
        const realIndex = path.resolve(this.repoRoot, (await this.git(['rev-parse', '--git-path', 'index'])).stdout.trim());
        const tmpIndex = path.join(os.tmpdir(), `cs-studio-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        try {
            if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmpIndex);
            const env = { GIT_INDEX_FILE: tmpIndex };
            await this.git(['add', '-A', '--', '.'], { env });
            const tree = (await this.git(['write-tree'], { env })).stdout.trim();
            const headTree = (await this.git(['rev-parse', 'HEAD^{tree}'])).stdout.trim();
            if (tree === headTree) return null;
            // Stash layout (W with parents HEAD and an index commit I) so "stash apply" can restore it.
            const i = (await this.git(['commit-tree', headTree, '-p', head, '-m', `index on ${msg}`])).stdout.trim();
            return (await this.git(['commit-tree', tree, '-p', head, '-p', i, '-m', msg])).stdout.trim();
        } finally {
            fs.rmSync(tmpIndex, { force: true });
        }
    }

    async backups(): Promise<Array<{ ref: string; sha: string; date: string; subject: string }>> {
        const r = await this.git(['for-each-ref', '--sort=-refname', '--format=%(refname)%1f%(objectname)%1f%(creatordate:iso-strict)%1f%(contents:subject)', 'refs/cs-studio/backups']);
        return r.stdout.split('\n').filter(Boolean).map((l) => { const [ref, sha, date, subject] = l.split('\x1f'); return { ref, sha, date, subject }; });
    }

    /** Go back to a recovery point (itself protected by a new recovery point). */
    async restoreBackup(ref: string): Promise<void> {
        if (!/^refs\/cs-studio\/backups\/[\w-]+$/.test(ref)) throw new UserError('Unknown recovery point.');
        if ((await this.git(['show-ref', '--verify', '-q', ref], { allowFailure: true })).code !== 0) throw new UserError('That recovery point no longer exists.');
        if (ref.endsWith('-uncommitted')) {
            const r = await this.git(['stash', 'apply', ref], { allowFailure: true });
            if (r.code !== 0) throw new GitError(explainGitFailure(r.stderr), ['stash', 'apply'], r.code, r.stderr);
            return;
        }
        await this.reset(ref, 'hard');
    }

    /**
     * Throw away uncommitted edits in files (new files are deleted). A copy of each file is kept in
     * .git/cs-studio/recovery/<time>/ first, so nothing is lost by a mis-click.
     */
    async discard(paths: string[]): Promise<{ recoveryDir: string }> {
        if (!paths.length) throw new UserError('Choose at least one file.');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const recoveryDir = path.resolve(this.repoRoot, (await this.git(['rev-parse', '--git-path', `cs-studio/recovery/${stamp}`])).stdout.trim());
        const st = await this.status();
        for (const p of paths) {
            const abs = this.safePath(p);
            if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
                const dest = path.join(recoveryDir, p);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.copyFileSync(abs, dest);
            }
            const f = st.files.find((x) => x.path === p);
            if (f?.untracked) fs.rmSync(abs, { force: true });
            else await this.git(['restore', '--worktree', '--', p], { env: LITERAL });
        }
        return { recoveryDir };
    }

    /** Restore one file as it was in a commit (your current version is backed up first). */
    async restoreFileFrom(rev: string, file: string): Promise<{ recoveryDir: string }> {
        assertRev(rev);
        const abs = this.safePath(file);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const recoveryDir = path.resolve(this.repoRoot, (await this.git(['rev-parse', '--git-path', `cs-studio/recovery/${stamp}`])).stdout.trim());
        if (fs.existsSync(abs)) { const d = path.join(recoveryDir, file); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(abs, d); }
        await this.git(['restore', `--source=${rev}`, '--worktree', '--', file], { env: LITERAL });
        return { recoveryDir };
    }

    // ---------------------------------------------------------------- partial staging (hunks)

    /** The change blocks ("hunks") of a file, staged or not. */
    /**
     * The change blocks ("hunks") of a file, staged or not. Each hunk has an `id` (hash of its
     * exact bytes) so a later stage/unstage can detect that the file changed in the meantime.
     * Lines are shown decoded as UTF-8; staging works on the raw bytes (any encoding).
     */
    async hunks(file: string, staged: boolean): Promise<{ header: string[]; hunks: Hunk[]; binary: boolean }> {
        const raw = await this.rawHunks(file, staged);
        const dec = (l: string) => Buffer.from(l, 'latin1').toString('utf8');
        return {
            header: raw.header.map(dec),
            hunks: raw.hunks.map((h) => ({ ...h, header: dec(h.header), lines: h.lines.map(dec) })),
            binary: raw.binary,
        };
    }

    /** Hunks with every string holding raw bytes (latin1: one char per byte). */
    private async rawHunks(file: string, staged: boolean): Promise<{ header: string[]; hunks: Hunk[]; binary: boolean }> {
        const paths = staged ? await this.stagedRenamePaths(file) : [file];
        const args = [...NOQ, 'diff', ...PATCH, '--no-textconv', '-U3', ...(staged ? ['--cached', '-M'] : []), '--', ...paths];
        const r = await this.git(args, { env: LITERAL, encoding: 'buffer' });
        const res = splitHunks((r.stdoutBuffer ?? Buffer.alloc(0)).toString('latin1'));
        return { ...res, binary: res.header.some((h) => h.startsWith('Binary files') || h.startsWith('GIT binary patch')) };
    }

    /**
     * Stage (or unstage) just the chosen hunks of a file. `selection` holds hunk ids from hunks()
     * (preferred: refused if that exact change is gone) or, for older callers, hunk indexes.
     */
    async stageHunks(file: string, selection: Array<number | string>, unstage = false): Promise<void> {
        const { header, hunks, binary } = await this.rawHunks(file, unstage);
        if (binary) throw new UserError('Binary files can only be staged whole.');
        const chosen: Hunk[] = [];
        for (const sel of selection) {
            if (typeof sel === 'string') {
                const h = hunks.find((x) => x.id === sel);
                if (!h) throw new UserError(STALE_HUNK_MESSAGE);
                chosen.push(h);
            } else if (hunks[sel]) chosen.push(hunks[sel]);
        }
        if (!chosen.length) throw new UserError('Those changes are no longer there. Refresh and try again.');
        const uniq = chosen.filter((h, i) => chosen.indexOf(h) === i).sort((a, b) => hunks.indexOf(a) - hunks.indexOf(b));
        const patch = [...plainModifyHeader(header), ...uniq.flatMap((h) => h.lines)].join('\n') + '\n';
        await this.git(['apply', '--cached', '--recount', '--whitespace=nowarn', ...(unstage ? ['-R'] : []), '-'], { input: Buffer.from(patch, 'latin1') });
    }

    /**
     * Stage (or unstage) only some lines of one hunk. `lines` are indexes into the hunk's lines as hunks() shows
     * them (0 is the @@ header). An added line not chosen is left out of the patch; a removed line not chosen
     * becomes context (it stays). Unstaging is the reverse: from the staged hunk, a "+" not chosen stays (context),
     * a "-" not chosen is left out.
     */
    async stageLines(file: string, hunkId: string, lines: number[], unstage = false): Promise<void> {
        const { header, hunks, binary } = await this.rawHunks(file, unstage);
        if (binary) throw new UserError('Binary files can only be staged whole.');
        const h = hunks.find((x) => x.id === hunkId);
        if (!h) throw new UserError(STALE_HUNK_MESSAGE);
        const chosen = new Set(lines);
        const out: string[] = [h.lines[0]];
        let changes = 0;
        h.lines.slice(1).forEach((l, i) => {
            const idx = i + 1;
            const kind = l[0];
            if (kind !== '+' && kind !== '-') { out.push(l); return; }
            if (chosen.has(idx)) { out.push(l); changes++; return; }
            // Not chosen: keep the file as it is on the side the patch applies to.
            if ((kind === '-' && !unstage) || (kind === '+' && unstage)) out.push(' ' + l.slice(1));
        });
        if (!changes) throw new UserError('Choose at least one added or removed line.');
        const patch = [...plainModifyHeader(header), ...out].join('\n') + '\n';
        await this.git(['apply', '--cached', '--recount', '--whitespace=nowarn', ...(unstage ? ['-R'] : []), '-'], { input: Buffer.from(patch, 'latin1') });
    }

    /** A new (untracked) file becomes "intent to add" (git add -N), so its lines can be staged in parts. */
    async intentToAdd(file: string): Promise<void> {
        this.safePath(file);
        await this.git(['add', '-N', '--', file], { env: LITERAL });
    }

    // ---------------------------------------------------------------- stash

    async stashList(): Promise<StashEntry[]> {
        const r = await this.git(['stash', 'list', '--format=%gd%x1f%H%x1f%gs%x1f%aI'], { allowFailure: true });
        return r.stdout.split('\n').filter(Boolean).map((l) => {
            const [ref, sha, subject, date] = l.split('\x1f');
            return { index: Number(/\{(\d+)\}/.exec(ref)?.[1] ?? 0), ref, sha, message: subject.replace(/^On [^:]+: /, '').replace(/^WIP on [^:]+: /, ''), date };
        });
    }

    async stashSave(message: string, includeUntracked: boolean): Promise<void> {
        const st = await this.status();
        if (!st.files.some((f) => !f.untracked) && !(includeUntracked && st.files.some((f) => f.untracked))) throw new UserError('There are no changes to stash.');
        const args = ['stash', 'push'];
        if (includeUntracked) args.push('--include-untracked');
        if (message.trim()) args.push('-m', oneLine(message));
        await this.git(args);
    }

    /**
     * The stash entry the user chose: by its commit when given (the list may have changed since it was shown: a
     * stash made elsewhere shifts every index), else by index.
     */
    private async stashRef(index: number, sha?: string): Promise<string> {
        if (!sha) return `stash@{${stashIndex(index)}}`;
        if (!/^[0-9a-f]{40}$/i.test(sha)) throw new UserError('Unknown stash entry.');
        const e = (await this.stashList()).find((x) => x.sha === sha);
        if (!e) throw new UserError('That stash entry no longer exists (the stash list changed). Refresh the list.');
        return `stash@{${e.index}}`;
    }

    async stashApply(index: number, pop: boolean, sha?: string): Promise<{ status: 'ok' | 'conflicts' | 'rejected'; message?: string; conflicts?: string[] }> {
        const ref = await this.stashRef(index, sha);
        // --index brings staged files back staged, as they were. Git refuses it (changing nothing)
        // when the staged part cannot be restored cleanly; then apply as usual (all unstaged).
        let r = await this.git(['stash', pop ? 'pop' : 'apply', '--index', ref], { allowFailure: true });
        if (r.code !== 0 && /Conflicts in index|Try without --index|could not restore untracked|cannot apply a stash in the middle/i.test(r.stderr) && !/CONFLICT/.test(r.stdout)) {
            r = await this.git(['stash', pop ? 'pop' : 'apply', ref], { allowFailure: true });
        }
        return this.afterMerge(r);
    }

    async stashDrop(index: number, sha?: string): Promise<void> {
        await this.git(['stash', 'drop', await this.stashRef(index, sha)]);
    }

    async stashFiles(index: number): Promise<NameStatus[]> {
        const ref = `stash@{${stashIndex(index)}}`;
        const files = await this.nameStatus([`${ref}^1`, ref]);
        const u = await this.git(['show', '--format=', '--name-only', '-z', `${ref}^3`, '--'], { allowFailure: true });
        if (u.code === 0) for (const p of u.stdout.split('\0').map((x) => x.replace(/^\n+/, '')).filter(Boolean)) files.push({ status: 'A', path: p });
        return files;
    }

    async stashFileDiff(index: number, file: string): Promise<string> {
        const ref = `stash@{${stashIndex(index)}}`;
        const tracked = await this.git([...NOQ, 'diff', ...PATCH, `${ref}^1`, ref, '--', file], { env: LITERAL });
        if (tracked.stdout) return tracked.stdout;
        return (await this.git([...NOQ, 'show', ...PATCH, '--format=', `${ref}^3`, '--', file], { allowFailure: true, env: LITERAL })).stdout;
    }

    // ---------------------------------------------------------------- tags

    async tags(): Promise<TagInfo[]> {
        const r = await this.git(['for-each-ref', '--sort=-creatordate', '--format=%(refname:lstrip=2)%1f%(objectname)%1f%(*objectname)%1f%(creatordate:iso-strict)%1f%(contents:subject)%1f%(objecttype)', 'refs/tags']);
        const out: TagInfo[] = [];
        for (const l of r.stdout.split('\n').filter(Boolean)) {
            const [name, obj, target, date, subject, type] = l.split('\x1f');
            let sha = target || obj;
            if (type === 'tag') {
                // %(*objectname) peels one level only; a tag of a tag needs a full peel.
                const t = (await this.git(['cat-file', '-t', sha], { allowFailure: true })).stdout.trim();
                if (t === 'tag') {
                    const c = await this.git(['rev-parse', '--verify', '-q', `${obj}^{commit}`], { allowFailure: true });
                    if (c.code === 0) sha = c.stdout.trim();
                }
            }
            out.push({ name, sha, date, message: type === 'tag' ? subject : '', annotated: type === 'tag' });
        }
        return out;
    }

    async createTag(name: string, rev: string, message?: string): Promise<void> {
        if (!name.trim()) throw new UserError('Give the tag a name.');
        const RULES = 'A tag name must not start with "-" or ".", end with "/", "." or ".lock", or contain spaces, ~ ^ : ? * [ \\, "..", "@{" or "//".';
        if (name.startsWith('-')) throw new UserError(`"${name}" is not a valid tag name: it must not start with "-".`);
        const r = await this.git(['check-ref-format', `refs/tags/${name}`], { allowFailure: true });
        if (r.code !== 0) throw new UserError(`"${name}" is not a valid tag name. ${RULES}`);
        const exists = await this.git(['show-ref', '--verify', '--quiet', `refs/tags/${name}`], { allowFailure: true });
        if (exists.code === 0) throw new UserError(`A tag named "${name}" exists already: choose another name (a tag is not moved).`);
        // A tag with the name of a branch makes the name ambiguous: git then warns on every use and
        // "tags/<name>" shows up where "<name>" was meant. Refuse it.
        const branch = await this.git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { allowFailure: true });
        if (branch.code === 0) throw new UserError(`A branch named "${name}" exists: a tag with the same name would make "${name}" ambiguous. Choose another name.`);
        assertRev(rev);
        const target = await this.git(['rev-parse', '--verify', '-q', `${rev}^{commit}`], { allowFailure: true });
        if (target.code !== 0) throw new UserError(`"${rev}" is not a branch, tag or commit in this repository: check the "At" field.`);
        await this.git(message?.trim() ? ['tag', '-a', name, '-m', message.trim(), rev] : ['tag', name, rev]);
    }

    async deleteTag(name: string, alsoRemote: boolean): Promise<void> {
        assertRev(name);
        // Work on the full ref, so a tag that shares its name with a branch is still found (and an
        // older list that showed it as "tags/<name>" still deletes it).
        const has = async (n: string) => (await this.git(['show-ref', '--verify', '--quiet', `refs/tags/${n}`], { allowFailure: true })).code === 0;
        let tag = name;
        if (!(await has(tag))) {
            const short = name.replace(/^(refs\/)?tags\//, '');
            if (short !== name && await has(short)) tag = short;
            else throw new UserError(`There is no tag named "${name}" (it may have been deleted already).`);
        }
        await this.git(['update-ref', '-d', `refs/tags/${tag}`]);
        if (alsoRemote) {
            const remote = await this.defaultRemote();
            if (remote) await this.git(['push', remote, '--delete', `refs/tags/${tag}`], { allowFailure: true, timeoutMs: 600_000 });
        }
    }

    async pushTag(name: string): Promise<void> {
        assertRev(name);
        const remote = await this.defaultRemote();
        if (!remote) throw new UserError(NO_REMOTE_TO_PUSH);
        const r = await this.git(['push', remote, `refs/tags/${name}`], { allowFailure: true, timeoutMs: 600_000 });
        if (r.code !== 0) throw new GitError(explainGitFailure(r.stderr), ['push', 'tag'], r.code, r.stderr);
    }

    // ---------------------------------------------------------------- helpers

    /** True when the commit is on any remote-tracking branch (i.e. others may have it). */
    async isPushed(rev: string): Promise<boolean> {
        const r = await this.git(['branch', '-r', '--contains', rev], { allowFailure: true });
        return r.code === 0 && r.stdout.trim().length > 0;
    }

    /**
     * Refuse to start a new merge/revert/cherry-pick/pull/switch while one is unfinished (a reset
     * stays allowed: a hard reset is the way out of a merge, with a recovery point saved first):
     * git would refuse too, but with a message that sounds like a new conflict.
     */
    private async assertIdle(what: string): Promise<void> {
        const op = await this.operation();
        if (!op) return;
        const name = op === 'am' ? 'patch apply (git am)' : op;
        throw new UserError(`A ${name} is still in progress. Finish it first (Source control → Changes: resolve the conflicts, then ${op === 'merge' ? 'commit' : 'press Continue in the banner'}), or abort it, before you ${what}.`);
    }

    private async operation(): Promise<Operation> {
        const exists = async (p: string) => fs.existsSync(path.resolve(this.repoRoot, (await this.git(['rev-parse', '--git-path', p])).stdout.trim()));
        if (await exists('rebase-merge')) return 'rebase';
        // rebase-apply is used both by the old "apply" rebase backend and by `git am`.
        if (await exists('rebase-apply')) return await exists('rebase-apply/applying') ? 'am' : 'rebase';
        if (await exists('CHERRY_PICK_HEAD')) return 'cherry-pick';
        if (await exists('REVERT_HEAD')) return 'revert';
        if (await exists('MERGE_HEAD')) return 'merge';
        return null;
    }

    private async afterSequencer(r: { code: number; stdout: string; stderr: string }, op: 'cherry-pick' | 'revert' | 'rebase' | 'am', depth = 0): Promise<SequencerResult> {
        if (r.code === 0) return { status: 'ok', message: r.stdout.trim() };
        const st = await this.status();
        if (st.hasConflicts) return { status: 'conflicts', conflicts: st.files.filter((f) => f.conflicted).map((f) => f.path), operation: st.operation };
        const empty = /nothing to commit|previous cherry-pick is now empty|nothing added to commit|No changes - did you forget|No changes -- Patch already applied/i.test(r.stderr + r.stdout);
        if (empty && st.operation !== op) {
            return { status: 'ok', message: op === 'revert' ? 'That change is already undone on this branch, so nothing new was added.' : 'That change is already on this branch, so nothing new was added.' };
        }
        if (empty && depth < 1000) {
            // The commit would be empty: skip it (with the operation in progress, not always cherry-pick)
            // and carry on with any remaining commits of the same run.
            const skip = await this.git([op, '--skip'], { allowFailure: true, env: { GIT_EDITOR: 'true' } });
            const already = 'That change is already on this branch, so nothing new was added.';
            if (skip.code === 0) return { status: 'ok', message: already };
            const next = await this.afterSequencer(skip, op, depth + 1);
            return next.status === 'ok' ? { ...next, message: already } : next;
        }
        return { status: 'rejected', message: explainGitFailure(r.stderr || r.stdout) };
    }

    private async nameStatus(range: string[], rootCommit = false): Promise<NameStatus[]> {
        const args = rootCommit ? ['diff-tree', '-r', '-M', '--name-status', '-z', '--no-commit-id', ...range] : ['diff', '-M', '--name-status', '-z', ...range, '--'];
        const parts = (await this.git(args)).stdout.split('\0').filter((x, i, a) => x !== '' || i < a.length - 1);
        const out: NameStatus[] = [];
        for (let i = 0; i < parts.length; i++) {
            const code = parts[i];
            if (!code) continue;
            if (/^[RC]/.test(code)) { out.push({ status: code[0], oldPath: parts[i + 1], path: parts[i + 2] }); i += 2; }
            else { out.push({ status: code[0], path: parts[i + 1] }); i += 1; }
        }
        return out;
    }

    // ---------------------------------------------------------------- (existing helpers)

    private async afterMerge(r: { code: number; stdout: string; stderr: string }) {
        if (r.code === 0) return { status: 'ok' as const, message: r.stdout.trim() };
        const st = await this.status();
        if (st.hasConflicts) return { status: 'conflicts' as const, conflicts: st.files.filter((f) => f.conflicted).map((f) => f.path) };
        return { status: 'rejected' as const, message: explainGitFailure(r.stderr || r.stdout) };
    }

    private async defaultRemote(): Promise<string | null> {
        const r = await this.git(['remote']);
        const remotes = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
        if (remotes.includes('origin')) return 'origin';
        return remotes[0] ?? null;
    }

    private async assertBranchName(name: string, what: 'create' | 'rename' = 'create'): Promise<void> {
        if (!name.trim()) throw new UserError('Give the branch a name.');
        const r = await this.git(['check-ref-format', '--branch', name], { allowFailure: true });
        if (r.code !== 0 || name.startsWith('-')) throw new UserError(`"${name}" is not a valid branch name: no spaces, ~ ^ : ? * [ \\, "..", or a name starting with "-" or ending with "." or ".lock".`);
        const exists = await this.git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { allowFailure: true });
        if (exists.code === 0) throw new UserError(what === 'rename' ? `A branch named "${name}" exists already: choose another name.` : `A branch named "${name}" exists already: choose another name, or switch to it.`);
    }

    /** Resolve a repo-relative path and refuse anything outside the repository. */
    safePath(file: string): string {
        const abs = path.resolve(this.repoRoot, file);
        const rel = path.relative(this.repoRoot, abs);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new UserError(`Path is outside the repository: ${file}`);
        return abs;
    }
}

function oneLine(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

/** Turn common git failures into plain language; keep git's own text for the rest. */
export function explainGitFailure(stderr: string): string {
    const t = stderr.trim();
    if (/detected dubious ownership|safe\.directory/i.test(t)) {
        // Common on Windows / VDI: the folder belongs to another account (a copied profile, a shared drive).
        return 'Git does not trust this folder: it belongs to another Windows account (git "safe.directory"). Choose "Trust this folder" in Source control, or run: git config --global --add safe.directory <folder>.';
    }
    if (/\[rejected\].*\(fetch first\)|non-fast-forward|Updates were rejected/i.test(t)) {
        return 'The remote branch has commits you do not have yet. Pull first, then push again.';
    }
    if (/Authentication failed|could not read Username|terminal prompts disabled|403/i.test(t)) {
        return 'Git could not sign in to the remote. Check your Git credentials (Git Credential Manager) and try again.';
    }
    if (/Could not resolve host|unable to access/i.test(t)) return `Git could not reach the remote. ${t}`;
    if (/would be overwritten by (checkout|merge)/i.test(t)) {
        return 'You have uncommitted changes that this would overwrite. Commit them or stash them first.';
    }
    if (/Please tell me who you are|empty ident/i.test(t)) {
        return 'Git does not know your name and email yet. Set them in Settings → "Your name on commits".';
    }
    if (/hook declined|pre-commit hook|commit-msg hook/i.test(t)) return `A Git hook stopped the commit:\n${t}`;
    if (/index\.lock'?: File exists|Unable to create '.*\.lock'|Another git process seems to be running/i.test(t)) {
        return INDEX_LOCK_MESSAGE;
    }
    if (/does not appear to be a git repository|Could not read from remote repository|repository '.*' not found/i.test(t)) {
        return `Git could not reach the remote repository. Check the remote address and your access rights.\n${t}`;
    }
    if (/Connection (timed out|refused)|Operation timed out|SSL certificate problem|unable to get local issuer certificate/i.test(t)) {
        return `Git could not connect to the remote (network or proxy problem).\n${t}`;
    }
    return t || 'Git reported an error.';
}

export const INDEX_LOCK_MESSAGE = 'Another Git program (a terminal or another editor) is working in this repository right now. Wait for it to finish and try again. If nothing else is running, a previous Git process may have crashed — the Studio can remove the stale lock.';

export type Operation = 'merge' | 'cherry-pick' | 'revert' | 'rebase' | 'am' | null;
export interface RebaseInfo {
    /** Always true during a rebase: git's "ours" is the upstream, "theirs" is your own commit. */
    sidesSwapped: boolean;
    /** The branch being rebased (null when detached). */
    rebaseBranch: string | null;
    /** What it is being rebased onto (a branch name when one points there, else a sha). */
    rebaseOnto: string | null;
}
export type StatusResult = RepoStatus & { mergeMessage?: string; operation: Operation } & Partial<RebaseInfo>;
export interface ConflictVersions extends Partial<RebaseInfo> {
    base: string | null;
    ours: string | null;
    theirs: string | null;
    working: string | null;
    /** The current (ours) side deleted the file (modify/delete conflict). */
    deletedOurs: boolean;
    /** The incoming (theirs) side deleted the file. */
    deletedTheirs: boolean;
    operation: Operation;
}
export interface DiffOptions { ignoreWhitespace?: 'none' | 'changes' | 'all'; ignoreLineEndings?: boolean }
export interface HistoryQuery { limit?: number; skip?: number; all?: boolean; refs?: string[]; text?: string; field?: 'message' | 'author' | 'path'; path?: string; since?: string; until?: string; firstParent?: boolean; noMerges?: boolean }
export interface NameStatus { status: string; path: string; oldPath?: string }
export interface CommitDetails { sha: string; parents: string[]; authorName: string; authorEmail: string; date: string; committerName: string; committerDate: string; message: string; files: NameStatus[]; pushed: boolean; branches: string[] }
export type SequencerResult = { status: 'ok' | 'conflicts' | 'rejected'; message?: string; conflicts?: string[]; operation?: Operation };
export interface StashEntry { index: number; ref: string; sha: string; message: string; date: string }
export interface TagInfo { name: string; sha: string; date: string; message: string; annotated: boolean }
export interface Hunk {
    header: string; lines: string[]; added: number; removed: number; newStart: number;
    /** sha256 of the hunk's exact text (header + lines); changes when the change changes. */
    id: string;
}

function diffFlags(o: DiffOptions): string[] {
    const f: string[] = [];
    if (o.ignoreWhitespace === 'changes') f.push('--ignore-space-change');
    if (o.ignoreWhitespace === 'all') f.push('--ignore-all-space');
    if (o.ignoreLineEndings) f.push('--ignore-cr-at-eol');
    return f;
}

/**
 * Refuse anything git could read as an option (leading '-') and characters no ref or revision can
 * contain (NUL, newlines, other control characters, spaces, and '..' which git forbids in ref names
 * and would read as a range here). Everything else — `fix#123`, `tâche`,
 * `v1.0+build,1` — is left for git itself to judge (callers also pass `--end-of-options` or put the
 * value where git cannot take it as an option).
 */
export function assertRev(rev: string): void {
    if (typeof rev !== 'string' || !rev || rev.length > 1024 || rev.startsWith('-') || /[\x00-\x1f\x7f]/.test(rev) || /\s/.test(rev) || /\.\./.test(rev)) {
        throw new UserError(`"${rev}" is not a valid branch, tag or commit.`);
    }
}

/** Strip comment lines as `git commit --cleanup=strip` would, for the configured comment char. */
export function stripComments(msg: string, commentChar: string | 'auto' = '#'): string {
    const lines = msg.split(/\r?\n/);
    // Git's own "--- >8 ---" scissors line: everything below it is dropped.
    const cut = lines.findIndex((l) => / -+ >8 -+$/.test(l));
    const kept = cut >= 0 ? lines.slice(0, cut) : lines;
    let isComment: (l: string) => boolean;
    if (commentChar === 'auto') {
        // git chose a character not used at the start of any line of the message; recognise its
        // own comment block by the standard first comment line, or fall back to '#'.
        const ch = kept.map((l) => /^(.) (Please enter|Conflicts:|It looks like)/.exec(l)?.[1]).find(Boolean) ?? '#';
        isComment = (l) => l.startsWith(ch);
    } else isComment = (l) => l.startsWith(commentChar);
    return kept.filter((l) => !isComment(l)).join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** [oldPath, path] when `file` is the target of a rename in `--name-status -z -M` output. */
function renamePathsFrom(out: string, file: string): string[] {
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
        const code = parts[i];
        if (!code) continue;
        if (/^[RC]/.test(code)) {
            if (code[0] === 'R' && parts[i + 2] === file) return [parts[i + 1], file];
            i += 2;
        } else i += 1;
    }
    return [file];
}

/**
 * Patch header that applies to the file's current path only: rename/copy headers are rewritten to a
 * plain modification of the new path, so (un)staging a hunk of a renamed file keeps the rename.
 */
function plainModifyHeader(header: string[]): string[] {
    if (!header.some((h) => /^(rename|copy) (from|to) /.test(h))) return header;
    const plus = header.find((h) => h.startsWith('+++ '));
    if (!plus) return header;
    const bName = plus.slice(4).replace(/\t$/, '');
    const aName = bName.startsWith('"b/') ? '"a/' + bName.slice(3) : bName.startsWith('b/') ? 'a/' + bName.slice(2) : bName;
    const out: string[] = [`diff --git ${aName} ${bName}`];
    for (const h of header.slice(1)) {
        if (/^(similarity|dissimilarity) index |^(rename|copy) (from|to) |^index /.test(h)) continue;
        if (h.startsWith('--- ')) out.push(`--- ${aName}`);
        else if (h.startsWith('+++ ')) out.push(`+++ ${bName}`);
        else out.push(h);
    }
    return out;
}

function stashIndex(i: number): number {
    if (!Number.isInteger(i) || i < 0 || i > 10000) throw new UserError('Unknown stash entry.');
    return i;
}

/** Split a single-file unified diff into its header and hunks. */
export function splitHunks(diff: string): { header: string[]; hunks: Hunk[] } {
    const lines = diff.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const header: string[] = [];
    const hunks: Hunk[] = [];
    let cur: Hunk | null = null;
    for (const l of lines) {
        if (l.startsWith('@@')) {
            const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
            cur = { header: l, lines: [l], added: 0, removed: 0, newStart: m ? Number(m[1]) : 0, id: '' };
            hunks.push(cur);
        } else if (cur) {
            cur.lines.push(l);
            if (l.startsWith('+')) cur.added++;
            else if (l.startsWith('-')) cur.removed++;
        } else header.push(l);
    }
    for (const h of hunks) h.id = createHash('sha256').update(h.lines.join('\n')).digest('hex').slice(0, 32);
    return { header, hunks };
}

/** A file's text encoding: UTF-8 when its bytes are valid UTF-8, else a one-byte encoding (read and written as Latin-1, byte for byte). */
export function fileEncoding(abs: string): 'utf8' | 'latin1' {
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(abs));
        return 'utf8';
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'utf8' : 'latin1';
    }
}

/** A remote URL without the user:password part (shown in the UI and logs). */
export function hideUrlCredentials(url: string): string {
    return url.replace(/^(https?:\/\/)[^/@]+@/i, '$1');
}
function assertRemoteName(name: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) throw new UserError('A remote name is letters, digits, dot, dash or underscore (for example origin or upstream).');
}
function assertRemoteUrl(url: string): void {
    // https/ssh/git addresses or a local path; never an option ("-…") or a helper transport ("ext::").
    if (!url || url.startsWith('-') || /^[a-z][a-z0-9+.-]*::/i.test(url) || /[\r\n]/.test(url) || url.length > 2000) throw new UserError('That is not a repository address (https://…, ssh://…, git@host:path or a folder).');
}
