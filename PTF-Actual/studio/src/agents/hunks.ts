/**
 * An agent's edits to a file as blocks of changed lines ("hunks"), for review in the editor: each one kept
 * or undone on its own (as VS Code's Keep / Undo). Pure (no Node modules): the server and the browser use it.
 *  - before: the file before the agent's first edit in the conversation (null: it did not exist);
 *  - after: the file now (null: deleted).
 * Keeping a hunk moves it into "before" (it is no longer shown); undoing it puts "before"'s lines back into "after".
 */
export interface Hunk {
    /** Stable for the same change: where it is and what it holds. */
    id: string;
    /** First line of the change in "after" (0-based); for a removal only, the line the removed lines were before. */
    afterStart: number;
    /** Lines added or changed in "after" (0: lines were only removed). */
    afterCount: number;
    /** First line in "before" (0-based) and the lines the change replaced or removed there. */
    beforeStart: number;
    removed: string[];
    added: string[];
}

type Op = { kind: 'same' | 'del' | 'add'; text: string };

/** Line diff (longest common subsequence; long files compared by their changed middle). */
export function lineOps(a: string[], b: string[]): Op[] {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const x = a.slice(start, endA), y = b.slice(start, endB);
    const head = a.slice(0, start).map((text) => ({ kind: 'same' as const, text }));
    const tail = a.slice(endA).map((text) => ({ kind: 'same' as const, text }));
    if (x.length * y.length > 4_000_000) return [...head, ...x.map((text) => ({ kind: 'del' as const, text })), ...y.map((text) => ({ kind: 'add' as const, text })), ...tail];
    const t: Uint32Array[] = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    const mid: Op[] = [];
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
        if (i < x.length && j < y.length && x[i] === y[j]) { mid.push({ kind: 'same', text: x[i] }); i++; j++; }
        else if (i < x.length && (j >= y.length || t[i + 1][j] >= t[i][j + 1])) { mid.push({ kind: 'del', text: x[i] }); i++; }
        else { mid.push({ kind: 'add', text: y[j] }); j++; }
    }
    return [...head, ...mid, ...tail];
}

const split = (t: string | null) => (t === null ? [] : t.replace(/\r\n/g, '\n').split('\n'));
const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

/** The changed blocks between before and after (nothing when they are the same). */
export function hunksOf(before: string | null, after: string | null): Hunk[] {
    const ops = lineOps(split(before), split(after));
    const out: Hunk[] = [];
    let ai = 0, bi = 0, k = 0;
    while (k < ops.length) {
        if (ops[k].kind === 'same') { ai++; bi++; k++; continue; }
        const h: Hunk = { id: '', afterStart: ai, afterCount: 0, beforeStart: bi, removed: [], added: [] };
        while (k < ops.length && ops[k].kind !== 'same') {
            if (ops[k].kind === 'del') { h.removed.push(ops[k].text); bi++; } else { h.added.push(ops[k].text); ai++; h.afterCount++; }
            k++;
        }
        h.id = hash(`${h.beforeStart}\u0000${h.removed.join('\n')}\u0000${h.added.join('\n')}`);
        out.push(h);
    }
    return out;
}

/** "after" with one hunk undone (its "before" lines back). */
export function undoHunk(before: string | null, after: string | null, id: string): string {
    const lines = split(after);
    const h = hunksOf(before, after).find((x) => x.id === id);
    if (!h) return after ?? '';
    lines.splice(h.afterStart, h.afterCount, ...h.removed);
    return lines.join('\n');
}

/** "before" with one hunk kept (its "after" lines taken in): what is left to review. */
export function keepHunk(before: string | null, after: string | null, id: string): string {
    const lines = split(before);
    const h = hunksOf(before, after).find((x) => x.id === id);
    if (!h) return before ?? '';
    lines.splice(h.beforeStart, h.removed.length, ...h.added);
    return lines.join('\n');
}

/** Lines added and removed in all (for "+12 −3"). */
export function changeCount(before: string | null, after: string | null): { added: number; removed: number } {
    return hunksOf(before, after).reduce((n, h) => ({ added: n.added + h.added.length, removed: n.removed + h.removed.length }), { added: 0, removed: 0 });
}
