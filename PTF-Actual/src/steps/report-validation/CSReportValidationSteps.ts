// BDD step-defs for PDF report validation. Thin — every step delegates to
// `CSReportValidationService`. Spec, entity and ingested canonicals live on
// `CSBDDContext` under `reportvalidation.*` so later steps reuse them.
//
// A SOURCE is any label the spec's fieldMap uses — crystal, ssrs, legacy, vendorA — so the
// steps are not tied to a particular reporting engine. `database` folds onto `db`.
//
// Gherkin surface:
//
//   Given the report spec "<reportType>"
//   Given the report spec "<reportType>" for entity "<entity>"
//   Given the report entity "<entity>"
//   Given the report parameter "<name>" is "<value>"
//   Given the report section column "<COLUMN>"
//
//   When I acquire the <source> report for entity "<entity>" exporting as "<format>"
//   When I acquire the <source> report for entity "<entity>"
//   When I ingest the <source> report from "<path>"
//   When I ingest the <source> report from the latest download
//   When I ingest the database dataset
//
//   Then the <actual> report should match the <expected> report per the spec
//   Then the <source> report should match the database per the spec
//   Then the report should contain the required sections
//   Then the <source> report should contain the required sections
//   Then the <source> report should contain the required charts
//   Then the <source> report section "<id>" should resolve every printed column
//   Then the <source> report section "<id>" should report "<figure>" as "<value>"
//
// "Acquire" drives the registered `ReportAcquirer` (default: pick up the most recent file the
// framework downloaded — projects register their own via
// CSReportValidationService.registerAcquirer).

import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSBDDContext } from '../../bdd/CSBDDContext';
import { CSReporter } from '../../reporter/CSReporter';
import {
    CSReportValidationService,
    type IngestOptions,
    type SectionValidationResult,
} from '../../report-validation/CSReportValidationService';
import type { CanonicalReport, CanonicalValue, ReconciliationResult, ReportSource } from '../../report-validation/CSReportModel';
import { normalizeValue } from '../../report-validation/CSReportNormalizer';
import type { ReportSpec, ToleranceSpec } from '../../report-validation/CSReportSpec';
import { computeComparisonScope, type DiffReportInput } from '../../report-validation/CSReportDiffReporter';

const CTX_SPEC = 'reportvalidation.spec';
const CTX_ENTITY = 'reportvalidation.entity';
const CTX_PARAMS = 'reportvalidation.params';
const CTX_SECTION_COLUMN = 'reportvalidation.sectionColumn';
const CTX_SOURCES = 'reportvalidation.sources';
const CTX_DB = 'reportvalidation.source.db';

export class CSReportValidationSteps {
    private readonly ctx: CSBDDContext;
    private readonly service: CSReportValidationService;

    constructor() {
        this.ctx = CSBDDContext.getInstance();
        this.service = CSReportValidationService.getInstance();
    }

    // ------------------------------------------------------------------------
    // Spec + entity setup
    // ------------------------------------------------------------------------

    @CSBDDStepDef('the report spec {string}')
    async setActiveSpec(reportType: string): Promise<void> {
        const spec = await this.service.loadSpec(reportType);
        this.ctx.set(CTX_SPEC, spec);
        CSReporter.info(`Report spec loaded: ${spec.reportType} (${spec.project})`);
    }

    @CSBDDStepDef('the report spec {string} for entity {string}')
    async setActiveSpecAndEntity(reportType: string, entity: string): Promise<void> {
        await this.setActiveSpec(reportType);
        this.ctx.set(CTX_ENTITY, entity);
        CSReporter.info(`Report entity: ${entity}`);
    }

    @CSBDDStepDef('the report entity {string}')
    async setActiveEntity(entity: string): Promise<void> {
        this.ctx.set(CTX_ENTITY, entity);
        CSReporter.info(`Report entity: ${entity}`);
    }

    /**
     * Set one report parameter for the scenario. Accumulates — call once per parameter.
     *
     * The value reaches three places without further wiring: the registered `ReportAcquirer`
     * (`AcquireOptions.params`, for filling the SSRS parameter panel), DB binding (`@name`
     * tokens in a spec query, or a named entry in `database.procedure.params`), and
     * `CanonicalReport.params` so the diff report records what the run was pinned to.
     *
     * Pinning the as-of date here is what stops both sides drifting to different snapshots —
     * an unpinned as-of date turns every legitimate row into a false difference.
     */
    @CSBDDStepDef('the report parameter {string} is {string}')
    async setReportParameter(name: string, value: string): Promise<void> {
        const params = { ...(this.ctx.get<Record<string, string | number>>(CTX_PARAMS) ?? {}) };
        params[name] = value;
        this.ctx.set(CTX_PARAMS, params);
        CSReporter.info(`Report parameter: ${name}=${value}`);
    }

