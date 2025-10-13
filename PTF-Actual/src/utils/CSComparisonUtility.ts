// src/utils/CSComparisonUtility.ts

import { CSTextUtility } from './CSTextUtility';
import { CSExcelUtility } from './CSExcelUtility';
import { CSCsvUtility } from './CSCsvUtility';
import { CSJsonUtility } from './CSJsonUtility';
import { CSPdfUtility } from './CSPdfUtility';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Comprehensive Comparison Utility Class
 * Provides generic comparison methods for various file formats
 * Supports: Text, Excel, CSV, JSON, PDF comparisons
 */
export class CSComparisonUtility {

    // ===============================
    // TEXT FILE COMPARISONS
    // ===============================

    /**
     * Compare two text files
     */
    static compareTextFiles(file1: string, file2: string, options?: {
        encoding?: BufferEncoding;
        ignoreCase?: boolean;
        ignoreWhitespace?: boolean;
    }): {
        areEqual: boolean;
        similarity: number;
        differences: Array<{ lineNumber: number; line1: string; line2: string }>;
        lineCount1: number;
        lineCount2: number;
    } {
        const encoding = options?.encoding || 'utf8';

        let content1 = CSTextUtility.readFile(file1, encoding);
        let content2 = CSTextUtility.readFile(file2, encoding);

        if (options?.ignoreCase) {
            content1 = content1.toLowerCase();
            content2 = content2.toLowerCase();
        }

        if (options?.ignoreWhitespace) {
            content1 = content1.replace(/\s+/g, ' ').trim();
            content2 = content2.replace(/\s+/g, ' ').trim();
        }

        const comparison = CSTextUtility.compareFiles(file1, file2, encoding);
        const similarity = CSTextUtility.calculateSimilarity(file1, file2, encoding);

        return {
            areEqual: comparison.areEqual,
            similarity,
            differences: comparison.differences,
            lineCount1: CSTextUtility.getLineCount(file1, encoding),
            lineCount2: CSTextUtility.getLineCount(file2, encoding)
        };
    }

    /**
     * Assert text files are equal
     */
    static assertTextFilesEqual(file1: string, file2: string, options?: {
        encoding?: BufferEncoding;
        ignoreCase?: boolean;
        ignoreWhitespace?: boolean;
    }): void {
        const result = this.compareTextFiles(file1, file2, options);

        if (!result.areEqual) {
            throw new Error(
                `Text files are not equal:\n` +
                `File 1: ${file1} (${result.lineCount1} lines)\n` +
                `File 2: ${file2} (${result.lineCount2} lines)\n` +
                `Differences found: ${result.differences.length}\n` +
                `Similarity: ${result.similarity.toFixed(2)}%`
            );
        }
    }

    // ===============================
    // EXCEL FILE COMPARISONS
    // ===============================

    /**
     * Compare two Excel files
     */
    static compareExcelFiles(file1: string, file2: string, options?: {
        sheetName?: string;
        compareAsJSON?: boolean;
    }): {
        areEqual: boolean;
        differences: any[];
        sheetCount1: number;
        sheetCount2: number;
    } {
        if (options?.compareAsJSON) {
            const comparison = CSExcelUtility.compareExcelDataAsJSON(file1, file2, options.sheetName);
            return {
                areEqual: comparison.areEqual,
                differences: [...comparison.added, ...comparison.removed, ...comparison.modified],
                sheetCount1: CSExcelUtility.getSheetNames(file1).length,
                sheetCount2: CSExcelUtility.getSheetNames(file2).length
            };
        } else {
            const comparison = CSExcelUtility.compareExcelFiles(file1, file2, options?.sheetName);
            return {
                areEqual: comparison.areEqual,
                differences: comparison.differences,
                sheetCount1: CSExcelUtility.getSheetNames(file1).length,
                sheetCount2: CSExcelUtility.getSheetNames(file2).length
            };
        }
    }

    /**
     * Compare specific sheets in Excel files
     */
    static compareExcelSheets(file: string, sheet1: string, sheet2: string): {
        areEqual: boolean;
        differences: any[];
    } {
        return CSExcelUtility.compareSheets(file, sheet1, sheet2);
    }

    /**
     * Assert Excel files are equal
     */
    static assertExcelFilesEqual(file1: string, file2: string, options?: {
        sheetName?: string;
        compareAsJSON?: boolean;
    }): void {
        const result = this.compareExcelFiles(file1, file2, options);

        if (!result.areEqual) {
            throw new Error(
                `Excel files are not equal:\n` +
                `File 1: ${file1} (${result.sheetCount1} sheets)\n` +
                `File 2: ${file2} (${result.sheetCount2} sheets)\n` +
                `Differences found: ${result.differences.length}`
            );
        }
    }

