/**
 * CSLocatorParser - extract locator declarations from TypeScript source.
 *
 * We don't pull in the TypeScript compiler API for this — it would be the
 * right tool if we needed to understand types, but here we only need to
 * find:
 *
 *   @CSGetElement({ ...options }) / @CSGetElements({...}) / @CSElement(...)
 *   page.locator('...')
 *
 * A small balanced-brace / balanced-paren scanner is more than enough,
 * boots in milliseconds against a thousand-file suite, and has no
 * dependency footprint.
 *
 * Limitations (documented, not bugs):
 *  - We don't follow string concatenation across variables. `xpath:
 *    BASE + '/foo'` is reported with the literal piece we can see.
 *  - Template literals are read with `${...}` placeholders kept verbatim;
 *    the scorer is told what it sees.
 *
 * @module locator-lint
 */

import * as fs from 'fs';
import * as path from 'path';
import { DecoratorBlock } from './CSLocatorTypes';

export interface RawLocatorCall {
    file: string;
    line: number;
    column: number;
    value: string;
}

export interface ParseResult {
    file: string;
    decorators: DecoratorBlock[];
    rawCalls: RawLocatorCall[];
}

const DECORATOR_HEADS = ['@CSGetElement', '@CSGetElements', '@CSElement', '@CSElements'];

const OPTION_KEYS = new Set([
    'id', 'testId', 'name', 'role', 'label', 'placeholder',
    'title', 'alt', 'text', 'className', 'css', 'xpath',
]);

export function parseFile(absPath: string, repoRoot: string): ParseResult {
    const file = path.relative(repoRoot, absPath).split(path.sep).join('/');
    const src = fs.readFileSync(absPath, 'utf-8');

    return {
        file,
        decorators: extractDecorators(src, file),
        rawCalls: extractRawLocatorCalls(src, file),
    };
}

// ============================================================================
// Decorator scanner
// ============================================================================

function extractDecorators(src: string, file: string): DecoratorBlock[] {
    const blocks: DecoratorBlock[] = [];
    for (const head of DECORATOR_HEADS) {
        let from = 0;
        while (true) {
            const idx = src.indexOf(head, from);
            if (idx === -1) break;
            from = idx + head.length;

            // Must be followed (possibly with whitespace) by '('
            const parenStart = skipWs(src, from);
            if (src[parenStart] !== '(') continue;

            // Inside the parens, find the opening '{' of the options object.
            const objStart = findObjectStart(src, parenStart + 1);
            if (objStart === -1) continue;
            const objEnd = findMatchingBrace(src, objStart);
            if (objEnd === -1) continue;

            const body = src.slice(objStart + 1, objEnd);
            const decLine = lineNumber(src, idx);
            const block: DecoratorBlock = {
                file, line: decLine, body,
                options: extractOptions(body, src, objStart + 1),
                alternatives: extractAlternatives(body, src, objStart + 1),
            };
            blocks.push(block);
            from = objEnd + 1;
        }
    }
    return blocks;
}

function extractOptions(body: string, src: string, bodyOffset: number): DecoratorBlock['options'] {
    const out: DecoratorBlock['options'] = [];
    // top-level `key: 'value'` pairs only — skip into nested braces/brackets
    let i = 0;
    while (i < body.length) {
        // Skip whitespace, commas
        while (i < body.length && /[\s,]/.test(body[i])) i++;
        if (i >= body.length) break;

        // Skip line / block comments
        if (body.startsWith('//', i)) { while (i < body.length && body[i] !== '\n') i++; continue; }
        if (body.startsWith('/*', i)) { i = body.indexOf('*/', i); if (i === -1) break; i += 2; continue; }

        // Read identifier key
        const keyMatch = body.slice(i).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
        if (!keyMatch) {
            // Not a key — skip to next comma or end at this depth
            i = skipToNextComma(body, i);
            continue;
        }
        const key = keyMatch[1];
        const keyStart = i;
        i += keyMatch[0].length;
        // Skip whitespace
        while (i < body.length && /\s/.test(body[i])) i++;

        // Read value — only handle string literals & template literals; for
        // arrays/objects we just skip over them at this point. Alternatives
        // are picked up separately.
        if (body[i] === "'" || body[i] === '"' || body[i] === '`') {
            const quote = body[i];
            const valStart = i + 1;
            i++;
            while (i < body.length) {
                if (body[i] === '\\') { i += 2; continue; }
                if (body[i] === quote) break;
                i++;
            }
            const value = body.slice(valStart, i);
            i++; // past closing quote
            if (OPTION_KEYS.has(key)) {
                const absPos = bodyOffset + keyStart;
                out.push({ key, value, line: lineNumber(src, absPos), column: columnNumber(src, absPos) });
            }
        } else {
            // Skip non-string values (arrays, objects, identifiers, numbers)
            i = skipValue(body, i);
        }
    }
    return out;
}

