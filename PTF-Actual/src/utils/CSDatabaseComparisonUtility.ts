// src/utils/CSDatabaseComparisonUtility.ts

import { DatabaseContext } from '../database/context/DatabaseContext';
import { QueryResult } from '../database/types/database.types';
import { CSExcelUtility } from './CSExcelUtility';
import { CSCsvUtility } from './CSCsvUtility';
import { CSJsonUtility } from './CSJsonUtility';
import { CSTextUtility } from './CSTextUtility';
import { CSPdfUtility } from './CSPdfUtility';

/**
 * Comprehensive Database Comparison Utility Class
 * Provides methods to compare database query results with various file formats
 * Supports: Excel, CSV, JSON, Text, PDF comparisons
 */
export class CSDatabaseComparisonUtility {

    private static dbContext = DatabaseContext.getInstance();

    // ===============================
    // DATABASE TO EXCEL COMPARISON
    // ===============================

    /**
     * Compare database query result with Excel file
     */
    static async compareWithExcel(query: string, excelFile: string, options?: {
        sheetName?: string;
        connectionName?: string;
        ignoreColumnOrder?: boolean;
    }): Promise<{
        areEqual: boolean;
        differences: any[];
        dbRowCount: number;
        excelRowCount: number;
        matchedRows: number;
        unmatchedRows: number;
    }> {
        // Execute database query
        const queryResult = await this.dbContext.executeQuery(query, options?.connectionName as any);
        const dbData = queryResult.rows;

        // Read Excel data
        const excelData = CSExcelUtility.readSheetAsJSON(excelFile, options?.sheetName);

        // Compare data
        return this.compareDataSets(dbData, excelData, options?.ignoreColumnOrder);
    }

    /**
     * Assert database query result matches Excel file
     */
    static async assertMatchesExcel(query: string, excelFile: string, options?: {
        sheetName?: string;
        connectionName?: string;
    }): Promise<void> {
        const result = await this.compareWithExcel(query, excelFile, options);

        if (!result.areEqual) {
            throw new Error(
                `Database query result does not match Excel file:\n` +
                `Excel file: ${excelFile}\n` +
                `DB rows: ${result.dbRowCount}\n` +
                `Excel rows: ${result.excelRowCount}\n` +
                `Matched: ${result.matchedRows}\n` +
                `Unmatched: ${result.unmatchedRows}\n` +
                `Differences: ${result.differences.length}`
            );
        }
    }

    /**
     * Export database query result to Excel and compare
     */
    static async exportAndCompareExcel(query: string, excelFile: string, options?: {
        sheetName?: string;
        connectionName?: string;
    }): Promise<void> {
        const queryResult = await this.dbContext.executeQuery(query, options?.connectionName as any);
        CSExcelUtility.writeJSONToExcel(queryResult.rows, excelFile, options?.sheetName || 'Sheet1');
    }

    // ===============================
    // DATABASE TO CSV COMPARISON
    // ===============================

    /**
     * Compare database query result with CSV file
     */
    static async compareWithCSV(query: string, csvFile: string, options?: {
        delimiter?: string;
        connectionName?: string;
        ignoreColumnOrder?: boolean;
    }): Promise<{
        areEqual: boolean;
        differences: any[];
        dbRowCount: number;
        csvRowCount: number;
        matchedRows: number;
        unmatchedRows: number;
    }> {
        // Execute database query
        const queryResult = await this.dbContext.executeQuery(query, options?.connectionName as any);
        const dbData = queryResult.rows;

        // Read CSV data
        const csvData = CSCsvUtility.readAsJSON(csvFile, { delimiter: options?.delimiter });

        // Compare data
        const comparison = this.compareDataSets(dbData, csvData, options?.ignoreColumnOrder);
        return {
            ...comparison,
            csvRowCount: comparison.excelRowCount // Rename for CSV context
        };
    }

