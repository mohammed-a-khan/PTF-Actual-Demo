/**
 * BDD step-defs for the SIMPLE PDF validator.
 *
 * These wrap `CSReportSimpleValidator.validatePdfAgainstSpec` with three
 * ergonomic surfaces:
 *   1. Full spec + expected-values-bag  → matches spec {string}
 *   2. Ad-hoc data-table (no spec file) → should have: {dataTable}
 *   3. Single field one-liner           → should have {string} equal to {string}
 *
 * Consumers pick whichever fits the scenario. All three use the same
 * extractor + normalizer under the hood.
 *
 * The spec-driven step (#1) reads expected values from `CSBDDContext` under
 * the key `reportExpected`. Consumers put values there via any pattern
 * they already use — a helper step that copies the current scenario-outline
 * row, a DB-helper method, a UI-capture step, etc. This module intentionally
 * does NOT ship SQL-in-feature or locator-in-feature primitives; that's the
 * consumer's own step-def surface.
 *
 * A convenience helper `Given the expected report values:` is provided so
 * consumers can pass an ad-hoc row inline when they don't want a helper.
 *
 * @module steps/report-validation/CSPdfValidationSteps
 */

import * as path from 'path';
import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSBDDContext } from '../../bdd/CSBDDContext';
import { CSReporter } from '../../reporter/CSReporter';
import { CSTestResultsManager } from '../../reporter/CSTestResultsManager';
import { loadSimpleReportSpec, type SimpleReportSpec } from '../../report-validation/CSReportSimpleSpec';
import {
    validatePdfAgainstSpec,
    type ValidationResult,
} from '../../report-validation/CSReportSimpleValidator';

const EXPECTED_BAG_KEY = 'reportExpected';
const DEFAULT_SPEC_DIR = 'config/report-specs';

export class CSPdfValidationSteps {
    /**
     * Populate the expected-values bag inline from a data table.
     * Row shape: | field | value |
     *
     * Alternative to authoring a consumer step that reads the scenario-outline
     * row or a DB row. Fine for small ad-hoc scenarios.
     */
    @CSBDDStepDef('the expected report values:')
    async setExpectedFromTable(rows: Array<Record<string, string>>): Promise<void> {
        const ctx = CSBDDContext.getInstance();
        const bag: Record<string, unknown> = (ctx.get(EXPECTED_BAG_KEY) as Record<string, unknown>) ?? {};
        for (const row of rows) {
            const key = row.field ?? row.name ?? row.key;
            const value = row.value ?? row.expected ?? row.expectedValue;
            if (!key) throw new Error(`expected-values row missing 'field' column: ${JSON.stringify(row)}`);
            bag[key] = value ?? '';
        }
        ctx.set(EXPECTED_BAG_KEY, bag);
        CSReporter.info(`Expected report values set: ${Object.keys(bag).join(', ')}`);
    }

    /**
     * Full-spec validation. Expected values come from the reportExpected bag
     * in CSBDDContext (populated by whatever pattern the consumer prefers).
     * Fields declared in the spec but not present in the bag are extracted
     * but not asserted — they show as informational in the diff.
     */
    @CSBDDStepDef('the PDF at {string} matches spec {string}')
    async validateAgainstSpec(pdfPath: string, specName: string): Promise<void> {
        const resolvedPdfPath = resolveRelativePath(pdfPath);
        const spec = loadSpec(specName);
        const expected = getExpectedBag();
        await runAndReport(resolvedPdfPath, spec, expected);
    }

    /** Sibling: read the PDF path from CSBrowserManager's download tracker. */
    @CSBDDStepDef('the last downloaded PDF matches spec {string}')
    async validateLastDownloadAgainstSpec(specName: string): Promise<void> {
        const latest = CSTestResultsManager.getInstance().getLatestDownloadedFile();
        if (!latest) throw new Error('No downloaded file tracked. Use the "at <path>" variant or trigger a framework-managed download first.');
        const spec = loadSpec(specName);
        const expected = getExpectedBag();
        await runAndReport(latest.filePath, spec, expected);
    }

    /**
     * Ad-hoc single-field assertion. No spec file needed.
     *
     *   Then the PDF at "path.pdf" should have "Total Amount Due:" equal to "$200.00"
     */
    @CSBDDStepDef('the PDF at {string} should have {string} equal to {string}')
    async assertSingleField(pdfPath: string, label: string, expected: string): Promise<void> {
        const resolvedPdfPath = resolveRelativePath(pdfPath);
        const spec: SimpleReportSpec = {
            name: `inline-${label}`,
            fields: {
                value: { label, readFrom: guessReadFromForLabel(label), kind: guessKindForValue(expected) },
            },
        };
        await runAndReport(resolvedPdfPath, spec, { value: expected });
    }

