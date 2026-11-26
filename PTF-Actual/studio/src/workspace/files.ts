/**
 * Workspace files for the editor: list (respecting .gitignore), read, save with "changed on disk"
 * protection, create, rename, delete (a copy is kept), and search across files.
 * Every path is repository-relative and checked to stay inside the repository.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { runGit } from '../git/run';
import { UserError } from '../core/errors';
import { safeRepoPath, writeFileInRepo } from '../core/safePath';
import { nameProblem } from './newName';

export const MAX_EDIT_BYTES = 5 * 1024 * 1024;

export interface FileContent { path: string; content: string; hash: string; size: number; eol: '\n' | '\r\n'; binary: false }
export interface BinaryFile { path: string; size: number; binary: true; hash: string }

export const hashOf = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export class Workspace {
    constructor(public readonly root: string) {}

    /** Absolute path for a repo-relative path; refuses anything outside the repo or inside .git. */
    abs(rel: string, write = false): string {
        return safeRepoPath(this.root, rel, { write });
    }

    /**
     * A path about to be created: each part that does not exist yet must be a name every platform can hold
     * (see newName.ts); parts that already exist are left as they are.
     */
    private checkNew(rel: string): void {
        const parts = rel.replace(/^\/+/, '').split('/');
        for (let i = 0; i < parts.length; i++) {
            if (fs.existsSync(path.join(this.root, ...parts.slice(0, i + 1)))) continue;
            const why = nameProblem(parts[i]);
            if (why) throw new UserError(why);
        }
    }

    rel(abs: string): string { return path.relative(this.root, abs).split(path.sep).join('/'); }

    /** All files Git would consider (tracked + untracked, minus ignored), sorted. */
    async list(): Promise<string[]> {
        const r = await runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate'], { cwd: this.root });
        const files = r.stdout.split('\0').filter(Boolean).filter((f) => fs.existsSync(path.join(this.root, f)));
        // Empty folders the user created are not files; include them so they show in the tree.
        return [...new Set(files)].sort((a, b) => a.localeCompare(b));
    }

    read(rel: string): FileContent | BinaryFile {
        const a = this.abs(rel);
        const st = fs.statSync(a);
        if (!st.isFile()) throw new UserError(`${rel} is not a file.`);
        if (st.size > MAX_EDIT_BYTES) throw new UserError(`${rel} is larger than 5 MB and cannot be opened in the editor.`);
        const buf = fs.readFileSync(a);
        const hash = hashOf(buf);
        if (buf.subarray(0, 8000).includes(0)) return { path: rel, size: st.size, binary: true, hash };
        const content = buf.toString('utf8');
        return { path: rel, content, hash, size: st.size, eol: content.includes('\r\n') ? '\r\n' : '\n', binary: false };
    }

    /**
     * Save. `expectedHash` is the hash the editor loaded; if the file changed on disk since (another
     * editor, git pull), the save is refused instead of silently overwriting that change.
     */
    write(rel: string, content: string, expectedHash: string | null): { hash: string } {
        const a = this.abs(rel, true);
        if (Buffer.byteLength(content) > MAX_EDIT_BYTES) throw new UserError('The file is too large to save from the editor (5 MB).');
        if (expectedHash !== null) {
            const now = fs.existsSync(a) ? hashOf(fs.readFileSync(a)) : null;
            if (now === null) throw new ConflictError(`${rel} was deleted outside the editor since you opened it.`, true);
            if (now !== expectedHash) throw new ConflictError(`${rel} was changed outside the editor since you opened it.`);
        } else if (fs.existsSync(a)) {
            throw new ConflictError(`${rel} already exists.`);
        } else this.checkNew(rel);
        fs.mkdirSync(path.dirname(a), { recursive: true });
        writeFileInRepo(a, content);
        return { hash: hashOf(Buffer.from(content, 'utf8')) };
    }

    createFolder(rel: string): void {
        const a = this.abs(rel, true);
        if (fs.existsSync(a)) throw new UserError(`${rel} already exists.`);
        this.checkNew(rel);
        fs.mkdirSync(a, { recursive: true });
    }

    rename(from: string, to: string): void {
        const a = this.abs(from, true), b = this.abs(to, true);
        if (!fs.existsSync(a)) throw new UserError(`${from} does not exist.`);
        if (fs.existsSync(b) && a.toLowerCase() !== b.toLowerCase()) throw new UserError(`${to} already exists.`);
        if (a !== b) this.checkNew(to);
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.renameSync(a, b);
    }

    /** Copy a file (Duplicate in the file tree): same path rules as rename; never overwrites. */
    copy(from: string, to: string): void {
        const a = this.abs(from, true), b = this.abs(to, true);
        if (!fs.existsSync(a)) throw new UserError(`${from} does not exist.`);
        if (!fs.statSync(a).isFile()) throw new UserError(`${from} is not a file: only files can be duplicated.`);
        if (fs.existsSync(b)) throw new UserError(`${to} already exists.`);
        this.checkNew(to);
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL);
    }

    /** Delete a file or folder; a copy goes to .git/cs-studio/recovery/<time>/ first. */
    async remove(rel: string): Promise<{ recoveryDir: string }> {
        const a = this.abs(rel, true);
        if (!fs.existsSync(a)) throw new UserError(`${rel} does not exist.`);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const gp = (await runGit(['rev-parse', '--git-path', `cs-studio/recovery/${stamp}`], { cwd: this.root })).stdout.trim();
        const recoveryDir = path.resolve(this.root, gp);
        const dest = path.join(recoveryDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(a, dest, { recursive: true });
        fs.rmSync(a, { recursive: true, force: true });
        return { recoveryDir };
    }

    /** Search file contents (git grep: fast, respects .gitignore, includes new files). */
    async search(query: string, opts: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; glob?: string; limit?: number } = {}): Promise<SearchHit[]> {
        if (!query) return [];
        const args = ['grep', '-n', '--column', '-I', '--no-color', '--untracked', '--full-name'];
        if (!opts.caseSensitive) args.push('-i');
        if (opts.wholeWord) args.push('-w');
        args.push(opts.regex ? '-E' : '-F', '-e', query);
        if (opts.glob) args.push('--', opts.glob);
        const r = await runGit(args, { cwd: this.root, allowFailure: true, maxOutputBytes: 32 * 1024 * 1024 });
        if (r.code > 1) throw new UserError(r.stderr.trim() || 'Search failed.');
        const hits: SearchHit[] = [];
        const limit = opts.limit ?? 2000;
        for (const line of r.stdout.split('\n')) {
            const m = /^(.+?):(\d+):(\d+):(.*)$/.exec(line);
            if (!m) continue;
            hits.push({ path: m[1], line: Number(m[2]), column: Number(m[3]), text: m[4].slice(0, 400) });
            if (hits.length >= limit) break;
        }
        return hits;
    }
}

export interface SearchHit { path: string; line: number; column: number; text: string }

export class ConflictError extends UserError {
    readonly conflict = true;
    /** The file no longer exists on disk (as opposed to: changed). */
    constructor(message: string, readonly deleted = false) { super(message); }
}
