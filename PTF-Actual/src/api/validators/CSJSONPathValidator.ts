import { CSResponse, CSValidationResult, CSValidationError } from '../types/CSApiTypes';
import { CSReporter } from '../../reporter/CSReporter';

export interface CSJSONPathValidationConfig {
    path: string;
    value?: any;
    exists?: boolean;
    notExists?: boolean;
    contains?: string | string[];
    pattern?: string | RegExp;
    length?: { min?: number; max?: number; exact?: number };
    count?: { min?: number; max?: number; exact?: number };
    type?: string | string[];
    custom?: (value: any) => boolean | string;
    multiple?: CSJSONPathValidationConfig[];
    arrayLength?: number;
    metadata?: Record<string, any>;
}

export class CSJSONPathValidator {
    public validate(response: CSResponse, config: CSJSONPathValidationConfig): CSValidationResult {
        const errors: CSValidationError[] = [];
        const warnings: string[] = [];
        const startTime = Date.now();

        CSReporter.debug(`Validating JSONPath: ${config.path}`);

        // Get the response body - should already be parsed properly by CSHttpClient
        let data = response.body;

        // Debug log the body type and content
        CSReporter.debug(`Response body type: ${typeof data}`);
        if (typeof data === 'object' && data !== null) {
            CSReporter.debug(`Response body keys: ${Object.keys(data).slice(0, 10).join(', ')}`);
        }

        // If the body is still a string and looks like it should be JSON, parse it
        if (typeof data === 'string') {
            try {
                // Try to parse if it looks like JSON
                if (data.trim().startsWith('{') || data.trim().startsWith('[')) {
                    data = JSON.parse(data);
                }
            } catch (e) {
                // Not JSON, use as is
            }
        }

        // Multiple path validations
        if (config.multiple) {
            for (const pathConfig of config.multiple) {
                const result = this.validate(response, pathConfig);
                if (result.errors) {
                    errors.push(...result.errors);
                }
                if (result.warnings) {
                    warnings.push(...result.warnings);
                }
            }
        } else {
            // Single path validation
            this.validateSinglePath(data, config, errors, warnings);
        }

        const duration = Date.now() - startTime;

        return {
            valid: errors.length === 0,
            errors,
            warnings: warnings.length > 0 ? warnings : undefined,
            duration,
            metadata: {
                pathsValidated: config.multiple ? config.multiple.length : 1
            }
        };
    }

