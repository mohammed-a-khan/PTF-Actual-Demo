/**
 * Gherkin parse errors, found with the same parser the framework uses (@cucumber/gherkin from the project's
 * node_modules, with the framework's @DataProvider(...) preprocessing). A feature the framework cannot parse is
 * left out of the run with only a line in its log; the editor's Problems and the Run screen say so instead.
 * Without the parser (framework not installed) nothing is reported.
 */
import * as path from 'path';

export interface GherkinProblem { line: number; column: number; endColumn: number; severity: 'error'; message: string }

type GherkinModule = { Parser: new (b: unknown, m: unknown) => { parse(t: string): unknown }; AstBuilder: new (id: () => string) => unknown; GherkinClassicTokenMatcher: new () => unknown };
const cache = new Map<string, GherkinModule | null>();

/** @cucumber/gherkin as the project resolves it (null when it is not installed). */
export function gherkinFor(root: string): GherkinModule | null {
    if (cache.has(root)) return cache.get(root)!;
    let m: GherkinModule | null = null;
    try { m = require(require.resolve('@cucumber/gherkin', { paths: [root, path.join(root, 'node_modules')] })) as GherkinModule; } catch { m = null; }
    cache.set(root, m);
    return m;
}

/** The framework's preprocessing: @DataProvider(source="…", …) becomes a plain tag (spaces and quotes are not tags). */
const preprocess = (t: string) => t.replace(/@DataProvider\([^)]+\)/g, '@data-provider');

export function gherkinProblems(text: string, g: GherkinModule | null): GherkinProblem[] {
    if (!g) return [];
    const src = preprocess(String(text ?? ''));
    let n = 0;
    try {
        const parser = new g.Parser(new g.AstBuilder(() => String(n++)), new g.GherkinClassicTokenMatcher());
        const ast = parser.parse(src) as { feature?: unknown };
        if (!ast?.feature && src.trim()) return [{ line: 1, column: 1, endColumn: 2, severity: 'error', message: 'There is no "Feature:" line: the framework leaves this file out of the run.' }];
        return [];
    } catch (e) {
        const lines = src.split(/\r?\n/);
        // A composite error lists each problem as "(line:column): message".
        const errs = (e as { errors?: Array<{ message: string; location?: { line: number; column?: number } }> }).errors ?? [e as { message: string; location?: { line: number; column?: number } }];
        return errs.slice(0, 20).map((x) => {
            const loc = x.location ?? (() => { const m = /\((\d+):(\d+)\)/.exec(x.message); return m ? { line: Number(m[1]), column: Number(m[2]) } : { line: 1, column: 1 }; })();
            const line = Math.max(1, Math.min(lines.length, loc.line || 1));
            const raw = lines[line - 1] ?? '';
            const col = loc.column && loc.column > 0 ? loc.column : raw.length - raw.trimStart().length + 1;
            const msg = String(x.message ?? '').replace(/^\(\d+:\d+\):\s*/, '');
            const plain = /expected: .*got '(.*)'$/s.exec(msg);
            return { line, column: col, endColumn: Math.max(col + 1, raw.trimEnd().length + 1), severity: 'error' as const,
                message: `The framework cannot parse this feature, so it is left out of the run: ${plain ? `"${plain[1].trim().slice(0, 80)}" is not Gherkin here (start it with Given/When/Then/And/But, make it a # comment, or move it under the header as a description).` : msg.slice(0, 300)}` };
        });
    }
}
