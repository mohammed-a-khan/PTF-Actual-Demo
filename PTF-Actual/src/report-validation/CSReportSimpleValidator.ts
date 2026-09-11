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
import { analyzeReport } from './CSReportPdfLayoutAnalyzer';
import type { PageContent, TextItem } from './CSReportPdfTypes';
import type { SimpleReportSpec, SimpleFieldKind } from './CSReportSimpleSpec';
import { extractField } from './CSReportSimpleFieldExtractor';
import { validateFormatting, type FormattingFinding } from './CSReportSimpleFormattingValidator';
import { detectPresence } from './CSReportSimplePresenceDetector';
import { extractTable } from './CSReportSimpleTableExtractor';
import {
    readPdfMetadata,
    validateMetadata,
    type MetadataFinding,
} from './checks/CSPdfMetadataValidator';
import {
    readLinkInventory,
    validateLinks,
    type LinkFinding,
} from './checks/CSPdfLinkValidator';
import {
    validateHeaderFooter,
    type HeaderFooterFinding,
} from './checks/CSPdfHeaderFooterValidator';
import {
    validateWatermarks,
    type WatermarkFinding,
} from './checks/CSPdfWatermarkValidator';
import {
    readLayoutInfo,
    validateLayout,
    type LayoutFinding,
} from './checks/CSPdfLayoutValidator';
import {
    readAttachments,
    validateIntegrity,
    type IntegrityFinding,
} from './checks/CSPdfIntegrityValidator';
import {
    validateTextQuality,
    type TextQualityFinding,
} from './checks/CSPdfTextQualityValidator';
import {
    readStructuralInventory,
    validateStructural,
    type StructuralFinding,
} from './checks/CSPdfStructuralValidator';
import {
    readInteractiveInventory,
    validateInteractive,
    type InteractiveFinding,
} from './checks/CSPdfInteractiveValidator';
import {
    readAttachmentInventory,
    validateAttachments,
    type AttachmentFinding,
} from './checks/CSPdfAttachmentValidator';
import {
    analyzeTableDepth,
    type TableDepthFinding,
    type TableDepthAnalysis,
} from './checks/CSPdfTableDepthValidator';
import {
    readImageInventory,
    validateImages,
    type ImageFinding,
} from './checks/CSPdfImageInventoryValidator';
import {
    validateContrast,
    type ContrastFinding,
} from './checks/CSPdfContrastValidator';
import {
    validateChartRegions,
    type ChartRegionFinding,
} from './checks/CSPdfChartRegionValidator';
import {
    validateVisualRegression,
    type VisualRegressionFinding,
} from './checks/CSPdfVisualRegressionValidator';
import {
    readSecurityInventory,
    validateSecurity,
    type SecurityFinding,
} from './checks/CSPdfSecurityValidator';
import {
    validateBarcodes,
    type BarcodeFinding,
} from './checks/CSPdfBarcodeValidator';
import {
    validateVersionDiff,
    type VersionDiffFinding,
} from './checks/CSPdfVersionDiffValidator';

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
    /** Populated when the field declared a `formatting:` block and at least one rule was checked. */
    formattingFindings?: FormattingFinding[];
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
    /** Total number of Tier-1 formatting drift findings across all fields. */
    formattingDriftCount: number;
    passed: boolean;
}

export interface Phase1Findings {
    metadata: MetadataFinding[];
    links: LinkFinding[];
    headerFooter: HeaderFooterFinding[];
    watermarks: WatermarkFinding[];
    layout: LayoutFinding[];
    integrity: IntegrityFinding[];
    textQuality: TextQualityFinding[];
}

/**
 * Phase-3 findings. Each list is populated only if the corresponding
 * `checks.*` block was declared on the spec; otherwise remains an empty
 * array. Any finding here fails the run in the same way phase-1 does.
 */
export interface Phase3Findings {
    structural: StructuralFinding[];
    interactive: InteractiveFinding[];
    attachments: AttachmentFinding[];
    tableDepth: Record<string, TableDepthAnalysis>;
    tableDepthFindings: TableDepthFinding[];
}

/** Phase-4 findings — rendering / images / contrast / chart regions. */
export interface Phase4Findings {
    images: ImageFinding[];
    contrast: ContrastFinding[];
    chartRegions: ChartRegionFinding[];
    visualRegression: VisualRegressionFinding[];
}

