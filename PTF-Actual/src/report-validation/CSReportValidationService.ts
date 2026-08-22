/**
 * CS Report Validation — Layer 4: Orchestrator service.
 *
 * The single entry point wiring the pipeline together:
 *
 *     spec loader → acquirer → format-aware ingestion → section mapper
 *                                                    → reconciler
 *                                                    → section validator
 *
 * Every earlier layer stays pure and standalone (Layer 1 does PDF text, Layer 2
 * does layout, Layer 3 does canonicalisation, the reconciler does compare).
 * The service is what BDD steps talk to — steps stay one-liners; the service
 * owns wiring, format routing, DB dialect selection, and the "pdfOnly overrides
 * requested format" rule from the spec.
 *
 * DEPENDENCY INJECTION
 * --------------------
 * Every collaborator is behind an interface with a sensible default that pulls
 * from framework singletons (`CSDataProvider`, `CSTestResultsManager`,
 * `CSConfigurationManager`, `CSDatabaseManager`). Tests inject fakes.
 *
 * ACQUISITION
 * -----------
 * The framework does NOT know how to drive project-specific SSRS/Crystal UIs.
 * Projects register a `ReportAcquirer` (or use the default `LatestDownloadAcquirer`
 * that just picks up whatever the last project step downloaded). Steps that
 * "generate" a report either (a) accept an explicit file path or
 * (b) call the registered acquirer.
 *
 * DB PARAM BINDING
 * ----------------
 * Named tokens (`@entity` on SQL Server, `:entity` on Oracle) are substituted
 * in-SQL against the caller-supplied `params` map, escaping single quotes on
 * strings and inlining numeric literals verbatim. This is safe for test-driven
 * entity ids and typed report parameters; a future phase can switch to native
 * prepared-statement binds if the framework exposes them uniformly across
 * dialects.
 *
 * @module report-validation/CSReportValidationService
 */

import * as fs from 'fs';
import * as path from 'path';

import type {
    CanonicalReport,
    ReconciliationResult,
    ReportFormat,
    ReportSource,
} from './CSReportModel';
import type { ReportSpec, SpecDatabaseQuery, SpecProcedure } from './CSReportSpec';
import { CSReportSpecLoader } from './CSReportSpec';
import { CSReportReconciler } from './CSReportReconciler';
import { CSReportSectionMapper, type DataRow } from './CSReportSectionMapper';
import { extractPagesFromPdf } from './CSReportPdfExtractor';
import { analyzeReport } from './CSReportPdfLayoutAnalyzer';
import {
    CSReportDiffReporter,
    type DiffReportInput,
    type DiffReportWriteResult,
} from './CSReportDiffReporter';
import {
    CSReportCanonicalDumper,
    canonicalDumpEnabled,
    type CanonicalDumpOptions,
    type CanonicalDumpWriteResult,
} from './CSReportCanonicalDumper';
import { CSCanonicalCache } from './CSCanonicalCache';
import type { OcrAdapter } from './CSReportOcrAdapter';
import {
    CSReportSectionValidator,
    type SectionValidationResult,
} from './CSReportSectionValidator';

export type { SectionValidationResult };

/** Which DB dialect a connection alias resolves to. */
export type DbDialect = 'sqlserver' | 'oracle';

/** Options for a single ingestion (file or DB). */
export interface IngestOptions {
    /** Business entity id the report was run for. Passed through to `CanonicalReport.entity`. */
    entity: string;
    /** Report parameters (as-of date, currency, etc.). Available for DB param binding and stored on `CanonicalReport.params`. */
    params?: Record<string, string | number>;
    /** Section-carrying column for flat sources (DB/CSV/Excel). See `CSReportSectionMapper.MapperOptions.sectionColumn`. */
    sectionColumn?: string;
    /** Excel sheet name (defaults to the first sheet). Ignored for non-Excel sources. */
    sheet?: string;
    /**
     * Explicit format override. When omitted, format is inferred from the file extension
     * (`.pdf` → pdf, `.xlsx`/`.xls` → excel, `.csv` → csv). Ignored for DB ingestion.
     */
    format?: ReportFormat;
}

/** Options for an acquisition (project driving SSRS/Crystal UI to produce a file). */
export interface AcquireOptions {
    entity: string;
    /** Requested export format from the BDD step (`"Excel"`, `"PDF"`, ...). Case-insensitive. Ignored when `spec.pdfOnly` is true. */
    requestedFormat?: string;
    /** Free-form parameters the acquirer may need (report-specific report-parameters). */
    params?: Record<string, string | number>;
}

