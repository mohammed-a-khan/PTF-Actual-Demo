/**
 * CS Report Validation — Extraction integrity via checksums.
 *
 * `CanonicalReport.meta.checksums` carries extraction-side signals that are
 * INDEPENDENT of the row-level comparison the reconciler does — per-section
 * column totals, per-report row counts, sum-of-numeric-columns, etc. When
 * they disagree across sides (or against a spec-declared expectation), the
 * downstream comparison cannot be trusted: the "MISSING" rows the reconciler
 * flagged might be genuine data bugs, or they might be the tail of a
 * silently-truncated PDF whose last page never made it into the canonical.
 *
 * This module produces `CHECKSUM_DRIFT` findings so that failure mode is
 * visible before humans start chasing phantom mismatches. `spec.enforceChecksums`
 * decides whether those findings gate the pass/fail decision or stay purely
 * informational.
 *
 * PURE FUNCTION
 * -------------
 * No I/O, no reporter side effects. Given two canonicals and a spec, returns
 * a Finding[] deterministically ordered by (checksumKey). Kept standalone
 * (not folded into the reconciler) so it's independently testable.
 *
 * @module report-validation/CSReportChecksumValidator
 */

import type { CanonicalReport, Finding } from './CSReportModel';
import type { ReportSpec } from './CSReportSpec';

/** Default absolute tolerance when `spec.checksumTolerance` is unset. One cent covers most currency use. */
const DEFAULT_CHECKSUM_TOLERANCE = 0.01;

/**
 * Compare `a.meta.checksums` against `b.meta.checksums`. Returns a `Finding[]` — every
 * mismatch is emitted as `CHECKSUM_DRIFT`. Extraction convention: keys are `"<sectionId>.<field>"`
 * (as produced by `CSReportSectionMapper.pdfTotalRowsToChecksums`) or just `"<field>"` (as
 * produced by `computeChecksumsFromRecords`). This validator does not interpret keys — it
 * merely compares equal keys and reports drifts.
 *
 * Rules:
 *   1. Key present in both sides: |a - b| ≤ tolerance → clean; otherwise CHECKSUM_DRIFT.
 *   2. Key present on only one side: emitted as CHECKSUM_DRIFT with a clear reason. This
 *      catches the case where one extractor lost a section entirely (its checksums for
 *      that section vanish while the other side kept them).
 *
 * Finding shape:
 *   - `section`  is the section id parsed off the checksum key when the `<section>.<field>` form
 *     was used, or `'*'` when the key is a bare field name (report-level checksum).
 *   - `field`    is the field portion of the key when the section prefix was present.
 *   - `aValue` / `bValue` carry the numeric checksum as canonical `number` values so the diff
 *     reporter can render them the same way it renders regular row-level findings.
 *   - `delta`    is the signed `b - a` difference; undefined when one side is missing entirely.
 *   - `reason`   is always populated for readability.
 */
export function validateChecksums(a: CanonicalReport, b: CanonicalReport, spec: ReportSpec): Finding[] {
    const aSums = a.meta.checksums ?? {};
    const bSums = b.meta.checksums ?? {};
    const tolerance = spec.checksumTolerance ?? DEFAULT_CHECKSUM_TOLERANCE;

    const allKeys = new Set<string>([...Object.keys(aSums), ...Object.keys(bSums)]);
    const sortedKeys = [...allKeys].sort();

    const findings: Finding[] = [];
    for (const key of sortedKeys) {
        const inA = key in aSums;
        const inB = key in bSums;
        const av = inA ? aSums[key] : undefined;
        const bv = inB ? bSums[key] : undefined;
        const { section, field } = splitChecksumKey(key);

        if (inA && inB) {
            const delta = (bv as number) - (av as number);
            if (Math.abs(delta) <= tolerance) continue;
            findings.push({
                id: checksumHashId(key, 'drift'),
                classification: 'CHECKSUM_DRIFT',
                section,
                key: { checksum: key },
                field,
                aValue: numericCanonical(av as number),
                bValue: numericCanonical(bv as number),
                delta,
                reason: `checksum "${key}" drift: |${(av as number).toString()} - ${(bv as number).toString()}| = ${Math.abs(delta).toString()} > tolerance ${tolerance}`,
            });
            continue;
        }

        // One-sided checksum: extraction on the OTHER side lost the metric entirely (usually
        // a dropped section). This is a strong signal that the comparison downstream is unsound.
        findings.push({
            id: checksumHashId(key, inA ? 'missing-b' : 'missing-a'),
            classification: 'CHECKSUM_DRIFT',
            section,
            key: { checksum: key },
            field,
            aValue: inA ? numericCanonical(av as number) : undefined,
            bValue: inB ? numericCanonical(bv as number) : undefined,
            reason: inA
                ? `checksum "${key}" present on A but missing on B — extraction on B likely dropped that section`
                : `checksum "${key}" present on B but missing on A — extraction on A likely dropped that section`,
        });
    }
    return findings;
}

/**
 * Split a checksum key `"section.field"` into its parts. Bare field keys (no dot, produced
 * by the flat-source aggregator) yield `{ section: '*', field: key }`. Dots inside a field
 * name are supported by taking the FIRST dot as the section boundary — dot in a section id
 * would be unusual and the mapper always uses camelCase.
 */
function splitChecksumKey(key: string): { section: string; field: string } {
    const dot = key.indexOf('.');
    if (dot < 0) return { section: '*', field: key };
    return { section: key.slice(0, dot), field: key.slice(dot + 1) };
}

function numericCanonical(n: number): { kind: 'number'; value: number; raw: string } {
    return { kind: 'number', value: n, raw: String(n) };
}

/** Same FNV-1a-32 as the reconciler + section validator so ids collide-check across modules. */
function checksumHashId(key: string, kind: string): string {
    const s = `checksum${key}${kind}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}
