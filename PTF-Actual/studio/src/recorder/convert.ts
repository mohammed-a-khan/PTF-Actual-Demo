/**
 * A recorded Playwright script (`playwright codegen --target playwright-test`) as a list of actions.
 * Each locator becomes the Playwright selector it stands for (the `internal:` form Playwright itself
 * uses: getByRole('button', { name: 'Sign in' }) → internal:role=button[name="Sign in"i]), so a page
 * object finds exactly the element the recording found: the framework's `css` option goes to
 * page.locator() unchanged. Frames (contentFrame / frameLocator) become the framework's `frame` option.
 */
import type { FwLocator } from '../framework/locators';
import type * as TS from 'typescript';

export type ActionKind = 'goto' | 'click' | 'dblclick' | 'fill' | 'press' | 'check' | 'uncheck' | 'select' | 'hover' | 'upload'
    | 'expectVisible' | 'expectHidden' | 'expectText' | 'expectContains' | 'expectValue' | 'expectChecked' | 'expectUrl' | 'expectTitle'
    | 'expectEnabled' | 'expectDisabled' | 'expectAttribute' | 'expectCount' | 'expectDownload'
    /** const name = await <element>.textContent() / inputValue(): the value kept for later steps (value: the name). */
    | 'remember'
    /** expect(Number(<element text>)).toBeGreaterThan(5 | Number(name) + 1): attribute: the comparison, value: "5" or "@name+1". */
    | 'expectNumber'
    /** await cs.column(<cells>, 'equals' | 'contains' | 'asc' | 'desc', text?, { column }): every row of a table column. */
    | 'expectColumn'
    /** await cs.waitFor(<element>, 'contains' | 'visible' | 'hidden', text?, { reload, seconds }): wait until (refreshing the page). */
    | 'waitFor'
    /** await cs.dialog('accept' | 'dismiss', message, promptText?): the answer to the dialog the next action opens. */
    | 'dialog'
    /** await cs.switchTab('new' | index): the steps after act in that tab. */
    | 'switchTab'
    /** await cs.dataCheck(name, column, expected): the test data read now (its source: the cs-data mark before) has that value. */
    | 'dataCheck'
    /** el.click({ button: 'right' }): a context menu. */
    | 'rightclick'
    /** el.dragTo(other) (target2), or within itself to a position (a slider: at, as a share of its size). */
    | 'drag'
    /** page.keyboard.press(key): a key or shortcut not in a field (Escape, F2, Control+S). */
    | 'pressKey'
    /** await cs.closeTab(): the tab shown is closed. */
    | 'closeTab';

export interface Target {
    /** Playwright selector (page.locator). */
    selector: string;
    /** Frames to enter first, outermost first (selectors of the iframe elements). */
    frames: string[];
    /** Test id, when the locator is only getByTestId (framework `testId`). */
    testId?: string;
    /** What the locator says about the element, for its name: role, accessible name / text. */
    role?: string;
    name?: string;
    /** The locator as recorded (for comments). */
    source: string;
    /** The element's locators as the framework finds them, confirmed while recording, best first (// cs-locator marks). */
    fw?: FwLocator[];
}

export interface Action {
    kind: ActionKind;
    target?: Target;
    /** drag: the element dropped on. */
    target2?: Target;
    /** drag within the element: where, as shares (0..1) of its width and height. */
    at?: { x: number; y: number };
    /** fill / press / select / upload / expect* / goto value. */
    value?: string;
    values?: string[];
    /** Regular expression value (expectUrl, expectText…). */
    regex?: boolean;
    /** remember: only the part matching this regular expression (its source). */
    pattern?: string;
    /** waitFor: refresh the page while waiting; how long to wait. */
    wait?: { reload: boolean; seconds: number };
    /** expectAttribute: the attribute's name. */
    attribute?: string;
    line: number;
}

export interface Converted { actions: Action[]; warnings: string[] }

const q = (s: string) => JSON.stringify(s);
const reText = (pattern: string, flags: string) => `/${pattern}/${flags}`;

