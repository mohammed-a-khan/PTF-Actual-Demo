// src/utils/CSJsonUtility.ts

import * as fs from 'fs';
import * as path from 'path';

/**
 * Comprehensive JSON Utility Class
 * Provides extensive JSON operations, parsing, validation, transformation, and comparison
 */
export class CSJsonUtility {

    // ===============================
    // READING AND PARSING
    // ===============================

    /**
     * Read and parse JSON file
     */
    static readFile<T = any>(filePath: string, encoding: BufferEncoding = 'utf8'): T {
        if (!fs.existsSync(filePath)) {
            throw new Error(`JSON file not found: ${filePath}`);
        }

        const content = fs.readFileSync(filePath, encoding);
        return this.parse<T>(content);
    }

    /**
     * Parse JSON string
     */
    static parse<T = any>(jsonString: string): T {
        try {
            return JSON.parse(jsonString);
        } catch (error) {
            throw new Error(`Failed to parse JSON: ${error}`);
        }
    }

    /**
     * Safe parse - returns default value on error
     */
    static safeParse<T = any>(jsonString: string, defaultValue: T): T {
        try {
            return JSON.parse(jsonString);
        } catch {
            return defaultValue;
        }
    }

    /**
     * Parse JSON with reviver function
     */
    static parseWithReviver<T = any>(jsonString: string, reviver: (key: string, value: any) => any): T {
        return JSON.parse(jsonString, reviver);
    }

    /**
     * Read JSON file asynchronously
     */
    static async readFileAsync<T = any>(filePath: string, encoding: BufferEncoding = 'utf8'): Promise<T> {
        if (!fs.existsSync(filePath)) {
            throw new Error(`JSON file not found: ${filePath}`);
        }

        const content = await fs.promises.readFile(filePath, encoding);
        return this.parse<T>(content);
    }

    // ===============================
    // WRITING AND STRINGIFYING
    // ===============================

    /**
     * Write object to JSON file
     */
    static writeFile<T = any>(data: T, filePath: string, options?: {
        pretty?: boolean;
        indent?: number;
        encoding?: BufferEncoding;
    }): void {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const content = options?.pretty !== false
            ? JSON.stringify(data, null, options?.indent || 2)
            : JSON.stringify(data);

        fs.writeFileSync(filePath, content, options?.encoding || 'utf8');
    }

    /**
     * Stringify object to JSON string
     */
    static stringify<T = any>(data: T, pretty: boolean = false, indent: number = 2): string {
        return pretty ? JSON.stringify(data, null, indent) : JSON.stringify(data);
    }

    /**
     * Stringify with replacer function
     */
    static stringifyWithReplacer<T = any>(data: T, replacer: (key: string, value: any) => any, pretty: boolean = false): string {
        return pretty ? JSON.stringify(data, replacer, 2) : JSON.stringify(data, replacer);
    }

    /**
     * Write JSON file asynchronously
     */
    static async writeFileAsync<T = any>(data: T, filePath: string, options?: {
        pretty?: boolean;
        indent?: number;
        encoding?: BufferEncoding;
    }): Promise<void> {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            await fs.promises.mkdir(dir, { recursive: true });
        }

        const content = options?.pretty !== false
            ? JSON.stringify(data, null, options?.indent || 2)
            : JSON.stringify(data);

