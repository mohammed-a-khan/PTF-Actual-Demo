/**
 * The agents' runtime (the GitHub Copilot SDK and its Copilot runtime, ~200 MB per platform), installed
 * by the Studio into its own folder on this computer, once for all repositories: projects, their
 * package.json, lock files and pipelines stay as they are.
 *  - npm does the install, with this computer's npm settings (company registry, sign-in) and the
 *    repository's .npmrc when it has one, through the Studio's network settings (proxy, certificates).
 *  - The version the Studio was tested with by default; the team policy can pin another; "latest" on request.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';

export const SDK_PACKAGE = '@github/copilot-sdk';
/** The version this Studio was built and tested with. */
export const SDK_TESTED_VERSION = '1.0.34';

export interface InstallState {
    running: boolean;
    /** What is being installed (package@version). */
    target?: string;
    startedAt?: number;
    finishedAt?: number;
    ok?: boolean;
    error?: string;
    /** npm's output (last lines). */
    log: string[];
}

const VERSION = /^(latest|\d+\.\d+\.\d+(-[\w.]+)?)$/;

export class RuntimeInstaller {
    private st: InstallState = { running: false, log: [] };
    private child: ChildProcess | null = null;

    constructor(private readonly dir: string, private readonly npm: { command: string; prefixArgs: string[] } = npmCommand()) {}

    /** The folder npm installs into (its node_modules holds the SDK). */
    get folder() { return this.dir; }

    state(): InstallState { return { ...this.st, log: this.st.log.slice(-60) }; }

    /** Install (or update to) a version; resolves when npm has started. */
    install(version: string, o: { env?: Record<string, string>; repoRoot?: string; timeoutMs?: number } = {}) {
        if (this.st.running) throw new Error('The agents runtime is already being installed.');
        if (!VERSION.test(version)) throw new Error('Version: latest or x.y.z.');
        fs.mkdirSync(this.dir, { recursive: true });
        const pkg = path.join(this.dir, 'package.json');
        if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, `${JSON.stringify({ name: 'cs-studio-agents-runtime', private: true, description: 'Installed by CS Test Studio for its agents.' }, null, 2)}\n`);
        // The repository's npm settings (company registry and its sign-in) apply here too.
        const repoNpmrc = o.repoRoot ? path.join(o.repoRoot, '.npmrc') : '';
        if (repoNpmrc && fs.existsSync(repoNpmrc)) fs.copyFileSync(repoNpmrc, path.join(this.dir, '.npmrc'));
        // The lock file of an earlier install would keep packages this computer does not need.
        fs.rmSync(path.join(this.dir, 'package-lock.json'), { force: true });
        const target = `${SDK_PACKAGE}@${version}`;
        this.st = { running: true, target, startedAt: Date.now(), log: [`npm install ${target}`] };
        // On Linux, npm cannot tell glibc from musl and would fetch both (~200 MB each): name this computer's.
        const libc = linuxLibc();
        const args = [...this.npm.prefixArgs, 'install', target, '--save-exact', '--no-audit', '--no-fund', ...(libc ? [`--libc=${libc}`] : []), '--prefix', this.dir];
        const child = spawn(this.npm.command, args, { cwd: this.dir, env: { ...process.env, ...(o.env ?? {}) } as NodeJS.ProcessEnv, windowsHide: true, shell: false });
        this.child = child;
        const add = (b: Buffer) => { for (const l of b.toString().split(/\r?\n/)) if (l.trim()) this.st.log.push(l.slice(0, 400)); if (this.st.log.length > 400) this.st.log.splice(0, this.st.log.length - 400); };
        child.stdout?.on('data', add);
        child.stderr?.on('data', add);
        const timer = setTimeout(() => { this.st.log.push('Stopped: npm took too long.'); child.kill(); }, o.timeoutMs ?? 20 * 60_000);
        const done = (ok: boolean, error?: string) => {
            clearTimeout(timer);
            if (!this.st.running) return;
            this.child = null;
            this.st = { ...this.st, running: false, finishedAt: Date.now(), ok, ...(error ? { error } : {}) };
        };
        child.on('error', (e) => done(false, `npm could not start: ${e.message}`));
        child.on('close', (code) => {
            if (code !== 0) return done(false, npmProblem(this.st.log) ?? `npm stopped with code ${code}.`);
            const removed = pruneOtherPlatforms(this.dir);
            if (removed.length) this.st.log.push(`Removed packages for other computers: ${removed.join(', ')}`);
            done(installedVersion(this.dir) ? true : false, installedVersion(this.dir) ? undefined : 'npm finished but the SDK is not in the folder.');
        });
    }

    cancel() { this.child?.kill(); }

    /** Remove the Studio's runtime (the repository's own, if any, is not touched). */
    remove() {
        if (this.st.running) throw new Error('Wait for the install to finish.');
        fs.rmSync(this.dir, { recursive: true, force: true });
        this.st = { running: false, log: [] };
    }
}