    // ===============================
    // CSV FILE COMPARISONS
    // ===============================

    /**
     * Compare two CSV files
     */
    static compareCSVFiles(file1: string, file2: string, options?: {
        delimiter?: string;
        compareStructure?: boolean;
    }): {
        areEqual: boolean;
        differences: any[];
        rowCount1: number;
        rowCount2: number;
        columnCount1: number;
        columnCount2: number;
    } {
        const comparison = CSCsvUtility.compareCSVFiles(file1, file2, { delimiter: options?.delimiter });

        return {
            areEqual: comparison.areEqual,
            differences: comparison.differences,
            rowCount1: CSCsvUtility.getRowCount(file1, { delimiter: options?.delimiter }),
            rowCount2: CSCsvUtility.getRowCount(file2, { delimiter: options?.delimiter }),
            columnCount1: CSCsvUtility.getColumnCount(file1, { delimiter: options?.delimiter }),
            columnCount2: CSCsvUtility.getColumnCount(file2, { delimiter: options?.delimiter })
        };
    }

    /**
     * Get detailed CSV differences
     */
    static getCSVDifferences(file1: string, file2: string, options?: {
        delimiter?: string;
    }): {
        areEqual: boolean;
        added: any[];
        removed: any[];
        modified: any[];
    } {
        return CSCsvUtility.getDifferences(file1, file2, { delimiter: options?.delimiter });
    }

    /**
     * Assert CSV files are equal
     */
    static assertCSVFilesEqual(file1: string, file2: string, options?: {
        delimiter?: string;
    }): void {
        const result = this.compareCSVFiles(file1, file2, options);

        if (!result.areEqual) {
            throw new Error(
                `CSV files are not equal:\n` +
                `File 1: ${file1} (${result.rowCount1} rows, ${result.columnCount1} columns)\n` +
                `File 2: ${file2} (${result.rowCount2} rows, ${result.columnCount2} columns)\n` +
                `Differences found: ${result.differences.length}`
            );
        }
    }

    // ===============================
    // JSON FILE COMPARISONS
    // ===============================

    /**
     * Compare two JSON files
     */
    static compareJSONFiles(file1: string, file2: string, options?: {
        ignoreKeyOrder?: boolean;
    }): {
        areEqual: boolean;
        differences: any[];
        keyCount1: number;
        keyCount2: number;
        depth1: number;
        depth2: number;
    } {
        const data1 = CSJsonUtility.readFile(file1);
        const data2 = CSJsonUtility.readFile(file2);

        const comparison = CSJsonUtility.compareFiles(file1, file2);

        return {
            areEqual: comparison.areEqual,
            differences: comparison.differences,
            keyCount1: CSJsonUtility.countKeys(data1),
            keyCount2: CSJsonUtility.countKeys(data2),
            depth1: CSJsonUtility.getDepth(data1),
            depth2: CSJsonUtility.getDepth(data2)
        };
    }

    /**
     * Get detailed JSON differences
     */
    static getJSONDifferences(file1: string, file2: string): {
        areEqual: boolean;
        differences: Array<{ path: string; value1: any; value2: any; type: string }>;
    } {
        const data1 = CSJsonUtility.readFile(file1);
        const data2 = CSJsonUtility.readFile(file2);

        const differences = CSJsonUtility.getDifferences(data1, data2);

        return {
            areEqual: differences.length === 0,
            differences
        };
    }

    /**
     * Get JSON diff report
     */
    static getJSONDiffReport(file1: string, file2: string): {
        areEqual: boolean;
        added: string[];
        removed: string[];
        modified: string[];
    } {
        const data1 = CSJsonUtility.readFile(file1);
        const data2 = CSJsonUtility.readFile(file2);

        return CSJsonUtility.getDiffReport(data1, data2);
    }

    /**
     * Assert JSON files are equal
     */
    static assertJSONFilesEqual(file1: string, file2: string): void {
        const result = this.compareJSONFiles(file1, file2);

        if (!result.areEqual) {
            throw new Error(
                `JSON files are not equal:\n` +
                `File 1: ${file1} (${result.keyCount1} keys, depth ${result.depth1})\n` +
                `File 2: ${file2} (${result.keyCount2} keys, depth ${result.depth2})\n` +
                `Differences found: ${result.differences.length}`
            );
        }
    }