    private validateSinglePath(
        data: any,
        config: CSJSONPathValidationConfig,
        errors: CSValidationError[],
        warnings: string[]
    ): void {
        const extracted = this.extractPath(data, config.path);

        // Exists validation
        if (config.exists === true) {
            if (extracted === undefined) {
                errors.push({
                    path: config.path,
                    expected: 'value to exist',
                    actual: 'undefined',
                    message: `Expected value at path '${config.path}' to exist`,
                    type: 'jsonpath'
                });
                return;
            }
        }

        // Not exists validation
        if (config.notExists === true) {
            if (extracted !== undefined) {
                errors.push({
                    path: config.path,
                    expected: 'value not to exist',
                    actual: extracted,
                    message: `Expected value at path '${config.path}' not to exist`,
                    type: 'jsonpath'
                });
                return;
            }
        }

        // If value doesn't exist and we're not checking for non-existence, skip other validations
        if (extracted === undefined && config.notExists !== true) {
            if (config.value !== undefined || config.contains || config.pattern || config.type) {
                errors.push({
                    path: config.path,
                    expected: 'value to exist',
                    actual: 'undefined',
                    message: `Cannot validate undefined value at path '${config.path}'`,
                    type: 'jsonpath'
                });
            }
            return;
        }

        // Value validation
        if (config.value !== undefined) {
            const matches = this.deepEquals(extracted, config.value);
            if (!matches) {
                errors.push({
                    path: config.path,
                    expected: config.value,
                    actual: extracted,
                    message: `Expected value at path '${config.path}' to equal ${JSON.stringify(config.value)}`,
                    type: 'jsonpath'
                });
            }
        }

        // Contains validation (for strings and arrays)
        if (config.contains) {
            const searchTerms = Array.isArray(config.contains) ? config.contains : [config.contains];
            const valueString = typeof extracted === 'string' ? extracted : JSON.stringify(extracted);

            for (const term of searchTerms) {
                if (!valueString.includes(term)) {
                    errors.push({
                        path: config.path,
                        expected: `contain '${term}'`,
                        actual: extracted,
                        message: `Expected value at path '${config.path}' to contain '${term}'`,
                        type: 'jsonpath'
                    });
                }
            }
        }

        // Pattern validation
        if (config.pattern) {
            const regex = typeof config.pattern === 'string'
                ? new RegExp(config.pattern)
                : config.pattern;

            const valueString = typeof extracted === 'string' ? extracted : JSON.stringify(extracted);

            if (!regex.test(valueString)) {
                errors.push({
                    path: config.path,
                    expected: `match pattern ${regex}`,
                    actual: extracted,
                    message: `Expected value at path '${config.path}' to match pattern ${regex}`,
                    type: 'jsonpath'
                });
            }
        }

        // Length validation (for strings and arrays)
        if (config.length) {
            const length = Array.isArray(extracted)
                ? extracted.length
                : typeof extracted === 'string'
                    ? extracted.length
                    : 0;

            this.validateRange(length, config.length, 'length', config.path, errors);
        }

        // Count validation (for arrays)
        if (config.count && Array.isArray(extracted)) {
            this.validateRange(extracted.length, config.count, 'count', config.path, errors);
        }

        // Type validation
        if (config.type) {
            const actualType = this.getType(extracted);
            const expectedTypes = Array.isArray(config.type) ? config.type : [config.type];

            if (!expectedTypes.includes(actualType)) {
                errors.push({
                    path: config.path,
                    expected: expectedTypes.length === 1 ? expectedTypes[0] : `one of [${expectedTypes.join(', ')}]`,
                    actual: actualType,
                    message: `Expected type at path '${config.path}' to be ${expectedTypes.join(' or ')}`,
                    type: 'jsonpath'
                });
            }
        }

        // Custom validation
        if (config.custom && extracted !== undefined) {
            const result = config.custom(extracted);
            if (result !== true) {
                errors.push({
                    path: config.path,
                    expected: 'custom validation to pass',
                    actual: extracted,
                    message: typeof result === 'string' ? result : `Custom validation failed for path '${config.path}'`,
                    type: 'jsonpath'
                });
            }
        }
    }

    private extractPath(data: any, path: string): any {
        // Normalize path - ensure it starts with $
        if (!path.startsWith('$')) {
            path = '$.' + path;
        }

        // Special case for root
        if (path === '$') {
            return data;
        }

        // Parse the path
        const segments = this.parsePath(path);
        let current = data;

        CSReporter.debug(`Extracting path ${path}, segments: ${JSON.stringify(segments)}`);
        CSReporter.debug(`Starting with data: ${JSON.stringify(current).substring(0, 100)}`)

        for (const segment of segments) {
            if (current === null || current === undefined) {
                CSReporter.debug(`Current is null/undefined at segment ${JSON.stringify(segment)}`);
                return undefined;
            }

            CSReporter.debug(`Processing segment: ${JSON.stringify(segment)}, current value type: ${typeof current}`);

            if (segment.type === 'property') {
                current = current[segment.value];
                CSReporter.debug(`After property access '${segment.value}': ${JSON.stringify(current).substring(0, 100)}`);
            } else if (segment.type === 'index') {
                if (Array.isArray(current)) {
                    const index = parseInt(segment.value);
                    current = index < 0
                        ? current[current.length + index]
                        : current[index];
                } else {
                    return undefined;
                }
            } else if (segment.type === 'wildcard') {
                if (Array.isArray(current)) {
                    return current;
                } else if (typeof current === 'object' && current !== null) {
                    return Object.values(current);
                }
                return undefined;
            } else if (segment.type === 'recursive') {
                // Recursive descent
                const results = this.recursiveSearch(current, segment.value);
                return results.length === 1 ? results[0] : results;
            } else if (segment.type === 'filter') {
                if (Array.isArray(current)) {
                    current = this.applyFilter(current, segment.value);
                } else {
                    return undefined;
                }
            } else if (segment.type === 'slice') {
                if (Array.isArray(current)) {
                    const parts = segment.value.split(':');
                    const start = parts[0] ? parseInt(parts[0]) : undefined;
                    const end = parts[1] ? parseInt(parts[1]) : undefined;
                    const step = parts[2] ? parseInt(parts[2]) : 1;
                    current = this.sliceArray(current, start, end, step);
                } else {
                    return undefined;
                }
            }
        }

        return current;
    }

