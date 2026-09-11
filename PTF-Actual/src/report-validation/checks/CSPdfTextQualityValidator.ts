/**
 * PDF text-quality validator (§23).
 *
 * Catches text-layer defects that are usually bugs in the report generator,
 * not real data:
 *
 *   1. Placeholder-token leakage — `{{name}}`, `${date}`, `<%= x %>` reaching
 *      customer-facing output because the template renderer failed.
 *   2. Encoding sanity — replacement chars `�`, Windows-1252 double-encoding
 *      like `Â£` (`Â` + literal £ where the source was UTF-8 £), stray control
 *      characters.
 *   3. PII regex leakage — SSN, credit-card, IBAN patterns in a context that
 *      should never contain them (e.g. a footer, a summary that should show
 *      aggregate totals).
 *
 * All patterns are configurable — this validator ships defensive defaults but
 * consumer can add/remove/replace via the rule block.
 *
 * @module report-validation/checks/CSPdfTextQualityValidator
 */

import type { PageContent } from '../CSReportPdfTypes';

export interface TextQualityRule {
    /** Custom placeholder regex list. Default: Mustache/Handlebars/EJS/ERB/shell templates. */
    placeholderPatterns?: string[];
    /** Disable placeholder scan entirely. */
    disablePlaceholderScan?: boolean;
    /** Custom mojibake patterns. Default: `�` + common UTF-8-mis-decoded-as-Windows-1252 sequences. */
    encodingPatterns?: string[];
    /** Disable encoding-sanity scan. */
    disableEncodingScan?: boolean;
    /** PII patterns to scan for. Default: SSN (US), 16-digit credit-card, IBAN. */
    piiPatterns?: string[];
    /** Disable PII scan entirely. */
    disablePiiScan?: boolean;
    /** Allow-list of concrete strings to ignore even if they match a PII pattern (e.g. sample test data). */
    piiAllowList?: string[];
}

export interface TextQualityFinding {
    kind: 'PLACEHOLDER_LEAK' | 'ENCODING_ARTIFACT' | 'PII_LEAK';
    message: string;
    page: number;
    /** The exact matched substring. */
    match: string;
}

const DEFAULT_PLACEHOLDER_PATTERNS = [
    '\\{\\{\\s*[A-Za-z_][A-Za-z0-9_.]*\\s*\\}\\}',   // Mustache / Handlebars
    '\\$\\{\\s*[A-Za-z_][A-Za-z0-9_.]*\\s*\\}',       // Template literals / shell
    '<%[=\\-]?\\s*[A-Za-z_][A-Za-z0-9_. ]*\\s*[\\-]?%>', // EJS / ERB
    '#\\{\\s*[A-Za-z_][A-Za-z0-9_.]*\\s*\\}',         // Ruby-string interpolation
];

const DEFAULT_ENCODING_PATTERNS = [
    '\\uFFFD',                       // replacement char
    'Â[£¥€§©®°±¢]',                   // UTF-8-mis-decoded-as-1252
    '[\\u0001-\\u0008\\u000B\\u000E-\\u001F]', // stray control chars (excluding TAB, LF, CR)
];

const DEFAULT_PII_PATTERNS = [
    '\\b\\d{3}-\\d{2}-\\d{4}\\b',                       // US SSN
    '\\b(?:\\d[ -]?){13,19}\\b',                        // Credit-card-shaped 13-19 digit runs
    // IBAN: 2 country letters + 2 check digits + 11-30 body chars = 15-34 total.
    // Note: 4-char body is too loose — it matches security identifiers like ISIN
    // codes (e.g. LX212219 = LU-listed security, 8 chars) which are common in
    // fund reports. Real IBANs are 15+ chars.
    '\\b[A-Z]{2}\\d{2}[A-Z0-9]{11,30}\\b',              // IBAN
];

export function validateTextQuality(pages: PageContent[], rule: TextQualityRule): TextQualityFinding[] {
    const findings: TextQualityFinding[] = [];

    const placeholderRes = compilePatterns(
        rule.disablePlaceholderScan ? [] : rule.placeholderPatterns ?? DEFAULT_PLACEHOLDER_PATTERNS,
    );
    const encodingRes = compilePatterns(
        rule.disableEncodingScan ? [] : rule.encodingPatterns ?? DEFAULT_ENCODING_PATTERNS,
    );
    const piiRes = compilePatterns(
        rule.disablePiiScan ? [] : rule.piiPatterns ?? DEFAULT_PII_PATTERNS,
    );
    const allow = new Set(rule.piiAllowList ?? []);

    for (const page of pages) {
        // Join tokens into one page string for regex efficiency — bounded and safe.
        const pageText = page.textItems.map((t) => t.str).join(' ');
        for (const re of placeholderRes) {
            const m = pageText.match(re);
            if (m) {
                findings.push({
                    kind: 'PLACEHOLDER_LEAK',
                    message: `Page ${page.pageNumber} contains unrendered placeholder "${m[0]}"`,
                    page: page.pageNumber,
                    match: m[0],
                });
            }
        }
        for (const re of encodingRes) {
            const m = pageText.match(re);
            if (m) {
                findings.push({
                    kind: 'ENCODING_ARTIFACT',
                    message: `Page ${page.pageNumber} contains encoding artefact "${JSON.stringify(m[0])}"`,
                    page: page.pageNumber,
                    match: m[0],
                });
            }
        }
        for (const re of piiRes) {
            let match: RegExpExecArray | null;
            const gRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
            while ((match = gRe.exec(pageText)) !== null) {
                if (allow.has(match[0])) continue;
                // For credit-card-shaped hits, filter obvious non-cards (all-same-digit runs, etc.).
                if (/^(\d)\1+$/.test(match[0].replace(/[ -]/g, ''))) continue;
                findings.push({
                    kind: 'PII_LEAK',
                    message: `Page ${page.pageNumber} contains PII-shaped substring "${match[0]}"`,
                    page: page.pageNumber,
                    match: match[0],
                });
            }
        }
    }
    return findings;
}

function compilePatterns(list: string[]): RegExp[] {
    const out: RegExp[] = [];
    for (const p of list) {
        try {
            out.push(new RegExp(p));
        } catch {
            /* malformed pattern silently dropped */
        }
    }
    return out;
}