    /**
     * Deep compare JSON objects
     */
    static deepCompareJSON(obj1: any, obj2: any): boolean {
        return CSJsonUtility.deepEquals(obj1, obj2);
    }

    // ===============================
    // PDF FILE COMPARISONS
    // ===============================

    /**
     * Compare two PDF files (byte-level)
     */
    static comparePDFFiles(file1: string, file2: string): {
        areEqual: boolean;
        size1: number;
        size2: number;
        sizeDifference: number;
    } {
        return CSPdfUtility.comparePDFsBytes(file1, file2);
    }

    /**
     * Compare two PDF files (text-based)
     */
    static async comparePDFFilesText(file1: string, file2: string): Promise<{
        areEqual: boolean;
        text1: string;
        text2: string;
        similarity: number;
    }> {
        return await CSPdfUtility.comparePDFsText(file1, file2);
    }

    /**
     * Compare two PDF files visually
     */
    static async comparePDFFilesVisually(file1: string, file2: string, outputDir?: string): Promise<{
        areEqual: boolean;
        differences: Array<{ page: number; isDifferent: boolean }>;
    }> {
        return await CSPdfUtility.comparePDFsVisually(file1, file2, outputDir);
    }

    /**
     * Assert PDF files are equal (byte-level)
     */
    static assertPDFFilesEqual(file1: string, file2: string): void {
        const result = this.comparePDFFiles(file1, file2);

        if (!result.areEqual) {
            throw new Error(
                `PDF files are not equal:\n` +
                `File 1: ${file1} (${result.size1} bytes)\n` +
                `File 2: ${file2} (${result.size2} bytes)\n` +
                `Size difference: ${result.sizeDifference} bytes`
            );
        }
    }

    /**
     * Assert PDF files are equal (text-based)
     */
    static async assertPDFFilesEqualText(file1: string, file2: string, minSimilarity: number = 100): Promise<void> {
        const result = await this.comparePDFFilesText(file1, file2);

        if (!result.areEqual || result.similarity < minSimilarity) {
            throw new Error(
                `PDF files text content is not equal:\n` +
                `File 1: ${file1}\n` +
                `File 2: ${file2}\n` +
                `Similarity: ${result.similarity.toFixed(2)}%\n` +
                `Minimum required: ${minSimilarity}%`
            );
        }
    }

    // ===============================
    // GENERIC FILE COMPARISONS
    // ===============================

    /**
     * Smart comparison - automatically detects file type and compares
     */
    static async smartCompare(file1: string, file2: string, options?: {
        encoding?: BufferEncoding;
        delimiter?: string;
        sheetName?: string;
    }): Promise<{
        fileType: string;
        areEqual: boolean;
        details: any;
    }> {
        const ext1 = path.extname(file1).toLowerCase();
        const ext2 = path.extname(file2).toLowerCase();

        if (ext1 !== ext2) {
            throw new Error(`File types do not match: ${ext1} vs ${ext2}`);
        }

        switch (ext1) {
            case '.txt':
            case '.log':
            case '.md':
                return {
                    fileType: 'text',
                    areEqual: this.compareTextFiles(file1, file2, { encoding: options?.encoding }).areEqual,
                    details: this.compareTextFiles(file1, file2, { encoding: options?.encoding })
                };

            case '.xlsx':
            case '.xls':
                return {
                    fileType: 'excel',
                    areEqual: this.compareExcelFiles(file1, file2, { sheetName: options?.sheetName }).areEqual,
                    details: this.compareExcelFiles(file1, file2, { sheetName: options?.sheetName })
                };

            case '.csv':
                return {
                    fileType: 'csv',
                    areEqual: this.compareCSVFiles(file1, file2, { delimiter: options?.delimiter }).areEqual,
                    details: this.compareCSVFiles(file1, file2, { delimiter: options?.delimiter })
                };

            case '.json':
                return {
                    fileType: 'json',
                    areEqual: this.compareJSONFiles(file1, file2).areEqual,
                    details: this.compareJSONFiles(file1, file2)
                };

            case '.pdf':
                const pdfResult = await this.comparePDFFilesText(file1, file2);
                return {
                    fileType: 'pdf',
                    areEqual: pdfResult.areEqual,
                    details: pdfResult
                };

            default:
                // Default to byte comparison
                const buffer1 = fs.readFileSync(file1);
                const buffer2 = fs.readFileSync(file2);
                return {
                    fileType: 'binary',
                    areEqual: buffer1.equals(buffer2),
                    details: {
                        size1: buffer1.length,
                        size2: buffer2.length,
                        areEqual: buffer1.equals(buffer2)
                    }
                };
        }
    }

