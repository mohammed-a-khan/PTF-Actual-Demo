/**
 * page_object_parser — parse a CSBasePage-style TypeScript file into a list
 * of {propertyName, description, primaryXpath, primaryCss, alternativeLocators}
 * WITHOUT pulling in the TypeScript compiler.
 *
 * Approach: balanced-brace scanning around each `@CSGetElement({ … })`
 * decorator. That handles nested objects (frame:{…}) and multi-line
 * definitions correctly. String option extraction uses a small helper
 * that understands single, double, and template literals (no
 * interpolation).
 *
 * Also emits the raw options body verbatim so the sync-locators tool can
 * do a text-level Edit to rewrite only the changed lines — never a full
 * file regeneration.
 */

import * as fs from 'fs';

export interface CSGetElementRecord {
    propertyName: string;
    decorator: '@CSGetElement' | '@CSGetElements';
    /** Character offset of the opening `{` of the options object. */
    optionsStart: number;
    /** Character offset one past the closing `}` of the options object. */
    optionsEnd: number;
    /** Full raw text between `{` and `}` (trimmed). */
    optionsRaw: string;
    /** Character offset of the ')' closing the decorator call. */
    afterDecoratorParen: number;

    // Parsed options — undefined when the attribute is absent.
    xpath?: string;
    css?: string;
    id?: string;
    testId?: string;
    name?: string;
    ariaLabel?: string;
    placeholder?: string;
    role?: string;
    text?: string;
    label?: string;
    description?: string;
    selfHeal?: boolean;
    waitForVisible?: boolean;
    alternativeLocators: string[];
    tags: string[];
}

export interface PageObjectFile {
    filePath: string;
    /** The parsed class name — e.g. "LoginPage". */
    className?: string;
    /** The parent class — should be CSBasePage / CSFramePage. */
    parentClass?: string;
    /** Value inside @CSPage('…'). */
    csPageSlug?: string;
    /** URL string when the file defines `protected url = '…'` or `super.navigate('…')`. */
    inferredUrl?: string;
    /** Full source, kept so callers can do surgical edits. */
    source: string;
    elements: CSGetElementRecord[];
    warnings: string[];
}

// -------------------------------------------------------------------------
// Small string/attr helpers.
// -------------------------------------------------------------------------

