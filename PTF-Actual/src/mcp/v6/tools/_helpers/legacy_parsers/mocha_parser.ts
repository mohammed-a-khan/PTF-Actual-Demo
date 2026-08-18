/**
 * mocha_parser — extract Mocha test facts. Same describe/it structure as
 * Jasmine but the assertion vocabulary comes from chai, should, or the built-
 * in `assert` module:
 *
 *   expect(x).to.equal('y') / .deep.equal(…)
 *   expect(x).to.be.true / .false / .null / .undefined
 *   expect(x).to.contain('…') / .include(…)
 *   x.should.equal('y')
 *   assert.equal(actual, expected)
 *   assert.strictEqual(actual, expected)
 *   assert.deepEqual(actual, expected)
 *
 * We delegate the describe/it/hook structural scan to the same routines
 * used by the jasmine parser (they share the JS callback body pattern),
 * only overriding the assertion vocabulary.
 */

import { LegacyAction, LegacyAssertion, LegacyLocator, LegacyTest, ParsedLegacyFile } from './types';

const DESCRIBE_RE = /\bdescribe\s*\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)\s*,/;
const IT_RE = /\b(?:it|specify)\s*\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)\s*,/;
const HOOK_RE = /\b(beforeEach|afterEach|before|after)\s*\(/;

const SELENIUM_BY_RE = /By\.(id|css|cssSelector|xpath|name|className|linkText|partialLinkText|tagName)\s*\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`]\s*\)/;
const PW_LOCATOR_RE = /page\.locator\s*\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`]\s*\)/;
const DRIVER_GET_RE = /(?:driver|browser|page)\.(?:get|goto|navigate\(\)\.to)\s*\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`]\s*\)/;
const SEND_KEYS_RE = /\.(?:sendKeys|fill|type)\s*\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`]\s*\)/;
const CLICK_RE = /\.click\s*\(\s*\)/;