    /**
     * Name the column that carries each row's section id, for flat sources (DB result sets,
     * CSV, Excel). Without it every flat row lands in the spec's FIRST required section,
     * which on a multi-section spec leaves the remaining sections empty on that side — a
     * coverage gap that reads as an extraction failure.
     *
     * Not needed for a stored procedure that declares `database.procedure.resultSets`; that
     * path tags its own sections from the result-set order.
     */
    @CSBDDStepDef('the report section column {string}')
    async setSectionColumn(columnName: string): Promise<void> {
        this.ctx.set(CTX_SECTION_COLUMN, columnName);
        CSReporter.info(`Report section column: ${columnName}`);
    }

    // ------------------------------------------------------------------------
    // Acquisition (drives the registered acquirer)
    // ------------------------------------------------------------------------

    @CSBDDStepDef('I acquire the {word} report for entity {string} exporting as {string}')
    async acquireWithFormat(sourceWord: string, entity: string, requestedFormat: string): Promise<void> {
        const source = parseSource(sourceWord);
        const spec = requireSpec(this.ctx);
        this.ctx.set(CTX_ENTITY, entity);
        const effectiveFormat = this.service.resolveExportFormat(spec, requestedFormat);
        if (spec.pdfOnly && requestedFormat.toLowerCase() !== 'pdf') {
            CSReporter.warn(
                `Spec "${spec.reportType}" is PDF-only — ignoring requested "${requestedFormat}" and using PDF.`,
            );
        }
        const filePath = await this.service.acquireReportFile(source, spec, {
            entity,
            requestedFormat: effectiveFormat,
            params: this.ctx.get<Record<string, string | number>>(CTX_PARAMS) ?? {},
        });
        await this.ingest(filePath, spec, source, entity);
        CSReporter.pass(`Acquired ${source} report for ${entity} as ${effectiveFormat}: ${filePath}`);
    }

    @CSBDDStepDef('I acquire the {word} report for entity {string}')
    async acquireDefault(sourceWord: string, entity: string): Promise<void> {
        const source = parseSource(sourceWord);
        const spec = requireSpec(this.ctx);
        this.ctx.set(CTX_ENTITY, entity);
        const filePath = await this.service.acquireReportFile(source, spec, {
            entity,
            requestedFormat: this.service.resolveExportFormat(spec),
            params: this.ctx.get<Record<string, string | number>>(CTX_PARAMS) ?? {},
        });
        await this.ingest(filePath, spec, source, entity);
        CSReporter.pass(`Acquired ${source} report for ${entity}: ${filePath}`);
    }

    // ------------------------------------------------------------------------
    // Explicit file ingestion (bypasses the acquirer)
    // ------------------------------------------------------------------------

    @CSBDDStepDef('I ingest the {word} report from {string}')
    async ingestFromPath(sourceWord: string, filePath: string): Promise<void> {
        const source = parseSource(sourceWord);
        const spec = requireSpec(this.ctx);
        const entity = requireEntity(this.ctx);
        await this.ingest(filePath, spec, source, entity);
        CSReporter.pass(`${source} report ingested from ${filePath}`);
    }

    @CSBDDStepDef('I ingest the {word} report from the latest download')
    async ingestFromLatestDownload(sourceWord: string): Promise<void> {
        const source = parseSource(sourceWord);
        const spec = requireSpec(this.ctx);
        const entity = requireEntity(this.ctx);
        const filePath = await this.service.acquireReportFile(source, spec, {
            entity,
            requestedFormat: this.service.resolveExportFormat(spec),
            params: this.ctx.get<Record<string, string | number>>(CTX_PARAMS) ?? {},
        });
        await this.ingest(filePath, spec, source, entity);
        CSReporter.pass(`${source} report ingested from latest download: ${filePath}`);
    }

