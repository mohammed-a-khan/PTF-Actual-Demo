/**
 * CS Report Validation — Barrel export.
 *
 * Public API of the report-validation module. Import via subpath:
 *
 *     import { CSReportReconciler } from '@mdakhan.mak/cs-playwright-test-framework/report-validation';
 *
 * Later phases add: CSReportPdfExtractor (Phase B), CSReportSectionMapper (Phase C),
 * CSReportValidationService (Phase D), CSReportDiffReporter (Phase E).
 *
 * @module report-validation
 */

export type {
    CanonicalReport,
    CanonicalSection,
    CanonicalRecord,
    CanonicalValue,
    ReportSource,
    ReportFormat,
    Finding,
    FindingKind,
    ReconciliationCounts,
    ReconciliationResult,
    CoverageMeta,
} from './CSReportModel';

export type {
    ReportSpec,
    SpecFieldNames,
    SummaryFieldSpec,
    ToleranceSpec,
    RequiredSectionSpec,
    KnownDifferenceSpec,
    SpecDatabase,
    SpecDatabaseQuery,
} from './CSReportSpec';
export { CSReportSpecLoader, validateReportSpecShape } from './CSReportSpec';

export type { NormalizerOptions } from './CSReportNormalizer';
export {
    normalizeValue,
    normalizeColumnName,
    canonicalFieldFor,
    parseDateWithFormat,
    canonicalizeString,
} from './CSReportNormalizer';

export { CSReportReconciler, compareValues } from './CSReportReconciler';

// ---- Phase B: PDF extraction + layout analysis ----------------------------
export type {
    TextItem,
    PageContent,
    ChartRegion,
    BoundingBox,
    LogicalLine,
    ColumnBand,
    TableRow,
    CellMeta,
    AnalyzedSection,
    AnalyzedPage,
    TocEntry,
    AnalyzedReport,
    LayoutAnalyzerOptions,
} from './CSReportPdfTypes';

export {
    extractPagesFromPdf,
    extractPagesFromBuffer,
    type PdfJsLoader,
    type PdfJsDocument,
    type PdfJsPage,
    type PdfJsTextContent,
    type PdfJsTextItem,
    type PdfJsStyle,
    type PdfExtractionOptions,
} from './CSReportPdfExtractor';

export { analyzeReport } from './CSReportPdfLayoutAnalyzer';

// ---- Phase C: section mapper (spec-driven → CanonicalReport) --------------
export {
    CSReportSectionMapper,
    resolveCanonicalSectionId,
    type DataRow,
    type MapperOptions,
} from './CSReportSectionMapper';

// Layout submodules — re-exported so callers can drop into individual passes for
// diagnostics, custom pipelines, or writing report-specific overrides.
export { clusterLines, type LineClusterOptions } from './layout/CSLineClusterer';
export {
    detectColumnsByAlignment,
    type AlignmentNetworkOptions,
} from './layout/CSTextAlignmentNetwork';
export {
    detectColumns,
    assignItemsToColumns,
    columnIndexFor,
    type ColumnDetectorOptions,
} from './layout/CSColumnDetector';
export {
    segmentPages,
    type PageSegmenterOptions,
    type SegmentedPage,
} from './layout/CSPageSegmenter';
export {
    detectSectionHeaders,
    type SectionDetectorOptions,
    type SectionHeaderCandidate,
} from './layout/CSSectionDetector';
export {
    resolveTableHeaders,
    type TableHeaderResolverOptions,
} from './layout/CSTableHeaderResolver';
export {
    stitchMultiLineCells,
    linesToTableRows,
    shouldMergeAcrossPages,
    extractGroupLabelIfHeader,
    type CellStitcherOptions,
} from './layout/CSCellStitcher';
export {
    tagTotalRows,
    extractChecksumsFromTotalRow,
    type TotalRowTaggerOptions,
} from './layout/CSTotalRowTagger';
export {
    detectChartRegions,
    removeChartItems,
    type ChartRegionDetectorOptions,
} from './layout/CSChartRegionDetector';
export {
    extractToc,
    findTocPageNumbers,
    findTocEntryLines,
    type TocExtractorOptions,
} from './layout/CSTocExtractor';

// ---- Phase E: HTML diff reporter ------------------------------------------
export {
    CSReportDiffReporter,
    computeComparisonScope,
    resolveReportValidationOutputDir,
    type ComparisonScope,
    type SectionComparisonScope,
    type DiffReportInput,
    type DiffReportWriteResult,
} from './CSReportDiffReporter';

// ---- Phase E: canonical extraction dump -----------------------------------
export {
    CSReportCanonicalDumper,
    canonicalDumpEnabled,
    type CanonicalDumpOptions,
    type CanonicalDumpWriteResult,
} from './CSReportCanonicalDumper';

// ---- Standalone section validator (spec §5 file layout) -------------------
export {
    CSReportSectionValidator,
    validateSections,
    type SectionValidationResult,
} from './CSReportSectionValidator';

