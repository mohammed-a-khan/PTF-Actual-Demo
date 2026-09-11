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
import { CSConfigurationManager } from '../../core/CSConfigurationManager';
import { CSReporter } from '../../reporter/CSReporter';
import { CSTestResultsManager } from '../../reporter/CSTestResultsManager';
import { loadSimpleReportSpec, type SimpleReportSpec } from '../../report-validation/CSReportSimpleSpec';
import {
    validatePdfAgainstSpec,
    type ValidationResult,
} from '../../report-validation/CSReportSimpleValidator';
import { writeSimpleValidatorHtmlReport } from '../../report-validation/CSReportSimpleValidatorReporter';
import { resolveReportValidationOutputDir } from '../../report-validation/CSReportDiffReporter';

/**
 * Config-overridable defaults. Consumers set either in their env files
 * (e.g. `config/<project>/common/common.env`) or leave them at these defaults.
 *
 *   REPORT_SPECS_DIR       — root directory to search for spec files.
 *                            Loader walks subfolders recursively — consumers
 *                            can arrange specs as `<dir>/<team>/<name>.json`
 *                            or flat, whichever they prefer. Default: `config/report-specs`.
 *   REPORT_EXPECTED_KEY    — CSBDDContext key that holds the expected-values
 *                            bag the `matches spec` step reads from. Consumers
 *                            populate it via their own step-defs. Default: `reportExpected`.
 */
const CFG_KEY_SPEC_DIR = 'REPORT_SPECS_DIR';
const CFG_KEY_EXPECTED_BAG = 'REPORT_EXPECTED_KEY';
const DEFAULT_SPEC_DIR = 'config/report-specs';
const DEFAULT_EXPECTED_BAG_KEY = 'reportExpected';