    /**
     * Assert database query result matches CSV file
     */
    static async assertMatchesCSV(query: string, csvFile: string, options?: {
        delimiter?: string;
        connectionName?: string;
    }): Promise<void> {
        const result = await this.compareWithCSV(query, csvFile, options);

        if (!result.areEqual) {
            throw new Error(
                `Database query result does not match CSV file:\n` +
                `CSV file: ${csvFile}\n` +
                `DB rows: ${result.dbRowCount}\n` +
                `CSV rows: ${result.csvRowCount}\n` +
                `Matched: ${result.matchedRows}\n` +
                `Unmatched: ${result.unmatchedRows}\n` +
                `Differences: ${result.differences.length}`
            );
        }
    }

    /**
     * Export database query result to CSV and compare
     */
    static async exportAndCompareCSV(query: string, csvFile: string, options?: {
        delimiter?: string;
        connectionName?: string;
    }): Promise<void> {
        const queryResult = await this.dbContext.executeQuery(query, options?.connectionName as any);
        CSCsvUtility.writeFromJSON(queryResult.rows, csvFile, { delimiter: options?.delimiter });
    }

    // ===============================
    // DATABASE TO JSON COMPARISON
    // ===============================

    /**
     * Compare database query result with JSON file
     */
    static async compareWithJSON(query: string, jsonFile: string, options?: {
        connectionName?: string;
        ignoreKeyOrder?: boolean;
    }): Promise<{
        areEqual: boolean;
        differences: any[];
        dbRowCount: number;
        jsonRowCount: number;
        matchedRows: number;
        unmatchedRows: number;
    }> {
        // Execute database query
        const queryResult = await this.dbContext.executeQuery(query, options?.connectionName as any);
        const dbData = queryResult.rows;

        // Read JSON data
        const jsonData = CSJsonUtility.readFile(jsonFile);

        // Ensure JSON data is array
        const jsonArray = Array.isArray(jsonData) ? jsonData : [jsonData];

        // Compare data
        const comparison = this.compareDataSets(dbData, jsonArray, options?.ignoreKeyOrder);
        return {
            ...comparison,
            jsonRowCount: comparison.excelRowCount // Rename for JSON context
        };
    }

    /**
     * Assert database query result matches JSON file
     */
    static async assertMatchesJSON(query: string, jsonFile: string, options?: {
        connectionName?: string;
    }): Promise<void> {
        const result = await this.compareWithJSON(query, jsonFile, options);

        if (!result.areEqual) {
            throw new Error(
                `Database query result does not match JSON file:\n` +
                `JSON file: ${jsonFile}\n` +
                `DB rows: ${result.dbRowCount}\n` +
                `JSON rows: ${result.jsonRowCount}\n` +
                `Matched: ${result.matchedRows}\n` +
                `Unmatched: ${result.unmatchedRows}\n` +
                `Differences: ${result.differences.length}`
            );
        }
    }

    /**
     * Export database query result to JSON
     */
    static async exportToJSON(query: string, jsonFile: string, options?: {
        connectionName?: string;
        pretty?: boolean;
    }): Promise<void> {
        const queryResult = await this.dbContext.executeQuery(query, options?.connectionName as any);
        CSJsonUtility.writeFile(queryResult.rows, jsonFile, { pretty: options?.pretty !== false });
    }

    // ===============================
    // DATABASE TO TEXT COMPARISON
    // ===============================

    /**
     * Compare database query result with text file (line-by-line)
     */
    static async compareWithText(query: string, textFile: string, options?: {
        columnName?: string;
        connectionName?: string;
        encoding?: BufferEncoding;
    }): Promise<{
        areEqual: boolean;
        differences: Array<{ lineNumber: number; dbValue: string; fileValue: string }>;
        dbRowCount: number;
        fileLineCount: number;
    }> {
        // Execute database query
        const queryResult = await this.dbContext.executeQuery(query, options?.connectionName as any);
        const dbData = queryResult.rows;

        // Read text file lines
        const fileLines = CSTextUtility.readLines(textFile, options?.encoding || 'utf8');

        // Extract column values from DB (if specified, otherwise use first column)
        const columnName = options?.columnName || Object.keys(dbData[0] || {})[0];
        const dbValues = dbData.map(row => String(row[columnName] || ''));

        // Compare line by line
        const differences: Array<{ lineNumber: number; dbValue: string; fileValue: string }> = [];
        const maxLines = Math.max(dbValues.length, fileLines.length);

        for (let i = 0; i < maxLines; i++) {
            const dbValue = dbValues[i] || '';
            const fileValue = fileLines[i] || '';

            if (dbValue !== fileValue) {
                differences.push({ lineNumber: i + 1, dbValue, fileValue });
            }
        }

        return {
            areEqual: differences.length === 0,
            differences,
            dbRowCount: dbValues.length,
            fileLineCount: fileLines.length
        };
    }

