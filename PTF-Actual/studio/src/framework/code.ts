/**
 * Reading and carefully editing the project's code: page objects (classes, @CSPage ids, elements
 * and their locators, methods), step classes, configuration files. Members are inserted at the end
 * of a class (found with the TypeScript parser), configuration lines are added or extended in place,
 * everything else in the file stays as it is.
 */
import type * as TS from 'typescript';

type Ts = typeof TS;

export interface ExistingElement { prop: string; css?: string; xpath?: string; testId?: string; id?: string; role?: string; name?: string; text?: string; description?: string }
export interface ExistingPage {
    className: string; id: string; file: string; text: string;
    elements: ExistingElement[];
    /** Methods it has (open, currentUrl…). */
    methods: string[];
    /** A CSFramePage: its frames as the framework resolves them (CSFrameResolver), outermost first. */
    frameChain?: string[];
    /** Frame page objects it embeds (@CSIframe): property and class. */
    iframes?: Array<{ prop: string; cls: string }>;
}

/** One frame entry as the framework's CSFrameResolver turns it into a selector (a string, or { xpath | css | id | name | title | testId | src | index }). */
function frameSelectorOf(ts: Ts, n: TS.Expression): string | null {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text.startsWith('/') ? `xpath=${n.text}` : n.text;
    if (!ts.isObjectLiteralExpression(n)) return null;
    const v = (k: string) => propText(ts, n, k);
    if (v('xpath')) return `xpath=${v('xpath')}`;
    if (v('css')) return v('css')!;
    if (v('id')) return `#${v('id')}`;
    if (v('name')) return `iframe[name="${v('name')}"]`;
    if (v('title')) return `iframe[title="${v('title')}"]`;
    if (v('testId')) return `[data-testid="${v('testId')}"]`;
    if (v('src')) return `iframe[src*="${v('src')}"]`;
    for (const p of n.properties) if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'index' && ts.isNumericLiteral(p.initializer)) return `iframe >> nth=${p.initializer.text}`;
    return null;
}
/** The literal text of a property in an object literal ({ css: '…' }). */
function propText(ts: Ts, o: TS.ObjectLiteralExpression, name: string): string | undefined {
    for (const p of o.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const k = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : '';
        if (k === name && (ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer))) return p.initializer.text;
    }
    return undefined;
}

const decoratorsOf = (ts: Ts, n: TS.Node): readonly TS.Decorator[] => (ts.canHaveDecorators(n) ? ts.getDecorators(n) ?? [] : []);
const decoratorCall = (ts: Ts, d: TS.Decorator, name: string): TS.CallExpression | null =>
    ts.isCallExpression(d.expression) && ts.isIdentifier(d.expression.expression) && d.expression.expression.text === name ? d.expression : null;

/** A page object file: the class extending CSBasePage, its @CSPage id and @CSGetElement elements. */
export function parsePageObject(ts: Ts, text: string, file: string): ExistingPage | null {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const st of sf.statements) {
        if (!ts.isClassDeclaration(st) || !st.name) continue;
        const ext = st.heritageClauses?.some((h) => h.types.some((t) => /CS(Base|Frame)Page/.test(t.expression.getText(sf))));
        if (!ext) continue;
        let id = '';
        for (const d of decoratorsOf(ts, st)) {
            const c = decoratorCall(ts, d, 'CSPage');
            const a = c?.arguments[0];
            if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) id = a.text;
        }
        if (!id) continue;
        const elements: ExistingElement[] = [];
        const methods: string[] = [];
        const iframes: Array<{ prop: string; cls: string }> = [];
        let frameChain: string[] | undefined;
        for (const m of st.members) {
            if (ts.isMethodDeclaration(m) && m.name && ts.isIdentifier(m.name)) methods.push(m.name.text);
            if (!ts.isPropertyDeclaration(m) || !m.name || !ts.isIdentifier(m.name)) continue;
            if (m.name.text === 'frame' && m.initializer) {
                const list = ts.isArrayLiteralExpression(m.initializer) ? [...m.initializer.elements] : [m.initializer];
                const chain = list.map((x) => frameSelectorOf(ts, x));
                if (chain.length && chain.every((x): x is string => !!x)) frameChain = chain;
            }
            for (const d of decoratorsOf(ts, m)) {
                const fr = decoratorCall(ts, d, 'CSIframe')?.arguments[0];
                if (fr && ts.isIdentifier(fr)) iframes.push({ prop: m.name.text, cls: fr.text });
                const c = decoratorCall(ts, d, 'CSGetElement');
                const o = c?.arguments[0];
                if (o && ts.isObjectLiteralExpression(o)) elements.push({ prop: m.name.text, css: propText(ts, o, 'css'), xpath: propText(ts, o, 'xpath'), testId: propText(ts, o, 'testId'), id: propText(ts, o, 'id'), role: propText(ts, o, 'role'), name: propText(ts, o, 'name'), text: propText(ts, o, 'text'), description: propText(ts, o, 'description') });
            }
        }
        return { className: st.name.text, id, file, text, elements, methods, ...(frameChain ? { frameChain } : {}), ...(iframes.length ? { iframes } : {}) };
    }
    return null;
}

/** Insert members at the end of a class (before its closing brace); null when the class is not found. */
export function insertIntoClass(ts: Ts, text: string, className: string, members: string): string | null {
    const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const st of sf.statements) {
        if (ts.isClassDeclaration(st) && st.name?.text === className) {
            const close = st.end - 1;
            if (text[close] !== '}') return null;
            const before = text.slice(0, close).replace(/\s*$/, '');
            return `${before}\n\n${members.replace(/^\n+|\s+$/g, '')}\n}${text.slice(close + 1)}`;
        }
    }
    return null;
}

/** The name of the first class with @StepDefinitions in a step file. */
export function stepClassOf(ts: Ts, text: string): string | null {
    const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const st of sf.statements) if (ts.isClassDeclaration(st) && st.name && decoratorsOf(ts, st).some((d) => /StepDefinitions/.test(d.getText(sf)))) return st.name.text;
    return null;
}

/** The field a step class injects a page into (@Page('id') private x!: Cls). */
export function pageFieldOf(text: string, pageId: string): string | null {
    const m = new RegExp(`@Page\\(\\s*['"]${pageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*\\)\\s*(?:private|public|protected)?\\s*(?:readonly\\s+)?(\\w+)`).exec(text);
    return m ? m[1] : null;
}

/** A .env text with KEY set (an existing line is replaced, else the line is added at the end). */
export function setEnvKey(text: string | null, key: string, value: string, comment?: string): string {
    const lines = (text ?? '').split(/\r?\n/);
    const i = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (i >= 0) { lines[i] = `${key}=${value}`; return lines.join('\n'); }
    const body = (text ?? '').replace(/\s*$/, '');
    return `${body}${body ? '\n' : ''}${comment ? `${body ? '\n' : ''}# ${comment}\n` : ''}${key}=${value}\n`;
}

/** STEP_DEFINITIONS_PATH extended with a folder (first in the list: loaded before others). */
export function addStepFolder(text: string, folder: string): string {
    return text.replace(/^(\s*STEP_DEFINITIONS_PATH\s*=\s*)(.*)$/m, (_m, k: string, v: string) => {
        const parts = v.split(';').map((x) => x.trim()).filter(Boolean);
        return parts.includes(folder) ? `${k}${v}` : `${k}${[folder, ...parts].join(';')}`;
    });
}