function extractAlternatives(body: string, src: string, bodyOffset: number): DecoratorBlock['alternatives'] {
    const out: DecoratorBlock['alternatives'] = [];
    const m = body.match(/alternativeLocators\s*:\s*\[/);
    if (!m) return out;
    const arrStart = body.indexOf('[', m.index!);
    const arrEnd = findMatchingBracket(body, arrStart);
    if (arrEnd === -1) return out;
    const arrBody = body.slice(arrStart + 1, arrEnd);

    // Pull every string literal at the top level of the array
    const re = /(['"`])((?:\\.|(?!\1).)*?)\1/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(arrBody)) !== null) {
        const offset = bodyOffset + arrStart + 1 + mm.index;
        out.push({
            value: mm[2],
            line: lineNumber(src, offset),
            column: columnNumber(src, offset),
        });
    }
    return out;
}

// ============================================================================
// Raw page.locator() calls
// ============================================================================

function extractRawLocatorCalls(src: string, file: string): RawLocatorCall[] {
    const out: RawLocatorCall[] = [];
    // Match `<receiver>.locator(` where receiver looks like `page`,
    // `this.page`, `popup`, etc. We deliberately do not match
    // CSWebElement instance calls — those aren't "raw".
    const re = /\b(?:this\.)?(?:page|popup|frame|newPage|context\.page|browserContext)\s*\.\s*locator\s*\(\s*(['"`])((?:\\.|(?!\1).)*?)\1/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
        const offset = m.index;
        out.push({
            file,
            line: lineNumber(src, offset),
            column: columnNumber(src, offset),
            value: m[2],
        });
    }
    return out;
}

// ============================================================================
// Tiny scanning utilities
// ============================================================================

function skipWs(s: string, i: number): number {
    while (i < s.length && /\s/.test(s[i])) i++;
    return i;
}

function findObjectStart(s: string, from: number): number {
    let depth = 0;
    let i = from;
    while (i < s.length) {
        const c = s[i];
        if (c === '{' && depth === 0) return i;
        if (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') depth--;
        else if (c === "'" || c === '"' || c === '`') i = skipString(s, i);
        i++;
        if (depth < 0) return -1;
    }
    return -1;
}

function findMatchingBrace(s: string, openIdx: number): number {
    return findMatching(s, openIdx, '{', '}');
}

function findMatchingBracket(s: string, openIdx: number): number {
    return findMatching(s, openIdx, '[', ']');
}

function findMatching(s: string, openIdx: number, open: string, close: string): number {
    let depth = 0;
    let i = openIdx;
    while (i < s.length) {
        const c = s[i];
        if (c === "'" || c === '"' || c === '`') { i = skipString(s, i); continue; }
        if (s.startsWith('//', i)) { while (i < s.length && s[i] !== '\n') i++; continue; }
        if (s.startsWith('/*', i)) { const j = s.indexOf('*/', i); i = j === -1 ? s.length : j + 2; continue; }
        if (c === open) depth++;
        else if (c === close) { depth--; if (depth === 0) return i; }
        i++;
    }
    return -1;
}

function skipString(s: string, i: number): number {
    const q = s[i];
    i++;
    while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === q) return i + 1;
        if (q === '`' && s.startsWith('${', i)) {
            // Template literal expression
            const end = findMatchingBrace(s, s.indexOf('{', i));
            if (end === -1) return s.length;
            i = end + 1; continue;
        }
        i++;
    }
    return i;
}

function skipValue(body: string, i: number): number {
    // Skip a top-level value until the next comma at depth 0 (or end).
    let depth = 0;
    while (i < body.length) {
        const c = body[i];
        if (c === "'" || c === '"' || c === '`') { i = skipString(body, i); continue; }
        if (c === '{' || c === '[' || c === '(') depth++;
        else if (c === '}' || c === ']' || c === ')') {
            if (depth === 0) return i;
            depth--;
        } else if (c === ',' && depth === 0) return i;
        i++;
    }
    return i;
}

function skipToNextComma(body: string, i: number): number {
    return skipValue(body, i) + 1;
}

function lineNumber(src: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
    return line;
}

function columnNumber(src: string, offset: number): number {
    let col = 1;
    for (let i = offset - 1; i >= 0; i--) {
        if (src[i] === '\n') break;
        col++;
    }
    return col;
}
