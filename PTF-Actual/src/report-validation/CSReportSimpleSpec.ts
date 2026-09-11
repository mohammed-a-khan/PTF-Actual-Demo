/**
 * Simple PDF-validation spec — the everyday shape.
 *
 * The full ReportSpec (CSReportSpec.ts) is designed for cross-source
 * reconciliation (Crystal ↔ SSRS ↔ DB) with rich tolerance, coverage and
 * field-map machinery. Consumers who only want to assert "the invoice number,
 * billing date and total in this PDF match my expected values" don't need any
 * of that. This spec is the small, first-class alternative — two keys, done.
 *
 * @module report-validation/CSReportSimpleSpec
 */

import * as fs from 'fs';
import * as path from 'path';

export type SimpleFieldKind = 'string' | 'number' | 'date' | 'currency';

/**
 * Where to read a field's value relative to its label token. If omitted,
 * the framework auto-detects — tries `below`, then `right`, then `inline`,
 * and picks the first that returns a value. Set explicitly only when
 * auto-detect picks wrong.
 * - `below`     → same x (± xTolerance), next token(s) at a smaller y
 * - `belowLine` → the entire next line below the anchor (any x); use `belowLineOffset` to skip N lines
 * - `right`     → same y (± yTolerance), next token(s) at a larger x
 * - `leftOf`    → same y (± yTolerance), token(s) to the LEFT of the anchor
 * - `inline`    → the value is embedded in the same token as the label, separated by `inlineSeparator`
 */
export type SimpleReadFrom = 'below' | 'belowLine' | 'right' | 'leftOf' | 'inline';

/**
 * Optional per-field formatting-rule declarations. Every rule is asserted
 * against the TextItem[] that produced the field's value — bold/italic/font
 * size come from `TextItem.fontName` and `TextItem.fontSize`; alignment is
 * inferred from item x-position within the field's own value span (or,
 * when a `columnBand` is available on a table field, relative to that band).
 * Every rule is OPTIONAL; a field with no `formatting:` block skips all
 * formatting checks.
 */
export interface SimpleFormattingRule {
    /** Every TextItem in the value must be a bold-font variant (matches /bold|black|heavy/i in fontName). */
    bold?: boolean;
    /** Every TextItem must be italic (matches /italic|oblique/i in fontName). */
    italic?: boolean;
    /** Font size band (in PDF points). All items must fall within [min, max] inclusive. `exact` overrides both. */
    fontSize?: { min?: number; max?: number; exact?: number };
    /**
     * Casing rule on the raw string value:
     *   - `upper`  → every alpha char is uppercase
     *   - `lower`  → every alpha char is lowercase
     *   - `title`  → first letter of each word is uppercase, rest lowercase
     */
    casing?: 'upper' | 'lower' | 'title';
    /**
     * Required currency-prefix on the raw value (e.g. `$`, `USD $`, `£`). Case-sensitive.
     * Whitespace between prefix and value is tolerated.
     */
    currencyPrefix?: string;
    /**
     * When true, negative numeric values MUST use accounting-paren wrap `(1,234.56)`
     * rather than leading-minus `-1234.56`. When false (default), either is accepted.
     */
    parenNegative?: boolean;
    /**
     * Text alignment. `left` → items' left edge sits at or near the leftmost point of the
     * anchor's x-span; `right` → items' right edge sits at or near the rightmost point;
     * `center` → item midpoint sits near anchor midpoint. Tolerance ±`alignmentTolerance`.
     */
    alignment?: 'left' | 'right' | 'center';
    /** Alignment tolerance in PDF points. Default 4. */
    alignmentTolerance?: number;
}

