// src/utils/CSExcelUtility.ts

import * as fs from 'fs';
import * as path from 'path';

// Lazy load xlsx to avoid requiring it at startup (optional dependency)
let XLSX: any = null;
function getXLSX(): any {
    if (!XLSX) {
        try {
            XLSX = require('xlsx');
        } catch (error) {
            throw new Error('XLSX not installed. Run: npm install xlsx');
        }
    }
    return XLSX;
}

/**
 * Comprehensive Excel Utility Class
 * Provides extensive Excel file operations, reading, writing, comparison, and transformation
 */
export class CSExcelUtility {

    // ===============================
    // READING OPERATIONS
    // ===============================

    /**
     * Read Excel file and return workbook
     */
    static readWorkbook(filePath: string): any {
        if (!fs.existsSync(filePath)) {
            throw new Error(`Excel file not found: ${filePath}`);
        }
        return getXLSX().readFile(filePath);
    }

    /**
     * Read Excel file with specific options
     */
    static readWorkbookWithOptions(filePath: string, options: any): any {
        if (!fs.existsSync(filePath)) {
            throw new Error(`Excel file not found: ${filePath}`);
        }
        return getXLSX().readFile(filePath, options);
    }

    /**
     * Get all sheet names from Excel file
     */
    static getSheetNames(filePath: string): string[] {
        const workbook = this.readWorkbook(filePath);
        return workbook.SheetNames;
    }

    /**
     * Read specific sheet as JSON array
     */
    static readSheetAsJSON<T = any>(filePath: string, sheetName?: string): T[] {
        const workbook = this.readWorkbook(filePath);
        const sheet = sheetName ? workbook.Sheets[sheetName] : workbook.Sheets[workbook.SheetNames[0]];

        if (!sheet) {
            throw new Error(`Sheet ${sheetName || 'default'} not found in ${filePath}`);
        }

        return getXLSX().utils.sheet_to_json(sheet) as T[];
    }

    /**
     * Read specific sheet as 2D array
     */
    static readSheetAsArray(filePath: string, sheetName?: string): any[][] {
        const workbook = this.readWorkbook(filePath);
        const sheet = sheetName ? workbook.Sheets[sheetName] : workbook.Sheets[workbook.SheetNames[0]];

        if (!sheet) {
            throw new Error(`Sheet ${sheetName || 'default'} not found in ${filePath}`);
        }

        return getXLSX().utils.sheet_to_json(sheet, { header: 1 }) as any[][];
    }

    /**
     * Read specific sheet as CSV string
     */
    static readSheetAsCSV(filePath: string, sheetName?: string): string {
        const workbook = this.readWorkbook(filePath);
        const sheet = sheetName ? workbook.Sheets[sheetName] : workbook.Sheets[workbook.SheetNames[0]];

        if (!sheet) {
            throw new Error(`Sheet ${sheetName || 'default'} not found in ${filePath}`);
        }

        return getXLSX().utils.sheet_to_csv(sheet);
    }

    /**
     * Read specific cell value
     */
    static readCellValue(filePath: string, cellAddress: string, sheetName?: string): any {
        const workbook = this.readWorkbook(filePath);
        const sheet = sheetName ? workbook.Sheets[sheetName] : workbook.Sheets[workbook.SheetNames[0]];

        if (!sheet) {
            throw new Error(`Sheet ${sheetName || 'default'} not found in ${filePath}`);
        }

        const cell = sheet[cellAddress];
        return cell ? cell.v : undefined;
    }

    /**
     * Read range of cells
     */
    static readCellRange(filePath: string, range: string, sheetName?: string): any[][] {
        const workbook = this.readWorkbook(filePath);
        const sheet = sheetName ? workbook.Sheets[sheetName] : workbook.Sheets[workbook.SheetNames[0]];

        if (!sheet) {
            throw new Error(`Sheet ${sheetName || 'default'} not found in ${filePath}`);
        }

        const decodedRange = getXLSX().utils.decode_range(range);
        const result: any[][] = [];

        for (let R = decodedRange.s.r; R <= decodedRange.e.r; ++R) {
            const row: any[] = [];
            for (let C = decodedRange.s.c; C <= decodedRange.e.c; ++C) {
                const cellAddress = getXLSX().utils.encode_cell({ r: R, c: C });
                const cell = sheet[cellAddress];
                row.push(cell ? cell.v : undefined);
            }
            result.push(row);
        }

        return result;
    }

