/**
 * Runs the system `git` binary (approved dependency) without a shell. Arguments are passed as an
 * array, so user-supplied values (branch names, paths, messages) can never be interpreted by a shell.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface GitResult {
    code: number;
    stdout: string;
    stderr: string;
    /** Raw stdout bytes; set when `encoding: 'buffer'` was requested. */
    stdoutBuffer?: Buffer;
}

export class GitError extends Error {
    constructor(message: string, public readonly args: string[], public readonly code: number, public readonly stderr: string) {
        super(message);
        this.name = 'GitError';
    }
}

export interface RunGitOptions {
    cwd: string;
    /** Data written to git's stdin; a Buffer is written byte for byte. */
    input?: string | Buffer;
    /**
     * 'buffer' keeps stdout's raw bytes in `stdoutBuffer` (and still decodes `stdout` as UTF-8).
     * Use it whenever the bytes must round-trip unchanged, e.g. a patch that is fed back to git.
     */
    encoding?: 'utf8' | 'buffer';
    env?: Record<string, string>;
    timeoutMs?: number;
    /** Do not throw on non-zero exit; return the result instead. */
    allowFailure?: boolean;
    maxOutputBytes?: number;
}

/**
 * Absolute path of the git binary. Resolved lazily and by ourselves: on Windows the OS search
 * would look in the spawn cwd (the repository) before PATH, so a `git.exe` committed to a repository
 * would run. Only absolute PATH entries are searched; '.', empty and relative entries are skipped.
 */
export function resolveGitBinary(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
    if (env.CS_STUDIO_GIT) return env.CS_STUDIO_GIT;
    const win = platform === 'win32';
    const p = win ? path.win32 : path.posix;
    const pathVar = (win ? (env.Path ?? env.PATH ?? env.path) : env.PATH) ?? '';
    const names = win
        ? Array.from(new Set(['.exe', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter((e) => e.startsWith('.'))])).map((e) => 'git' + e)
        : ['git'];
    for (const raw of pathVar.split(win ? ';' : ':')) {
        const dir = raw.trim().replace(/^"(.*)"$/, '$1');
        if (!dir || dir === '.' || !p.isAbsolute(dir)) continue;
        for (const n of names) {
            const file = p.join(dir, n);
            try {
                const st = fs.statSync(file);
                if (st.isFile() && (win || (st.mode & 0o111) !== 0)) return file;
            } catch { /* not here */ }
        }
    }
    return 'git';
}

let gitBinCache: string | null = null;
function gitBin(): string {
    if (gitBinCache === null) gitBinCache = resolveGitBinary();
    return gitBinCache;
}
/** For tests: forget the cached git path. */
export function resetGitBinaryCache(): void { gitBinCache = null; }

const MAX_STDERR_BYTES = 1024 * 1024;

const fsmonitorCache = new Map<string, boolean>();
/** The repository asks for Git's built-in file system monitor (core.fsmonitor=true), read once per folder. */
function builtinFsmonitor(cwd: string): boolean {
    let v = fsmonitorCache.get(cwd);
    if (v === undefined) {
        try {
            const out = require('child_process').execFileSync(gitBin(), ['-c', 'core.fsmonitor=false', 'config', '--type=bool', '--get', 'core.fsmonitor'], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
            v = out === 'true' && process.platform !== 'linux';
        } catch { v = false; } // not set, or a program (not a boolean)
        fsmonitorCache.set(cwd, v);
    }
    return v;
}

export function runGit(args: string[], opts: RunGitOptions): Promise<GitResult> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const maxBytes = opts.maxOutputBytes ?? 64 * 1024 * 1024;
    return new Promise((resolve, reject) => {
        // core.fsmonitor naming a program: Git runs it on every status, and a repository folder copied from
        // someone else (with its .git/config) could set it, so it is turned off. "true" is Git's own built-in
        // monitor (Windows, macOS: much faster status on large repositories), not a program: kept.
        const child = spawn(gitBin(), ['-c', `core.fsmonitor=${builtinFsmonitor(opts.cwd) ? 'true' : 'false'}`, ...args], {
            cwd: opts.cwd,
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: '0', // never hang waiting for a password prompt
                LC_ALL: 'C', // stable, parseable messages
                ...opts.env,
            },
            windowsHide: true,
            shell: false,
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let outBytes = 0;
        let killedForSize = false;
        child.stdout.on('data', (b: Buffer) => {
            outBytes += b.length;
            if (outBytes > maxBytes) { killedForSize = true; child.kill(); return; }
            out.push(b);
        });
        let errBytes = 0;
        child.stderr.on('data', (b: Buffer) => { if (errBytes < MAX_STDERR_BYTES) { err.push(b); errBytes += b.length; } }); // keep the start (the error)
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.on('error', (e) => { clearTimeout(timer); reject(new GitError(`Could not start git: ${e.message}`, args, -1, '')); });
        child.on('close', (code) => {
            clearTimeout(timer);
            const outBuf = Buffer.concat(out);
            const res: GitResult = { code: code ?? -1, stdout: outBuf.toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
            if (opts.encoding === 'buffer') res.stdoutBuffer = outBuf;
            if (killedForSize) return reject(new GitError(`git output exceeded ${maxBytes} bytes`, args, res.code, res.stderr));
            if (res.code !== 0 && !opts.allowFailure) {
                return reject(new GitError(`git ${subcommand(args)} failed: ${res.stderr.trim() || res.stdout.trim()}`, args, res.code, res.stderr));
            }
            resolve(res);
        });
        child.stdin.on('error', () => { /* git exited before reading all input; reported via exit code */ });
        if (opts.input !== undefined) child.stdin.end(opts.input);
        else child.stdin.end();
    });
}

/** First argument that is the git subcommand (skips `-c key=value` and other global options). */
function subcommand(args: string[]): string {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-c' || args[i] === '-C') { i++; continue; }
        if (!args[i].startsWith('-')) return args[i];
    }
    return args[0] ?? '';
}
