/**
 * CS Report Validation — Reconciler
 *
 * The core comparison engine. Given two `CanonicalReport`s (or one report
 * plus a DB-oracle report), classifies every difference into one of six
 * kinds and produces a stable, diff-able result. Assumes both inputs are
 * already canonical (produced by the section mapper / DB mapper / etc.) —
 * this module does zero normalization itself.
 *
 * ALGORITHM
 * ---------
 * 1. Match records by BUSINESS KEY (`spec.keyColumns`), not by position.
 *    Build a `Map<keyString, record>` per side; iterate the union.
 * 2. For each key present on both sides, compare every field in
 *    `spec.fieldMap` (except `spec.ignoreFields`) using tolerance rules:
 *      - number: `|a-b| ≤ epsilon` and/or `|a-b|/max(|a|,|b|) ≤ relative`
 *      - date:   ISO string equality (both sides already normalized)
 *      - string: trimmed + case-folded equality; optional fuzzy threshold
 *      - null:   both null → equal; one null → mismatch
 * 3. For each key present on only one side, emit MISSING or EXTRA.
 * 4. Post-process: promote raw-different-but-normalized-equal findings to
 *    FORMAT_ONLY (informational); apply `spec.knownDifferences` allowlist
 *    to downgrade matching findings to KNOWN_DIFFERENCE.
 * 5. Sort findings deterministically by (section, key, field) so the
 *    output is diff-able across runs — same inputs produce identical
 *    output byte-for-byte.
 *
 * PASS CRITERION
 * --------------
 * `passed === true` iff there are ZERO findings in the failing
 * classifications: DATA_MISMATCH, MISSING, EXTRA, and COVERAGE_GAP.
 * FORMAT_ONLY / WITHIN_TOLERANCE / KNOWN_DIFFERENCE / SECTION_RESTRUCTURE
 * are informational and never block. CHECKSUM_DRIFT blocks only under
 * `spec.enforceChecksums`; COVERAGE_GAP blocks unless explicitly waived
 * with `spec.allowCoverageGaps`.
 *
 * COVERAGE_GAP is the anti-vacuous-pass gate: a comparison that extracted
 * nothing has nothing to disagree about, so "zero differences" would
 * otherwise be reported for a run that proved nothing. See
 * `CSReportCoverageValidator`.
 *
 * @module report-validation/CSReportReconciler
 */

import type {
    CanonicalRecord,
    CanonicalReport,
    CanonicalSection,
    CanonicalValue,
    ComparisonCell,
    ComparisonLedger,
    ComparisonRow,
    Finding,
    FindingKind,
    ReconciliationCounts,
    ReconciliationResult,
} from './CSReportModel';
import { canonicalizeString, fieldNamesForSource } from './CSReportNormalizer';
import { validateChecksums } from './CSReportChecksumValidator';
import { validateCoverage } from './CSReportCoverageValidator';
import { validateFooting } from './CSReportFootingValidator';
import type { KnownDifferenceSpec, ReportSpec, ToleranceSpec } from './CSReportSpec';

/** Non-printable Unit Separator — safe to concat into a composite key because it can't appear in real data. */
const KEY_SEP = '\x1f';

/**
 * Default ledger cap. High enough that ordinary reports are recorded whole, low enough that
 * a runaway extraction cannot turn the diff report into a gigabyte of HTML. Override per
 * spec with `ledgerMaxRows`.
 */
const DEFAULT_LEDGER_MAX_ROWS = 2000;

/** Classifications that make a row fail; anything else that is not MATCH is a note. */
const LEDGER_FAILING: ReadonlySet<string> = new Set([
    'DATA_MISMATCH', 'MISSING', 'EXTRA', 'FOOTING_MISMATCH', 'COVERAGE_GAP', 'CHECKSUM_DRIFT',
]);

/**
 * Accumulates the audit trail while the reconciler walks. Rows beyond the cap are counted,
 * never dropped quietly — `omittedRows` reaches the report so a truncated ledger reads as
 * truncated rather than as complete.
 */
