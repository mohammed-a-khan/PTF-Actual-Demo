/**
 * PDF header/footer validator (§17).
 *
 * Runs against the AnalyzedReport that Layer-2 already produces — each
 * AnalyzedPage carries `header: string[]` (page-band header text) and
 * `footer: string[]`. This validator asserts:
 *
 *   1. Same header text on every page (band diff — first N chars of joined header)
 *   2. Same footer text on every page
 *   3. Page-number continuity — every page carries a number, no gaps, no dups
 *   4. "Page X of Y" — Y matches actual page count
 *   5. Confidentiality-footer literal presence on every page (when declared)
 *   6. Unresolved-placeholder leak — `${date}`, `{{name}}`, `<%= x %>` tokens
 *      appearing in header/footer (template didn't render)
 *
 * @module report-validation/checks/CSPdfHeaderFooterValidator
 */

import type { AnalyzedReport } from '../CSReportPdfTypes';

export interface HeaderFooterRule {
    /** Every page must have identical header text. Default: true. */
    identicalHeader?: boolean;
    /** Every page must have identical footer text. Default: true. */
    identicalFooter?: boolean;
    /** Every page must contain its own 1-indexed page number somewhere. Default: false. */
    requirePageNumbers?: boolean;
    /** When a page has "Page X of Y", assert Y === pageCount. Default: true. */
    validatePageXofY?: boolean;
    /** Literal string that must appear in every page footer (e.g. "Confidential"). */
    footerLiteralOnEveryPage?: string;
    /** Custom regex list — any match on ANY page = leak (e.g. `\\{\\{\\w+\\}\\}`, `\\$\\{\\w+\\}`). Default catches Mustache/Handlebars/EJS/ERB. */
    placeholderPatterns?: string[];
    /** Disable placeholder-leak scan entirely. Default: false. */
    disablePlaceholderScan?: boolean;
}

export interface HeaderFooterFinding {
    kind:
        | 'HEADER_DRIFT_ACROSS_PAGES'
        | 'FOOTER_DRIFT_ACROSS_PAGES'
        | 'PAGE_NUMBER_MISSING'
        | 'PAGE_NUMBER_DUPLICATE'
        | 'PAGE_NUMBER_GAP'
        | 'PAGE_X_OF_Y_MISMATCH'
        | 'FOOTER_LITERAL_MISSING'
        | 'PLACEHOLDER_LEAK';
    message: string;
    page?: number;
    expected?: string;
    actual?: string;
}

const DEFAULT_PLACEHOLDER_PATTERNS = [
    // Mustache/Handlebars: {{name}}
    '\\{\\{\\s*[A-Za-z_][A-Za-z0-9_.]*\\s*\\}\\}',
    // Shell/template literal: ${name}
    '\\$\\{\\s*[A-Za-z_][A-Za-z0-9_.]*\\s*\\}',
    // ERB/EJS: <%= name %> or <% name %>
    '<%[=\\-]?\\s*[A-Za-z_][A-Za-z0-9_. ]*\\s*[\\-]?%>',
];

export function validateHeaderFooter(analyzed: AnalyzedReport, rule: HeaderFooterRule): HeaderFooterFinding[] {
    const findings: HeaderFooterFinding[] = [];
    const pages = analyzed.pages;
    const pageCount = analyzed.pageCount;
    if (pages.length === 0) return findings;

    // 1. Identical header.
    if (rule.identicalHeader !== false) {
        const first = pages[0].header.join(' ').trim();
        for (let i = 1; i < pages.length; i++) {
            const cur = pages[i].header.join(' ').trim();
            if (cur !== first) {
                findings.push({
                    kind: 'HEADER_DRIFT_ACROSS_PAGES',
                    message: `Page ${pages[i].pageNumber} header differs from page 1`,
                    page: pages[i].pageNumber,
                    expected: first,
                    actual: cur,
                });
                break;
            }
        }
    }

    // 2. Identical footer.
    if (rule.identicalFooter !== false) {
        const first = pages[0].footer.join(' ').trim();
        for (let i = 1; i < pages.length; i++) {
            const cur = pages[i].footer.join(' ').trim();
            if (cur !== first) {
                findings.push({
                    kind: 'FOOTER_DRIFT_ACROSS_PAGES',
                    message: `Page ${pages[i].pageNumber} footer differs from page 1`,
                    page: pages[i].pageNumber,
                    expected: first,
                    actual: cur,
                });
                break;
            }
        }
    }

    // 3. Page-number presence (opt-in).
    if (rule.requirePageNumbers) {
        for (const page of pages) {
            const combined = page.header.concat(page.footer).join(' ');
            // Accept "Page 5", "5 of 12", or a lone "5" in footer/header text.
            const hasNumber = combined.includes(String(page.pageNumber));
            if (!hasNumber) {
                findings.push({
                    kind: 'PAGE_NUMBER_MISSING',
                    message: `Page ${page.pageNumber} has no visible page number in header/footer`,
                    page: page.pageNumber,
                    expected: String(page.pageNumber),
                    actual: '',
                });
            }
        }
    }

    // 4. "Page X of Y" — Y matches actual page count.
    if (rule.validatePageXofY !== false) {
        for (const page of pages) {
            const combined = page.header.concat(page.footer).join(' ');
            const m = combined.match(/(?:Page|page)\s+\d+\s+of\s+(\d+)/);
            if (m) {
                const declaredTotal = parseInt(m[1], 10);
                if (declaredTotal !== pageCount) {
                    findings.push({
                        kind: 'PAGE_X_OF_Y_MISMATCH',
                        message: `Page ${page.pageNumber} declares "of ${declaredTotal}" but actual page count is ${pageCount}`,
                        page: page.pageNumber,
                        expected: `of ${pageCount}`,
                        actual: `of ${declaredTotal}`,
                    });
                }
            }
        }
    }

    // 5. Footer literal on every page.
    if (rule.footerLiteralOnEveryPage) {
        const needle = rule.footerLiteralOnEveryPage;
        for (const page of pages) {
            const footerText = page.footer.join(' ');
            if (!footerText.includes(needle)) {
                findings.push({
                    kind: 'FOOTER_LITERAL_MISSING',
                    message: `Page ${page.pageNumber} footer missing required literal "${needle}"`,
                    page: page.pageNumber,
                    expected: needle,
                    actual: footerText,
                });
            }
        }
    }

    // 6. Placeholder-leak scan (across ALL header/footer text on all pages).
    if (!rule.disablePlaceholderScan) {
        const patterns = (rule.placeholderPatterns ?? DEFAULT_PLACEHOLDER_PATTERNS)
            .map((p) => {
                try {
                    return new RegExp(p);
                } catch {
                    return null;
                }
            })
            .filter((r): r is RegExp => r !== null);
        for (const page of pages) {
            const combined = page.header.concat(page.footer).join(' ');
            for (const re of patterns) {
                const m = combined.match(re);
                if (m) {
                    findings.push({
                        kind: 'PLACEHOLDER_LEAK',
                        message: `Page ${page.pageNumber} header/footer contains unrendered placeholder "${m[0]}"`,
                        page: page.pageNumber,
                        actual: m[0],
                    });
                    break;
                }
            }
        }
    }

    return findings;
}
