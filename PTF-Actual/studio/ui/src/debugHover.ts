/**
 * While a debug run is paused: the expression under the mouse in the editor, whose value is shown as in browser
 * dev tools. It is the name under the mouse with what it is reached through on its left ("this.loginPage.url"
 * when pointing at "url"; "items[0].name"), never a call (nothing that could change the run is evaluated).
 */
const KEYWORDS = new Set(['abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'of', 'private', 'protected', 'public', 'readonly', 'return', 'set', 'static', 'super', 'switch', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield']);
const ID = /[A-Za-z0-9_$]/;

/** The text between quotes / in a comment on that line, before `offset` (a word there is not code). */
function inStringOrComment(line: string, col: number): boolean {
    let q: string | null = null;
    for (let i = 0; i < col; i++) {
        const c = line[i];
        if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
        if (c === '/' && line[i + 1] === '/') return true;
        if (c === '"' || c === "'" || c === '`') q = c;
    }
    return q !== null;
}

export function hoverExpression(text: string, offset: number): string | null {
    if (offset < 0 || offset > text.length) return null;
    let s = offset, e = offset;
    while (s > 0 && ID.test(text[s - 1])) s--;
    while (e < text.length && ID.test(text[e])) e++;
    if (s === e || /^[0-9]/.test(text[s])) return null;
    const lineStart = text.lastIndexOf('\n', s - 1) + 1;
    if (inStringOrComment(text.slice(lineStart, text.indexOf('\n', s) < 0 ? text.length : text.indexOf('\n', s)), s - lineStart)) return null;
    const word = text.slice(s, e);
    if (KEYWORDS.has(word)) return null;
    // Left: ".name", "?.name", "[0]", "['key']" … back to the start of the chain.
    let start = s;
    for (;;) {
        let i = start;
        if (text[i - 1] === '.' ) {
            i--; if (text[i - 1] === '?') i--;
            // Reached through a call ("get().x") or anything else that is not a plain chain: its value would
            // need the call to run (or would be another variable's): nothing is shown.
            if (text[i - 1] === ']') { const j = matchOpen(text, i - 1); if (j < 0) return null; i = j; }
            let k = i; while (k > 0 && ID.test(text[k - 1])) k--;
            if (k === i) return null;
            start = k; continue;
        }
        if (text[i - 1] === ']') { const j = matchOpen(text, i - 1); if (j < 0) break; let k = j; while (k > 0 && ID.test(text[k - 1])) k--; if (k === j) break; start = k; continue; }
        break;
    }
    const expr = text.slice(start, e);
    // A call (or a declaration's name, e.g. "async verify(") is not evaluated: a method shows as itself only when reached through an object.
    if (/[()]/.test(expr) || /\n/.test(expr)) return null;
    const first = /^[A-Za-z_$][\w$]*/.exec(expr)?.[0] ?? '';
    if (KEYWORDS.has(first) && first !== 'this') return null;
    return expr;
}

/** The "[" that the "]" at `close` closes (simple indexes: names, numbers, quoted keys). */
function matchOpen(text: string, close: number): number {
    const j = text.lastIndexOf('[', close);
    if (j < 0) return -1;
    return /^\[\s*(?:\d+|[A-Za-z_$][\w$.]*|'[^'\n]*'|"[^"\n]*")\s*\]$/.test(text.slice(j, close + 1)) ? j : -1;
}

/** Where the debug run is paused (set by the Debug panel): the hover evaluates in that frame, in that file only. */
export interface DebugHoverContext { runId: string; frame: number; file: string }
let current: DebugHoverContext | null = null;
export function setDebugHoverContext(c: DebugHoverContext | null): void { current = c; }
export function debugHoverContext(): DebugHoverContext | null { return current; }
/** The same file, whatever the separators ("test\\a.ts" on Windows, "test/a.ts"). */
export const sameFile = (a: string, b: string) => a.replace(/\\/g, '/').replace(/^\.\//, '') === b.replace(/\\/g, '/').replace(/^\.\//, '');
