// src/utils/CSCsvUtility.ts

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

/**
 * Comprehensive CSV Utility Class
 * Provides extensive CSV file operations, reading, writing, parsing, and transformation
 */
export class CSCsvUtility {

    // ===============================
    // READING OPERATIONS
    // ===============================

    /**
     * Read CSV file as string
     */
    static readAsString(filePath: string, encoding: BufferEncoding = 'utf8'): string {
        if (!fs.existsSync(filePath)) {
            throw new Error(`CSV file not found: ${filePath}`);
        }
        return fs.readFileSync(filePath, encoding);
    }

    /**
     * Parse CSV string to array of objects
     */
    static parseToJSON<T = any>(csvContent: string, options?: {
        delimiter?: string;
        columns?: boolean | string[];
        skipEmptyLines?: boolean;
        trim?: boolean;
        fromLine?: number;
        toLine?: number;
    }): T[] {
        const defaultOptions = {
            delimiter: ',',
            columns: true,
            skipEmptyLines: true,
            trim: true,
            ...options
        };

        return parse(csvContent, defaultOptions);
    }

    /**
     * Parse CSV string to 2D array
     */
    static parseToArray(csvContent: string, options?: {
        delimiter?: string;
        skipEmptyLines?: boolean;
        trim?: boolean;
        fromLine?: number;
        toLine?: number;
    }): string[][] {
        const defaultOptions = {
            delimiter: ',',
            columns: false,
            skipEmptyLines: true,
            trim: true,
            ...options
        };

        return parse(csvContent, defaultOptions);
    }

    /**
     * Read CSV file as array of objects
     */
    static readAsJSON<T = any>(filePath: string, options?: {
        delimiter?: string;
        columns?: boolean | string[];
        skipEmptyLines?: boolean;
        trim?: boolean;
        encoding?: BufferEncoding;
    }): T[] {
        const csvContent = this.readAsString(filePath, options?.encoding || 'utf8');
        return this.parseToJSON<T>(csvContent, options);
    }

    /**
     * Read CSV file as 2D array
     */
    static readAsArray(filePath: string, options?: {
        delimiter?: string;
        skipEmptyLines?: boolean;
        trim?: boolean;
        encoding?: BufferEncoding;
    }): string[][] {
        const csvContent = this.readAsString(filePath, options?.encoding || 'utf8');
        return this.parseToArray(csvContent, options);
    }

    /**
     * Read specific column by index (0-based)
     */
    static readColumnByIndex(filePath: string, columnIndex: number, options?: { delimiter?: string; skipHeader?: boolean }): string[] {
        const data = this.readAsArray(filePath, { delimiter: options?.delimiter });

        if (options?.skipHeader && data.length > 0) {
            data.shift();
        }

        return data.map(row => row[columnIndex] || '');
    }

    /**
     * Read specific column by name
     */
    static readColumnByName(filePath: string, columnName: string, options?: { delimiter?: string }): any[] {
        const data = this.readAsJSON(filePath, { delimiter: options?.delimiter });
        return data.map((row: any) => row[columnName]);
    }

    /**
     * Read specific row by index (0-based)
     */
    static readRowByIndex(filePath: string, rowIndex: number, options?: { delimiter?: string }): string[] {
        const data = this.readAsArray(filePath, { delimiter: options?.delimiter });
        return data[rowIndex] || [];
    }

    /**
     * Get headers from CSV file
     */
    static getHeaders(filePath: string, options?: { delimiter?: string }): string[] {
        const data = this.readAsArray(filePath, { delimiter: options?.delimiter });
        return data.length > 0 ? data[0] : [];
    }

    /**
     * Get row count
     */
    static getRowCount(filePath: string, options?: { delimiter?: string; includeHeader?: boolean }): number {
        const data = this.readAsArray(filePath, { delimiter: options?.delimiter });
        return options?.includeHeader ? data.length : Math.max(0, data.length - 1);
    }

    /**
     * Get column count
     */
    static getColumnCount(filePath: string, options?: { delimiter?: string }): number {
        const data = this.readAsArray(filePath, { delimiter: options?.delimiter });
        return data.length > 0 ? data[0].length : 0;
    }