    @CSBDDStepDef('I ingest the database dataset')
    async ingestDb(): Promise<void> {
        const spec = requireSpec(this.ctx);
        const entity = requireEntity(this.ctx);
        const params = (this.ctx.get<Record<string, string | number>>(CTX_PARAMS)) ?? {};
        const sectionColumn = this.ctx.get<string>(CTX_SECTION_COLUMN);
        const canonical = await this.service.ingestFromDatabase(spec, { entity, params, sectionColumn });
        this.ctx.set(CTX_DB, canonical);
        rememberSource(this.ctx, 'db');
        this.emitCanonicalDump(canonical);
        CSReporter.pass(`Database dataset ingested: ${canonical.records.length} record(s), ${canonical.sections.length} section(s)`);
    }

    // ------------------------------------------------------------------------
    // Comparisons
    // ------------------------------------------------------------------------

    /**
     * Compare any two ingested sources. `expected` is the reference side, so a row it has and
     * `actual` lacks reads as MISSING.
     */
    @CSBDDStepDef('the {word} report should match the {word} report per the spec')
    async reportMatchesReport(actualWord: string, expectedWord: string): Promise<void> {
        const spec = requireSpec(this.ctx);
        const actual = parseSource(actualWord);
        const expected = parseSource(expectedWord);
        const a = requireCanonical(this.ctx, ctxKeyForSource(expected), expectedWord);
        const b = requireCanonical(this.ctx, ctxKeyForSource(actual), actualWord);
        const result = this.service.reconcile(a, b, spec);
        this.writeAndReportReconciliation(result, `${actual} vs ${expected}`, spec, a, b);
    }

    @CSBDDStepDef('the {word} report should match the database per the spec')
    async reportMatchesDb(actualWord: string): Promise<void> {
        await this.reportMatchesReport(actualWord, 'db');
    }

    @CSBDDStepDef('the report should contain the required sections')
    async requiredSectionsPresent(): Promise<void> {
        const spec = requireSpec(this.ctx);
        const target = pickFirstIngested(this.ctx);
        const result = this.service.validateSections(target, spec);
        this.reportSectionValidation(result, target.source);
    }

    @CSBDDStepDef('the {word} report should contain the required sections')
    async requiredSectionsPresentForSource(sourceWord: string): Promise<void> {
        const spec = requireSpec(this.ctx);
        const source = parseSource(sourceWord);
        const key = ctxKeyForSource(source);
        const target = requireCanonical(this.ctx, key, sourceWord);
        const result = this.service.validateSections(target, spec);
        this.reportSectionValidation(result, source);
    }

    /**
     * Assert a figure from a section's summary block. Those sit outside every column band, so
     * the row comparison cannot reach them — undeclared, they go unchecked.
     *
     * Write the expected value as printed; both sides are normalised before comparing.
     */
    @CSBDDStepDef('the {word} report section {string} should report {string} as {string}')
    async summaryFigureShouldBe(
        sourceWord: string,
        sectionId: string,
        figureId: string,
        expected: string,
    ): Promise<void> {
        const spec = requireSpec(this.ctx);
        const source = parseSource(sourceWord);
        const canonical = requireCanonical(this.ctx, ctxKeyForSource(source), sourceWord);
        const section = canonical.sections.find((s) => s.id === sectionId);
        if (!section) {
            throw new Error(
                `CSReportValidationSteps: section "${sectionId}" was not found on the ${source} report — ` +
                `found: [${canonical.sections.map((s) => s.id).join(', ')}]`,
            );
        }
        const actual = section.summary?.[figureId];
        if (!actual) {
            throw new Error(
                `CSReportValidationSteps: figure "${figureId}" was not extracted from section "${sectionId}" ` +
                `on ${source} — declare it under requiredSections["${sectionId}"].summaryFields with the ` +
                `label as printed; a label clipped at the page edge is matched on its tail automatically`,
            );
        }
        const want = normalizeValue(expected, { dateFormats: spec.dateFormats });
        const tolerance = spec.tolerances[figureId];
        if (!valuesAgree(actual, want, tolerance)) {
            throw new Error(
                `Report figure mismatch on ${source} — section "${sectionId}", figure "${figureId}": ` +
                `expected ${JSON.stringify(want.kind === 'null' ? expected : String(want.value))} ` +
                `but read ${JSON.stringify(actual.kind === 'null' ? '' : String(actual.value))} ` +
                `(printed as ${JSON.stringify(actual.raw)})`,
            );
        }
        // Both sides of the comparison are logged, not just the verdict: a reader auditing a
        // green run needs to see what was expected and what the report actually printed.
        CSReporter.pass(
            `${sectionId}.${figureId} on ${source} — expected ${JSON.stringify(expected)}, ` +
            `read ${JSON.stringify(actual.raw)} (normalised ` +
            `${JSON.stringify(actual.kind === 'null' ? '' : String(actual.value))}` +
            `${tolerance ? ', tolerance applied' : ''}) — PASS`,
        );
    }

