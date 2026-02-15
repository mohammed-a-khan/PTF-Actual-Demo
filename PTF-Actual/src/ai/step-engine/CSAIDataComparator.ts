/**
 * CSAIDataComparator - Generic comparison engine utility class
 *
 * Provides static methods for comparing objects, arrays, and individual values
 * with support for field mappings, tolerances, transforms, and flexible
 * column name resolution via CSAIColumnNormalizer.
 *
 * Supports loading comparison configuration from YAML, JSON, and Excel files.
 *
 * @module ai/step-engine
 */

import { CSAIColumnNormalizer } from './CSAIColumnNormalizer';

// ============================================================================
// INTERFACES
// ============================================================================

/** Describes how a single field maps from source to target */
export interface ComparisonMapping {
    /** Source field name (looked up in the source object) */
    source: string;
    /** Target field name (looked up in the target object). Defaults to same as source. */
    target?: string;
    /** Transform to apply before comparison */
    transform?: 'none' | 'trim' | 'lowercase' | 'uppercase' | 'splitSort' | 'formatDate' | 'formatNumber' | 'round';
    /** Argument for the transform (e.g., date format, decimal places) */
    transformArg?: string;
}

/** Configuration that controls comparison behavior */
export interface ComparisonConfig {
    /** Explicit field-to-field mappings with optional transforms */
    mappings?: ComparisonMapping[];
    /** Numeric tolerance for floating-point comparisons */
    tolerance?: number;
    /** Fields whose comma-separated values should be compared order-independently */
    orderIndependentFields?: string[];
    /** Fields to exclude from comparison entirely */
    ignoreFields?: string[];
    /** Key fields used to match rows when comparing arrays */
    keyFields?: string[];
    /** How to handle fields present in source but missing in target */
    missingFieldStrategy?: 'fail' | 'skip' | 'warn';
}

/** Result of a comparison operation */
export interface ComparisonResult {
    /** Whether the comparison passed (no mismatches) */
    passed: boolean;
    /** Total number of fields evaluated */
    totalFields: number;
    /** Number of fields that matched */
    matchedFields: number;
    /** Details of each mismatched field */
    mismatches: Array<{ field: string; expected: any; actual: any; reason: string }>;
    /** Human-readable summary of the result */
    summary: string;
}

// ============================================================================
// COMPARATOR CLASS
// ============================================================================

export class CSAIDataComparator {