    /**
     * Check if CSV file is empty
     */
    static isEmpty(filePath: string): boolean {
        const content = this.readAsString(filePath).trim();
        return content.length === 0;
    }

    /**
     * Find rows matching criteria
     */
    static findRows(filePath: string, predicate: (row: any) => boolean, options?: { delimiter?: string }): any[] {
        const data = this.readAsJSON(filePath, { delimiter: options?.delimiter });
        return data.filter(predicate);
    }

    /**
     * Find first row matching criteria
     */
    static findRow(filePath: string, predicate: (row: any) => boolean, options?: { delimiter?: string }): any | undefined {
        const data = this.readAsJSON(filePath, { delimiter: options?.delimiter });
        return data.find(predicate);
    }

    /**
     * Get cell value by row and column index
     */
    static getCellValue(filePath: string, rowIndex: number, columnIndex: number, options?: { delimiter?: string }): string {
        const row = this.readRowByIndex(filePath, rowIndex, options);
        return row[columnIndex] || '';
    }

    /**
     * Read CSV with custom delimiter (TSV, pipe-separated, etc.)
     */
    static readWithDelimiter<T = any>(filePath: string, delimiter: string, asJSON: boolean = true): T[] | string[][] {
        return asJSON
            ? this.readAsJSON<T>(filePath, { delimiter })
            : this.readAsArray(filePath, { delimiter });
    }

    // ===============================
    // WRITING OPERATIONS
    // ===============================

    /**
     * Write array of objects to CSV file
     */
    static writeFromJSON<T = any>(data: T[], filePath: string, options?: {
        headers?: string[];
        delimiter?: string;
        includeHeaders?: boolean;
        encoding?: BufferEncoding;
    }): void {
        if (data.length === 0) {
            throw new Error('Cannot write empty data to CSV');
        }

        const delimiter = options?.delimiter || ',';
        const includeHeaders = options?.includeHeaders !== false;
        const headers = options?.headers || Object.keys(data[0] as any);

        let csvContent = '';

        if (includeHeaders) {
            csvContent += this.escapeRow(headers, delimiter) + '\n';
        }

        data.forEach(row => {
            const values = headers.map(header => (row as any)[header] ?? '');
            csvContent += this.escapeRow(values, delimiter) + '\n';
        });

        this.writeToFile(filePath, csvContent, options?.encoding);
    }

    /**
     * Write 2D array to CSV file
     */
    static writeFromArray(data: string[][], filePath: string, options?: {
        delimiter?: string;
        encoding?: BufferEncoding;
    }): void {
        if (data.length === 0) {
            throw new Error('Cannot write empty data to CSV');
        }

        const delimiter = options?.delimiter || ',';
        const csvContent = data.map(row => this.escapeRow(row, delimiter)).join('\n') + '\n';

        this.writeToFile(filePath, csvContent, options?.encoding);
    }

    /**
     * Append rows to existing CSV file
     */
    static appendRows<T = any>(filePath: string, rows: T[], options?: {
        delimiter?: string;
        encoding?: BufferEncoding;
    }): void {
        const existingData = this.readAsJSON(filePath, { delimiter: options?.delimiter, encoding: options?.encoding });
        const combinedData = [...existingData, ...rows];
        this.writeFromJSON(combinedData, filePath, { delimiter: options?.delimiter, encoding: options?.encoding });
    }

    /**
     * Update specific row
     */
    static updateRow<T = any>(filePath: string, rowIndex: number, newData: T, options?: { delimiter?: string }): void {
        const data = this.readAsJSON<T>(filePath, { delimiter: options?.delimiter });

        if (rowIndex < 0 || rowIndex >= data.length) {
            throw new Error(`Row index ${rowIndex} out of bounds`);
        }

        data[rowIndex] = newData;
        this.writeFromJSON(data, filePath, { delimiter: options?.delimiter });
    }

