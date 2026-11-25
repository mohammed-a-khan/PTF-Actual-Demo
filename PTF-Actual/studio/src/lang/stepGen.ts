/**
 * "Create step definition" for an undefined Gherkin step, in the framework's own style:
 *
 *   import { CSBDDStepDef, StepDefinitions } from '@mdakhan.mak/cs-playwright-test-framework/bdd';
 *
 *   @StepDefinitions
 *   export class OrdersSteps {
 *       @CSBDDStepDef('I open order {string}')
 *       async openOrder(orderId: string): Promise<void> { … }
 *   }
 *
 * Verified against the framework source:
 *  - `CSBDDStepDef` (CSStepRegistry) registers through CSBDDDecorators.registerStepDefinition, which
 *    matches with patternToRegex: {string} = "…" or '…', {int} = \d+, {float} = [\d.]+, {word} = \w+.
 *  - Arguments: {int}/{float} are passed as numbers, {string}/{word} as strings, then a DataTable
 *    (when the step has a table) or the doc string (CSBDDDecorators.ts ~217-269).
 *  - `StepDefinitions` and `DataTable` are exported from `/bdd` (lib/bdd.ts: export * from CSBDDDecorators).
 */
import { patternToRegex } from './steps';

const VERBS = new Set(['enter', 'enters', 'type', 'types', 'fill', 'fills', 'click', 'clicks', 'select', 'selects', 'search', 'searches', 'open', 'opens', 'go', 'goes', 'navigate', 'navigates', 'choose', 'chooses', 'set', 'sets', 'add', 'adds', 'remove', 'removes', 'delete', 'deletes', 'press', 'presses', 'check', 'checks', 'verify', 'verifies', 'wait', 'waits', 'upload', 'uploads', 'contain', 'contains', 'have', 'has', 'show', 'shows', 'display', 'displays', 'see', 'sees', 'login', 'log']);

export const BDD_IMPORT = '@mdakhan.mak/cs-playwright-test-framework/bdd';

export interface StepParam { name: string; type: 'string' | 'number' | 'DataTable' }
export interface GeneratedStep { pattern: string; params: StepParam[]; methodName: string }

const STOP = new Set(['i', 'a', 'an', 'the', 'is', 'are', 'am', 'be', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'with', 'my', 'should', 'see', 'user', 'that']);

const camel = (words: string[]) => words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
const ident = (s: string) => {
    const w = s.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    let id = w.length ? camel(w) : '';
    if (!id || /^\d/.test(id)) id = 'value' + id;
    return RESERVED.has(id) ? id + 'Value' : id;
};
const RESERVED = new Set(['class', 'function', 'var', 'let', 'const', 'new', 'delete', 'return', 'this', 'default', 'switch', 'case', 'in', 'of', 'for', 'while', 'do', 'if', 'else', 'try', 'catch', 'throw', 'void', 'with', 'yield', 'await', 'enum', 'export', 'import', 'super', 'extends', 'typeof', 'instanceof', 'null', 'true', 'false', 'debugger', 'continue', 'break', 'finally', 'interface', 'package', 'private', 'protected', 'public', 'static', 'implements']);

/**
 * Pattern and parameters for a step text. In an outline, `variants` are the step's text for each
 * Examples row: a bare <placeholder> becomes {int}/{float}/{word} when every row's value fits.
 */