    /**
     * Batch compare multiple file pairs
     */
    static async batchCompare(filePairs: Array<{ file1: string; file2: string; type?: string }>): Promise<Array<{
        file1: string;
        file2: string;
        areEqual: boolean;
        error?: string;
    }>> {
        const results: Array<{
            file1: string;
            file2: string;
            areEqual: boolean;
            error?: string;
        }> = [];

        for (const pair of filePairs) {
            try {
                const result = await this.smartCompare(pair.file1, pair.file2);
                results.push({
                    file1: pair.file1,
                    file2: pair.file2,
                    areEqual: result.areEqual
                });
            } catch (error) {
                results.push({
                    file1: pair.file1,
                    file2: pair.file2,
                    areEqual: false,
                    error: String(error)
                });
            }
        }

        return results;
    }

    // ===============================
    // CROSS-FORMAT COMPARISONS
    // ===============================

    /**
     * Compare Excel and CSV files (convert to common format)
     */
    static compareExcelToCSV(excelFile: string, csvFile: string, options?: {
        sheetName?: string;
        delimiter?: string;
    }): {
        areEqual: boolean;
        differences: any[];
    } {
        const excelData = CSExcelUtility.readSheetAsJSON(excelFile, options?.sheetName);
        const csvData = CSCsvUtility.readAsJSON(csvFile, { delimiter: options?.delimiter });

        const areEqual = JSON.stringify(excelData) === JSON.stringify(csvData);

        return {
            areEqual,
            differences: areEqual ? [] : [{ message: 'Data structures differ' }]
        };
    }

    /**
     * Compare CSV and JSON files
     */
    static compareCSVToJSON(csvFile: string, jsonFile: string, options?: {
        delimiter?: string;
    }): {
        areEqual: boolean;
        differences: any[];
    } {
        const csvData = CSCsvUtility.readAsJSON(csvFile, { delimiter: options?.delimiter });
        const jsonData = CSJsonUtility.readFile(jsonFile);

        const areEqual = JSON.stringify(csvData) === JSON.stringify(jsonData);

        return {
            areEqual,
            differences: areEqual ? [] : [{ message: 'Data structures differ' }]
        };
    }

    /**
     * Compare Excel and JSON files
     */
    static compareExcelToJSON(excelFile: string, jsonFile: string, options?: {
        sheetName?: string;
    }): {
        areEqual: boolean;
        differences: any[];
    } {
        const excelData = CSExcelUtility.readSheetAsJSON(excelFile, options?.sheetName);
        const jsonData = CSJsonUtility.readFile(jsonFile);

        const areEqual = JSON.stringify(excelData) === JSON.stringify(jsonData);

        return {
            areEqual,
            differences: areEqual ? [] : [{ message: 'Data structures differ' }]
        };
    }

    // ===============================
    // UTILITY METHODS
    // ===============================

    /**
     * Generate comparison report
     */
    static async generateComparisonReport(file1: string, file2: string, outputPath: string): Promise<void> {
        const result = await this.smartCompare(file1, file2);

        const report = `
Comparison Report
================

File 1: ${file1}
File 2: ${file2}
File Type: ${result.fileType}
Are Equal: ${result.areEqual}

Details:
${JSON.stringify(result.details, null, 2)}

Generated: ${new Date().toISOString()}
        `.trim();

        CSTextUtility.writeFile(outputPath, report);
    }

    /**
     * Calculate file similarity percentage
     */
    static async calculateSimilarity(file1: string, file2: string): Promise<number> {
        const ext = path.extname(file1).toLowerCase();

        switch (ext) {
            case '.txt':
            case '.log':
            case '.md':
                return CSTextUtility.calculateSimilarity(file1, file2);

            case '.pdf':
                const pdfResult = await this.comparePDFFilesText(file1, file2);
                return pdfResult.similarity;

            case '.json':
            case '.csv':
            case '.xlsx':
                const result = await this.smartCompare(file1, file2);
                return result.areEqual ? 100 : 0;

            default:
                const buffer1 = fs.readFileSync(file1);
                const buffer2 = fs.readFileSync(file2);
                return buffer1.equals(buffer2) ? 100 : 0;
        }
    }

    /**
     * Get file type from extension
     */
    static getFileType(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();

        const typeMap: Record<string, string> = {
            '.txt': 'text',
            '.log': 'text',
            '.md': 'text',
            '.xlsx': 'excel',
            '.xls': 'excel',
            '.csv': 'csv',
            '.json': 'json',
            '.pdf': 'pdf'
        };

        return typeMap[ext] || 'unknown';
    }
}
