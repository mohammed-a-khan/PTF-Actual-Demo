/**
 * Tier-1 formatting validator.
 *
 * Given the TextItem[] the field extractor picked and the SimpleFormattingRule
 * declared on the spec, returns a list of format-drift findings. Every rule
 * is opt-in — no rule declared means no check performed.
 *
 * Signal sources:
 *   - Bold/italic: `TextItem.fontName` regex (matches CSLineClusterer's
 *     convention: `/bold|black|heavy/i` + `/italic|oblique/i`).
 *   - Font size: `TextItem.fontSize`.
 *   - Casing / currencyPrefix / parenNegative: raw string of the joined value.
 *   - Alignment: item x-position relative to the value's own x-span.
 *
 * @module report-validation/CSReportSimpleFormattingValidator
 */

import type { TextItem } from './CSReportPdfTypes';
import type { SimpleFormattingRule } from './CSReportSimpleSpec';

export interface FormattingFinding {
    /** Machine-readable classification. Consumers filter/group on this. */
    kind:
        | 'FORMAT_BOLD_DRIFT'
        | 'FORMAT_ITALIC_DRIFT'
        | 'FORMAT_FONT_SIZE_DRIFT'
        | 'FORMAT_CASE_DRIFT'
        | 'FORMAT_CURRENCY_PREFIX_DRIFT'
        | 'FORMAT_PAREN_NEGATIVE_DRIFT'
        | 'FORMAT_ALIGNMENT_DRIFT';
    fieldName: string;
    /** Human-readable one-sentence explanation. */
    message: string;
    /** Expected value (rule side). */
    expected: string;
    /** Extracted value (PDF side). */
    actual: string;
}

const BOLD_FONT_RE = /bold|black|heavy/i;
const ITALIC_FONT_RE = /italic|oblique/i;
const DEFAULT_ALIGNMENT_TOLERANCE = 4;

