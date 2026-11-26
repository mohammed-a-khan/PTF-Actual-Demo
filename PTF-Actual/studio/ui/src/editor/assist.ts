/**
 * The editor's insertion logic, kept apart from the component so it can be tested on its own:
 * completion text (a call with parentheses or a snippet), snippets and their tab stops, and Copilot's
 * inline suggestions (ghost text) against the text as it is now.
 */

// ---------------------------------------------------------------- snippets

/** A tab stop of an inserted snippet: [start, end) in the text, visited in `index` order ($0 last). */
export interface Stop { index: number; start: number; end: number }

/**
 * The plain text of a snippet and its tab stops (offsets in that text): $1, ${1:name}, $0, ${0}, with
 * \$ \} \\ escapes. Stops are sorted as Tab visits them: 1, 2, …, then 0 (the end; added at the end of
 * the text when the snippet has none).
 */
export function parseSnippet(s: string): { text: string; stops: Stop[] } {
    let text = '';
    const stops: Stop[] = [];
    const open: Array<{ index: number; start: number }> = [];
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '\\' && i + 1 < s.length && '$}\\'.includes(s[i + 1])) { text += s[++i]; continue; }
        if (c === '$') {
            const simple = /^\$(\d+)/.exec(s.slice(i));
            if (simple) { stops.push({ index: Number(simple[1]), start: text.length, end: text.length }); i += simple[0].length - 1; continue; }
            const ph = /^\$\{(\d+)(:|\})/.exec(s.slice(i));
            if (ph) {
                if (ph[2] === '}') stops.push({ index: Number(ph[1]), start: text.length, end: text.length });
                else open.push({ index: Number(ph[1]), start: text.length });
                i += ph[0].length - 1;
                continue;
            }
        }
        if (c === '}' && open.length) { const o = open.pop()!; stops.push({ index: o.index, start: o.start, end: text.length }); continue; }
        text += c;
    }
    // One stop per index (the first one; later mirrors are plain text here).
    const seen = new Set<number>();
    const uniq = stops.filter((x) => (seen.has(x.index) ? false : (seen.add(x.index), true)));
    if (!seen.has(0)) uniq.push({ index: 0, start: text.length, end: text.length });
    uniq.sort((a, b) => (a.index === 0 ? 1 : b.index === 0 ? -1 : a.index - b.index));
    return { text, stops: uniq };
}

/** Snippet mode: the stops (absolute offsets), the current one, and the inserted range. */
export interface SnippetMode { stops: Stop[]; cur: number; start: number; end: number }

/**
 * The snippet after an edit [at, at + removed) → `inserted` characters: typing in the current stop
 * grows it, stops after the edit move. An edit outside the snippet ends snippet mode (null).
 */
export function snippetAfterEdit(m: SnippetMode, at: number, removed: number, inserted: number): SnippetMode | null {
    const delta = inserted - removed;
    const endOld = at + removed;
    if (at < m.start || endOld > m.end) return null;
    const inside = (x: Stop) => at >= x.start && endOld <= x.end;
    // The stop being typed in: the current one when the edit is in it, else the first one it is in.
    const owner = m.stops[m.cur] && inside(m.stops[m.cur]) ? m.cur : m.stops.findIndex(inside);
    const stops = m.stops.map((x, i) => {
        if (i === owner) return { ...x, end: x.end + delta };
        if (x.start >= endOld) return { ...x, start: x.start + delta, end: x.end + delta };
        if (x.end <= at) return x;
        // An edit across a stop it is not in: that stop is gone (an empty stop where the edit starts).
        return { ...x, start: at, end: at };
    });
    return { ...m, stops, end: m.end + delta };
}

/** A diff of two texts as one edit: offset, removed and inserted lengths. */
export function editBetween(a: string, b: string): { at: number; removed: number; inserted: number } | null {
    if (a === b) return null;
    const max = Math.min(a.length, b.length);
    let s = 0;
    while (s < max && a.charCodeAt(s) === b.charCodeAt(s)) s++;
    let e = 0;
    while (e < max - s && a.charCodeAt(a.length - 1 - e) === b.charCodeAt(b.length - 1 - e)) e++;
    return { at: s, removed: a.length - s - e, inserted: b.length - s - e };
}

// ---------------------------------------------------------------- completions

export interface CompletionLike { name: string; kind: string; insertText?: string; isSnippet?: boolean }
const CALLABLE = new Set(['method', 'function', 'local function']);

/**
 * What accepting a completion inserts, as VS Code does with "complete function calls": a method or
 * function gets its parentheses (with its required parameters as placeholders when its call snippet
 * is known), unless a "(" follows already or it is named in an import / export list; anything else
 * (property, variable, keyword, class) just its name. The language service's own insertText wins.
 */
export function completionText(it: CompletionLike, details: { snippet?: string } | null | undefined, ctx: { nextChar: string; lineBefore: string }): { text: string; snippet: boolean } {
    if (it.insertText !== undefined) return { text: it.insertText, snippet: !!it.isSnippet };
    if (!CALLABLE.has(it.kind) || ctx.nextChar === '(' || /^\s*(import|export)\b/.test(ctx.lineBefore) || /\b(typeof|keyof)\s+[\w$.]*$/.test(ctx.lineBefore))
        return { text: it.name, snippet: false };
    const esc = it.name.replace(/[$}\\]/g, '\\$&');
    return { text: details?.snippet ?? `${esc}($0)`, snippet: true };
}

/** Whether the item needs its details before it is inserted (its call snippet comes from the signature). */
export const needsDetails = (it: CompletionLike) => it.insertText === undefined && CALLABLE.has(it.kind);

// ---------------------------------------------------------------- inline suggestions (ghost text)

export interface InlineSuggestion { id: string; text: string; start: number; end: number }

/**
 * What to show of a suggestion with the text and caret as they are now: the part after what is
 * already typed (null when it no longer fits: the person typed something else, or moved away).
 * `replaceEnd`: the suggestion replaces text up to there (e.g. a ")" after the caret), shown once.
 */
export function ghostOf(s: InlineSuggestion, doc: string, caret: number): { ghost: string; replaceEnd: number; suffix: string } | null {
    if (s.start > caret || s.start < 0 || s.end < s.start) return null;
    const typed = doc.slice(s.start, caret);
    if (!s.text.startsWith(typed)) return null;
    let ghost = s.text.slice(typed.length);
    const replaceEnd = Math.max(caret, s.end);
    // Text after the caret the suggestion also ends with (a closing ")"): drawn once, after the ghost.
    const suffix = doc.slice(caret, replaceEnd);
    if (suffix && ghost.endsWith(suffix)) ghost = ghost.slice(0, ghost.length - suffix.length);
    else if (suffix && !s.text.endsWith(suffix)) return null;
    if (!ghost) return null;
    return { ghost, replaceEnd, suffix };
}

/** Length of the next word of a ghost text (Ctrl+→): leading spaces (and line breaks), punctuation before it, the word ('Hello of 'Hello, world'); else the run of punctuation. */
export function nextWordLength(ghost: string): number {
    const m = /^\s*[^\w\s$]*[\w$]+|^\s*[^\w\s$]+|^\s+/.exec(ghost);
    const n = m ? m[0].length : 0;
    return n || Math.min(1, ghost.length);
}

/** Inline suggestions are asked for at the end of a line, or before closing brackets / quotes / ; only. */
export const inlineFits = (afterCaret: string) => /^[\s)\]}'"`;,]*$/.test(afterCaret);
