/**
 * A pull request checked out next to the project, to run its tests without touching the user's
 * working copy (their branch, staged and unsaved work stay exactly as they are).
 *
 *  - What is tested: refs/pull/<id>/merge — the result of merging the pull request into its target,
 *    i.e. what will land. Azure DevOps keeps this ref up to date; when the pull request has merge
 *    conflicts there is none, and the source branch itself is tested instead (and the user is told).
 *  - Where: a Git worktree in <git dir>/cs-studio/pr/<id> (inside the repository folder, ignored by
 *    Git, removed with "Remove local copy"). Reused for the next run of the same pull request.
 *  - node_modules: linked to the project's own (a junction on Windows, no admin rights needed), so
 *    the installed framework and packages are used as they are.
 *  - Local configuration that is not in Git (ignored files under config/, e.g. a personal .env) is
 *    copied over, so tests see the same settings as in the project.
 */
import * as fs from 'fs';
import * as path from 'path';
import { runGit } from './run';
import { UserError } from '../core/errors';
import { remoteForRepository } from '../ado/pullRequests';

export interface PrCheckout {
    /** Absolute folder of the checkout. */
    dir: string;
    /** The same, relative to the repository root (forward slashes). */
    rel: string;
    commit: string;
    /** 'merge': the merge result (what will land); 'source': the source branch (merge conflicts). */
    based: 'merge' | 'source';
    remote: string;
    reused: boolean;
    copiedConfig: string[];
    notes: string[];
}

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0' };

async function git(cwd: string, args: string[], allowFailure = false) {
    return runGit(args, { cwd, allowFailure, env: GIT_ENV, timeoutMs: 10 * 60_000 });
}

export async function remotes(repoRoot: string): Promise<Array<{ name: string; url: string }>> {
    const r = await git(repoRoot, ['remote', '-v'], true);
    const out = new Map<string, string>();
    for (const l of r.stdout.split('\n')) {
        const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(l.trim());
        if (m) out.set(m[1], m[2]);
    }
    return [...out].map(([name, url]) => ({ name, url }));
}