/** Phase-5 findings — security / barcodes. */
export interface Phase5Findings {
    security: SecurityFinding[];
    barcodes: BarcodeFinding[];
}

/** Phase-6 findings — version diff. */
export interface Phase6Findings {
    versionDiff: VersionDiffFinding[];
}

export interface ValidationResult {
    summary: ValidationSummary;
    fields: FieldFinding[];
    tables: TableFinding[];
    warnings: string[];
    /** Phase-1 check findings. Empty arrays when the corresponding check block wasn't declared or produced no findings. */
    phase1: Phase1Findings;
    /** Phase-3 check findings. Empty when no phase-3 block declared. */
    phase3: Phase3Findings;
    /** Phase-4 check findings (rendering / visuals). Empty when not declared. */
    phase4: Phase4Findings;
    /** Phase-5 check findings (security / barcodes). Empty when not declared. */
    phase5: Phase5Findings;
    /** Phase-6 check findings (version diff). Empty when not declared. */
    phase6: Phase6Findings;
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
    const coreResult = validatePdfFromTokens({ ...opts, tokensByPage });

    // Phase-1 checks — run only for blocks declared on the spec.
    const checks = opts.spec.checks;
    const phase1: Phase1Findings = {
        metadata: [],
        links: [],
        headerFooter: [],
        watermarks: [],
        layout: [],
        integrity: [],
        textQuality: [],
    };
    if (checks) {
        if (checks.metadata) {
            try {
                const meta = await readPdfMetadata(opts.pdfPath);
                phase1.metadata = validateMetadata(meta, checks.metadata);
            } catch (e) {
                opts.spec && coreResult.warnings.push(`checks.metadata failed to run: ${(e as Error).message}`);
            }
        }
        if (checks.links) {
            try {
                const inv = await readLinkInventory(opts.pdfPath);
                phase1.links = await validateLinks(inv, checks.links);
            } catch (e) {
                coreResult.warnings.push(`checks.links failed to run: ${(e as Error).message}`);
            }
        }
        // Header/footer + watermarks both need the analyzed report — run analyzer once.
        let analyzed: ReturnType<typeof analyzeReport> | undefined;
        if (checks.headerFooter || checks.watermarks || checks.integrity?.assertTocSectionCountMatch) {
            try {
                analyzed = analyzeReport(pages);
            } catch (e) {
                coreResult.warnings.push(`analyzeReport failed: ${(e as Error).message}`);
            }
        }
        if (checks.headerFooter && analyzed) {
            phase1.headerFooter = validateHeaderFooter(analyzed, checks.headerFooter);
        }
        if (checks.watermarks && analyzed) {
            phase1.watermarks = validateWatermarks(analyzed, checks.watermarks);
        }
        if (checks.layout) {
            try {
                const info = await readLayoutInfo(opts.pdfPath);
                phase1.layout = validateLayout(info, checks.layout);
            } catch (e) {
                coreResult.warnings.push(`checks.layout failed to run: ${(e as Error).message}`);
            }
        }
        if (checks.integrity) {
            let attachments: Awaited<ReturnType<typeof readAttachments>> | undefined;
            if (
                checks.integrity.attachmentCount !== undefined ||
                checks.integrity.attachmentAllowList ||
                checks.integrity.attachmentForbiddenPatterns
            ) {
                try {
                    attachments = await readAttachments(opts.pdfPath);
                } catch (e) {
                    coreResult.warnings.push(`readAttachments failed: ${(e as Error).message}`);
                }
            }
            phase1.integrity = validateIntegrity({
                pdfPath: opts.pdfPath,
                analyzed,
                attachments,
                rule: checks.integrity,
            });
        }
        if (checks.textQuality) {
            phase1.textQuality = validateTextQuality(pages, checks.textQuality);
        }
    }

