/**
 * Phase 1 checks aggregate — one import surface for the seven validators.
 *
 * @module report-validation/checks
 */

export {
    readPdfMetadata,
    validateMetadata,
    type MetadataRule,
    type MetadataFinding,
    type RawPdfMetadata,
} from './CSPdfMetadataValidator';

export {
    readLinkInventory,
    validateLinks,
    type LinkRule,
    type LinkFinding,
    type LinkInventory,
} from './CSPdfLinkValidator';

export {
    validateHeaderFooter,
    type HeaderFooterRule,
    type HeaderFooterFinding,
} from './CSPdfHeaderFooterValidator';

export {
    validateWatermarks,
    type WatermarkRule,
    type WatermarkFinding,
} from './CSPdfWatermarkValidator';

export {
    readLayoutInfo,
    validateLayout,
    type LayoutRule,
    type LayoutFinding,
} from './CSPdfLayoutValidator';

export {
    computeFileSha256,
    readAttachments,
    validateIntegrity,
    type IntegrityRule,
    type IntegrityFinding,
    type AttachmentInventory,
} from './CSPdfIntegrityValidator';

export {
    validateTextQuality,
    type TextQualityRule,
    type TextQualityFinding,
} from './CSPdfTextQualityValidator';

// ---- Phase 3: structural / interactive / attachments / table-depth --------
export {
    readStructuralInventory,
    validateStructural,
    type StructuralRule,
    type StructuralFinding,
    type StructuralInventory,
} from './CSPdfStructuralValidator';

export {
    readInteractiveInventory,
    validateInteractive,
    type InteractiveRule,
    type InteractiveFinding,
    type InteractiveInventory,
} from './CSPdfInteractiveValidator';

export {
    readAttachmentInventory,
    validateAttachments,
    inferMime,
    type AttachmentRule,
    type AttachmentFinding,
    type AttachmentInfo,
    type AttachmentBundle,
} from './CSPdfAttachmentValidator';

export {
    analyzeTableDepth,
    type TableDepthRule,
    type TableDepthFinding,
    type TableDepthAnalysis,
} from './CSPdfTableDepthValidator';

// ---- Phase 4: rendering / visual regression / charts / images / contrast ----
export {
    readImageInventory,
    validateImages,
    type ImageRule,
    type ImageFinding,
    type ImageInfo,
    type ImageInventory,
} from './CSPdfImageInventoryValidator';

export {
    validateContrast,
    type ContrastRule,
    type ContrastFinding,
} from './CSPdfContrastValidator';

export {
    validateChartRegions,
    type ChartRegionRule,
    type ChartRegionFinding,
} from './CSPdfChartRegionValidator';

export {
    validateVisualRegression,
    type VisualRegressionRule,
    type VisualRegressionFinding,
} from './CSPdfVisualRegressionValidator';

// ---- Phase 5: security / barcode ------------------------------------------
export {
    readSecurityInventory,
    validateSecurity,
    type SecurityRule,
    type SecurityFinding,
    type SecurityInventory,
} from './CSPdfSecurityValidator';

export {
    readBarcodeInventory,
    validateBarcodes,
    type BarcodeRule,
    type BarcodeFinding,
    type BarcodeInventory,
} from './CSPdfBarcodeValidator';

// ---- Phase 6: version diff ------------------------------------------------
export {
    validateVersionDiff,
    type VersionDiffRule,
    type VersionDiffFinding,
} from './CSPdfVersionDiffValidator';