    /**
     * Assert database query result matches text file
     */
    static async assertMatchesText(query: string, textFile: string, options?: {
        columnName?: string;
        connectionName?: string;
    }): Promise<void> {
        const result = await this.compareWithText(query, textFile, options);

        if (!result.areEqual) {
            throw new Error(
                `Database query result does not match text file:\n` +
                `Text file: ${textFile}\n` +
                `DB rows: ${result.dbRowCount}\n` +
                `File lines: ${result.fileLineCount}\n` +
                `Differences: ${result.differences.length}`
            );
        }
    }

    /**
     * Export database query result to text file
     */
    static async exportToText(query: string, textFile: string, options?: {
        columnName?: string;
        connectionName?: string;
        delimiter?: string;
    }): Promise<void> {
        const queryResult = await this.dbContext.executeQuery(query, options?.connectionName as any);
        const dbData = queryResult.rows;

        if (options?.columnName) {
            // Export single column
            const lines = dbData.map(row => String(row[options.columnName!] || ''));
            CSTextUtility.writeLines(textFile, lines);
        } else {
            // Export all columns (tab-separated by default)
            const delimiter = options?.delimiter || '\t';
            const lines = dbData.map(row =>
                Object.values(row).join(delimiter)
            );
            CSTextUtility.writeLines(textFile, lines);
        }
    }

    // ===============================
    // DATABASE TO PDF COMPARISON
    // ===============================

    /**
     * Compare database query result with PDF file (text extraction)
     */
    static async compareWithPDF(query: string, pdfFile: string, options?: {
        connectionName?: string;
        columnName?: string;
    }): Promise<{
        areEqual: boolean;
        similarity: number;
        dbText: string;
        pdfText: string;
    }> {
        // Execute database query
        const queryResult = await this.dbContext.executeQuery(query, options?.connectionName as any);
        const dbData = queryResult.rows;

        // Convert DB data to text
        const dbText = options?.columnName
            ? dbData.map(row => String(row[options.columnName!] || '')).join('\n')
            : JSON.stringify(dbData, null, 2);

        // Extract text from PDF
        const pdfText = await CSPdfUtility.extractText(pdfFile);

        // Compare texts
        const areEqual = dbText.trim() === pdfText.trim();
        const similarity = this.calculateTextSimilarity(dbText, pdfText);

        return {
            areEqual,
            similarity,
            dbText,
            pdfText
        };
    }

    /**
     * Assert database query result matches PDF file
     */
    static async assertMatchesPDF(query: string, pdfFile: string, options?: {
        connectionName?: string;
        minSimilarity?: number;
    }): Promise<void> {
        const result = await this.compareWithPDF(query, pdfFile, options);

        const minSimilarity = options?.minSimilarity || 100;

        if (!result.areEqual || result.similarity < minSimilarity) {
            throw new Error(
                `Database query result does not match PDF file:\n` +
                `PDF file: ${pdfFile}\n` +
                `Similarity: ${result.similarity.toFixed(2)}%\n` +
                `Minimum required: ${minSimilarity}%`
            );
        }
    }

    /**
     * Export database query result to PDF
     */
    static async exportToPDF(query: string, pdfFile: string, options?: {
        connectionName?: string;
        format?: 'A4' | 'Letter';
        title?: string;
    }): Promise<void> {
        const queryResult = await this.dbContext.executeQuery(query, options?.connectionName as any);
        const dbData = queryResult.rows;

        // Generate HTML table from data
        const html = this.generateHTMLTable(dbData, options?.title);

        // Generate PDF from HTML
        await CSPdfUtility.generateFromHTML(html, pdfFile, {
            format: options?.format || 'A4',
            printBackground: true
        });
    }

