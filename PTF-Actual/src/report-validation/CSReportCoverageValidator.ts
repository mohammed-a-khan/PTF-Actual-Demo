/**
 * CS Report Validation — Coverage validation (anti-vacuous-pass gate).
 *
 * THE FAILURE MODE THIS EXISTS FOR
 * --------------------------------
 * A reconciliation that extracted nothing finds no differences, and reports:
 *
 *     passed = true   { total: 0, dataMismatch: 0, missing: 0, extra: 0 }
 *
 * which is indistinguishable from a genuine clean run. Every ingredient of that
 * state is silent by design elsewhere in the pipeline: `CSReportSectionMapper`
 * skips columns it can't map, drops rows whose business key came out empty, and
 * emits no warning for either. So one wrong column name in a spec removes a field
 * from the comparison, one wrong key column removes every row — and the suite
 * goes green.
 *
 * This module turns those silences into `COVERAGE_GAP` findings, which FAIL by
 * default (`spec.allowCoverageGaps` opts out). The rule it enforces is simply:
 * everything the spec CLAIMS to check must actually have been checked.
 *
 * WHAT COUNTS AS A GAP
 * --------------------
 *   1. Nothing compared at all — both sides produced zero records.
 *   2. One side produced zero records while the other produced some. (The
 *      reconciler would otherwise render this as N MISSING rows, which reads like
 *      a data defect when it is really an extraction failure.)
 *   3. A `spec.requiredSections` entry with zero records on ONE side while the
 *      other side has rows. (Zero on both is a legitimately empty section for
 *      the period, not an extraction failure.)
 *   4. A canonical field the spec declares a column name for on a side, but whose
 *      name matched no column during extraction — it silently left the comparison.
 *   5. Rows discarded on a side for want of a populated business key.
 *
 * Checks 4 and 5 need `meta.coverage`, which only `CSReportSectionMapper` populates.
 * Hand-built canonicals (tests, custom adapters) skip those two and still get 1-3.
 *
 * PURE FUNCTION
 * -------------
 * No I/O, no reporter side effects — same contract as `validateChecksums`. Findings
 * come back deterministically ordered so the output is diff-able across runs.
 *
 * @module report-validation/CSReportCoverageValidator
 */

import type { CanonicalReport, Finding } from './CSReportModel';
import type { ReportSpec } from './CSReportSpec';

/**
 * Produce `COVERAGE_GAP` findings for anything the spec asked for but the extraction never
 * actually compared. `aLabel`/`bLabel` name the two sides in the human-readable reasons
 * (the reconciler passes the canonical `source` values, e.g. `crystal` / `ssrs`).
 */
export function validateCoverage(a: CanonicalReport, b: CanonicalReport, spec: ReportSpec): Finding[] {
    const findings: Finding[] = [];
    const aLabel = a.source;
    const bLabel = b.source;

    // ---- 1 + 2: did we compare any rows at all? ---------------------------
    if (a.records.length === 0 && b.records.length === 0) {
        findings.push(gap('*', 'noRecords', undefined,
            `no records were extracted from EITHER side (${aLabel}, ${bLabel}) — this comparison proved nothing. ` +
            `Check the section matchers and column names in spec "${spec.reportType}".`));
        // No point enumerating per-section gaps on top of a total wipe-out.
        return findings;
    }
    if (a.records.length === 0 || b.records.length === 0) {
        const emptySide = a.records.length === 0 ? aLabel : bLabel;
        const otherSide = a.records.length === 0 ? bLabel : aLabel;
        const otherCount = Math.max(a.records.length, b.records.length);
        findings.push(gap('*', 'oneSideEmpty', undefined,
            `no records were extracted from ${emptySide} while ${otherSide} produced ${otherCount} — ` +
            `every row would be reported as a difference, but the cause is extraction, not data.`));
    }

    // ---- 3: required sections empty on ONE side only ----------------------
    // Asymmetry is the signal. A section empty on both sides is legitimately empty this
    // period — "Defaulted Obligations Detail" with no defaults is a real, correct, empty
    // section, and failing it would punish a clean month. (A report where EVERY section is
    // empty is caught by check 1 above.) Empty on one side while the other has rows is an
    // extraction failure wearing a data-difference costume.
    for (const required of spec.requiredSections) {
        const aCount = sectionRowCount(a, required.id);
        const bCount = sectionRowCount(b, required.id);
        if (aCount > 0 === bCount > 0) continue;
        const emptySide = aCount === 0 ? aLabel : bLabel;
        const otherSide = aCount === 0 ? bLabel : aLabel;
        const otherCount = Math.max(aCount, bCount);
        findings.push(gap(required.id, `emptySection:${emptySide}`, undefined,
            `required section "${required.title}" (${required.id}) produced 0 records on ${emptySide} ` +
            `but ${otherCount} on ${otherSide} — nothing in it was compared on ${emptySide}.`));
    }

    // ---- 4: declared fields that never resolved to a column ---------------
    const exempt = new Set([...(spec.optionalFields ?? []), ...spec.ignoreFields]);
    for (const [label, canonical] of [[aLabel, a], [bLabel, b]] as const) {
        const coverage = canonical.meta.coverage;
        if (!coverage) continue; // Hand-built canonical — nothing to assert against.
        for (const field of coverage.unmappedFields) {
            if (exempt.has(field)) continue;
            const declared = spec.fieldMap[field]?.[canonical.source];
            findings.push(gap('*', `unmappedField:${label}:${field}`, field,
                `spec maps "${field}" to column "${declared ?? '(unknown)'}" on ${label}, but no such column was found — ` +
                `the field was never compared. Fix the column name, or list it in spec.optionalFields if it is genuinely optional.`));
        }
    }

    // ---- 5: rows dropped for want of a business key ------------------------
    // Scoped to `requiredSections` on purpose. A multi-section report drops rows in every
    // section the spec doesn't cover — their columns are different, so they have no business
    // key under this spec, and that is entirely expected. Only losses inside a section we
    // claim to check are real.
    for (const required of spec.requiredSections) {
        for (const [label, canonical] of [[aLabel, a], [bLabel, b]] as const) {
            const skipped = canonical.meta.coverage?.skippedRowsBySection?.[required.id] ?? 0;
            if (skipped === 0) continue;
            findings.push(gap(required.id, `skippedRows:${label}`, undefined,
                `${skipped} row(s) in section "${required.title}" on ${label} were dropped because one or more ` +
                `key columns (${spec.keyColumns.join(', ')}) came out empty — those rows were never compared.`));
        }
    }

    findings.sort((x, y) => x.id.localeCompare(y.id));
    return findings;
}

/** Build one COVERAGE_GAP finding. `discriminator` keeps ids unique and stable across runs. */
function gap(section: string, discriminator: string, field: string | undefined, reason: string): Finding {
    return {
        id: coverageHashId(section, discriminator),
        classification: 'COVERAGE_GAP',
        section,
        key: { coverage: discriminator },
        field,
        reason,
    };
}

/** Total records the canonical produced for `sectionId`. Sections can repeat when a table spans pages. */
function sectionRowCount(canonical: CanonicalReport, sectionId: string): number {
    const fromCoverage = canonical.meta.coverage?.sectionRowCounts?.[sectionId];
    if (typeof fromCoverage === 'number') return fromCoverage;
    return canonical.records.filter((r) => r.sectionId === sectionId).length;
}

/** Same FNV-1a-32 as the reconciler, section validator and checksum validator. */
function coverageHashId(section: string, discriminator: string): string {
    const s = `coverage${section}${discriminator}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}
