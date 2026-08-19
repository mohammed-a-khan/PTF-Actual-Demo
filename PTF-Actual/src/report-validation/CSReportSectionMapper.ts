/**
 * CS Report Validation — Layer 3: Section mapper.
 *
 * The bridge between per-source data shapes (Layer 2's `AnalyzedReport`
 * from PDF, or `DataRow[]` from Excel/CSV/DB via `CSDataProvider`) and
 * the canonical model the reconciler compares against.
 *
 * RESPONSIBILITIES
 * ----------------
 *   1. Resolve raw section titles (`Position Detail 1D` in SSRS,
 *      `Position Detail` in Crystal, no section in a DB row set)
 *      onto canonical section ids from `spec.requiredSections`.
 *   2. Fold source-specific column names (`Acct No` Crystal / `AccountNo`
 *      SSRS / `ACCT_NO` DB) onto canonical field names via `spec.fieldMap`.
 *   3. Normalise every cell value into a `CanonicalValue` (currency,
 *      accounting negatives, dates from `spec.dateFormats`, null tokens).
 *   4. Extract `spec.keyColumns` values as the row's business key.
 *   5. Skip `spec.ignoreFields`, group-header rows, and total rows.
 *   6. Populate `meta.checksums` from either extractor-side total rows
 *      (`AnalyzedReport`) or sum-of-data-rows (any source).
 *
 * FACTORY METHODS
 * ---------------
 *   `fromPdf(analyzed, spec, opts)`      — Layer-2 output → canonical
 *   `fromDataRows(rows, spec, opts)`     — flat `{col: value}[]` from
 *                                          Excel/CSV/DB/etc.
 *   `fromDb(rows, spec, opts)`           — alias with source='db', format='db'
 *   `fromExcel(rows, spec, opts)`        — alias with format='excel'
 *   `fromCsv(rows, spec, opts)`          — alias with format='csv'
 *
 * The reconciler compares two `CanonicalReport`s regardless of how they
 * were produced — the mapper is what makes format-independence real.
 *
 * @module report-validation/CSReportSectionMapper
 */

import type {
    CanonicalRecord,
    CanonicalReport,
    CanonicalSection,
    CanonicalValue,
    CoverageMeta,
    ReportFormat,
    ReportSource,
} from './CSReportModel';
import { canonicalFieldFor, normalizeColumnName, normalizeValue } from './CSReportNormalizer';
import type {
    AnalyzedReport,
    AnalyzedSection,
    TableRow,
} from './CSReportPdfTypes';
import type { RequiredSectionSpec, ReportSpec } from './CSReportSpec';

/**
 * A flat data row as ingested from Excel, CSV, DB, XML, etc. Keys are the raw column
 * names from the source; values are strings (or JS primitives that will be stringified).
 * This shape matches what `CSDataProvider.loadData(...)` produces framework-wide, so
 * callers can pipe DataProvider output straight into `CSReportSectionMapper.fromDataRows`.
 */
export type DataRow = Record<string, unknown>;

/** Shared options across all mapper factory methods. */
export interface MapperOptions {
    /** Business entity id the report was generated for. Passed through to `CanonicalReport.entity`. */
    entity: string;
    /** Which source system this data came from. Determines which `spec.fieldMap[*][source]` branch to use. */
    source: ReportSource;
    /** Serialization/rendering format. Defaults to a sensible per-source choice when omitted. */
    format?: ReportFormat;
    /** Report parameters (as-of date, currency, etc.). Passed through to `CanonicalReport.params`. */
    params?: Record<string, string>;
    /**
     * When the source is flat (Excel/CSV/DB), this column name — if provided — carries the
     * section identifier for each row. Rows with the same value are grouped into one section.
     * When omitted, every row is assigned to `defaultSectionId`.
     */
    sectionColumn?: string;
    /** Fallback section id used when `sectionColumn` is not set. Defaults to the FIRST entry in `spec.requiredSections`, or `'default'`. */
    defaultSectionId?: string;
    /**
     * When true, records whose canonical field list resolves to zero mapped fields are
     * DROPPED (they'd be pure key + empty content). Default true — silently propagating
     * empty records into the reconciler produces confusing MISSING findings downstream.
     */
    dropEmptyRecords?: boolean;
}

