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

export { CSReportReconciler } from './CSReportReconciler';

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
