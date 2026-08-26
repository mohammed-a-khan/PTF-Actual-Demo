/**
 * Simple PDF validator — the one-call entry point for the everyday case.
 *
 * Given (pdfPath, spec, expectedValues), extracts every field + table declared
 * in the spec, normalizes both sides, compares, and returns a diff. No
 * cross-source reconciliation, no fingerprint cache, no HTML output. That
 * heavier machinery lives in CSReportValidationService for consumers who
 * need it.
 *
 * Contract for `expectedValues`:
 *   - Keys match spec field/table names 1:1.
 *   - Scalar field: value is a string (or number/Date — will be normalized).
 *   - Table: value is an array of row objects with the same keys as the
 *     spec's `columns[].key`.
 *   - Keys present in expected but not in the spec produce a warning finding.
 *   - Keys in the spec but not in expected are extracted (populates diff)
 *     but not asserted — status = 'informational'.
 *
 * @module report-validation/CSReportSimpleValidator
 */

import { extractPagesFromPdf } from './CSReportPdfExtractor';
import type { PageContent, TextItem } from './CSReportPdfTypes';
import type { SimpleReportSpec, SimpleFieldKind } from './CSReportSimpleSpec';
import { extractField } from './CSReportSimpleFieldExtractor';
import { detectPresence } from './CSReportSimplePresenceDetector';
import { extractTable } from './CSReportSimpleTableExtractor';

export type FieldStatus = 'match' | 'mismatch' | 'missing-in-pdf' | 'informational' | 'unknown-in-spec';
export type TableStatus = 'match' | 'mismatch' | 'missing-in-pdf' | 'informational' | 'unknown-in-spec';

export interface FieldFinding {
    name: string;
    status: FieldStatus;
    extracted: string | null;
    expected: string | null;
    normalizedExtracted?: string;
    normalizedExpected?: string;
    reason?: string;
}

export interface TableRowFinding {
    rowKey: string;
    status: 'match' | 'mismatch' | 'missing-in-pdf' | 'extra-in-pdf';
    extracted?: Record<string, string>;
    expected?: Record<string, string>;
    cellDiffs?: Array<{ column: string; extracted: string; expected: string }>;
}

export interface TableFinding {
    name: string;
    status: TableStatus;
    extractedRowCount: number;
    expectedRowCount: number;
    rows: TableRowFinding[];
    reason?: string;
}

export interface ValidationSummary {
    pdfPath: string;
    specName: string;
    totalFields: number;
    fieldMatches: number;
    fieldMismatches: number;
    fieldMissing: number;
    totalTables: number;
    tableMatches: number;
    tableMismatches: number;
    tableMissing: number;
    passed: boolean;
}

export interface ValidationResult {
    summary: ValidationSummary;
    fields: FieldFinding[];
    tables: TableFinding[];
    warnings: string[];
}

export interface ValidateOptions {
    pdfPath: string;
    spec: SimpleReportSpec;
    expectedValues: Record<string, unknown>;
}

export async function validatePdfAgainstSpec(opts: ValidateOptions): Promise<ValidationResult> {
    const pages = await extractPagesFromPdf(opts.pdfPath);
    // pdfjs emits explicit whitespace-only "spacer" tokens for horizontal
    // padding between real text. They break gap-based readRight because the
    // gap calculation sees them as contiguous with real content. Drop them here
    // at pipeline entry so no downstream extractor has to think about them.
    const tokensByPage = pages.map((p: PageContent) =>
        (p.textItems ?? []).filter((t) => t.str && t.str.trim().length > 0),
    );
    return validatePdfFromTokens({ ...opts, tokensByPage });
}

