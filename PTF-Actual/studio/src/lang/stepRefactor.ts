/**
 * Working with a step across the project:
 *  - usages: the feature steps a definition runs (the first loaded definition that matches the step, in the
 *    feature's project, is the one the framework runs; Scenario Outline variants count);
 *  - rename: new wording for a step, in its definition and in every feature step that uses it; each step keeps
 *    its own values ("alice", 3, <user>), only the wording changes;
 *  - the Gherkin formatter: indentation by structure and aligned table columns (doc strings, comments, tags and
 *    descriptions are kept).
 */
import { featureSteps, matches, StepDef } from './steps';

export interface StepUsage { path: string; line: number; column: number; text: string; keyword: string }

/** The definition a feature step runs: the first loaded definition that matches it. */
export function runningDef(text: string, defs: StepDef[]): StepDef | undefined {
    return defs.find((d) => !d.notLoaded && matches(d, text)) ?? defs.find((d) => matches(d, text));
}

const same = (a: StepDef, b: Pick<StepDef, 'file' | 'line' | 'pattern'>) => a.file === b.file && a.line === b.line && a.pattern === b.pattern;

/** Every feature step the definition runs. `defsFor` gives the definitions a feature's project loads. */
export function stepUsages(target: Pick<StepDef, 'file' | 'line' | 'pattern'>, features: Array<{ path: string; text: string }>, defsFor: (feature: string) => StepDef[]): StepUsage[] {
    const out: StepUsage[] = [];
    for (const f of features) {
        const defs = defsFor(f.path);
        if (!defs.some((d) => same(d, target))) continue; // its project does not load this step file
        for (const s of featureSteps(f.text)) {
            if (s.variants.some((v) => { const d = runningDef(v, defs); return !!d && same(d, target); })) {
                out.push({ path: f.path, line: s.line, column: s.column, text: s.text, keyword: s.keyword });
            }
        }
    }
    return out;
}

const PARAM = /\{(string|int|float|word)\}/g;
export const paramsOf = (pattern: string) => [...pattern.matchAll(PARAM)].map((m) => m[1]);

/**
 * A regex for a step as written (not resolved): each parameter captured whole as written (with its quotes), and an
 * Outline <placeholder> accepted wherever a value goes.
 */
export function writtenRegex(pattern: string): RegExp {
    const ph = '<[^<>]+>';
    let p = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    p = p.replace(/\\\{string\\\}/g, `("[^"]*"|'[^']*'|${ph})`)
        .replace(/\\\{int\\\}/g, `(-?\\d+|${ph})`)
        .replace(/\\\{float\\\}/g, `(-?[\\d.]+|${ph})`)
        .replace(/\\\{word\\\}/g, `(\\w+|${ph})`);
    return new RegExp(`^${p}$`);
}

/** Why the new wording cannot replace the old one, or null. */
export function renameProblem(oldPattern: string, newPattern: string, allDefs: StepDef[]): string | null {
    const np = newPattern.trim();
    if (!np) return 'The new wording is empty.';
    if (np.length > 500 || /[\r\n]/.test(np)) return 'The new wording must be one line.';
    if (np === oldPattern) return 'The wording did not change.';
    const a = paramsOf(oldPattern), b = paramsOf(np);
    if (a.join() !== b.join()) return `The new wording must keep the same values in the same order: ${a.length ? a.map((x) => `{${x}}`).join(', ') : 'none'} (it has ${b.length ? b.map((x) => `{${x}}`).join(', ') : 'none'}).`;
    const taken = allDefs.find((d) => d.pattern === np);
    if (taken) return `A step with this wording exists: ${taken.file}:${taken.line}.`;
    return null;
}

/** A feature step's text in the new wording, its values kept as written; null if it is not written that way. */
export function renamedStepText(oldPattern: string, newPattern: string, text: string): string | null {
    const m = writtenRegex(oldPattern).exec(text.trim());
    if (!m) return null;
    let i = 1;
    return newPattern.replace(PARAM, () => m[i++] ?? '');
}