class LedgerBuilder {
    private readonly rows: ComparisonRow[] = [];
    private omitted = 0;

    constructor(
        private readonly aSource: string,
        private readonly bSource: string,
        private readonly cap: number,
    ) {}

    addRow(
        section: string,
        key: Record<string, string>,
        kind: ComparisonRow['kind'],
        presence: ComparisonRow['presence'],
        cells: ComparisonCell[],
    ): void {
        if (cells.length === 0) return;
        if (this.rows.length >= this.cap) { this.omitted++; return; }
        this.rows.push({ section, key, kind, presence, status: rollUp(cells), cells });
    }

    /** A row only one side carried: its values are recorded against an empty other side. */
    addOneSided(
        section: string,
        record: CanonicalRecord,
        presence: 'A_ONLY' | 'B_ONLY',
        status: FindingKind,
        spec: ReportSpec,
        ignore: ReadonlySet<string>,
        notComparable: ReadonlySet<string>,
    ): void {
        const cells: ComparisonCell[] = [];
        for (const field of Object.keys(spec.fieldMap)) {
            if (ignore.has(field) || notComparable.has(field)) continue;
            if (spec.keyColumns.includes(field)) continue;
            const v = record.fields[field];
            if (v === undefined) continue;
            cells.push({
                field,
                aRaw: presence === 'A_ONLY' ? v.raw : null,
                bRaw: presence === 'B_ONLY' ? v.raw : null,
                status,
            });
        }
        this.addRow(section, record.key, 'record', presence, cells);
    }

    build(): ComparisonLedger {
        return {
            aSource: this.aSource,
            bSource: this.bSource,
            rows: this.rows,
            omittedRows: this.omitted,
            rowCap: this.cap,
        };
    }
}

/** Row verdict from its cells: any failure fails the row, any note marks it informational. */
function rollUp(cells: ComparisonCell[]): ComparisonRow['status'] {
    let info = false;
    for (const c of cells) {
        if (LEDGER_FAILING.has(c.status)) return 'FAIL';
        if (c.status !== 'MATCH') info = true;
    }
    return info ? 'INFO' : 'PASS';
}

/**
 * `CSReportReconciler.reconcile(a, b, spec)` — compare two canonical reports and
 * classify every difference. Pure function; no I/O, no reporter side effects.
 */