const CHAI_EQUAL_RE = /\bexpect\s*\(\s*(.+?)\s*\)\s*(?:\.to)?(?:\.not)?\.(?:deep\.)?(?:equal|equals|eq|eql|strictEqual)\s*\(\s*(?:['"`]((?:[^'"`\\]|\\.)*)['"`]|(-?\d+(?:\.\d+)?)|(true|false)|null|undefined)\s*\)/;
const CHAI_BE_RE = /\bexpect\s*\(\s*(.+?)\s*\)\s*\.to\.be\.(true|false|null|undefined)/;
const CHAI_INCLUDE_RE = /\bexpect\s*\(\s*(.+?)\s*\)\s*\.to(?:\.not)?\.(?:contain|include|includes)\s*\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`]\s*\)/;
const CHAI_MATCH_RE = /\bexpect\s*\(\s*(.+?)\s*\)\s*\.to(?:\.not)?\.match\s*\(\s*\/((?:[^/\\]|\\.)*)\//;
const SHOULD_EQUAL_RE = /([A-Za-z_$][\w$.]*)\.should\.(?:not\.)?(?:equal|eq)\s*\(\s*(?:['"`]((?:[^'"`\\]|\\.)*)['"`]|(-?\d+(?:\.\d+)?)|(true|false))\s*\)/;
const ASSERT_EQ_RE = /\bassert\.(?:equal|strictEqual|deepEqual)\s*\(\s*(.+?)\s*,\s*(?:['"`]((?:[^'"`\\]|\\.)*)['"`]|(-?\d+(?:\.\d+)?)|(true|false))\s*\)/;

function lineOf(src: string, idx: number): number { let n = 1; for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') n++; return n; }

function matchBraces(src: string, openIdx: number): number {
    if (src[openIdx] !== '{') return -1;
    let depth = 0;
    let inString: '"' | "'" | '`' | null = null;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i]; const n = src[i + 1];
        if (inString) { if (c === '\\') { i++; continue; } if (c === inString) inString = null; continue; }
        if (c === '"' || c === '\'' || c === '`') { inString = c; continue; }
        if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (c === '/' && n === '*') { i += 2; while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

function findCallbackBody(src: string, callOpenIdx: number): { bodyStart: number; bodyEnd: number; closeParen: number } | null {
    let depth = 1;
    let inString: '"' | "'" | '`' | null = null;
    let bodyStart = -1;
    let bodyEnd = -1;
    for (let i = callOpenIdx; i < src.length; i++) {
        const c = src[i]; const n = src[i + 1];
        if (inString) { if (c === '\\') { i++; continue; } if (c === inString) inString = null; continue; }
        if (c === '"' || c === '\'' || c === '`') { inString = c; continue; }
        if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (c === '/' && n === '*') { i += 2; while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }
        if (c === '(') { depth++; continue; }
        if (c === ')') { depth--; if (depth === 0) return { bodyStart, bodyEnd, closeParen: i }; continue; }
        if (c === '{' && depth === 1 && bodyStart === -1) {
            bodyStart = i + 1;
            const close = matchBraces(src, i);
            if (close === -1) return null;
            bodyEnd = close;
            i = close;
        }
    }
    return null;
}

function normalizeStrategy(raw: string): string { return raw === 'cssSelector' ? 'css' : raw; }

function scanBody(body: string, bodyStartLine: number): { actions: LegacyAction[]; assertions: LegacyAssertion[]; urls: string[]; warnings: string[] } {
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

        const navMatch = DRIVER_GET_RE.exec(raw);
        if (navMatch) {
            urls.push(navMatch[1]);
            actions.push({ kind: 'navigate', value: navMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        let locator: LegacyLocator | undefined;
        const byMatch = SELENIUM_BY_RE.exec(raw);
        if (byMatch) locator = { strategy: normalizeStrategy(byMatch[1]), value: byMatch[2], lineNumber };
        else {
            const pwMatch = PW_LOCATOR_RE.exec(raw);
            if (pwMatch) locator = { strategy: 'css', value: pwMatch[1], lineNumber };
        }
        const skMatch = SEND_KEYS_RE.exec(raw);
        if (skMatch) { actions.push({ kind: 'sendKeys', locator, value: skMatch[1], rawLine: trimmed, lineNumber }); continue; }
        if (CLICK_RE.test(raw)) { actions.push({ kind: 'click', locator, rawLine: trimmed, lineNumber }); continue; }

        const ceMatch = CHAI_EQUAL_RE.exec(raw);
        if (ceMatch) {
            const expected = ceMatch[2] !== undefined ? ceMatch[2]
                : ceMatch[3] !== undefined ? ceMatch[3]
                : ceMatch[4] !== undefined ? ceMatch[4]
                : null;
            assertions.push({ kind: 'equals', expectedLiteral: expected, actualExpression: ceMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        const cbMatch = CHAI_BE_RE.exec(raw);
        if (cbMatch) {
            const kind = cbMatch[2] === 'true' ? 'true'
                : cbMatch[2] === 'false' ? 'false'
                : cbMatch[2] === 'null' ? 'null'
                : 'notNull';
            assertions.push({ kind, expectedLiteral: null, actualExpression: cbMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        const ciMatch = CHAI_INCLUDE_RE.exec(raw);
        if (ciMatch) {
            assertions.push({ kind: 'contains', expectedLiteral: ciMatch[2], actualExpression: ciMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        const cmMatch = CHAI_MATCH_RE.exec(raw);
        if (cmMatch) {
            assertions.push({ kind: 'matches', expectedLiteral: cmMatch[2], actualExpression: cmMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        const shMatch = SHOULD_EQUAL_RE.exec(raw);
        if (shMatch) {
            const expected = shMatch[2] !== undefined ? shMatch[2]
                : shMatch[3] !== undefined ? shMatch[3]
                : shMatch[4] !== undefined ? shMatch[4]
                : null;
            assertions.push({ kind: 'equals', expectedLiteral: expected, actualExpression: shMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        const aeMatch = ASSERT_EQ_RE.exec(raw);
        if (aeMatch) {
            const expected = aeMatch[2] !== undefined ? aeMatch[2]
                : aeMatch[3] !== undefined ? aeMatch[3]
                : aeMatch[4] !== undefined ? aeMatch[4]
                : null;
            assertions.push({ kind: 'equals', expectedLiteral: expected, actualExpression: aeMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
    }
    return { actions, assertions, urls, warnings };
}

interface StackFrame { describeName: string; hooks: string[]; }

export function parseMochaFile(filePath: string, source: string): ParsedLegacyFile {
    const tests: LegacyTest[] = [];
    const fileErrors: string[] = [];
    const stack: StackFrame[] = [];

    function walk(inner: string, innerAbsStart: number) {
        let i = 0;
        while (i < inner.length) {
            const rest = inner.slice(i);
            const dMatch = DESCRIBE_RE.exec(rest);
            const iMatch = IT_RE.exec(rest);
            const hMatch = HOOK_RE.exec(rest);
            const cands: Array<{ kind: 'describe' | 'it' | 'hook'; idx: number; match: RegExpExecArray }> = [];
            if (dMatch) cands.push({ kind: 'describe', idx: dMatch.index, match: dMatch });
            if (iMatch) cands.push({ kind: 'it', idx: iMatch.index, match: iMatch });
            if (hMatch) cands.push({ kind: 'hook', idx: hMatch.index, match: hMatch });
            if (cands.length === 0) break;
            cands.sort((a, b) => a.idx - b.idx);
            const winner = cands[0];
            const absoluteIdx = i + winner.idx;
            const callOpenParen = inner.indexOf('(', absoluteIdx);
            if (callOpenParen === -1) { i = absoluteIdx + winner.match[0].length; continue; }
            const cb = findCallbackBody(inner, callOpenParen + 1);
            if (!cb || cb.bodyStart === -1) { i = absoluteIdx + winner.match[0].length; continue; }
            if (winner.kind === 'describe') {
                const name = winner.match[1] || winner.match[2] || winner.match[3] || '';
                stack.push({ describeName: name, hooks: [] });
                walk(inner.slice(cb.bodyStart, cb.bodyEnd), innerAbsStart + cb.bodyStart);
                stack.pop();
                i = cb.closeParen + 1;
                continue;
            }
            if (winner.kind === 'hook') {
                if (stack.length > 0) stack[stack.length - 1].hooks.push(winner.match[1]);
                i = cb.closeParen + 1;
                continue;
            }
            if (winner.kind === 'it') {
                const label = winner.match[1] || winner.match[2] || winner.match[3] || '';
                const startLine = lineOf(source, innerAbsStart + absoluteIdx);
                const body = inner.slice(cb.bodyStart, cb.bodyEnd);
                const bodyStartLineAbs = lineOf(source, innerAbsStart + cb.bodyStart);
                const scanned = scanBody(body, bodyStartLineAbs);
                for (let k = 0; k < scanned.actions.length; k++) {
                    if (!scanned.actions[k].locator && k > 0 && scanned.actions[k - 1].locator) {
                        scanned.actions[k].locator = scanned.actions[k - 1].locator;
                    }
                }
                const displayName = [...stack.map((s) => s.describeName).filter(Boolean), label].join(' > ');
                tests.push({
                    id: (displayName || label).replace(/\s+/g, '_').slice(0, 80),
                    displayName: displayName || label,
                    filePath, startLine,
                    framework: 'mocha',
                    tags: [],
                    actions: scanned.actions,
                    assertions: scanned.assertions,
                    setupHooks: stack.flatMap((s) => s.hooks.filter((h) => h.startsWith('before'))),
                    teardownHooks: stack.flatMap((s) => s.hooks.filter((h) => h.startsWith('after'))),
                    dataRows: null,
                    urlsTouched: Array.from(new Set(scanned.urls)),
                    warnings: scanned.warnings,
                });
                i = cb.closeParen + 1;
                continue;
            }
            i = absoluteIdx + winner.match[0].length;
        }
    }
    walk(source, 0);
    return { filePath, framework: 'mocha', tests, fileErrors };
}

export function looksLikeMochaFile(source: string): boolean {
    return /\bdescribe\s*\(/.test(source) && /\bit\s*\(/.test(source)
        && (/require\s*\(\s*['"](?:chai|mocha)['"]/.test(source) || /from\s+['"]chai['"]/.test(source));
}