/**
 * Contract for driving a report system's UI to produce a downloaded file. Projects register
 * a concrete implementation on the service; the default just captures the last file the
 * framework's browser session downloaded (`CSTestResultsManager.getLatestDownloadedFile()`).
 */
export interface ReportAcquirer {
    /** Returns the absolute path to the acquired file. Must throw with a clear message when acquisition fails. */
    acquire(spec: ReportSpec, opts: AcquireOptions): Promise<string>;
}

/** Callable that resolves a connection alias → dialect string. Injectable for tests. */
export type DialectResolver = (connectionAlias: string) => DbDialect;

/** Callable that runs a SQL string against a named connection and returns row objects. Injectable for tests. */
export type QueryRunner = (connectionAlias: string, sql: string) => Promise<DataRow[]>;

/**
 * Callable that executes a stored procedure against a named connection with POSITIONALLY
 * bound parameters, and returns EVERY result set it produced, in order. A single-result-set
 * procedure returns a one-element array. Injectable for tests.
 */
export type ProcedureRunner = (
    connectionAlias: string,
    procedureName: string,
    params: Array<string | number>,
) => Promise<DataRow[][]>;

/**
 * Compile-time hook for wiring pdfjs / layout analyzer. Kept generic (accepts any pages array
 * and returns any analyzed shape) so test injection doesn't need to model the full types.
 *
 * The optional `opts` bag threads through spec-driven behaviour: `ocrFallback` from the spec
 * plus the registered OCR adapter (see `CSReportValidationService.registerOcrAdapter`).
 */
export interface PdfPipelineOptions {
    /** When true AND `ocrAdapter` is provided, image-only pages are OCR'd. */
    enableOcrFallback?: boolean;
    /** OCR engine adapter registered on the service. */
    ocrAdapter?: OcrAdapter;
}

/**
 * Options handed to the layout analyzer. `sectionHeaderRegexes` is derived from the spec's
 * `requiredSections[].matchers` — without it the analyzer falls back to font-size voting,
 * which misses section titles rendered at body-text size (SSRS does exactly that).
 */
export interface PdfAnalyzeOptions {
    sectionHeaderRegexes?: RegExp[];
}

export interface PdfPipeline {
    extractPages(filePath: string, opts?: PdfPipelineOptions): Promise<unknown[]>;
    analyze(pages: unknown[], opts?: PdfAnalyzeOptions): unknown;
}

export interface FileLoader {
    loadExcel(filePath: string, sheet?: string): Promise<DataRow[]>;
    loadCsv(filePath: string): Promise<DataRow[]>;
}

export interface ServiceOptions {
    /** Directory that holds `*.json` report specs. Default `config/report-specs`. Not used if a `loader` is supplied. */
    specsDir?: string;
    /** Pre-built spec loader. Convenient for injecting in-memory specs in tests. */
    loader?: CSReportSpecLoader;
    /** Default acquirer used when no per-source acquirer is registered. Defaults to `LatestDownloadAcquirer`. */
    defaultAcquirer?: ReportAcquirer;
    /** Alias → dialect resolver. Defaults to reading `CSConfigurationManager` `DB_<alias>_TYPE` config key; falls back to `sqlserver`. */
    dialectResolver?: DialectResolver;
    /** SQL runner. Defaults to using `CSDatabaseManager` + `CSDatabase.execute`. */
    queryRunner?: QueryRunner;
    /** Stored-procedure runner. Defaults to using `CSDatabaseManager` + `CSDatabase.executeStoredProcedure`. */
    procedureRunner?: ProcedureRunner;
    /** PDF pipeline. Defaults to the framework's `extractPagesFromPdf` + `analyzeReport`. */
    pdfPipeline?: PdfPipeline;
    /** Flat-file loaders. Defaults to `CSDataProvider.loadData`. */
    fileLoader?: FileLoader;
    /** Canonical cache — hits skip the extract-analyze-map pipeline. Pass `null` to disable caching entirely. Defaults to a fresh `CSCanonicalCache`. */
    canonicalCache?: CSCanonicalCache | null;
    /** OCR adapter for image-only PDF pages. Required whenever a spec sets `ocrFallback: true`. */
    ocrAdapter?: OcrAdapter;
}

// ---------------------------------------------------------------------------
// Default acquirer: pick up the last file dropped in the downloads folder.
// ---------------------------------------------------------------------------

