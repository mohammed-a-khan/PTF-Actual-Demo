/**
 * CS Report Validation — Canonical Model
 *
 * The hub types for report validation. Every source (Crystal export/PDF,
 * SSRS export/PDF, DB query result) is reduced into these format-independent
 * shapes; only canonical models flow into the reconciler. This is what
 * decouples comparison logic from PDF layout, Excel sheet order, DB column
 * casing, or SSRS section restructuring.
 *
 * A `CanonicalReport` is a full extraction of one report instance (one
 * entity, one set of parameters, one snapshot). Its `records` are the
 * flat list of comparable rows across all sections; `sections` describes
 * which section boundaries were detected/asserted. `meta.checksums`
 * carries the extraction confidence signals (row counts / column totals)
 * that let the reconciler refuse to compare against a silently-broken
 * extraction.
 *
 * A `CanonicalValue` preserves the raw text alongside the normalized
 * value, so diff reports can show what the user actually saw in the report
 * even after currency stripping / accounting-negative parsing / date
 * canonicalization.
 *
 * @module report-validation/CSReportModel
 */

/** Source system a canonical report was extracted from. */
export type ReportSource = 'crystal' | 'ssrs' | 'db';

/** Serialization/rendering format the canonical report came out of. */
export type ReportFormat = 'excel' | 'csv' | 'xml' | 'pdf' | 'db';

/** Normalized value in the canonical model. `raw` is what the source produced literally; `value` is what the reconciler compares. */
export type CanonicalValue =
    | { kind: 'number'; value: number; raw: string }
    /** ISO-8601 date-only or timestamp string, e.g. `2026-07-26` or `2026-07-26T14:30:00`. */
    | { kind: 'date'; value: string; raw: string }
    | { kind: 'string'; value: string; raw: string }
    /** Empty / N/A / null-equivalent; different presentations all collapse here. */
    | { kind: 'null'; raw: string };

/** A single detected/expected section in the canonical report. */
export interface CanonicalSection {
    /** Canonical id (from spec), e.g. `summary`, `transactionDetail`. */
    id: string;
    /** As-rendered title, e.g. `CUSTOMER SUMMARY`. */
    title: string;
    /** True if we found this section during extraction; false = expected-but-absent. */
    present: boolean;
    /** 1-indexed position among detected sections in reading order. */
    order: number;
    /** How many rows were extracted under this section header. */
    rowCount: number;
    /**
     * True when the section was found in the source but the spec does not declare it, so
     * none of its rows entered the comparison. Recorded rather than dropped: a reader of the
     * canonical dump can see what else the report contained, and `rowCount` stays honest at
     * 0 because zero rows were contributed.
     */
    outOfScope?: boolean;
    /** Rows the source rendered under this section, whether or not they were compared. */
    detectedRowCount?: number;
    /**
     * Figures read from the section's calculation block, keyed by
     * `RequiredSectionSpec.summaryFields[].id`. Absent when the spec declares none. A
     * declared figure that could not be read is absent here rather than null, so the
     * reconciler can tell "did not extract" from "extracted as empty".
     */
    summary?: Record<string, CanonicalValue>;
}

/** One comparable row in the canonical model. */
export interface CanonicalRecord {
    /** Which section this record lives in (matches a `CanonicalSection.id`). */
    sectionId: string;
    /** Business-key values, one entry per column in `spec.keyColumns`. Values are already normalized. */
    key: Record<string, string>;
    /** Every non-key field, keyed by canonical field name (from `spec.fieldMap`). */
    fields: Record<string, CanonicalValue>;
}

/**
 * What the extraction actually managed to map, recorded by `CSReportSectionMapper` so the
 * reconciler can refuse to declare a vacuous pass.
 *
 * A comparison that extracted nothing reports zero differences and looks green. These
 * counters are what make that state detectable: a spec field whose declared column name
 * never matched a real column was never compared, and rows dropped for want of a business
 * key were never compared either — in both cases silence is indistinguishable from
 * agreement without this block.
 */
export interface CoverageMeta {
    /** Canonical fields that resolved to at least one real column/key on this source. */
    mappedFields: string[];
    /**
     * Canonical fields the spec DECLARES a column name for on this source, but whose name
     * matched no column during extraction. Each one is a field that silently dropped out of
     * the comparison. Fields with no declared name for this source are legitimately absent
     * and never appear here.
     */
    unmappedFields: string[];
    /**
     * Rows discarded, per canonical section, because one or more `spec.keyColumns` came out
     * empty — they can't be matched to the other side.
     *
     * Tracked PER SECTION, not as one total, because a 23-section Crystal report drops rows
     * in all the sections the spec never claimed to check (their columns are different, so
     * they have no business key under this spec). Only drops inside `spec.requiredSections`
     * indicate a real loss; a single total would fire on every multi-section report.
     */
    skippedRowsBySection: Record<string, number>;
    /** Records produced per canonical section id. A required section sitting at 0 is an extraction gap. */
    sectionRowCounts: Record<string, number>;
}