    /**
     * Compare two objects field-by-field.
     *
     * When mappings are provided, only mapped fields are compared.
     * Otherwise, all source keys are iterated and matched against target keys
     * using CSAIColumnNormalizer for flexible name resolution.
     *
     * @param source - The expected/reference object
     * @param target - The actual object to compare against
     * @param config - Optional comparison configuration
     * @returns ComparisonResult with pass/fail, field counts, and mismatches
     */
    static compareObjects(
        source: Record<string, any>,
        target: Record<string, any>,
        config?: ComparisonConfig
    ): ComparisonResult {
        const mismatches: ComparisonResult['mismatches'] = [];
        const tolerance = config?.tolerance;
        const ignoreSet = new Set((config?.ignoreFields || []).map(f => CSAIColumnNormalizer.normalize(f)));
        const orderIndependentSet = new Set((config?.orderIndependentFields || []).map(f => CSAIColumnNormalizer.normalize(f)));
        const missingStrategy = config?.missingFieldStrategy || 'fail';

        let totalFields = 0;
        let matchedFields = 0;

        // Determine the field pairs to compare
        const fieldPairs: Array<{ sourceField: string; targetField: string; transform?: string; transformArg?: string }> = [];

        if (config?.mappings && config.mappings.length > 0) {
            // Use explicit mappings
            for (const mapping of config.mappings) {
                fieldPairs.push({
                    sourceField: mapping.source,
                    targetField: mapping.target || mapping.source,
                    transform: mapping.transform || 'none',
                    transformArg: mapping.transformArg
                });
            }
        } else {
            // Iterate all source keys
            for (const key of Object.keys(source)) {
                fieldPairs.push({ sourceField: key, targetField: key });
            }
        }

        for (const pair of fieldPairs) {
            const normalizedField = CSAIColumnNormalizer.normalize(pair.sourceField);

            // Skip ignored fields
            if (ignoreSet.has(normalizedField)) continue;

            totalFields++;

            // Resolve source value
            const sourceValue = CSAIColumnNormalizer.getField(source, pair.sourceField);

            // Resolve target value
            const targetValue = CSAIColumnNormalizer.getField(target, pair.targetField);

            // Handle missing target field
            if (targetValue === undefined && !CSAIColumnNormalizer.hasField(target, pair.targetField)) {
                if (missingStrategy === 'skip') {
                    totalFields--;
                    continue;
                }
                if (missingStrategy === 'warn') {
                    mismatches.push({
                        field: pair.sourceField,
                        expected: sourceValue,
                        actual: undefined,
                        reason: `Field "${pair.targetField}" not found in target (available: ${CSAIColumnNormalizer.getAvailableColumns(target).join(', ')})`
                    });
                    continue;
                }
                // 'fail' strategy
                mismatches.push({
                    field: pair.sourceField,
                    expected: sourceValue,
                    actual: undefined,
                    reason: `Field "${pair.targetField}" not found in target (available: ${CSAIColumnNormalizer.getAvailableColumns(target).join(', ')})`
                });
                continue;
            }

            // Determine transform: explicit from mapping, or order-independent
            let transform = pair.transform || 'none';
            let transformArg = pair.transformArg;
            if (orderIndependentSet.has(normalizedField) && transform === 'none') {
                transform = 'splitSort';
            }

            // Compare values
            const result = CSAIDataComparator.compareValues(sourceValue, targetValue, {
                tolerance,
                transform,
                transformArg
            });

            if (result.match) {
                matchedFields++;
            } else {
                mismatches.push({
                    field: pair.sourceField,
                    expected: sourceValue,
                    actual: targetValue,
                    reason: result.reason || 'Values do not match'
                });
            }
        }

        const passed = mismatches.length === 0;
        const summary = passed
            ? `All ${totalFields} field(s) matched.`
            : `${mismatches.length} of ${totalFields} field(s) mismatched: ${mismatches.map(m => m.field).join(', ')}`;

        return { passed, totalFields, matchedFields, mismatches, summary };
    }

