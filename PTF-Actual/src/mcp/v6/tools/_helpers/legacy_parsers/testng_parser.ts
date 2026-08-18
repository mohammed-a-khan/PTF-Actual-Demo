/**
 * testng_parser — extract TestNG (org.testng.annotations) test facts from Java.
 *
 * TestNG's @Test annotation carries more metadata than JUnit's:
 *
 *   @Test(description = "…", groups = {"smoke"}, dataProvider = "employees")
 *   public void createEmployee(String firstName, String lastName) { … }
 *
 *   @DataProvider(name = "employees")
 *   public Object[][] provider() { return new Object[][] { {"Ada", "Lovelace"}, … }; }
 *
 * We extract:
 *
 *   - description=..., groups=... → LegacyTest displayName / tags
 *   - dataProvider="name" + matching @DataProvider(name="name") → LegacyDataRow
 *   - @BeforeMethod / @AfterMethod / @BeforeClass / @AfterClass hooks
 *   - Same driver/assertion vocabulary as JUnit
 *
 * DataProvider extraction reads `Object[][]` literal returns and folds each
 * inner literal into a row. Non-literal providers (e.g. reading from a CSV)
 * fall back to `columns=[], rows=[]` but the tag stays so the migrator can
 * emit a placeholder Examples row and flag it for manual review.
 */

import { LegacyAction, LegacyAssertion, LegacyDataRow, LegacyTest, ParsedLegacyFile } from './types';
import { humaniseMethodName } from './junit_parser';

const TESTNG_TEST_RE = /@Test(?:\s*\(([^)]*)\))?/;
const DATA_PROVIDER_ANN_RE = /@DataProvider(?:\s*\(([^)]*)\))?/;
const BEFORE_METHOD_RE = /@BeforeMethod\b/;
const AFTER_METHOD_RE = /@AfterMethod\b/;
const BEFORE_CLASS_RE = /@BeforeClass\b/;
const AFTER_CLASS_RE = /@AfterClass\b/;
const METHOD_HEADER_RE = /(?<=[\s;}]|^)(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:void|Object\[\]\[\]|[\w<>,?]+)\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:throws\s[^{]+)?\{/;

const BY_CALL_RE = /By\.(id|css|cssSelector|xpath|name|className|linkText|partialLinkText|tagName)\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/;
const DRIVER_GET_RE = /(?:driver|browser|webDriver|wd)\.(?:get|navigate\(\)\.to)\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/;
const SEND_KEYS_RE = /\.sendKeys\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/;
const CLICK_RE = /\.click\s*\(\s*\)/;
const CLEAR_RE = /\.clear\s*\(\s*\)/;
const SUBMIT_RE = /\.submit\s*\(\s*\)/;

/** TestNG's Assert lives in org.testng.Assert — signature is `assertEquals(actual, expected)` (reversed vs JUnit!). */
const ASSERT_EQ_TESTNG_RE = /\b(?:Assert\.)?assertEquals\s*\(\s*(.+?)\s*,\s*("((?:[^"\\]|\\.)*)"|[^,)]+?)\s*\)\s*;/;
const ASSERT_TRUE_RE = /\bAssert\.assertTrue\s*\(\s*(.+?)\s*(?:,\s*"((?:[^"\\]|\\.)*)")?\s*\)\s*;/;
const ASSERT_FALSE_RE = /\bAssert\.assertFalse\s*\(\s*(.+?)\s*(?:,\s*"((?:[^"\\]|\\.)*)")?\s*\)\s*;/;
const ASSERT_NULL_RE = /\bAssert\.assertNull\s*\(\s*(.+?)\s*\)\s*;/;
const ASSERT_NOTNULL_RE = /\bAssert\.assertNotNull\s*\(\s*(.+?)\s*\)\s*;/;
const ASSERT_CONTAINS_RE = /\bAssert\.assert(?:True|Equals)\s*\(\s*(.+?)\.(?:contains|containsIgnoreCase)\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/;

interface ScannedMethod {
    name: string;
    isTest: boolean;
    testAnnArgs: string | null;
    isDataProvider: boolean;
    dataProviderName: string | null;
    beforeMethod: boolean;
    afterMethod: boolean;
    beforeClass: boolean;
    afterClass: boolean;
    startLine: number;
    body: string;
    bodyStartLine: number;
    parameterNames: string[];
}

function matchBraces(src: string, openIdx: number): number {
    if (src[openIdx] !== '{') return -1;
    let depth = 0;
    let inString: '"' | "'" | null = null;
    let inLineComment = false;
    let inBlockComment = false;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i];
        const next = src[i + 1];
        if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
        if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i++; } continue; }
        if (inString) {
            if (c === '\\') { i++; continue; }
            if (c === inString) inString = null;
            continue;
        }
        if (c === '/' && next === '/') { inLineComment = true; i++; continue; }
        if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
        if (c === '"' || c === '\'') { inString = c; continue; }
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