    /**
     * Delete specific row
     */
    static deleteRow(filePath: string, rowIndex: number, options?: { delimiter?: string }): void {
        const data = this.readAsJSON(filePath, { delimiter: options?.delimiter });

        if (rowIndex < 0 || rowIndex >= data.length) {
            throw new Error(`Row index ${rowIndex} out of bounds`);
        }

        data.splice(rowIndex, 1);
        this.writeFromJSON(data, filePath, { delimiter: options?.delimiter });
    }

    /**
     * Add column to CSV
     */
    static addColumn(filePath: string, columnName: string, defaultValue: any = '', options?: { delimiter?: string }): void {
        const data = this.readAsJSON(filePath, { delimiter: options?.delimiter });

        const updatedData = data.map((row: any) => ({
            ...row,
            [columnName]: defaultValue
        }));

        this.writeFromJSON(updatedData, filePath, { delimiter: options?.delimiter });
    }

    /**
     * Remove column from CSV
     */
    static removeColumn(filePath: string, columnName: string, options?: { delimiter?: string }): void {
        const data = this.readAsJSON(filePath, { delimiter: options?.delimiter });

        const updatedData = data.map((row: any) => {
            const { [columnName]: removed, ...rest } = row;
            return rest;
        });

        this.writeFromJSON(updatedData, filePath, { delimiter: options?.delimiter });
    }

    /**
     * Rename column
     */
    static renameColumn(filePath: string, oldName: string, newName: string, options?: { delimiter?: string }): void {
        const data = this.readAsJSON(filePath, { delimiter: options?.delimiter });

        const updatedData = data.map((row: any) => {
            if (row.hasOwnProperty(oldName)) {
                const { [oldName]: value, ...rest } = row;
                return { ...rest, [newName]: value };
            }
            return row;
        });

        this.writeFromJSON(updatedData, filePath, { delimiter: options?.delimiter });
    }

    // ===============================
    // TRANSFORMATION OPERATIONS
    // ===============================

    /**
     * Convert CSV to JSON file
     */
    static csvToJSON(csvPath: string, jsonPath: string, options?: { delimiter?: string }): void {
        const data = this.readAsJSON(csvPath, { delimiter: options?.delimiter });
        fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
    }

    /**
     * Convert JSON to CSV file
     */
    static jsonToCSV(jsonPath: string, csvPath: string, options?: { delimiter?: string }): void {
        const jsonContent = fs.readFileSync(jsonPath, 'utf8');
        const data = JSON.parse(jsonContent);

        if (!Array.isArray(data)) {
            throw new Error('JSON file must contain an array');
        }

        this.writeFromJSON(data, csvPath, { delimiter: options?.delimiter });
    }

    /**
     * Merge multiple CSV files
     */
    static mergeCSVFiles(filePaths: string[], outputPath: string, options?: {
        delimiter?: string;
        removeDuplicates?: boolean;
    }): void {
        let mergedData: any[] = [];

        filePaths.forEach(filePath => {
            const data = this.readAsJSON(filePath, { delimiter: options?.delimiter });
            mergedData = [...mergedData, ...data];
        });

        if (options?.removeDuplicates) {
            mergedData = this.removeDuplicateRows(mergedData);
        }

        this.writeFromJSON(mergedData, outputPath, { delimiter: options?.delimiter });
    }

    /**
     * Split CSV file into multiple files by row count
     */
    static splitCSVByRows(filePath: string, rowsPerFile: number, outputDir: string, options?: { delimiter?: string }): void {
        const data = this.readAsJSON(filePath, { delimiter: options?.delimiter });

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        let fileIndex = 1;
        for (let i = 0; i < data.length; i += rowsPerFile) {
            const chunk = data.slice(i, i + rowsPerFile);
            const outputPath = path.join(outputDir, `part_${fileIndex}.csv`);
            this.writeFromJSON(chunk, outputPath, { delimiter: options?.delimiter });
            fileIndex++;
        }
    }