class LatestDownloadAcquirer implements ReportAcquirer {
    async acquire(spec: ReportSpec, _opts: AcquireOptions): Promise<string> {
        const { CSTestResultsManager } = require('../reporter/CSTestResultsManager');
        const latest = CSTestResultsManager.getInstance().getLatestDownloadedFile();
        if (!latest) {
            throw new Error(
                `ReportAcquirer(LatestDownload): no downloaded file recorded yet — ` +
                `wire the project's own UI step to download the ${spec.reportType} report first, ` +
                `or register a custom acquirer via CSReportValidationService.registerAcquirer().`,
            );
        }
        if (!fs.existsSync(latest.filePath)) {
            throw new Error(`ReportAcquirer(LatestDownload): recorded file no longer exists: ${latest.filePath}`);
        }
        return latest.filePath;
    }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CSReportValidationService {
    private static instance: CSReportValidationService | null = null;

    /** Framework-wide singleton. BDD steps use this — tests should construct a fresh instance instead. */
    static getInstance(): CSReportValidationService {
        if (!CSReportValidationService.instance) {
            CSReportValidationService.instance = new CSReportValidationService();
        }
        return CSReportValidationService.instance;
    }

    /** Reset the singleton — for test isolation. Not part of the shipping API. */
    static resetInstanceForTests(): void {
        CSReportValidationService.instance = null;
    }

    private readonly loader: CSReportSpecLoader;
    private readonly defaultAcquirer: ReportAcquirer;
    private readonly perSourceAcquirers = new Map<ReportSource, ReportAcquirer>();
    private readonly dialectResolver: DialectResolver;
    private readonly queryRunner: QueryRunner;
    private readonly procedureRunner: ProcedureRunner;
    private readonly pdfPipeline: PdfPipeline;
    private readonly fileLoader: FileLoader;
    private readonly canonicalCache: CSCanonicalCache | null;
    private ocrAdapter?: OcrAdapter;
    private loaderInitialized = false;

    constructor(opts: ServiceOptions = {}) {
        this.loader = opts.loader ?? new CSReportSpecLoader(opts.specsDir ?? defaultSpecsDir());
        this.defaultAcquirer = opts.defaultAcquirer ?? new LatestDownloadAcquirer();
        this.dialectResolver = opts.dialectResolver ?? defaultDialectResolver;
        this.queryRunner = opts.queryRunner ?? defaultQueryRunner;
        this.procedureRunner = opts.procedureRunner ?? defaultProcedureRunner;
        this.pdfPipeline = opts.pdfPipeline ?? {
            extractPages: (fp, pipelineOpts) => extractPagesFromPdf(fp, {
                enableOcrFallback: pipelineOpts?.enableOcrFallback,
                ocrAdapter: pipelineOpts?.ocrAdapter,
            }),
            analyze: (pages, analyzeOpts) => analyzeReport(pages as any, {
                sectionHeaderRegexes: analyzeOpts?.sectionHeaderRegexes,
            }),
        };
        this.fileLoader = opts.fileLoader ?? defaultFileLoader();
        // `null` explicitly opts out of caching; `undefined` gets a fresh cache.
        this.canonicalCache = opts.canonicalCache === undefined ? new CSCanonicalCache() : opts.canonicalCache;
        this.ocrAdapter = opts.ocrAdapter;
        // When the caller injected a pre-populated loader, skip filesystem load — its cache is already primed.
        if (opts.loader) this.loaderInitialized = true;
    }

    /** Register a source-specific acquirer, overriding the default. */
    registerAcquirer(source: ReportSource, acquirer: ReportAcquirer): void {
        this.perSourceAcquirers.set(source, acquirer);
    }

    /** Register (or replace) the OCR adapter. Required for specs with `ocrFallback: true`. */
    registerOcrAdapter(adapter: OcrAdapter): void {
        this.ocrAdapter = adapter;
    }

    /** Access the canonical cache. Returns null when caching is disabled. */
    getCanonicalCache(): CSCanonicalCache | null {
        return this.canonicalCache;
    }

    /** Load and return a spec. Idempotent — subsequent calls hit the loader's in-memory cache. */
    async loadSpec(reportType: string): Promise<ReportSpec> {
        if (!this.loaderInitialized) {
            await this.loader.loadAll();
            this.loaderInitialized = true;
        }
        return this.loader.get(reportType);
    }

    /**
     * Determine the effective export format after applying the spec's `pdfOnly` rule.
     *
     *   - `spec.pdfOnly === true`  → always `'pdf'` regardless of `requested`
     *   - `requested` provided     → parsed (`"Excel"` → `'excel'`, etc.)
     *   - otherwise                → `spec.exportFormat`
     */
    resolveExportFormat(spec: ReportSpec, requested?: string): ReportFormat {
        if (spec.pdfOnly) return 'pdf';
        if (requested) {
            const normalized = requested.toLowerCase().trim();
            if (normalized === 'excel' || normalized === 'xlsx' || normalized === 'xls') return 'excel';
            if (normalized === 'csv') return 'csv';
            if (normalized === 'xml') return 'xml';
            if (normalized === 'pdf') return 'pdf';
            throw new Error(`CSReportValidationService: unsupported export format "${requested}"`);
        }
        return spec.exportFormat;
    }

    /**
     * Acquire a report file via the registered (per-source, then default) acquirer.
     * Returns the absolute file path.
     */
    async acquireReportFile(source: ReportSource, spec: ReportSpec, opts: AcquireOptions): Promise<string> {
        // Enforce pdfOnly early so acquirers can honour it. Rewrites requestedFormat only for the acquirer call;
        // the caller's original request is left intact (they can still read it if they need to warn).
        const effectiveRequest = spec.pdfOnly ? { ...opts, requestedFormat: 'pdf' } : opts;
        const acquirer = this.perSourceAcquirers.get(source) ?? this.defaultAcquirer;
        return acquirer.acquire(spec, effectiveRequest);
    }

    /**
     * Ingest a report file into a `CanonicalReport`. Routes by file extension (or explicit
     * `opts.format`): `.pdf` → PDF pipeline, `.xlsx`/`.xls` → Excel, `.csv` → CSV.
     */
    async ingestFile(
        filePath: string,
        spec: ReportSpec,
        source: ReportSource,
        opts: IngestOptions,
    ): Promise<CanonicalReport> {
        const format = opts.format ?? inferFormatFromPath(filePath);
        const params = normalizeParamsForCanonical(opts.params);
        const mapperOpts = {
            entity: opts.entity,
            source,
            params,
            sectionColumn: opts.sectionColumn,
        } as const;

        // Cache lookup — content-invariant key covers (filePath, mtime, size, source, spec fingerprint).
        // Only file-backed ingestion caches; DB canonicals fluctuate with the underlying data on
        // every call, so they intentionally bypass this path via `ingestFromDatabase`.
        const cacheKey =
            this.canonicalCache && fsSafeStat(filePath) ? CSCanonicalCache.keyFor(filePath, source, spec) : null;
        if (cacheKey && this.canonicalCache) {
            const hit = this.canonicalCache.get(cacheKey);
            if (hit) return hit;
        }

        const canonical = await this.ingestFileUncached(filePath, spec, source, opts, format, mapperOpts);
        if (cacheKey && this.canonicalCache) this.canonicalCache.set(cacheKey, canonical);
        return canonical;
    }

    private async ingestFileUncached(
        filePath: string,
        spec: ReportSpec,
        source: ReportSource,
        opts: IngestOptions,
        format: ReportFormat,
        mapperOpts: {
            readonly entity: string;
            readonly source: ReportSource;
            readonly params: Record<string, string> | undefined;
            readonly sectionColumn: string | undefined;
        },
    ): Promise<CanonicalReport> {
        void opts; // Sheet is already threaded into loadExcel below; keep the arg for future extension without a type churn.
        switch (format) {
            case 'pdf': {
                const pages = await this.pdfPipeline.extractPages(filePath, {
                    enableOcrFallback: !!spec.ocrFallback,
                    ocrAdapter: this.ocrAdapter,
                });
                const analyzed = this.pdfPipeline.analyze(pages, {
                    sectionHeaderRegexes: sectionHeaderRegexesFor(spec),
                });
                return CSReportSectionMapper.fromPdf(analyzed as any, spec, { ...mapperOpts, format: 'pdf' });
            }
            case 'excel': {
                const rows = await this.fileLoader.loadExcel(filePath, opts.sheet);
                return CSReportSectionMapper.fromExcel(rows, spec, mapperOpts);
            }
            case 'csv': {
                const rows = await this.fileLoader.loadCsv(filePath);
                return CSReportSectionMapper.fromCsv(rows, spec, mapperOpts);
            }
            default:
                throw new Error(
                    `CSReportValidationService: ingestion for format "${format}" is not implemented — ` +
                    `supported: pdf | excel | csv (xml planned for a later phase).`,
                );
        }
    }

    /**
     * Ingest the DB oracle for this spec. Picks the correct SQL variant per dialect,
     * substitutes named params from `opts.params`, runs the query, and maps rows into
     * a canonical report with `source: 'db'`.
     */
    async ingestFromDatabase(spec: ReportSpec, opts: IngestOptions): Promise<CanonicalReport> {
        if (!spec.database) {
            throw new Error(`CSReportValidationService: spec "${spec.reportType}" has no database block`);
        }
        const boundParams = { entity: opts.entity, ...(opts.params ?? {}) };

        if (spec.database.procedure) {
            return this.ingestFromProcedure(spec, spec.database.procedure, opts, boundParams);
        }

        const dialect = this.dialectResolver(spec.database.connectionAlias);
        const rawSql = pickDialectSql(spec.database.query, dialect);
        if (!rawSql) {
            throw new Error(
                `CSReportValidationService: spec "${spec.reportType}" has no SQL variant for dialect "${dialect}" ` +
                `(available: ${describeQueryVariants(spec.database.query)})`,
            );
        }
        const boundSql = substituteNamedParams(rawSql, boundParams);
        const rows = await this.queryRunner(spec.database.connectionAlias, boundSql);
        return CSReportSectionMapper.fromDb(rows, spec, {
            entity: opts.entity,
            params: normalizeParamsForCanonical(opts.params),
            sectionColumn: opts.sectionColumn,
        });
    }

    /**
     * Stored-procedure ingestion. Parameters bind POSITIONALLY through the driver (no textual
     * substitution), and every result set the procedure emitted is available.
     *
     * RESULT-SET SHAPES
     * -----------------
     *   1 set,  no `resultSets`  → flat ingestion, exactly like the query path.
     *   N sets, `resultSets`     → set i becomes section `resultSets[i]`; `""` discards a set.
     *   N sets, no `resultSets`  → ERROR. Silently taking one of them would let a comparison
     *                              that covered a fraction of the report report a pass, which
     *                              is precisely what the coverage gate exists to prevent.
     *   1 set,  `resultSets`     → allowed when exactly one entry names a section; the rows go
     *                              to that section. Lets a spec pin the section explicitly.
     */
    private async ingestFromProcedure(
        spec: ReportSpec,
        procedure: SpecProcedure,
        opts: IngestOptions,
        boundParams: Record<string, string | number>,
    ): Promise<CanonicalReport> {
        const alias = spec.database!.connectionAlias;
        const paramValues = resolveProcedureParams(spec, procedure, boundParams);
        const resultSets = await this.procedureRunner(alias, procedure.name, paramValues);

        if (!Array.isArray(resultSets) || resultSets.length === 0) {
            throw new Error(
                `CSReportValidationService: procedure "${procedure.name}" (spec "${spec.reportType}") returned no result set at all.`,
            );
        }

        const declared = procedure.resultSets;
        const mapperBase = {
            entity: opts.entity,
            params: normalizeParamsForCanonical(opts.params),
        } as const;

        if (!declared) {
            if (resultSets.length > 1) {
                throw new Error(
                    `CSReportValidationService: procedure "${procedure.name}" (spec "${spec.reportType}") returned ` +
                    `${resultSets.length} result sets but the spec declares no "database.procedure.resultSets" mapping — ` +
                    `refusing to guess which one to compare. Declare one section id per result set, in order ` +
                    `(use "" to discard a set).`,
                );
            }
            return CSReportSectionMapper.fromDb(resultSets[0] ?? [], spec, {
                ...mapperBase,
                sectionColumn: opts.sectionColumn,
            });
        }

        if (declared.length !== resultSets.length) {
            throw new Error(
                `CSReportValidationService: procedure "${procedure.name}" (spec "${spec.reportType}") returned ` +
                `${resultSets.length} result set(s) but "database.procedure.resultSets" declares ${declared.length} ` +
                `([${declared.map((d) => d || '(discard)').join(', ')}]). The counts must match exactly.`,
            );
        }

        // Tag each retained row with its section, then hand the concatenation to the flat
        // mapper under a synthetic section column. Going through ONE fromDb call (rather than
        // mapping each set separately and merging) keeps checksum namespacing, coverage
        // accounting, and unmapped-field detection identical to every other flat source.
        const tagged: DataRow[] = [];
        for (let i = 0; i < resultSets.length; i++) {
            const sectionId = declared[i];
            if (!sectionId) continue; // "" — deliberately discarded (leading count/status set).
            for (const row of resultSets[i] ?? []) {
                tagged.push({ ...row, [PROCEDURE_SECTION_COLUMN]: sectionId });
            }
        }

        return CSReportSectionMapper.fromDb(tagged, spec, {
            ...mapperBase,
            sectionColumn: PROCEDURE_SECTION_COLUMN,
        });
    }

    /** Passthrough to `CSReportReconciler.reconcile`. Kept on the service so BDD steps have one collaborator. */
    reconcile(a: CanonicalReport, b: CanonicalReport, spec: ReportSpec): ReconciliationResult {
        return CSReportReconciler.reconcile(a, b, spec);
    }

    /**
     * Render the diff report to the framework's current test-results `reports/report-validation/`
     * directory (or a cwd-local fallback when the framework harness isn't hosting the test).
     * Returns the file path + byte count so the caller can log where the artefact landed.
     */
    writeDiffReport(input: DiffReportInput): DiffReportWriteResult {
        return CSReportDiffReporter.writeToRunReports(input);
    }

    /**
     * Dump one canonical extraction to `reports/report-validation/` as JSON (full fidelity)
     * and CSV (opens in Excel), alongside the diff report.
     *
     * This is what answers "show me what you actually pulled out of the PDF" — the diff
     * report renders findings, so a clean run otherwise leaves only a record count behind.
     *
     * Returns `[]` when `REPORT_CANONICAL_DUMP` is switched off. Never throws for a reason
     * the caller should act on: dumping is evidence, not a result.
     */
    dumpCanonical(canonical: CanonicalReport, opts: CanonicalDumpOptions = {}): CanonicalDumpWriteResult[] {
        if (!canonicalDumpEnabled()) return [];
        return CSReportCanonicalDumper.writeToRunReports(canonical, opts);
    }

    /**
     * Check that every required section is present on the canonical, and (when
     * `spec.enforceSectionOrder`) that they appear in declared order. Passthrough
     * to `CSReportSectionValidator.validate` — kept on the service so BDD steps
     * have one collaborator for all report-validation work.
     */
    validateSections(canonical: CanonicalReport, spec: ReportSpec): SectionValidationResult {
        return CSReportSectionValidator.validate(canonical, spec);
    }
}

// ---------------------------------------------------------------------------
// Internals — kept module-local; not exported to keep the surface small.
// ---------------------------------------------------------------------------

/**
 * Where report specs live. `REPORT_SPECS_DIR` (config or environment) wins, so a consuming
 * project can keep its specs outside the repo — they name a specific report's sections and
 * every column heading, which is not something to commit.
 */
function defaultSpecsDir(): string {
    const configured = readConfig('REPORT_SPECS_DIR') || process.env.REPORT_SPECS_DIR;
    if (configured && configured.trim().length > 0) {
        return path.resolve(process.cwd(), configured.trim());
    }
    return path.join(process.cwd(), 'config', 'report-specs');
}

/** Read a framework config key, returning undefined when configuration isn't available. */
function readConfig(key: string): string | undefined {
    try {
        const { CSConfigurationManager } = require('../core/CSConfigurationManager');
        const value = CSConfigurationManager.getInstance().get(key);
        return typeof value === 'string' ? value : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Safe stat probe — returns true when the path exists and is a regular file (so `keyFor`
 * can synchronously stat it). Returns false for missing paths, permission errors, or when
 * the caller passed something that isn't a file (a mocked path in a test, for instance).
 * Cache is only queried when this passes; misses fall through to the real ingestion path.
 */
function fsSafeStat(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function defaultDialectResolver(connectionAlias: string): DbDialect {
    try {
        const { CSConfigurationManager } = require('../core/CSConfigurationManager');
        const cfg = CSConfigurationManager.getInstance();
        const typeKey = `DB_${connectionAlias}_TYPE`;
        const raw = cfg.get(typeKey);
        if (raw && typeof raw === 'string') {
            const norm = raw.toLowerCase();
            if (norm === 'oracle') return 'oracle';
            if (norm === 'mssql' || norm === 'sqlserver' || norm === 'sql-server') return 'sqlserver';
        }
    } catch {
        // Configuration lookup failed — fall through to the conservative default.
    }
    return 'sqlserver';
}

/**
 * Synthetic column used to carry a procedure result set's section id into the flat mapper.
 * The mapper strips its `sectionColumn` from the data, so this never becomes a comparable
 * field. Deliberately un-SQL-like so it cannot collide with a real column name.
 */
const PROCEDURE_SECTION_COLUMN = '__cs_report_section__';

/**
 * Resolve a procedure's declared parameter names into an ordered value array. A declared name
 * with no bound value is an error rather than a silent NULL — a report run against an unbound
 * as-of date would compare the wrong data and look like a pass.
 */
function resolveProcedureParams(
    spec: ReportSpec,
    procedure: SpecProcedure,
    boundParams: Record<string, string | number>,
): Array<string | number> {
    const names = procedure.params ?? [];
    return names.map((name) => {
        if (!(name in boundParams)) {
            throw new Error(
                `CSReportValidationService: procedure "${procedure.name}" (spec "${spec.reportType}") declares ` +
                `parameter "${name}" but no value was supplied ` +
                `(available: ${Object.keys(boundParams).join(', ') || '(none)'}). ` +
                `Set it with: Given the report parameter "${name}" is "<value>"`,
            );
        }
        return boundParams[name];
    });
}

/**
 * Default procedure runner — `CSDatabaseManager` + `CSDatabase.executeStoredProcedure`.
 * Returns every result set in driver order; falls back to the single `rows` set for drivers
 * (or mocks) that don't surface `recordsets`.
 */
async function defaultProcedureRunner(
    connectionAlias: string,
    procedureName: string,
    params: Array<string | number>,
): Promise<DataRow[][]> {
    const { CSDatabaseManager } = require('../database/CSDatabaseManager');
    const mgr = CSDatabaseManager.getInstance();
    const db = await mgr.getDatabase(connectionAlias);
    const result = await db.executeStoredProcedure(procedureName, params);
    const sets: any[] = (result && (result as any).recordsets) || [];
    if (Array.isArray(sets) && sets.length > 0) {
        return sets.map((rs: any) => toDataRows(rs));
    }
    return [toDataRows((result && (result as any).rows) || [])];
}

/**
 * Coerce a driver result set into plain row objects, tolerating the array-of-arrays shape some
 * drivers return for scalar-column queries. Same semantics as `defaultQueryRunner`, including
 * the defensive copy — nothing downstream should be able to write back into driver buffers.
 */
function toDataRows(raw: any): DataRow[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((row: any) => {
        if (row && typeof row === 'object' && !Array.isArray(row)) {
            return { ...row } as DataRow;
        }
        return { value: row } as DataRow;
    });
}

async function defaultQueryRunner(connectionAlias: string, sql: string): Promise<DataRow[]> {
    const { CSDatabaseManager } = require('../database/CSDatabaseManager');
    const mgr = CSDatabaseManager.getInstance();
    const db = await mgr.getDatabase(connectionAlias);
    const result = await db.execute(sql);
    // ResultSet.rows is an array of row objects; map each to a plain DataRow. Some drivers
    // return array-of-arrays for scalar-column queries — guard for that too.
    const rows: any[] = (result && (result as any).rows) || [];
    return rows.map((row) => {
        if (row && typeof row === 'object' && !Array.isArray(row)) {
            return { ...row } as DataRow;
        }
        return { value: row } as DataRow;
    });
}

function defaultFileLoader(): FileLoader {
    return {
        async loadExcel(filePath: string, sheet?: string): Promise<DataRow[]> {
            const { CSDataProvider } = require('../data/CSDataProvider');
            return CSDataProvider.getInstance().loadData({ source: filePath, sheet, type: 'excel' });
        },
        async loadCsv(filePath: string): Promise<DataRow[]> {
            const { CSDataProvider } = require('../data/CSDataProvider');
            return CSDataProvider.getInstance().loadData({ source: filePath, type: 'csv' });
        },
    };
}

/**
 * Build the section-header regexes the layout analyzer should recognise, from the spec's
 * `requiredSections`. Each section contributes its `matchers` when declared, otherwise an
 * anchored, case-insensitive match on its `title`. Invalid regexes in a spec are skipped
 * with the rest still applied — a typo in one matcher shouldn't blind the analyzer to
 * every other section.
 */
function sectionHeaderRegexesFor(spec: ReportSpec): RegExp[] {
    const out: RegExp[] = [];
    for (const section of spec.requiredSections ?? []) {
        const patterns = section.matchers && section.matchers.length > 0
            ? section.matchers
            : [`^${escapeRegex(section.title)}$`];
        for (const pattern of patterns) {
            try {
                out.push(new RegExp(pattern, 'i'));
            } catch {
                // Malformed matcher — the spec loader validates shape, not regex syntax.
                // Skipping keeps the remaining sections detectable.
            }
        }
    }
    return out;
}

function escapeRegex(literal: string): string {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inferFormatFromPath(filePath: string): ReportFormat {
    const ext = filePath.toLowerCase().split('.').pop() ?? '';
    if (ext === 'pdf') return 'pdf';
    if (ext === 'xlsx' || ext === 'xls') return 'excel';
    if (ext === 'csv') return 'csv';
    if (ext === 'xml') return 'xml';
    throw new Error(
        `CSReportValidationService: cannot infer format from extension ".${ext}" — pass opts.format explicitly.`,
    );
}

function pickDialectSql(query: SpecDatabaseQuery | undefined, dialect: DbDialect): string | undefined {
    if (query === undefined) return undefined;
    if (typeof query === 'string') return query;
    return query[dialect];
}

function describeQueryVariants(query: SpecDatabaseQuery | undefined): string {
    if (query === undefined) return '(none)';
    if (typeof query === 'string') return 'inline';
    return Object.keys(query).filter((k) => Boolean((query as any)[k])).join(', ') || '(none)';
}

/**
 * Substitute `@name` (SQL Server) and `:name` (Oracle) tokens in `sql` with the corresponding
 * value from `params`. Strings are single-quote-escaped; numbers are inlined; booleans and
 * dates are coerced to their string form. Names must be `[A-Za-z_][A-Za-z0-9_]*`; unknown
 * tokens throw so a typo doesn't ship as a silent NULL.
 *
 * This is a deliberately narrow, test-safe substituter — it is NOT a general SQL builder
 * and MUST NOT be given untrusted input. All callers pass caller-typed test params.
 */
export function substituteNamedParams(
    sql: string,
    params: Record<string, string | number | boolean | Date | null | undefined>,
): string {
    // Regex covers both `@name` and `:name` tokens outside of quoted string literals.
    // We handle quotes by first splitting the SQL into (literal | code) runs and only
    // substituting inside code runs.
    const runs = splitOnQuotedLiterals(sql);
    return runs
        .map((run) => (run.quoted ? run.text : substituteInCode(run.text, params)))
        .join('');
}

function substituteInCode(
    code: string,
    params: Record<string, string | number | boolean | Date | null | undefined>,
): string {
    return code.replace(/([@:])([A-Za-z_][A-Za-z0-9_]*)/g, (match, prefix, name) => {
        if (!(name in params)) {
            throw new Error(
                `CSReportValidationService: SQL binding "${match}" has no matching value in params ` +
                `(available: ${Object.keys(params).join(', ') || '(none)'})`,
            );
        }
        return formatSqlLiteral(params[name]);
    });
}

/** Split SQL into runs marked `quoted: true` (inside a `'...'` string literal, keep verbatim) or false (code). */
function splitOnQuotedLiterals(sql: string): Array<{ text: string; quoted: boolean }> {
    const out: Array<{ text: string; quoted: boolean }> = [];
    let i = 0;
    let currentStart = 0;
    let inQuote = false;
    while (i < sql.length) {
        const ch = sql[i];
        if (!inQuote && ch === "'") {
            if (i > currentStart) out.push({ text: sql.slice(currentStart, i), quoted: false });
            currentStart = i;
            inQuote = true;
            i++;
            continue;
        }
        if (inQuote && ch === "'") {
            // Two consecutive single quotes inside a literal are an escaped quote — stay in the literal.
            if (sql[i + 1] === "'") { i += 2; continue; }
            i++;
            out.push({ text: sql.slice(currentStart, i), quoted: true });
            currentStart = i;
            inQuote = false;
            continue;
        }
        i++;
    }
    if (currentStart < sql.length) {
        out.push({ text: sql.slice(currentStart), quoted: inQuote });
    }
    return out;
}

function formatSqlLiteral(value: string | number | boolean | Date | null | undefined): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (value instanceof Date) return `'${value.toISOString().replace(/'/g, "''")}'`;
    return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizeParamsForCanonical(
    params?: Record<string, string | number>,
): Record<string, string> | undefined {
    if (!params) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) out[k] = String(v);
    return out;
}