export class CSReportReconciler {
    static reconcile(a: CanonicalReport, b: CanonicalReport, spec: ReportSpec): ReconciliationResult {
        const ignore = new Set(spec.ignoreFields);
        const findings: Finding[] = [];
        const ledger = new LedgerBuilder(a.source, b.source, spec.ledgerMaxRows ?? DEFAULT_LEDGER_MAX_ROWS);

        // Fields that cannot meaningfully be compared between THESE two sources.
        //
        //  - Not declared for one of the two sources: `spec.fieldMap` documents a missing
        //    per-source entry as "the field doesn't appear in that source — that side just
        //    skips it". Comparing anyway pits a value against `undefined` and reports
        //    "null vs non-null" on every single row.
        //  - Declared optional and genuinely absent this run: `spec.optionalFields` says a
        //    column may or may not be present. Exempting it from the coverage gate but then
        //    failing every row on it would make the setting useless.
        const notComparable = new Set<string>();
        const optional = new Set(spec.optionalFields ?? []);
        const aUnmapped = new Set(a.meta.coverage?.unmappedFields ?? []);
        const bUnmapped = new Set(b.meta.coverage?.unmappedFields ?? []);
        for (const canonicalField of Object.keys(spec.fieldMap)) {
            const entry = spec.fieldMap[canonicalField];
            if (!fieldNamesForSource(entry, a.source) || !fieldNamesForSource(entry, b.source)) {
                notComparable.add(canonicalField);
                continue;
            }
            if (optional.has(canonicalField) && (aUnmapped.has(canonicalField) || bUnmapped.has(canonicalField))) {
                notComparable.add(canonicalField);
            }
        }

        // Group records by (section, key) on each side. Keeps the union walk O(n).
        const aBySection = groupRecords(a.records);
        const bBySection = groupRecords(b.records);
        const allSections = new Set<string>([...aBySection.keys(), ...bBySection.keys()]);

        for (const section of allSections) {
            const aMap = aBySection.get(section) ?? new Map<string, CanonicalRecord>();
            const bMap = bBySection.get(section) ?? new Map<string, CanonicalRecord>();
            const allKeys = new Set<string>([...aMap.keys(), ...bMap.keys()]);

            for (const compositeKey of allKeys) {
                const aRec = aMap.get(compositeKey);
                const bRec = bMap.get(compositeKey);

                if (aRec && !bRec) {
                    findings.push({
                        id: hashId(section, compositeKey, '*missing*'),
                        classification: 'MISSING',
                        section,
                        key: aRec.key,
                        reason: 'key present in A, absent in B',
                    });
                    ledger.addOneSided(section, aRec, 'A_ONLY', 'MISSING', spec, ignore, notComparable);
                    continue;
                }
                if (!aRec && bRec) {
                    findings.push({
                        id: hashId(section, compositeKey, '*extra*'),
                        classification: 'EXTRA',
                        section,
                        key: bRec.key,
                        reason: 'key present in B, absent in A',
                    });
                    ledger.addOneSided(section, bRec, 'B_ONLY', 'EXTRA', spec, ignore, notComparable);
                    continue;
                }
                if (!aRec || !bRec) continue; // TS narrowing; unreachable.

                // Field-by-field walk. We use fieldMap as the authoritative canonical field
                // list so extraneous columns on either side are ignored (a common source
                // of noise between Crystal and SSRS).
                const cells: ComparisonCell[] = [];
                for (const canonicalField of Object.keys(spec.fieldMap)) {
                    if (ignore.has(canonicalField)) continue;
                    if (notComparable.has(canonicalField)) continue;
                    // keyColumns are already the identity of the row — no need to re-compare.
                    if (spec.keyColumns.includes(canonicalField)) continue;

                    const av = aRec.fields[canonicalField];
                    const bv = bRec.fields[canonicalField];
                    // If both sides don't provide the field, silently skip. If ONLY one side
                    // provides it, treat the other as null (uses tolerance's null semantics).
                    if (av === undefined && bv === undefined) continue;

                    const tolerance = spec.tolerances[canonicalField];
                    const result = compareValues(
                        av ?? { kind: 'null', raw: '' },
                        bv ?? { kind: 'null', raw: '' },
                        tolerance,
                    );
                    // Recorded whatever the outcome: the ledger is the audit trail, and a
                    // trail that omits the agreements cannot show what a pass covered.
                    cells.push({
                        field: canonicalField,
                        aRaw: av ? av.raw : null,
                        bRaw: bv ? bv.raw : null,
                        status: result.classification,
                        delta: result.delta,
                        reason: result.reason,
                    });
                    if (result.classification === 'MATCH') continue;

                    findings.push({
                        id: hashId(section, compositeKey, canonicalField),
                        classification: result.classification,
                        section,
                        key: aRec.key,
                        field: canonicalField,
                        aValue: av,
                        bValue: bv,
                        delta: result.delta,
                        reason: result.reason,
                    });
                }
                ledger.addRow(section, aRec.key, 'record', 'BOTH', cells);
            }
        }

        // Calculation-block figures. These live outside every column band, so the record walk
        // above cannot reach them — and they are usually the numbers the section exists to
        // report. Compared here so a section whose grid agrees but whose ratio doesn't
        // cannot pass.
        for (const f of compareSectionSummaries(a, b, spec, ledger)) findings.push(f);

        // Footing: each side's printed totals against the rows extracted beneath them. Run
        // per side, not across sides — two identically truncated extractions agree with each
        // other perfectly, so only a report checked against itself can catch that.
        for (const f of validateFooting(a, spec)) findings.push(f);
        for (const f of validateFooting(b, spec)) findings.push(f);

        // Extraction-integrity check. Findings ALWAYS append (visibility matters even when
        // `enforceChecksums` is off); pass/fail below decides whether they gate the outcome.
        const checksumFindings = validateChecksums(a, b, spec);
        for (const f of checksumFindings) findings.push(f);

        // Coverage check — did we actually compare what the spec claims to check? Unlike the
        // checksum gate this FAILS by default: a run that compared nothing finds no
        // differences, and that must never render as a pass.
        const coverageFindings = validateCoverage(a, b, spec);
        for (const f of coverageFindings) findings.push(f);

        // Promote knownDifferences AFTER the raw pass, since the allowlist may cover any
        // classification. This lets the allowlist "cover" both DATA_MISMATCH and MISSING
        // findings without duplicating logic upstream.
        applyKnownDifferences(findings, spec.knownDifferences);

        // Deterministic order for diff-friendly output.
        findings.sort(sortFindings);

        const counts = tallyCounts(findings);
        const passed =
            counts.dataMismatch === 0 &&
            counts.missing === 0 &&
            counts.extra === 0 &&
            counts.footingMismatch === 0 &&
            (spec.enforceChecksums ? counts.checksumDrift === 0 : true) &&
            (spec.allowCoverageGaps ? true : counts.coverageGap === 0);
        return { passed, counts, findings, ledger: ledger.build() };
    }
}