/** The definition's line with the new wording (the string literal in the decorator, same quote). */
export function renamedDefLine(line: string, oldPattern: string, newPattern: string): string | null {
    const re = /(CSBDDStepDef\s*\(\s*|@(?:Given|When|Then|And|But|Step|defineStep)\s*\(\s*)(['"`])((?:\\.|(?!\2)[^\\])*)\2/;
    const m = re.exec(line);
    if (!m) return null;
    const q = m[2];
    const unesc = m[3].replace(/\\(.)/g, '$1');
    if (unesc !== oldPattern) return null;
    const lit = newPattern.replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), `\\${q}`).replace(q === '`' ? /\$\{/g : /$^/, '\\${');
    return line.slice(0, m.index) + m[1] + q + lit + q + line.slice(m.index + m[0].length);
}

export interface RenameChange { path: string; line: number; before: string; after: string }

/** Every line the rename changes (the definition first), from the files as they are now. */
export function planRename(def: Pick<StepDef, 'file' | 'line' | 'pattern'>, newPattern: string, defText: string, usages: StepUsage[], featureText: (path: string) => string): { changes: RenameChange[]; skipped: StepUsage[] } {
    const changes: RenameChange[] = [];
    const defLines = defText.split('\n');
    const dl = defLines[def.line - 1] ?? '';
    const nl = renamedDefLine(dl, def.pattern, newPattern);
    if (nl === null) throw new Error(`The definition at ${def.file}:${def.line} is not written as a plain string: change it by hand.`);
    changes.push({ path: def.file, line: def.line, before: dl, after: nl });
    const skipped: StepUsage[] = [];
    const cache = new Map<string, string[]>();
    for (const u of usages) {
        if (!cache.has(u.path)) cache.set(u.path, featureText(u.path).split('\n'));
        const l = cache.get(u.path)![u.line - 1] ?? '';
        const t = renamedStepText(def.pattern, newPattern, u.text);
        if (t === null) { skipped.push(u); continue; }
        const at = l.lastIndexOf(u.text);
        changes.push({ path: u.path, line: u.line, before: l, after: at >= 0 ? l.slice(0, at) + t + l.slice(at + u.text.length) : l });
    }
    return { changes, skipped };
}

/** Apply line changes to a file's text (the lines must still read as planned). */
export function applyChanges(text: string, changes: RenameChange[]): string {
    const lines = text.split('\n');
    for (const c of changes) {
        const cur = (lines[c.line - 1] ?? '').replace(/\r$/, '');
        if (cur !== c.before.replace(/\r$/, '')) throw new Error(`Line ${c.line} of ${c.path} changed since the preview: try again.`);
        lines[c.line - 1] = c.after + ((lines[c.line - 1] ?? '').endsWith('\r') ? '\r' : '');
    }
    return lines.join('\n');
}

// ---- The Gherkin formatter.

const KW = {
    feature: /^(Feature|Funcionalidad|Fonctionnalité|Funktionalität):/,
    rule: /^Rule:/,
    block: /^(Background|Scenario|Scenario Outline|Scenario Template|Example):/,
    examples: /^(Examples|Scenarios):/,
    step: /^(Given|When|Then|And|But|\*)(\s|$)/,
};

/** Cells of a row as written (escapes kept), for re-alignment. */
function rawCells(row: string): string[] {
    const t = row.trim();
    const cells: string[] = [];
    let cur = '';
    for (let i = 1; i < t.length; i++) {
        const c = t[i];
        if (c === '\\' && i + 1 < t.length) { cur += c + t[++i]; continue; }
        if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim()) cells.push(cur.trim());
    return cells;
}

/** Display width of a cell (wide characters count double, combining marks nothing). */
const width = (s: string) => [...s].reduce((n, ch) => {
    const c = ch.codePointAt(0)!;
    if (/\p{M}/u.test(ch)) return n;
    return n + ((c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd))) ? 2 : 1);
}, 0);

/**
 * Format a feature: Feature at 0; Rule at 2; Background / Scenario / Examples one level in (two under a Rule);
 * steps one more; a step's table or doc string one more; Examples tables one more than Examples. Table columns
 * are aligned (numbers right-aligned). Tags and comments take the indentation of what follows them; doc string
 * contents keep their own indentation relative to the opening quotes; descriptions are indented under their
 * heading. The result ends with one line break.
 */
export function formatGherkin(text: string, indentUnit = '  '): string {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const out: string[] = [];
    const ind = (n: number) => indentUnit.repeat(n);
    let inRule = false;
    let level = 0;           // the indentation of the current heading's children
    let stepLevel = 0;       // the level of steps in the current block
    let lastKind: 'feature' | 'rule' | 'block' | 'examples' | 'step' | 'none' = 'none';
    const pending: string[] = []; // tags / comments waiting for the next line's level
    const flush = (lvl: number) => { for (const p of pending) out.push(p.startsWith('#') && p.startsWith('#language') ? p : ind(lvl) + p); pending.length = 0; };
    let i = 0;
    while (i < lines.length) {
        const raw = lines[i];
        const t = raw.trim();
        if (!t) { flush(level); out.push(''); i++; continue; }
        if (t.startsWith('@') || t.startsWith('#')) {
            if (/^#\s*language\s*:/.test(t) && out.every((l) => !l.trim())) { out.push(t); i++; continue; }
            pending.push(t); i++; continue;
        }
        if (KW.feature.test(t)) { flush(0); out.push(t); inRule = false; level = 1; lastKind = 'feature'; i++; continue; }
        if (KW.rule.test(t)) { flush(1); out.push(ind(1) + t); inRule = true; level = 2; lastKind = 'rule'; i++; continue; }
        if (KW.block.test(t)) { const l = inRule ? 2 : 1; flush(l); out.push(ind(l) + t); stepLevel = l + 1; level = l + 1; lastKind = 'block'; i++; continue; }
        if (KW.examples.test(t)) { const l = (inRule ? 2 : 1) + 1; flush(l); out.push(ind(l) + t); level = l + 1; lastKind = 'examples'; i++; continue; }
        if (KW.step.test(t)) { flush(stepLevel); out.push(ind(stepLevel) + t.replace(/^(\S+)\s+/, '$1 ')); level = stepLevel; lastKind = 'step'; i++; continue; }
        // A doc string under a step: the delimiters one level in, the content kept relative to them.
        const doc = /^("""|```)(.*)$/.exec(t);
        if (doc) {
            const l = stepLevel + 1;
            flush(l);
            const base = raw.length - raw.trimStart().length;
            out.push(ind(l) + t);
            i++;
            while (i < lines.length && !lines[i].trim().startsWith(doc[1])) {
                const c = lines[i];
                const own = c.length - c.trimStart().length;
                out.push(c.trim() ? ind(l) + ' '.repeat(Math.max(0, own - base)) + c.trimStart() : '');
                i++;
            }
            if (i < lines.length) { out.push(ind(l) + lines[i].trim()); i++; }
            continue;
        }
        // A table: the rows that follow each other, aligned together.
        if (t.startsWith('|')) {
            const l = lastKind === 'examples' ? level : stepLevel + 1;
            flush(l);
            const rows: Array<string[] | string> = [];
            while (i < lines.length && (lines[i].trim().startsWith('|') || (lines[i].trim().startsWith('#') && i + 1 < lines.length && lines[i + 1].trim().startsWith('|')))) {
                const r = lines[i].trim();
                rows.push(r.startsWith('#') ? r : rawCells(r));
                i++;
            }
            const cellsRows = rows.filter((r): r is string[] => Array.isArray(r));
            const cols = Math.max(...cellsRows.map((r) => r.length));
            const w = Array.from({ length: cols }, (_x, c) => Math.max(...cellsRows.map((r) => width(r[c] ?? ''))));
            const numeric = Array.from({ length: cols }, (_x, c) => cellsRows.slice(1).length > 0 && cellsRows.slice(1).every((r) => /^-?\d+(\.\d+)?$/.test(r[c] ?? '')));
            for (const r of rows) {
                if (typeof r === 'string') { out.push(ind(l) + r); continue; }
                out.push(ind(l) + '| ' + Array.from({ length: cols }, (_x, c) => {
                    const v = r[c] ?? '';
                    const pad = ' '.repeat(w[c] - width(v));
                    return numeric[c] && r !== cellsRows[0] ? pad + v : v + pad;
                }).join(' | ') + ' |');
            }
            continue;
        }
        // A description line: under its heading.
        flush(level);
        out.push(ind(lastKind === 'feature' || lastKind === 'rule' ? level : Math.max(level, 1)) + t);
        i++;
    }
    flush(level);
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out.join('\n') + '\n';
}