    /**
     * Compare two arrays of objects row-by-row.
     *
     * When keyFields are provided, rows are matched by key field values.
     * Otherwise, rows are matched by array index.
     *
     * @param sourceRows - The expected/reference array
     * @param targetRows - The actual array to compare against
     * @param config - Optional comparison configuration
     * @returns ComparisonResult aggregated across all rows
     */
    static compareArrays(
        sourceRows: Record<string, any>[],
        targetRows: Record<string, any>[],
        config?: ComparisonConfig
    ): ComparisonResult {
        const allMismatches: ComparisonResult['mismatches'] = [];
        let totalFields = 0;
        let matchedFields = 0;

        // Check row count
        if (sourceRows.length !== targetRows.length) {
            return {
                passed: false,
                totalFields: 0,
                matchedFields: 0,
                mismatches: [{
                    field: '__rowCount__',
                    expected: sourceRows.length,
                    actual: targetRows.length,
                    reason: `Row count mismatch: expected ${sourceRows.length}, got ${targetRows.length}`
                }],
                summary: `Row count mismatch: expected ${sourceRows.length}, got ${targetRows.length}`
            };
        }

        if (sourceRows.length === 0) {
            return { passed: true, totalFields: 0, matchedFields: 0, mismatches: [], summary: 'Both arrays are empty.' };
        }

        const keyFields = config?.keyFields;

        if (keyFields && keyFields.length > 0) {
            // Match rows by key fields
            const targetIndex = CSAIDataComparator.buildRowIndex(targetRows, keyFields);

            for (let i = 0; i < sourceRows.length; i++) {
                const sourceRow = sourceRows[i];
                const keyValue = CSAIDataComparator.getCompositeKey(sourceRow, keyFields);
                const targetRow = targetIndex.get(keyValue);

                if (!targetRow) {
                    allMismatches.push({
                        field: `row[${i}]`,
                        expected: keyValue,
                        actual: undefined,
                        reason: `No matching target row found for key "${keyValue}"`
                    });
                    totalFields++;
                    continue;
                }

                const rowResult = CSAIDataComparator.compareObjects(sourceRow, targetRow, config);
                totalFields += rowResult.totalFields;
                matchedFields += rowResult.matchedFields;

                for (const mismatch of rowResult.mismatches) {
                    allMismatches.push({
                        field: `row[key=${keyValue}].${mismatch.field}`,
                        expected: mismatch.expected,
                        actual: mismatch.actual,
                        reason: mismatch.reason
                    });
                }
            }
        } else {
            // Match rows by array index
            for (let i = 0; i < sourceRows.length; i++) {
                const rowResult = CSAIDataComparator.compareObjects(sourceRows[i], targetRows[i], config);
                totalFields += rowResult.totalFields;
                matchedFields += rowResult.matchedFields;

                for (const mismatch of rowResult.mismatches) {
                    allMismatches.push({
                        field: `row[${i}].${mismatch.field}`,
                        expected: mismatch.expected,
                        actual: mismatch.actual,
                        reason: mismatch.reason
                    });
                }
            }
        }

        const passed = allMismatches.length === 0;
        const summary = passed
            ? `All ${sourceRows.length} row(s), ${totalFields} field(s) matched.`
            : `${allMismatches.length} mismatch(es) across ${sourceRows.length} row(s): ${allMismatches.map(m => m.field).join(', ')}`;

        return { passed, totalFields, matchedFields, mismatches: allMismatches, summary };
    }

    /**
     * Compare two individual values with optional tolerance and transform.
     *
     * @param actual - The actual value
     * @param expected - The expected value
     * @param options - Optional tolerance, transform, and transformArg
     * @returns Object with match boolean and optional reason string
     */
    static compareValues(
        actual: any,
        expected: any,
        options?: { tolerance?: number; transform?: string; transformArg?: string }
    ): { match: boolean; reason?: string } {
        const transform = options?.transform || 'none';
        const transformArg = options?.transformArg;

        // Apply transform to both values
        let transformedActual = CSAIDataComparator.applyTransform(actual, transform, transformArg);
        let transformedExpected = CSAIDataComparator.applyTransform(expected, transform, transformArg);

        // Handle null/undefined equality
        if (transformedActual == null && transformedExpected == null) {
            return { match: true };
        }
        if (transformedActual == null || transformedExpected == null) {
            return {
                match: false,
                reason: `One value is null/undefined: expected="${transformedExpected}", actual="${transformedActual}"`
            };
        }

        // Numeric comparison with tolerance
        const tolerance = options?.tolerance;
        if (tolerance !== undefined && tolerance > 0) {
            const numActual = parseFloat(String(transformedActual));
            const numExpected = parseFloat(String(transformedExpected));
            if (!isNaN(numActual) && !isNaN(numExpected)) {
                const diff = Math.abs(numActual - numExpected);
                if (diff <= tolerance) {
                    return { match: true };
                }
                return {
                    match: false,
                    reason: `Numeric difference ${diff} exceeds tolerance ${tolerance} (expected=${numExpected}, actual=${numActual})`
                };
            }
        }

        // String comparison (coerce to string)
        const strActual = String(transformedActual);
        const strExpected = String(transformedExpected);

        if (strActual === strExpected) {
            return { match: true };
        }

        // Try numeric comparison even without tolerance (handles "100.00" vs "100")
        const numA = parseFloat(strActual);
        const numE = parseFloat(strExpected);
        if (!isNaN(numA) && !isNaN(numE) && numA === numE) {
            return { match: true };
        }

        return {
            match: false,
            reason: `Expected "${strExpected}", got "${strActual}"`
        };
    }