// ---------------------------------------------------------------------------
// Internals — kept in this file (not exported) so the API surface stays small.

/**
 * Compare the declared calculation figures of every required section.
 *
 * Three outcomes per declared figure:
 *   - present on both  → compared with `spec.tolerances[<id>]`, exactly like a row field
 *   - present on one   → DATA_MISMATCH; one engine printed a figure the other didn't
 *   - present on neither, while the section itself WAS found on both sides → COVERAGE_GAP
 *
 * That last case is the important one. A spec can declare a figure whose label the report
 * later renames; extraction then finds nothing, both sides hold nothing, and a naive
 * comparison calls that agreement. It is a silent loss of the very number the section is
 * about, so it is reported as a gap — which fails by default.
 *
 * Sections absent from a side are left alone: the section validator already reports a
 * missing section, and repeating it once per figure would bury that finding.
 */
function compareSectionSummaries(
    a: CanonicalReport,
    b: CanonicalReport,
    spec: ReportSpec,
    ledger: LedgerBuilder,
): Finding[] {
    const findings: Finding[] = [];
    const sectionOn = (report: CanonicalReport, id: string): CanonicalSection | undefined =>
        report.sections.find((s) => s.id === id && s.present && !s.outOfScope);

    for (const required of spec.requiredSections ?? []) {
        const fields = required.summaryFields ?? [];
        if (fields.length === 0) continue;

        const aSection = sectionOn(a, required.id);
        const bSection = sectionOn(b, required.id);
        if (!aSection || !bSection) continue;

        const summaryCells: ComparisonCell[] = [];
        for (const field of fields) {
            const av = aSection.summary?.[field.id];
            const bv = bSection.summary?.[field.id];

            if (av === undefined && bv === undefined) {
                findings.push({
                    id: hashId(required.id, `summary:${field.id}`, 'coverage'),
                    classification: 'COVERAGE_GAP',
                    section: required.id,
                    key: { coverage: `summaryField:${required.id}:${field.id}` },
                    field: field.id,
                    reason:
                        `spec declares summary figure "${field.id}" (label "${field.label}") in section ` +
                        `"${required.title}", but neither report yielded a value for it — the figure was ` +
                        `never compared. Check the label against the calculation block as printed.`,
                });
                continue;
            }

            const result = compareValues(
                av ?? { kind: 'null', raw: '' },
                bv ?? { kind: 'null', raw: '' },
                spec.tolerances[field.id],
            );
            summaryCells.push({
                field: field.id,
                aRaw: av ? av.raw : null,
                bRaw: bv ? bv.raw : null,
                status: result.classification,
                delta: result.delta,
                reason: result.reason,
            });
            if (result.classification === 'MATCH') continue;

            findings.push({
                id: hashId(required.id, `summary:${field.id}`, field.id),
                classification: result.classification,
                section: required.id,
                key: { summary: field.label },
                field: field.id,
                aValue: av,
                bValue: bv,
                delta: result.delta,
                reason: result.reason,
            });
        }
        if (summaryCells.length > 0) {
            ledger.addRow(required.id, { figures: required.title }, 'summary', 'BOTH', summaryCells);
        }
    }
    return findings;
}
// ---------------------------------------------------------------------------

