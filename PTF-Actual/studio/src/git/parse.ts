/**
 * Parsers for git's machine-readable output formats.
 */
import { ScanLine } from '../scanner/types';

export interface FileStatus {
    path: string;
    /** Original path for renames/copies. */
    origPath?: string;
    /** Index (staged) state: M A D R C T U or '.' */
    staged: string;
    /** Worktree (unstaged) state: M A D R C T U or '.' */
    unstaged: string;
    untracked: boolean;
    conflicted: boolean;
}

export interface RepoStatus {
    branch: string | null; // null = detached HEAD
    head: string | null; // commit sha, null in a repo with no commits
    upstream: string | null;
    ahead: number;
    behind: number;
    /** The branch has an upstream configured but that remote branch no longer exists. */
    upstreamGone: boolean;
    files: FileStatus[];
    hasConflicts: boolean;
}

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatusV2(out: string): RepoStatus {
    const st: RepoStatus = { branch: null, head: null, upstream: null, ahead: 0, behind: 0, upstreamGone: false, files: [], hasConflicts: false };
    let sawAb = false;
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
        const rec = parts[i];
        if (!rec) continue;
        if (rec.startsWith('# ')) {
            const [, key, ...rest] = rec.split(' ');
            const val = rest.join(' ');
            if (key === 'branch.oid') st.head = val === '(initial)' ? null : val;
            else if (key === 'branch.head') st.branch = val === '(detached)' ? null : val;
            else if (key === 'branch.upstream') st.upstream = val;
            else if (key === 'branch.ab') {
                sawAb = true;
                const m = /\+(\d+) -(\d+)/.exec(val);
                if (m) { st.ahead = Number(m[1]); st.behind = Number(m[2]); }
            }
            continue;
        }
        const type = rec[0];
        if (type === '1') {
            // 1 XY sub mH mI mW hH hI path
            const f = rec.split(' ');
            st.files.push(entry(f.slice(8).join(' '), f[1]));
        } else if (type === '2') {
            // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
            const f = rec.split(' ');
            const e = entry(f.slice(9).join(' '), f[1]);
            e.origPath = parts[++i];
            st.files.push(e);
        } else if (type === 'u') {
            // u XY sub m1 m2 m3 mW h1 h2 h3 path
            const f = rec.split(' ');
            const e = entry(f.slice(10).join(' '), f[1]);
            e.conflicted = true;
            st.hasConflicts = true;
            st.files.push(e);
        } else if (type === '?') {
            st.files.push({ path: rec.slice(2), staged: '.', unstaged: '?', untracked: true, conflicted: false });
        }
    }
    // git omits branch.ab when the configured upstream ref does not exist (deleted on the remote).
    st.upstreamGone = st.upstream !== null && !sawAb;
    return st;
}

function entry(path: string, xy: string): FileStatus {
    return { path, staged: xy[0], unstaged: xy[1], untracked: false, conflicted: false };
}

export interface DiffFile {
    path: string;
    /** True when git reports the file as binary. */
    binary: boolean;
    deleted: boolean;
    added: ScanLine[];
}

/**
 * Parse a unified diff (`git diff --cached -U0 --no-color --no-ext-diff` or `git show -U0`) and
 * return only the ADDED lines with their new-file line numbers. Removed lines are irrelevant for
 * secret scanning: removing a secret is always fine.
 *
 * A line removed and added again with the same text in the same file is not new: it only moved, or
 * Git re-wrote it because a newline was added at the end of the file ("\ No newline at end of
 * file"). Such lines are already in the repository, so they are not reported again.
 *
 * Header lines (---, +++, Binary files, mode lines) are only recognised BEFORE the first hunk of a
 * file section: inside a hunk an added line whose text starts with "++" looks exactly like "+++".
 * Combined diffs (`diff --cc` / `diff --combined`, `@@@` hunks) are understood too.
 */
