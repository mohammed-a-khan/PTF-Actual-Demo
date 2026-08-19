/**
 * CS Report Validation — Footing check (printed total vs sum of extracted rows).
 *
 * The one integrity check a report can run against ITSELF, and the only one that catches a
 * silently truncated extraction. Drop the last page of a PDF and the printed totals row
 * is usually still there — it is rendered once, at the end of the section, and whether it
 * survives has nothing to do with whether the rows above it did. The sum of what was
 * extracted falls away; the printed figure does not. Cross-side checksum agreement is blind
 * to this, because both sides can be truncated identically and two identical wrong numbers
 * still agree.
 *
 * WHAT IS CHECKED
 * ---------------
 * Only `<sectionId>.<field>` keys already present in `meta.checksums` — that is, columns the
 * REPORT ITSELF printed a total for. This is deliberately self-limiting: by printing a total
 * under a column, the report asserts that the column is summable. Nothing is invented for
 * columns the report chose not to foot, so a price or rate column is never summed unless the
 * report did so first.
 *
 * Even then, `spec.footingIgnoreFields` exists because some reports print a WEIGHTED AVERAGE
 * (or a count, or a max) in the totals band under a numeric column. Those are not sums, and
 * asserting them as sums would be a false failure on a perfectly good report.
 *
 * TOLERANCE
 * ---------
 * Drift here is not measurement error. Reports commonly foot from unrounded values while
 * printing each row rounded to 2dp, so the discrepancy grows with ROW COUNT — up to half a
 * cent per row, in either direction. A flat absolute tolerance either fails every long
 * section or is loosened until it no longer catches a dropped page. `spec.footingTolerance`
 * is therefore `absolute + perRow × rowCount`.
 *
 * PURE FUNCTION
 * -------------
 * No I/O, no reporter side effects. Deterministic ordering by checksum key. Kept standalone
 * (not folded into the reconciler) so it is independently testable, and so it can be run
 * against a SINGLE report — there is no second side involved in footing.
 *
 * @module report-validation/CSReportFootingValidator
 */

import type { CanonicalReport, Finding } from './CSReportModel';
import type { ReportSpec } from './CSReportSpec';

/** Default footing tolerance: one cent, no per-row allowance. Specs opt into rounding drift. */
const DEFAULT_FOOTING = { absolute: 0.01, perRow: 0 };

/**
 * Resolve `spec.footingTolerance` into its two components. A bare number is shorthand for an
 * absolute-only tolerance, which is what most specs want and what every pre-existing spec
 * gets by default.
 */
function footingToleranceOf(spec: ReportSpec): { absolute: number; perRow: number } {
    const raw = spec.footingTolerance;
    if (raw === undefined) return { ...DEFAULT_FOOTING };
    if (typeof raw === 'number') return { absolute: raw, perRow: 0 };
    return {
        absolute: raw.absolute ?? DEFAULT_FOOTING.absolute,
        perRow: raw.perRow ?? DEFAULT_FOOTING.perRow,
    };
}

/**
 * Check every printed total on `canonical` against the rows extracted beneath it.
 *
 * @param canonical The report to check. Only this one — footing is single-sided.
 * @param spec      Supplies `footingTolerance` and `footingIgnoreFields`.
 * @returns `FOOTING_MISMATCH` findings, ordered by checksum key. Empty when the report
 *          prints no totals, which is common and is not itself a problem — the coverage gate
 *          is what asserts that something was compared.
 */
export function validateFooting(canonical: CanonicalReport, spec: ReportSpec): Finding[] {
    const checksums = canonical.meta.checksums ?? {};
    const ignore = new Set(spec.footingIgnoreFields ?? []);
    const { absolute, perRow } = footingToleranceOf(spec);
    const findings: Finding[] = [];

    for (const key of Object.keys(checksums).sort()) {
        // Only section-scoped totals can be footed: a bare `<field>` key is a report-level
        // figure with no defined set of rows underneath it.
        const dot = key.indexOf('.');
        if (dot <= 0) continue;
        const sectionId = key.slice(0, dot);
        const field = key.slice(dot + 1);
        if (ignore.has(field) || ignore.has(key)) continue;

        const printed = checksums[key];
        if (typeof printed !== 'number' || !Number.isFinite(printed)) continue;

        const rows = canonical.records.filter((r) => r.sectionId === sectionId);

        // A total printed over a section that yielded NO rows is the truncation signature
        // itself, so it is reported rather than skipped — unless the printed figure is zero,
        // where there is genuinely nothing to tell apart.
        let sum = 0;
        let contributing = 0;
        for (const row of rows) {
            const value = row.fields[field];
            if (value && value.kind === 'number') {
                sum += value.value;
                contributing++;
            }
        }

        // The field was never extracted anywhere in the section: that is a mapping gap, and
        // `CSReportCoverageValidator` reports it with a far more actionable message than
        // "your total is off by the whole total" would be. Staying quiet here avoids two
        // findings for one cause.
        if (contributing === 0 && printed !== 0 && rows.length > 0) continue;

        const tolerance = absolute + perRow * rows.length;
        const delta = sum - printed;
        if (Math.abs(delta) <= tolerance) continue;

        findings.push({
            id: footingFindingId(canonical.source, key),
            classification: 'FOOTING_MISMATCH',
            section: sectionId,
            key: { footing: key },
            field,
            aValue: { kind: 'number', value: printed, raw: String(printed) },
            bValue: { kind: 'number', value: sum, raw: String(sum) },
            delta,
            reason:
                `${canonical.source}: section "${sectionId}" prints a total of ${printed} for "${field}", ` +
                `but the ${contributing} extracted row(s) sum to ${roundForMessage(sum)} ` +
                `(delta ${roundForMessage(delta)}, tolerance ${roundForMessage(tolerance)}). ` +
                (rows.length === 0
                    ? 'No rows were extracted from that section at all — the extraction lost the section body.'
                    : 'Either rows are missing from the extraction, or the report foots from unrounded ' +
                      'values — raise spec.footingTolerance.perRow if the drift scales with row count.'),
        });
    }
    return findings;
}

/** Stable id so the same drift keeps the same finding id across runs. */
function footingFindingId(source: string, key: string): string {
    let hash = 0;
    const text = `footing|${source}|${key}`;
    for (let i = 0; i < text.length; i++) {
        hash = (hash * 31 + text.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Trim float noise out of user-facing numbers without hiding a real sub-cent difference. */
function roundForMessage(value: number): number {
    return Math.round(value * 1e6) / 1e6;
}