/** Group records into `Map<section, Map<keyString, record>>`. */
function groupRecords(records: readonly CanonicalRecord[]): Map<string, Map<string, CanonicalRecord>> {
    const out = new Map<string, Map<string, CanonicalRecord>>();
    for (const rec of records) {
        let section = out.get(rec.sectionId);
        if (!section) {
            section = new Map<string, CanonicalRecord>();
            out.set(rec.sectionId, section);
        }
        section.set(compositeKey(rec.key), rec);
    }
    return out;
}

/** Build a stable composite key by concatenating key values with the Unit Separator. */
function compositeKey(key: Record<string, string>): string {
    // Sorting the entries keeps the key stable regardless of insertion order — crucial
    // because keys built from Excel columns vs DB columns may not iterate in the same order.
    return Object.keys(key)
        .sort()
        .map((k) => `${k}=${key[k] ?? ''}`)
        .join(KEY_SEP);
}

/**
 * Single-field compare. Returns a classification + optional delta/reason. `'MATCH'` means
 * "no finding to record"; anything else is a finding.
 */
export function compareValues(
    a: CanonicalValue,
    b: CanonicalValue,
    tol: ToleranceSpec | undefined,
): { classification: FindingKind | 'MATCH'; delta?: number; reason?: string } {
    // Null semantics: both null → match. One null → mismatch (no tolerance escape hatch;
    // a report showing "$500" vs "N/A" is a real discrepancy).
    if (a.kind === 'null' && b.kind === 'null') return { classification: 'MATCH' };
    if (a.kind === 'null' || b.kind === 'null') {
        return { classification: 'DATA_MISMATCH', reason: 'null vs non-null' };
    }

    // Kind mismatch (e.g. one side parsed as number, other as string) is a mismatch, but
    // downgraded to FORMAT_ONLY when the string form of the number matches the string. This
    // catches "1000" vs 1000 — the reporter surfaces it but doesn't fail.
    if (a.kind !== b.kind) {
        const aStr = valueAsRawText(a);
        const bStr = valueAsRawText(b);
        if (canonicalizeString(aStr) === canonicalizeString(bStr)) {
            return { classification: 'FORMAT_ONLY', reason: `${a.kind} vs ${b.kind}` };
        }
        return {
            classification: 'DATA_MISMATCH',
            reason: `${a.kind} vs ${b.kind}: ${aStr} vs ${bStr}`,
        };
    }

    // Same kind — dispatch on it.
    if (a.kind === 'number' && b.kind === 'number') {
        const delta = b.value - a.value;
        if (delta === 0) {
            // Numeric equality but raw text differs → FORMAT_ONLY. Catches "$1,000.00" vs "1000".
            if (a.raw.trim() !== b.raw.trim()) {
                return { classification: 'FORMAT_ONLY', reason: 'numeric equal, presentation differs' };
            }
            return { classification: 'MATCH' };
        }
        const withinTol = numericWithinTolerance(a.value, b.value, tol);
        if (withinTol) {
            return {
                classification: 'WITHIN_TOLERANCE',
                delta,
                reason: describeToleranceMatch(a.value, b.value, delta, tol),
            };
        }
        return {
            classification: 'DATA_MISMATCH',
            delta,
            reason: `numeric diff ${delta} exceeds tolerance ${describeTolerance(tol)}`,
        };
    }

    if (a.kind === 'date' && b.kind === 'date') {
        if (a.value === b.value) {
            if (a.raw.trim() !== b.raw.trim()) {
                return { classification: 'FORMAT_ONLY', reason: 'same date, different rendering' };
            }
            return { classification: 'MATCH' };
        }
        return { classification: 'DATA_MISMATCH', reason: `date ${a.value} vs ${b.value}` };
    }

    if (a.kind === 'string' && b.kind === 'string') {
        const aC = canonicalizeString(a.value);
        const bC = canonicalizeString(b.value);
        if (aC === bC) {
            if (a.raw.trim() !== b.raw.trim() && a.value !== b.value) {
                return { classification: 'FORMAT_ONLY', reason: 'same text, different case/whitespace' };
            }
            return { classification: 'MATCH' };
        }
        // Optional fuzzy match: Levenshtein similarity ≥ threshold passes with WITHIN_TOLERANCE.
        if (tol && tol.type === 'string' && typeof tol.fuzzy === 'number') {
            const sim = levenshteinSimilarity(aC, bC);
            if (sim >= tol.fuzzy) {
                return {
                    classification: 'WITHIN_TOLERANCE',
                    reason: `fuzzy similarity ${sim.toFixed(3)} >= threshold ${tol.fuzzy}`,
                };
            }
        }
        return { classification: 'DATA_MISMATCH', reason: `string "${a.value}" vs "${b.value}"` };
    }

    // Fallback — types the compiler already narrowed but keep as a defensive branch.
    return { classification: 'MATCH' };
}

