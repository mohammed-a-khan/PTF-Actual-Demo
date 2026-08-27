/**
 * Presence-of-text detector for state-style fields.
 *
 * When a spec field declares `presenceOfText` (e.g. `"DRAFT INVOICE - DO NOT PAY"`),
 * the detector scans the full PDF token stream for that substring and returns
 * `meansValue` on a hit, `elseValue` otherwise. Case-insensitive.
 *
 * @module report-validation/CSReportSimplePresenceDetector
 */

import type { TextItem } from './CSReportPdfTypes';
import type { SimpleFieldSpec } from './CSReportSimpleSpec';

export function detectPresence(
    tokensByPage: TextItem[][],
    spec: SimpleFieldSpec,
): string {
    if (!spec.presenceOfText) {
        throw new Error('detectPresence called on non-presence field spec');
    }
    // Defaults let consumers write terse specs: `{ "presenceOfText": "Some header text" }`
    // and assert expected value = "present" | "missing".
    const meansValue = spec.meansValue ?? 'present';
    const elseValue = spec.elseValue ?? 'missing';
    const needle = spec.presenceOfText.toLowerCase();
    for (const page of tokensByPage) {
        for (const t of page) {
            if (t.str.toLowerCase().includes(needle)) {
                return meansValue;
            }
        }
    }
    return elseValue;
}
