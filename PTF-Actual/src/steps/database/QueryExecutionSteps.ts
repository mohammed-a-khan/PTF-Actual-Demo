// src/steps/database/QueryExecutionSteps.ts

import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { DatabaseContext } from '../../database/context/DatabaseContext';
import { CSReporter } from '../../reporter/CSReporter';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';
import { QueryResult } from '../../database/types/database.types';
import * as fs from 'fs';

export class QueryExecutionSteps {
    private databaseContext: DatabaseContext = new DatabaseContext();
    private configManager: CSConfigurationManager;
    private contextVariables: Map<string, any> = new Map();

    constructor() {
        this.configManager = CSConfigurationManager.getInstance();
    }

    @CSBDDStepDef('user executes query from file {string}')
    async executeQueryFromFile(filePath: string): Promise<void> {
        CSReporter.info(`Executing query from file: ${filePath}`);

        try {
            const resolvedPath = this.resolveFilePath(filePath);
            const content = await fs.promises.readFile(resolvedPath, 'utf-8');
            const query = content;
            const interpolatedQuery = this.interpolateVariables(query);

            const startTime = Date.now();
            const result = await this.databaseContext.executeQuery(interpolatedQuery);
            const executionTime = Date.now() - startTime;

            this.databaseContext.storeResult('last', result);
            this.contextVariables.set('lastQueryResult', result);
            this.contextVariables.set('lastQueryExecutionTime', executionTime);

            CSReporter.info(`Query from file executed successfully. Rows: ${result.rowCount}, Time: ${executionTime}ms`);

        } catch (error) {
            CSReporter.error(`Failed to execute query from file '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to execute query from file '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user executes parameterized query {string} with parameters:')
    async executeParameterizedQuery(query: string, dataTable: any): Promise<void> {
        CSReporter.info(`Executing parameterized query: ${this.sanitizeQueryForLog(query)}`);

        try {
            const parameters = this.parseParametersTable(dataTable);
            const interpolatedQuery = this.interpolateVariables(query);

            const startTime = Date.now();
            const result = await this.databaseContext.executeQuery(interpolatedQuery, Array.isArray(parameters) ? parameters : Object.values(parameters));
            const executionTime = Date.now() - startTime;

            this.databaseContext.storeResult('last', result);
            this.contextVariables.set('lastQueryResult', result);
            this.contextVariables.set('lastQueryExecutionTime', executionTime);

            CSReporter.info(`Parameterized query executed successfully. Rows: ${result.rowCount}, Time: ${executionTime}ms`);

        } catch (error) {
            CSReporter.error(`Failed to execute parameterized query: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to execute parameterized query: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user executes predefined query {string}')
    async executePredefinedQuery(queryName: string): Promise<void> {
        CSReporter.info(`Executing predefined query: ${queryName}`);

        try {
            const query = this.configManager.get(`DB_QUERY_${queryName.toUpperCase()}`);
            if (!query) {
                throw new Error(`Predefined query '${queryName}' not found in configuration`);
            }

            const interpolatedQuery = this.interpolateVariables(query as string);

            const startTime = Date.now();
            const result = await this.databaseContext.executeQuery(interpolatedQuery);
            const executionTime = Date.now() - startTime;

            this.databaseContext.storeResult('last', result);
            this.contextVariables.set('lastQueryResult', result);
            this.contextVariables.set('lastQueryExecutionTime', executionTime);

            CSReporter.info(`Predefined query '${queryName}' executed successfully. Rows: ${result.rowCount}, Time: ${executionTime}ms`);

        } catch (error) {
            CSReporter.error(`Failed to execute predefined query '${queryName}': ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to execute predefined query '${queryName}': ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user executes batch queries:')
    async executeBatchQueries(docString: string): Promise<void> {
        CSReporter.info('Executing batch queries');

        const queries = this.parseBatchQueries(docString);
        const results: QueryResult[] = [];
        const errors: string[] = [];

        const startTime = Date.now();

        for (let i = 0; i < queries.length; i++) {
            try {
                const queryText = queries[i];
                if (!queryText) continue;

                const interpolatedQuery = this.interpolateVariables(queryText);
                const result = await this.databaseContext.executeQuery(interpolatedQuery);
                results.push(result);

                CSReporter.info(`Batch query ${i + 1} executed successfully. Rows: ${result.rowCount}`);

            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                const errorText = `Query ${i + 1} failed: ${errorMsg}`;
                errors.push(errorText);
                CSReporter.error(errorText);
            }
        }

        const totalExecutionTime = Date.now() - startTime;

        if (errors.length > 0) {
            throw new Error(`Batch execution failed:\n${errors.join('\n')}`);
        }

        const aggregatedResult: QueryResult = {
            rows: results.flatMap(r => r.rows),
            fields: results[0]?.fields || [],
            rowCount: results.reduce((sum, r) => sum + r.rowCount, 0),
            command: 'BATCH',
            duration: Date.now() - startTime,
            affectedRows: results.reduce((sum, r) => sum + (r.affectedRows || 0), 0) || 0
        };

        this.databaseContext.storeResult('last', aggregatedResult);
        this.databaseContext.storeResult('batch', aggregatedResult);
        this.contextVariables.set('batchResults', results);

        CSReporter.info(`Batch queries completed successfully. Total queries: ${queries.length}, Total rows: ${aggregatedResult.rowCount}, Time: ${totalExecutionTime}ms`);
    }

    @CSBDDStepDef('user executes query {string} with timeout {int} seconds')
    async executeQueryWithTimeout(query: string, timeout: number): Promise<void> {
        CSReporter.info(`Executing query with timeout ${timeout} seconds: ${this.sanitizeQueryForLog(query)}`);

        try {
            const interpolatedQuery = this.interpolateVariables(query);

            const startTime = Date.now();
            const originalTimeout = this.databaseContext['queryTimeout'];
            this.databaseContext['queryTimeout'] = timeout * 1000;
            const result = await this.databaseContext.executeQuery(interpolatedQuery);
            this.databaseContext['queryTimeout'] = originalTimeout;
            const executionTime = Date.now() - startTime;

            this.databaseContext.storeResult('last', result);
            this.contextVariables.set('lastQueryResult', result);
            this.contextVariables.set('lastQueryExecutionTime', executionTime);

            CSReporter.info(`Query with timeout executed successfully. Rows: ${result.rowCount}, Time: ${executionTime}ms`);

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            if (errorMsg.includes('timeout')) {
                throw new Error(`Query execution timed out after ${timeout} seconds`);
            }
            CSReporter.error(`Failed to execute query with timeout: ${errorMsg}`);
            throw new Error(`Failed to execute query with timeout: ${errorMsg}`);
        }
    }

    @CSBDDStepDef('user executes invalid query {string}')
    async executeQueryExpectingError(query: string): Promise<void> {
        CSReporter.info(`Executing query expecting error: ${this.sanitizeQueryForLog(query)}`);

        const interpolatedQuery = this.interpolateVariables(query);
        let errorOccurred = false;
        let errorMessage = '';

        try {
            await this.databaseContext.executeQuery(interpolatedQuery);
        } catch (error) {
            errorOccurred = true;
            errorMessage = error instanceof Error ? error.message : String(error);
            this.contextVariables.set('lastError', error);
            CSReporter.info(`Query failed as expected: ${errorMessage}`);
        }

        if (!errorOccurred) {
            throw new Error('Expected query to fail, but it succeeded');
        }

        CSReporter.info('Query error validation passed');
    }

    @CSBDDStepDef('user executes scalar query {string}')
    async executeScalarQuery(query: string): Promise<void> {
        CSReporter.info(`Executing scalar query: ${this.sanitizeQueryForLog(query)}`);

        try {
            const interpolatedQuery = this.interpolateVariables(query);

            const result = await this.databaseContext.executeQuery(interpolatedQuery);
            const scalarValue = result.rows[0] ? Object.values(result.rows[0])[0] : null;

            this.contextVariables.set('lastScalarResult', scalarValue);

            CSReporter.info(`Scalar query executed successfully. Value: ${scalarValue}`);

        } catch (error) {
            CSReporter.error(`Failed to execute scalar query: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to execute scalar query: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user executes count query {string}')
    async executeCountQuery(query: string): Promise<void> {
        CSReporter.info(`Executing count query: ${this.sanitizeQueryForLog(query)}`);

        try {
            const interpolatedQuery = this.interpolateVariables(query);

            if (!interpolatedQuery.toLowerCase().includes('count')) {
                throw new Error('Query must contain COUNT function');
            }

            const result = await this.databaseContext.executeQuery(interpolatedQuery);
            const count = result.rows[0] ? Object.values(result.rows[0])[0] : 0;
            const countValue = Number(count);

            if (isNaN(countValue)) {
                throw new Error(`Expected numeric count, got: ${count}`);
            }

            this.contextVariables.set('lastScalarResult', countValue);

            CSReporter.info(`Count query executed successfully. Count: ${countValue}`);

        } catch (error) {
            CSReporter.error(`Failed to execute count query: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to execute count query: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user executes query {string} and fetches first row')
    async executeQueryFetchFirst(query: string): Promise<void> {
        CSReporter.info(`Executing query and fetching first row: ${this.sanitizeQueryForLog(query)}`);

        try {
            const interpolatedQuery = this.interpolateVariables(query);

            const result = await this.databaseContext.executeQuery(interpolatedQuery);

            if (result.rowCount === 0) {
                throw new Error('Query returned no rows');
            }

            const firstRowResult: QueryResult = {
                rows: [result.rows[0]],
                fields: result.fields,
                rowCount: 1,
                command: result.command,
                duration: result.duration,
                affectedRows: result.affectedRows || 0
            };

            this.databaseContext.storeResult('last', firstRowResult);
            this.contextVariables.set('lastRow', result.rows[0]);

            CSReporter.info(`First row fetched successfully from ${result.rowCount} total rows`);

        } catch (error) {
            CSReporter.error(`Failed to fetch first row: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to fetch first row: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user executes query {string} with limit {int}')
    async executeQueryWithLimit(query: string, limit: number): Promise<void> {
        CSReporter.info(`Executing query with limit ${limit}: ${this.sanitizeQueryForLog(query)}`);

        try {
            const interpolatedQuery = this.interpolateVariables(query);

            const limitedQuery = this.addLimitToQuery(interpolatedQuery, limit);

            const result = await this.databaseContext.executeQuery(limitedQuery);

            this.databaseContext.storeResult('last', result);

            CSReporter.info(`Query with limit executed successfully. Requested limit: ${limit}, Actual rows: ${result.rowCount}`);

        } catch (error) {
            CSReporter.error(`Failed to execute query with limit: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to execute query with limit: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user profiles query {string}')
    async profileQueryExecution(query: string): Promise<void> {
        CSReporter.info(`Profiling query: ${this.sanitizeQueryForLog(query)}`);

        try {
            const interpolatedQuery = this.interpolateVariables(query);

            const result = await this.databaseContext.executeWithPlan(interpolatedQuery);
            const executionPlan = this.databaseContext.getLastExecutionPlan() || 'No execution plan available';

            console.log('\n=== Query Execution Plan ===');
            console.log(executionPlan);
            console.log('===========================\n');

            this.contextVariables.set('lastExecutionPlan', executionPlan);

            CSReporter.info(`Query profiled successfully. Rows: ${result.rowCount}`);

        } catch (error) {
            CSReporter.error(`Failed to profile query: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to profile query: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    @CSBDDStepDef('user cancels running query')
    async cancelRunningQuery(): Promise<void> {
        CSReporter.info('Cancelling running query');

        try {
            const adapter = this.databaseContext.getActiveAdapter();

            const connectionField = 'activeConnection';
            const connection = (this.databaseContext as any)[connectionField];

            if (!connection) {
                throw new Error('No active database connection');
            }

            if (adapter.cancelQuery) {
                await adapter.cancelQuery(connection);
            } else {
                throw new Error('Current database adapter does not support query cancellation');
            }

            CSReporter.info('Query cancelled successfully');

        } catch (error) {
            CSReporter.error(`Failed to cancel query: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to cancel query: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private resolveFilePath(filePath: string): string {
        const paths = [
            filePath,
            `./test-data/queries/${filePath}`,
            `./resources/queries/${filePath}`,
            `./queries/${filePath}`
        ];

        for (const path of paths) {
            if (fs.existsSync(path)) {
                return path;
            }
        }

        throw new Error(`Query file not found: ${filePath}`);
    }

    private parseParametersTable(dataTable: any): Record<string, any> {
        const parameters: Record<string, any> = {};

        if (dataTable && dataTable.rawTable) {
            dataTable.rawTable.forEach((row: string[]) => {
                if (row.length >= 2) {
                    const paramName = row[0]?.trim() || '';
                    const paramValue = this.interpolateVariables(row[1]?.trim() || '');

                    parameters[paramName] = this.convertParameterValue(paramValue);
                }
            });
        }

        return parameters;
    }

    private convertParameterValue(value: string): any {
        if (value.toLowerCase() === 'null') return null;

        if (value.toLowerCase() === 'true') return true;
        if (value.toLowerCase() === 'false') return false;

        if (/^\d+$/.test(value)) return parseInt(value);
        if (/^\d+\.\d+$/.test(value)) return parseFloat(value);

        if (/^\d{4}-\d{2}-\d{2}/.test(value)) return new Date(value);

        return value;
    }

    private parseBatchQueries(docString: string): string[] {
        return docString
            .split(';')
            .map(q => q.trim())
            .filter(q => q.length > 0);
    }

    private addLimitToQuery(query: string, limit: number): string {
        const lowerQuery = query.toLowerCase();

        if (lowerQuery.includes(' limit ') || lowerQuery.includes(' top ')) {
            return query;
        }

        return `${query} LIMIT ${limit}`;
    }

    private sanitizeQueryForLog(query: string): string {
        const maxLength = 200;
        if (query.length > maxLength) {
            return query.substring(0, maxLength) + '...';
        }
        return query;
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