    /**
     * Get row count in sheet
     */
    static getRowCount(filePath: string, sheetName?: string): number {
        const data = this.readSheetAsArray(filePath, sheetName);
        return data.length;
    }

    /**
     * Get column count in sheet
     */
    static getColumnCount(filePath: string, sheetName?: string): number {
        const data = this.readSheetAsArray(filePath, sheetName);
        return data.length > 0 ? data[0].length : 0;
    }

    /**
     * Get used range of sheet (e.g., "A1:D10")
     */
    static getUsedRange(filePath: string, sheetName?: string): string | undefined {
        const workbook = this.readWorkbook(filePath);
        const sheet = sheetName ? workbook.Sheets[sheetName] : workbook.Sheets[workbook.SheetNames[0]];

        if (!sheet) {
            throw new Error(`Sheet ${sheetName || 'default'} not found in ${filePath}`);
        }

        return sheet['!ref'];
    }

    /**
     * Read specific column by index (0-based)
     */
    static readColumnByIndex(filePath: string, columnIndex: number, sheetName?: string): any[] {
        const data = this.readSheetAsArray(filePath, sheetName);
        return data.map(row => row[columnIndex]);
    }

    /**
     * Read specific column by name (from header row)
     */
    static readColumnByName(filePath: string, columnName: string, sheetName?: string): any[] {
        const data = this.readSheetAsJSON(filePath, sheetName);
        return data.map((row: any) => row[columnName]);
    }

    /**
     * Read specific row by index (0-based)
     */
    static readRowByIndex(filePath: string, rowIndex: number, sheetName?: string): any[] {
        const data = this.readSheetAsArray(filePath, sheetName);
        return data[rowIndex] || [];
    }

    /**
     * Find rows matching criteria
     */
    static findRows(filePath: string, predicate: (row: any) => boolean, sheetName?: string): any[] {
        const data = this.readSheetAsJSON(filePath, sheetName);
        return data.filter(predicate);
    }

    /**
     * Find first row matching criteria
     */
    static findRow(filePath: string, predicate: (row: any) => boolean, sheetName?: string): any | undefined {
        const data = this.readSheetAsJSON(filePath, sheetName);
        return data.find(predicate);
    }

    /**
     * Check if cell exists and has value
     */
    static cellHasValue(filePath: string, cellAddress: string, sheetName?: string): boolean {
        const value = this.readCellValue(filePath, cellAddress, sheetName);
        return value !== undefined && value !== null && value !== '';
    }

    // ===============================
    // WRITING OPERATIONS
    // ===============================

    /**
     * Create new Excel workbook
     */
    static createWorkbook(): any {
        return getXLSX().utils.book_new();
    }

    /**
     * Write workbook to file
     */
    static writeWorkbook(workbook: any, filePath: string, options?: any): void {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        getXLSX().writeFile(workbook, filePath, options);
    }

    /**
     * Write JSON array to Excel file
     */
    static writeJSONToExcel<T = any>(data: T[], filePath: string, sheetName: string = 'Sheet1', options?: any): void {
        const workbook = this.createWorkbook();
        const worksheet = getXLSX().utils.json_to_sheet(data);
        getXLSX().utils.book_append_sheet(workbook, worksheet, sheetName);
        this.writeWorkbook(workbook, filePath, options);
    }

    /**
     * Write 2D array to Excel file
     */
    static writeArrayToExcel(data: any[][], filePath: string, sheetName: string = 'Sheet1', options?: any): void {
        const workbook = this.createWorkbook();
        const worksheet = getXLSX().utils.aoa_to_sheet(data);
        getXLSX().utils.book_append_sheet(workbook, worksheet, sheetName);
        this.writeWorkbook(workbook, filePath, options);
    }

    /**
     * Add sheet to existing workbook file
     */
    static addSheetToFile(filePath: string, data: any[], sheetName: string, isJSON: boolean = true): void {
        let workbook: any;

        if (fs.existsSync(filePath)) {
            workbook = this.readWorkbook(filePath);
        } else {
            workbook = this.createWorkbook();
        }

        const worksheet = isJSON
            ? getXLSX().utils.json_to_sheet(data)
            : getXLSX().utils.aoa_to_sheet(data);

        getXLSX().utils.book_append_sheet(workbook, worksheet, sheetName);
        this.writeWorkbook(workbook, filePath);
    }