    /**
     * Ad-hoc multi-field assertion via data table. No spec file needed.
     *
     *   Then the PDF at "path.pdf" should have:
     *     | field           | label              | expectedValue | kind     |
     *     | invoiceDate     | Billing Date       | 08/22/2025    | date     |
     *     | totalAmountDue  | Total Amount Due:  | $200.00       | currency |
     *
     * Columns: `field` (spec key), `label` (PDF anchor), `expectedValue`,
     * and optional `kind` (string|number|date|currency) and `readFrom` (below|right|inline).
     */
    @CSBDDStepDef('the PDF at {string} should have:')
    async assertMultiFieldsTable(pdfPath: string, rows: Array<Record<string, string>>): Promise<void> {
        const resolvedPdfPath = resolveRelativePath(pdfPath);
        const spec: SimpleReportSpec = { name: 'inline-datatable', fields: {} };
        const expected: Record<string, string> = {};
        for (const row of rows) {
            const key = row.field ?? row.name;
            if (!key) throw new Error(`row missing 'field' column: ${JSON.stringify(row)}`);
            const label = row.label ?? key;
            const kind = (row.kind as 'string' | 'number' | 'date' | 'currency') || guessKindForValue(row.expectedValue ?? row.expected ?? '');
            const readFrom = (row.readFrom as 'below' | 'right' | 'inline') || guessReadFromForLabel(label);
            spec.fields![key] = { label, readFrom, kind };
            expected[key] = row.expectedValue ?? row.expected ?? '';
        }
        await runAndReport(resolvedPdfPath, spec, expected);
    }
}

// ---------- Internals ------------------------------------------------------

function getExpectedBag(): Record<string, unknown> {
    const ctx = CSBDDContext.getInstance();
    const bag = ctx.get(EXPECTED_BAG_KEY) as Record<string, unknown> | undefined;
    return bag ?? {};
}

function loadSpec(specNameOrPath: string): SimpleReportSpec {
    const dir = resolveRelativePath(DEFAULT_SPEC_DIR);
    return loadSimpleReportSpec(specNameOrPath, dir);
}

function resolveRelativePath(p: string): string {
    if (path.isAbsolute(p)) return p;
    const root = process.env.CS_QA_WORKSPACE_ROOT || process.cwd();
    return path.join(root, p);
}

async function runAndReport(
    pdfPath: string,
    spec: SimpleReportSpec,
    expected: Record<string, unknown>,
): Promise<void> {
    CSReporter.info(`Validating PDF against spec "${spec.name}": ${pdfPath}`);
    let result: ValidationResult;
    try {
        result = await validatePdfAgainstSpec({ pdfPath, spec, expectedValues: expected });
    } catch (e) {
        CSReporter.error(`PDF validation failed to run: ${(e as Error).message}`);
        throw e;
    }
    logResult(result);
    if (!result.summary.passed) {
        const failed = [
            ...result.fields.filter((f) => f.status === 'mismatch' || f.status === 'missing-in-pdf'),
        ].map((f) => `field "${f.name}": expected="${f.expected}" extracted="${f.extracted}" (${f.status})`);
        const failedTables = result.tables
            .filter((t) => t.status !== 'match' && t.status !== 'informational')
            .map((t) => `table "${t.name}": ${t.status} (${t.rows.filter((r) => r.status !== 'match').length} row diffs)`);
        const message = [
            `PDF validation FAILED for "${pdfPath}" against spec "${spec.name}"`,
            ...failed,
            ...failedTables,
        ].join('\n  ');
        throw new Error(message);
    }
}

function logResult(result: ValidationResult): void {
    const s = result.summary;
    CSReporter.info(
        `PDF validation summary: fields ${s.fieldMatches}/${s.totalFields} match (${s.fieldMismatches} mismatch, ${s.fieldMissing} missing), tables ${s.tableMatches}/${s.totalTables} match (${s.tableMismatches} mismatch, ${s.tableMissing} missing)`,
    );
    for (const f of result.fields) {
        if (f.status === 'match') CSReporter.pass(`  field "${f.name}": ${f.extracted}`);
        else if (f.status === 'mismatch')
            CSReporter.fail(`  field "${f.name}": expected="${f.expected}" got="${f.extracted}"`);
        else if (f.status === 'missing-in-pdf')
            CSReporter.fail(`  field "${f.name}": expected="${f.expected}" but not found in PDF (${f.reason ?? 'no reason'})`);
        else if (f.status === 'informational')
            CSReporter.debug(`  field "${f.name}" (info-only): extracted="${f.extracted}"`);
    }
    for (const t of result.tables) {
        if (t.status === 'match') CSReporter.pass(`  table "${t.name}": ${t.extractedRowCount} rows match`);
        else if (t.status === 'informational')
            CSReporter.debug(`  table "${t.name}" (info-only): ${t.extractedRowCount} rows extracted`);
        else {
            CSReporter.fail(
                `  table "${t.name}": ${t.status} — extracted=${t.extractedRowCount} expected=${t.expectedRowCount}${t.reason ? ' (' + t.reason + ')' : ''}`,
            );
            for (const r of t.rows.filter((x) => x.status !== 'match')) {
                CSReporter.fail(`    row [${r.rowKey}]: ${r.status}`);
                for (const d of r.cellDiffs ?? []) {
                    CSReporter.fail(`      column "${d.column}": expected="${d.expected}" got="${d.extracted}"`);
                }
            }
        }
    }
    for (const w of result.warnings) CSReporter.warn(w);
}

function guessReadFromForLabel(label: string): 'below' | 'right' | 'inline' {
    // Labels ending with ':' typically mean the value is right of the anchor or inline after ': '.
    const trimmed = label.trim();
    if (trimmed.endsWith(':')) return 'right';
    return 'below';
}

function guessKindForValue(v: string): 'string' | 'number' | 'date' | 'currency' {
    const s = (v ?? '').trim();
    if (!s) return 'string';
    if (/^\(?\s*(USD\s*)?\$/.test(s)) return 'currency';
    if (/^\(?\s*-?\d[\d,]*\.\d+\)?$/.test(s)) return 'number';
    if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(s) || /^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) return 'date';
    return 'string';
}
