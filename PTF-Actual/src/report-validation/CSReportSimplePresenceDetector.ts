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
    if (!spec.presenceOfText || spec.meansValue === undefined || spec.elseValue === undefined) {
        throw new Error('detectPresence called on non-presence field spec');
    }
    const needle = spec.presenceOfText.toLowerCase();
    for (const page of tokensByPage) {
        for (const t of page) {
            if (t.str.toLowerCase().includes(needle)) {
                return spec.meansValue;
            }
        }
    }
    return spec.elseValue;
}
