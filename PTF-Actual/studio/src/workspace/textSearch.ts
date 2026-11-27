/**
 * Text search and replace across files, shared by the server (Search in the Code screen) and the
 * screen itself (replacing in open editor tabs, results for unsaved tabs). The same matcher on both
 * sides, so what the search finds is exactly what Replace changes.
 *
 * Matching is per line (as the results are shown): `^` and `$` are a line's start and end, and a
 * line's "\r" (Windows line endings) is never part of a match and is kept as it is.
 * Paths are repository-relative with "/" (backslashes and a Windows drive letter's case are accepted
 * in what a person types: folders and globs).
 */

export interface TextQuery { q: string; regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean }
export interface LineMatch { line: number; column: number; length: number; text: string }

/** Folders left out unless "Include ignored files" is on: build output, dependencies, run results. */
export const EXCLUDED_DIRS = ['.debug-build', 'dist', 'node_modules', 'reports', 'test-results', 'playwright-report', 'coverage', '.git'];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The regular expression for a query (always global; `i` unless case-sensitive). Throws a readable message on an invalid regex. */
export function matcher(o: TextQuery): RegExp {
    let src = o.regex ? o.q : escapeRe(o.q);
    if (o.wholeWord) src = `(?<![\\w$])(?:${src})(?![\\w$])`;
    try { return new RegExp(src, o.caseSensitive ? 'g' : 'gi'); }
    catch (e) { throw new Error(`Not a valid regular expression: ${(e as Error).message.replace(/^Invalid regular expression: \/.*\/[a-z]*: /, '')}. Turn off .* to search for the text as written.`); }
}

/** Each match of a line (empty matches are skipped: they would replace nothing visible). */
function* lineMatches(line: string, re: RegExp): Generator<RegExpExecArray> {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
        if (m[0].length === 0) { re.lastIndex = m.index + 1; if (re.lastIndex > line.length) break; continue; }
        yield m;
    }
}

const splitLines = (text: string) => text.split('\n').map((l) => (l.endsWith('\r') ? { body: l.slice(0, -1), cr: '\r' } : { body: l, cr: '' }));

/** The matches in a text: line and column (1-based), the match length and the line (trimmed to 400 characters). */
export function matchesIn(text: string, re: RegExp, limit = Infinity): LineMatch[] {
    const out: LineMatch[] = [];
    const lines = splitLines(text);
    for (let i = 0; i < lines.length && out.length < limit; i++) {
        const l = lines[i].body;
        if (l.length > 20000) continue; // minified code: one line of a bundle is not a useful result
        for (const m of lineMatches(l, re)) {
            out.push({ line: i + 1, column: m.index + 1, length: m[0].length, text: l.slice(0, 400) });
            if (out.length >= limit) break;
        }
    }
    return out;
}

/** How many matches a text has. */
export function countIn(text: string, re: RegExp): number { return matchesIn(text, re).length; }

/**
 * The replacement for one match: with a regex, `$1`…`$99`, `$<name>`, `$&` (the match) and `$$`
 * (a dollar sign), as in JavaScript; without, the text exactly as typed.
 */
export function expandReplacement(m: RegExpExecArray, replacement: string, regex: boolean): string {
    if (!regex) return replacement;
    return replacement.replace(/\$(\$|&|<([^>]*)>|(\d{1,2}))/g, (all, what: string, name: string | undefined, num: string | undefined) => {
        if (what === '$') return '$';
        if (what === '&') return m[0];
        if (name !== undefined) return m.groups?.[name] ?? '';
        if (num !== undefined) {
            const n = Number(num);
            if (n >= 1 && n < m.length) return m[n] ?? '';
            // "$12" with one group: group 1, then "2".
            if (num.length === 2 && Number(num[0]) >= 1 && Number(num[0]) < m.length) return (m[Number(num[0])] ?? '') + num[1];
        }
        return all;
    });
}

/**
 * Replace the matches of a query in a text. `only`: just the match starting there (line and column,
 * 1-based), e.g. one search result. Returns the new text and how many matches were replaced.
 */
export function replaceIn(text: string, o: TextQuery, replacement: string, only?: { line: number; column: number }): { text: string; count: number } {
    const re = matcher(o);
    let count = 0;
    const lines = splitLines(text);
    const out = lines.map((l, i) => {
        if (only && only.line !== i + 1) return l.body + l.cr;
        if (l.body.length > 20000) return l.body + l.cr;
        let res = '', last = 0;
        for (const m of lineMatches(l.body, re)) {
            if (only && m.index + 1 !== only.column) continue;
            res += l.body.slice(last, m.index) + expandReplacement(m, replacement, !!o.regex);
            last = m.index + m[0].length;
            count++;
        }
        return res + l.body.slice(last) + l.cr;
    });
    return { text: count ? out.join('\n') : text, count };
}

/** A path as the repository writes it: "/" separators, no leading "./" or "/", no trailing "/". */
export function normalizeRel(p: string): string {
    return p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
}

/** Is the file inside one of the folders left out by default (at any depth)? */
export function isExcluded(rel: string): boolean {
    const parts = normalizeRel(rel).split('/');
    parts.pop();
    return parts.some((p) => EXCLUDED_DIRS.includes(p));
}

/**
 * "Only in" patterns: comma-separated globs (`*`, `**`, `?`). A pattern without "/" matches the
 * file name at any depth (like `*.feature`); one ending in "/" is a folder; "!" in front leaves files out.
 */
export function globFilter(glob: string | undefined): (rel: string) => boolean {
    const pats = (glob ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!pats.length) return () => true;
    const toRe = (p: string) => {
        let s = normalizeRel(p.replace(/\\/g, '/')) + (/[\\/]$/.test(p) ? '/**' : '');
        const anyDepth = !s.includes('/');
        let re = '';
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (c === '*' && s[i + 1] === '*') { re += s[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += s[i + 2] === '/' ? 2 : 1; }
            else if (c === '*') re += '[^/]*';
            else if (c === '?') re += '[^/]';
            else re += escapeRe(c);
        }
        // A plain folder name ("test/weblab") also means everything inside it.
        if (!/[*?]/.test(s) && s) re += '(?:/.*)?';
        s = re;
        return new RegExp(anyDepth ? `(?:^|/)${s}$` : `^${s}$`, 'i');
    };
    const inc = pats.filter((p) => !p.startsWith('!')).map(toRe);
    const exc = pats.filter((p) => p.startsWith('!')).map((p) => toRe(p.slice(1)));
    return (rel) => (!inc.length || inc.some((r) => r.test(rel))) && !exc.some((r) => r.test(rel));
}

/** Is a file in the scope chosen: the whole project, a folder, or one file? */
export function inScope(rel: string, scope: { folder?: string; file?: string }): boolean {
    const r = normalizeRel(rel);
    if (scope.file) return r === normalizeRel(scope.file);
    if (scope.folder) { const f = normalizeRel(scope.folder); return !f || r.startsWith(f + '/'); }
    return true;
}
