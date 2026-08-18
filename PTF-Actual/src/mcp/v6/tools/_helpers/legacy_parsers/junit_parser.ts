/**
 * junit_parser — extract Selenium-JUnit test facts from a `.java` file.
 *
 * Handles both JUnit 4 (`org.junit.Test`) and JUnit 5 (`org.junit.jupiter.api.Test`).
 * Emits one `LegacyTest` per @Test-annotated method. For each test body we
 * scan every source line for:
 *
 *   - By.<strategy>("value")            → LegacyLocator
 *   - driver.findElement(By.…).click()  → LegacyAction (click)
 *   - .sendKeys("literal")              → LegacyAction (sendKeys) with the exact literal
 *   - .clear()                          → LegacyAction (clear)
 *   - .submit()                         → LegacyAction (submit)
 *   - driver.get("url") / navigate().to → LegacyAction (navigate)
 *   - Select ... selectByVisibleText    → LegacyAction (select)
 *   - Assert.assert*(expected, actual)  → LegacyAssertion
 *   - assertThat(actual, is(…))         → LegacyAssertion
 *   - assertEquals / assertTrue etc     → LegacyAssertion
 *
 * The parser is intentionally regex-driven (no tree-sitter) so the migration
 * tool has zero runtime dependency chain. Malformed Java is tolerated —
 * unmatched braces yield a `fileErrors` entry and any tests we could still
 * scope-close are emitted.
 */

import * as path from 'path';
import { LegacyAction, LegacyAssertion, LegacyDataRow, LegacyLocator, LegacyTest, ParsedLegacyFile } from './types';

