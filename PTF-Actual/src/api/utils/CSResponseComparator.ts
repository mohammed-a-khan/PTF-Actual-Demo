/**
 * Response Comparator
 * Deep JSON comparison utility for API responses
 * Supports ordered/unordered array comparison and detailed diff reporting
 *
 */

import { CSReporter } from '../../reporter/CSReporter';
import { CSResponse } from '../types/CSApiTypes';

export interface ComparisonOptions {
    /** Ignore array order when comparing */
    ignoreArrayOrder?: boolean;
    /** Ignore extra fields in actual response */
    ignoreExtraFields?: boolean;
    /** Fields to exclude from comparison */
    excludeFields?: string[];
    /** Decimal precision for number comparison */
    decimalPrecision?: number;
    /** Normalize strings (trim, case-insensitive) */
    normalizeStrings?: boolean;
    /** Ignore null vs undefined differences */
    ignoreNullUndefined?: boolean;
}

export interface ComparisonResult {
    isEqual: boolean;
    differences: Difference[];
    summary: string;
}

export interface Difference {
    path: string;
    type: 'missing' | 'extra' | 'type-mismatch' | 'value-mismatch' | 'array-length';
    expected?: any;
    actual?: any;
    message: string;
}

export class CSResponseComparator {
    private static instance: CSResponseComparator;

    private constructor() {}

    public static getInstance(): CSResponseComparator {
        if (!CSResponseComparator.instance) {
            CSResponseComparator.instance = new CSResponseComparator();
        }
        return CSResponseComparator.instance;
    }

    /**
     * Compare two responses
     */
    public compareResponses(
        expected: CSResponse,
        actual: CSResponse,
        options?: ComparisonOptions
    ): ComparisonResult {
        const differences: Difference[] = [];

        // Compare status codes
        if (expected.status !== actual.status) {
            differences.push({
                path: 'status',
                type: 'value-mismatch',
                expected: expected.status,
                actual: actual.status,
                message: `Status code mismatch: expected ${expected.status}, got ${actual.status}`
            });
        }

        // Compare headers if present
        if (expected.headers && actual.headers) {
            this.compareHeaders(expected.headers, actual.headers, differences, options);
        }

        // Compare bodies
        this.compareValues(expected.body, actual.body, 'body', differences, options || {});

        return {
            isEqual: differences.length === 0,
            differences,
            summary: this.generateSummary(differences)
        };
    }

    /**
     * Compare two JSON objects
     */
    public compareObjects(
        expected: any,
        actual: any,
        options?: ComparisonOptions
    ): ComparisonResult {
        const differences: Difference[] = [];
        this.compareValues(expected, actual, 'root', differences, options || {});

        return {
            isEqual: differences.length === 0,
            differences,
            summary: this.generateSummary(differences)
        };
    }

    /**
     * Deep compare two values
     */
    private compareValues(
        expected: any,
        actual: any,
        path: string,
        differences: Difference[],
        options: ComparisonOptions
    ): void {
        // Handle null/undefined
        if (this.isNullOrUndefined(expected) && this.isNullOrUndefined(actual)) {
            if (options.ignoreNullUndefined) {
                return;
            }
            if (expected !== actual) {
                differences.push({
                    path,
                    type: 'value-mismatch',
                    expected,
                    actual,
                    message: `${path}: null/undefined mismatch`
                });
            }
            return;
        }

        if (this.isNullOrUndefined(expected)) {
            differences.push({
                path,
                type: 'missing',
                expected,
                actual,
                message: `${path}: expected is null/undefined but actual has value`
            });
            return;
        }

        if (this.isNullOrUndefined(actual)) {
            differences.push({
                path,
                type: 'missing',
                expected,
                actual,
                message: `${path}: actual is null/undefined but expected has value`
            });
            return;
        }

        // Check if field should be excluded
        if (options.excludeFields && options.excludeFields.includes(path)) {
            return;
        }

        // Get types
        const expectedType = Array.isArray(expected) ? 'array' : typeof expected;
        const actualType = Array.isArray(actual) ? 'array' : typeof actual;

        // Type mismatch
        if (expectedType !== actualType) {
            differences.push({
                path,
                type: 'type-mismatch',
                expected: expectedType,
                actual: actualType,
                message: `${path}: type mismatch (expected ${expectedType}, got ${actualType})`
            });
            return;
        }

        // Compare based on type
        switch (expectedType) {
            case 'object':
                this.compareObjects_internal(expected, actual, path, differences, options);
                break;
            case 'array':
                this.compareArrays(expected, actual, path, differences, options);
                break;
            case 'number':
                this.compareNumbers(expected, actual, path, differences, options);
                break;
            case 'string':
                this.compareStrings(expected, actual, path, differences, options);
                break;
            default:
                // Primitive comparison
                if (expected !== actual) {
                    differences.push({
                        path,
                        type: 'value-mismatch',
                        expected,
                        actual,
                        message: `${path}: value mismatch (expected ${expected}, got ${actual})`
                    });
                }
        }
    }