type Ts = typeof TS;

/** The locator chain of an expression: [{ name: 'getByRole', args }, ...] from `page`. */
interface Call { name: string; args: TS.Expression[] }

function chain(ts: Ts, e: TS.Expression): { root: string; calls: Call[] } | null {
    const calls: Call[] = [];
    let cur: TS.Expression = e;
    for (;;) {
        if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
            calls.unshift({ name: cur.expression.name.text, args: [...cur.arguments] });
            cur = cur.expression.expression;
        } else if (ts.isIdentifier(cur)) return { root: cur.text, calls };
        else if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
        else return null;
    }
}

/** Literal text of a string / template / regex argument. */
function lit(ts: Ts, e: TS.Expression | undefined): { text: string; regex?: { pattern: string; flags: string } } | null {
    if (!e) return null;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { text: e.text };
    if (ts.isRegularExpressionLiteral(e)) {
        const m = /^\/(.*)\/([a-z]*)$/s.exec(e.text);
        return m ? { text: m[1], regex: { pattern: m[1], flags: m[2] } } : null;
    }
    if (ts.isNumericLiteral(e)) return { text: e.text };
    return null;
}

function options(ts: Ts, e: TS.Expression | undefined): Record<string, { text: string; regex?: { pattern: string; flags: string }; bool?: boolean }> {
    const out: Record<string, { text: string; regex?: { pattern: string; flags: string }; bool?: boolean }> = {};
    if (!e || !ts.isObjectLiteralExpression(e)) return out;
    for (const p of e.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const k = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : '';
        if (p.initializer.kind === ts.SyntaxKind.TrueKeyword) out[k] = { text: 'true', bool: true };
        else if (p.initializer.kind === ts.SyntaxKind.FalseKeyword) out[k] = { text: 'false', bool: false };
        else if (ts.isNumericLiteral(p.initializer)) out[k] = { text: p.initializer.text };
        else { const v = lit(ts, p.initializer); if (v) out[k] = v; }
    }
    return out;
}

const textSel = (v: { text: string; regex?: { pattern: string; flags: string } }, exact?: boolean) => (v.regex ? reText(v.regex.pattern, v.regex.flags) : `${q(v.text)}${exact ? 's' : 'i'}`);