    /**
     * Transpose CSV (rows to columns)
     */
    static transpose(inputPath: string, outputPath: string, options?: { delimiter?: string }): void {
        const data = this.readAsArray(inputPath, { delimiter: options?.delimiter });

        if (data.length === 0) {
            throw new Error('CSV file is empty');
        }

        const transposed: string[][] = [];
        const maxCols = Math.max(...data.map(row => row.length));

        for (let col = 0; col < maxCols; col++) {
            const newRow: string[] = [];
            for (let row = 0; row < data.length; row++) {
                newRow.push(data[row][col] || '');
            }
            transposed.push(newRow);
        }

        this.writeFromArray(transposed, outputPath, { delimiter: options?.delimiter });
    }

    /**
     * Filter CSV data and write to new file
     */
    static filterToFile(inputPath: string, outputPath: string, predicate: (row: any) => boolean, options?: { delimiter?: string }): void {
        const filteredData = this.findRows(inputPath, predicate, options);
        this.writeFromJSON(filteredData, outputPath, { delimiter: options?.delimiter });
    }

    /**
     * Sort CSV data and write to new file
     */
    static sortToFile(inputPath: string, outputPath: string, sortKey: string, ascending: boolean = true, options?: { delimiter?: string }): void {
        const data = this.readAsJSON(inputPath, { delimiter: options?.delimiter });

        const sorted = data.sort((a, b) => {
            const aVal = a[sortKey];
            const bVal = b[sortKey];

            if (aVal < bVal) return ascending ? -1 : 1;
            if (aVal > bVal) return ascending ? 1 : -1;
            return 0;
        });

        this.writeFromJSON(sorted, outputPath, { delimiter: options?.delimiter });
    }

    // ===============================
    // COMPARISON OPERATIONS
    // ===============================

    /**
     * Compare two CSV files
     */
    static compareCSVFiles(file1: string, file2: string, options?: { delimiter?: string }): {
        areEqual: boolean;
        differences: Array<{ row: number; column: string; value1: any; value2: any }>;
    } {
        const data1 = this.readAsJSON(file1, { delimiter: options?.delimiter });
        const data2 = this.readAsJSON(file2, { delimiter: options?.delimiter });

        const differences: Array<{ row: number; column: string; value1: any; value2: any }> = [];

        const maxRows = Math.max(data1.length, data2.length);
        const allKeys = new Set([
            ...data1.flatMap(row => Object.keys(row)),
            ...data2.flatMap(row => Object.keys(row))
        ]);

        for (let i = 0; i < maxRows; i++) {
            const row1 = data1[i];
            const row2 = data2[i];

            allKeys.forEach(key => {
                const val1 = row1?.[key];
                const val2 = row2?.[key];

                if (val1 !== val2) {
                    differences.push({ row: i, column: key, value1: val1, value2: val2 });
                }
            });
        }

        return {
            areEqual: differences.length === 0,
            differences
        };
    }

    /**
     * Get differences between two CSV files (added, removed, modified)
     */
    static getDifferences(file1: string, file2: string, options?: { delimiter?: string }): {
        areEqual: boolean;
        added: any[];
        removed: any[];
        modified: any[];
    } {
        const data1 = this.readAsJSON(file1, { delimiter: options?.delimiter });
        const data2 = this.readAsJSON(file2, { delimiter: options?.delimiter });

        const added = data2.filter(item2 =>
            !data1.some(item1 => JSON.stringify(item1) === JSON.stringify(item2))
        );

        const removed = data1.filter(item1 =>
            !data2.some(item2 => JSON.stringify(item1) === JSON.stringify(item2))
        );

        const modified: any[] = [];
        data1.forEach((item1, index) => {
            const item2 = data2[index];
            if (item2 && JSON.stringify(item1) !== JSON.stringify(item2)) {
                modified.push({ original: item1, modified: item2 });
            }
        });

        return {
            areEqual: added.length === 0 && removed.length === 0 && modified.length === 0,
            added,
            removed,
            modified
        };
    }

    // ===============================
    // UTILITY OPERATIONS
    // ===============================

    /**
     * Get distinct values from column
     */
    static getDistinctValues(filePath: string, columnName: string, options?: { delimiter?: string }): any[] {
        const values = this.readColumnByName(filePath, columnName, options);
        return [...new Set(values)];
    }