    /**
     * Apply a named transform to a value.
     *
     * Supported transforms:
     * - none: return as-is
     * - trim: trim whitespace
     * - lowercase: convert to lowercase
     * - uppercase: convert to uppercase
     * - splitSort: split by comma, sort, rejoin (order-independent comparison)
     * - formatDate: format a date value using transformArg as format pattern
     * - formatNumber: format a number with fixed decimals (transformArg = decimal places)
     * - round: round to N decimal places (transformArg = decimal places, default 2)
     *
     * @param value - The value to transform
     * @param transform - Transform name
     * @param arg - Optional argument for the transform
     * @returns Transformed value
     */
    static applyTransform(value: any, transform: string, arg?: string): any {
        if (value == null) return value;

        switch (transform) {
            case 'none':
                return value;

            case 'trim':
                return String(value).trim();

            case 'lowercase':
                return String(value).toLowerCase();

            case 'uppercase':
                return String(value).toUpperCase();

            case 'splitSort': {
                const delimiter = arg || ',';
                const parts = String(value)
                    .split(delimiter)
                    .map(s => s.trim())
                    .filter(s => s.length > 0)
                    .sort();
                return parts.join(delimiter);
            }

            case 'formatDate': {
                const dateVal = new Date(value);
                if (isNaN(dateVal.getTime())) return String(value);
                const format = arg || 'YYYY-MM-DD';
                const yyyy = String(dateVal.getFullYear());
                const mm = String(dateVal.getMonth() + 1).padStart(2, '0');
                const dd = String(dateVal.getDate()).padStart(2, '0');
                return format
                    .replace('YYYY', yyyy)
                    .replace('MM', mm)
                    .replace('DD', dd);
            }

            case 'formatNumber': {
                const num = parseFloat(String(value));
                if (isNaN(num)) return String(value);
                const decimals = arg ? parseInt(arg) : 2;
                return num.toFixed(decimals);
            }

            case 'round': {
                const numVal = parseFloat(String(value));
                if (isNaN(numVal)) return String(value);
                const places = arg ? parseInt(arg) : 2;
                const factor = Math.pow(10, places);
                return String(Math.round(numVal * factor) / factor);
            }

            default:
                return value;
        }
    }