function extractAnnotationArg(annArgs: string, key: string): string | null {
    const re = new RegExp(`${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`);
    const m = re.exec(annArgs);
    return m ? m[1] : null;
}

function extractGroups(annArgs: string): string[] {
    const single = extractAnnotationArg(annArgs, 'groups');
    if (single) return [single];
    const bracketed = /groups\s*=\s*\{([^}]*)\}/.exec(annArgs);
    if (bracketed) {
        const items: string[] = [];
        const strRe = /"((?:[^"\\]|\\.)*)"/g;
        let m: RegExpExecArray | null;
        while ((m = strRe.exec(bracketed[1])) !== null) items.push(m[1]);
        return items;
    }
    return [];
}

function extractParameterNames(header: string): string[] {
    // Header is `<name>(<params>) …`.
    const paren = header.match(/\(([^)]*)\)/);
    if (!paren) return [];
    const raw = paren[1].trim();
    if (!raw) return [];
    return raw.split(/\s*,\s*/).map((p) => {
        const parts = p.trim().split(/\s+/);
        return parts[parts.length - 1] || '';
    }).filter(Boolean);
}

function scanMethods(src: string, fileErrors: string[]): ScannedMethod[] {
    const out: ScannedMethod[] = [];
    let cursor = 0;
    while (cursor < src.length) {
        const rest = src.slice(cursor);
        const headerMatch = METHOD_HEADER_RE.exec(rest);
        if (!headerMatch) break;
        const headerIdxAbs = cursor + headerMatch.index;
        const openBraceAbs = cursor + headerMatch.index + headerMatch[0].length - 1;
        if (src[openBraceAbs] !== '{') { cursor = openBraceAbs + 1; continue; }

        const blockStart = (() => {
            let i = headerIdxAbs - 1;
            let seenAnn = false;
            while (i >= 0) {
                const ch = src[i];
                if (ch === '\n') {
                    let ls = i - 1;
                    while (ls > 0 && src[ls] !== '\n') ls--;
                    const line = src.slice(ls + 1, i).trim();
                    if (line === '' || line.startsWith('@') || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) {
                        i = ls;
                        if (line === '' && seenAnn) return ls + 1;
                        if (line.startsWith('@')) seenAnn = true;
                        continue;
                    }
                    return ls + 1;
                }
                i--;
            }
            return 0;
        })();
        const annBlock = src.slice(blockStart, headerIdxAbs);

        const name = headerMatch[1];
        const testMatch = TESTNG_TEST_RE.exec(annBlock);
        const isTest = testMatch !== null;
        const testAnnArgs = testMatch && testMatch[1] ? testMatch[1] : null;
        const dpMatch = DATA_PROVIDER_ANN_RE.exec(annBlock);
        const isDataProvider = dpMatch !== null;
        const dataProviderName = dpMatch && dpMatch[1] ? extractAnnotationArg(dpMatch[1], 'name') : null;

        const beforeMethod = BEFORE_METHOD_RE.test(annBlock);
        const afterMethod = AFTER_METHOD_RE.test(annBlock);
        const beforeClass = BEFORE_CLASS_RE.test(annBlock);
        const afterClass = AFTER_CLASS_RE.test(annBlock);

        const closeIdx = matchBraces(src, openBraceAbs);
        if (closeIdx === -1) {
            fileErrors.push(`unmatched-braces starting near line ${lineOf(src, openBraceAbs)}`);
            cursor = openBraceAbs + 1;
            continue;
        }
        const body = src.slice(openBraceAbs + 1, closeIdx);
        out.push({
            name, isTest, testAnnArgs,
            isDataProvider, dataProviderName,
            beforeMethod, afterMethod, beforeClass, afterClass,
            startLine: lineOf(src, headerIdxAbs),
            body,
            bodyStartLine: lineOf(src, openBraceAbs),
            parameterNames: extractParameterNames(headerMatch[0]),
        });
        cursor = closeIdx + 1;
    }
    return out;
}