    /**
     * Compare objects
     */
    private compareObjects_internal(
        expected: any,
        actual: any,
        path: string,
        differences: Difference[],
        options: ComparisonOptions
    ): void {
        const expectedKeys = Object.keys(expected);
        const actualKeys = Object.keys(actual);

        // Check for missing keys
        for (const key of expectedKeys) {
            if (!(key in actual)) {
                differences.push({
                    path: `${path}.${key}`,
                    type: 'missing',
                    expected: expected[key],
                    actual: undefined,
                    message: `${path}.${key}: missing in actual response`
                });
            }
        }

        // Check for extra keys
        if (!options.ignoreExtraFields) {
            for (const key of actualKeys) {
                if (!(key in expected)) {
                    differences.push({
                        path: `${path}.${key}`,
                        type: 'extra',
                        expected: undefined,
                        actual: actual[key],
                        message: `${path}.${key}: extra field in actual response`
                    });
                }
            }
        }

        // Compare common keys
        for (const key of expectedKeys) {
            if (key in actual) {
                this.compareValues(
                    expected[key],
                    actual[key],
                    `${path}.${key}`,
                    differences,
                    options
                );
            }
        }
    }

    /**
     * Compare arrays
     */
    private compareArrays(
        expected: any[],
        actual: any[],
        path: string,
        differences: Difference[],
        options: ComparisonOptions
    ): void {
        if (options.ignoreArrayOrder) {
            // Unordered comparison
            this.compareArraysUnordered(expected, actual, path, differences, options);
        } else {
            // Ordered comparison
            this.compareArraysOrdered(expected, actual, path, differences, options);
        }
    }

    /**
     * Compare arrays in order
     */
    private compareArraysOrdered(
        expected: any[],
        actual: any[],
        path: string,
        differences: Difference[],
        options: ComparisonOptions
    ): void {
        if (expected.length !== actual.length) {
            differences.push({
                path,
                type: 'array-length',
                expected: expected.length,
                actual: actual.length,
                message: `${path}: array length mismatch (expected ${expected.length}, got ${actual.length})`
            });
        }

        const minLength = Math.min(expected.length, actual.length);
        for (let i = 0; i < minLength; i++) {
            this.compareValues(
                expected[i],
                actual[i],
                `${path}[${i}]`,
                differences,
                options
            );
        }
    }

    /**
     * Compare arrays ignoring order
     */
    private compareArraysUnordered(
        expected: any[],
        actual: any[],
        path: string,
        differences: Difference[],
        options: ComparisonOptions
    ): void {
        if (expected.length !== actual.length) {
            differences.push({
                path,
                type: 'array-length',
                expected: expected.length,
                actual: actual.length,
                message: `${path}: array length mismatch (expected ${expected.length}, got ${actual.length})`
            });
        }

        const actualCopy = [...actual];
        const unmatched: any[] = [];

        for (const expectedItem of expected) {
            let found = false;

            for (let i = 0; i < actualCopy.length; i++) {
                const tempDiffs: Difference[] = [];
                this.compareValues(expectedItem, actualCopy[i], `${path}[?]`, tempDiffs, options);

                if (tempDiffs.length === 0) {
                    // Match found
                    actualCopy.splice(i, 1);
                    found = true;
                    break;
                }
            }

            if (!found) {
                unmatched.push(expectedItem);
            }
        }

        if (unmatched.length > 0) {
            differences.push({
                path,
                type: 'value-mismatch',
                expected: unmatched,
                actual: actualCopy,
                message: `${path}: ${unmatched.length} expected item(s) not found in actual array`
            });
        }

        if (actualCopy.length > 0 && !options.ignoreExtraFields) {
            differences.push({
                path,
                type: 'extra',
                expected: undefined,
                actual: actualCopy,
                message: `${path}: ${actualCopy.length} extra item(s) in actual array`
            });
        }
    }

