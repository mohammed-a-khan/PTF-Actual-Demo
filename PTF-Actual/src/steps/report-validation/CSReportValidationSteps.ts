// src/steps/reports/CSReportValidationSteps.ts
//
// BDD step-defs for report validation. Thin — every step delegates to
// `CSReportValidationService`. Canonicals + spec + entity are stashed on
// `CSBDDContext` under the `reportvalidation.*` namespace so later steps in
// the same scenario can pick them up without re-doing acquisition or ingestion.
//
// Gherkin surface:
//
//   Given the report spec "example-report"
//   Given the report spec "example-report" for entity "ENTITY-1"
//   Given the report entity "ENTITY-1"
//   Given the report parameter "asOfDate" is "2026-08-18"
//   Given the report section column "SECTION_NAME"
//
//   When I acquire the SSRS report for entity "ENTITY-1" exporting as "Excel"
//   When I acquire the Crystal report for entity "ENTITY-1"
//   When I ingest the SSRS report from "path/to/file.xlsx"
//   When I ingest the Crystal report from "path/to/file.pdf"
//   When I ingest the SSRS report from the latest download
//   When I ingest the Crystal report from the latest download
//   When I ingest the database dataset
//
//   Then the SSRS report should match the Crystal report per the spec
//   Then the SSRS report should match the database per the spec
//   Then the Crystal report should match the database per the spec
//   Then the report should contain the required sections
//   Then the {source} report should contain the required sections
//
// The "acquire" step drives the framework-registered `ReportAcquirer`
// (default: LatestDownloadAcquirer, which just grabs the most recent file
// dropped in the framework downloads folder — projects register their own
// SSRS-UI-driving acquirer via CSReportValidationService.registerAcquirer).

import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSBDDContext } from '../../bdd/CSBDDContext';
import { CSReporter } from '../../reporter/CSReporter';
import {
    CSReportValidationService,
    type IngestOptions,
    type SectionValidationResult,
} from '../../report-validation/CSReportValidationService';
import type { CanonicalReport, ReconciliationResult, ReportSource } from '../../report-validation/CSReportModel';
import type { ReportSpec } from '../../report-validation/CSReportSpec';
import { computeComparisonScope, type DiffReportInput } from '../../report-validation/CSReportDiffReporter';

const CTX_SPEC = 'reportvalidation.spec';
const CTX_ENTITY = 'reportvalidation.entity';
const CTX_PARAMS = 'reportvalidation.params';
const CTX_SECTION_COLUMN = 'reportvalidation.sectionColumn';
const CTX_SSRS = 'reportvalidation.ssrs';
const CTX_CRYSTAL = 'reportvalidation.crystal';
const CTX_DB = 'reportvalidation.db';

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
    }

    @CSBDDStepDef('I ingest the database dataset')
    async ingestDb(): Promise<void> {
        const spec = requireSpec(this.ctx);
        const entity = requireEntity(this.ctx);
        const params = (this.ctx.get<Record<string, string | number>>(CTX_PARAMS)) ?? {};
        const sectionColumn = this.ctx.get<string>(CTX_SECTION_COLUMN);
        const canonical = await this.service.ingestFromDatabase(spec, { entity, params, sectionColumn });
        this.ctx.set(CTX_DB, canonical);
        CSReporter.info(`Ingested DB dataset: ${canonical.records.length} record(s), ${canonical.sections.length} section(s)`);
        this.emitCanonicalDump(canonical);
    }

    // ------------------------------------------------------------------------
    // Comparisons
    // ------------------------------------------------------------------------

    @CSBDDStepDef('the SSRS report should match the Crystal report per the spec')
    async ssrsMatchesCrystal(): Promise<void> {
        const spec = requireSpec(this.ctx);
        const a = requireCanonical(this.ctx, CTX_CRYSTAL, 'Crystal');
        const b = requireCanonical(this.ctx, CTX_SSRS, 'SSRS');
        const result = this.service.reconcile(a, b, spec);
        this.writeAndReportReconciliation(result, 'SSRS vs Crystal', spec, a, b);
    }

    @CSBDDStepDef('the SSRS report should match the database per the spec')
    async ssrsMatchesDb(): Promise<void> {
        const spec = requireSpec(this.ctx);
        const a = requireCanonical(this.ctx, CTX_DB, 'DB');
        const b = requireCanonical(this.ctx, CTX_SSRS, 'SSRS');
        const result = this.service.reconcile(a, b, spec);
        this.writeAndReportReconciliation(result, 'SSRS vs DB', spec, a, b);
    }

    @CSBDDStepDef('the Crystal report should match the database per the spec')
    async crystalMatchesDb(): Promise<void> {
        const spec = requireSpec(this.ctx);
        const a = requireCanonical(this.ctx, CTX_DB, 'DB');
        const b = requireCanonical(this.ctx, CTX_CRYSTAL, 'Crystal');
        const result = this.service.reconcile(a, b, spec);
        this.writeAndReportReconciliation(result, 'Crystal vs DB', spec, a, b);
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

function ctxKeyForSource(source: ReportSource): string {
    switch (source) {
        case 'crystal': return CTX_CRYSTAL;
        case 'ssrs': return CTX_SSRS;
        case 'db': return CTX_DB;
    }
}

function parseSource(word: string): ReportSource {
    const norm = word.toLowerCase().trim();
    if (norm === 'crystal') return 'crystal';
    if (norm === 'ssrs') return 'ssrs';
    if (norm === 'db' || norm === 'database') return 'db';
    throw new Error(`CSReportValidationSteps: unknown report source "${word}" — expected one of crystal|ssrs|db`);
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

/** Fallback for "the report should contain the required sections" — SSRS first, then Crystal, then DB. */
function pickFirstIngested(ctx: CSBDDContext): CanonicalReport {
    const candidates: Array<[string, string]> = [
        [CTX_SSRS, 'SSRS'],
        [CTX_CRYSTAL, 'Crystal'],
        [CTX_DB, 'DB'],
    ];
    for (const [key] of candidates) {
        const val = ctx.get<CanonicalReport>(key);
        if (val) return val;
    }
    throw new Error('CSReportValidationSteps: no canonical report ingested yet — run an ingestion step before section validation');
}