export class CSPdfValidationSteps {
    /**
     * Populate the expected-values bag inline from a data table.
     * Row shape: | field | value |
     *
     * Alternative to authoring a consumer step that reads the scenario-outline
     * row or a DB row. Fine for small ad-hoc scenarios.
     */
    @CSBDDStepDef('the expected report values:')
    async setExpectedFromTable(dataTable: unknown): Promise<void> {
        const ctx = CSBDDContext.getInstance();
        const bagKey = resolveExpectedBagKey();
        const bag: Record<string, unknown> = (ctx.get(bagKey) as Record<string, unknown>) ?? {};
        const rows = toHashRows(dataTable);
        for (const row of rows) {
            const key = row.field ?? row.name ?? row.key;
            const value = row.value ?? row.expected ?? row.expectedValue;
            if (!key) throw new Error(`expected-values row missing 'field' column: ${JSON.stringify(row)}`);
            bag[key] = value ?? '';
        }
        ctx.set(bagKey, bag);
        CSReporter.info(`Expected report values set (context key '${bagKey}'): ${Object.keys(bag).join(', ')}`);
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
     * Test-data-first entry point — the whole scenario is one line.
     *
     *   Then the PDF at "samples/invoice.pdf" matches expected values from "test/data/invoice.json"
     *
     * The JSON's top-level keys ARE the labels as they appear in the PDF.
     * Framework auto-extracts + compares. No spec file, no scenario outline,
     * no consumer step-def to author.
     */
    @CSBDDStepDef('the PDF at {string} matches expected values from {string}')
    async validatePdfFromDataFile(pdfPath: string, dataPath: string): Promise<void> {
        const resolvedPdfPath = resolveRelativePath(pdfPath);
        const resolvedDataPath = resolveRelativePath(dataPath);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { validatePdfFromDataFile } = require('../../report-validation/CSReportSimpleValidatorFromData');
        CSReporter.info(`Validating PDF against test-data: ${resolvedPdfPath} → ${resolvedDataPath}`);
        const result: ValidationResult = await validatePdfFromDataFile({
            pdfPath: resolvedPdfPath,
            dataPath: resolvedDataPath,
        });
        // Reuse the classic reporter — writes an HTML file next to the run.
        try {
            const outDir = resolveReportValidationOutputDir();
            const outPath = path.join(outDir, `${result.summary.specName}-${Date.now()}.html`);
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { writeSimpleValidatorHtmlReport } = require('../../report-validation/CSReportSimpleValidatorReporter');
            const write = writeSimpleValidatorHtmlReport(result, {
                outputPath: outPath,
                title: `PDF Validation (test-data) — ${result.summary.specName}`,
                writeJsonCopy: true,
            });
            CSReporter.info(`PDF validation report: ${write.htmlPath}`);
        } catch (e) {
            CSReporter.warn(`HTML report emit failed: ${(e as Error).message}`);
        }
        if (!result.summary.passed) {
            const lines: string[] = [
                `PDF validation FAILED for "${resolvedPdfPath}" against test-data "${resolvedDataPath}"`,
            ];
            for (const f of result.fields) {
                if (f.status === 'mismatch' || f.status === 'missing-in-pdf') {
                    lines.push(`  field "${f.name}": expected="${f.expected}" extracted="${f.extracted}" (${f.status})`);
                }
            }
            // Roll up phase-1..6 findings so BDD log names the drift explicitly.
            const push = (label: string, arr: Array<{ kind: string; message: string }>) => {
                if (!arr || !arr.length) return;
                lines.push(`  ${label} (${arr.length}):`);
                for (const x of arr) lines.push(`    - [${x.kind}] ${x.message}`);
            };
            push('Metadata', result.phase1.metadata);
            push('Links', result.phase1.links);
            push('Header/Footer', result.phase1.headerFooter);
            push('Watermarks', result.phase1.watermarks);
            push('Layout', result.phase1.layout);
            push('Integrity', result.phase1.integrity);
            push('Text quality', result.phase1.textQuality);
            push('Structural', result.phase3.structural);
            push('Interactive', result.phase3.interactive);
            push('Attachments', result.phase3.attachments);
            push('Table depth', result.phase3.tableDepthFindings);
            push('Images', result.phase4.images);
            push('Contrast', result.phase4.contrast);
            push('Chart regions', result.phase4.chartRegions);
            push('Visual regression', result.phase4.visualRegression.filter((f) => f.kind !== 'BASELINE_UPDATED' && f.kind !== 'MISSING_BASELINE'));
            push('Security', result.phase5.security);
            push('Barcodes', result.phase5.barcodes);
            push('Version diff', result.phase6.versionDiff);
            throw new Error(lines.join('\n'));
        }
        CSReporter.pass(
            `PDF validation PASSED — ${result.summary.fieldMatches}/${result.summary.totalFields} fields matched`,
        );
    }

    /**
     * v1.53 — Zero-config PDF-vs-PDF reconciliation.
     *
     *   Then the PDF at "current.pdf" matches the reference PDF at "legacy.pdf"
     *
     * Framework auto-detects sections + columns + keyColumns from both PDFs,
     * applies default tolerances (currency 0.01), and reconciles cell-by-cell.
     * Zero JSON authored by the consumer. For overrides (custom tolerance,
     * known-differences, forced aliases) use the `using rules from ...`
     * variant below.
     */
    @CSBDDStepDef('the PDF at {string} matches the reference PDF at {string}')
    async reconcilePdfPairAuto(candidatePdf: string, referencePdf: string): Promise<void> {
        const candidateAbs = resolveRelativePath(candidatePdf);
        const referenceAbs = resolveRelativePath(referencePdf);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { generateReconciliationRulesFromPair, reconcilePdfsFromRules } = require('../../report-validation/CSPdfPairReconciler');
        CSReporter.info(`Reconciling PDF pair (auto-mode): ${candidateAbs} vs ${referenceAbs}`);
        const rulesInline = await generateReconciliationRulesFromPair({
            candidatePdfPath: candidateAbs,
            referencePdfPath: referenceAbs,
        });
        if (Object.keys(rulesInline.sections).length === 0) {
            throw new Error(
                `Reconciliation FAILED — auto-mode detected zero reconcilable sections between "${candidateAbs}" and "${referenceAbs}". ` +
                `This usually means both PDFs have no tabular sections OR the sections have no rows the extractor recognises as data. ` +
                `Consider using \`Then the PDF at ... matches expected values from ...\` (test-data-first) for label-based assertions instead.`,
            );
        }
        const result = await reconcilePdfsFromRules({
            candidatePdfPath: candidateAbs,
            referencePdfPath: referenceAbs,
            rulesInline,
        });
        CSReporter.info(
            `Reconciliation (auto): ${result.summary.sectionsCompared} sections, ${result.summary.columnsCompared} columns, ${result.summary.rowsCompared} rows, ${result.summary.cellsCompared} cells compared`,
        );
        emitReconcileReport(result, `auto ${path.basename(candidateAbs)} vs ${path.basename(referenceAbs)}`);
        if (!result.passed) {
            const lines: string[] = [
                `PDF reconciliation (auto) FAILED for candidate "${candidateAbs}" against reference "${referenceAbs}"`,
                `  summary: cellMismatches=${result.summary.cellMismatches} rowMissing=${result.summary.rowMissing} sectionMissing=${result.summary.sectionMissing} columnMissing=${result.summary.columnMissing} knownDiffs=${result.summary.knownDifferencesMatched}`,
            ];
            const cap = 20;
            const failing = result.findings.filter((f: { kind: string }) => f.kind !== 'KNOWN_DIFFERENCE_MATCHED').slice(0, cap);
            for (const f of failing) {
                const cell = f.column ? ` col="${f.column}"` : '';
                const key = f.key ? ` key="${f.key}"` : '';
                const values =
                    f.candidateValue !== undefined || f.referenceValue !== undefined
                        ? ` candidate="${f.candidateValue ?? '(null)'}" reference="${f.referenceValue ?? '(null)'}"`
                        : '';
                lines.push(`  [${f.kind}] section="${f.section}"${cell}${key}${values}`);
            }
            if (result.findings.length - result.summary.knownDifferencesMatched > cap) {
                lines.push(`  … and ${result.findings.length - result.summary.knownDifferencesMatched - cap} more findings`);
            }
            lines.push('');
            lines.push('  To override auto-detected tolerance / aliases / known-differences, create a rules JSON and use:');
            lines.push('    Then the PDF at "…" matches the reference PDF at "…" using rules from "…"');
            throw new Error(lines.join('\n'));
        }
        CSReporter.pass(`PDF reconciliation (auto) PASSED — ${result.summary.cellsCompared} cells reconciled clean`);
    }

    /**
     * v1.53 — PDF-vs-PDF cell-level reconciliation with tolerance + aliases.
     *
     *   Then the PDF at "current.pdf" matches the reference PDF at "legacy.pdf" using rules from "rules.json"
     *
     * Rules JSON declares sections + columns + aliases + tolerances +
     * known-differences. Framework auto-matches sections/columns by name or
     * fuzzy match at strict threshold. Cell-by-cell comparison with per-column
     * tolerance. Fails on any CELL_MISMATCH, ROW/SECTION/COLUMN_MISSING.
     * See docs/report-validation/RECONCILIATION-QUICKSTART.md.
     */
    @CSBDDStepDef('the PDF at {string} matches the reference PDF at {string} using rules from {string}')
    async reconcilePdfPair(candidatePdf: string, referencePdf: string, rulesPath: string): Promise<void> {
        const candidateAbs = resolveRelativePath(candidatePdf);
        const referenceAbs = resolveRelativePath(referencePdf);
        const rulesAbs = resolveRelativePath(rulesPath);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { reconcilePdfsFromRules } = require('../../report-validation/CSPdfPairReconciler');
        CSReporter.info(`Reconciling PDF pair: ${candidateAbs} vs ${referenceAbs} using ${rulesAbs}`);
        const result = await reconcilePdfsFromRules({
            candidatePdfPath: candidateAbs,
            referencePdfPath: referenceAbs,
            rulesPath: rulesAbs,
        });
        CSReporter.info(
            `Reconciliation: ${result.summary.sectionsCompared} sections, ${result.summary.columnsCompared} columns, ${result.summary.rowsCompared} rows, ${result.summary.cellsCompared} cells compared`,
        );
        emitReconcileReport(result, `${path.basename(candidateAbs)} vs ${path.basename(referenceAbs)} (${path.basename(rulesAbs)})`);
        if (!result.passed) {
            const lines: string[] = [
                `PDF reconciliation FAILED for candidate "${candidateAbs}" against reference "${referenceAbs}"`,
                `  summary: cellMismatches=${result.summary.cellMismatches} rowMissing=${result.summary.rowMissing} sectionMissing=${result.summary.sectionMissing} columnMissing=${result.summary.columnMissing} knownDiffs=${result.summary.knownDifferencesMatched}`,
            ];
            const cap = 20;
            const failing = result.findings.filter((f: { kind: string }) => f.kind !== 'KNOWN_DIFFERENCE_MATCHED').slice(0, cap);
            for (const f of failing) {
                const cell = f.column ? ` col="${f.column}"` : '';
                const key = f.key ? ` key="${f.key}"` : '';
                const values =
                    f.candidateValue !== undefined || f.referenceValue !== undefined
                        ? ` candidate="${f.candidateValue ?? '(null)'}" reference="${f.referenceValue ?? '(null)'}"`
                        : '';
                const delta = f.delta !== undefined ? ` delta=${f.delta} tolerance=${f.tolerance}` : '';
                lines.push(`  [${f.kind}] section="${f.section}"${cell}${key}${values}${delta}`);
            }
            if (result.findings.length - result.summary.knownDifferencesMatched > cap) {
                lines.push(`  … and ${result.findings.length - result.summary.knownDifferencesMatched - cap} more findings (see HTML report)`);
            }
            throw new Error(lines.join('\n'));
        }
        CSReporter.pass(
            `PDF reconciliation PASSED — ${result.summary.cellsCompared} cells reconciled clean` +
                (result.summary.knownDifferencesMatched > 0 ? `, ${result.summary.knownDifferencesMatched} known-diffs matched` : ''),
        );
    }

    /**
     * v1.53 — PDF-vs-DB reconciliation via a consumer-supplied helper module.
     *
     *   Then the PDF at "invoice.pdf" matches the reference DB rows using rules from "rules.json"
     *
     * Rules JSON's `referenceDataSource` block points at a consumer helper +
     * method + params. Helper returns Row[] (simple) or {resultSets: Row[][]}
     * (multi — for stored procs). Framework treats DB rows as the reference
     * side and drives the same reconciler engine as PDF-vs-PDF.
     * See docs/report-validation/RECONCILIATION-QUICKSTART.md § DB-source.
     */
    @CSBDDStepDef('the PDF at {string} matches the reference DB rows using rules from {string}')
    async reconcilePdfDb(candidatePdf: string, rulesPath: string): Promise<void> {
        const candidateAbs = resolveRelativePath(candidatePdf);
        const rulesAbs = resolveRelativePath(rulesPath);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { reconcilePdfDbFromRules } = require('../../report-validation/CSPdfDbReconciler');
        CSReporter.info(`Reconciling PDF vs DB: ${candidateAbs} using ${rulesAbs}`);
        const result = await reconcilePdfDbFromRules({
            candidatePdfPath: candidateAbs,
            rulesPath: rulesAbs,
        });
        CSReporter.info(
            `Reconciliation: ${result.summary.sectionsCompared} sections, ${result.summary.columnsCompared} columns, ${result.summary.rowsCompared} rows, ${result.summary.cellsCompared} cells compared`,
        );
        emitReconcileReport(result, `${path.basename(candidateAbs)} vs DB (${path.basename(rulesAbs)})`);
        if (!result.passed) {
            const lines: string[] = [
                `PDF-vs-DB reconciliation FAILED for candidate "${candidateAbs}"`,
                `  summary: cellMismatches=${result.summary.cellMismatches} rowMissing=${result.summary.rowMissing} sectionMissing=${result.summary.sectionMissing} columnMissing=${result.summary.columnMissing} knownDiffs=${result.summary.knownDifferencesMatched}`,
            ];
            const cap = 20;
            const failing = result.findings.filter((f: { kind: string }) => f.kind !== 'KNOWN_DIFFERENCE_MATCHED').slice(0, cap);
            for (const f of failing) {
                const cell = f.column ? ` col="${f.column}"` : '';
                const key = f.key ? ` key="${f.key}"` : '';
                const values =
                    f.candidateValue !== undefined || f.referenceValue !== undefined
                        ? ` candidate="${f.candidateValue ?? '(null)'}" reference="${f.referenceValue ?? '(null)'}"`
                        : '';
                const delta = f.delta !== undefined ? ` delta=${f.delta} tolerance=${f.tolerance}` : '';
                lines.push(`  [${f.kind}] section="${f.section}"${cell}${key}${values}${delta}`);
            }
            if (result.findings.length - result.summary.knownDifferencesMatched > cap) {
                lines.push(`  … and ${result.findings.length - result.summary.knownDifferencesMatched - cap} more findings (see HTML report)`);
            }
            throw new Error(lines.join('\n'));
        }
        CSReporter.pass(
            `PDF-vs-DB reconciliation PASSED — ${result.summary.cellsCompared} cells reconciled clean` +
                (result.summary.knownDifferencesMatched > 0 ? `, ${result.summary.knownDifferencesMatched} known-diffs matched` : ''),
        );
    }

    /**
     * v1.53 — ZERO-JSON PDF-vs-DB reconciliation. Consumer supplies only the
     * helper method name (resolved from `HELPERS_PATH` config) and any params.
     * Framework auto-detects the matching PDF section, auto-composes the key
     * columns, and reconciles in auto-mode.
     *
     *   Then the PDF at "invoice.pdf" matches DB rows from "CloDbHelper.getDeferringSecurities"
     *
     *   Then the PDF at "invoice.pdf" matches DB rows from "CloDbHelper.getDeferringSecurities" with params:
     *     | reportAsOf | 2025-01-16 |
     *     | region     | NA         |
     *
     * `helperSpec` format: `"ClassName.methodName"` (resolved to
     * `HELPERS_PATH/ClassName.js`). Optional `@Section` suffix hints the
     * target section on the PDF when auto-detection is ambiguous:
     *   `"CloDbHelper.getDeferringSecurities@Deferring Securities Detail"`
     */
    @CSBDDStepDef('the PDF at {string} matches DB rows from {string}')
    async reconcilePdfDbSimple(candidatePdf: string, helperSpec: string): Promise<void> {
        await this.runPdfDbAuto(candidatePdf, helperSpec, {});
    }

    @CSBDDStepDef('the PDF at {string} matches DB rows from {string} with params:')
    async reconcilePdfDbSimpleWithParams(
        candidatePdf: string,
        helperSpec: string,
        dataTable: unknown,
    ): Promise<void> {
        await this.runPdfDbAuto(candidatePdf, helperSpec, paramsFromTable(dataTable));
    }

    /** Internal — shared by both zero-JSON step variants. */
    private async runPdfDbAuto(
        candidatePdf: string,
        helperSpec: string,
        params: Record<string, unknown>,
    ): Promise<void> {
        const candidateAbs = resolveRelativePath(candidatePdf);
        const parsed = parseHelperSpec(helperSpec);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { reconcilePdfDbAuto } = require('../../report-validation/CSPdfDbReconciler');
        CSReporter.info(
            `Reconciling PDF vs DB (auto): ${candidateAbs} via ${parsed.helperModule}.${parsed.method}` +
                (parsed.sectionHint ? ` → section "${parsed.sectionHint}"` : ' (auto-section)'),
        );
        const result = await reconcilePdfDbAuto({
            candidatePdfPath: candidateAbs,
            helperModule: parsed.helperModule,
            helperClassName: parsed.helperModule,
            method: parsed.method,
            params,
            sectionHint: parsed.sectionHint,
        });
        CSReporter.info(
            `Reconciliation (auto): ${result.summary.sectionsCompared} sections, ${result.summary.columnsCompared} columns, ${result.summary.rowsCompared} rows, ${result.summary.cellsCompared} cells compared`,
        );
        emitReconcileReport(result, `${path.basename(candidateAbs)} vs DB (${parsed.helperModule}.${parsed.method})`);
        if (!result.passed) {
            const lines: string[] = [
                `PDF-vs-DB reconciliation (auto) FAILED for candidate "${candidateAbs}"`,
                `  summary: cellMismatches=${result.summary.cellMismatches} rowMissing=${result.summary.rowMissing} sectionMissing=${result.summary.sectionMissing} columnMissing=${result.summary.columnMissing} knownDiffs=${result.summary.knownDifferencesMatched}`,
            ];
            const cap = 20;
            const failing = result.findings.filter((f: { kind: string }) => f.kind !== 'KNOWN_DIFFERENCE_MATCHED').slice(0, cap);
            for (const f of failing) {
                const cell = f.column ? ` col="${f.column}"` : '';
                const key = f.key ? ` key="${f.key}"` : '';
                const values =
                    f.candidateValue !== undefined || f.referenceValue !== undefined
                        ? ` candidate="${f.candidateValue ?? '(null)'}" reference="${f.referenceValue ?? '(null)'}"`
                        : '';
                const delta = f.delta !== undefined ? ` delta=${f.delta} tolerance=${f.tolerance}` : '';
                lines.push(`  [${f.kind}] section="${f.section}"${cell}${key}${values}${delta}`);
            }
            throw new Error(lines.join('\n'));
        }
        CSReporter.pass(
            `PDF-vs-DB reconciliation (auto) PASSED — ${result.summary.cellsCompared} cells reconciled clean`,
        );
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
    async assertMultiFieldsTable(pdfPath: string, dataTable: unknown): Promise<void> {
        const resolvedPdfPath = resolveRelativePath(pdfPath);
        const spec: SimpleReportSpec = { name: 'inline-datatable', fields: {} };
        const expected: Record<string, string> = {};
        const rows = toHashRows(dataTable);
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

/**
 * Emit the reconciler's HTML + JSON audit artefact into the per-run
 * `report-validation/` folder. Called by all three reconcile step-defs
 * before pass/fail is decided, so failure artefacts are on disk too.
 */
function emitReconcileReport(result: unknown, label: string): void {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { writeReconcileHtmlReport } = require('../../report-validation/CSPdfReconcileReporter');
        const write = writeReconcileHtmlReport(result as never, {
            label,
            writeJsonCopy: true,
        });
        CSReporter.info(`Reconciliation report: ${write.htmlPath}`);
    } catch (e) {
        CSReporter.warn(`Reconciliation HTML report emit failed: ${(e as Error).message}`);
    }
}

function getExpectedBag(): Record<string, unknown> {
    const ctx = CSBDDContext.getInstance();
    const bag = ctx.get(resolveExpectedBagKey()) as Record<string, unknown> | undefined;
    return bag ?? {};
}

function loadSpec(specNameOrPath: string): SimpleReportSpec {
    const configuredDir = CSConfigurationManager.getInstance().get(CFG_KEY_SPEC_DIR, DEFAULT_SPEC_DIR);
    const dir = resolveRelativePath(configuredDir || DEFAULT_SPEC_DIR);
    return loadSimpleReportSpec(specNameOrPath, dir);
}

function resolveExpectedBagKey(): string {
    const configured = CSConfigurationManager.getInstance().get(CFG_KEY_EXPECTED_BAG, DEFAULT_EXPECTED_BAG_KEY);
    return configured || DEFAULT_EXPECTED_BAG_KEY;
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
    // Always emit a self-contained HTML report next to the run outputs. It renders
    // ALL phases (fields, tables, phase 1-6) so an out-of-band consumer can open
    // a single file and see everything the framework saw.
    const outDir = resolveReportValidationOutputDir();
    try {
        const outPath = path.join(outDir, `${spec.name}-${Date.now()}.html`);
        const write = writeSimpleValidatorHtmlReport(result, {
            outputPath: outPath,
            title: `PDF Validation — ${spec.name}`,
            writeJsonCopy: true,
        });
        CSReporter.info(`PDF validation report written: ${write.htmlPath}`);
    } catch (e) {
        CSReporter.warn(`PDF validation HTML report emit failed: ${(e as Error).message}`);
    }
    if (!result.summary.passed) {
        const failed = [
            ...result.fields.filter((f) => f.status === 'mismatch' || f.status === 'missing-in-pdf'),
        ].map((f) => `field "${f.name}": expected="${f.expected}" extracted="${f.extracted}" (${f.status})`);
        const failedTables = result.tables
            .filter((t) => t.status !== 'match' && t.status !== 'informational')
            .map((t) => `table "${t.name}": ${t.status} (${t.rows.filter((r) => r.status !== 'match').length} row diffs)`);
        // Roll up phase-1..6 findings into the thrown error so BDD reports show
        // them without the consumer having to open the HTML report.
        const phaseFailures = collectPhaseFailures(result);
        const message = [
            `PDF validation FAILED for "${pdfPath}" against spec "${spec.name}"`,
            ...failed,
            ...failedTables,
            ...phaseFailures,
        ].join('\n  ');
        throw new Error(message);
    }
}

function collectPhaseFailures(r: ValidationResult): string[] {
    const lines: string[] = [];
    const push = (label: string, arr: Array<{ kind: string; message: string }>) => {
        if (!arr.length) return;
        lines.push(`${label} (${arr.length}):`);
        for (const f of arr) lines.push(`  - [${f.kind}] ${f.message}`);
    };
    push('Metadata', r.phase1.metadata);
    push('Links', r.phase1.links);
    push('Header/Footer', r.phase1.headerFooter);
    push('Watermarks', r.phase1.watermarks);
    push('Layout', r.phase1.layout);
    push('Integrity', r.phase1.integrity);
    push('Text quality', r.phase1.textQuality);
    push('Structural', r.phase3.structural);
    push('Interactive', r.phase3.interactive);
    push('Attachments', r.phase3.attachments);
    push('Table depth', r.phase3.tableDepthFindings);
    push('Images', r.phase4.images);
    push('Contrast', r.phase4.contrast);
    push('Chart regions', r.phase4.chartRegions);
    push('Visual regression', r.phase4.visualRegression.filter((f) => f.kind !== 'BASELINE_UPDATED' && f.kind !== 'MISSING_BASELINE'));
    push('Security', r.phase5.security);
    push('Barcodes', r.phase5.barcodes);
    push('Version diff', r.phase6.versionDiff);
    return lines;
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

/**
 * Coerce whatever the framework passes as a "data table" into an array of
 * row hashes ({ column: value }).
 *
 * Supports three shapes:
 *   1. DataTable instance with `.hashes()` — the current framework path.
 *   2. Raw string[][] with the header row first — legacy path some builds took.
 *   3. Array<Record<string,string>> — if the framework ever pre-hashes.
 */
/**
 * Parse the `helperSpec` string used by the zero-JSON PDF-vs-DB step:
 *   "ClassName.methodName"
 *   "ClassName.methodName@Section Name"
 * where the optional `@Section` suffix hints the target section on the PDF.
 */
function parseHelperSpec(spec: string): { helperModule: string; method: string; sectionHint?: string } {
    let s = spec.trim();
    let sectionHint: string | undefined;
    const atIdx = s.indexOf('@');
    if (atIdx >= 0) {
        sectionHint = s.slice(atIdx + 1).trim();
        s = s.slice(0, atIdx).trim();
    }
    const dotIdx = s.lastIndexOf('.');
    if (dotIdx < 0) {
        throw new Error(
            `Invalid helper spec "${spec}" — expected "ClassName.methodName" (optional "@Section Name" suffix).`,
        );
    }
    return {
        helperModule: s.slice(0, dotIdx).trim(),
        method: s.slice(dotIdx + 1).trim(),
        sectionHint,
    };
}

/**
 * Convert a params DataTable (2-column: name | value) into a plain params
 * object. Values are strings; consumers cast inside the helper method.
 */
function paramsFromTable(dt: unknown): Record<string, unknown> {
    const rows = tableRowsRaw(dt);
    const out: Record<string, unknown> = {};
    for (const row of rows) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const key = String(row[0]).trim();
        if (!key) continue;
        out[key] = String(row[1]);
    }
    return out;
}

/** Reader for two-column params tables — returns raw string[][], no header inference. */
function tableRowsRaw(dt: unknown): string[][] {
    if (!dt) return [];
    if (typeof (dt as { raw?: unknown }).raw === 'function') {
        const rows = (dt as { raw: () => string[][] }).raw();
        return Array.isArray(rows) ? rows : [];
    }
    if (typeof (dt as { rows?: unknown }).rows === 'function') {
        const rows = (dt as { rows: () => string[][] }).rows();
        return Array.isArray(rows) ? rows : [];
    }
    if (Array.isArray(dt) && dt.length > 0 && Array.isArray((dt as unknown[])[0])) {
        return dt as string[][];
    }
    return [];
}

function toHashRows(dt: unknown): Array<Record<string, string>> {
    if (!dt) return [];
    // Path 1: DataTable instance with hashes().
    if (typeof (dt as { hashes?: unknown }).hashes === 'function') {
        const rows = (dt as { hashes: () => Record<string, string>[] }).hashes();
        return Array.isArray(rows) ? rows : [];
    }
    // Path 2: raw string[][] — first row is headers.
    if (Array.isArray(dt) && dt.length > 0 && Array.isArray((dt as unknown[])[0])) {
        const grid = dt as string[][];
        const headers = grid[0].map((h) => String(h));
        return grid.slice(1).map((row) => {
            const h: Record<string, string> = {};
            headers.forEach((col, i) => (h[col] = String(row[i] ?? '')));
            return h;
        });
    }
    // Path 3: already hashed.
    if (Array.isArray(dt)) return dt as Array<Record<string, string>>;
    throw new Error(`unrecognised data-table shape: ${Object.prototype.toString.call(dt)}`);
}