    // ===============================
    // ADVANCED COMPARISON OPERATIONS
    // ===============================

    /**
     * Compare two database queries
     */
    static async compareQueries(query1: string, query2: string, options?: {
        connectionName1?: string;
        connectionName2?: string;
        ignoreColumnOrder?: boolean;
    }): Promise<{
        areEqual: boolean;
        differences: any[];
        rowCount1: number;
        rowCount2: number;
        matchedRows: number;
        unmatchedRows: number;
    }> {
        const result1 = await this.dbContext.executeQuery(query1, options?.connectionName1 as any);
        const result2 = await this.dbContext.executeQuery(query2, options?.connectionName2 as any);

        const comparison = this.compareDataSets(result1.rows, result2.rows, options?.ignoreColumnOrder);
        return {
            ...comparison,
            rowCount1: comparison.dbRowCount,
            rowCount2: comparison.excelRowCount
        };
    }

    /**
     * Verify database data against multiple file formats
     */
    static async verifyAgainstMultipleFormats(query: string, files: {
        excel?: string;
        csv?: string;
        json?: string;
        text?: string;
        pdf?: string;
    }, options?: {
        connectionName?: string;
    }): Promise<{
        allMatched: boolean;
        results: Record<string, { matched: boolean; error?: string }>;
    }> {
        const results: Record<string, { matched: boolean; error?: string }> = {};
        let allMatched = true;

        if (files.excel) {
            try {
                const result = await this.compareWithExcel(query, files.excel, options);
                results.excel = { matched: result.areEqual };
                if (!result.areEqual) allMatched = false;
            } catch (error) {
                results.excel = { matched: false, error: String(error) };
                allMatched = false;
            }
        }

        if (files.csv) {
            try {
                const result = await this.compareWithCSV(query, files.csv, options);
                results.csv = { matched: result.areEqual };
                if (!result.areEqual) allMatched = false;
            } catch (error) {
                results.csv = { matched: false, error: String(error) };
                allMatched = false;
            }
        }

        if (files.json) {
            try {
                const result = await this.compareWithJSON(query, files.json, options);
                results.json = { matched: result.areEqual };
                if (!result.areEqual) allMatched = false;
            } catch (error) {
                results.json = { matched: false, error: String(error) };
                allMatched = false;
            }
        }

        if (files.text) {
            try {
                const result = await this.compareWithText(query, files.text, options);
                results.text = { matched: result.areEqual };
                if (!result.areEqual) allMatched = false;
            } catch (error) {
                results.text = { matched: false, error: String(error) };
                allMatched = false;
            }
        }

        if (files.pdf) {
            try {
                const result = await this.compareWithPDF(query, files.pdf, options);
                results.pdf = { matched: result.areEqual };
                if (!result.areEqual) allMatched = false;
            } catch (error) {
                results.pdf = { matched: false, error: String(error) };
                allMatched = false;
            }
        }

        return { allMatched, results };
    }

    /**
     * Get detailed comparison report
     */
    static async generateComparisonReport(query: string, file: string, fileType: 'excel' | 'csv' | 'json' | 'text' | 'pdf', outputPath: string, options?: {
        connectionName?: string;
    }): Promise<void> {
        let result: any;

        switch (fileType) {
            case 'excel':
                result = await this.compareWithExcel(query, file, options);
                break;
            case 'csv':
                result = await this.compareWithCSV(query, file, options);
                break;
            case 'json':
                result = await this.compareWithJSON(query, file, options);
                break;
            case 'text':
                result = await this.compareWithText(query, file, options);
                break;
            case 'pdf':
                result = await this.compareWithPDF(query, file, options);
                break;
        }

        const report = `
Database Comparison Report
==========================

Query: ${query}
File: ${file}
File Type: ${fileType}
Are Equal: ${result.areEqual}

Details:
${JSON.stringify(result, null, 2)}

Generated: ${new Date().toISOString()}
        `.trim();

        CSTextUtility.writeFile(outputPath, report);
    }