function normalizeStrategy(raw: string): string { return raw === 'cssSelector' ? 'css' : raw; }

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

        const navMatch = DRIVER_GET_RE.exec(raw);
        if (navMatch) {
            urls.push(navMatch[1]);
            actions.push({ kind: 'navigate', value: navMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        const byMatch = BY_CALL_RE.exec(raw);
        const locator = byMatch ? { strategy: normalizeStrategy(byMatch[1]), value: byMatch[2], lineNumber } : undefined;

        const skMatch = SEND_KEYS_RE.exec(raw);
        if (skMatch) { actions.push({ kind: 'sendKeys', locator, value: skMatch[1], rawLine: trimmed, lineNumber }); continue; }
        if (CLICK_RE.test(raw)) { actions.push({ kind: 'click', locator, rawLine: trimmed, lineNumber }); continue; }
        if (CLEAR_RE.test(raw)) { actions.push({ kind: 'clear', locator, rawLine: trimmed, lineNumber }); continue; }
        if (SUBMIT_RE.test(raw)) { actions.push({ kind: 'submit', locator, rawLine: trimmed, lineNumber }); continue; }

        // TestNG assertEquals is `(actual, expected)` — swap capture group semantics.
        const aeMatch = ASSERT_EQ_TESTNG_RE.exec(raw);
        if (aeMatch) {
            const actualExpression = aeMatch[1];
            const expectedLiteral = aeMatch[3] ?? null;
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
        const cMatch = ASSERT_CONTAINS_RE.exec(raw);
        if (cMatch) {
            assertions.push({ kind: 'contains', expectedLiteral: cMatch[2], actualExpression: cMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
    }
    return { actions, assertions, urls, warnings };
}

/**
 * Extract Object[][] literal rows from a data-provider method body.
 * Handles single-line and multi-line literals. Non-literal returns (e.g.
 * loading from CSV) yield an empty rows list — the migrator flags this.
 */
function extractDataProviderRows(body: string, columnNames: string[]): LegacyDataRow | null {
    // Look for `new Object[][] { { … }, { … } }` or `return new Object[][] { … }`.
    const arrRe = /new\s+Object\s*\[\s*\]\s*\[\s*\]\s*\{([\s\S]+?)\}\s*;/;
    const m = arrRe.exec(body);
    if (!m) return { columns: columnNames, rows: [] };
    const inner = m[1];
    // Each row is `{ v1, v2, ... }`.
    const rows: Array<Record<string, string>> = [];
    const rowRe = /\{([^{}]*)\}/g;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(inner)) !== null) {
        const cells: string[] = [];
        const cellRe = /"((?:[^"\\]|\\.)*)"|(\d+(?:\.\d+)?)|(true|false)|(null)/g;
        let cm: RegExpExecArray | null;
        while ((cm = cellRe.exec(rm[1])) !== null) {
            cells.push(cm[1] !== undefined ? cm[1] : cm[2] !== undefined ? cm[2] : cm[3] !== undefined ? cm[3] : 'null');
        }
        const row: Record<string, string> = {};
        for (let i = 0; i < cells.length; i++) {
            const colName = columnNames[i] || `col${i + 1}`;
            row[colName] = cells[i];
        }
        rows.push(row);
    }
    return { columns: columnNames, rows };
}

export function parseTestngFile(filePath: string, source: string): ParsedLegacyFile {
    const fileErrors: string[] = [];
    const methods = scanMethods(source, fileErrors);

    // Build data-provider map: name → parsed rows using the consumer's parameter names.
    const providerMethods = new Map<string, ScannedMethod>();
    for (const m of methods) {
        if (m.isDataProvider) {
            const name = m.dataProviderName || m.name;
            providerMethods.set(name, m);
        }
    }

    const setupHooks = methods.filter((m) => m.beforeMethod || m.beforeClass).map((m) => m.name);
    const teardownHooks = methods.filter((m) => m.afterMethod || m.afterClass).map((m) => m.name);

    const tests: LegacyTest[] = [];
    for (const m of methods) {
        if (!m.isTest) continue;
        const description = m.testAnnArgs ? extractAnnotationArg(m.testAnnArgs, 'description') : null;
        const groups = m.testAnnArgs ? extractGroups(m.testAnnArgs) : [];
        const providerName = m.testAnnArgs ? extractAnnotationArg(m.testAnnArgs, 'dataProvider') : null;

        let dataRows: LegacyDataRow | null = null;
        if (providerName) {
            const providerMethod = providerMethods.get(providerName);
            if (providerMethod) {
                dataRows = extractDataProviderRows(providerMethod.body, m.parameterNames);
            } else {
                dataRows = { columns: m.parameterNames, rows: [] };
            }
        }

        const bodyScan = scanBody(m.body, m.bodyStartLine);
        for (let i = 0; i < bodyScan.actions.length; i++) {
            if (!bodyScan.actions[i].locator && i > 0 && bodyScan.actions[i - 1].locator) {
                bodyScan.actions[i].locator = bodyScan.actions[i - 1].locator;
            }
        }
        tests.push({
            id: m.name,
            displayName: description || humaniseMethodName(m.name),
            filePath,
            startLine: m.startLine,
            framework: 'testng',
            tags: groups,
            actions: bodyScan.actions,
            assertions: bodyScan.assertions,
            setupHooks,
            teardownHooks,
            dataRows,
            urlsTouched: Array.from(new Set(bodyScan.urls)),
            warnings: bodyScan.warnings,
        });
    }
    return { filePath, framework: 'testng', tests, fileErrors };
}

export function looksLikeTestngFile(source: string): boolean {
    return /import\s+org\.testng\.annotations\.Test\b/.test(source)
        || (/@Test\b/.test(source) && /import\s+org\.testng\./.test(source));
}