    // ---- Phase 3 ---------------------------------------------------------
    const phase3: Phase3Findings = {
        structural: [],
        interactive: [],
        attachments: [],
        tableDepth: {},
        tableDepthFindings: [],
    };
    if (checks) {
        if (checks.structural) {
            try {
                const inv = await readStructuralInventory(opts.pdfPath);
                phase3.structural = validateStructural(inv, checks.structural);
            } catch (e) {
                coreResult.warnings.push(`checks.structural failed to run: ${(e as Error).message}`);
            }
        }
        if (checks.interactive) {
            try {
                const inv = await readInteractiveInventory(opts.pdfPath);
                phase3.interactive = validateInteractive(inv, checks.interactive);
            } catch (e) {
                coreResult.warnings.push(`checks.interactive failed to run: ${(e as Error).message}`);
            }
        }
        if (checks.attachments) {
            try {
                const inv = await readAttachmentInventory(opts.pdfPath);
                phase3.attachments = validateAttachments(inv, checks.attachments);
            } catch (e) {
                coreResult.warnings.push(`checks.attachments failed to run: ${(e as Error).message}`);
            }
        }
        if (checks.tableDepth) {
            // Runs against the already-analyzed report — reuse if we built one for
            // header/footer, else build now.
            let a: ReturnType<typeof analyzeReport> | undefined;
            try {
                a = analyzeReport(pages);
            } catch (e) {
                coreResult.warnings.push(`analyzeReport failed for tableDepth: ${(e as Error).message}`);
            }
            if (a) {
                for (const [tableName, rule] of Object.entries(checks.tableDepth)) {
                    // Find the AnalyzedSection whose id matches. Section ids are already
                    // spec-driven — we defer to the resolver used elsewhere.
                    const section = a.pages
                        .flatMap((p) => p.sections)
                        .find((s) => s.title.toLowerCase() === tableName.toLowerCase());
                    if (!section) {
                        coreResult.warnings.push(`checks.tableDepth: table "${tableName}" not found in analyzed report`);
                        continue;
                    }
                    const analysis = analyzeTableDepth(section.tableRows ?? [], section.columns ?? [], rule);
                    phase3.tableDepth[tableName] = analysis;
                    phase3.tableDepthFindings.push(...analysis.findings);
                }
            }
        }
    }

    // ---- Phase 4 ---------------------------------------------------------
    const phase4: Phase4Findings = {
        images: [],
        contrast: [],
        chartRegions: [],
        visualRegression: [],
    };
    if (checks) {
        if (checks.images) {
            try {
                const inv = await readImageInventory(opts.pdfPath);
                phase4.images = validateImages(inv, checks.images);
            } catch (e) {
                coreResult.warnings.push(`checks.images failed: ${(e as Error).message}`);
            }
        }
        if (checks.contrast || checks.chartRegions) {
            let a: ReturnType<typeof analyzeReport> | undefined;
            try {
                a = analyzeReport(pages);
            } catch (e) {
                coreResult.warnings.push(`analyzeReport failed for Phase 4: ${(e as Error).message}`);
            }
            if (a) {
                if (checks.contrast) phase4.contrast = validateContrast(pages, checks.contrast);
                if (checks.chartRegions) phase4.chartRegions = validateChartRegions(a, checks.chartRegions, pages);
            }
        }
        if (checks.visualRegression) {
            try {
                phase4.visualRegression = await validateVisualRegression(opts.pdfPath, checks.visualRegression);
            } catch (e) {
                coreResult.warnings.push(`checks.visualRegression failed: ${(e as Error).message}`);
            }
        }
    }

    // ---- Phase 5 ---------------------------------------------------------
    const phase5: Phase5Findings = { security: [], barcodes: [] };
    if (checks) {
        if (checks.security) {
            try {
                const inv = await readSecurityInventory(opts.pdfPath);
                phase5.security = validateSecurity(inv, checks.security);
            } catch (e) {
                coreResult.warnings.push(`checks.security failed: ${(e as Error).message}`);
            }
        }
        if (checks.barcodes) {
            try {
                phase5.barcodes = await validateBarcodes(opts.pdfPath, checks.barcodes);
            } catch (e) {
                coreResult.warnings.push(`checks.barcodes failed: ${(e as Error).message}`);
            }
        }
    }

    // ---- Phase 6 ---------------------------------------------------------
    const phase6: Phase6Findings = { versionDiff: [] };
    if (checks?.versionDiff) {
        try {
            phase6.versionDiff = await validateVersionDiff(opts.pdfPath, checks.versionDiff);
        } catch (e) {
            coreResult.warnings.push(`checks.versionDiff failed: ${(e as Error).message}`);
        }
    }

