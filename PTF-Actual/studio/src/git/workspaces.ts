/**
 * Other repositories: clone one (an Azure DevOps repository with the user's own sign-in, given to Git for that one
 * command through the environment, never written into the remote or the config), and open any local repository as
 * its own Studio (another window, the same secrets and settings). Recently opened repositories are remembered in
 * the Studio's home folder (this computer only).
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { runGit } from './run';

export interface RecentRepo { path: string; name: string; openedAt: string }

const file = (home: string) => path.join(home, 'recent-repos.json');

export function recentRepos(home: string): RecentRepo[] {
    try { return (JSON.parse(fs.readFileSync(file(home), 'utf8')) as RecentRepo[]).filter((r) => fs.existsSync(r.path)).slice(0, 20); } catch { return []; }
}
export function rememberRepo(home: string, repoPath: string): RecentRepo[] {
    const list = [{ path: repoPath, name: path.basename(repoPath), openedAt: new Date().toISOString() }, ...recentRepos(home).filter((r) => path.resolve(r.path) !== path.resolve(repoPath))].slice(0, 20);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file(home), JSON.stringify(list, null, 1));
    return list;
}

/** The folder name a clone gets (the repository's name, made safe). */
export function cloneFolderName(url: string): string {
    const last = url.replace(/[?#].*$/, '').replace(/\/+$/, '').split(/[/:]/).pop() ?? 'repository';
    return decodeURIComponent(last).replace(/\.git$/, '').replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80) || 'repository';
}

/**
 * Clone into parent/name. `authHeader` (Authorization: Basic … or Bearer …) is sent only to `authHost`, through
 * GIT_CONFIG_* environment variables for this one command: nothing about it stays in the clone.
 */
export async function cloneRepo(o: { url: string; parent: string; name?: string; authHeader?: string; authHost?: string }): Promise<string> {
    let u: URL | null = null;
    try { u = new URL(o.url); } catch { /* scp-like ssh address */ }
    if (u && !/^(https?|ssh|git|file):$/.test(u.protocol)) throw new Error('Clone from an https:// or ssh address.');
    if (o.url.startsWith('-')) throw new Error('Not a repository address.');
    const parent = path.resolve(o.parent);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new Error(`${o.parent} is not a folder.`);
    const name = (o.name ?? cloneFolderName(o.url)).trim();
    if (!/^[\w.-]{1,80}$/.test(name) || name.startsWith('.')) throw new Error('The folder name uses letters, digits, . - _');
    const dest = path.join(parent, name);
    if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error(`${dest} already exists and is not empty.`);
    const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
    if (o.authHeader && o.authHost && u && u.protocol === 'https:' && u.hostname.toLowerCase() === o.authHost.toLowerCase()) {
        env.GIT_CONFIG_COUNT = '1';
        env.GIT_CONFIG_KEY_0 = `http.${u.origin}/.extraHeader`;
        env.GIT_CONFIG_VALUE_0 = `Authorization: ${o.authHeader}`;
    }
    const r = await runGit(['clone', '--', o.url, dest], { cwd: parent, env, allowFailure: true, timeoutMs: 30 * 60_000 });
    if (r.code !== 0) {
        try { if (fs.existsSync(dest) && !fs.readdirSync(dest).length) fs.rmdirSync(dest); } catch { /* leave it */ }
        throw new Error(`git clone failed: ${r.stderr.trim().split('\n').filter((l) => !/^Cloning into/.test(l)).slice(-3).join(' ') || `exit ${r.code}`}`);
    }
    return dest;
}

/** The top folder of the Git repository a folder is in (or an error saying it is none). */
export async function repoTop(dir: string): Promise<string> {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder.`);
    const r = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir, allowFailure: true });
    if (r.code !== 0) throw new Error(`${dir} is not inside a Git repository.`);
    return path.resolve(r.stdout.trim());
}

/** Start another Studio for a repository; resolves with its address once it says where it listens. */
export function openStudio(o: { cli: string; repo: string; trustRepoConfig?: boolean; timeoutMs?: number; execArgv?: string[] }): Promise<{ url: string; pid: number }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [...(o.execArgv ?? []), o.cli, 'start', '--repo', o.repo, '--port', '0', '--no-open', ...(o.trustRepoConfig ? ['--trust-repo-config'] : [])],
            { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env, windowsHide: true });
        let out = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('The other Studio did not start in time.')); }, o.timeoutMs ?? 30_000);
        const onData = (b: Buffer) => {
            out += b.toString();
            const m = /Open: (\S+)/.exec(out);
            if (m) { clearTimeout(timer); child.stdout?.removeAllListeners('data'); child.unref(); resolve({ url: m[1], pid: child.pid ?? 0 }); }
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', (b: Buffer) => { out += b.toString(); });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(out.trim().split('\n').slice(-3).join(' ') || `The other Studio stopped (exit ${code}).`)); });
    });
}