    /**
     * Assert every column the section prints resolved to a field. An unresolved column is
     * dropped in silence, and if it is a key column the section goes with it.
     */
    @CSBDDStepDef('the {word} report section {string} should resolve every printed column')
    async sectionColumnsShouldResolve(sourceWord: string, sectionId: string): Promise<void> {
        const source = parseSource(sourceWord);
        const canonical = requireCanonical(this.ctx, ctxKeyForSource(source), sourceWord);
        const section = canonical.sections.find((s) => s.id === sectionId);
        if (!section) {
            throw new Error(
                `CSReportValidationSteps: section "${sectionId}" was not found on the ${source} report — ` +
                `found: [${canonical.sections.map((s) => s.id).join(', ')}]`,
            );
        }
        const printed = section.detectedColumns ?? [];
        const unresolved = printed.filter((c) => c.header && !c.mapsTo).map((c) => c.header);
        if (unresolved.length > 0) {
            throw new Error(
                `Section "${sectionId}" on ${source} printed ${unresolved.length} column(s) that resolved to no ` +
                `field: ${JSON.stringify(unresolved)} — add them to spec.fieldMap, or correct the names already there`,
            );
        }
        const resolved = printed.filter((c) => c.mapsTo);
        for (const column of resolved) {
            CSReporter.info(`${sectionId} column "${column.header}" → field "${column.mapsTo}"`);
        }
        CSReporter.pass(`${sectionId} on ${source}: all ${resolved.length} printed column(s) resolved — PASS`);
    }

    /** Assert the charts a section declares. A chart title is ordinary text, so presence is a text check. */
    @CSBDDStepDef('the {word} report should contain the required charts')
    async requiredChartsPresent(sourceWord: string): Promise<void> {
        const spec = requireSpec(this.ctx);
        const source = parseSource(sourceWord);
        const canonical = requireCanonical(this.ctx, ctxKeyForSource(source), sourceWord);
        const result = this.service.validateSections(canonical, spec);
        const declared = spec.requiredSections.flatMap((s) => s.requiredCharts ?? []);
        if (declared.length === 0) {
            throw new Error(
                'CSReportValidationSteps: no charts are declared — add requiredCharts to a section in the spec, ' +
                'otherwise this step asserts nothing',
            );
        }
        if (result.missingCharts.length > 0) {
            for (const missing of result.missingCharts) CSReporter.fail(`Missing chart: ${missing}`);
            throw new Error(
                `Required charts missing on ${source}: [${result.missingCharts.join(', ')}]`,
            );
        }
        for (const chart of declared) CSReporter.info(`Chart declared "${chart}" → found on ${source}`);
        CSReporter.pass(`All ${declared.length} required chart(s) present on ${source} — PASS`);
    }

    // ------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------

    private async ingest(
        filePath: string,
        spec: ReportSpec,
        source: ReportSource,
        entity: string,
    ): Promise<void> {
        const params = (this.ctx.get<Record<string, string | number>>(CTX_PARAMS)) ?? {};
        const sectionColumn = this.ctx.get<string>(CTX_SECTION_COLUMN);
        const opts: IngestOptions = { entity, params, sectionColumn };
        const canonical = await this.service.ingestFile(filePath, spec, source, opts);
        this.ctx.set(ctxKeyForSource(source), canonical);
        rememberSource(this.ctx, source);
        CSReporter.info(
            `Ingested ${source} report from ${filePath}: ` +
            `${canonical.records.length} record(s), ${canonical.sections.length} section(s)`,
        );
        this.emitCanonicalDump(canonical);
    }