const TEST_ANN_RE = /@Test(?:\s*\(([^)]*)\))?/;
const DISPLAY_NAME_RE = /@DisplayName\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/;
const TAG_ANN_RE = /@Tag\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g;
const BEFORE_EACH_RE = /@(?:BeforeEach|Before)\b(?!Class|All)/;
const AFTER_EACH_RE = /@(?:AfterEach|After)\b(?!Class|All)/;
const BEFORE_ALL_RE = /@(?:BeforeAll|BeforeClass)\b/;
const AFTER_ALL_RE = /@(?:AfterAll|AfterClass)\b/;
const METHOD_HEADER_RE = /(?<=[\s;}]|^)(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:void|[\w<>,?]+)\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:throws\s[^{]+)?\{/;

const BY_CALL_RE = /By\.(id|css|cssSelector|xpath|name|className|linkText|partialLinkText|tagName)\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/;
const DRIVER_GET_RE = /(?:driver|browser|webDriver|wd)\.(?:get|navigate\(\)\.to)\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/;
const SEND_KEYS_RE = /\.sendKeys\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/;
const CLICK_RE = /\.click\s*\(\s*\)/;
const CLEAR_RE = /\.clear\s*\(\s*\)/;
const SUBMIT_RE = /\.submit\s*\(\s*\)/;
const SELECT_TEXT_RE = /\.selectByVisibleText\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/;
const SELECT_VALUE_RE = /\.selectByValue\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/;

const ASSERT_EQUALS_RE = /\b(?:Assert(?:ions)?\.)?assertEquals\s*\(\s*("((?:[^"\\]|\\.)*)"|[^,)]+?)\s*,\s*(.+?)\s*\)\s*;/;
const ASSERT_TRUE_RE = /\b(?:Assert(?:ions)?\.)?assertTrue\s*\(\s*(.+?)\s*(?:,\s*"((?:[^"\\]|\\.)*)")?\s*\)\s*;/;
const ASSERT_FALSE_RE = /\b(?:Assert(?:ions)?\.)?assertFalse\s*\(\s*(.+?)\s*(?:,\s*"((?:[^"\\]|\\.)*)")?\s*\)\s*;/;
const ASSERT_NULL_RE = /\b(?:Assert(?:ions)?\.)?assertNull\s*\(\s*(.+?)\s*\)\s*;/;
const ASSERT_NOTNULL_RE = /\b(?:Assert(?:ions)?\.)?assertNotNull\s*\(\s*(.+?)\s*\)\s*;/;
const ASSERT_THAT_EQUAL_RE = /assertThat\s*\(\s*(.+?)\s*,\s*(?:is|equalTo|equals?)\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/;
const ASSERT_THAT_CONTAINS_RE = /assertThat\s*\(\s*(.+?)\s*,\s*(?:containsString|hasItem)\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/;

interface ScannedMethod {
    name: string;
    displayName: string | null;
    tags: string[];
    isTest: boolean;
    beforeEach: boolean;
    afterEach: boolean;
    beforeAll: boolean;
    afterAll: boolean;
    startLine: number;
    body: string;
    bodyStartLine: number;
}

/** Match paired braces starting at position `openIdx` in `src`. Returns close index or -1. */
function matchBraces(src: string, openIdx: number): number {
    if (src[openIdx] !== '{') return -1;
    let depth = 0;
    let inString: '"' | "'" | null = null;
    let inLineComment = false;
    let inBlockComment = false;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i];
        const next = src[i + 1];
        if (inLineComment) {
            if (c === '\n') inLineComment = false;
            continue;
        }
        if (inBlockComment) {
            if (c === '*' && next === '/') { inBlockComment = false; i++; }
            continue;
        }
        if (inString) {
            if (c === '\\') { i++; continue; }
            if (c === inString) inString = null;
            continue;
        }
        if (c === '/' && next === '/') { inLineComment = true; i++; continue; }
        if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
        if (c === '"' || c === '\'') { inString = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function lineOf(src: string, idx: number): number {
    let n = 1;
    for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') n++;
    return n;
}

function scanMethods(src: string, fileErrors: string[]): ScannedMethod[] {
    const out: ScannedMethod[] = [];
    // Walk the file looking for method-header regex. To decide if the method
    // is a test / hook, look at the annotation block immediately preceding
    // the header (up to a blank line or another method close-brace).
    let cursor = 0;
    while (cursor < src.length) {
        const rest = src.slice(cursor);
        const headerMatch = METHOD_HEADER_RE.exec(rest);
        if (!headerMatch) break;
        const headerIdxLocal = headerMatch.index;
        const headerIdxAbs = cursor + headerIdxLocal;
        // Find the { at the end of the match relative to whole file
        const openBraceAbs = cursor + headerIdxLocal + headerMatch[0].length - 1;
        if (src[openBraceAbs] !== '{') { cursor = openBraceAbs + 1; continue; }

        // Grab the annotation block above.
        const blockStart = (() => {
            let i = headerIdxAbs - 1;
            let seenNonAnn = false;
            while (i >= 0) {
                const ch = src[i];
                if (ch === '\n') {
                    // check if this line was blank or annotation-only
                    let ls = i - 1;
                    while (ls > 0 && src[ls] !== '\n') ls--;
                    const line = src.slice(ls + 1, i).trim();
                    if (line === '' || line.startsWith('@') || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) {
                        i = ls;
                        if (line === '' && seenNonAnn) return ls + 1;
                        if (line.startsWith('@')) seenNonAnn = true;
                        continue;
                    } else {
                        return ls + 1;
                    }
                }
                i--;
            }
            return 0;
        })();
        const annBlock = src.slice(blockStart, headerIdxAbs);

        const name = headerMatch[1];
        const isTest = TEST_ANN_RE.test(annBlock);
        const beforeEach = BEFORE_EACH_RE.test(annBlock);
        const afterEach = AFTER_EACH_RE.test(annBlock);
        const beforeAll = BEFORE_ALL_RE.test(annBlock);
        const afterAll = AFTER_ALL_RE.test(annBlock);

        // Skip constructors: name matches the enclosing class token pattern? We only care about methods.
        const dispMatch = DISPLAY_NAME_RE.exec(annBlock);
        const displayName = dispMatch ? dispMatch[1] : null;
        const tags: string[] = [];
        let tm: RegExpExecArray | null;
        const tagsRe = new RegExp(TAG_ANN_RE.source, 'g');
        while ((tm = tagsRe.exec(annBlock)) !== null) tags.push(tm[1]);

        const closeIdx = matchBraces(src, openBraceAbs);
        if (closeIdx === -1) {
            fileErrors.push(`unmatched-braces starting near line ${lineOf(src, openBraceAbs)}`);
            cursor = openBraceAbs + 1;
            continue;
        }
        const body = src.slice(openBraceAbs + 1, closeIdx);
        out.push({
            name, displayName, tags, isTest, beforeEach, afterEach, beforeAll, afterAll,
            startLine: lineOf(src, headerIdxAbs),
            body,
            bodyStartLine: lineOf(src, openBraceAbs),
        });
        cursor = closeIdx + 1;
    }
    return out;
}

/** Normalise the JUnit strategy names into the shared LegacyLocator strategy vocabulary. */
function normalizeStrategy(raw: string): string {
    if (raw === 'cssSelector') return 'css';
    return raw;
}

function scanBody(body: string, bodyStartLine: number): {
    actions: LegacyAction[];
    assertions: LegacyAssertion[];
    urls: string[];
    warnings: string[];
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

        // URL navigation.
        const navMatch = DRIVER_GET_RE.exec(raw);
        if (navMatch) {
            urls.push(navMatch[1]);
            actions.push({ kind: 'navigate', value: navMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }

        // Locate By(...) on this line (may or may not have an interaction chained).
        const byMatch = BY_CALL_RE.exec(raw);
        const locator: LegacyLocator | undefined = byMatch ? {
            strategy: normalizeStrategy(byMatch[1]),
            value: byMatch[2],
            lineNumber,
        } : undefined;

        // sendKeys — always paired with a locator, even if the locator sits on a previous line via chaining.
        const skMatch = SEND_KEYS_RE.exec(raw);
        if (skMatch) {
            actions.push({ kind: 'sendKeys', locator, value: skMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        const stMatch = SELECT_TEXT_RE.exec(raw);
        if (stMatch) {
            actions.push({ kind: 'select', locator, value: stMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        const svMatch = SELECT_VALUE_RE.exec(raw);
        if (svMatch) {
            actions.push({ kind: 'select', locator, value: svMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        if (CLICK_RE.test(raw)) {
            actions.push({ kind: 'click', locator, rawLine: trimmed, lineNumber });
            continue;
        }
        if (CLEAR_RE.test(raw)) {
            actions.push({ kind: 'clear', locator, rawLine: trimmed, lineNumber });
            continue;
        }
        if (SUBMIT_RE.test(raw)) {
            actions.push({ kind: 'submit', locator, rawLine: trimmed, lineNumber });
            continue;
        }

        // Assertions.
        const aeMatch = ASSERT_EQUALS_RE.exec(raw);
        if (aeMatch) {
            const expectedLiteral = aeMatch[2] ?? null;
            const actualExpression = aeMatch[3];
            assertions.push({ kind: 'equals', expectedLiteral, actualExpression, rawLine: trimmed, lineNumber });
            continue;
        }
        const atMatch = ASSERT_TRUE_RE.exec(raw);
        if (atMatch) {
            assertions.push({ kind: 'true', expectedLiteral: null, actualExpression: atMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        const afMatch = ASSERT_FALSE_RE.exec(raw);
        if (afMatch) {
            assertions.push({ kind: 'false', expectedLiteral: null, actualExpression: afMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        const nlMatch = ASSERT_NULL_RE.exec(raw);
        if (nlMatch) {
            assertions.push({ kind: 'null', expectedLiteral: null, actualExpression: nlMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        const nnMatch = ASSERT_NOTNULL_RE.exec(raw);
        if (nnMatch) {
            assertions.push({ kind: 'notNull', expectedLiteral: null, actualExpression: nnMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        const teMatch = ASSERT_THAT_EQUAL_RE.exec(raw);
        if (teMatch) {
            assertions.push({ kind: 'equals', expectedLiteral: teMatch[2], actualExpression: teMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        const tcMatch = ASSERT_THAT_CONTAINS_RE.exec(raw);
        if (tcMatch) {
            assertions.push({ kind: 'contains', expectedLiteral: tcMatch[2], actualExpression: tcMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
    }
    return { actions, assertions, urls, warnings };
}

/**
 * Read a Java file and return every discovered @Test method as LegacyTest.
 */
export function parseJunitFile(filePath: string, source: string): ParsedLegacyFile {
    const fileErrors: string[] = [];
    const methods = scanMethods(source, fileErrors);

    // Setup / teardown method names — attach to every test in the file.
    const setupHooks = methods.filter((m) => m.beforeEach || m.beforeAll).map((m) => m.name);
    const teardownHooks = methods.filter((m) => m.afterEach || m.afterAll).map((m) => m.name);

    const tests: LegacyTest[] = [];
    for (const m of methods) {
        if (!m.isTest) continue;
        const bodyScan = scanBody(m.body, m.bodyStartLine);
        // Merge locator across chained calls: an action with no locator that
        // immediately follows another action carrying a locator inherits it —
        // approximates the common Java pattern of splitting `driver.findElement(By.id(x))` and
        // `.click()` onto two lines.
        for (let i = 0; i < bodyScan.actions.length; i++) {
            if (!bodyScan.actions[i].locator && i > 0 && bodyScan.actions[i - 1].locator) {
                bodyScan.actions[i].locator = bodyScan.actions[i - 1].locator;
            }
        }
        tests.push({
            id: m.name,
            displayName: m.displayName || humaniseMethodName(m.name),
            filePath,
            startLine: m.startLine,
            framework: 'selenium-junit',
            tags: m.tags,
            actions: bodyScan.actions,
            assertions: bodyScan.assertions,
            setupHooks,
            teardownHooks,
            dataRows: null,
            urlsTouched: Array.from(new Set(bodyScan.urls)),
            warnings: bodyScan.warnings,
        });
    }
    return { filePath, framework: 'selenium-junit', tests, fileErrors };
}

export function humaniseMethodName(name: string): string {
    // Strip common test prefixes then split camelCase / snake_case.
    let t = name.replace(/^(?:test|should|verify|check)/i, '');
    if (!t) t = name;
    t = t.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
    if (t.length === 0) return name;
    return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Convenience so the migrate tool can decide "is this file Selenium-JUnit?" from a filename. */
export function looksLikeJunitFile(source: string): boolean {
    return /import\s+org\.junit\.(?:Test|jupiter\.api\.Test)\b/.test(source)
        || (/@Test\b/.test(source) && /import\s+org\.openqa\.selenium/.test(source));
}

/** Legacy JUnit tests never carry DataProvider — always null. */
export function junitDataRows(): LegacyDataRow | null {
    return null;
}

// Re-export path util to keep call sites tidy — no external re-import.
export const _pathUtil = path;