export interface SimpleFieldSpec {
    /** Anchor text in the PDF. Case-insensitive substring match. Required unless `presenceOfText` is set. */
    label?: string;
    /**
     * How to read the value relative to the label. If omitted, the framework
     * auto-detects by trying below → right → inline in order. Override only
     * when auto picks wrong or for `leftOf` (payer-block style layouts).
     */
    readFrom?: SimpleReadFrom;
    /** For `inline` mode: the separator string between label and value. Default: `: ` */
    inlineSeparator?: string;
    /** Type-aware normalization. Default: 'string'. */
    kind?: SimpleFieldKind;
    /** X-alignment tolerance (px) for `below` reads. Default: 25 */
    xTolerance?: number;
    /** Y-alignment tolerance (px) for `right`/`leftOf` reads. Default: 4 (right), 8 (leftOf) */
    yTolerance?: number;
    /** Max vertical distance (px) below the anchor to look for the value. Default: 30 */
    belowMaxDrop?: number;
    /** Max horizontal distance (px) right of the anchor to look for the value. Default: unbounded */
    rightMaxSpan?: number;
    /** For `belowLine` mode: number of lines to skip before reading. Default: 1 (immediately next line). */
    belowLineOffset?: number;
    // ---- Alternative: presence-of-text categorical state marker -------------
    /**
     * Text that, if present anywhere in the PDF, makes this field's value = `meansValue`.
     * Use ONLY for categorical state markers (e.g. draft banner presence, brand detection).
     * For any per-invoice value the consumer might source from UI/DB/JSON, declare a `label`
     * so the value is EXTRACTED and can be compared against the consumer's expected value.
     */
    presenceOfText?: string;
    /** Value when `presenceOfText` matched. Default: 'present'. */
    meansValue?: string;
    /** Value when `presenceOfText` did NOT match. Default: 'missing'. */
    elseValue?: string;
    // ---- Optional formatting-rule declarations ------------------------------
    /**
     * Per-field formatting assertions (bold/italic/font-size/alignment/currency
     * prefix/paren-negative/casing). Applied ONLY to extraction fields (skipped
     * for presence-only fields). No formatting block = no formatting checks.
     */
    formatting?: SimpleFormattingRule;
}

export interface SimpleTableColumnSpec {
    /** Consumer-facing key (matches expected-value JSON). */
    key: string;
    /**
     * PDF header text for this column. Omit for a column that has no header
     * (e.g. an amount column right of the last named header).
     */
    header?: string;
}

export interface SimpleTableSpec {
    /** Anchor text that locates the table's section header. */
    headerAnchor: string;
    /** Column definitions in x-order (leftmost first). */
    columns: SimpleTableColumnSpec[];
    /** Column keys that uniquely identify a row (for key-based row matching). */
    keyColumns?: string[];
    /** Text that, when found, stops row reading (e.g. "Total Amount Due:"). */
    stopAt?: string;
    /** Row-alignment tolerance (px). Two tokens with |Δy| ≤ this are on the same row. Default: 4 */
    rowYTolerance?: number;
}

/**
 * Optional Phase-1 check blocks. Each is opt-in — declaring `checks.metadata`
 * triggers the metadata validator, `checks.links` triggers the link validator,
 * etc. Absent blocks skip the corresponding check. All findings roll into the
 * top-level ValidationResult under `phase1Findings`.
 */
export interface SimpleReportSpecChecks {
    /** PDF Info dict + XMP metadata rules (§5). */
    metadata?: import('./checks/CSPdfMetadataValidator').MetadataRule;
    /** Link annotation rules — URI presence, mailto syntax, dead-link scan (§14). */
    links?: import('./checks/CSPdfLinkValidator').LinkRule;
    /** Header/footer consistency + placeholder-leak scan (§17). */
    headerFooter?: import('./checks/CSPdfHeaderFooterValidator').HeaderFooterRule;
    /** Watermark presence/absence rules (§15). */
    watermarks?: import('./checks/CSPdfWatermarkValidator').WatermarkRule[];
    /** Page-count + orientation + size + blank-page detection (§2). */
    layout?: import('./checks/CSPdfLayoutValidator').LayoutRule;
    /** File SHA-256, TOC↔section count, attachment inventory (§20). */
    integrity?: import('./checks/CSPdfIntegrityValidator').IntegrityRule;
    /** Placeholder-leak, encoding, PII regex scans (§23). */
    textQuality?: import('./checks/CSPdfTextQualityValidator').TextQualityRule;
    // ---- Phase 3 ---------------------------------------------------------
    /** Bookmarks / outlines / OCG layers / page labels / annotation inventory (§4). */
    structural?: import('./checks/CSPdfStructuralValidator').StructuralRule;
    /** AcroForm widgets + JS action allow/deny (§13). */
    interactive?: import('./checks/CSPdfInteractiveValidator').InteractiveRule;
    /** Embedded-file inventory + mime allow-list + XML well-formed (§9 / §16). */
    attachments?: import('./checks/CSPdfAttachmentValidator').AttachmentRule;
    /**
     * Table-depth analyses, keyed by table name (must match a table declared
     * in `tables`). Adds merged-row / arity / accuracy checks on top of the
     * existing table extractor.
     */
    tableDepth?: Record<string, import('./checks/CSPdfTableDepthValidator').TableDepthRule>;
    // ---- Phase 4 ---------------------------------------------------------
    /** Image XObject inventory + resolution + colorSpace allow-list. */
    images?: import('./checks/CSPdfImageInventoryValidator').ImageRule;
    /** WCAG text-contrast checks. */
    contrast?: import('./checks/CSPdfContrastValidator').ContrastRule;
    /** Chart-region assertions (count, area, text-overlap). */
    chartRegions?: import('./checks/CSPdfChartRegionValidator').ChartRegionRule;
    /** Rasterize + pixel-diff pages against a persisted baseline. Requires optional deps. */
    visualRegression?: import('./checks/CSPdfVisualRegressionValidator').VisualRegressionRule;
    // ---- Phase 5 ---------------------------------------------------------
    /** Encryption / permissions / digital-signature / redaction assertions. */
    security?: import('./checks/CSPdfSecurityValidator').SecurityRule;
    /** Decode + assert 1D/2D barcodes visible on pages. Requires optional deps. */
    barcodes?: import('./checks/CSPdfBarcodeValidator').BarcodeRule;
    // ---- Phase 6 ---------------------------------------------------------
    /** Diff this PDF against a baseline PDF, either textually or by structural counters. */
    versionDiff?: import('./checks/CSPdfVersionDiffValidator').VersionDiffRule;
}