/** Absolute + relative tolerance check for numeric fields. Missing tolerance = strict equality. */
function numericWithinTolerance(a: number, b: number, tol: ToleranceSpec | undefined): boolean {
    if (!tol || tol.type !== 'number') return false;
    const diff = Math.abs(a - b);
    if (typeof tol.epsilon === 'number' && diff <= tol.epsilon) return true;
    if (typeof tol.relative === 'number') {
        const denom = Math.max(Math.abs(a), Math.abs(b));
        if (denom === 0) return diff === 0;
        if (diff / denom <= tol.relative) return true;
    }
    return false;
}

function describeTolerance(tol: ToleranceSpec | undefined): string {
    if (!tol) return '(strict)';
    if (tol.type === 'number') {
        const parts: string[] = [];
        if (typeof tol.epsilon === 'number') parts.push(`epsilon=${tol.epsilon}`);
        if (typeof tol.relative === 'number') parts.push(`relative=${tol.relative}`);
        return parts.length ? parts.join(',') : '(strict)';
    }
    if (tol.type === 'string' && typeof tol.fuzzy === 'number') return `fuzzy=${tol.fuzzy}`;
    return '(strict)';
}

function describeToleranceMatch(
    a: number,
    b: number,
    delta: number,
    tol: ToleranceSpec | undefined,
): string {
    const magnitude = Math.max(Math.abs(a), Math.abs(b));
    const rel = magnitude === 0 ? 0 : Math.abs(delta) / magnitude;
    return `delta ${delta} within ${describeTolerance(tol)} (relative ${rel.toFixed(4)})`;
}

function valueAsRawText(v: CanonicalValue): string {
    if (v.kind === 'null') return '';
    if (v.kind === 'number') return String(v.value);
    if (v.kind === 'date') return v.value;
    return v.value;
}