/** A locator chain as a selector; null when it uses something that cannot be written as one. */
export function selectorOf(ts: Ts, calls: Call[], testIdAttribute = 'data-testid'): Target | { error: string } {
    const parts: string[] = [];
    const frames: string[] = [];
    let role: string | undefined, name: string | undefined, testId: string | undefined;
    let onlyTestId = true;
    /** The label of the group the element was found in (filter({ hasText })): what names it. */
    let scope: string | undefined;
    for (const c of calls) {
        const a0 = lit(ts, c.args[0]);
        const o = options(ts, c.args[c.name === 'getByRole' ? 1 : 1]);
        const exact = o.exact?.bool === true;
        switch (c.name) {
            case 'getByRole': {
                if (!a0) return { error: 'a role that is not plain text' };
                let s = `internal:role=${a0.text}`;
                for (const [k, v] of Object.entries(o)) {
                    if (k === 'exact') continue;
                    if (k === 'name') s += `[name=${textSel(v, exact)}]`;
                    else if (['checked', 'disabled', 'expanded', 'includeHidden', 'level', 'pressed', 'selected'].includes(k)) s += `[${k === 'includeHidden' ? 'include-hidden' : k}=${v.text}]`;
                }
                parts.push(s); role = a0.text; name = o.name?.text ?? name; onlyTestId = false;
                break;
            }
            case 'getByText': if (!a0) return { error: 'getByText without text' }; parts.push(`internal:text=${textSel(a0, exact)}`); name = a0.text; onlyTestId = false; break;
            case 'getByLabel': if (!a0) return { error: 'getByLabel without text' }; parts.push(`internal:label=${textSel(a0, exact)}`); name = a0.text; onlyTestId = false; break;
            case 'getByPlaceholder': if (!a0) return { error: 'getByPlaceholder without text' }; parts.push(`internal:attr=[placeholder=${textSel(a0, exact)}]`); name = a0.text; role = role ?? 'textbox'; onlyTestId = false; break;
            case 'getByAltText': if (!a0) return { error: 'getByAltText without text' }; parts.push(`internal:attr=[alt=${textSel(a0, exact)}]`); name = a0.text; role = role ?? 'img'; onlyTestId = false; break;
            case 'getByTitle': if (!a0) return { error: 'getByTitle without text' }; parts.push(`internal:attr=[title=${textSel(a0, exact)}]`); name = a0.text; onlyTestId = false; break;
            case 'getByTestId': if (!a0 || a0.regex) return { error: 'getByTestId with a pattern' }; parts.push(`internal:testid=[${testIdAttribute}=${q(a0.text)}s]`); testId = a0.text; name = name ?? a0.text; break;
            case 'locator': {
                if (!a0 || a0.regex) return { error: 'locator() with an expression' };
                if (c.args[1]) {
                    const lo = options(ts, c.args[1]);
                    if (lo.hasText) { parts.push(a0.text, `internal:has-text=${textSel(lo.hasText)}`); onlyTestId = false; break; }
                }
                parts.push(a0.text); onlyTestId = false;
                const idm = /^#([\w-]+)$/.exec(a0.text);
                name = name ?? (idm ? idm[1] : undefined);
                // Rows / items of a list by CSS (a count check): named by the list's id.
                const item = /(?:^|[\s>+~])(tr|li)(?:[.#[:][^\s>]*)?$/.exec(a0.text);
                if (item && !role) { role = item[1] === 'tr' ? 'row' : 'listitem'; const lid = /#([\w-]+)/.exec(a0.text); name = name ?? (lid ? lid[1] : undefined); }
                break;
            }
            case 'filter': {
                const fo = options(ts, c.args[0]);
                if (fo.hasText) { parts.push(`internal:has-text=${textSel(fo.hasText)}`); scope = fo.hasText.text; }
                else if (fo.hasNotText) parts.push(`internal:has-not-text=${textSel(fo.hasNotText)}`);
                else return { error: 'filter() with a nested locator' };
                onlyTestId = false;
                break;
            }
            case 'first': parts.push('nth=0'); onlyTestId = false; break;
            case 'last': parts.push('nth=-1'); onlyTestId = false; break;
            case 'nth': {
                if (!a0) return { error: 'nth() with an expression' };
                // A table cell by its row and column: "<row> column <n>".
                if (role === 'row' && parts[parts.length - 1] === ':scope > *' && /^\d+$/.test(a0.text)) { role = 'cell'; name = `${(name ?? '').split(/\s+/).slice(0, 2).join(' ')} column ${Number(a0.text) + 1}`.trim(); }
                parts.push(`nth=${a0.text}`); onlyTestId = false; break;
            }
            case 'contentFrame': {
                // Everything so far selects the iframe element.
                if (!parts.length) return { error: 'contentFrame() of nothing' };
                frames.push(parts.join(' >> ')); parts.length = 0; onlyTestId = true; testId = undefined; role = undefined; name = undefined;
                break;
            }
            case 'frameLocator': {
                if (!a0) return { error: 'frameLocator() with an expression' };
                frames.push([...parts, a0.text].join(' >> ')); parts.length = 0; onlyTestId = true; testId = undefined;
                break;
            }
            default: return { error: `${c.name}()` };
        }
    }
    if (!parts.length) return { error: 'no element' };
    if (scope) name = scope;
    return { selector: parts.join(' >> '), frames, ...(onlyTestId && testId && parts.length === 1 && testIdAttribute === 'data-testid' ? { testId } : {}), role, name, source: '' };
}

const ACTIONS: Record<string, ActionKind> = { click: 'click', dblclick: 'dblclick', fill: 'fill', press: 'press', check: 'check', uncheck: 'uncheck', selectOption: 'select', hover: 'hover', setInputFiles: 'upload' };
const EXPECTS: Record<string, ActionKind> = { toBeVisible: 'expectVisible', toBeHidden: 'expectHidden', toHaveText: 'expectText', toContainText: 'expectContains', toHaveValue: 'expectValue', toBeChecked: 'expectChecked', toHaveURL: 'expectUrl', toHaveTitle: 'expectTitle',
    toBeEnabled: 'expectEnabled', toBeDisabled: 'expectDisabled', toHaveAttribute: 'expectAttribute', toHaveCount: 'expectCount',
    // The Studio recorder's own: a click downloaded a file (expect(page).toHaveDownloaded('name' | /pattern/)).
    toHaveDownloaded: 'expectDownload' };

const FW_KEYS = new Set(['testId', 'id', 'name', 'role', 'text', 'placeholder']);

export function convertScript(ts: Ts, text: string, o: { testIdAttribute?: string } = {}): Converted {
    const sf = ts.createSourceFile('recording.spec.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    // The in-Studio recorder's framework locators by element code (// cs-locator {"code": …, "fw": […]}).
    const fwOf = new Map<string, FwLocator[]>();
    for (const l of text.split('\n')) {
        const m = /^\s*\/\/ cs-locator (\{.*\})\s*$/.exec(l);
        if (!m) continue;
        try {
            const j = JSON.parse(m[1]) as { code?: unknown; fw?: unknown };
            if (typeof j.code === 'string' && Array.isArray(j.fw)) fwOf.set(j.code, j.fw.filter((x): x is FwLocator => !!x && typeof x.key === 'string' && typeof x.value === 'string' && typeof x.score === 'number' && FW_KEYS.has(x.key)));
        } catch { /* not a mark */ }
    }
    const actions: Action[] = [];
    const warnings: string[] = [];
    // Open tabs in order (page is the first); the one the next action acts in. Playwright's own scripts work with
    // several page variables (const page1 = await page1Promise): their actions become the framework's tab steps.
    const tabs: string[] = ['page'];
    let current = 'page';
    const pages = { has: (name: string) => tabs.includes(name) };
    /** Before an action in a tab: switch to it when another tab is shown. */
    const inTab = (root: string, line: number) => {
        if (root === current || !tabs.includes(root)) return;
        actions.push({ kind: 'switchTab', value: String(tabs.indexOf(root)), line });
        current = root;
    };
    const lineOf = (n: TS.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const src = (n: TS.Node) => n.getText(sf);
    const warn = (n: TS.Node, why: string) => warnings.push(`Line ${lineOf(n)}: ${why}: ${src(n).replace(/\s+/g, ' ').slice(0, 160)}`);

    const target = (e: TS.Expression): Target | string => {
        const ch = chain(ts, e);
        if (!ch) return 'not a locator';
        if (!pages.has(ch.root)) return `on ${ch.root}`;
        inTab(ch.root, lineOf(e));
        const t = selectorOf(ts, ch.calls, o.testIdAttribute);
        if ('error' in t) return t.error;
        const fw = fwOf.get(src(e));
        return { ...t, source: src(e), ...(fw?.length ? { fw } : {}) };
    };

    const visit = (n: TS.Node) => {
        // const page1 = await page1Promise (page.waitForEvent('popup')) / await context.newPage(): another tab.
        if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
            const init = ts.isAwaitExpression(n.initializer) ? n.initializer.expression : n.initializer;
            // const orderNumber = await page.getByTestId('order').textContent(): a value kept for later steps;
            // (await ….textContent())?.match(/SO-\d+/)?.[0]: only the part that matches.
            const strip = (x: TS.Expression): TS.Expression => { while (ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x)) x = x.expression; return x; };
            let rx = strip(n.initializer);
            let pattern: string | undefined;
            if (ts.isElementAccessExpression(rx) && ts.isNumericLiteral(rx.argumentExpression) && rx.argumentExpression.text === '0') {
                const mc = strip(rx.expression);
                if (ts.isCallExpression(mc) && ts.isPropertyAccessExpression(mc.expression) && mc.expression.name.text === 'match' && mc.arguments[0] && ts.isRegularExpressionLiteral(mc.arguments[0])) {
                    const lit0 = /^\/(.*)\/([a-z]*)$/s.exec(mc.arguments[0].text);
                    if (lit0) { pattern = lit0[1]; rx = strip(mc.expression.expression); }
                }
            }
            const ic = ts.isAwaitExpression(rx) ? rx.expression : undefined;
            if (ic && ts.isCallExpression(ic) && ts.isPropertyAccessExpression(ic.expression) && ['textContent', 'innerText', 'inputValue'].includes(ic.expression.name.text)) {
                const t = target(ic.expression.expression);
                if (typeof t === 'string') { warn(n, `the element is ${t}`); return; }
                actions.push({ kind: 'remember', target: t, value: n.name.text, attribute: ic.expression.name.text === 'inputValue' ? 'value' : 'text', ...(pattern ? { pattern } : {}), line: lineOf(n) });
                return;
            }
            const opened = (/popup|page/i.test(n.name.text) && ts.isIdentifier(init) && ts.isAwaitExpression(n.initializer))
                || (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === 'newPage');
            if (opened && !tabs.includes(n.name.text)) {
                tabs.push(n.name.text);
                actions.push({ kind: 'switchTab', value: 'new', line: lineOf(n) });
                current = n.name.text;
            }
        }
        if (ts.isExpressionStatement(n)) {
            let e = n.expression;
            if (ts.isAwaitExpression(e)) e = e.expression;
            // The Studio's own checks: await cs.column(…) / cs.waitFor(…).
            if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression) && e.expression.expression.text === 'cs') {
                const fn = e.expression.name.text, a0 = e.arguments[0];
                if (fn === 'dialog') {
                    const act = lit(ts, a0)?.text, msg = lit(ts, e.arguments[1])?.text, txt = e.arguments[2] ? lit(ts, e.arguments[2])?.text : undefined;
                    if ((act !== 'accept' && act !== 'dismiss') || msg === undefined) { warn(n, 'a dialog answer that is not converted'); return; }
                    actions.push({ kind: 'dialog', attribute: act, value: msg, ...(txt !== undefined ? { values: [txt] } : {}), line: lineOf(n) });
                    return;
                }
                if (fn === 'dataCheck') {
                    const name = lit(ts, a0)?.text, column = lit(ts, e.arguments[1])?.text, expected = lit(ts, e.arguments[2])?.text;
                    if (!name || !column || expected === undefined) { warn(n, 'a test data check that is not converted'); return; }
                    actions.push({ kind: 'dataCheck', attribute: column, value: expected, values: [name], line: lineOf(n) });
                    return;
                }
                if (fn === 'closeTab') { actions.push({ kind: 'closeTab', line: lineOf(n) }); return; }
                if (fn === 'switchTab') {
                    const v = a0 && ts.isNumericLiteral(a0) ? a0.text : lit(ts, a0)?.text;
                    if (v !== 'new' && !/^\d+$/.test(v ?? '')) { warn(n, 'a tab that is not converted'); return; }
                    actions.push({ kind: 'switchTab', value: v, line: lineOf(n) });
                    return;
                }
                const mode = lit(ts, e.arguments[1])?.text ?? '';
                const text = e.arguments[2] && !ts.isObjectLiteralExpression(e.arguments[2]) ? lit(ts, e.arguments[2])?.text : undefined;
                const o = options(ts, e.arguments.find((x) => ts.isObjectLiteralExpression(x)));
                const t = a0 ? target(a0) : 'no element';
                if (typeof t === 'string') { warn(n, `the element is ${t}`); return; }
                if (fn === 'column' && ['equals', 'contains', 'asc', 'desc'].includes(mode)) {
                    if ((mode === 'equals' || mode === 'contains') && text === undefined) { warn(n, 'a column check without its text'); return; }
                    if (o.column?.text) t.name = `${o.column.text} column`;
                    actions.push({ kind: 'expectColumn', target: t, attribute: mode, ...(text !== undefined ? { value: text } : {}), line: lineOf(n) });
                    return;
                }
                if (fn === 'waitFor' && ['contains', 'visible', 'hidden'].includes(mode)) {
                    if (mode === 'contains' && !text) { warn(n, 'a wait without its text'); return; }
                    const seconds = Math.min(3600, Math.max(1, Number(o.seconds?.text ?? 60) || 60));
                    actions.push({ kind: 'waitFor', target: t, attribute: mode, ...(text !== undefined ? { value: text } : {}), wait: { reload: o.reload?.bool === true, seconds }, line: lineOf(n) });
                    return;
                }
                warn(n, `cs.${fn}(${mode}) is not converted`);
                return;
            }
            if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
                const method = e.expression.name.text;
                const recv = e.expression.expression;
                const args = e.arguments;
                // expect(x).toY(...) / expect(x).not.toY(...)
                let ex: TS.CallExpression | null = null, negated = false;
                if (ts.isCallExpression(recv) && ts.isIdentifier(recv.expression) && recv.expression.text === 'expect') ex = recv;
                else if (ts.isPropertyAccessExpression(recv) && recv.name.text === 'not' && ts.isCallExpression(recv.expression) && ts.isIdentifier(recv.expression.expression) && recv.expression.expression.text === 'expect') { ex = recv.expression; negated = true; }
                // expect(Number((await el.textContent())?.replace(/[^\d.-]/g, ''))).toBeGreaterThan(Number(cartCount) + 1)
                if (ex && ex.arguments[0] && ts.isCallExpression(ex.arguments[0]) && ts.isIdentifier(ex.arguments[0].expression) && ex.arguments[0].expression.text === 'Number') {
                    const OPS: Record<string, string> = { toBe: 'eq', toEqual: 'eq', toBeGreaterThan: 'gt', toBeGreaterThanOrEqual: 'ge', toBeLessThan: 'lt', toBeLessThanOrEqual: 'le' };
                    let op = OPS[method];
                    if (negated) op = op === 'eq' ? 'ne' : '';
                    const strip = (x: TS.Expression): TS.Expression => { while (ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x)) x = x.expression; return x; };
                    let inner = strip(ex.arguments[0].arguments[0] ?? ex.arguments[0]);
                    if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && inner.expression.name.text === 'replace') inner = strip(inner.expression.expression);
                    const call = ts.isAwaitExpression(inner) ? strip(inner.expression) : undefined;
                    if (!op || !call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression) || !['textContent', 'innerText', 'inputValue'].includes(call.expression.name.text)) { warn(n, 'a number check that is not converted'); return; }
                    const t = target(call.expression.expression);
                    if (typeof t === 'string') { warn(n, `the element is ${t}`); return; }
                    // The other side: a number, or a remembered value (Number(name)) plus or minus a number.
                    const rhs = args[0] ? strip(args[0]) : undefined;
                    const num = (x: TS.Expression): number | null => { x = strip(x); if (ts.isNumericLiteral(x)) return Number(x.text); if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(x.operand)) return -Number(x.operand.text); return null; };
                    const named = (x: TS.Expression): string | null => { x = strip(x); return ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === 'Number' && x.arguments[0] && ts.isIdentifier(x.arguments[0]) ? x.arguments[0].text : null; };
                    let value: string | null = null;
                    if (rhs && num(rhs) !== null) value = String(num(rhs));
                    else if (rhs && named(rhs)) value = `@${named(rhs)}+0`;
                    else if (rhs && ts.isBinaryExpression(rhs) && named(rhs.left) && num(rhs.right) !== null && (rhs.operatorToken.kind === ts.SyntaxKind.PlusToken || rhs.operatorToken.kind === ts.SyntaxKind.MinusToken)) value = `@${named(rhs.left)}${rhs.operatorToken.kind === ts.SyntaxKind.MinusToken ? '-' : '+'}${Math.abs(num(rhs.right)!)}`;
                    if (value === null) { warn(n, 'a number check against an expression that is not converted'); return; }
                    actions.push({ kind: 'expectNumber', target: t, attribute: op, value, line: lineOf(n) });
                    return;
                }
                if (ex) {
                    const kind = EXPECTS[method];
                    if (!kind || negated) { warn(n, `${negated ? 'not.' : ''}${method} is not converted`); return; }
                    const subject = ex.arguments[0];
                    const v = lit(ts, args[0]);
                    if (kind === 'expectUrl' || kind === 'expectTitle' || kind === 'expectDownload') {
                        if (!subject || !ts.isIdentifier(subject) || subject.text !== 'page') { warn(n, 'not on the page'); return; }
                        if (!v) { warn(n, 'a value that is not plain text'); return; }
                        actions.push({ kind, value: v.text, regex: !!v.regex, line: lineOf(n) });
                        return;
                    }
                    const t = subject ? target(subject) : 'no element';
                    if (typeof t === 'string') { warn(n, `the element is ${t}`); return; }
                    if (kind === 'expectAttribute') {
                        const name = lit(ts, args[0]), val = lit(ts, args[1]);
                        if (!name || name.regex || !val) { warn(n, 'an attribute check without plain name and value'); return; }
                        const t2 = subject ? target(subject) : 'no element';
                        if (typeof t2 === 'string') { warn(n, `the element is ${t2}`); return; }
                        actions.push({ kind, target: t2, attribute: name.text, value: val.text, regex: !!val.regex, line: lineOf(n) });
                        return;
                    }
                    if (['expectText', 'expectContains', 'expectValue', 'expectCount'].includes(kind) && !v) {
                        if (args[0] && ts.isArrayLiteralExpression(args[0])) { warn(n, 'a list of texts is not converted'); return; }
                        warn(n, 'a value that is not plain text'); return;
                    }
                    actions.push({ kind, target: t, ...(v ? { value: v.text, regex: !!v.regex } : {}), line: lineOf(n) });
                    return;
                }
                const ch = chain(ts, recv);
                // page.keyboard.press('Escape'): a key of the page (not of a field).
                if (method === 'press' && ts.isPropertyAccessExpression(recv) && recv.name.text === 'keyboard' && ts.isIdentifier(recv.expression) && tabs.includes(recv.expression.text)) {
                    inTab(recv.expression.text, lineOf(n));
                    const v = lit(ts, args[0]);
                    if (!v) { warn(n, 'a key that is not plain text'); return; }
                    actions.push({ kind: 'pressKey', value: v.text, line: lineOf(n) });
                    return;
                }
                // a.dragTo(b) / a.dragTo(a, { targetPosition }): drag and drop, a slider.
                if (method === 'dragTo' && ch) {
                    const t = target(recv), t2 = args[0] ? target(args[0]) : 'no element';
                    if (typeof t === 'string' || typeof t2 === 'string') { warn(n, `the element is ${typeof t === 'string' ? t : t2}`); return; }
                    const tp = args[1] && ts.isObjectLiteralExpression(args[1]) ? args[1].properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'targetPosition') : undefined;
                    if (tp && ts.isPropertyAssignment(tp)) {
                        const pos = options(ts, tp.initializer);
                        const size = /\/\/ of (\d+)x(\d+)/.exec(sf.text.slice(n.end, sf.text.indexOf('\n', n.end) === -1 ? undefined : sf.text.indexOf('\n', n.end)));
                        const w = size ? Number(size[1]) : 0, h = size ? Number(size[2]) : 0;
                        if (!w || !h || !pos.x || !pos.y) { warn(n, 'a drag to a position without the element size'); return; }
                        actions.push({ kind: 'drag', target: t, at: { x: Math.round((Number(pos.x.text) / w) * 1000) / 1000, y: Math.round((Number(pos.y.text) / h) * 1000) / 1000 }, line: lineOf(n) });
                    } else actions.push({ kind: 'drag', target: t, target2: t2, line: lineOf(n) });
                    return;
                }
                if (method === 'goto' && ts.isIdentifier(recv)) {
                    if (!tabs.includes(recv.text)) { warn(n, `navigation on ${recv.text}`); return; }
                    inTab(recv.text, lineOf(n));
                    const v = lit(ts, args[0]);
                    if (!v) { warn(n, 'an address that is not plain text'); return; }
                    actions.push({ kind: 'goto', value: v.text, line: lineOf(n) });
                    return;
                }
                const kind = ACTIONS[method];
                if (kind && ch) {
                    const t = target(recv);
                    if (typeof t === 'string') { warn(n, `the element is ${t}`); return; }
                    const a: Action = { kind, target: t, line: lineOf(n) };
                    if (kind === 'fill' || kind === 'press') { const v = lit(ts, args[0]); if (!v) { warn(n, 'a value that is not plain text'); return; } a.value = v.text; }
                    if (kind === 'select' || kind === 'upload') {
                        const arr = args[0] && ts.isArrayLiteralExpression(args[0]) ? [...args[0].elements] : args[0] ? [args[0]] : [];
                        const vals = arr.map((x) => lit(ts, x as TS.Expression)?.text);
                        if (!vals.length && kind === 'upload') a.values = [];
                        else if (vals.some((x) => x === undefined)) { warn(n, 'values that are not plain text'); return; }
                        else a.values = vals as string[];
                    }
                    if ((kind === 'click' || kind === 'dblclick') && args[0]) {
                        const co = options(ts, args[0]);
                        if (kind === 'click' && co.button?.text === 'right' && !co.modifiers && !co.position) a.kind = 'rightclick';
                        else if (co.button || co.modifiers || co.position) warn(n, 'click options (button, modifiers, position) are not kept');
                    }
                    actions.push(a);
                    return;
                }
                // Another tab closed: the framework closes the tab shown; the next action switches to its tab.
                if (method === 'close' && ts.isIdentifier(recv) && recv.text !== 'page' && tabs.includes(recv.text)) {
                    inTab(recv.text, lineOf(n));
                    actions.push({ kind: 'closeTab', line: lineOf(n) });
                    tabs.splice(tabs.indexOf(recv.text), 1);
                    current = '';
                    return;
                }
                if (ch && pages.has(ch.root) && ['close', 'waitForURL', 'waitForLoadState', 'pause'].includes(method)) return;
                if (method === 'once' || method === 'on') { warn(n, 'dialog / event handlers are not converted (accept or dismiss dialogs with the framework\'s browser steps)'); return; }
                if (!ch || !['test', 'describe'].includes(ch.root)) warn(n, 'not converted');
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    // The recorder clicks a field before filling it: the click adds nothing.
    const out: Action[] = [];
    for (let i = 0; i < actions.length; i++) {
        const a = actions[i], b = actions[i + 1];
        if (a.kind === 'click' && b && (b.kind === 'fill' || b.kind === 'press' || b.kind === 'select') && b.target?.selector === a.target?.selector && JSON.stringify(b.target?.frames) === JSON.stringify(a.target?.frames)) continue;
        // Keys that only move to the next field (Tab) or through a list before choosing (arrows):
        // the next action does that itself.
        const same = (x?: Action, y?: Action) => !!x && !!y && x.target?.selector === y.target?.selector && JSON.stringify(x.target?.frames) === JSON.stringify(y.target?.frames);
        if (a.kind === 'press' && /^(Shift\+)?Tab$/.test(a.value ?? '') && ['fill', 'check', 'uncheck', 'select', 'press', 'click'].includes(out[out.length - 1]?.kind ?? '') && same(out[out.length - 1], a)) continue;
        if (a.kind === 'press' && /^Arrow(Up|Down)$/.test(a.value ?? '') && b?.kind === 'select' && same(a, b)) continue;
        // Successive fills of the same field: the last one counts.
        if (a.kind === 'fill' && b?.kind === 'fill' && b.target?.selector === a.target?.selector) continue;
        out.push(a);
    }
    return { actions: out, warnings };
}