export class CSReportSectionMapper {
    /**
     * Map a `AnalyzedReport` (Phase B output) into a `CanonicalReport`. Each merged section
     * is walked; every data row (non-total, non-group-header) is turned into a
     * `CanonicalRecord`; total rows populate `meta.checksums`.
     *
     * The mapper preserves the analyzer's section ORDER — canonical sections come out in
     * the same order as they were rendered in the PDF, which matches what the section
     * validator expects.
     */
    static fromPdf(
        analyzed: AnalyzedReport,
        spec: ReportSpec,
        opts: MapperOptions,
    ): CanonicalReport {
        const format = opts.format ?? 'pdf';
        const sections: CanonicalSection[] = [];
        const records: CanonicalRecord[] = [];
        const checksums: Record<string, number> = {};
        const coverage = newCoverageAccumulator();

        // The spec's `requiredSections` IS the declaration of scope. A legacy report carries
        // dozens of sections; the replacement renders the migrated few. Mapping the rest
        // turns every unmigrated section into a wall of MISSING rows that says nothing the
        // section list doesn't already say, and buries the differences that matter. Sections
        // outside the declaration are recorded (below) but contribute no records.
        //
        // Guarded on the list being non-empty so specs that declare no sections — flat
        // single-table sources — keep mapping everything, as before.
        const scoped = spec.requiredSections.length > 0;
        const declared = new Set(spec.requiredSections.map((r) => r.id));

        let sectionOrder = 0;
        for (const analyzedSection of analyzed.mergedSections) {
            sectionOrder++;
            const canonicalSectionId = resolveCanonicalSectionId(analyzedSection.title, spec);
            const requiredMeta = findRequiredSection(canonicalSectionId, spec);

            if (scoped && !declared.has(canonicalSectionId)) {
                sections.push({
                    id: canonicalSectionId,
                    title: analyzedSection.title,
                    present: true,
                    order: sectionOrder,
                    rowCount: 0,
                    outOfScope: true,
                    detectedRowCount: analyzedSection.tableRows.length,
                });
                continue;
            }

            // Column-index → canonical field name, based on the resolved bands' headers.
            // Skip columns whose header doesn't map to any canonical field via `spec.fieldMap`
            // (extraneous columns on this side of the report — a common source of noise).
            const colIdxToCanonical = mapColumnIndexesToCanonical(analyzedSection, spec, opts.source);

            const canonicalRecords = pdfRowsToCanonicalRecords(
                analyzedSection.tableRows,
                colIdxToCanonical,
                canonicalSectionId,
                spec,
                opts,
                coverage,
            );
            const canonicalChecksums = pdfTotalRowsToChecksums(
                analyzedSection.tableRows,
                colIdxToCanonical,
                canonicalSectionId,
            );
            for (const [k, v] of Object.entries(canonicalChecksums)) checksums[k] = v;

            const summary = extractSectionSummary(analyzedSection.preambleText ?? [], requiredMeta, spec);

            sections.push({
                id: canonicalSectionId,
                title: requiredMeta?.title ?? analyzedSection.title,
                present: true,
                order: sectionOrder,
                rowCount: canonicalRecords.length,
                detectedRowCount: analyzedSection.tableRows.length,
                ...(summary ? { summary } : {}),
            });
            records.push(...canonicalRecords);
        }

        // Add MISSING placeholder entries for required sections that weren't detected — the
        // section validator downstream can then produce a clear "section X missing" finding
        // instead of the mapper silently omitting them.
        for (const req of spec.requiredSections) {
            if (sections.some((s) => s.id === req.id)) continue;
            sectionOrder++;
            sections.push({
                id: req.id,
                title: req.title,
                present: false,
                order: sectionOrder,
                rowCount: 0,
            });
        }

        return {
            entity: opts.entity,
            reportType: spec.reportType,
            params: opts.params ?? {},
            source: opts.source,
            format,
            sections,
            records,
            totals: aggregateTotalsFromRecords(records, spec),
            meta: {
                rowCount: records.length,
                checksums,
                coverage: finalizeCoverage(coverage, spec, opts.source),
            },
        };
    }