    /**
     * Load a comparison configuration from a YAML, JSON, or Excel file.
     *
     * - .yml/.yaml files are parsed with js-yaml (lazy require)
     * - .json files are parsed with JSON.parse
     * - .xlsx/.xls files are parsed with xlsx (lazy require), reading the specified sheet
     *
     * Expected structure (YAML/JSON):
     * ```yaml
     * tolerance: 0.01
     * ignoreFields: ["timestamp", "id"]
     * keyFields: ["code"]
     * orderIndependentFields: ["tags"]
     * missingFieldStrategy: "skip"
     * mappings:
     *   - source: "OrderStatus"
     *     target: "status"
     *     transform: "lowercase"
     * ```
     *
     * For Excel: each row represents a mapping. Column headers should include
     * "source", "target", "transform", "transformArg".
     *
     * @param filePath - Path to the configuration file
     * @param sheetName - Sheet name for Excel files (default: first sheet)
     * @returns Parsed ComparisonConfig
     */
    static async loadMappingConfig(filePath: string, sheetName?: string): Promise<ComparisonConfig> {
        const fs = await import('fs');
        const path = await import('path');
        const ext = path.extname(filePath).toLowerCase();

        if (ext === '.json') {
            const content = fs.readFileSync(filePath, 'utf-8');
            return CSAIDataComparator.parseConfigObject(JSON.parse(content));
        }

        if (ext === '.yml' || ext === '.yaml') {
            // Lazy require js-yaml
            let yaml: any;
            try {
                yaml = require('js-yaml');
            } catch {
                throw new Error('js-yaml is required to load YAML mapping files. Install with: npm install js-yaml');
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            const parsed = yaml.load(content);
            return CSAIDataComparator.parseConfigObject(parsed);
        }

        if (ext === '.xlsx' || ext === '.xls') {
            // Lazy require xlsx
            let XLSX: any;
            try {
                XLSX = require('xlsx');
            } catch {
                throw new Error('xlsx is required to load Excel mapping files. Install with: npm install xlsx');
            }
            const workbook = XLSX.readFile(filePath);
            const targetSheet = sheetName || workbook.SheetNames[0];
            const sheet = workbook.Sheets[targetSheet];
            if (!sheet) {
                throw new Error(`Sheet "${targetSheet}" not found in "${filePath}". Available: ${workbook.SheetNames.join(', ')}`);
            }
            const rows: Record<string, any>[] = XLSX.utils.sheet_to_json(sheet);
            const mappings: ComparisonMapping[] = rows.map((row: Record<string, any>) => ({
                source: String(CSAIColumnNormalizer.getField(row, 'source') || ''),
                target: CSAIColumnNormalizer.getField(row, 'target') ? String(CSAIColumnNormalizer.getField(row, 'target')) : undefined,
                transform: CSAIColumnNormalizer.getField(row, 'transform') as ComparisonMapping['transform'] || undefined,
                transformArg: CSAIColumnNormalizer.getField(row, 'transformArg') ? String(CSAIColumnNormalizer.getField(row, 'transformArg')) : undefined
            }));
            return { mappings };
        }

        throw new Error(`Unsupported mapping file extension "${ext}". Supported: .json, .yml, .yaml, .xlsx, .xls`);
    }

    // ========================================================================
    // PRIVATE HELPERS
    // ========================================================================

    /**
     * Parse a raw config object into a ComparisonConfig with type safety.
     */
    private static parseConfigObject(raw: any): ComparisonConfig {
        if (!raw || typeof raw !== 'object') return {};

        const config: ComparisonConfig = {};

        if (typeof raw.tolerance === 'number') config.tolerance = raw.tolerance;
        if (Array.isArray(raw.ignoreFields)) config.ignoreFields = raw.ignoreFields.map(String);
        if (Array.isArray(raw.keyFields)) config.keyFields = raw.keyFields.map(String);
        if (Array.isArray(raw.orderIndependentFields)) config.orderIndependentFields = raw.orderIndependentFields.map(String);
        if (['fail', 'skip', 'warn'].includes(raw.missingFieldStrategy)) config.missingFieldStrategy = raw.missingFieldStrategy;

        if (Array.isArray(raw.mappings)) {
            config.mappings = raw.mappings.map((m: any) => ({
                source: String(m.source || ''),
                target: m.target ? String(m.target) : undefined,
                transform: m.transform || undefined,
                transformArg: m.transformArg ? String(m.transformArg) : undefined
            }));
        }

        return config;
    }

    /**
     * Build a lookup index from target rows using composite key fields.
     */
    private static buildRowIndex(
        rows: Record<string, any>[],
        keyFields: string[]
    ): Map<string, Record<string, any>> {
        const index = new Map<string, Record<string, any>>();
        for (const row of rows) {
            const key = CSAIDataComparator.getCompositeKey(row, keyFields);
            index.set(key, row);
        }
        return index;
    }

    /**
     * Build a composite key string from a row using the given key fields.
     */
    private static getCompositeKey(row: Record<string, any>, keyFields: string[]): string {
        return keyFields
            .map(field => {
                const value = CSAIColumnNormalizer.getField(row, field);
                return value != null ? String(value) : '';
            })
            .join('|');
    }
}
