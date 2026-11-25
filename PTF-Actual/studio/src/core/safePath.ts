/**
 * Paths inside the repository that the Studio reads or writes on the user's behalf.
 *
 * A repository is content from other people. A symbolic link committed as `config/dev.env ->
 * ~/.ssh/id_rsa` or `test/x -> C:\Windows` must not let a save or delete in the Studio reach
 * outside the project, and Windows spellings of `.git` (`.GIT`, `.git.`, `GIT~1`, `.git::$INDEX_ALLOCATION`)
 * must not reach the repository's internals.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { UserError } from './errors';

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

/** Problems with one path segment, or null. Applied on every platform (repositories are shared). */
export function segmentProblem(seg: string): string | null {
    if (/[\x00-\x1f]/.test(seg)) return 'contains control characters';
    if (seg.includes(':')) return 'contains ":"';
    if (/[. ]$/.test(seg) && seg !== '.' && seg !== '..') return 'ends with a dot or space';
    if (RESERVED.test(seg)) return 'is a reserved Windows device name';
    if (/~\d/.test(seg)) return 'looks like a Windows short name (e.g. GIT~1)';
    if (seg.toLowerCase() === '.git') return 'is inside .git';
    return null;
}

const realOrSelf = (p: string) => { try { return fs.realpathSync.native(p); } catch { return p; } };

function isInside(root: string, p: string, caseInsensitive: boolean): boolean {
    const a = caseInsensitive ? root.toLowerCase() : root;
    const b = caseInsensitive ? p.toLowerCase() : p;
    const r = path.relative(a, b);
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Absolute path for a repository-relative path, or a UserError. Checks:
 *  - stays inside the repository, also after following symbolic links (deepest existing part);
 *  - no `.git` segment in any spelling, no Windows-special names;
 *  - with `write`, the target itself is not a symbolic link (saving would write through it).
 */
export function safeRepoPath(root: string, rel: string, opts: { write?: boolean; label?: string } = {}): string {
    if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new UserError('Invalid path.');
    const abs = path.resolve(root, rel);
    if (!isInside(root, abs, false) || abs === path.resolve(root)) throw new UserError(`Path is outside the project: ${rel}`);
    for (const seg of path.relative(root, abs).split(path.sep)) {
        const p = segmentProblem(seg);
        if (p) throw new UserError(p === 'is inside .git' ? 'Files inside .git cannot be opened or changed here.' : `"${seg}" ${p}; such paths cannot be used here.`);
    }
    // Follow links on the part that exists.
    let existing = abs;
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
    const realRoot = realOrSelf(root);
    const real = realOrSelf(existing);
    if (!isInside(realRoot, real, CASE_INSENSITIVE)) throw new UserError(`${opts.label ?? rel} points outside the project (through a link), so the Studio will not use it.`);
    for (const seg of path.relative(realRoot, real).split(path.sep)) {
        if (seg.toLowerCase() === '.git') throw new UserError('Files inside .git cannot be opened or changed here.');
    }
    if (opts.write) {
        let st: fs.Stats | null = null;
        try { st = fs.lstatSync(abs); } catch { /* new file */ }
        if (st?.isSymbolicLink()) throw new UserError(`${opts.label ?? rel} is a link to another file; change that file instead.`);
    }
    return abs;
}

/** Write via a new temporary file next to the target (never follows an existing temp file). */
export function writeFileInRepo(abs: string, data: string | Buffer, opts: { exclusive?: boolean } = {}): void {
    if (opts.exclusive) { fs.writeFileSync(abs, data, { flag: 'wx' }); return; }
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomBytes(6).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, data, { flag: 'wx' });
    try { fs.renameSync(tmp, abs); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
}