export function validateFormatting(
    fieldName: string,
    value: string,
    items: TextItem[],
    rule: SimpleFormattingRule,
): FormattingFinding[] {
    const findings: FormattingFinding[] = [];
    if (items.length === 0) return findings;

    if (rule.bold !== undefined) {
        const allBold = items.every((it) => BOLD_FONT_RE.test(it.fontName));
        if (rule.bold && !allBold) {
            findings.push({
                kind: 'FORMAT_BOLD_DRIFT',
                fieldName,
                message: `Field "${fieldName}" was expected BOLD but at least one text item is not (fontName: ${items.map((it) => it.fontName).join(', ')})`,
                expected: 'bold',
                actual: allBold ? 'bold' : 'not-bold',
            });
        } else if (!rule.bold && allBold) {
            findings.push({
                kind: 'FORMAT_BOLD_DRIFT',
                fieldName,
                message: `Field "${fieldName}" was expected NOT bold but every text item is bold`,
                expected: 'not-bold',
                actual: 'bold',
            });
        }
    }

    if (rule.italic !== undefined) {
        const allItalic = items.every((it) => ITALIC_FONT_RE.test(it.fontName));
        if (rule.italic && !allItalic) {
            findings.push({
                kind: 'FORMAT_ITALIC_DRIFT',
                fieldName,
                message: `Field "${fieldName}" was expected italic but at least one text item is not (fontName: ${items.map((it) => it.fontName).join(', ')})`,
                expected: 'italic',
                actual: 'not-italic',
            });
        } else if (!rule.italic && allItalic) {
            findings.push({
                kind: 'FORMAT_ITALIC_DRIFT',
                fieldName,
                message: `Field "${fieldName}" was expected NOT italic but every text item is italic`,
                expected: 'not-italic',
                actual: 'italic',
            });
        }
    }

    if (rule.fontSize) {
        const sizes = items.map((it) => it.fontSize);
        const min = Math.min(...sizes);
        const max = Math.max(...sizes);
        if (rule.fontSize.exact !== undefined) {
            const off = sizes.some((s) => Math.abs(s - rule.fontSize!.exact!) > 0.5);
            if (off) {
                findings.push({
                    kind: 'FORMAT_FONT_SIZE_DRIFT',
                    fieldName,
                    message: `Field "${fieldName}" expected font-size ${rule.fontSize.exact}pt exact, got range [${min.toFixed(1)}, ${max.toFixed(1)}]`,
                    expected: `${rule.fontSize.exact}pt`,
                    actual: `[${min.toFixed(1)}, ${max.toFixed(1)}]pt`,
                });
            }
        } else {
            if (rule.fontSize.min !== undefined && min < rule.fontSize.min) {
                findings.push({
                    kind: 'FORMAT_FONT_SIZE_DRIFT',
                    fieldName,
                    message: `Field "${fieldName}" expected font-size ≥ ${rule.fontSize.min}pt, got ${min.toFixed(1)}pt`,
                    expected: `≥ ${rule.fontSize.min}pt`,
                    actual: `${min.toFixed(1)}pt`,
                });
            }
            if (rule.fontSize.max !== undefined && max > rule.fontSize.max) {
                findings.push({
                    kind: 'FORMAT_FONT_SIZE_DRIFT',
                    fieldName,
                    message: `Field "${fieldName}" expected font-size ≤ ${rule.fontSize.max}pt, got ${max.toFixed(1)}pt`,
                    expected: `≤ ${rule.fontSize.max}pt`,
                    actual: `${max.toFixed(1)}pt`,
                });
            }
        }
    }

    if (rule.casing) {
        const alphaOnly = value.replace(/[^A-Za-z]/g, '');
        if (alphaOnly.length > 0) {
            let ok = true;
            switch (rule.casing) {
                case 'upper':
                    ok = alphaOnly === alphaOnly.toUpperCase();
                    break;
                case 'lower':
                    ok = alphaOnly === alphaOnly.toLowerCase();
                    break;
                case 'title':
                    ok = value.split(/\s+/).every((w) => w.length === 0 || /^[A-Z]/.test(w) && w.slice(1) === w.slice(1).toLowerCase());
                    break;
            }
            if (!ok) {
                findings.push({
                    kind: 'FORMAT_CASE_DRIFT',
                    fieldName,
                    message: `Field "${fieldName}" expected ${rule.casing} case, got "${value}"`,
                    expected: rule.casing,
                    actual: value,
                });
            }
        }
    }

    if (rule.currencyPrefix) {
        // Allow whitespace between prefix and rest of value.
        const stripped = value.replace(/\s+/g, ' ').trim();
        const prefix = rule.currencyPrefix;
        const prefixed = stripped.startsWith(prefix) || stripped.startsWith(`(${prefix}`);
        if (!prefixed) {
            findings.push({
                kind: 'FORMAT_CURRENCY_PREFIX_DRIFT',
                fieldName,
                message: `Field "${fieldName}" expected currency prefix "${prefix}", got "${stripped}"`,
                expected: `starts with "${prefix}"`,
                actual: stripped,
            });
        }
    }

    if (rule.parenNegative === true) {
        // Only flag when the value IS negative but uses leading-minus instead of paren-wrap.
        const trimmed = value.trim();
        const isMinusNegative = /^-\s*[\$£€¥]?[\d,]/.test(trimmed);
        if (isMinusNegative) {
            findings.push({
                kind: 'FORMAT_PAREN_NEGATIVE_DRIFT',
                fieldName,
                message: `Field "${fieldName}" expected accounting-paren negatives, got minus-prefix "${trimmed}"`,
                expected: '(1,234.56)',
                actual: trimmed,
            });
        }
    }

    if (rule.alignment) {
        const tol = rule.alignmentTolerance ?? DEFAULT_ALIGNMENT_TOLERANCE;
        // Value's own x-span.
        const leftEdge = Math.min(...items.map((it) => it.x));
        const rightEdge = Math.max(...items.map((it) => it.x + it.width));
        const width = rightEdge - leftEdge;
        // Alignment is inferred by where the picked items cluster relative to their own span.
        // For SINGLE-token values there's no meaningful alignment — skip.
        if (items.length > 1) {
            const midpoint = (leftEdge + rightEdge) / 2;
            const itemMidpoints = items.map((it) => it.x + it.width / 2);
            const avgMidpoint = itemMidpoints.reduce((s, m) => s + m, 0) / itemMidpoints.length;
            const distanceFromMid = Math.abs(avgMidpoint - midpoint);
            const distanceFromLeft = Math.abs(items[0].x - leftEdge);
            const distanceFromRight = Math.abs(items[items.length - 1].x + items[items.length - 1].width - rightEdge);
            let inferred: 'left' | 'right' | 'center';
            if (distanceFromMid <= tol && distanceFromMid < distanceFromLeft && distanceFromMid < distanceFromRight) {
                inferred = 'center';
            } else if (distanceFromRight <= tol && distanceFromRight < distanceFromLeft) {
                inferred = 'right';
            } else {
                inferred = 'left';
            }
            if (inferred !== rule.alignment) {
                findings.push({
                    kind: 'FORMAT_ALIGNMENT_DRIFT',
                    fieldName,
                    message: `Field "${fieldName}" expected ${rule.alignment}-aligned, inferred ${inferred}-aligned (width=${width.toFixed(1)})`,
                    expected: rule.alignment,
                    actual: inferred,
                });
            }
        }
    }

    return findings;
}
