/**
 * jasmine_parser — extract Jasmine (and Protractor) test facts from .js/.ts.
 *
 * Handles:
 *   - describe('block', () => { … })
 *   - it('spec', async () => { … })
 *   - beforeEach / afterEach / beforeAll / afterAll
 *   - Protractor element locators: element(by.id('x')), element(by.css('…')),
 *     $('css'), $$('css'), by.model, by.buttonText, by.linkText
 *   - Actions: .click(), .sendKeys('…'), .clear(), .submit()
 *   - Navigation: browser.get('url'), browser.navigate().to('url')
 *   - Assertions (Jasmine matchers): expect(x).toEqual('…'), .toBe(true),
 *     .toContain('…'), .toBeTruthy(), .toBeFalsy(), .toMatch(/…/), .not.toEqual(…)
 *
 * Nested describe blocks contribute a stacked "parent > child" displayName.
 * Each `it` becomes one LegacyTest whose actions/assertions are those inside
 * its callback body (does NOT inherit sibling `it` bodies).
 */

import { LegacyAction, LegacyAssertion, LegacyLocator, LegacyTest, ParsedLegacyFile } from './types';

const DESCRIBE_RE = /\bdescribe\s*\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)\s*,/;
const IT_RE = /\b(?:it|fit|specify)\s*\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)\s*,/;
const XIT_RE = /\bxit\s*\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)\s*,/;
const HOOK_RE = /\b(beforeEach|afterEach|beforeAll|afterAll)\s*\(/;

const BY_CALL_RE = /by\.(id|css|xpath|name|model|binding|buttonText|linkText|partialLinkText|tagName|repeater|cssContainingText|options|deepCss)\s*\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`]\s*\)/;
const ELEMENT_RE = /element\s*\(\s*by\.(id|css|xpath|name|model|binding|buttonText|linkText|partialLinkText|tagName)\s*\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`]\s*\)/;
const DOLLAR_RE = /\$\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`]\s*\)/;
const DOLLAR_DOLLAR_RE = /\$\$\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`]\s*\)/;

const BROWSER_GET_RE = /browser\.(?:get|navigate\(\)\.to)\s*\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`]\s*\)/;
const SEND_KEYS_RE = /\.sendKeys\s*\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`]\s*\)/;
const CLICK_RE = /\.click\s*\(\s*\)/;
const CLEAR_RE = /\.clear\s*\(\s*\)/;
const SUBMIT_RE = /\.submit\s*\(\s*\)/;

