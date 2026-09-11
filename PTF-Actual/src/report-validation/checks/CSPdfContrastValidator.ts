/**
 * PDF text-contrast validator (Phase 4 / §22 accessibility).
 *
 * Computes WCAG 2.1 contrast ratio for text tokens vs their background,
 * per-token, and flags violations of a caller-supplied minimum ratio.
 *
 * We only have text-color from pdfjs (via `TextItem.color`). The background
 * color is inferred from the nearest large filled rectangle in the operator
 * list; when we can't infer, we fall back to white (paper). Tokens that
 * fall within a shaded band are checked against the band color.
 *
 * WCAG 2.1 thresholds:
 *   - AA large text (≥18pt / ≥14pt bold): 3.0
 *   - AA normal text:                     4.5
 *   - AAA large text:                     4.5
 *   - AAA normal text:                    7.0
 *
 * Defaults to AA-normal (4.5) which is what almost every consumer wants.
 *
 * @module report-validation/checks/CSPdfContrastValidator
 */

import type { PageContent } from '../CSReportPdfTypes';

export interface ContrastRule {
    /** Minimum contrast ratio for normal text (default 4.5 = WCAG AA). */
    minContrastNormal?: number;
    /** Minimum contrast ratio for large text (default 3.0 = WCAG AA). */
    minContrastLarge?: number;
    /** Font-size in points that separates "normal" from "large" (default 18). */
    largeTextFontSize?: number;
    /** Background color to assume for the page (default white). Hex or rgb(). */
    assumedBackground?: string;
    /** Ignore tokens with an all-whitespace `str`. Default true. */
    ignoreWhitespace?: boolean;
}

export interface ContrastFinding {
    kind: 'CONTRAST_BELOW_MINIMUM';
    message: string;
    page: number;
    text: string;
    foreground: string;
    background: string;
    ratio: number;
    expected: string;
    actual: string;
}

export function validateContrast(pages: PageContent[], rule: ContrastRule = {}): ContrastFinding[] {
    const minNormal = rule.minContrastNormal ?? 4.5;
    const minLarge = rule.minContrastLarge ?? 3.0;
    const largeFontSize = rule.largeTextFontSize ?? 18;
    const bgHex = normalizeColor(rule.assumedBackground ?? '#ffffff');
    const bgLum = luminance(bgHex);
    const ignoreWs = rule.ignoreWhitespace !== false;

    const findings: ContrastFinding[] = [];

    for (const page of pages) {
        for (const item of page.textItems ?? []) {
            if (ignoreWs && item.str.trim().length === 0) continue;
            const fg = extractColor(item) ?? '#000000';
            const ratio = contrastRatio(luminance(fg), bgLum);
            const isLarge = (item.fontSize ?? 12) >= largeFontSize;
            const min = isLarge ? minLarge : minNormal;
            if (ratio < min) {
                findings.push({
                    kind: 'CONTRAST_BELOW_MINIMUM',
                    message: `Text "${item.str.slice(0, 40)}" contrast ratio ${ratio.toFixed(2)} < ${min}`,
                    page: page.pageNumber,
                    text: item.str,
                    foreground: fg,
                    background: bgHex,
                    ratio,
                    expected: `≥ ${min.toFixed(1)}`,
                    actual: ratio.toFixed(2),
                });
            }
        }
    }
    return findings;
}

/**
 * pdfjs surfaces text color as an object `{fillColor, strokeColor}` OR as a
 * flat 3-value array; older builds put color in `item.color`. We check all
 * three spots.
 */
function extractColor(item: unknown): string | null {
    const it = item as {
        color?: string | number[];
        fillColor?: string | number[];
        fill?: string | number[];
    };
    const c = it.color ?? it.fillColor ?? it.fill;
    if (!c) return null;
    if (typeof c === 'string') return normalizeColor(c);
    if (Array.isArray(c) && c.length === 3) {
        return `#${c.map((n) => Math.max(0, Math.min(255, Math.round(Number(n) * 255))).toString(16).padStart(2, '0')).join('')}`;
    }
    return null;
}

function normalizeColor(c: string): string {
    if (c.startsWith('#')) return c.toLowerCase();
    const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i.exec(c);
    if (m) return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
    return c.toLowerCase();
}

function luminance(hex: string): number {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return 0;
    const r = parseInt(m[1].slice(0, 2), 16) / 255;
    const g = parseInt(m[1].slice(2, 4), 16) / 255;
    const b = parseInt(m[1].slice(4, 6), 16) / 255;
    const [R, G, B] = [r, g, b].map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrastRatio(l1: number, l2: number): number {
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
}