    private parsePath(path: string): Array<{ type: string; value: string }> {
        const segments: Array<{ type: string; value: string }> = [];

        // Remove leading $. or $
        path = path.replace(/^\$\.?/, '');

        // First handle bracket notation and then split remaining parts by dots
        const tokens: string[] = [];
        let current = '';
        let inBracket = false;

        for (let i = 0; i < path.length; i++) {
            const char = path[i];
            const nextChar = path[i + 1];

            if (char === '[') {
                if (current) {
                    // Split any accumulated path by dots before bracket
                    tokens.push(...current.split('.').filter(t => t));
                    current = '';
                }
                inBracket = true;
                current = char;
            } else if (char === ']') {
                current += char;
                tokens.push(current);
                current = '';
                inBracket = false;
                // Skip the dot after bracket if present
                if (nextChar === '.') {
                    i++;
                }
            } else if (char === '.' && !inBracket) {
                if (current) {
                    tokens.push(current);
                    current = '';
                }
            } else {
                current += char;
            }
        }

        if (current) {
            // Split any remaining path by dots
            tokens.push(...current.split('.').filter(t => t));
        }

        for (const token of tokens) {
            if (!token) continue;

            if (token === '*') {
                segments.push({ type: 'wildcard', value: '*' });
            } else if (token.startsWith('..')) {
                segments.push({ type: 'recursive', value: token.substring(2) });
            } else if (token.startsWith('[') && token.endsWith(']')) {
                const content = token.substring(1, token.length - 1);

                if (content === '*') {
                    segments.push({ type: 'wildcard', value: '*' });
                } else if (content.startsWith('?')) {
                    segments.push({ type: 'filter', value: content });
                } else if (content.includes(':')) {
                    segments.push({ type: 'slice', value: content });
                } else if (/^-?\d+$/.test(content)) {
                    segments.push({ type: 'index', value: content });
                } else if (content.startsWith("'") && content.endsWith("'")) {
                    segments.push({ type: 'property', value: content.slice(1, -1) });
                } else {
                    segments.push({ type: 'property', value: content });
                }
            } else {
                // Regular property
                segments.push({ type: 'property', value: token });
            }
        }

        return segments;
    }

    private recursiveSearch(obj: any, property: string): any[] {
        const results: any[] = [];

        const search = (current: any): void => {
            if (current === null || current === undefined) {
                return;
            }

            if (typeof current === 'object') {
                if (property in current) {
                    results.push(current[property]);
                }

                for (const key in current) {
                    if (current.hasOwnProperty(key)) {
                        search(current[key]);
                    }
                }
            }
        };

        search(obj);
        return results;
    }

    private applyFilter(array: any[], filter: string): any[] {
        // Simple filter implementation
        // Format: [?(@.property == value)] or [?(@.property > value)]
        const match = filter.match(/\?\(@\.(\w+)\s*(==|!=|>|<|>=|<=)\s*(.+)\)/);

        if (!match) {
            return array;
        }

        const [, property, operator, valueStr] = match;
        let value: any = valueStr;

        // Try to parse value
        if (valueStr === 'true') value = true;
        else if (valueStr === 'false') value = false;
        else if (valueStr === 'null') value = null;
        else if (/^-?\d+$/.test(valueStr)) value = parseInt(valueStr);
        else if (/^-?\d+\.\d+$/.test(valueStr)) value = parseFloat(valueStr);
        else if (valueStr.startsWith('"') && valueStr.endsWith('"')) {
            value = valueStr.slice(1, -1);
        }

        return array.filter(item => {
            const itemValue = item[property];

            switch (operator) {
                case '==': return itemValue == value;
                case '!=': return itemValue != value;
                case '>': return itemValue > value;
                case '<': return itemValue < value;
                case '>=': return itemValue >= value;
                case '<=': return itemValue <= value;
                default: return false;
            }
        });
    }

