/**
 * The Code screen's Search (and Usages) lists: results grouped by file, the open tabs with unsaved
 * edits searched here (the server reads the files on disk), and what a replacement would make of a line.
 * The matching is the server's own (src/workspace/textSearch.ts), so Replace changes what Search found.
 */
import { globFilter, inScope, isExcluded, matcher, matchesIn, replaceIn, TextQuery } from '../../src/workspace/textSearch';
import type { SearchHit, TextSearchResult } from './api';

export type SearchScope = 'project' | 'folder' | 'file';
export interface SearchState {
    q: string; regex: boolean; case: boolean; word: boolean; glob: string;
    replace: string; showReplace: boolean;
    scope: SearchScope; folder: string; ignored: boolean;
}
export const NEW_SEARCH: SearchState = { q: '', regex: false, case: false, word: false, glob: '', replace: '', showReplace: false, scope: 'project', folder: '', ignored: false };

export const queryOf = (s: Pick<SearchState, 'q' | 'regex' | 'case' | 'word'>): TextQuery => ({ q: s.q, regex: s.regex, caseSensitive: s.case, wholeWord: s.word });

/** Items grouped by file, in the order the files first appear. */
export function groupByFile<T extends { path: string }>(items: T[]): Array<{ path: string; items: T[] }> {
    const m = new Map<string, T[]>();
    for (const it of items) { const l = m.get(it.path); if (l) l.push(it); else m.set(it.path, [it]); }
    return [...m.entries()].map(([path, list]) => ({ path, items: list }));
}

/** Would the search look at this file (scope, "Only in", ignored folders)? For open tabs searched here. */
export function searchesFile(path: string, s: SearchState, activeFile: string | null): boolean {
    if (s.scope === 'file') return !!activeFile && path === activeFile;
    if (!s.ignored && isExcluded(path)) return false;
    if (s.scope === 'folder' && !inScope(path, { folder: s.folder })) return false;
    return globFilter(s.glob)(path);
}

/**
 * The server's results with the open tabs that have unsaved edits searched in the editor's text instead
 * (what the person sees, and what Replace will change there).
 */
export function withOpenTabs(r: TextSearchResult, s: SearchState, tabs: Array<{ path: string; content: string; dirty: boolean }>, activeFile: string | null, limit = 2000): TextSearchResult {
    const open = tabs.filter((t) => t.dirty && searchesFile(t.path, s, activeFile));
    if (!open.length) return r;
    const re = matcher(queryOf(s));
    const paths = new Set(open.map((t) => t.path));
    const files = r.files.filter((f) => !paths.has(f.path));
    let hits: SearchHit[] = r.hits.filter((h) => !paths.has(h.path));
    for (const t of open) {
        const found = matchesIn(t.content, re);
        if (!found.length) continue;
        files.push({ path: t.path, count: found.length });
        hits = hits.concat(found.map((m) => ({ path: t.path, line: m.line, column: m.column, length: m.length, text: m.text })));
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const order = new Map(files.map((f, i) => [f.path, i]));
    hits.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0) || a.line - b.line || a.column - b.column);
    const total = files.reduce((n, f) => n + f.count, 0);
    return { ...r, files, total, hits: hits.slice(0, limit), limited: r.limited || hits.length > limit };
}

/** A result line split around its match, and what the match becomes with the replacement. */
export function previewLine(h: SearchHit, s: SearchState): { before: string; match: string; after: string; replaced?: string } {
    const len = h.length ?? 0;
    const i = h.column - 1;
    const before = h.text.slice(0, i), match = h.text.slice(i, i + len), after = h.text.slice(i + len);
    if (!s.showReplace) return { before, match, after };
    let replaced = s.replace;
    try {
        const r = replaceIn(h.text, queryOf(s), s.replace, { line: 1, column: h.column });
        if (r.count) replaced = r.text.slice(i, r.text.length - after.length);
    } catch { /* invalid regex: shown as typed */ }
    return { before, match, after, replaced };
}

/** "12 matches in 3 files" */
export const countText = (matches: number, files: number) => `${matches} match${matches === 1 ? '' : 'es'} in ${files} file${files === 1 ? '' : 's'}`;