    /**
     * Map a flat `DataRow[]` (from Excel/CSV/DB via `CSDataProvider`) into a `CanonicalReport`.
     * When `opts.sectionColumn` is set, rows are grouped by that column's value; otherwise
     * every row lands in a single canonical section named by `opts.defaultSectionId`.
     */
    static fromDataRows(
        rows: DataRow[],
        spec: ReportSpec,
        opts: MapperOptions,
    ): CanonicalReport {
        const format = opts.format ?? (opts.source === 'db' ? 'db' : 'csv');
        const defaultId = opts.defaultSectionId ?? spec.requiredSections[0]?.id ?? 'default';

        // Group rows by section (via sectionColumn or single default).
        const groups = new Map<string, DataRow[]>();
        for (const row of rows) {
            const sectionId = opts.sectionColumn
                ? String(row[opts.sectionColumn] ?? defaultId)
                : defaultId;
            let group = groups.get(sectionId);
            if (!group) {
                group = [];
                groups.set(sectionId, group);
            }
            group.push(row);
        }

        const sections: CanonicalSection[] = [];
        const canonicalRecords: CanonicalRecord[] = [];
        const coverage = newCoverageAccumulator();
        let sectionOrder = 0;
        for (const [rawSectionId, groupRows] of groups) {
            sectionOrder++;
            const canonicalSectionId = resolveCanonicalSectionId(rawSectionId, spec);
            const requiredMeta = findRequiredSection(canonicalSectionId, spec);
            const rowCanonicals = groupRows
                .map((row) => dataRowToCanonicalRecord(row, spec, opts, canonicalSectionId, coverage))
                .filter((r): r is CanonicalRecord => r !== null);
            coverage.sectionRowCounts[canonicalSectionId] =
                (coverage.sectionRowCounts[canonicalSectionId] ?? 0) + rowCanonicals.length;
            sections.push({
                id: canonicalSectionId,
                title: requiredMeta?.title ?? rawSectionId,
                present: true,
                order: sectionOrder,
                rowCount: rowCanonicals.length,
            });
            canonicalRecords.push(...rowCanonicals);
        }

        // Placeholders for required-but-absent sections (same as fromPdf).
        for (const req of spec.requiredSections) {
            if (sections.some((s) => s.id === req.id)) continue;
            sectionOrder++;
            sections.push({
                id: req.id,
                title: req.title,
                present: false,
                order: sectionOrder,
                rowCount: 0,
            });
        }

        return {
            entity: opts.entity,
            reportType: spec.reportType,
            params: opts.params ?? {},
            source: opts.source,
            format,
            sections,
            records: canonicalRecords,
            totals: aggregateTotalsFromRecords(canonicalRecords, spec),
            meta: {
                rowCount: canonicalRecords.length,
                checksums: computeChecksumsFromRecords(canonicalRecords, spec),
                coverage: finalizeCoverage(coverage, spec, opts.source),
            },
        };
    }

    /** Convenience alias — DB rows come in the same shape as Excel/CSV rows. */
    static fromDb(rows: DataRow[], spec: ReportSpec, opts: Omit<MapperOptions, 'source' | 'format'> & { source?: 'db' }): CanonicalReport {
        return CSReportSectionMapper.fromDataRows(rows, spec, { ...opts, source: 'db', format: 'db' });
    }

    /** Convenience alias — Excel rows via CSDataProvider. */
    static fromExcel(
        rows: DataRow[],
        spec: ReportSpec,
        opts: Omit<MapperOptions, 'format'> & { format?: 'excel' },
    ): CanonicalReport {
        return CSReportSectionMapper.fromDataRows(rows, spec, { ...opts, format: 'excel' });
    }

    /** Convenience alias — CSV rows via CSDataProvider. */
    static fromCsv(
        rows: DataRow[],
        spec: ReportSpec,
        opts: Omit<MapperOptions, 'format'> & { format?: 'csv' },
    ): CanonicalReport {
        return CSReportSectionMapper.fromDataRows(rows, spec, { ...opts, format: 'csv' });
    }
}

// ---------------------------------------------------------------------------
// Section-title resolution.
// ---------------------------------------------------------------------------

/**
 * Resolve a raw section title (from a PDF section header or DataRow section column) to
 * its canonical id per `spec.requiredSections`. Match precedence:
 *   1. Any `matchers` regex on a required section that matches the raw title.
 *   2. Case-insensitive substring match against `requiredSection.title`.
 *   3. Substring match against `requiredSection.id`.
 *   4. Fallback: return the raw title unchanged (mapper treats it as an unknown section;
 *      the reconciler will produce EXTRA findings for any records in it).
 */