function extractStringOption(optStr: string, key: string): string | undefined {
    const re = new RegExp(`\\b${key}\\s*:\\s*(?:'([^'\\\\]*(?:\\\\.[^'\\\\]*)*)'|"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"|\`([^\`\\\\]*(?:\\\\.[^\`\\\\]*)*)\`)`);
    const m = optStr.match(re);
    if (!m) return undefined;
    const raw = m[1] ?? m[2] ?? m[3];
    // Decode common escapes we may have emitted (\\' \\" \\\\).
    return raw.replace(/\\(['"`\\])/g, '$1');
}

function extractBoolOption(optStr: string, key: string): boolean | undefined {
    const re = new RegExp(`\\b${key}\\s*:\\s*(true|false)\\b`);
    const m = optStr.match(re);
    return m ? m[1] === 'true' : undefined;
}

function extractArrayStringOption(optStr: string, key: string): string[] {
    // Match the array bracket and grab its content (non-greedy to first `]`).
    // Nested arrays are rare here — the CSGetElement schema uses flat arrays.
    const re = new RegExp(`\\b${key}\\s*:\\s*\\[([\\s\\S]*?)\\]`);
    const m = optStr.match(re);
    if (!m) return [];
    const inner = m[1];
    const items: string[] = [];
    const itemRe = /(?:'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`)/g;
    let im: RegExpExecArray | null;
    while ((im = itemRe.exec(inner)) !== null) {
        const raw = im[1] ?? im[2] ?? im[3] ?? '';
        items.push(raw.replace(/\\(['"`\\])/g, '$1'));
    }
    return items;
}

/** Given source text and the index of an opening brace, return the index of its matching closing brace, ignoring braces inside string/template literals. */
function findMatchingCloseBrace(src: string, openIdx: number): number {
    let depth = 0;
    let i = openIdx;
    while (i < src.length) {
        const ch = src[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            const quote = ch;
            i++;
            while (i < src.length && src[i] !== quote) {
                if (src[i] === '\\') i += 2;
                else i++;
            }
            i++;
            continue;
        }
        if (ch === '/' && src[i + 1] === '/') {
            // line comment
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if (ch === '/' && src[i + 1] === '*') {
            i += 2;
            while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return i;
        }
        i++;
    }
    return -1;
}

// -------------------------------------------------------------------------
// Public parse API.
// -------------------------------------------------------------------------

export function parsePageObjectFile(filePath: string): PageObjectFile {
    const source = fs.readFileSync(filePath, 'utf-8');
    const warnings: string[] = [];

    const classMatch = source.match(/export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+([A-Za-z][A-Za-z0-9_]*)/);
    const className = classMatch?.[1];
    const parentClass = classMatch?.[2];

    if (!parentClass || !/CSBasePage|CSFramePage/.test(parentClass)) {
        warnings.push(`File does not extend CSBasePage / CSFramePage (found parent: ${parentClass ?? 'none'}) — element extraction may be incomplete.`);
    }

    const csPageMatch = source.match(/@CSPage\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/);
    const csPageSlug = csPageMatch?.[1];

    // Try to infer a live URL from either `super.navigate('...')` or `protected url = '...'`.
    let inferredUrl: string | undefined;
    const navCall = source.match(/super\.navigate\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/);
    if (navCall) inferredUrl = navCall[1];
    if (!inferredUrl) {
        const superNavCfg = source.match(/super\.navigate\s*\(\s*this\.config\.get\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\)/);
        if (superNavCfg) inferredUrl = `\${${superNavCfg[1]}}`;
    }
    if (!inferredUrl) {
        const urlProp = source.match(/protected\s+url\s*[:=]\s*['"`]([^'"`]+)['"`]/);
        if (urlProp) inferredUrl = urlProp[1];
    }

    const elements: CSGetElementRecord[] = [];
    const decoratorRe = /@(CSGetElements?)\s*\(\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = decoratorRe.exec(source)) !== null) {
        const decorator = ('@' + m[1]) as '@CSGetElement' | '@CSGetElements';
        const openBraceIdx = m.index + m[0].length - 1; // points at `{`
        const closeBraceIdx = findMatchingCloseBrace(source, openBraceIdx);
        if (closeBraceIdx < 0) { warnings.push(`Unmatched braces at char ${openBraceIdx} — decorator skipped.`); continue; }
        const optionsRaw = source.slice(openBraceIdx + 1, closeBraceIdx).trim();
        // Advance to the ')' after `}`
        let paren = closeBraceIdx + 1;
        while (paren < source.length && source[paren] !== ')') paren++;
        if (paren >= source.length) { warnings.push(`Unclosed decorator call after char ${closeBraceIdx} — decorator skipped.`); continue; }
        const afterParen = paren + 1;

        // Find the next property declaration
        const rest = source.slice(afterParen);
        const propMatch = rest.match(/^\s*(?:\n\s*)?(?:(?:public|private|protected|readonly|override|declare|static)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)/);
        if (!propMatch) { warnings.push(`No property found after decorator at char ${afterParen} — decorator skipped.`); continue; }
        const propertyName = propMatch[1];
        // Skip reserved method-name matches
        if (propertyName === 'initializeElements' || propertyName === 'constructor') continue;

        elements.push({
            propertyName,
            decorator,
            optionsStart: openBraceIdx + 1,
            optionsEnd: closeBraceIdx,
            optionsRaw,
            afterDecoratorParen: afterParen,
            xpath: extractStringOption(optionsRaw, 'xpath'),
            css: extractStringOption(optionsRaw, 'css'),
            id: extractStringOption(optionsRaw, 'id'),
            testId: extractStringOption(optionsRaw, 'testId'),
            name: extractStringOption(optionsRaw, 'name'),
            ariaLabel: extractStringOption(optionsRaw, 'ariaLabel'),
            placeholder: extractStringOption(optionsRaw, 'placeholder'),
            role: extractStringOption(optionsRaw, 'role'),
            text: extractStringOption(optionsRaw, 'text'),
            label: extractStringOption(optionsRaw, 'label'),
            description: extractStringOption(optionsRaw, 'description'),
            selfHeal: extractBoolOption(optionsRaw, 'selfHeal'),
            waitForVisible: extractBoolOption(optionsRaw, 'waitForVisible'),
            alternativeLocators: extractArrayStringOption(optionsRaw, 'alternativeLocators'),
            tags: extractArrayStringOption(optionsRaw, 'tags'),
        });
    }

    return { filePath, className, parentClass, csPageSlug, inferredUrl, source, elements, warnings };
}

/**
 * Emit a modified source string where a specific element's primary xpath is
 * replaced. Uses text-level substring replace with the balanced-brace
 * offsets we captured — no full-file regeneration.
 *
 * When `newAlternative` is supplied, the primary xpath is promoted to the
 * suggested alternative and the OLD xpath is appended to alternativeLocators
 * (bumped ahead of any existing entries) so a future auto-heal has a
 * hint if the alternative also breaks.
 */
export function rewritePrimaryXpath(source: string, el: CSGetElementRecord, newXpath: string, moveOldToAlternatives: boolean): string {
    const optsRaw = el.optionsRaw;
    // Replace the xpath: '…' line inside the options block.
    const xpathRe = /(\bxpath\s*:\s*)(['"`])([^'"`\\]*(?:\\.[^'"`\\]*)*)\2/;
    const escapedNew = newXpath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    let newOpts = optsRaw;
    if (xpathRe.test(optsRaw)) {
        newOpts = optsRaw.replace(xpathRe, `$1'${escapedNew}'`);
    } else {
        // No xpath present — insert one at the top of the options object.
        newOpts = `xpath: '${escapedNew}',\n        ` + optsRaw;
    }
    if (moveOldToAlternatives && el.xpath) {
        // Bump the old xpath into alternativeLocators (front of the array).
        const altRe = /(\balternativeLocators\s*:\s*)\[([\s\S]*?)\]/;
        const bumpValue = `'${el.xpath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
        if (altRe.test(newOpts)) {
            newOpts = newOpts.replace(altRe, (_full, key, inner) => {
                const trimmed = String(inner).trim();
                const list = trimmed ? `${bumpValue}, ${trimmed}` : bumpValue;
                return `${key}[${list}]`;
            });
        } else {
            newOpts = newOpts.trimEnd() + (newOpts.trimEnd().endsWith(',') ? '' : ',') + `\n        alternativeLocators: [${bumpValue}]`;
        }
    }
    // Splice back into the full source using the captured offsets.
    return source.slice(0, el.optionsStart) + newOpts + source.slice(el.optionsEnd);
}