    /**
     * Write the extracted rows to disk beside the diff report. Auxiliary evidence — a dump
     * failure is logged and swallowed so it can never mask the reconciliation result.
     */
    private emitCanonicalDump(canonical: CanonicalReport): void {
        try {
            const written = this.service.dumpCanonical(canonical);
            for (const w of written) {
                CSReporter.info(`Canonical ${canonical.source} dump (${w.format}): ${w.filePath} (${w.byteCount} bytes)`);
            }
        } catch (err) {
            CSReporter.warn(`Canonical dump failed for ${canonical.source} (continuing): ${(err as Error).message}`);
        }
    }

    private writeAndReportReconciliation(
        result: ReconciliationResult,
        label: string,
        spec: ReportSpec,
        a: CanonicalReport,
        b: CanonicalReport,
    ): void {
        // Emit the HTML diff BEFORE the pass/fail decision — even a passing run leaves the
        // artefact behind for humans to inspect (within-tolerance findings, notes, etc.).
        this.emitDiffReport({ spec, label, a, b, reconciliation: result });
        this.reportReconciliation(result, label, spec, a, b);
    }

    /**
     * Describe the comparison's SCOPE — rows matched on the business key and the number of
     * value comparisons that ran. Without it the log line is a wall of zeros, and a genuine
     * clean run reads exactly like a run that extracted nothing and compared nothing.
     */
    /**
     * One line of positive evidence for the console: how many rows paired up, in which
     * sections, and how many values that actually put under comparison.
     *
     * Shares `computeComparisonScope` with the HTML diff report on purpose — two
     * implementations of "what did we compare" is two chances to disagree with the
     * reconciler, and this number is the one thing standing between a clean run and a
     * vacuous one that looks identical.
     */
    private describeScope(spec: ReportSpec, a?: CanonicalReport, b?: CanonicalReport): string {
        if (!a || !b) return '';
        const scope = computeComparisonScope(spec, a, b);
        const perSection = scope.sections
            .filter((sec) => sec.matched > 0)
            .map((sec) => `${sec.title} ${sec.matched}\u00d7${sec.fields.length}`)
            .join(', ');
        return `${scope.comparisons} value comparison(s) over ${scope.matched} matched row(s) ` +
            `(${scope.rowsA} in A, ${scope.rowsB} in B)` + (perSection ? ` — ${perSection}` : '');
    }

    private reportReconciliation(
        result: ReconciliationResult,
        label: string,
        spec?: ReportSpec,
        a?: CanonicalReport,
        b?: CanonicalReport,
    ): void {
        const c = result.counts;
        const scope = spec ? this.describeScope(spec, a, b) : '';
        const breakdown =
            `mismatch=${c.dataMismatch}, missing=${c.missing}, extra=${c.extra}, ` +
            `formatOnly=${c.formatOnly}, withinTolerance=${c.withinTolerance}, ` +
            `known=${c.knownDifference}, restructure=${c.sectionRestructure}, ` +
            `checksumDrift=${c.checksumDrift}, footingMismatch=${c.footingMismatch}, ` +
            `coverageGap=${c.coverageGap}`;
        const line = scope
            ? `${label}: ${scope} — ${c.total} difference(s) [${breakdown}]`
            : `${label}: ${c.total} difference(s) [${breakdown}]`;

        // The ledger is the audit trail behind the verdict — say how much of it there is and
        // where to read it, so a pass can be checked rather than taken on trust.
        const ledger = result.ledger;
        if (ledger) {
            const failing = ledger.rows.filter((r) => r.status === 'FAIL').length;
            const cells = ledger.rows.reduce((n, r) => n + r.cells.length, 0);
            CSReporter.info(
                `Comparison ledger (${ledger.aSource} vs ${ledger.bSource}): ${ledger.rows.length} row(s), ` +
                `${cells} field comparison(s), ${ledger.rows.length - failing} passing / ${failing} failing` +
                (ledger.omittedRows > 0 ? ` — ${ledger.omittedRows} row(s) beyond the ${ledger.rowCap}-row cap not listed` : '') +
                ' — full row-by-row detail in the diff report',
            );
        }

        if (result.passed) {
            CSReporter.pass(`${line} — passed`);
            return;
        }
        for (const f of result.findings.slice(0, 20)) {
            CSReporter.warn(`  [${f.classification}] section=${f.section} key=${JSON.stringify(f.key)} field=${f.field ?? '-'} reason=${f.reason ?? ''}`);
        }
        throw new Error(`Report reconciliation failed (${label}) — ${line}`);
    }