/** Downgrade findings that match an allowlist entry to `KNOWN_DIFFERENCE`. Mutates in place. */
function applyKnownDifferences(findings: Finding[], allowlist: KnownDifferenceSpec[]): void {
    if (allowlist.length === 0) return;
    for (const finding of findings) {
        // A COVERAGE_GAP is never an "intentional difference" — it means the comparison
        // never happened. A broad allowlist entry (`section: '*'` with no field filter) is
        // aimed at data diffs, and letting it swallow an extraction failure would rebuild
        // exactly the silent-pass hole the coverage gate closes. Waiving these is a
        // deliberate, separate decision: `spec.allowCoverageGaps`.
        if (finding.classification === 'COVERAGE_GAP') continue;
        for (const entry of allowlist) {
            if (entry.section !== '*' && entry.section !== finding.section) continue;
            if (entry.field !== undefined && entry.field !== finding.field) continue;
            if (entry.key) {
                let mismatch = false;
                for (const [k, v] of Object.entries(entry.key)) {
                    if (finding.key[k] !== v) {
                        mismatch = true;
                        break;
                    }
                }
                if (mismatch) continue;
            }
            finding.classification = 'KNOWN_DIFFERENCE';
            finding.reason = entry.reason + (finding.reason ? ` (was: ${finding.reason})` : '');
            break;
        }
    }
}

function tallyCounts(findings: Finding[]): ReconciliationCounts {
    const counts: ReconciliationCounts = {
        total: findings.length,
        passed: 0, // findings.length only counts non-MATCH; leaving 0 keeps the number honest.
        dataMismatch: 0,
        missing: 0,
        extra: 0,
        formatOnly: 0,
        withinTolerance: 0,
        knownDifference: 0,
        sectionRestructure: 0,
        checksumDrift: 0,
        coverageGap: 0,
        footingMismatch: 0,
    };
    for (const f of findings) {
        switch (f.classification) {
            case 'DATA_MISMATCH': counts.dataMismatch++; break;
            case 'MISSING': counts.missing++; break;
            case 'EXTRA': counts.extra++; break;
            case 'FORMAT_ONLY': counts.formatOnly++; break;
            case 'WITHIN_TOLERANCE': counts.withinTolerance++; break;
            case 'KNOWN_DIFFERENCE': counts.knownDifference++; break;
            case 'SECTION_RESTRUCTURE': counts.sectionRestructure++; break;
            case 'CHECKSUM_DRIFT': counts.checksumDrift++; break;
            case 'COVERAGE_GAP': counts.coverageGap++; break;
            case 'FOOTING_MISMATCH': counts.footingMismatch++; break;
        }
    }
    return counts;
}

function sortFindings(a: Finding, b: Finding): number {
    if (a.section !== b.section) return a.section.localeCompare(b.section);
    const aKey = compositeKey(a.key);
    const bKey = compositeKey(b.key);
    if (aKey !== bKey) return aKey.localeCompare(bKey);
    const aField = a.field ?? '';
    const bField = b.field ?? '';
    return aField.localeCompare(bField);
}

/**
 * Deterministic stable id for a finding — same (section, compositeKey, field) triple
 * always produces the same id. Uses FNV-1a 32-bit → 8-char hex; collisions are
 * theoretically possible but astronomically unlikely at typical report sizes and easy
 * to spot in the HTML output (visually clustered by same id).
 */
function hashId(section: string, keyStr: string, field: string): string {
    const s = `${section}${keyStr}${field}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/**
 * Levenshtein-similarity in [0, 1] via edit distance. Kept small and dep-free — the
 * fuzzy string threshold is a minority use case (mostly for narrative fields like
 * "description"), so we can afford the O(m·n) DP for typical report cell lengths.
 */
function levenshteinSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length === 0 || b.length === 0) return 0;
    const m = a.length;
    const n = b.length;
    const dp: number[] = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= n; j++) {
            const temp = dp[j];
            if (a[i - 1] === b[j - 1]) {
                dp[j] = prev;
            } else {
                dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
            }
            prev = temp;
        }
    }
    const distance = dp[n];
    return 1 - distance / Math.max(m, n);
}