/** Same as validatePdfAgainstSpec but takes pre-parsed tokens (handy for tests + reuse). */
export function validatePdfFromTokens(opts: ValidateOptions & { tokensByPage: TextItem[][] }): ValidationResult {
    const { pdfPath, spec, expectedValues, tokensByPage } = opts;
    const fields: FieldFinding[] = [];
    const tables: TableFinding[] = [];
    const warnings: string[] = [];

    const specFieldKeys = new Set(Object.keys(spec.fields ?? {}));
    const specTableKeys = new Set(Object.keys(spec.tables ?? {}));

    // Fields
    for (const [name, fieldSpec] of Object.entries(spec.fields ?? {})) {
        const hasExpected = Object.prototype.hasOwnProperty.call(expectedValues, name);
        const expectedRaw = hasExpected ? String(expectedValues[name] ?? '') : null;
        let extracted: string | null;
        let reason: string | undefined;
        if (fieldSpec.presenceOfText) {
            extracted = detectPresence(tokensByPage, fieldSpec);
        } else {
            const res = extractField(tokensByPage, fieldSpec);
            extracted = res.value;
            reason = res.reason;
        }
        if (!hasExpected) {
            fields.push({
                name,
                status: 'informational',
                extracted,
                expected: null,
                reason: 'no expected value provided — extracted only',
            });
            continue;
        }
        if (extracted === null) {
            fields.push({
                name,
                status: 'missing-in-pdf',
                extracted: null,
                expected: expectedRaw,
                reason,
            });
            continue;
        }
        const normExtracted = normalizeValueByKind(extracted, fieldSpec.kind ?? 'string');
        const normExpected = normalizeValueByKind(expectedRaw ?? '', fieldSpec.kind ?? 'string');
        const match = normExtracted === normExpected;
        fields.push({
            name,
            status: match ? 'match' : 'mismatch',
            extracted,
            expected: expectedRaw,
            normalizedExtracted: normExtracted,
            normalizedExpected: normExpected,
        });
    }

    // Tables
    for (const [name, tableSpec] of Object.entries(spec.tables ?? {})) {
        const hasExpected = Object.prototype.hasOwnProperty.call(expectedValues, name);
        const expectedRows = hasExpected ? (expectedValues[name] as Array<Record<string, string>>) : null;
        const extraction = extractTable(tokensByPage, tableSpec);
        if (extraction.reason) {
            tables.push({
                name,
                status: hasExpected ? 'missing-in-pdf' : 'informational',
                extractedRowCount: 0,
                expectedRowCount: expectedRows?.length ?? 0,
                rows: [],
                reason: extraction.reason,
            });
            continue;
        }
        if (!hasExpected) {
            tables.push({
                name,
                status: 'informational',
                extractedRowCount: extraction.rows.length,
                expectedRowCount: 0,
                rows: extraction.rows.map((r, i) => ({ rowKey: `row#${i}`, status: 'extra-in-pdf', extracted: r })),
                reason: 'no expected rows provided — extracted only',
            });
            continue;
        }
        const rowFindings = diffTableRows(extraction.rows, expectedRows ?? [], tableSpec.keyColumns ?? []);
        const anyMismatch = rowFindings.some((r) => r.status !== 'match');
        tables.push({
            name,
            status: anyMismatch ? 'mismatch' : 'match',
            extractedRowCount: extraction.rows.length,
            expectedRowCount: expectedRows?.length ?? 0,
            rows: rowFindings,
        });
    }

    // Warn about extra keys in expected that aren't declared in the spec.
    for (const key of Object.keys(expectedValues)) {
        if (!specFieldKeys.has(key) && !specTableKeys.has(key)) {
            warnings.push(`expected value "${key}" is not declared in spec "${spec.name}" — ignored`);
        }
    }

    const fieldMatches = fields.filter((f) => f.status === 'match').length;
    const fieldMismatches = fields.filter((f) => f.status === 'mismatch').length;
    const fieldMissing = fields.filter((f) => f.status === 'missing-in-pdf').length;
    const tableMatches = tables.filter((t) => t.status === 'match').length;
    const tableMismatches = tables.filter((t) => t.status === 'mismatch').length;
    const tableMissing = tables.filter((t) => t.status === 'missing-in-pdf').length;
    const passed = fieldMismatches === 0 && fieldMissing === 0 && tableMismatches === 0 && tableMissing === 0;
    return {
        summary: {
            pdfPath,
            specName: spec.name,
            totalFields: fields.length,
            fieldMatches,
            fieldMismatches,
            fieldMissing,
            totalTables: tables.length,
            tableMatches,
            tableMismatches,
            tableMissing,
            passed,
        },
        fields,
        tables,
        warnings,
    };
}