        await fs.promises.writeFile(filePath, content, options?.encoding || 'utf8');
    }

    // ===============================
    // VALIDATION
    // ===============================

    /**
     * Check if string is valid JSON
     */
    static isValid(jsonString: string): boolean {
        try {
            JSON.parse(jsonString);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Validate JSON against schema (basic validation)
     */
    static validateSchema(data: any, schema: {
        required?: string[];
        properties?: Record<string, { type: string; required?: boolean }>;
    }): { isValid: boolean; errors: string[] } {
        const errors: string[] = [];

        // Check required fields
        if (schema.required) {
            schema.required.forEach(field => {
                if (!(field in data)) {
                    errors.push(`Missing required field: ${field}`);
                }
            });
        }

        // Check property types
        if (schema.properties) {
            Object.entries(schema.properties).forEach(([key, propSchema]) => {
                if (key in data) {
                    const actualType = typeof data[key];
                    const expectedType = propSchema.type.toLowerCase();

                    if (actualType !== expectedType && !(expectedType === 'array' && Array.isArray(data[key]))) {
                        errors.push(`Field ${key} has type ${actualType}, expected ${expectedType}`);
                    }
                }
            });
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Check if file is valid JSON file
     */
    static isValidFile(filePath: string): boolean {
        try {
            if (!fs.existsSync(filePath)) return false;
            const content = fs.readFileSync(filePath, 'utf8');
            return this.isValid(content);
        } catch {
            return false;
        }
    }

    // ===============================
    // QUERYING AND TRAVERSAL
    // ===============================

    /**
     * Get value at JSON path (simple dot notation)
     */
    static getValueAtPath(data: any, path: string): any {
        const keys = path.split('.');
        let current = data;

        for (const key of keys) {
            if (current === null || current === undefined) {
                return undefined;
            }

            // Handle array indexing
            const arrayMatch = key.match(/^(.+)\[(\d+)\]$/);
            if (arrayMatch) {
                const [, arrayKey, index] = arrayMatch;
                current = current[arrayKey]?.[parseInt(index, 10)];
            } else {
                current = current[key];
            }
        }

        return current;
    }

    /**
     * Set value at JSON path
     */
    static setValueAtPath(data: any, path: string, value: any): any {
        const keys = path.split('.');
        const lastKey = keys.pop()!;
        let current = data;

        for (const key of keys) {
            if (!(key in current)) {
                current[key] = {};
            }
            current = current[key];
        }

        current[lastKey] = value;
        return data;
    }

    /**
     * Delete value at JSON path
     */
    static deleteValueAtPath(data: any, path: string): any {
        const keys = path.split('.');
        const lastKey = keys.pop()!;
        let current = data;

        for (const key of keys) {
            if (!(key in current)) {
                return data;
            }
            current = current[key];
        }

        delete current[lastKey];
        return data;
    }

    /**
     * Check if path exists in JSON
     */
    static hasPath(data: any, path: string): boolean {
        return this.getValueAtPath(data, path) !== undefined;
    }

    /**
     * Find all values matching predicate
     */
    static findValues(data: any, predicate: (value: any, key: string, parent: any) => boolean): any[] {
        const results: any[] = [];

        const traverse = (obj: any, parent: any = null) => {
            if (typeof obj !== 'object' || obj === null) {
                return;
            }

            Object.entries(obj).forEach(([key, value]) => {
                if (predicate(value, key, parent)) {
                    results.push(value);
                }

                if (typeof value === 'object' && value !== null) {
                    traverse(value, obj);
                }
            });
        };

        traverse(data);
        return results;
    }

    /**
     * Find all keys in JSON
     */
    static getAllKeys(data: any): string[] {
        const keys = new Set<string>();

        const traverse = (obj: any) => {
            if (typeof obj !== 'object' || obj === null) {
                return;
            }

            Object.keys(obj).forEach(key => {
                keys.add(key);
                traverse(obj[key]);
            });
        };

        traverse(data);
        return Array.from(keys);
    }

    /**
     * Get all paths in JSON
     */
    static getAllPaths(data: any): string[] {
        const paths: string[] = [];

        const traverse = (obj: any, currentPath: string = '') => {
            if (typeof obj !== 'object' || obj === null) {
                paths.push(currentPath);
                return;
            }

            Object.entries(obj).forEach(([key, value]) => {
                const newPath = currentPath ? `${currentPath}.${key}` : key;
                traverse(value, newPath);
            });
        };

        traverse(data);
        return paths;
    }

    // ===============================
    // TRANSFORMATION
    // ===============================

    /**
     * Deep clone JSON object
     */
    static clone<T = any>(data: T): T {
        return JSON.parse(JSON.stringify(data));
    }

    /**
     * Merge two JSON objects (deep merge)
     */
    static merge<T = any>(target: T, source: any): T {
        const result = this.clone(target);

        const deepMerge = (tgt: any, src: any) => {
            Object.keys(src).forEach(key => {
                if (src[key] && typeof src[key] === 'object' && !Array.isArray(src[key])) {
                    if (!tgt[key]) {
                        tgt[key] = {};
                    }
                    deepMerge(tgt[key], src[key]);
                } else {
                    tgt[key] = src[key];
                }
            });
        };

        deepMerge(result, source);
        return result;
    }

    /**
     * Flatten nested JSON to single level
     */
    static flatten(data: any, separator: string = '.'): Record<string, any> {
        const result: Record<string, any> = {};

        const flatten = (obj: any, prefix: string = '') => {
            Object.entries(obj).forEach(([key, value]) => {
                const newKey = prefix ? `${prefix}${separator}${key}` : key;

                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    flatten(value, newKey);
                } else {
                    result[newKey] = value;
                }
            });
        };

        flatten(data);
        return result;
    }

    /**
     * Unflatten single-level JSON to nested structure
     */
    static unflatten(data: Record<string, any>, separator: string = '.'): any {
        const result: any = {};

        Object.entries(data).forEach(([key, value]) => {
            const keys = key.split(separator);
            let current = result;

            keys.forEach((k, index) => {
                if (index === keys.length - 1) {
                    current[k] = value;
                } else {
                    if (!current[k]) {
                        current[k] = {};
                    }
                    current = current[k];
                }
            });
        });

        return result;
    }

    /**
     * Transform JSON keys (e.g., camelCase to snake_case)
     */
    static transformKeys(data: any, transformer: (key: string) => string): any {
        if (Array.isArray(data)) {
            return data.map(item => this.transformKeys(item, transformer));
        }

        if (typeof data !== 'object' || data === null) {
            return data;
        }

        const result: any = {};
        Object.entries(data).forEach(([key, value]) => {
            const newKey = transformer(key);
            result[newKey] = this.transformKeys(value, transformer);
        });

        return result;
    }

    /**
     * Filter JSON by keys
     */
    static filterByKeys<T = any>(data: T, keysToKeep: string[]): Partial<T> {
        if (typeof data !== 'object' || data === null) {
            return data;
        }

        const result: any = {};
        keysToKeep.forEach(key => {
            if (key in data) {
                result[key] = (data as any)[key];
            }
        });

        return result;
    }

    /**
     * Omit keys from JSON
     */
    static omitKeys<T = any>(data: T, keysToOmit: string[]): Partial<T> {
        if (typeof data !== 'object' || data === null) {
            return data;
        }

        const result = this.clone(data);
        keysToOmit.forEach(key => {
            delete (result as any)[key];
        });

        return result;
    }

    /**
     * Convert JSON array to object (key-value pairs)
     */
    static arrayToObject<T = any>(array: T[], keyField: string): Record<string, T> {
        const result: Record<string, T> = {};

        array.forEach(item => {
            const key = (item as any)[keyField];
            if (key !== undefined) {
                result[key] = item;
            }
        });

        return result;
    }

    /**
     * Convert object to array
     */
    static objectToArray(obj: Record<string, any>, keyName: string = 'key', valueName: string = 'value'): any[] {
        return Object.entries(obj).map(([key, value]) => ({
            [keyName]: key,
            [valueName]: value
        }));
    }

    /**
     * Remove null and undefined values
     */
    static removeNullish<T = any>(data: T): T {
        if (Array.isArray(data)) {
            return data.map(item => this.removeNullish(item)) as any;
        }

        if (typeof data !== 'object' || data === null) {
            return data;
        }

        const result: any = {};
        Object.entries(data).forEach(([key, value]) => {
            if (value !== null && value !== undefined) {
                result[key] = this.removeNullish(value);
            }
        });

        return result;
    }

    /**
     * Sort object keys alphabetically
     */
    static sortKeys<T = any>(data: T): T {
        if (Array.isArray(data)) {
            return data.map(item => this.sortKeys(item)) as any;
        }

        if (typeof data !== 'object' || data === null) {
            return data;
        }

        const result: any = {};
        Object.keys(data).sort().forEach(key => {
            result[key] = this.sortKeys((data as any)[key]);
        });

        return result;
    }

    // ===============================
    // COMPARISON
    // ===============================

    /**
     * Deep compare two JSON objects
     */
    static deepEquals(obj1: any, obj2: any): boolean {
        return JSON.stringify(this.sortKeys(obj1)) === JSON.stringify(this.sortKeys(obj2));
    }

    /**
     * Compare two JSON files
     */
    static compareFiles(file1: string, file2: string): {
        areEqual: boolean;
        differences: any[];
    } {
        const data1 = this.readFile(file1);
        const data2 = this.readFile(file2);

        const differences = this.getDifferences(data1, data2);

        return {
            areEqual: differences.length === 0,
            differences
        };
    }

    /**
     * Get differences between two JSON objects
     */
    static getDifferences(obj1: any, obj2: any, path: string = ''): Array<{ path: string; value1: any; value2: any; type: string }> {
        const differences: Array<{ path: string; value1: any; value2: any; type: string }> = [];

        if (typeof obj1 !== typeof obj2) {
            differences.push({ path, value1: obj1, value2: obj2, type: 'type_mismatch' });
            return differences;
        }

        if (typeof obj1 !== 'object' || obj1 === null || obj2 === null) {
            if (obj1 !== obj2) {
                differences.push({ path, value1: obj1, value2: obj2, type: 'value_mismatch' });
            }
            return differences;
        }

        const allKeys = new Set([...Object.keys(obj1), ...Object.keys(obj2)]);

        allKeys.forEach(key => {
            const newPath = path ? `${path}.${key}` : key;
            const val1 = obj1[key];
            const val2 = obj2[key];

            if (!(key in obj1)) {
                differences.push({ path: newPath, value1: undefined, value2: val2, type: 'added' });
            } else if (!(key in obj2)) {
                differences.push({ path: newPath, value1: val1, value2: undefined, type: 'removed' });
            } else {
                differences.push(...this.getDifferences(val1, val2, newPath));
            }
        });

        return differences;
    }

    /**
     * Get JSON diff report
     */
    static getDiffReport(obj1: any, obj2: any): {
        areEqual: boolean;
        added: string[];
        removed: string[];
        modified: string[];
    } {
        const differences = this.getDifferences(obj1, obj2);

        return {
            areEqual: differences.length === 0,
            added: differences.filter(d => d.type === 'added').map(d => d.path),
            removed: differences.filter(d => d.type === 'removed').map(d => d.path),
            modified: differences.filter(d => d.type === 'value_mismatch' || d.type === 'type_mismatch').map(d => d.path)
        };
    }

    // ===============================
    // UTILITY OPERATIONS
    // ===============================

    /**
     * Pretty print JSON
     */
    static prettyPrint(data: any, indent: number = 2): void {
        console.log(JSON.stringify(data, null, indent));
    }

    /**
     * Get JSON size in bytes
     */
    static getSize(data: any): number {
        return Buffer.from(JSON.stringify(data)).length;
    }

    /**
     * Minify JSON (remove whitespace)
     */
    static minify(jsonString: string): string {
        return JSON.stringify(JSON.parse(jsonString));
    }

    /**
     * Beautify JSON string
     */
    static beautify(jsonString: string, indent: number = 2): string {
        return JSON.stringify(JSON.parse(jsonString), null, indent);
    }

    /**
     * Count keys in JSON
     */
    static countKeys(data: any): number {
        return this.getAllKeys(data).length;
    }

    /**
     * Get depth of JSON object
     */
    static getDepth(data: any): number {
        if (typeof data !== 'object' || data === null) {
            return 0;
        }

        const depths = Object.values(data).map(value => this.getDepth(value));
        return 1 + Math.max(0, ...depths);
    }

    /**
     * Search for key in JSON
     */
    static searchKey(data: any, searchKey: string): any[] {
        return this.findValues(data, (value, key) => key === searchKey);
    }

    /**
     * Get file metadata
     */
    static getFileMetadata(filePath: string): {
        isValid: boolean;
        size: number;
        keyCount: number;
        depth: number;
    } {
        const stats = fs.statSync(filePath);
        const data = this.readFile(filePath);

        return {
            isValid: this.isValidFile(filePath),
            size: stats.size,
            keyCount: this.countKeys(data),
            depth: this.getDepth(data)
        };
    }

    /**
     * Escape JSON for use in HTML
     */
    static escapeForHTML(data: any): string {
        return JSON.stringify(data)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Clone file to another location
     */
    static cloneFile(sourcePath: string, targetPath: string, pretty: boolean = true): void {
        const data = this.readFile(sourcePath);
        this.writeFile(data, targetPath, { pretty });
    }

    /**
     * Merge multiple JSON files
     */
    static mergeFiles(filePaths: string[], outputPath: string, pretty: boolean = true): void {
        let merged: any = {};

        filePaths.forEach(filePath => {
            const data = this.readFile(filePath);
            merged = this.merge(merged, data);
        });

        this.writeFile(merged, outputPath, { pretty });
    }

    /**
     * Extract specific field from JSON array
     */
    static extractField<T = any>(data: any[], fieldName: string): T[] {
        return data.map(item => item[fieldName]);
    }

    /**
     * Group array by field
     */
    static groupBy<T = any>(data: T[], field: string): Record<string, T[]> {
        const result: Record<string, T[]> = {};

        data.forEach(item => {
            const key = (item as any)[field];
            if (!result[key]) {
                result[key] = [];
            }
            result[key].push(item);
        });

        return result;
    }
}