export function resolveCanonicalSectionId(rawTitle: string, spec: ReportSpec): string {
    if (!rawTitle) return '';
    const normalized = rawTitle.toLowerCase().trim();
    for (const req of spec.requiredSections) {
        if (req.matchers && req.matchers.length > 0) {
            for (const pattern of req.matchers) {
                try {
                    const re = new RegExp(pattern, 'i');
                    if (re.test(rawTitle)) return req.id;
                } catch {
                    // Malformed regex in spec — fall through to substring check. The spec
                    // loader (Phase A) will surface bad regex during ajv validation later.
                }
            }
        }
        if (normalized.includes(req.title.toLowerCase())) return req.id;
        if (normalized.includes(req.id.toLowerCase())) return req.id;
    }
    return rawTitle;
}

function findRequiredSection(canonicalId: string, spec: ReportSpec): RequiredSectionSpec | undefined {
    return spec.requiredSections.find((r) => r.id === canonicalId);
}

// ---------------------------------------------------------------------------
// PDF-side helpers (AnalyzedSection → CanonicalRecord[]).
// ---------------------------------------------------------------------------

/**
 * For each column index in an analyzed section's `columns[]`, resolve which canonical
 * field it corresponds to (via `spec.fieldMap[canonical][source]`). Returns an array of
 * `canonicalField | null`; null = "column present but not mapped by spec" (silently
 * skipped during row extraction).
 */
function mapColumnIndexesToCanonical(
    section: AnalyzedSection,
    spec: ReportSpec,
    source: ReportSource,
): (string | null)[] {
    return section.columns.map((band) => {
        if (!band.header) return null;
        return canonicalFieldFor(band.header, source, spec.fieldMap);
    });
}

/**
 * Read a section's declared calculation figures out of its preamble lines.
 *
 * The preamble is label-and-value text, not a grid, so extraction is label-driven: find the
 * line carrying the label, then take the Nth VALUE on it. "Value" means the token normalizes
 * to a number or a date — which is what excludes the formula markers these blocks are full
 * of (`(A)`, `(B)`, `(B)/(A)`) without having to enumerate them, and what lets
 * `All Deferring Securities 4,200,000.00 (B) (B)/(A) 5.600%` yield the amount at index 1 and
 * the ratio at index 2.
 *
 * A declared figure that isn't found is left ABSENT rather than written as null. The
 * reconciler treats absence as a coverage gap — a figure the spec claims to check and
 * didn't — where a null would silently compare equal against the other side's null.
 *
 * @returns the figures found, or `undefined` when the section declares none.
 */
function extractSectionSummary(
    preambleText: string[],
    requiredMeta: RequiredSectionSpec | undefined,
    spec: ReportSpec,
): Record<string, CanonicalValue> | undefined {
    const fields = requiredMeta?.summaryFields;
    if (!fields || fields.length === 0) return undefined;

    const out: Record<string, CanonicalValue> = {};
    for (const field of fields) {
        const wanted = Math.max(1, field.valueIndex ?? 1);
        const label = collapseSpaces(field.label).toLowerCase();

        for (const rawLine of preambleText) {
            const line = collapseSpaces(rawLine);
            const at = line.toLowerCase().indexOf(label);
            if (at < 0) continue;

            const values: CanonicalValue[] = [];
            for (const token of line.slice(at + label.length).split(' ')) {
                if (token.length === 0) continue;
                const value = normalizeValue(token, { dateFormats: spec.dateFormats });
                if (value.kind === 'number' || value.kind === 'date') values.push(value);
            }
            if (values.length >= wanted) {
                out[field.id] = values[wanted - 1];
                break;
            }
        }
    }
    return out;
}