    private emitDiffReport(input: DiffReportInput): void {
        try {
            const out = this.service.writeDiffReport(input);
            CSReporter.info(`Report validation diff written: ${out.filePath} (${out.byteCount} bytes)`);
        } catch (err) {
            // The diff report is auxiliary evidence — its failure must never mask the underlying
            // reconciliation pass/fail. Log and continue.
            const msg = err instanceof Error ? err.message : String(err);
            CSReporter.warn(`Failed to write report validation diff: ${msg}`);
        }
    }

    private reportSectionValidation(result: SectionValidationResult, source: string): void {
        if (result.passed) {
            CSReporter.pass(`Required sections present on ${source}: [${result.presentSections.join(', ')}]`);
            return;
        }
        if (result.missingSections.length > 0) {
            CSReporter.fail(`Missing required sections on ${source}: [${result.missingSections.join(', ')}]`);
        }
        for (const issue of result.orderIssues) CSReporter.fail(issue);
        throw new Error(
            `Section validation failed on ${source} — missing=[${result.missingSections.join(', ')}], ` +
            `orderIssues=${result.orderIssues.length}`,
        );
    }
}

// ---------------------------------------------------------------------------
// Helpers — module-local; no side effects on load.
// ---------------------------------------------------------------------------

/** Where a source's ingested canonical is stashed. One slot per label, created on demand. */
function ctxKeyForSource(source: ReportSource): string {
    return `reportvalidation.source.${source}`;
}

/**
 * A source is whatever the spec's `fieldMap` calls it — `crystal`, `ssrs`, `legacy`, `vendorA`.
 * Only `database` is folded onto `db`, so both spellings reach the DB steps.
 */
function parseSource(word: string): ReportSource {
    const norm = word.toLowerCase().trim();
    if (norm.length === 0) {
        throw new Error('CSReportValidationSteps: report source is empty — name the source the spec uses, e.g. "legacy"');
    }
    return norm === 'database' ? 'db' : norm;
}

/** Labels ingested so far, in order, so a step can fall back to "whatever was loaded". */
function ingestedSources(ctx: CSBDDContext): string[] {
    return ctx.get<string[]>(CTX_SOURCES) ?? [];
}

function rememberSource(ctx: CSBDDContext, source: ReportSource): void {
    const seen = ingestedSources(ctx);
    if (!seen.includes(source)) ctx.set(CTX_SOURCES, [...seen, source]);
}

function requireSpec(ctx: CSBDDContext): ReportSpec {
    const spec = ctx.get<ReportSpec>(CTX_SPEC);
    if (!spec) throw new Error('CSReportValidationSteps: no active report spec — call `Given the report spec "…"` first');
    return spec;
}

function requireEntity(ctx: CSBDDContext): string {
    const entity = ctx.get<string>(CTX_ENTITY);
    if (!entity) throw new Error('CSReportValidationSteps: no active entity — pass it via `Given the report spec "…" for entity "…"` or `Given the report entity "…"`');
    return entity;
}

function requireCanonical(ctx: CSBDDContext, key: string, label: string): CanonicalReport {
    const val = ctx.get<CanonicalReport>(key);
    if (!val) throw new Error(`CSReportValidationSteps: no ${label} canonical report ingested yet — run an ingestion step first`);
    return val;
}

/** Normalised comparison of an extracted figure against an expected one, honouring the field's tolerance. */
function valuesAgree(actual: CanonicalValue, expected: CanonicalValue, tolerance?: ToleranceSpec): boolean {
    if (actual.kind === 'null' || expected.kind === 'null') return actual.kind === expected.kind;
    if (actual.kind === 'number' && expected.kind === 'number') {
        const epsilon = tolerance && tolerance.type === 'number' ? tolerance.epsilon ?? 0 : 0;
        return Math.abs(actual.value - expected.value) <= epsilon;
    }
    return String(actual.value).trim().toLowerCase() === String(expected.value).trim().toLowerCase();
}

/** Fallback for "the report should contain the required sections" — SSRS first, then Crystal, then DB. */
function pickFirstIngested(ctx: CSBDDContext): CanonicalReport {
    for (const source of ingestedSources(ctx)) {
        const val = ctx.get<CanonicalReport>(ctxKeyForSource(source));
        if (val) return val;
    }
    throw new Error('CSReportValidationSteps: no canonical report ingested yet — run an ingestion step before section validation');
}