// ---- Phase F: checksum validator + canonical cache + OCR adapter ----------
export { validateChecksums } from './CSReportChecksumValidator';
export { validateCoverage } from './CSReportCoverageValidator';
export { validateFooting } from './CSReportFootingValidator';
export {
    CSCanonicalCache,
    specFingerprint,
    type CanonicalCacheKey,
    type CanonicalCacheOptions,
} from './CSCanonicalCache';
export {
    NoOpOcrAdapter,
    type OcrAdapter,
    type OcrPageContext,
} from './CSReportOcrAdapter';

// ---- Phase D: validation service (orchestrator) ---------------------------
export {
    CSReportValidationService,
    substituteNamedParams,
    type IngestOptions,
    type AcquireOptions,
    type ReportAcquirer,
    type DbDialect,
    type DialectResolver,
    type QueryRunner,
    type PdfPipeline,
    type PdfPipelineOptions,
    type FileLoader,
    type ServiceOptions,
} from './CSReportValidationService';

// ---- Simple PDF validator (the everyday case) -----------------------------
export type {
    SimpleFieldKind,
    SimpleReadFrom,
    SimpleFieldSpec,
    SimpleTableColumnSpec,
    SimpleTableSpec,
    SimpleReportSpec,
} from './CSReportSimpleSpec';
export { loadSimpleReportSpec, validateSimpleReportSpecShape } from './CSReportSimpleSpec';
export { extractField, type FieldExtractionResult } from './CSReportSimpleFieldExtractor';
export { detectPresence } from './CSReportSimplePresenceDetector';
export { extractTable, type TableExtractionResult } from './CSReportSimpleTableExtractor';
export {
    validatePdfAgainstSpec,
    validatePdfFromTokens,
    type FieldStatus,
    type TableStatus,
    type FieldFinding,
    type TableRowFinding,
    type TableFinding,
    type ValidationSummary,
    type ValidationResult,
    type ValidateOptions,
} from './CSReportSimpleValidator';

// ---- Phase-1 + Phase-3 checks (metadata, links, header/footer, watermarks, layout, integrity, text-quality,
//      structural, interactive, attachments, table-depth) ----
export * from './checks';
export type {
    Phase1Findings,
    Phase3Findings,
    Phase4Findings,
    Phase5Findings,
    Phase6Findings,
} from './CSReportSimpleValidator';
export type { SimpleReportSpecChecks } from './CSReportSimpleSpec';

// ---- Tier-1 formatting validator (bold/italic/font-size/alignment/prefix) --
export {
    validateFormatting,
    type FormattingFinding,
} from './CSReportSimpleFormattingValidator';
export type { SimpleFormattingRule } from './CSReportSimpleSpec';

// ---- SimpleReportSpec auto-generator (starter spec from a sample PDF) ------
export {
    generateSimpleReportSpec,
    buildSpecFromAnalyzed,
    type GenerateSpecOptions,
    type GenerateSpecResult,
} from './CSReportSimpleSpecGenerator';
export {
    parseReportSpecInitArgs,
    runReportSpecInit,
    type ReportSpecInitOptions,
    type ReportSpecInitResult,
} from './CSReportSimpleSpecGeneratorCli';

// ---- SimpleReportSpec HTML report renderer --------------------------------
export {
    writeSimpleValidatorHtmlReport,
    type SimpleValidatorReporterOptions,
    type SimpleValidatorReportWriteResult,
} from './CSReportSimpleValidatorReporter';

// ---- v1.52 test-data-first surface ----------------------------------------
export {
    validatePdfFromDataFile,
    synthesiseSpecFromData,
    extractPdfTokensByPage,
    inferLabels,
    type ValidateFromDataOptions,
} from './CSReportSimpleValidatorFromData';

// ---- v1.53 PDF-vs-PDF pair reconciler -------------------------------------
export {
    reconcilePdfsFromRules,
    reconcileAnalyzedReports,
    generateReconciliationRulesFromPair,
    type ReconcileFinding,
    type ReconcileFindingKind,
    type ReconcileColumnRule,
    type ReconcileSectionRule,
    type KnownDifference,
    type GlobalTolerance,
    type ReconcileRules,
    type ReconcileResult,
    type ReconcileLedgerRow,
    type ReconcileLedgerCell,
    type ReconcilePdfPairOptions,
} from './CSPdfPairReconciler';

// ---- v1.53 PDF-vs-DB reconciler -------------------------------------------
export {
    reconcilePdfDbFromRules,
    reconcilePdfDbAuto,
    type DbSectionSpec,
    type DbReferenceDataSource,
    type PdfDbRulesJson,
    type ReconcilePdfDbOptions,
    type ReconcilePdfDbAutoOptions,
} from './CSPdfDbReconciler';

// ---- v1.53 reconciler HTML reporter --------------------------------------
export {
    writeReconcileHtmlReport,
    type ReconcileReporterOptions,
    type ReconcileReporterResult,
} from './CSPdfReconcileReporter';