export function generateStep(text: string, opts: { variants?: string[]; dataTable?: boolean; docString?: boolean } = {}): GeneratedStep {
    const params: StepParam[] = [];
    const used = new Set<string>();
    const uniq = (base: string) => { let n = base, i = 2; while (used.has(n)) n = `${base}${i++}`; used.add(n); return n; };
    // Values of each <placeholder> across the Examples rows (to pick a type for bare placeholders).
    const values = new Map<string, string[]>();
    if (opts.variants?.length) {
        const keys = [...text.matchAll(/<([^>]+)>/g)].map((m) => m[1]);
        const re = new RegExp('^' + text.split(/<[^>]+>/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*?)') + '$');
        for (const v of opts.variants) {
            const m = re.exec(v);
            if (m) keys.forEach((k, i) => values.set(k, [...(values.get(k) ?? []), m[i + 1]]));
        }
    }
    let pattern = '';
    let words: string[] = [];
    // '…' only as a quote (not the apostrophe in "don't"): no letter right before or after.
    const tokens = /"([^"]*)"|(?<![\w])'([^']*)'(?![\w])|<([^>]+)>|(\d+\.\d+)(?![\w.])|(?<![\w.])(\d+)(?![\w.])|([^"'<\d]+|.)/g;
    let m: RegExpExecArray | null;
    let lastWord = '';
    while ((m = tokens.exec(text)) !== null) {
        if (m[1] !== undefined || m[2] !== undefined) {
            const inner = m[1] ?? m[2];
            const ph = /^<([^>]+)>$/.exec(inner);
            pattern += '{string}';
            // Name: the placeholder; else a short word value ("Username" → username); else the
            // meaningful word before it; else "text".
            // A UI label ("Username" field) names the parameter after itself.
            const uiLabel = /^[A-Za-z][A-Za-z ]{0,30}$/.test(inner) && inner.trim().split(/\s+/).length <= 3
                && /^\s+(field|button|link|tab|page|menu|dropdown|checkbox|option|column|section|dialog|input|textbox|label|header|list|table)\b/i.test(text.slice(tokens.lastIndex)) ? inner : '';
            const prev = lastWord && !STOP.has(lastWord.toLowerCase()) && !VERBS.has(lastWord.toLowerCase()) ? lastWord : '';
            params.push({ name: uniq(ident(ph ? ph[1] : uiLabel || prev || 'text')), type: 'string' });
        } else if (m[3] !== undefined) {
            const vals = values.get(m[3]) ?? [];
            const all = (re: RegExp) => vals.length > 0 && vals.every((v) => re.test(v));
            const type = all(/^\d+$/) ? 'int' : all(/^[\d.]+$/) ? 'float' : all(/^\w+$/) ? 'word' : null;
            if (!type) throw new StepGenError(`<${m[3]}> is not in quotes and its Examples values contain spaces or symbols, so no step parameter can match it. Put quotes around it ("<${m[3]}>") and try again.`);
            pattern += `{${type}}`;
            params.push({ name: uniq(ident(m[3])), type: type === 'word' ? 'string' : 'number' });
        } else if (m[4] !== undefined || m[5] !== undefined) {
            // A number is named after the word that follows it ("3 items" → items), else the one before.
            const isFloat = m[4] !== undefined;
            pattern += isFloat ? '{float}' : '{int}';
            const ok = (w?: string) => !!w && !STOP.has(w.toLowerCase()) && !VERBS.has(w.toLowerCase());
            const ahead = (/^\s*([A-Za-z]+)(?:\s+([A-Za-z]+))?/.exec(text.slice(tokens.lastIndex)) ?? []).slice(1, 3);
            const pick = ok(ahead[0]) ? ahead[0] : ok(lastWord) ? lastWord : ok(ahead[1]) ? ahead[1] : isFloat ? 'amount' : 'count';
            params.push({ name: uniq(ident(pick)), type: 'number' });
        } else {
            const lit = m[6];
            pattern += lit;
            const ws = lit.split(/[^A-Za-z0-9]+/).filter(Boolean);
            words = words.concat(ws);
            if (ws.length) lastWord = ws[ws.length - 1];
        }
    }
    if (opts.dataTable) params.push({ name: uniq('dataTable'), type: 'DataTable' });
    else if (opts.docString) params.push({ name: uniq('docString'), type: 'string' });
    // The step must match its own text, exactly as the framework will match it.
    const check = opts.variants?.length ? opts.variants : [text];
    const re = patternToRegex(pattern);
    for (const v of check) if (!re.test(v)) throw new StepGenError(`Could not build a pattern that matches "${v}". Write this step definition by hand.`);
    const meaningful = words.filter((w) => !STOP.has(w.toLowerCase()));
    const methodName = ident((meaningful.length ? meaningful : words).slice(0, 6).join(' ') || 'step');
    return { pattern, params, methodName };
}