    // ===============================
    // PRIVATE HELPER METHODS
    // ===============================

    private static compareDataSets(data1: any[], data2: any[], ignoreOrder?: boolean): {
        areEqual: boolean;
        differences: any[];
        dbRowCount: number;
        excelRowCount: number;
        matchedRows: number;
        unmatchedRows: number;
    } {
        const differences: any[] = [];
        let matchedRows = 0;
        let unmatchedRows = 0;

        // Normalize data for comparison
        const normalize = (obj: any) => {
            const normalized: any = {};
            Object.keys(obj).sort().forEach(key => {
                normalized[key.toLowerCase()] = obj[key];
            });
            return normalized;
        };

        const normalizedData1 = data1.map(normalize);
        const normalizedData2 = data2.map(normalize);

        // Compare row counts
        if (normalizedData1.length !== normalizedData2.length) {
            differences.push({
                type: 'row_count_mismatch',
                data1Count: normalizedData1.length,
                data2Count: normalizedData2.length
            });
        }

        // Compare each row
        const maxRows = Math.max(normalizedData1.length, normalizedData2.length);

        for (let i = 0; i < maxRows; i++) {
            const row1 = normalizedData1[i];
            const row2 = normalizedData2[i];

            if (!row1 || !row2) {
                differences.push({
                    type: 'missing_row',
                    rowIndex: i,
                    row1: row1 || null,
                    row2: row2 || null
                });
                unmatchedRows++;
                continue;
            }

            const row1Str = JSON.stringify(row1);
            const row2Str = JSON.stringify(row2);

            if (row1Str !== row2Str) {
                differences.push({
                    type: 'row_mismatch',
                    rowIndex: i,
                    row1,
                    row2
                });
                unmatchedRows++;
            } else {
                matchedRows++;
            }
        }

        return {
            areEqual: differences.length === 0,
            differences,
            dbRowCount: data1.length,
            excelRowCount: data2.length,
            matchedRows,
            unmatchedRows
        };
    }

    private static calculateTextSimilarity(text1: string, text2: string): number {
        if (text1 === text2) return 100;
        if (!text1 || !text2) return 0;

        const longer = text1.length > text2.length ? text1 : text2;
        const shorter = text1.length > text2.length ? text2 : text1;

        if (longer.length === 0) return 100;

        const editDistance = this.levenshteinDistance(longer, shorter);
        return ((longer.length - editDistance) / longer.length) * 100;
    }

    private static levenshteinDistance(str1: string, str2: string): number {
        const matrix: number[][] = [];

        for (let i = 0; i <= str2.length; i++) {
            matrix[i] = [i];
        }

        for (let j = 0; j <= str1.length; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= str2.length; i++) {
            for (let j = 1; j <= str1.length; j++) {
                if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }

        return matrix[str2.length][str1.length];
    }

    private static generateHTMLTable(data: any[], title?: string): string {
        if (data.length === 0) {
            return '<html><body><p>No data</p></body></html>';
        }

        const headers = Object.keys(data[0]);

        const headerRow = headers.map(h => `<th>${h}</th>`).join('');
        const dataRows = data.map(row =>
            `<tr>${headers.map(h => `<td>${row[h] ?? ''}</td>`).join('')}</tr>`
        ).join('');

        return `
            <!DOCTYPE html>
            <html>
                <head>
                    <meta charset="UTF-8">
                    <style>
                        body { font-family: Arial, sans-serif; padding: 20px; }
                        h1 { color: #333; }
                        table { border-collapse: collapse; width: 100%; margin-top: 20px; }
                        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                        th { background-color: #4CAF50; color: white; }
                        tr:nth-child(even) { background-color: #f2f2f2; }
                    </style>
                </head>
                <body>
                    ${title ? `<h1>${title}</h1>` : ''}
                    <table>
                        <thead><tr>${headerRow}</tr></thead>
                        <tbody>${dataRows}</tbody>
                    </table>
                </body>
            </html>
        `;
    }
}