export function parseAddedLines(diff: string): DiffFile[] {
    const files: DiffFile[] = [];
    let cur: DiffFile | null = null;
    let newLine = 0;
    let inHunk = false;
    let combined = false;
    /** Number of parent columns in the current hunk (1 for a normal diff). */
    let cols = 1;
    let minusPath = '';
    const lines = diff.split('\n');
    const removed = new Map<DiffFile, Map<string, number>>();
    for (const raw of lines) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
            cur = { path: '', binary: false, deleted: false, added: [] };
            files.push(cur);
            inHunk = false;
            minusPath = '';
            combined = !line.startsWith('diff --git ');
            cur.path = combined ? headerPath(line.replace(/^diff --(?:cc|combined) /, '')) : gitHeaderPath(line.slice('diff --git '.length));
            continue;
        }
        if (!cur) continue;
        if (!inHunk) {
            if (line.startsWith('+++ ')) {
                const p = headerPath(line.slice(4));
                if (p !== '/dev/null') cur.path = stripPrefix(p, 'b/');
                else if (minusPath) cur.path = minusPath;
                continue;
            }
            if (line.startsWith('--- ')) {
                const p = headerPath(line.slice(4));
                if (p !== '/dev/null') minusPath = stripPrefix(p, 'a/');
                continue;
            }
            if (line.startsWith('deleted file mode')) { cur.deleted = true; continue; }
            if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) { cur.binary = true; continue; }
        }
        if (line.startsWith('@@')) {
            const m = /^(@@+) (?:-\d+(?:,\d+)? )+\+(\d+)(?:,(\d+))? @@+/.exec(line);
            if (m) {
                cols = m[1].length - 1;
                newLine = Number(m[2]);
                inHunk = true;
                continue;
            }
        }
        if (!inHunk) continue;
        if (cols <= 1) {
            if (line.startsWith('+')) {
                cur.added.push({ file: cur.path, line: newLine, text: line.slice(1) });
                newLine++;
            } else if (line.startsWith(' ')) {
                newLine++;
            } else if (line.startsWith('-')) {
                const m = removed.get(cur) ?? new Map<string, number>();
                m.set(line.slice(1), (m.get(line.slice(1)) ?? 0) + 1);
                removed.set(cur, m);
            }
            // '-' lines and '\ No newline' do not advance the new-file counter.
        } else {
            // Combined diff: one marker column per parent. A line is in the result unless some
            // column says '-'; it is new (vs. at least one parent) when some column says '+'.
            const marks = line.slice(0, cols);
            if (marks.length < cols || marks.startsWith('\\')) continue;
            if (marks.includes('-')) continue;
            if (marks.includes('+')) cur.added.push({ file: cur.path, line: newLine, text: line.slice(cols) });
            newLine++;
        }
    }
    for (const f of files) {
        const gone = removed.get(f);
        if (gone) f.added = f.added.filter((a) => { const n = gone.get(a.text) ?? 0; if (!n) return true; gone.set(a.text, n - 1); return false; });
        for (const a of f.added) a.file = f.path;
    }
    return files;
}

/** A path from a ---/+++/diff --cc line: drop the trailing TAB git adds to names with spaces, then unquote. */
function headerPath(p: string): string {
    return unquote(p.replace(/\t$/, ''));
}

function stripPrefix(p: string, prefix: string): string {
    return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/** The new path from `diff --git a/x b/x` (quoted forms included); a fallback until "+++" is seen. */
function gitHeaderPath(rest: string): string {
    // Quoted new path at the end: ... "b/name"
    const q = /"((?:[^"\\]|\\.)*)"$/.exec(rest);
    if (q && rest.length > q[0].length) return stripPrefix(unquote(q[0]), 'b/');
    // Unquoted: both sides have the same name in the common (non-rename) case: a/X b/X
    const n = rest.length;
    if (n % 2 === 1) {
        const half = (n - 1) / 2;
        const a = rest.slice(0, half), b = rest.slice(half + 1);
        if (a.startsWith('a/') && b.startsWith('b/') && a.slice(2) === b.slice(2)) return b.slice(2);
    }
    const m = /^(?:"(?:[^"\\]|\\.)*"|a\/.*?) b\/(.*)$/.exec(rest);
    return m ? m[1] : '';
}

/** Unquote git's C-style quoted paths ("a\tb", octal UTF-8 bytes etc.). */
export function unquote(p: string): string {
    if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
    const body = p.slice(1, -1);
    const bytes: number[] = [];
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c !== '\\') {
            const cp = body.codePointAt(i)!;
            const ch = String.fromCodePoint(cp);
            bytes.push(...Buffer.from(ch, 'utf8'));
            i += ch.length - 1;
            continue;
        }
        const n = body[++i];
        if (n >= '0' && n <= '7') {
            const oct = /^[0-7]{1,3}/.exec(body.slice(i))![0];
            bytes.push(parseInt(oct, 8));
            i += oct.length - 1;
        } else {
            const map: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
            bytes.push(map[n] ?? n.charCodeAt(0));
        }
    }
    return Buffer.from(bytes).toString('utf8');
}

export interface LogEntry {
    sha: string;
    authorName: string;
    authorEmail: string;
    date: string;
    subject: string;
}

export const LOG_FORMAT = '%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e';

export function parseLog(out: string): LogEntry[] {
    return out.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
        const [sha, authorName, authorEmail, date, subject] = r.split('\x1f');
        return { sha, authorName, authorEmail, date, subject };
    });
}