function collapseSpaces(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * Running tally of what extraction actually managed to map. Threaded through the row
 * converters so `meta.coverage` can be built without a second pass, and so
 * `CSReportCoverageValidator` can fail a run that silently compared nothing.
 */
interface CoverageAccumulator {
    /** Canonical fields that resolved to a real column on this source. */
    mapped: Set<string>;
    /** Rows that carried mapped content but lacked a complete business key, keyed by canonical section. */
    skippedRowsBySection: Record<string, number>;
    /** Records produced per canonical section id. */
    sectionRowCounts: Record<string, number>;
}

function newCoverageAccumulator(): CoverageAccumulator {
    return { mapped: new Set<string>(), skippedRowsBySection: {}, sectionRowCounts: {} };
}

/**
 * Finalise the accumulator into `CoverageMeta`. `unmappedFields` is derived here: every
 * canonical field the spec DECLARES a column name for on this source, that never resolved
 * to a column. Fields with no declared name for the source are legitimately absent and are
 * not reported.
 */
function finalizeCoverage(acc: CoverageAccumulator, spec: ReportSpec, source: ReportSource): CoverageMeta {
    const unmapped: string[] = [];
    for (const [canonical, perSource] of Object.entries(spec.fieldMap)) {
        const declared = perSource[source];
        if (!declared) continue;
        if (acc.mapped.has(canonical)) continue;
        unmapped.push(canonical);
    }
    return {
        mappedFields: Array.from(acc.mapped).sort(),
        unmappedFields: unmapped.sort(),
        skippedRowsBySection: { ...acc.skippedRowsBySection },
        sectionRowCounts: { ...acc.sectionRowCounts },
    };
}

/** Turn PDF table rows into canonical records, skipping total rows and group headers. */
function pdfRowsToCanonicalRecords(
    rows: TableRow[],
    colIdxToCanonical: (string | null)[],
    sectionId: string,
    spec: ReportSpec,
    opts: MapperOptions,
    coverage: CoverageAccumulator,
): CanonicalRecord[] {
    const out: CanonicalRecord[] = [];
    const ignore = new Set(spec.ignoreFields);
    const keyColumnSet = new Set(spec.keyColumns);
    const dropEmpty = opts.dropEmptyRecords !== false;

    // A column that resolved to a canonical field counts as mapped even if this particular
    // section's rows leave it blank — the spec's column name was found, which is the thing
    // the coverage gate is asserting.
    for (const canonical of colIdxToCanonical) {
        if (canonical) coverage.mapped.add(canonical);
    }

    for (const row of rows) {
        if (row.isGroupHeader || row.isTotalRow) continue;

        const fields: Record<string, CanonicalValue> = {};
        const key: Record<string, string> = {};

        for (let ci = 0; ci < row.cells.length; ci++) {
            const canonical = colIdxToCanonical[ci];
            if (!canonical) continue;
            if (ignore.has(canonical)) continue;
            const cell = row.cells[ci];
            const value = normalizeValue(cell ?? '', { dateFormats: spec.dateFormats });
            if (keyColumnSet.has(canonical)) {
                key[canonical] = canonicalValueToKeyString(value);
            }
            fields[canonical] = value;
        }

        // Skip rows with no key columns populated — they can't be identified for reconciliation
        // (would collide with every other keyless row under the empty composite key).
        const keyPopulated = spec.keyColumns.every((k) => key[k] !== undefined && key[k] !== '');
        if (!keyPopulated) {
            // A row that carried real content but no usable key is a LOSS worth reporting.
            // A row with nothing in it at all is just a blank line in the PDF — counting
            // those would put a coverage gap on every report that has whitespace.
            if (Object.keys(fields).length > 0) {
                coverage.skippedRowsBySection[sectionId] = (coverage.skippedRowsBySection[sectionId] ?? 0) + 1;
            }
            continue;
        }

        if (dropEmpty && Object.keys(fields).length === 0) continue;

        out.push({ sectionId, key, fields });
    }
    coverage.sectionRowCounts[sectionId] = (coverage.sectionRowCounts[sectionId] ?? 0) + out.length;
    return out;
}

/**
 * Convert every total row into per-field checksum entries under canonical field names.
 * Format: `{<sectionId>.<canonicalField>: value}` so multiple sections' checksums don't
 * collide when merged into the report-level checksum map.
 */
function pdfTotalRowsToChecksums(
    rows: TableRow[],
    colIdxToCanonical: (string | null)[],
    sectionId: string,
): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of rows) {
        if (!row.isTotalRow) continue;
        for (let ci = 0; ci < row.cells.length; ci++) {
            const canonical = colIdxToCanonical[ci];
            if (!canonical) continue;
            const cell = row.cells[ci];
            if (cell === null) continue;
            const value = normalizeValue(cell);
            if (value.kind === 'number') {
                out[`${sectionId}.${canonical}`] = value.value;
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// DataRow-side helpers.
// ---------------------------------------------------------------------------

function dataRowToCanonicalRecord(
    row: DataRow,
    spec: ReportSpec,
    opts: MapperOptions,
    sectionId: string,
    coverage: CoverageAccumulator,
): CanonicalRecord | null {
    const ignore = new Set(spec.ignoreFields);
    const keyColumnSet = new Set(spec.keyColumns);
    const fields: Record<string, CanonicalValue> = {};
    const key: Record<string, string> = {};

    // Pre-compute canonical field for every raw column present on this row. Cache results
    // across records so a 10K-row Excel doesn't re-scan the fieldMap 10K times.
    for (const rawCol of Object.keys(row)) {
        const canonical = canonicalFieldFor(rawCol, opts.source, spec.fieldMap);
        if (!canonical) continue;
        // Recorded before the ignore/section filters: the spec's column name WAS found in the
        // source, which is exactly what the coverage gate asserts. Whether we then choose not
        // to compare it is a separate decision.
        coverage.mapped.add(canonical);
        if (ignore.has(canonical)) continue;
        // Skip the sectionColumn — it's metadata, not data.
        if (opts.sectionColumn && normalizeColumnName(rawCol) === normalizeColumnName(opts.sectionColumn)) continue;
        const raw = row[rawCol];
        const value = normalizeValue(raw ?? '', { dateFormats: spec.dateFormats });
        if (keyColumnSet.has(canonical)) {
            key[canonical] = canonicalValueToKeyString(value);
        }
        fields[canonical] = value;
    }

    const keyPopulated = spec.keyColumns.every((k) => key[k] !== undefined && key[k] !== '');
    if (!keyPopulated) {
        // Same rule as the PDF path: a row with content but no usable key is a real loss;
        // a wholly empty row is just padding.
        if (Object.keys(fields).length > 0) {
            coverage.skippedRowsBySection[sectionId] = (coverage.skippedRowsBySection[sectionId] ?? 0) + 1;
        }
        return null;
    }

    if ((opts.dropEmptyRecords ?? true) && Object.keys(fields).length === 0) return null;

    return { sectionId, key, fields };
}

// ---------------------------------------------------------------------------
// Cross-cutting utilities.
// ---------------------------------------------------------------------------

/**
 * Stringify a `CanonicalValue` for use as a key component. Uses `value` for structured
 * kinds (number, date, string) and `raw` for null (so an explicit null-token differs
 * from an absent field, though both compare as empty in the composite key). The
 * reconciler builds the composite key from these strings via `Object.keys().sort()`
 * concatenation.
 */
function canonicalValueToKeyString(v: CanonicalValue): string {
    switch (v.kind) {
        case 'number':
            return String(v.value);
        case 'date':
            return v.value;
        case 'string':
            return v.value;
        case 'null':
            return '';
    }
}

/**
 * Compute sum + count per numeric field across all records. Used for the DataRow[]
 * path (which has no extractor-side total rows to lift checksums from) — the mapper
 * derives the sums itself so the reconciler can compare A.totals vs B.totals.
 *
 * Skips key columns (they're identifiers, not measurable quantities).
 */
function computeChecksumsFromRecords(records: CanonicalRecord[], spec: ReportSpec): Record<string, number> {
    const keyCols = new Set(spec.keyColumns);
    const sums: Record<string, number> = {};
    for (const rec of records) {
        for (const [field, value] of Object.entries(rec.fields)) {
            if (keyCols.has(field)) continue;
            if (value.kind !== 'number') continue;
            const bucket = `${rec.sectionId}.${field}`;
            sums[bucket] = (sums[bucket] ?? 0) + value.value;
        }
    }
    return sums;
}

/**
 * Report-level totals — sum of every numeric non-key canonical field, keyed by canonical
 * field name (no section prefix). This is a coarser view than `meta.checksums` and is
 * used for headline "grand total" comparisons.
 */
function aggregateTotalsFromRecords(records: CanonicalRecord[], spec: ReportSpec): Record<string, number> {
    const keyCols = new Set(spec.keyColumns);
    const totals: Record<string, number> = {};
    for (const rec of records) {
        for (const [field, value] of Object.entries(rec.fields)) {
            if (keyCols.has(field)) continue;
            if (value.kind !== 'number') continue;
            totals[field] = (totals[field] ?? 0) + value.value;
        }
    }
    return totals;
}
