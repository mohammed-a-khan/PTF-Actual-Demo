/**
 * Split a file containing git conflict markers into plain text and conflict blocks, and rebuild it
 * from the user's per-block choices. Pure functions, shared by the server tests and the UI.
 *
 *   <<<<<<< HEAD            ← current (ours)
 *   ...
 *   ||||||| base            ← only with merge.conflictStyle=diff3/zdiff3 (dropped from the result)
 *   ...
 *   =======
 *   ...                     ← incoming (theirs)
 *   >>>>>>> feature/x
 */
export type Segment =
    | { kind: 'text'; lines: string[] }
    | { kind: 'conflict'; ours: string[]; theirs: string[]; base: string[] | null; oursLabel: string; theirsLabel: string; startLine: number };

export type Choice = 'ours' | 'theirs' | 'both' | 'theirs-first' | { custom: string };

export interface Parsed {
    segments: Segment[];
    eol: '\n' | '\r\n';
    finalNewline: boolean;
    conflicts: number;
}

export function parseConflicts(text: string): Parsed {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const finalNewline = /\r?\n$/.test(text);
    const lines = text.split(/\r?\n/);
    if (finalNewline) lines.pop();
    const segments: Segment[] = [];
    let buf: string[] = [];
    let i = 0;
    let conflicts = 0;
    const flush = () => { if (buf.length) { segments.push({ kind: 'text', lines: buf }); buf = []; } };
    while (i < lines.length) {
        const l = lines[i];
        const open = /^(<{7,})(?:[ \t](.*))?$/.exec(l);
        if (open) {
            // The marker size is configurable (conflict-marker-size attribute); every marker of a
            // block has the same length as its opening run of '<'.
            const n = open[1].length;
            const isMarker = (m: string, ch: string) => m.length >= n && m.slice(0, n) === ch.repeat(n) && (m.length === n || m[n] === ' ' || m[n] === '\t');
            // Find a complete block; if it is malformed, treat the marker as plain text.
            const ours: string[] = [], theirs: string[] = [];
            let base: string[] | null = null;
            let j = i + 1, part: 'ours' | 'base' | 'theirs' = 'ours', ok = false, theirsLabel = '';
            for (; j < lines.length; j++) {
                const m = lines[j];
                if (part === 'ours' && isMarker(m, '|')) { part = 'base'; base = []; continue; }
                if ((part === 'ours' || part === 'base') && m === '='.repeat(n)) { part = 'theirs'; continue; }
                if (part === 'theirs' && isMarker(m, '>')) { theirsLabel = m.slice(n).trim(); ok = true; break; }
                if (isMarker(m, '<')) break;
                (part === 'ours' ? ours : part === 'base' ? base! : theirs).push(m);
            }
            if (ok) {
                flush();
                segments.push({ kind: 'conflict', ours, theirs, base, oursLabel: (open[2] ?? '').trim(), theirsLabel, startLine: i + 1 });
                conflicts++;
                i = j + 1;
                continue;
            }
        }
        buf.push(l);
        i++;
    }
    flush();
    return { segments, eol, finalNewline, conflicts };
}

/** Rebuild the file; every conflict needs a choice (index = order of conflict blocks). */
export function resolveConflicts(p: Parsed, choices: Choice[]): string {
    const out: string[] = [];
    let k = 0;
    for (const s of p.segments) {
        if (s.kind === 'text') { out.push(...s.lines); continue; }
        const c = choices[k++];
        if (c === undefined) throw new Error(`Conflict ${k} has no choice yet.`);
        if (c === 'ours') out.push(...s.ours);
        else if (c === 'theirs') out.push(...s.theirs);
        else if (c === 'both') out.push(...s.ours, ...s.theirs);
        else if (c === 'theirs-first') out.push(...s.theirs, ...s.ours);
        else out.push(...(c.custom === '' ? [] : c.custom.split(/\r?\n/)));
    }
    return out.join(p.eol) + (p.finalNewline ? p.eol : '');
}

/** Lines a choice produces for one block (undefined when not decided yet). */
export function blockResult(s: Extract<Segment, { kind: 'conflict' }>, c: Choice | undefined): string[] | undefined {
    if (c === undefined) return undefined;
    if (c === 'ours') return s.ours;
    if (c === 'theirs') return s.theirs;
    if (c === 'both') return [...s.ours, ...s.theirs];
    if (c === 'theirs-first') return [...s.theirs, ...s.ours];
    return c.custom === '' ? [] : c.custom.split(/\r?\n/);
}

export interface PaneRow { text: string | null; line?: number; block?: number; filler?: boolean; unresolved?: boolean }

/**
 * Rows for a three-pane merge view (Theirs | Mine above, Merged below), padded so that the same
 * row index shows the same place in all three panes and they can scroll together.
 */
export function alignPanes(p: Parsed, choices: Array<Choice | undefined>): { theirs: PaneRow[]; mine: PaneRow[]; merged: PaneRow[] } {
    const theirs: PaneRow[] = [], mine: PaneRow[] = [], merged: PaneRow[] = [];
    let t = 1, m = 1, r = 1, k = 0;
    for (const s of p.segments) {
        if (s.kind === 'text') {
            for (const l of s.lines) { theirs.push({ text: l, line: t++ }); mine.push({ text: l, line: m++ }); merged.push({ text: l, line: r++ }); }
            continue;
        }
        const res = blockResult(s, choices[k]);
        const mergedLines = res ?? [null];
        const n = Math.max(s.theirs.length, s.ours.length, mergedLines.length, 1);
        for (let i = 0; i < n; i++) {
            theirs.push(i < s.theirs.length ? { text: s.theirs[i], line: t++, block: k } : { text: null, block: k, filler: true });
            mine.push(i < s.ours.length ? { text: s.ours[i], line: m++, block: k } : { text: null, block: k, filler: true });
            if (res === undefined) merged.push(i === 0 ? { text: null, block: k, unresolved: true } : { text: null, block: k, filler: true, unresolved: true });
            else merged.push(i < res.length ? { text: res[i], line: r++, block: k } : { text: null, block: k, filler: true });
        }
        k++;
    }
    return { theirs, mine, merged };
}