    /**
     * Get column statistics
     */
    static getColumnStatistics(filePath: string, columnName: string, options?: { delimiter?: string }): {
        count: number;
        sum: number;
        average: number;
        min: number;
        max: number;
    } {
        const values = this.readColumnByName(filePath, columnName, options)
            .filter(v => typeof v === 'number' || !isNaN(Number(v)))
            .map(v => Number(v));

        if (values.length === 0) {
            throw new Error(`No numeric values found in column ${columnName}`);
        }

        return {
            count: values.length,
            sum: values.reduce((a, b) => a + b, 0),
            average: values.reduce((a, b) => a + b, 0) / values.length,
            min: Math.min(...values),
            max: Math.max(...values)
        };
    }

    /**
     * Search for value in CSV
     */
    static searchValue(filePath: string, searchValue: any, options?: { delimiter?: string }): Array<{ row: number; column: string; value: any }> {
        const data = this.readAsJSON(filePath, { delimiter: options?.delimiter });
        const results: Array<{ row: number; column: string; value: any }> = [];

        data.forEach((row, rowIndex) => {
            Object.entries(row).forEach(([column, value]) => {
                if (value === searchValue) {
                    results.push({ row: rowIndex, column, value });
                }
            });
        });

        return results;
    }

    /**
     * Validate CSV structure
     */
    static validateStructure(filePath: string, expectedHeaders: string[], options?: { delimiter?: string }): {
        isValid: boolean;
        missingHeaders: string[];
        extraHeaders: string[];
    } {
        const headers = this.getHeaders(filePath, options);
        const missingHeaders = expectedHeaders.filter(h => !headers.includes(h));
        const extraHeaders = headers.filter(h => !expectedHeaders.includes(h));

        return {
            isValid: missingHeaders.length === 0 && extraHeaders.length === 0,
            missingHeaders,
            extraHeaders
        };
    }

    /**
     * Remove duplicate rows
     */
    static removeDuplicates(filePath: string, outputPath: string, options?: { delimiter?: string }): void {
        const data = this.readAsJSON(filePath, { delimiter: options?.delimiter });
        const uniqueData = this.removeDuplicateRows(data);
        this.writeFromJSON(uniqueData, outputPath, { delimiter: options?.delimiter });
    }

    /**
     * Clone CSV file
     */
    static cloneFile(sourcePath: string, targetPath: string): void {
        fs.copyFileSync(sourcePath, targetPath);
    }

    /**
     * Check if CSV file is valid
     */
    static isValidCSVFile(filePath: string): boolean {
        try {
            if (!fs.existsSync(filePath)) return false;
            this.readAsArray(filePath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get file metadata
     */
    static getFileMetadata(filePath: string, options?: { delimiter?: string }): {
        rowCount: number;
        columnCount: number;
        headers: string[];
        fileSize: number;
    } {
        const stats = fs.statSync(filePath);
        const headers = this.getHeaders(filePath, options);

        return {
            rowCount: this.getRowCount(filePath, { delimiter: options?.delimiter, includeHeader: false }),
            columnCount: this.getColumnCount(filePath, options),
            headers,
            fileSize: stats.size
        };
    }

    // ===============================
    // PRIVATE HELPER METHODS
    // ===============================

    private static escapeRow(row: any[], delimiter: string): string {
        return row.map(cell => this.escapeCell(String(cell), delimiter)).join(delimiter);
    }

    private static escapeCell(cell: string, delimiter: string): string {
        if (cell.includes(delimiter) || cell.includes('"') || cell.includes('\n') || cell.includes('\r')) {
            return `"${cell.replace(/"/g, '""')}"`;
        }
        return cell;
    }

    private static writeToFile(filePath: string, content: string, encoding: BufferEncoding = 'utf8'): void {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, content, encoding);
    }

    private static removeDuplicateRows<T = any>(data: T[]): T[] {
        const seen = new Set<string>();
        return data.filter(row => {
            const key = JSON.stringify(row);
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }
}