export class StepGenError extends Error {}

/** Quote a pattern as a TypeScript string literal. */
export function tsString(s: string): string {
    return s.includes("'") ? JSON.stringify(s) : `'${s.replace(/\\/g, '\\\\')}'`;
}

export function methodSource(g: GeneratedStep, stepText: string, indent: string, eol: string, methodName = g.methodName): string {
    const args = g.params.map((p) => `${p.name}: ${p.type}`).join(', ');
    const lines = [
        `${indent}@CSBDDStepDef(${tsString(g.pattern)})`,
        `${indent}async ${methodName}(${args}): Promise<void> {`,
        `${indent}${indent}// TODO: implement — usually a call to a page object method.`,
        `${indent}${indent}throw new Error(${tsString(`Step not implemented yet: ${stepText}`)});`,
        `${indent}}`,
    ];
    return lines.join(eol);
}

/** Skip strings, template literals and comments while scanning TypeScript for braces. */
function scanCode(src: string, onChar: (i: number, c: string) => boolean | void): void {
    let i = 0;
    while (i < src.length) {
        const c = src[i], n = src[i + 1];
        if (c === '/' && n === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
        if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
        if (c === '"' || c === "'" || c === '`') {
            let j = i + 1;
            while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
            i = j + 1; continue;
        }
        if (onChar(i, c) === true) return;
        i++;
    }
}

export interface Insertion { content: string; line: number; methodName: string }

/**
 * Add the step to a step-definition file's text (or create the file's text when `existing` is
 * null): into the last @StepDefinitions class (else the last class), with the imports it needs.
 */
export function insertStep(existing: string | null, g: GeneratedStep, stepText: string, classNameForNew: string, bddImport: string = BDD_IMPORT): Insertion {
    const eol = existing && existing.includes('\r\n') ? '\r\n' : '\n';
    const needs = ['CSBDDStepDef', ...(g.params.some((p) => p.type === 'DataTable') ? ['DataTable'] : [])];
    if (existing === null || !existing.trim()) {
        const body = methodSource(g, stepText, '    ', '\n');
        const content = [
            `import { ${[...needs, 'StepDefinitions'].sort().join(', ')} } from '${bddImport}';`,
            '',
            '@StepDefinitions',
            `export class ${classNameForNew} {`,
            '',
            body,
            '}',
            '',
        ].join('\n');
        return { content, line: 6, methodName: g.methodName };
    }
    let text = existing;
    // Classes and their closing braces.
    const classes: Array<{ name: string; open: number; close: number; decorated: boolean }> = [];
    const stack: Array<{ cls?: { name: string; open: number; decorated: boolean } }> = [];
    let pendingClass: { name: string; decorated: boolean } | null = null;
    scanCode(text, (i, c) => {
        if (c === 'c' && /^class\s+([A-Za-z_$][\w$]*)/.test(text.slice(i, i + 200)) && (i === 0 || !/[\w$]/.test(text[i - 1]))) {
            const name = /^class\s+([A-Za-z_$][\w$]*)/.exec(text.slice(i, i + 200))![1];
            const before = text.slice(Math.max(0, i - 300), i);
            pendingClass = { name, decorated: /@StepDefinitions\s*(?:export\s+(?:default\s+)?)?$/.test(before) };
        }
        if (c === '{') {
            if (pendingClass) { stack.push({ cls: { ...pendingClass, open: i } }); pendingClass = null; }
            else stack.push({});
        } else if (c === '}') {
            const top = stack.pop();
            if (top?.cls) classes.push({ ...top.cls, close: i });
        }
    });
    const target = [...classes].reverse().find((c) => c.decorated) ?? classes[classes.length - 1];
    if (!target) {
        // A file without a class: add one at the end.
        const block = ['', '@StepDefinitions', `export class ${classNameForNew} {`, '', methodSource(g, stepText, '    ', eol), '}', ''].join(eol);
        text = text.replace(/\s*$/, eol) + block;
        const withImports = ensureImports(text, [...needs, 'StepDefinitions'], eol, bddImport);
        const line = withImports.slice(0, withImports.lastIndexOf('@CSBDDStepDef(')).split('\n').length;
        return { content: withImports, line, methodName: g.methodName };
    }
    // Unique method name within the class.
    const classText = text.slice(target.open, target.close);
    let methodName = g.methodName;
    for (let k = 2; new RegExp(`\\b${methodName}\\s*\\(`).test(classText); k++) methodName = `${g.methodName}${k}`;
    // Indent like the class body.
    const indent = /\n([ \t]+)\S/.exec(classText)?.[1] ?? '    ';
    const method = methodSource(g, stepText, indent, eol, methodName);
    // Insert before the closing brace, after the last non-blank content.
    let at = target.close;
    while (at > target.open && /[ \t]/.test(text[at - 1])) at--;
    const beforeBrace = text.slice(0, at).replace(/(\r?\n)*$/, '');
    const insertText = eol + eol + method + eol;
    text = beforeBrace + insertText + text.slice(at);
    const marker = beforeBrace.length + insertText.indexOf('@CSBDDStepDef(');
    const withImports = ensureImports(text, needs.concat(target.decorated ? [] : []), eol, bddImport);
    const shift = withImports.length - text.length;
    const line = withImports.slice(0, marker + shift).split('\n').length;
    return { content: withImports, line, methodName };
}

/** Make sure `names` are imported from the framework's /bdd entry point (any existing import counts). */
export function ensureImports(text: string, names: string[], eol: string, bddImport: string = BDD_IMPORT): string {
    const missing = names.filter((n) => !new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${n}\\b[^}]*\\}\\s*from`).test(text));
    if (!missing.length) return text;
    // The file's own framework /bdd import (@mdakhan.mak or another scope) is extended.
    const existing = /import\s*\{([^}]*)\}\s*from\s*(['"])(@[\w.-]+\/cs-playwright-test-framework\/bdd)\2\s*;?/.exec(text);
    if (existing) {
        const have = existing[1].split(',').map((s) => s.trim()).filter(Boolean);
        const multi = existing[1].includes('\n');
        const all = [...have, ...missing];
        const list = multi ? `${eol}    ${all.join(`,${eol}    `)}${eol}` : ` ${all.join(', ')} `;
        return text.slice(0, existing.index) + `import {${list}} from ${existing[2]}${existing[3]}${existing[2]};` + text.slice(existing.index + existing[0].length);
    }
    const line = `import { ${missing.sort().join(', ')} } from '${bddImport}';`;
    // After the last import statement (they can span lines), else at the top.
    let lastEnd = -1;
    const importRe = /^import\b[\s\S]*?(?:from\s*['"][^'"]+['"]|['"][^'"]+['"])\s*;?[ \t]*$/gm;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(text)) !== null) lastEnd = m.index + m[0].length;
    if (lastEnd >= 0) return text.slice(0, lastEnd) + eol + line + text.slice(lastEnd);
    return line + eol + text;
}

/** "order-search.feature" → "OrderSearchSteps" */
export function classNameFor(featureBase: string): string {
    const w = featureBase.replace(/\.feature$/i, '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    const n = w.map((x) => x[0].toUpperCase() + x.slice(1)).join('') || 'New';
    return (/^\d/.test(n) ? 'S' + n : n) + 'Steps';
}
