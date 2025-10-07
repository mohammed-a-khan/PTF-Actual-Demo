// src/steps/database/DataValidationSteps.ts

import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { DatabaseContext } from '../../database/context/DatabaseContext';
import { CSReporter } from '../../reporter/CSReporter';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';
import { QueryResult } from '../../database/types/database.types';

export class DataValidationSteps {
    private databaseContext: DatabaseContext = new DatabaseContext();
    private configManager: CSConfigurationManager;
    private contextVariables: Map<string, any> = new Map();

    constructor() {
        this.configManager = CSConfigurationManager.getInstance();
    }

    @CSBDDStepDef('the value in row {int} column {string} should be {string}')
    async validateCellValue(row: number, column: string, expectedValue: string): Promise<void> {
        CSReporter.info(`Validating cell value at row ${row}, column '${column}' should be '${expectedValue}'`);

        const result = this.getLastResult();
        const interpolatedExpected = this.interpolateVariables(expectedValue);

        try {
            const actualValue = this.getCellValue(result, row - 1, column);
            const convertedExpected = this.convertExpectedValue(interpolatedExpected);

            if (!this.valuesEqual(actualValue, convertedExpected)) {
                throw new Error(
                    `Cell validation failed at row ${row}, column '${column}'\n` +
                    `Expected: ${interpolatedExpected}\n` +
                    `Actual: ${actualValue}`
                );
            }

            CSReporter.info(`Cell value validation passed: row ${row}, column '${column}' = '${actualValue}'`);

        } catch (error) {
            CSReporter.error(`Cell validation failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Cell validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('the value in row {int} column {string} should contain {string}')
    async validateCellContains(row: number, column: string, expectedSubstring: string): Promise<void> {
        CSReporter.info(`Validating cell at row ${row}, column '${column}' contains '${expectedSubstring}'`);

        const result = this.getLastResult();
        const interpolatedExpected = this.interpolateVariables(expectedSubstring);

        try {
            const actualValue = this.getCellValue(result, row - 1, column);
            const actualString = String(actualValue);

            if (!actualString.includes(interpolatedExpected)) {
                throw new Error(
                    `Value '${actualString}' does not contain '${interpolatedExpected}'`
                );
            }

            CSReporter.info(`Cell contains validation passed: '${actualString}' contains '${interpolatedExpected}'`);

        } catch (error) {
            CSReporter.error(`Cell contains validation failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Cell contains validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('the value in row {int} column {string} should match pattern {string}')
    async validateCellPattern(row: number, column: string, pattern: string): Promise<void> {
        CSReporter.info(`Validating cell at row ${row}, column '${column}' matches pattern '${pattern}'`);

        const result = this.getLastResult();
        const interpolatedPattern = this.interpolateVariables(pattern);

        try {
            const actualValue = this.getCellValue(result, row - 1, column);
            const actualString = String(actualValue);
            const regex = new RegExp(interpolatedPattern);

            if (!regex.test(actualString)) {
                throw new Error(
                    `Value '${actualString}' does not match pattern '${interpolatedPattern}'`
                );
            }

            CSReporter.info(`Cell pattern validation passed: '${actualString}' matches '${interpolatedPattern}'`);

        } catch (error) {
            CSReporter.error(`Cell pattern validation failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Cell pattern validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('the value in row {int} column {string} should be null')
    async validateCellNull(row: number, column: string): Promise<void> {
        CSReporter.info(`Validating cell at row ${row}, column '${column}' is null`);

        const result = this.getLastResult();

        try {
            const actualValue = this.getCellValue(result, row - 1, column);

            if (actualValue !== null && actualValue !== undefined) {
                throw new Error(`Expected null, but got: ${actualValue}`);
            }

            CSReporter.info(`Cell null validation passed: row ${row}, column '${column}' is null`);

        } catch (error) {
            CSReporter.error(`Cell null validation failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Cell null validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('the value in row {int} column {string} should not be null')
    async validateCellNotNull(row: number, column: string): Promise<void> {
        CSReporter.info(`Validating cell at row ${row}, column '${column}' is not null`);

        const result = this.getLastResult();

        try {
            const actualValue = this.getCellValue(result, row - 1, column);

            if (actualValue === null || actualValue === undefined) {
                throw new Error('Expected non-null value, but got null');
            }

            CSReporter.info(`Cell not-null validation passed: row ${row}, column '${column}' = '${actualValue}'`);

        } catch (error) {
            CSReporter.error(`Cell not-null validation failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Cell not-null validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('all values in column {string} should be unique')
    async validateColumnUnique(column: string): Promise<void> {
        CSReporter.info(`Validating all values in column '${column}' are unique`);

        const result = this.getLastResult();

        try {
            const values = result.rows.map(row => row[column]);
            const uniqueValues = new Set(values);

            if (uniqueValues.size !== values.length) {
                const duplicates = values.filter((item, index) => values.indexOf(item) !== index);
                throw new Error(
                    `Column '${column}' contains duplicate values: ${duplicates.join(', ')}`
                );
            }

            CSReporter.info(`Column uniqueness validation passed: ${uniqueValues.size} unique values in column '${column}'`);

        } catch (error) {
            CSReporter.error(`Column uniqueness validation failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Column uniqueness validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('all values in column {string} should be {string}')
    async validateAllColumnValues(column: string, expectedValue: string): Promise<void> {
        CSReporter.info(`Validating all values in column '${column}' are '${expectedValue}'`);

        const result = this.getLastResult();
        const interpolatedExpected = this.interpolateVariables(expectedValue);
        const expectedConverted = this.convertExpectedValue(interpolatedExpected);

        try {
            const mismatchedRows = result.rows.filter((row, index) => {
                const actualValue = row[column];
                return !this.valuesEqual(actualValue, expectedConverted);
            });

            if (mismatchedRows.length > 0) {
                throw new Error(
                    `${mismatchedRows.length} row(s) do not match expected value '${interpolatedExpected}'\n` +
                    `First mismatch: ${mismatchedRows[0][column]}`
                );
            }

            CSReporter.info(`All column values validation passed: ${result.rowCount} rows with value '${expectedConverted}'`);

        } catch (error) {
            CSReporter.error(`All column values validation failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`All column values validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('column {string} should contain value {string}')
    async validateColumnContainsValue(column: string, value: string): Promise<void> {
        CSReporter.info(`Validating column '${column}' contains value '${value}'`);

        const result = this.getLastResult();
        const interpolatedValue = this.interpolateVariables(value);
        const convertedValue = this.convertExpectedValue(interpolatedValue);

        try {
            const found = result.rows.some(row => {
                const cellValue = row[column];
                return this.valuesEqual(cellValue, convertedValue);
            });

            if (!found) {
                throw new Error(`Value '${interpolatedValue}' not found in column '${column}'`);
            }

            CSReporter.info(`Column contains value validation passed: '${interpolatedValue}' found in column '${column}'`);

        } catch (error) {
            CSReporter.error(`Column contains value validation failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Column contains value validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('column {string} should not contain value {string}')
    async validateColumnNotContainsValue(column: string, value: string): Promise<void> {
        CSReporter.info(`Validating column '${column}' does not contain value '${value}'`);

        const result = this.getLastResult();
        const interpolatedValue = this.interpolateVariables(value);
        const convertedValue = this.convertExpectedValue(interpolatedValue);

        try {
            const found = result.rows.some(row => {
                const cellValue = row[column];
                return this.valuesEqual(cellValue, convertedValue);
            });

            if (found) {
                throw new Error(`Value '${interpolatedValue}' found in column '${column}'`);
            }

            CSReporter.info(`Column not contains value validation passed: '${interpolatedValue}' not found in column '${column}'`);

        } catch (error) {
            CSReporter.error(`Column not contains value validation failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Column not contains value validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('the sum of column {string} should be {float}')
    async validateColumnSum(column: string, expectedSum: number): Promise<void> {
        CSReporter.info(`Validating sum of column '${column}' should be ${expectedSum}`);

        const result = this.getLastResult();

        try {
            const actualSum = result.rows.reduce((sum, row) => {
                const value = row[column];
                const numValue = Number(value);

                if (isNaN(numValue)) {
                    throw new Error(`Non-numeric value found in column '${column}': ${value}`);
                }

                return sum + numValue;
            }, 0);

            const tolerance = 0.001;
            if (Math.abs(actualSum - expectedSum) > tolerance) {
                throw new Error(
                    `Expected sum: ${expectedSum}, but got: ${actualSum}`
                );
            }

            CSReporter.info(`Column sum validation passed: column '${column}' sum = ${actualSum}`);

        } catch (error) {
            CSReporter.error(`Column sum validation failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Column sum validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('the average of column {string} should be {float}')
    async validateColumnAverage(column: string, expectedAvg: number): Promise<void> {
        CSReporter.info(`Validating average of column '${column}' should be ${expectedAvg}`);

        const result = this.getLastResult();

        try {
            if (result.rowCount === 0) {
                throw new Error('Cannot calculate average of empty result set');
            }

            const sum = result.rows.reduce((total, row) => {
                const value = row[column];
                const numValue = Number(value);

                if (isNaN(numValue)) {
                    throw new Error(`Non-numeric value found in column '${column}': ${value}`);
                }

                return total + numValue;
            }, 0);

            const actualAvg = sum / result.rowCount;
            const tolerance = 0.001;

            if (Math.abs(actualAvg - expectedAvg) > tolerance) {
                throw new Error(
                    `Expected average: ${expectedAvg}, but got: ${actualAvg.toFixed(3)}`
                );
            }

            CSReporter.info(`Column average validation passed: column '${column}' average = ${actualAvg.toFixed(3)}`);

        } catch (error) {
            CSReporter.error(`Column average validation failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Column average validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('the minimum value in column {string} should be {string}')
    async validateColumnMin(column: string, expectedMin: string): Promise<void> {
        CSReporter.info(`Validating minimum value in column '${column}' should be '${expectedMin}'`);

        const result = this.getLastResult();
        const interpolatedExpected = this.interpolateVariables(expectedMin);

        try {
            if (result.rowCount === 0) {
                throw new Error('Cannot find minimum in empty result set');
            }

            const values = result.rows.map(row => row[column]);
            const minValue = values.reduce((min, val) => {
                if (val === null || val === undefined) return min;

                if (typeof val === 'number' && typeof min === 'number') {
                    return val < min ? val : min;
                } else if (val instanceof Date && min instanceof Date) {
                    return val < min ? val : min;
                } else {
                    return String(val) < String(min) ? val : min;
                }
            }, values[0]);

            const convertedExpected = this.convertExpectedValue(interpolatedExpected);

            if (!this.valuesEqual(minValue, convertedExpected)) {
                throw new Error(
                    `Expected minimum: ${interpolatedExpected}, but got: ${minValue}`
                );
            }

            CSReporter.info(`Column minimum validation passed: column '${column}' min = ${minValue}`);

        } catch (error) {
            CSReporter.error(`Column minimum validation failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Column minimum validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('the maximum value in column {string} should be {string}')
    async validateColumnMax(column: string, expectedMax: string): Promise<void> {
        CSReporter.info(`Validating maximum value in column '${column}' should be '${expectedMax}'`);

        const result = this.getLastResult();
        const interpolatedExpected = this.interpolateVariables(expectedMax);

        try {
            if (result.rowCount === 0) {
                throw new Error('Cannot find maximum in empty result set');
            }

            const values = result.rows.map(row => row[column]);
            const maxValue = values.reduce((max, val) => {
                if (val === null || val === undefined) return max;

                if (typeof val === 'number' && typeof max === 'number') {
                    return val > max ? val : max;
                } else if (val instanceof Date && max instanceof Date) {
                    return val > max ? val : max;
                } else {
                    return String(val) > String(max) ? val : max;
                }
            }, values[0]);

            const convertedExpected = this.convertExpectedValue(interpolatedExpected);

            if (!this.valuesEqual(maxValue, convertedExpected)) {
                throw new Error(
                    `Expected maximum: ${interpolatedExpected}, but got: ${maxValue}`
                );
            }

            CSReporter.info(`Column maximum validation passed: column '${column}' max = ${maxValue}`);

        } catch (error) {
            CSReporter.error(`Column maximum validation failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Column maximum validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('column {string} should have data type {string}')
    async validateColumnDataType(column: string, expectedType: string): Promise<void> {
        CSReporter.info(`Validating column '${column}' has data type '${expectedType}'`);

        const result = this.getLastResult();

        try {
            const columnMeta = result.fields?.find((col: any) => col.name === column);
            if (!columnMeta) {
                throw new Error(`Column '${column}' not found in result set`);
            }

            const actualType = columnMeta.dataType || 'unknown';
            const normalizedActual = actualType.toLowerCase();
            const normalizedExpected = expectedType.toLowerCase();

            if (!this.dataTypesMatch(normalizedActual, normalizedExpected)) {
                throw new Error(
                    `Expected data type '${expectedType}', but got '${actualType}'`
                );
            }

            CSReporter.info(`Column data type validation passed: column '${column}' type = '${actualType}'`);

        } catch (error) {
            CSReporter.error(`Column data type validation failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Column data type validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('values in column {string} should be between {string} and {string}')
    async validateColumnRange(column: string, minValue: string, maxValue: string): Promise<void> {
        CSReporter.info(`Validating values in column '${column}' are between '${minValue}' and '${maxValue}'`);

        const result = this.getLastResult();
        const interpolatedMin = this.interpolateVariables(minValue);
        const interpolatedMax = this.interpolateVariables(maxValue);

        try {
            const minConverted = this.convertExpectedValue(interpolatedMin);
            const maxConverted = this.convertExpectedValue(interpolatedMax);

            const outOfRange = result.rows.filter(row => {
                const value = row[column];
                if (value === null || value === undefined) return false;

                if (typeof value === 'number') {
                    return value < Number(minConverted) || value > Number(maxConverted);
                } else if (value instanceof Date) {
                    const dateValue = value.getTime();
                    const minDate = new Date(minConverted as any).getTime();
                    const maxDate = new Date(maxConverted as any).getTime();
                    return dateValue < minDate || dateValue > maxDate;
                } else {
                    const strValue = String(value);
                    return strValue < String(minConverted) || strValue > String(maxConverted);
                }
            });

            if (outOfRange.length > 0) {
                throw new Error(
                    `${outOfRange.length} value(s) out of range [${interpolatedMin}, ${interpolatedMax}]\n` +
                    `First out-of-range value: ${outOfRange[0][column]}`
                );
            }

            CSReporter.info(`Column range validation passed: ${result.rowCount} values in range [${interpolatedMin}, ${interpolatedMax}]`);

        } catch (error) {
            CSReporter.error(`Column range validation failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Column range validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('the result should have columns:')
    async validateResultColumns(dataTable: any): Promise<void> {
        CSReporter.info('Validating result has expected columns');

        const result = this.getLastResult();
        const expectedColumns = this.parseColumnsTable(dataTable);

        try {
            const actualColumns = result.fields?.map((col: any) => col.name) || Object.keys(result.rows[0] || {});
            const missingColumns = expectedColumns.filter((col: string) => !actualColumns.includes(col));
            const extraColumns = actualColumns.filter((col: string) => !expectedColumns.includes(col));

            if (missingColumns.length > 0 || extraColumns.length > 0) {
                let errorMsg = 'Column mismatch:\n';
                if (missingColumns.length > 0) {
                    errorMsg += `Missing columns: ${missingColumns.join(', ')}\n`;
                }
                if (extraColumns.length > 0) {
                    errorMsg += `Extra columns: ${extraColumns.join(', ')}\n`;
                }
                errorMsg += `Expected: ${expectedColumns.join(', ')}\n`;
                errorMsg += `Actual: ${actualColumns.join(', ')}`;
                throw new Error(errorMsg);
            }

            CSReporter.info(`Result columns validation passed: ${expectedColumns.length} columns match`);

        } catch (error) {
            CSReporter.error(`Result columns validation failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Result columns validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('the result should match:')
    async validateResultData(dataTable: any): Promise<void> {
        CSReporter.info('Validating result data matches expected data');

        const result = this.getLastResult();
        const expectedData = this.parseExpectedData(dataTable);

        try {
            if (expectedData.length !== result.rowCount) {
                throw new Error(
                    `Row count mismatch. Expected: ${expectedData.length}, Actual: ${result.rowCount}`
                );
            }

            for (let i = 0; i < expectedData.length; i++) {
                const expectedRow = expectedData[i];
                const actualRow = result.rows[i];

                for (const column of Object.keys(expectedRow || {})) {
                    const expected = expectedRow![column];
                    const actual = actualRow![column];

                    if (!this.valuesEqual(actual, expected)) {
                        throw new Error(
                            `Mismatch at row ${i + 1}, column '${column}'\n` +
                            `Expected: ${expected}\n` +
                            `Actual: ${actual}`
                        );
                    }
                }
            }

            CSReporter.info(`Result data validation passed: ${expectedData.length} rows and ${Object.keys(expectedData[0] || {}).length} columns match`);

        } catch (error) {
            CSReporter.error(`Result data validation failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Result data validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('the scalar result should be {string}')
    async validateScalarResult(expectedValue: string): Promise<void> {
        CSReporter.info(`Validating scalar result should be '${expectedValue}'`);

        const result = this.getLastResult();
        if (!result || result.rowCount === 0 || !result.rows[0]) {
            throw new Error('No scalar result available. Execute a scalar query first');
        }

        const columns = Object.keys(result.rows[0]);
        if (columns.length === 0) {
            throw new Error('No columns in result');
        }
        const firstColumn = columns[0];
        if (!firstColumn) {
            throw new Error('No column found in result');
        }
        const scalarResult = result.rows[0][firstColumn];

        const interpolatedExpected = this.interpolateVariables(expectedValue);
        const convertedExpected = this.convertExpectedValue(interpolatedExpected);

        try {
            if (!this.valuesEqual(scalarResult, convertedExpected)) {
                throw new Error(
                    `Scalar result mismatch\n` +
                    `Expected: ${interpolatedExpected} (${typeof convertedExpected})\n` +
                    `Actual: ${scalarResult} (${typeof scalarResult})`
                );
            }

            CSReporter.info(`Scalar result validation passed: ${scalarResult}`);

        } catch (error) {
            CSReporter.error(`Scalar result validation failed: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Scalar result validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private getLastResult(): QueryResult {
        const result = this.databaseContext.getStoredResult('last');
        if (!result) {
            throw new Error('No query result available. Execute a query first');
        }
        return result;
    }

    private getCellValue(result: QueryResult, rowIndex: number, column: string): any {
        if (rowIndex < 0 || rowIndex >= result.rowCount) {
            throw new Error(`Row index ${rowIndex + 1} out of bounds (1-${result.rowCount})`);
        }

        const row = result.rows[rowIndex];
        if (!(column in row)) {
            const availableColumns = Object.keys(row).join(', ');
            throw new Error(
                `Column '${column}' not found. Available columns: ${availableColumns}`
            );
        }

        return row[column];
    }

    private convertExpectedValue(value: string): any {
        if (value.toLowerCase() === 'null') return null;
        if (value.toLowerCase() === 'true') return true;
        if (value.toLowerCase() === 'false') return false;

        if (/^-?\d+$/.test(value)) return parseInt(value);
        if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);

        if (/^\d{4}-\d{2}-\d{2}/.test(value)) return new Date(value);

        if (value === "''") return '';

        return value;
    }

    private valuesEqual(actual: any, expected: any): boolean {
        if (actual === null || actual === undefined) {
            return expected === null || expected === undefined || expected === 'null';
        }

        if (actual instanceof Date && expected instanceof Date) {
            return actual.getTime() === expected.getTime();
        }

        if (typeof actual === 'number' && typeof expected === 'number') {
            return Math.abs(actual - expected) < 0.001;
        }

        return actual === expected;
    }

    private dataTypesMatch(actual: string, expected: string): boolean {
        const typeMap: Record<string, string[]> = {
            'string': ['varchar', 'char', 'text', 'nvarchar', 'nchar', 'string'],
            'number': ['int', 'integer', 'decimal', 'numeric', 'float', 'double', 'real', 'number'],
            'boolean': ['bool', 'boolean', 'bit'],
            'date': ['date', 'datetime', 'timestamp', 'time'],
            'json': ['json', 'jsonb']
        };

        for (const [type, aliases] of Object.entries(typeMap)) {
            if (aliases.includes(expected) && aliases.includes(actual)) {
                return true;
            }
        }

        return actual === expected;
    }

    private parseColumnsTable(dataTable: any): string[] {
        const columns: string[] = [];

        if (dataTable && dataTable.raw) {
            dataTable.raw().forEach((row: string[]) => {
                if (row && row.length > 0) {
                    const value = row[0];
                    if (value !== undefined && value !== null) {
                        columns.push(value.trim());
                    }
                }
            });
        } else if (dataTable && dataTable.rawTable) {
            dataTable.rawTable.forEach((row: string[]) => {
                if (row && row.length > 0) {
                    const value = row[0];
                    if (value !== undefined && value !== null) {
                        columns.push(value.trim());
                    }
                }
            });
        }

        return columns;
    }

    private parseExpectedData(dataTable: any): Record<string, any>[] {
        const data: Record<string, any>[] = [];
        let rawData: string[][] | undefined;

        if (dataTable && dataTable.raw) {
            rawData = dataTable.raw();
        } else if (dataTable && dataTable.rawTable) {
            rawData = dataTable.rawTable;
        }

        if (rawData && rawData.length > 0) {
            const firstRow = rawData[0];
            if (!firstRow) {
                return data;
            }
            const headers = firstRow.map((h: string) => h.trim());

            for (let i = 1; i < rawData.length; i++) {
                const row = rawData[i];
                const rowData: Record<string, any> = {};

                headers.forEach((header: string, index: number) => {
                    if (row && row[index] !== undefined) {
                        const value = row[index].trim();
                        const interpolated = this.interpolateVariables(value);
                        rowData[header] = this.convertExpectedValue(interpolated);
                    } else {
                        rowData[header] = null;
                    }
                });

                data.push(rowData);
            }
        }

        return data;
    }

    private interpolateVariables(text: string): string {
        text = text.replace(/\${([^}]+)}/g, (match, varName) => {
            return process.env[varName] || match;
        });

        text = text.replace(/{{([^}]+)}}/g, (match, varName) => {
            const retrieved = this.contextVariables.get(varName);
            return retrieved !== undefined ? String(retrieved) : match;
        });

        text = text.replace(/%([^%]+)%/g, (match, varName) => {
            return this.configManager.get(varName, match) as string;
        });

        return text;
    }
}