    // Any phase-1..6 finding fails the run (opt-in — none declared, none run).
    const phase1FailCount =
        phase1.metadata.length +
        phase1.links.length +
        phase1.headerFooter.length +
        phase1.watermarks.length +
        phase1.layout.length +
        phase1.integrity.length +
        phase1.textQuality.length;
    const phase3FailCount =
        phase3.structural.length +
        phase3.interactive.length +
        phase3.attachments.length +
        phase3.tableDepthFindings.length;
    const phase4FailCount =
        phase4.images.length +
        phase4.contrast.length +
        phase4.chartRegions.length +
        // Visual regression findings that are just "baseline updated" are informational,
        // not failures — filter them out of the pass/fail gate.
        phase4.visualRegression.filter((f) => f.kind !== 'BASELINE_UPDATED' && f.kind !== 'MISSING_BASELINE').length;
    const phase5FailCount = phase5.security.length + phase5.barcodes.length;
    const phase6FailCount = phase6.versionDiff.length;
    coreResult.phase1 = phase1;
    coreResult.phase3 = phase3;
    coreResult.phase4 = phase4;
    coreResult.phase5 = phase5;
    coreResult.phase6 = phase6;
    if (
        phase1FailCount > 0 ||
        phase3FailCount > 0 ||
        phase4FailCount > 0 ||
        phase5FailCount > 0 ||
        phase6FailCount > 0
    ) {
        coreResult.summary.passed = false;
    }
    return coreResult;
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
        // Presence-of-text fields auto-assert against `meansValue` (default "present")
        // when the consumer didn't provide an explicit expected. Rationale:
        // declaring `presenceOfText` IS the assertion — the consumer's intent is
        // "verify this exact string is rendered". They only need to override the
        // expected value when they want to check for the ELSE state (missing) or
        // a state marker with two categorical values (draft vs billed).
        const isPresenceField = !!fieldSpec.presenceOfText;
        let expectedRaw: string | null;
        if (hasExpected) {
            expectedRaw = String(expectedValues[name] ?? '');
        } else if (isPresenceField) {
            expectedRaw = fieldSpec.meansValue ?? 'present';
        } else {
            expectedRaw = null;
        }
        let extracted: string | null;
        let reason: string | undefined;
        let extractedItems: ReturnType<typeof extractField>['items'] = undefined;
        if (isPresenceField) {
            extracted = detectPresence(tokensByPage, fieldSpec);
        } else {
            const res = extractField(tokensByPage, fieldSpec);
            extracted = res.value;
            reason = res.reason;
            extractedItems = res.items;
        }
        // Run per-field formatting rules if declared. Formatting failures land on
        // the finding object regardless of whether the value itself matched — a
        // wrong-typography-but-correct-value case is still worth surfacing.
        let formattingFindings: FormattingFinding[] | undefined;
        if (!isPresenceField && fieldSpec.formatting && extracted !== null && extractedItems && extractedItems.length > 0) {
            formattingFindings = validateFormatting(name, extracted, extractedItems, fieldSpec.formatting);
            if (formattingFindings.length === 0) formattingFindings = undefined;
        }
        // Presence-fields with implicit expected are now always asserted (never informational).
        if (expectedRaw === null) {
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
            formattingFindings,
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
    // Format-drift findings gate pass/fail: an "extractionally correct" value
    // rendered in the wrong font/color/alignment is still a real drift the
    // consumer opted into by declaring the rule.
    const formattingDriftCount = fields.reduce(
        (n, f) => n + (f.formattingFindings ? f.formattingFindings.length : 0),
        0,
    );
    const passed =
        fieldMismatches === 0 &&
        fieldMissing === 0 &&
        tableMismatches === 0 &&
        tableMissing === 0 &&
        formattingDriftCount === 0;
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
            formattingDriftCount,
            passed,
        },
        fields,
        tables,
        warnings,
        // Phase-1 findings default empty; the async wrapper (`validatePdfAgainstSpec`)
        // populates them when the spec declares corresponding check blocks.
        phase1: {
            metadata: [],
            links: [],
            headerFooter: [],
            watermarks: [],
            layout: [],
            integrity: [],
            textQuality: [],
        },
        phase3: {
            structural: [],
            interactive: [],
            attachments: [],
            tableDepth: {},
            tableDepthFindings: [],
        },
        phase4: { images: [], contrast: [], chartRegions: [], visualRegression: [] },
        phase5: { security: [], barcodes: [] },
        phase6: { versionDiff: [] },
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