/** The simple validation spec — flat, two-key. */
export interface SimpleReportSpec {
    /** Spec name — matches the filename (without .json) when loaded from disk. */
    name: string;
    /** Optional human description. */
    description?: string;
    /** Scalar fields to extract + assert. Keys are consumer-facing names. */
    fields?: Record<string, SimpleFieldSpec>;
    /** Line-item tables to extract + assert. Keys are consumer-facing table names. */
    tables?: Record<string, SimpleTableSpec>;
    /** Optional Phase-1 checks — metadata / links / header-footer / watermarks / layout / integrity / text-quality. */
    checks?: SimpleReportSpecChecks;
}

/**
 * Locate + load a SimpleReportSpec JSON file.
 *
 * Resolution order:
 *   1. If `specName` is an absolute path or contains `.json` — load it directly.
 *   2. If `specName` contains a path separator (`/` or `\`) — treat as
 *      `<dir>/<specName>.json` (backward-compatible path form).
 *   3. Otherwise walk `dir` RECURSIVELY and return the first spec file where
 *      EITHER the filename (minus `.json`) matches `specName` OR the file's
 *      `name` field matches `specName`. Consumers can drop specs into any
 *      subfolder layout — the loader finds them by name.
 *
 * Bare-name lookups error with a helpful list of every spec discovered under
 * `dir`, so a typo produces "spec 'invoic-standard' not found; available:
 * invoice-standard, invoice-mhfa, ..." rather than a raw file-not-found.
 */
export function loadSimpleReportSpec(specName: string, dir: string): SimpleReportSpec {
    let filePath: string;
    if (path.isAbsolute(specName)) {
        filePath = specName;
    } else if (specName.endsWith('.json') || specName.includes('/') || specName.includes('\\')) {
        filePath = path.join(dir, specName.endsWith('.json') ? specName : `${specName}.json`);
    } else {
        const found = findSpecByName(dir, specName);
        if (!found) {
            const available = listSpecNames(dir).sort();
            throw new Error(
                `SimpleReportSpec "${specName}" not found under ${dir}` +
                    (available.length ? `\n  available: ${available.join(', ')}` : ' (no *.json files present)'),
            );
        }
        filePath = found;
    }
    if (!fs.existsSync(filePath)) {
        throw new Error(`SimpleReportSpec not found: ${filePath}`);
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        throw new Error(`SimpleReportSpec ${filePath} is not valid JSON: ${(e as Error).message}`);
    }
    const errors = validateSimpleReportSpecShape(parsed);
    if (errors.length > 0) {
        throw new Error(`SimpleReportSpec ${filePath} is malformed:\n  - ${errors.join('\n  - ')}`);
    }
    return parsed as SimpleReportSpec;
}

/**
 * Recursively walk `root` for `*.json` files and return the first match on either:
 *   - filename basename (minus `.json`) equal to `specName`, OR
 *   - parsed `name` field equal to `specName`.
 * Returns null if nothing matches. Silently skips unreadable / malformed files
 * during the walk so one bad file doesn't hide a good sibling.
 */