    private sliceArray(array: any[], start?: number, end?: number, step: number = 1): any[] {
        const result: any[] = [];
        const length = array.length;

        // Handle negative indices
        const actualStart = start === undefined
            ? 0
            : start < 0
                ? Math.max(0, length + start)
                : start;

        const actualEnd = end === undefined
            ? length
            : end < 0
                ? Math.max(0, length + end)
                : Math.min(end, length);

        for (let i = actualStart; i < actualEnd; i += step) {
            result.push(array[i]);
        }

        return result;
    }

    private validateRange(
        value: number,
        range: { min?: number; max?: number; exact?: number },
        type: string,
        path: string,
        errors: CSValidationError[]
    ): void {
        if (range.exact !== undefined && value !== range.exact) {
            errors.push({
                path,
                expected: range.exact,
                actual: value,
                message: `Expected ${type} at path '${path}' to be ${range.exact}, but got ${value}`,
                type: 'jsonpath'
            });
        }

        if (range.min !== undefined && value < range.min) {
            errors.push({
                path,
                expected: `>= ${range.min}`,
                actual: value,
                message: `Expected ${type} at path '${path}' to be at least ${range.min}, but got ${value}`,
                type: 'jsonpath'
            });
        }

        if (range.max !== undefined && value > range.max) {
            errors.push({
                path,
                expected: `<= ${range.max}`,
                actual: value,
                message: `Expected ${type} at path '${path}' to be at most ${range.max}, but got ${value}`,
                type: 'jsonpath'
            });
        }
    }

    private deepEquals(a: any, b: any): boolean {
        if (a === b) return true;

        if (a === null || b === null) return false;
        if (a === undefined || b === undefined) return false;

        // Special handling for number/string comparison
        // This allows "200" to equal 200 when comparing query params
        if ((typeof a === 'string' && typeof b === 'number') ||
            (typeof a === 'number' && typeof b === 'string')) {
            return String(a) === String(b);
        }

        if (typeof a !== typeof b) return false;

        if (typeof a === 'object') {
            if (Array.isArray(a) !== Array.isArray(b)) return false;

            if (Array.isArray(a)) {
                if (a.length !== b.length) return false;
                for (let i = 0; i < a.length; i++) {
                    if (!this.deepEquals(a[i], b[i])) return false;
                }
                return true;
            } else {
                const keysA = Object.keys(a);
                const keysB = Object.keys(b);

                if (keysA.length !== keysB.length) return false;

                for (const key of keysA) {
                    if (!this.deepEquals(a[key], b[key])) return false;
                }
                return true;
            }
        }

        return false;
    }

    private getType(value: any): string {
        if (value === null) return 'null';
        if (value === undefined) return 'undefined';
        if (Array.isArray(value)) return 'array';
        if (value instanceof Date) return 'date';
        return typeof value;
    }

    public expectPath(path: string, value?: any): CSJSONPathValidationConfig {
        return value === undefined ? { path, exists: true } : { path, value };
    }

    public expectPathNotExists(path: string): CSJSONPathValidationConfig {
        return { path, notExists: true };
    }

    public expectPathType(path: string, type: string | string[]): CSJSONPathValidationConfig {
        return { path, type };
    }

    public expectPathPattern(path: string, pattern: string | RegExp): CSJSONPathValidationConfig {
        return { path, pattern };
    }

    public expectPathContains(path: string, contains: string | string[]): CSJSONPathValidationConfig {
        return { path, contains };
    }

    public expectArrayLength(path: string, length: { min?: number; max?: number; exact?: number }): CSJSONPathValidationConfig {
        return { path, length };
    }
}

export const jsonPathValidator = new CSJSONPathValidator();