const EXPECT_EQUAL_RE = /\bexpect\s*\(\s*(.+?)\s*\)\s*\.(?:not\.)?(?:toEqual|toBe|toStrictEqual)\s*\(\s*(?:['"`]((?:[^'"`\\]|\\.)*)['"`]|(-?\d+(?:\.\d+)?)|(true|false)|null|undefined)\s*\)/;
const EXPECT_CONTAIN_RE = /\bexpect\s*\(\s*(.+?)\s*\)\s*\.(?:not\.)?toContain\s*\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`]\s*\)/;
const EXPECT_TRUTHY_RE = /\bexpect\s*\(\s*(.+?)\s*\)\s*\.(?:not\.)?toBeTruthy\s*\(\s*\)/;
const EXPECT_FALSY_RE = /\bexpect\s*\(\s*(.+?)\s*\)\s*\.(?:not\.)?toBeFalsy\s*\(\s*\)/;
const EXPECT_DEFINED_RE = /\bexpect\s*\(\s*(.+?)\s*\)\s*\.(?:not\.)?toBeDefined\s*\(\s*\)/;
const EXPECT_MATCH_RE = /\bexpect\s*\(\s*(.+?)\s*\)\s*\.(?:not\.)?toMatch\s*\(\s*['"`/]((?:[^'"`\\/]|\\.)*)['"`/]/;

// --- Callback body matcher ------------------------------------------------

/**
 * Given a source string and the index right AFTER a call opener like
 * `it("...", `, find the matching close-paren index of the enclosing `it(`
 * call. We track paren depth, string state, and template-literals so nested
 * calls don't confuse us.
 *
 * Returns { bodyStart, bodyEnd, closeParen } where bodyStart/bodyEnd bound
 * the callback source (either an arrow function body `() => {...}` or
 * `function() {…}`), and closeParen is the position of the `)` that closes
 * the outer call.
 */
function findCallbackBody(src: string, callOpenIdx: number): { bodyStart: number; bodyEnd: number; closeParen: number } | null {
    // callOpenIdx points AT the first char after the opening `(`.
    // Walk forward, tracking paren/string state, until we find our matching
    // close-paren. Along the way, remember the position of the first `{`
    // that appeared at our own paren depth 0 → that's the callback body.
    let depth = 1; // we consumed the opening ( at callOpenIdx - 1
    let inString: '"' | "'" | '`' | null = null;
    let bodyStart = -1;
    let bodyEnd = -1;
    for (let i = callOpenIdx; i < src.length; i++) {
        const c = src[i];
        const n = src[i + 1];
        if (inString) {
            if (c === '\\') { i++; continue; }
            if (c === inString) inString = null;
            continue;
        }
        if (c === '"' || c === '\'' || c === '`') { inString = c; continue; }
        if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (c === '/' && n === '*') { i += 2; while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }
        if (c === '(') { depth++; continue; }
        if (c === ')') { depth--; if (depth === 0) return { bodyStart, bodyEnd, closeParen: i }; continue; }
        if (c === '{' && depth === 1 && bodyStart === -1) {
            // First { at our depth is the arrow body.
            bodyStart = i + 1;
            const close = matchBraces(src, i);
            if (close === -1) return null;
            bodyEnd = close;
            i = close;
        }
    }
    return null;
}

function matchBraces(src: string, openIdx: number): number {
    if (src[openIdx] !== '{') return -1;
    let depth = 0;
    let inString: '"' | "'" | '`' | null = null;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i];
        const n = src[i + 1];
        if (inString) {
            if (c === '\\') { i++; continue; }
            if (c === inString) inString = null;
            continue;
        }
        if (c === '"' || c === '\'' || c === '`') { inString = c; continue; }
        if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (c === '/' && n === '*') { i += 2; while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

function lineOf(src: string, idx: number): number {
    let n = 1;
    for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') n++;
    return n;
}

function normalizeStrategy(raw: string): string {
    if (raw === 'linkText') return 'linkText';
    if (raw === 'buttonText') return 'linkText';
    return raw;
}

function scanBody(body: string, bodyStartLine: number): {
    actions: LegacyAction[]; assertions: LegacyAssertion[]; urls: string[]; warnings: string[];
} {
    const actions: LegacyAction[] = [];
    const assertions: LegacyAssertion[] = [];
    const urls: string[] = [];
    const warnings: string[] = [];
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        const lineNumber = bodyStartLine + i;

        const navMatch = BROWSER_GET_RE.exec(raw);
        if (navMatch) {
            urls.push(navMatch[1]);
            actions.push({ kind: 'navigate', value: navMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }

        let locator: LegacyLocator | undefined;
        const elemMatch = ELEMENT_RE.exec(raw);
        if (elemMatch) {
            locator = { strategy: normalizeStrategy(elemMatch[1]), value: elemMatch[2], lineNumber };
        } else {
            const byMatch = BY_CALL_RE.exec(raw);
            if (byMatch) locator = { strategy: normalizeStrategy(byMatch[1]), value: byMatch[2], lineNumber };
            else {
                const dd = DOLLAR_DOLLAR_RE.exec(raw);
                if (dd) locator = { strategy: 'css', value: dd[1], lineNumber };
                else {
                    const d = DOLLAR_RE.exec(raw);
                    if (d) locator = { strategy: 'css', value: d[1], lineNumber };
                }
            }
        }

        const skMatch = SEND_KEYS_RE.exec(raw);
        if (skMatch) { actions.push({ kind: 'sendKeys', locator, value: skMatch[1], rawLine: trimmed, lineNumber }); continue; }
        if (CLICK_RE.test(raw)) { actions.push({ kind: 'click', locator, rawLine: trimmed, lineNumber }); continue; }
        if (CLEAR_RE.test(raw)) { actions.push({ kind: 'clear', locator, rawLine: trimmed, lineNumber }); continue; }
        if (SUBMIT_RE.test(raw)) { actions.push({ kind: 'submit', locator, rawLine: trimmed, lineNumber }); continue; }

        const eqMatch = EXPECT_EQUAL_RE.exec(raw);
        if (eqMatch) {
            const expectedLiteral = eqMatch[2] !== undefined ? eqMatch[2]
                : eqMatch[3] !== undefined ? eqMatch[3]
                : eqMatch[4] !== undefined ? eqMatch[4]
                : null;
            assertions.push({ kind: 'equals', expectedLiteral, actualExpression: eqMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        const cMatch = EXPECT_CONTAIN_RE.exec(raw);
        if (cMatch) {
            assertions.push({ kind: 'contains', expectedLiteral: cMatch[2], actualExpression: cMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        const tMatch = EXPECT_TRUTHY_RE.exec(raw);
        if (tMatch) {
            assertions.push({ kind: 'true', expectedLiteral: null, actualExpression: tMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        const fMatch = EXPECT_FALSY_RE.exec(raw);
        if (fMatch) {
            assertions.push({ kind: 'false', expectedLiteral: null, actualExpression: fMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        const dMatch = EXPECT_DEFINED_RE.exec(raw);
        if (dMatch) {
            assertions.push({ kind: 'notNull', expectedLiteral: null, actualExpression: dMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        const mMatch = EXPECT_MATCH_RE.exec(raw);
        if (mMatch) {
            assertions.push({ kind: 'matches', expectedLiteral: mMatch[2], actualExpression: mMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
    }
    return { actions, assertions, urls, warnings };
}

interface StackFrame {
    describeName: string;
    beforeEach: string[];
    afterEach: string[];
    beforeAll: string[];
    afterAll: string[];
}

/**
 * Walk the source and identify every `it(...)` block, tracking nested
 * describe context so the display name is `parent > child > it text`.
 */
export function parseJasmineFile(filePath: string, source: string, framework: 'jasmine' | 'protractor' = 'jasmine'): ParsedLegacyFile {
    const tests: LegacyTest[] = [];
    const fileErrors: string[] = [];
    const stack: StackFrame[] = [];

    let i = 0;
    while (i < source.length) {
        // Detect closing `}` that pops a describe frame — approximate by tracking
        // the innermost describe's body end.
        // We do this by scanning for describe/it/hook opens in order.
        const rest = source.slice(i);
        const describeMatch = DESCRIBE_RE.exec(rest);
        const itMatch = IT_RE.exec(rest);
        const xitMatch = XIT_RE.exec(rest);
        const hookMatch = HOOK_RE.exec(rest);
        const candidates: Array<{ kind: 'describe' | 'it' | 'xit' | 'hook'; idx: number; match: RegExpExecArray }> = [];
        if (describeMatch) candidates.push({ kind: 'describe', idx: describeMatch.index, match: describeMatch });
        if (itMatch) candidates.push({ kind: 'it', idx: itMatch.index, match: itMatch });
        if (xitMatch) candidates.push({ kind: 'xit', idx: xitMatch.index, match: xitMatch });
        if (hookMatch) candidates.push({ kind: 'hook', idx: hookMatch.index, match: hookMatch });
        if (candidates.length === 0) break;
        candidates.sort((a, b) => a.idx - b.idx);
        const winner = candidates[0];
        const absoluteIdx = i + winner.idx;
        const callOpenParen = source.indexOf('(', absoluteIdx);
        if (callOpenParen === -1) { i = absoluteIdx + winner.match[0].length; continue; }

        const cb = findCallbackBody(source, callOpenParen + 1);
        if (!cb || cb.bodyStart === -1) {
            i = absoluteIdx + winner.match[0].length;
            continue;
        }
        if (winner.kind === 'describe') {
            const name = winner.match[1] || winner.match[2] || winner.match[3] || '';
            stack.push({ describeName: name, beforeEach: [], afterEach: [], beforeAll: [], afterAll: [] });
            // Re-scan the describe body top-to-bottom.
            const inner = source.slice(cb.bodyStart, cb.bodyEnd);
            const innerParsed = parseInnerBlock(filePath, inner, cb.bodyStart, source, stack, framework, fileErrors);
            tests.push(...innerParsed);
            stack.pop();
            i = cb.closeParen + 1;
            continue;
        }
        if (winner.kind === 'hook') {
            // Top-level hook — attach to a synthetic root frame if none exists.
            if (stack.length === 0) stack.push({ describeName: '', beforeEach: [], afterEach: [], beforeAll: [], afterAll: [] });
            const hookKey = winner.match[1] as 'beforeEach' | 'afterEach' | 'beforeAll' | 'afterAll';
            (stack[stack.length - 1][hookKey] as string[]).push(winner.match[1]);
            i = cb.closeParen + 1;
            continue;
        }
        if (winner.kind === 'it' || winner.kind === 'xit') {
            const label = winner.match[1] || winner.match[2] || winner.match[3] || '';
            const startLine = lineOf(source, absoluteIdx);
            const body = source.slice(cb.bodyStart, cb.bodyEnd);
            const scanned = scanBody(body, lineOf(source, cb.bodyStart));
            for (let k = 0; k < scanned.actions.length; k++) {
                if (!scanned.actions[k].locator && k > 0 && scanned.actions[k - 1].locator) {
                    scanned.actions[k].locator = scanned.actions[k - 1].locator;
                }
            }
            const displayName = [...stack.map((s) => s.describeName).filter(Boolean), label].join(' > ');
            const tags = winner.kind === 'xit' ? ['pending'] : [];
            tests.push({
                id: (displayName || label).replace(/\s+/g, '_').slice(0, 80),
                displayName: displayName || label,
                filePath, startLine,
                framework,
                tags,
                actions: scanned.actions,
                assertions: scanned.assertions,
                setupHooks: stack.flatMap((f) => [...f.beforeEach, ...f.beforeAll]),
                teardownHooks: stack.flatMap((f) => [...f.afterEach, ...f.afterAll]),
                dataRows: null,
                urlsTouched: Array.from(new Set(scanned.urls)),
                warnings: scanned.warnings,
            });
            i = cb.closeParen + 1;
            continue;
        }
        i = absoluteIdx + winner.match[0].length;
    }

    return { filePath, framework, tests, fileErrors };
}

function parseInnerBlock(
    filePath: string,
    inner: string,
    innerAbsStart: number,
    fullSource: string,
    stack: StackFrame[],
    framework: 'jasmine' | 'protractor',
    fileErrors: string[],
): LegacyTest[] {
    const tests: LegacyTest[] = [];
    let i = 0;
    while (i < inner.length) {
        const rest = inner.slice(i);
        const describeMatch = DESCRIBE_RE.exec(rest);
        const itMatch = IT_RE.exec(rest);
        const xitMatch = XIT_RE.exec(rest);
        const hookMatch = HOOK_RE.exec(rest);
        const candidates: Array<{ kind: 'describe' | 'it' | 'xit' | 'hook'; idx: number; match: RegExpExecArray }> = [];
        if (describeMatch) candidates.push({ kind: 'describe', idx: describeMatch.index, match: describeMatch });
        if (itMatch) candidates.push({ kind: 'it', idx: itMatch.index, match: itMatch });
        if (xitMatch) candidates.push({ kind: 'xit', idx: xitMatch.index, match: xitMatch });
        if (hookMatch) candidates.push({ kind: 'hook', idx: hookMatch.index, match: hookMatch });
        if (candidates.length === 0) break;
        candidates.sort((a, b) => a.idx - b.idx);
        const winner = candidates[0];
        const absoluteIdxInInner = i + winner.idx;
        const callOpenParen = inner.indexOf('(', absoluteIdxInInner);
        if (callOpenParen === -1) { i = absoluteIdxInInner + winner.match[0].length; continue; }
        const cb = findCallbackBody(inner, callOpenParen + 1);
        if (!cb || cb.bodyStart === -1) {
            i = absoluteIdxInInner + winner.match[0].length;
            continue;
        }
        if (winner.kind === 'describe') {
            const name = winner.match[1] || winner.match[2] || winner.match[3] || '';
            stack.push({ describeName: name, beforeEach: [], afterEach: [], beforeAll: [], afterAll: [] });
            const nestedInner = inner.slice(cb.bodyStart, cb.bodyEnd);
            const nested = parseInnerBlock(filePath, nestedInner, innerAbsStart + cb.bodyStart, fullSource, stack, framework, fileErrors);
            tests.push(...nested);
            stack.pop();
            i = cb.closeParen + 1;
            continue;
        }
        if (winner.kind === 'hook') {
            const hookKind = winner.match[1] as keyof StackFrame;
            if (stack.length > 0 && Array.isArray(stack[stack.length - 1][hookKind])) {
                (stack[stack.length - 1][hookKind] as string[]).push(hookKind);
            }
            i = cb.closeParen + 1;
            continue;
        }
        if (winner.kind === 'it' || winner.kind === 'xit') {
            const label = winner.match[1] || winner.match[2] || winner.match[3] || '';
            const startLine = lineOf(fullSource, innerAbsStart + absoluteIdxInInner);
            const body = inner.slice(cb.bodyStart, cb.bodyEnd);
            const bodyStartLineAbs = lineOf(fullSource, innerAbsStart + cb.bodyStart);
            const scanned = scanBody(body, bodyStartLineAbs);
            for (let k = 0; k < scanned.actions.length; k++) {
                if (!scanned.actions[k].locator && k > 0 && scanned.actions[k - 1].locator) {
                    scanned.actions[k].locator = scanned.actions[k - 1].locator;
                }
            }
            const displayName = [...stack.map((s) => s.describeName).filter(Boolean), label].join(' > ');
            const tags = winner.kind === 'xit' ? ['pending'] : [];
            tests.push({
                id: (displayName || label).replace(/\s+/g, '_').slice(0, 80),
                displayName: displayName || label,
                filePath, startLine,
                framework,
                tags,
                actions: scanned.actions,
                assertions: scanned.assertions,
                setupHooks: stack.flatMap((f) => [...f.beforeEach, ...f.beforeAll]),
                teardownHooks: stack.flatMap((f) => [...f.afterEach, ...f.afterAll]),
                dataRows: null,
                urlsTouched: Array.from(new Set(scanned.urls)),
                warnings: scanned.warnings,
            });
            i = cb.closeParen + 1;
            continue;
        }
        i = absoluteIdxInInner + winner.match[0].length;
    }
    return tests;
}

export function looksLikeJasmineFile(source: string): boolean {
    return /\bdescribe\s*\(/.test(source) && /\bit\s*\(/.test(source);
}

export function looksLikeProtractorFile(source: string): boolean {
    return /\bbrowser\.(?:get|navigate)\(/.test(source) || /\belement\s*\(\s*by\./.test(source) || /\bprotractor\.(?:by|element|browser)/.test(source);
}