/** Folder for checkouts: inside the .git folder when that is inside the repository. */
export function checkoutBase(repoRoot: string, gitDir: string): string {
    const rel = path.relative(repoRoot, gitDir);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return path.join(gitDir, 'cs-studio', 'pr');
    // .git elsewhere (a worktree or submodule): a folder in the repository, ignored locally.
    const base = path.join(repoRoot, '.cs-studio', 'pr');
    try {
        const exclude = path.join(gitDir, 'info', 'exclude');
        // Only the checkouts: the rest of .cs-studio/ holds team settings that are committed (policy, pipeline,
        // agents). An earlier version ignored the whole folder: that line is narrowed.
        let cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
        const narrowed = cur.replace(/^\/\.cs-studio\/(\r?)$/gm, '/.cs-studio/pr/$1');
        if (narrowed !== cur) { fs.writeFileSync(exclude, narrowed); cur = narrowed; }
        if (!/^\/\.cs-studio\/pr\/\r?$/m.test(cur)) { fs.mkdirSync(path.dirname(exclude), { recursive: true }); fs.appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}/.cs-studio/pr/\n`); }
    } catch { /* best effort */ }
    return base;
}

export function checkoutDir(repoRoot: string, gitDir: string, id: number): string {
    if (!Number.isInteger(id) || id <= 0) throw new UserError('Invalid pull request id.');
    return path.join(checkoutBase(repoRoot, gitDir), String(id));
}

/** Fetch the pull request and check it out next to the project (see the file header). */
export async function checkoutPr(repoRoot: string, gitDir: string, o: { id: number; repository: string; sourceBranch: string }): Promise<PrCheckout> {
    const remote = remoteForRepository(await remotes(repoRoot), o.repository);
    if (!remote) throw new UserError(`This project's Git remote is not the pull request's repository (${o.repository}). Open the Studio in a clone of ${o.repository} to run its tests.`);
    if (!/^[\w./-]{1,250}$/.test(o.sourceBranch) || o.sourceBranch.includes('..')) throw new UserError('Invalid source branch.');
    const ns = `refs/cs-studio/pr/${o.id}`;
    const notes: string[] = [];
    let based: 'merge' | 'source' = 'merge';
    const merge = await git(repoRoot, ['fetch', '--no-tags', '--', remote, `+refs/pull/${o.id}/merge:${ns}/merge`], true);
    const source = await git(repoRoot, ['fetch', '--no-tags', '--', remote, `+refs/heads/${o.sourceBranch}:${ns}/source`], true);
    if (merge.code !== 0) {
        if (source.code !== 0) throw new UserError(`Could not get the pull request from ${remote}: ${(merge.stderr || source.stderr).trim().split('\n').pop()}`);
        based = 'source';
        notes.push('The pull request cannot be merged automatically (merge conflicts), so its source branch is tested as it is.');
    }
    const commit = (await git(repoRoot, ['rev-parse', '--verify', '-q', `${ns}/${based}^{commit}`])).stdout.trim();

    const dir = checkoutDir(repoRoot, gitDir, o.id);
    let reused = false;
    const isTree = fs.existsSync(path.join(dir, '.git')) && (await git(dir, ['rev-parse', '--is-inside-work-tree'], true)).stdout.trim() === 'true';
    if (isTree) {
        await git(dir, ['checkout', '--detach', '--force', commit]);
        // Leftovers of the previous version (not ignored files: reports and the node_modules link stay).
        await git(dir, ['clean', '-fd']);
        reused = true;
    } else {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        await git(repoRoot, ['worktree', 'prune']);
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        const r = await git(repoRoot, ['worktree', 'add', '--detach', '--force', dir, commit], true);
        if (r.code !== 0) throw new UserError(`Could not create the local copy of the pull request: ${r.stderr.trim().split('\n').pop()}`);
    }

    const { copiedConfig, notes: more } = await prepareCopy(repoRoot, dir);
    notes.push(...more);
    return { dir, rel: path.relative(repoRoot, dir).split(path.sep).join('/'), commit, based, remote, reused, copiedConfig, notes };
}

/**
 * Make a checkout next to the project usable for test runs: the project's installed packages linked (a junction on
 * Windows) and the local configuration that is not in Git copied over.
 */
export async function prepareCopy(repoRoot: string, dir: string): Promise<{ copiedConfig: string[]; notes: string[] }> {
    const notes: string[] = [];
    // The project's installed packages (the framework among them).
    const nm = path.join(repoRoot, 'node_modules'), link = path.join(dir, 'node_modules');
    if (fs.existsSync(nm) && !fs.existsSync(link)) {
        try { fs.symlinkSync(nm, link, process.platform === 'win32' ? 'junction' : 'dir'); }
        catch (e) { notes.push(`Could not link node_modules (${(e as Error).message}); run "npm install" in ${dir} if the tests do not start.`); }
    }
    // Local configuration that is not in Git.
    const copiedConfig: string[] = [];
    const ignored = await git(repoRoot, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', 'config'], true);
    for (const rel of ignored.stdout.split('\0').filter(Boolean).slice(0, 200)) {
        if (rel.split('/').some((s) => s === '..' || s === '.git')) continue;
        const from = path.join(repoRoot, rel), to = path.join(dir, rel);
        try {
            if (!fs.statSync(from).isFile() || fs.existsSync(to)) continue;
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.copyFileSync(from, to);
            copiedConfig.push(rel);
        } catch { /* skip */ }
    }
    if (copiedConfig.length) notes.push(`Copied local configuration that is not in Git: ${copiedConfig.join(', ')}.`);
    return { copiedConfig, notes };
}

/** Remove a checkout made with \`git worktree add\` next to the project (the node_modules link first). */
export async function removeCopy(repoRoot: string, dir: string): Promise<void> {
    // Removing the worktree must never touch the project's packages: a junction reads as a symbolic link on
    // Windows; unlinking it removes only the link.
    const link = path.join(dir, 'node_modules');
    try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); } catch { /* none */ }
    await git(repoRoot, ['worktree', 'remove', '--force', dir], true);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    await git(repoRoot, ['worktree', 'prune'], true);
}

/** The local copy of a pull request, if there is one. */
export async function existingCheckout(repoRoot: string, gitDir: string, id: number): Promise<{ dir: string; rel: string; commit: string } | null> {
    const dir = checkoutDir(repoRoot, gitDir, id);
    if (!fs.existsSync(path.join(dir, '.git'))) return null;
    const r = await git(dir, ['rev-parse', 'HEAD'], true);
    if (r.code !== 0) return null;
    return { dir, rel: path.relative(repoRoot, dir).split(path.sep).join('/'), commit: r.stdout.trim() };
}

/** Remove the local copy and its fetched refs. */
export async function removeCheckout(repoRoot: string, gitDir: string, id: number): Promise<void> {
    await removeCopy(repoRoot, checkoutDir(repoRoot, gitDir, id));
    for (const r of ['merge', 'source']) await git(repoRoot, ['update-ref', '-d', `refs/cs-studio/pr/${id}/${r}`], true);
}

/** Diff of one file between the pull request's target and the tested commit (both fetched). */
export async function prFileDiff(repoRoot: string, target: string, commit: string, file: string, originalPath?: string): Promise<string> {
    if (!/^[0-9a-f]{7,64}$/i.test(target) || !/^[0-9a-f]{7,64}$/i.test(commit)) throw new UserError('Invalid commit.');
    // A renamed file: both names, so the diff shows the rename and only the real changes.
    const paths = originalPath && originalPath !== file ? [originalPath, file] : [file];
    const r = await git(repoRoot, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M', target, commit, '--', ...paths], true);
    if (r.code !== 0) throw new UserError('Get the pull request first ("Get the PR locally"): its commits are not on this computer yet.');
    return r.stdout;
}