function diffTableRows(
    extracted: Array<Record<string, string>>,
    expected: Array<Record<string, string>>,
    keyColumns: string[],
): TableRowFinding[] {
    const findings: TableRowFinding[] = [];
    if (keyColumns.length === 0) {
        // Positional comparison — pair by index.
        const max = Math.max(extracted.length, expected.length);
        for (let i = 0; i < max; i++) {
            const ex = extracted[i];
            const exp = expected[i];
            if (ex && exp) {
                findings.push(compareRow(`row#${i}`, ex, exp));
            } else if (ex) {
                findings.push({ rowKey: `row#${i}`, status: 'extra-in-pdf', extracted: ex });
            } else if (exp) {
                findings.push({ rowKey: `row#${i}`, status: 'missing-in-pdf', expected: exp });
            }
        }
        return findings;
    }
    // Key-based comparison.
    const keyOf = (r: Record<string, string>) => keyColumns.map((c) => (r[c] ?? '').trim()).join('|');
    const extractedByKey = new Map<string, Record<string, string>>();
    for (const r of extracted) extractedByKey.set(keyOf(r), r);
    const seen = new Set<string>();
    for (const exp of expected) {
        const key = keyOf(exp);
        const ex = extractedByKey.get(key);
        seen.add(key);
        if (!ex) {
            findings.push({ rowKey: key, status: 'missing-in-pdf', expected: exp });
        } else {
            findings.push(compareRow(key, ex, exp));
        }
    }
    for (const [key, row] of extractedByKey) {
        if (!seen.has(key)) findings.push({ rowKey: key, status: 'extra-in-pdf', extracted: row });
    }
    return findings;
}

function compareRow(
    key: string,
    extracted: Record<string, string>,
    expected: Record<string, string>,
): TableRowFinding {
    const cellDiffs: Array<{ column: string; extracted: string; expected: string }> = [];
    const allCols = new Set([...Object.keys(extracted), ...Object.keys(expected)]);
    for (const col of allCols) {
        const ex = (extracted[col] ?? '').trim();
        const exp = (expected[col] ?? '').trim();
        if (normalizeCurrencyOrStringForCell(ex) !== normalizeCurrencyOrStringForCell(exp)) {
            cellDiffs.push({ column: col, extracted: ex, expected: exp });
        }
    }
    if (cellDiffs.length === 0) {
        return { rowKey: key, status: 'match', extracted, expected };
    }
    return { rowKey: key, status: 'mismatch', extracted, expected, cellDiffs };
}

// ---- Normalization ---------------------------------------------------------

function normalizeValueByKind(raw: string, kind: SimpleFieldKind): string {
    const trimmed = raw.trim();
    switch (kind) {
        case 'currency':
            return normalizeCurrency(trimmed);
        case 'number':
            return normalizeNumber(trimmed);
        case 'date':
            return normalizeDate(trimmed);
        case 'string':
        default:
            // Collapse runs of whitespace to single space so tokens joined across
            // horizontal gaps (which may span multiple spaces) match human-typed values.
            return trimmed.replace(/\s+/g, ' ');
    }
}

function normalizeCurrency(raw: string): string {
    // Strip common currency prefixes/suffixes and thousands separators.
    // ($1,234.56) becomes -1234.56; USD $200.00 becomes 200; $0.00 becomes 0.
    let s = raw.trim();
    let negative = false;
    const parenMatch = s.match(/^\(\s*(.*?)\s*\)$/);
    if (parenMatch) {
        s = parenMatch[1];
        negative = true;
    }
    s = s.replace(/USD\s*/i, '').replace(/\$/g, '').replace(/,/g, '').trim();
    if (s.startsWith('-')) {
        negative = !negative;
        s = s.substring(1).trim();
    }
    if (s.startsWith('.')) s = '0' + s;
    const n = parseFloat(s);
    if (Number.isNaN(n)) return raw.trim();
    return String(negative ? -n : n);
}

function normalizeNumber(raw: string): string {
    const s = raw.replace(/,/g, '').trim();
    const n = parseFloat(s);
    return Number.isNaN(n) ? raw.trim() : String(n);
}

function normalizeDate(raw: string): string {
    // Accept MM/DD/YYYY, M/D/YYYY, YYYY-MM-DD → normalize to YYYY-MM-DD.
    const s = raw.trim();
    const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) return `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}`;
    const us = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (us) return `${us[3]}-${pad(us[1])}-${pad(us[2])}`;
    return s;
}

function pad(n: string): string {
    return n.length === 1 ? `0${n}` : n;
}

function normalizeCurrencyOrStringForCell(raw: string): string {
    // Table cells may be currency-shaped or plain strings; try currency norm first, then plain.
    const currencyLike = /^\(?\s*\$?USD?\$?\s*\d/.test(raw);
    return currencyLike ? normalizeCurrency(raw) : raw.trim();
}