/** The SDK version installed in a runtime folder (null when none). */
export function installedVersion(dir: string): string | null {
    try { return (JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', '@github', 'copilot-sdk', 'package.json'), 'utf8')) as { version: string }).version; }
    catch { return null; }
}

/**
 * The runtime's platform packages (@github/copilot-sdk-<platform>) declare the system they are for
 * (os, cpu, libc): those for another system are removed (npm keeps ones an earlier install fetched).
 */
export function pruneOtherPlatforms(dir: string, sys = { os: process.platform as string, cpu: process.arch as string, libc: linuxLibc() as string | null }): string[] {
    const gh = path.join(dir, 'node_modules', '@github');
    const removed: string[] = [];
    let names: string[] = [];
    try { names = fs.readdirSync(gh).filter((n) => /^copilot-sdk-/.test(n)); } catch { return removed; }
    const fits = (list: unknown, v: string | null) => !Array.isArray(list) || !list.length || v === null || list.includes(v);
    for (const n of names) {
        try {
            const j = JSON.parse(fs.readFileSync(path.join(gh, n, 'package.json'), 'utf8')) as { os?: string[]; cpu?: string[]; libc?: string[] };
            if (!fits(j.os, sys.os) || !fits(j.cpu, sys.cpu) || !fits(j.libc, sys.libc)) { fs.rmSync(path.join(gh, n), { recursive: true, force: true }); removed.push(`@github/${n}`); }
        } catch { /* leave it */ }
    }
    return removed;
}

/** glibc or musl on Linux (null elsewhere, or when unknown). */
export function linuxLibc(): 'glibc' | 'musl' | null {
    if (process.platform !== 'linux') return null;
    try {
        const h = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
        if (h?.glibcVersionRuntime) return 'glibc';
        return fs.existsSync('/etc/alpine-release') ? 'musl' : null;
    } catch { return null; }
}

/** npm: the one next to this Node (npm-cli.js), else the one on the PATH. */
export function npmCommand(): { command: string; prefixArgs: string[] } {
    const base = path.dirname(process.execPath);
    for (const cli of [path.join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(base, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
        if (fs.existsSync(cli)) return { command: process.execPath, prefixArgs: [cli] };
    }
    return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefixArgs: [] };
}

/** The reason in npm's output, in words people can act on. */
export function npmProblem(log: string[]): string | null {
    const t = log.join('\n');
    if (/E401|E403|Unable to authenticate|authentication token/i.test(t)) return 'The npm registry refused the request: sign in to your company registry (npm login) or ask for access to @github/copilot-sdk.';
    if (/E404|404 Not Found/i.test(t)) return 'The npm registry does not have @github/copilot-sdk (or this version): ask for it to be added to the company registry.';
    if (/SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT|certificate/i.test(t)) return 'The company certificate is not trusted by npm: set it in Settings → Network (certificates).';
    if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|proxy/i.test(t)) return 'npm could not reach the registry: check the proxy in Settings → Network.';
    if (/ENOSPC/i.test(t)) return 'Not enough disk space (the runtime needs about 250 MB).';
    if (/EACCES|EPERM/i.test(t)) return 'No permission to write the Studio\'s folder.';
    const err = log.filter((l) => /npm (ERR!|error)/.test(l)).slice(0, 3).join(' ');
    return err ? err.replace(/npm (ERR!|error)\s*/g, '').slice(0, 300) : null;
}