    /**
     * Update specific cell value
     */
    static updateCellValue(filePath: string, cellAddress: string, value: any, sheetName?: string): void {
        const workbook = this.readWorkbook(filePath);
        const sheet = sheetName ? workbook.Sheets[sheetName] : workbook.Sheets[workbook.SheetNames[0]];

        if (!sheet) {
            throw new Error(`Sheet ${sheetName || 'default'} not found in ${filePath}`);
        }

        if (!sheet[cellAddress]) {
            sheet[cellAddress] = { t: 's', v: value };
        } else {
            sheet[cellAddress].v = value;
        }

        this.writeWorkbook(workbook, filePath);
    }

    /**
     * Delete sheet from workbook
     */
    static deleteSheet(filePath: string, sheetName: string): void {
        const workbook = this.readWorkbook(filePath);
        delete workbook.Sheets[sheetName];
        workbook.SheetNames = workbook.SheetNames.filter((name: string) => name !== sheetName);
        this.writeWorkbook(workbook, filePath);
    }

    /**
     * Rename sheet
     */
    static renameSheet(filePath: string, oldName: string, newName: string): void {
        const workbook = this.readWorkbook(filePath);

        if (!workbook.Sheets[oldName]) {
            throw new Error(`Sheet ${oldName} not found`);
        }

        workbook.Sheets[newName] = workbook.Sheets[oldName];
        delete workbook.Sheets[oldName];
        workbook.SheetNames = workbook.SheetNames.map((name: string) => name === oldName ? newName : name);

        this.writeWorkbook(workbook, filePath);
    }

    /**
     * Copy sheet within same workbook
     */
    static copySheet(filePath: string, sourceSheet: string, targetSheet: string): void {
        const workbook = this.readWorkbook(filePath);

        if (!workbook.Sheets[sourceSheet]) {
            throw new Error(`Source sheet ${sourceSheet} not found`);
        }

        const sourceData = getXLSX().utils.sheet_to_json(workbook.Sheets[sourceSheet], { header: 1 }) as any[][];
        const newSheet = getXLSX().utils.aoa_to_sheet(sourceData);

        getXLSX().utils.book_append_sheet(workbook, newSheet, targetSheet);
        this.writeWorkbook(workbook, filePath);
    }

    /**
     * Append rows to existing sheet
     */
    static appendRows(filePath: string, rows: any[], sheetName?: string, isJSON: boolean = true): void {
        const workbook = this.readWorkbook(filePath);
        const sheet = sheetName ? workbook.Sheets[sheetName] : workbook.Sheets[workbook.SheetNames[0]];

        if (!sheet) {
            throw new Error(`Sheet ${sheetName || 'default'} not found in ${filePath}`);
        }

        const existingData = isJSON
            ? getXLSX().utils.sheet_to_json(sheet)
            : getXLSX().utils.sheet_to_json(sheet, { header: 1 });

        const combinedData = [...existingData, ...rows];
        const newSheet = isJSON
            ? getXLSX().utils.json_to_sheet(combinedData)
            : getXLSX().utils.aoa_to_sheet(combinedData);

        workbook.Sheets[sheetName || workbook.SheetNames[0]] = newSheet;
        this.writeWorkbook(workbook, filePath);
    }

    // ===============================
    // TRANSFORMATION OPERATIONS
    // ===============================

    /**
     * Convert Excel to JSON
     */
    static excelToJSON<T = any>(filePath: string, sheetName?: string): T[] {
        return this.readSheetAsJSON<T>(filePath, sheetName);
    }

    /**
     * Convert Excel to CSV
     */
    static excelToCSV(filePath: string, outputPath: string, sheetName?: string): void {
        const csv = this.readSheetAsCSV(filePath, sheetName);
        fs.writeFileSync(outputPath, csv, 'utf8');
    }