    /**
     * Compare numbers with precision
     */
    private compareNumbers(
        expected: number,
        actual: number,
        path: string,
        differences: Difference[],
        options: ComparisonOptions
    ): void {
        if (options.decimalPrecision !== undefined) {
            const expectedRounded = this.roundToPrecision(expected, options.decimalPrecision);
            const actualRounded = this.roundToPrecision(actual, options.decimalPrecision);

            if (expectedRounded !== actualRounded) {
                differences.push({
                    path,
                    type: 'value-mismatch',
                    expected: expectedRounded,
                    actual: actualRounded,
                    message: `${path}: number mismatch (expected ${expectedRounded}, got ${actualRounded} with precision ${options.decimalPrecision})`
                });
            }
        } else {
            if (expected !== actual) {
                differences.push({
                    path,
                    type: 'value-mismatch',
                    expected,
                    actual,
                    message: `${path}: number mismatch (expected ${expected}, got ${actual})`
                });
            }
        }
    }

    /**
     * Compare strings with normalization
     */
    private compareStrings(
        expected: string,
        actual: string,
        path: string,
        differences: Difference[],
        options: ComparisonOptions
    ): void {
        let exp = expected;
        let act = actual;

        if (options.normalizeStrings) {
            exp = expected.trim().toLowerCase();
            act = actual.trim().toLowerCase();
        }

        if (exp !== act) {
            differences.push({
                path,
                type: 'value-mismatch',
                expected,
                actual,
                message: `${path}: string mismatch (expected "${expected}", got "${actual}")`
            });
        }
    }

    /**
     * Compare headers
     */
    private compareHeaders(
        expected: Record<string, any>,
        actual: Record<string, any>,
        differences: Difference[],
        options?: ComparisonOptions
    ): void {
        for (const [key, value] of Object.entries(expected)) {
            if (!(key in actual)) {
                differences.push({
                    path: `headers.${key}`,
                    type: 'missing',
                    expected: value,
                    actual: undefined,
                    message: `Header "${key}" missing in actual response`
                });
            } else if (actual[key] !== value) {
                differences.push({
                    path: `headers.${key}`,
                    type: 'value-mismatch',
                    expected: value,
                    actual: actual[key],
                    message: `Header "${key}" mismatch`
                });
            }
        }
    }

    /**
     * Generate summary from differences
     */
    private generateSummary(differences: Difference[]): string {
        if (differences.length === 0) {
            return 'Responses are equal';
        }

        const summary = [`Found ${differences.length} difference(s):`];

        for (const diff of differences.slice(0, 10)) {  // Show first 10
            summary.push(`  - ${diff.message}`);
        }

        if (differences.length > 10) {
            summary.push(`  ... and ${differences.length - 10} more`);
        }

        return summary.join('\n');
    }

    /**
     * Helper: Check if value is null or undefined
     */
    private isNullOrUndefined(value: any): boolean {
        return value === null || value === undefined;
    }

    /**
     * Helper: Round number to precision
     */
    private roundToPrecision(num: number, precision: number): number {
        const factor = Math.pow(10, precision);
        return Math.round(num * factor) / factor;
    }

    /**
     * Format comparison result for reporting
     */
    public formatResult(result: ComparisonResult): string {
        if (result.isEqual) {
            return 'Comparison PASSED: Responses are equal';
        }

        const lines = [
            'Comparison FAILED:',
            `Found ${result.differences.length} difference(s)`,
            ''
        ];

        for (const diff of result.differences) {
            lines.push(`Path: ${diff.path}`);
            lines.push(`Type: ${diff.type}`);
            if (diff.expected !== undefined) {
                lines.push(`Expected: ${JSON.stringify(diff.expected)}`);
            }
            if (diff.actual !== undefined) {
                lines.push(`Actual: ${JSON.stringify(diff.actual)}`);
            }
            lines.push('');
        }

        return lines.join('\n');
    }
}