function findSpecByName(root: string, specName: string): string | null {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return null;
    const stack: string[] = [root];
    while (stack.length > 0) {
        const dir = stack.pop() as string;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                stack.push(full);
                continue;
            }
            if (!e.isFile() || !e.name.endsWith('.json')) continue;
            const base = e.name.substring(0, e.name.length - '.json'.length);
            if (base === specName) return full;
            try {
                const parsed = JSON.parse(fs.readFileSync(full, 'utf-8'));
                if (parsed && typeof parsed === 'object' && parsed.name === specName) return full;
            } catch {
                // ignore malformed sibling
            }
        }
    }
    return null;
}

/** For error messages: list every discoverable spec name under `root`. */
function listSpecNames(root: string): string[] {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
    const names: string[] = [];
    const stack: string[] = [root];
    while (stack.length > 0) {
        const dir = stack.pop() as string;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) stack.push(full);
            else if (e.isFile() && e.name.endsWith('.json')) {
                const base = e.name.substring(0, e.name.length - '.json'.length);
                let name = base;
                try {
                    const parsed = JSON.parse(fs.readFileSync(full, 'utf-8'));
                    if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string') {
                        name = parsed.name;
                    }
                } catch {
                    // fall back to filename base
                }
                names.push(name);
            }
        }
    }
    return names;
}

/** Structural validation. Returns a list of problems (empty = valid). */
export function validateSimpleReportSpecShape(obj: unknown): string[] {
    const errors: string[] = [];
    if (!obj || typeof obj !== 'object') {
        return ['spec is not an object'];
    }
    const spec = obj as Record<string, unknown>;
    if (typeof spec.name !== 'string' || spec.name.length === 0) {
        errors.push('name is required and must be a non-empty string');
    }
    if (spec.fields !== undefined) {
        if (typeof spec.fields !== 'object' || spec.fields === null || Array.isArray(spec.fields)) {
            errors.push('fields must be an object (keyed by field name)');
        } else {
            for (const [key, val] of Object.entries(spec.fields)) {
                const f = val as SimpleFieldSpec;
                if (!f || typeof f !== 'object') {
                    errors.push(`fields.${key} must be an object`);
                    continue;
                }
                const hasAnchor = typeof f.label === 'string' && f.label.length > 0;
                const hasPresence = typeof f.presenceOfText === 'string' && f.presenceOfText.length > 0;
                if (!hasAnchor && !hasPresence) {
                    errors.push(`fields.${key} requires either 'label' (for extraction) or 'presenceOfText' (for state markers)`);
                }
                if (hasPresence) {
                    if (f.meansValue !== undefined && typeof f.meansValue !== 'string') {
                        errors.push(`fields.${key}.meansValue must be a string when set`);
                    }
                    if (f.elseValue !== undefined && typeof f.elseValue !== 'string') {
                        errors.push(`fields.${key}.elseValue must be a string when set`);
                    }
                }
                if (f.readFrom !== undefined && !['below', 'belowLine', 'right', 'leftOf', 'inline'].includes(f.readFrom)) {
                    errors.push(`fields.${key}.readFrom must be one of below|belowLine|right|leftOf|inline`);
                }
                if (f.kind !== undefined && !['string', 'number', 'date', 'currency'].includes(f.kind)) {
                    errors.push(`fields.${key}.kind must be one of string|number|date|currency`);
                }
            }
        }
    }
    if (spec.tables !== undefined) {
        if (typeof spec.tables !== 'object' || spec.tables === null || Array.isArray(spec.tables)) {
            errors.push('tables must be an object (keyed by table name)');
        } else {
            for (const [key, val] of Object.entries(spec.tables)) {
                const t = val as SimpleTableSpec;
                if (!t || typeof t !== 'object') {
                    errors.push(`tables.${key} must be an object`);
                    continue;
                }
                if (typeof t.headerAnchor !== 'string' || t.headerAnchor.length === 0) {
                    errors.push(`tables.${key}.headerAnchor is required (non-empty string)`);
                }
                if (!Array.isArray(t.columns) || t.columns.length === 0) {
                    errors.push(`tables.${key}.columns is required (non-empty array)`);
                } else {
                    for (let i = 0; i < t.columns.length; i++) {
                        const c = t.columns[i];
                        if (!c || typeof c !== 'object' || typeof c.key !== 'string') {
                            errors.push(`tables.${key}.columns[${i}] must be an object with a 'key' string`);
                        }
                    }
                }
            }
        }
    }
    return errors;
}