    /**
     * Convert CSV to Excel
     */
    static csvToExcel(csvPath: string, excelPath: string, sheetName: string = 'Sheet1'): void {
        const csvContent = fs.readFileSync(csvPath, 'utf8');
        const workbook = getXLSX().read(csvContent, { type: 'string' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];

        const newWorkbook = this.createWorkbook();
        getXLSX().utils.book_append_sheet(newWorkbook, sheet, sheetName);
        this.writeWorkbook(newWorkbook, excelPath);
    }

    /**
     * Convert JSON to Excel
     */
    static jsonToExcel<T = any>(data: T[], excelPath: string, sheetName: string = 'Sheet1'): void {
        this.writeJSONToExcel(data, excelPath, sheetName);
    }

    /**
     * Merge multiple Excel files into one
     */
    static mergeExcelFiles(filePaths: string[], outputPath: string): void {
        const workbook = this.createWorkbook();

        filePaths.forEach((filePath, index) => {
            const sourceWorkbook = this.readWorkbook(filePath);
            sourceWorkbook.SheetNames.forEach((sheetName: string, sheetIndex: number) => {
                const sheet = sourceWorkbook.Sheets[sheetName];
                const newSheetName = `File${index + 1}_${sheetName}`;
                getXLSX().utils.book_append_sheet(workbook, sheet, newSheetName);
            });
        });

        this.writeWorkbook(workbook, outputPath);
    }

    /**
     * Split Excel file by sheets
     */
    static splitExcelBySheets(filePath: string, outputDir: string): void {
        const workbook = this.readWorkbook(filePath);

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        workbook.SheetNames.forEach((sheetName: string) => {
            const newWorkbook = this.createWorkbook();
            getXLSX().utils.book_append_sheet(newWorkbook, workbook.Sheets[sheetName], sheetName);

            const outputPath = path.join(outputDir, `${sheetName}.xlsx`);
            this.writeWorkbook(newWorkbook, outputPath);
        });
    }

    /**
     * Transpose sheet data (rows to columns)
     */
    static transposeSheet(filePath: string, outputPath: string, sheetName?: string): void {
        const data = this.readSheetAsArray(filePath, sheetName);

        if (data.length === 0) {
            throw new Error('Sheet is empty');
        }

        const transposed: any[][] = [];
        const maxCols = Math.max(...data.map(row => row.length));

        for (let col = 0; col < maxCols; col++) {
            const newRow: any[] = [];
            for (let row = 0; row < data.length; row++) {
                newRow.push(data[row][col]);
            }
            transposed.push(newRow);
        }

        this.writeArrayToExcel(transposed, outputPath, sheetName || 'Sheet1');
    }

    // ===============================
    // COMPARISON OPERATIONS
    // ===============================

    /**
     * Compare two Excel files
     */
    static compareExcelFiles(file1: string, file2: string, sheetName?: string): {
        areEqual: boolean;
        differences: Array<{ cell: string; value1: any; value2: any }>;
    } {
        const data1 = this.readSheetAsArray(file1, sheetName);
        const data2 = this.readSheetAsArray(file2, sheetName);

        const differences: Array<{ cell: string; value1: any; value2: any }> = [];

        const maxRows = Math.max(data1.length, data2.length);
        const maxCols = Math.max(
            Math.max(...data1.map(row => row.length)),
            Math.max(...data2.map(row => row.length))
        );

        for (let row = 0; row < maxRows; row++) {
            for (let col = 0; col < maxCols; col++) {
                const val1 = data1[row]?.[col];
                const val2 = data2[row]?.[col];

                if (val1 !== val2) {
                    const cellAddress = getXLSX().utils.encode_cell({ r: row, c: col });
                    differences.push({ cell: cellAddress, value1: val1, value2: val2 });
                }
            }
        }

        return {
            areEqual: differences.length === 0,
            differences
        };
    }

    /**
     * Compare two sheets within same file
     */
    static compareSheets(filePath: string, sheet1: string, sheet2: string): {
        areEqual: boolean;
        differences: Array<{ cell: string; value1: any; value2: any }>;
    } {
        const data1 = this.readSheetAsArray(filePath, sheet1);
        const data2 = this.readSheetAsArray(filePath, sheet2);

        const differences: Array<{ cell: string; value1: any; value2: any }> = [];

        const maxRows = Math.max(data1.length, data2.length);
        const maxCols = Math.max(
            Math.max(...data1.map(row => row.length)),
            Math.max(...data2.map(row => row.length))
        );

        for (let row = 0; row < maxRows; row++) {
            for (let col = 0; col < maxCols; col++) {
                const val1 = data1[row]?.[col];
                const val2 = data2[row]?.[col];

                if (val1 !== val2) {
                    const cellAddress = getXLSX().utils.encode_cell({ r: row, c: col });
                    differences.push({ cell: cellAddress, value1: val1, value2: val2 });
                }
            }
        }

        return {
            areEqual: differences.length === 0,
            differences
        };
    }

    /**
     * Check if cell value equals expected
     */
    static verifyCellValue(filePath: string, cellAddress: string, expectedValue: any, sheetName?: string): boolean {
        const actualValue = this.readCellValue(filePath, cellAddress, sheetName);
        return actualValue === expectedValue;
    }

    /**
     * Get differences between two JSON datasets from Excel
     */
    static compareExcelDataAsJSON(file1: string, file2: string, sheetName?: string): {
        areEqual: boolean;
        added: any[];
        removed: any[];
        modified: any[];
    } {
        const data1 = this.readSheetAsJSON(file1, sheetName);
        const data2 = this.readSheetAsJSON(file2, sheetName);

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
     * Check if file is valid Excel file
     */
    static isValidExcelFile(filePath: string): boolean {
        try {
            if (!fs.existsSync(filePath)) return false;
            const ext = path.extname(filePath).toLowerCase();
            if (!['.xlsx', '.xls', '.xlsm', '.xlsb'].includes(ext)) return false;

            this.readWorkbook(filePath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get Excel file metadata
     */
    static getFileMetadata(filePath: string): {
        sheetCount: number;
        sheetNames: string[];
        fileSize: number;
        extension: string;
    } {
        const workbook = this.readWorkbook(filePath);
        const stats = fs.statSync(filePath);

        return {
            sheetCount: workbook.SheetNames.length,
            sheetNames: workbook.SheetNames,
            fileSize: stats.size,
            extension: path.extname(filePath)
        };
    }

    /**
     * Search for value in Excel file
     */
    static searchValue(filePath: string, searchValue: any, sheetName?: string): Array<{ sheet: string; cell: string; value: any }> {
        const results: Array<{ sheet: string; cell: string; value: any }> = [];
        const workbook = this.readWorkbook(filePath);

        const sheetsToSearch = sheetName ? [sheetName] : workbook.SheetNames;

        sheetsToSearch.forEach((sheet: string) => {
            const worksheet = workbook.Sheets[sheet];
            const range = worksheet['!ref'];

            if (!range) return;

            const decodedRange = getXLSX().utils.decode_range(range);

            for (let R = decodedRange.s.r; R <= decodedRange.e.r; ++R) {
                for (let C = decodedRange.s.c; C <= decodedRange.e.c; ++C) {
                    const cellAddress = getXLSX().utils.encode_cell({ r: R, c: C });
                    const cell = worksheet[cellAddress];

                    if (cell && cell.v === searchValue) {
                        results.push({ sheet, cell: cellAddress, value: cell.v });
                    }
                }
            }
        });

        return results;
    }

    /**
     * Get distinct values from column
     */
    static getDistinctValues(filePath: string, columnName: string, sheetName?: string): any[] {
        const values = this.readColumnByName(filePath, columnName, sheetName);
        return [...new Set(values)];
    }

    /**
     * Filter sheet data by criteria
     */
    static filterData(filePath: string, predicate: (row: any) => boolean, sheetName?: string): any[] {
        return this.findRows(filePath, predicate, sheetName);
    }

    /**
     * Sort sheet data
     */
    static sortData(filePath: string, sortKey: string, ascending: boolean = true, sheetName?: string): any[] {
        const data = this.readSheetAsJSON(filePath, sheetName);

        return data.sort((a, b) => {
            const aVal = a[sortKey];
            const bVal = b[sortKey];

            if (aVal < bVal) return ascending ? -1 : 1;
            if (aVal > bVal) return ascending ? 1 : -1;
            return 0;
        });
    }

    /**
     * Get summary statistics for numeric column
     */
    static getColumnStatistics(filePath: string, columnName: string, sheetName?: string): {
        count: number;
        sum: number;
        average: number;
        min: number;
        max: number;
    } {
        const values = this.readColumnByName(filePath, columnName, sheetName)
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
     * Export sheet to HTML
     */
    static sheetToHTML(filePath: string, outputPath: string, sheetName?: string): void {
        const workbook = this.readWorkbook(filePath);
        const sheet = sheetName ? workbook.Sheets[sheetName] : workbook.Sheets[workbook.SheetNames[0]];

        if (!sheet) {
            throw new Error(`Sheet ${sheetName || 'default'} not found in ${filePath}`);
        }

        const html = getXLSX().utils.sheet_to_html(sheet);
        fs.writeFileSync(outputPath, html, 'utf8');
    }

    /**
     * Clone Excel file
     */
    static cloneFile(sourcePath: string, targetPath: string): void {
        fs.copyFileSync(sourcePath, targetPath);
    }

    /**
     * Clear sheet data (keep structure)
     */
    static clearSheet(filePath: string, sheetName?: string): void {
        const workbook = this.readWorkbook(filePath);
        const targetSheet = sheetName || workbook.SheetNames[0];

        workbook.Sheets[targetSheet] = getXLSX().utils.aoa_to_sheet([]);
        this.writeWorkbook(workbook, filePath);
    }
}