/** Full extraction of one report instance in the canonical shape. */
export interface CanonicalReport {
    /** Business entity id the report was generated for (customer id, account no, etc.). */
    entity: string;
    /** Which report type this is (matches `spec.reportType`). */
    reportType: string;
    /** Parameters the report was run with (from date, to date, currency, etc.). */
    params: Record<string, string>;
    source: ReportSource;
    format: ReportFormat;
    sections: CanonicalSection[];
    records: CanonicalRecord[];
    /** Report-level totals (grand total, count-of-rows) — optional per spec. */
    totals: Record<string, number>;
    meta: {
        rowCount: number;
        /**
         * Extraction confidence signals — row count, sum per numeric column, hash of
         * `keyColumns` values in order. `CSReportReconciler` refuses to reconcile when
         * these disagree with spec-declared expectations or with the DB oracle.
         */
        checksums?: Record<string, number>;
        /**
         * What the extraction actually mapped. Populated by `CSReportSectionMapper`; absent on
         * hand-built canonicals, in which case the reconciler falls back to record-count-only
         * coverage checks.
         */
        coverage?: CoverageMeta;
    };
}

/** How a per-field or per-record comparison landed. See `CSReportReconciler` for the exhaustive definitions. */
export type FindingKind =
    /** Same key, different values beyond tolerance. Fails the reconciliation. */
    | 'DATA_MISMATCH'
    /** Key present in A but not in B. Fails. */
    | 'MISSING'
    /** Key present in B but not in A. Fails. */
    | 'EXTRA'
    /** Normalized-equal but raw differs (e.g. "$1,000.00" vs "1000"). Recorded, does not fail. */
    | 'FORMAT_ONLY'
    /** Numeric diff below tolerance. Recorded with the actual delta for trend visibility. */
    | 'WITHIN_TOLERANCE'
    /** Matched an entry in `spec.knownDifferences` allowlist. Recorded, does not fail. */
    | 'KNOWN_DIFFERENCE'
    /** Section boundaries differ between the two reports but their rows aligned via keys elsewhere. Informational. */
    | 'SECTION_RESTRUCTURE'
    /**
     * `meta.checksums` disagree between sides (or against a spec-declared expectation)
     * beyond `spec.checksumTolerance`. Signals extraction incompleteness — comparison
     * results downstream cannot be trusted. Fails only when `spec.enforceChecksums` is on;
     * otherwise recorded for visibility.
     */
    | 'CHECKSUM_DRIFT'
    /**
     * A section's printed total disagrees with the sum of the rows extracted from that same
     * section, beyond `spec.footingTolerance`. Fails.
     *
     * This is the one integrity check a single report can run on ITSELF, and the only thing
     * that catches a silently truncated extraction: drop the last page and the printed total
     * stays exactly where it was while the sum of rows falls away. Cross-side checksum
     * agreement cannot see it — both sides can be truncated the same way, and identical
     * wrong numbers still agree.
     */
    | 'FOOTING_MISMATCH'
    /**
     * The spec asked for something that was never actually compared — a required section
     * that produced no records, a mapped field whose column was never found, or a
     * reconciliation with no records at all.
     *
     * Fails by DEFAULT, unlike every other non-difference classification. A coverage gap
     * means the run proved nothing, and "proved nothing" must never render as a pass. Set
     * `spec.allowCoverageGaps` to downgrade to informational when a partial comparison is
     * genuinely intended (mid-migration, where only some sections exist yet).
     */
    | 'COVERAGE_GAP';

/** One difference (or note) from a reconciliation run. */
export interface Finding {
    /** Stable hash of (section, key, field). Same input on both sides → same id across runs → trivially diff-able. */
    id: string;
    classification: FindingKind;
    /** Section id (from `CanonicalSection.id`) — `'*'` for cross-section findings. */
    section: string;
    /** Business-key values that identify the affected record (empty for section-level findings). */
    key: Record<string, string>;
    /** Canonical field name (from `spec.fieldMap`) — absent for row-level findings (MISSING/EXTRA). */
    field?: string;
    /** Value on the "A" side (typically the source of truth: Crystal, DB). */
    aValue?: CanonicalValue;
    /** Value on the "B" side (typically the candidate: SSRS). */
    bValue?: CanonicalValue;
    /** For WITHIN_TOLERANCE numeric findings, the signed delta `b - a`. */
    delta?: number;
    /** Human-readable note (why KNOWN_DIFFERENCE, what triggered SECTION_RESTRUCTURE, etc.). */
    reason?: string;
}

/** Summary counts alongside a full finding list. */
export interface ReconciliationCounts {
    total: number;
    passed: number;
    dataMismatch: number;
    missing: number;
    extra: number;
    formatOnly: number;
    withinTolerance: number;
    knownDifference: number;
    sectionRestructure: number;
    checksumDrift: number;
    coverageGap: number;
    footingMismatch: number;
}

/** The full result of `CSReportReconciler.reconcile(...)`. */
export interface ReconciliationResult {
    /**
     * True iff there are ZERO findings in the failing classifications: `DATA_MISMATCH`,
     * `MISSING`, `EXTRA`, `FOOTING_MISMATCH`, and `COVERAGE_GAP` (the last suppressible via
     * `spec.allowCoverageGaps`, the others never).
     */
    passed: boolean;
    counts: ReconciliationCounts;
    findings: Finding[];
}
