// src/steps/database/CSDatabaseAPISteps.ts

import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSDatabaseManager } from '../../database/CSDatabaseManager';
import { CSDatabase } from '../../database/client/CSDatabase';
import { CSQueryResultCache } from '../../database/context/CSQueryResultCache';
import { CSApiContextManager } from '../../api/context/CSApiContextManager';
import { CSRecordMatcher, RecordMatchConfig, DatasetMatchResult } from '../../api/comparison/CSRecordMatcher';
import { CSFieldMapper, FieldMapping } from '../../api/comparison/CSFieldMapper';
import { CSReporter } from '../../reporter/CSReporter';
import { CSPlaceholderResolver } from '../../api/templates/CSPlaceholderResolver';

/**
 * Database-API Integration Step Definitions
 *
 * Provides critical step definitions for validating API responses against database queries.
 * Implements all functionality from Java QAF framework with enhancements for TypeScript/PTF.
 *
 * Key features:
 * - Execute SQL queries and store results for validation
 * - Execute stored procedures with parameters
 * - Validate API responses against database query results
 * - Field mapping (DB snake_case <-> API camelCase)
 * - Key-based record matching
 * - Flexible data validation with detailed reporting
 */
export class CSDatabaseAPISteps {
    private dbManager: CSDatabaseManager;
    private apiContextManager: CSApiContextManager;
    private queryCache: CSQueryResultCache;
    private placeholderResolver: CSPlaceholderResolver;

    constructor() {
        this.dbManager = CSDatabaseManager.getInstance();
        this.apiContextManager = CSApiContextManager.getInstance();
        this.queryCache = CSQueryResultCache.getInstance();
        this.placeholderResolver = new CSPlaceholderResolver();
    }

    private resolveWithContext(template: string): string {
        const apiContext = this.apiContextManager.getCurrentContext();
        const variables = apiContext.getAllVariables();
        // Set all variables in the resolver context
        for (const [key, value] of Object.entries(variables)) {
            this.placeholderResolver.setVariable(key, value);
        }
        return this.placeholderResolver.resolve(template);
    }

    /**
     * Execute SQL query and store results for later validation
     *
     * @example
     * Given I execute query "SELECT * FROM users WHERE status='active'" and store results as "activeUsers"
     */
    @CSBDDStepDef('I execute query {string} and store results as {string}')
    async executeQueryAndStore(query: string, resultName: string): Promise<void> {
        try {
            // Resolve placeholders in query (${variableName})
            const resolvedQuery = this.resolveWithContext(query);

            CSReporter.info(`Executing SQL query: ${resultName}`);
            CSReporter.debug(`Query: ${resolvedQuery}`);

            // Get default database connection
            const db = this.dbManager.getConnection('default');
            const resultSet = await db.execute(resolvedQuery);

            // Store in cache
            this.queryCache.storeResultSet(resultName, resultSet, {
                query: resolvedQuery,
                connectionName: 'default'
            });

            CSReporter.pass(`Query executed and stored as '${resultName}': ${resultSet.rowCount} rows`);
        } catch (error) {
            CSReporter.error(`Failed to execute query: ${(error as Error).message}`);
            throw new Error(`Failed to execute query and store results: ${(error as Error).message}`);
        }
    }

    /**
     * Execute query with explicit parameters
     *
     * @example
     * Given I execute query "SELECT * FROM users WHERE id = ?" with parameters "123" and store as "user"
     */
    @CSBDDStepDef('I execute query {string} with parameters {string} and store as {string}')
    async executeQueryWithParameters(
        query: string,
        parameters: string,
        resultName: string
    ): Promise<void> {
        try {
            // Parse parameters (comma-separated)
            const params = parameters.split(',').map(p => {
                const trimmed = p.trim();
                // Try to resolve as variable
                return this.resolveWithContext(trimmed);
            });

            CSReporter.info(`Executing parameterized SQL query: ${resultName}`);
            CSReporter.debug(`Query: ${query}`);
            CSReporter.debug(`Parameters: ${JSON.stringify(params)}`);

            const db = this.dbManager.getConnection('default');
            const resultSet = await db.execute(query, params);

            // Store in cache
            this.queryCache.storeResultSet(resultName, resultSet, {
                query,
                parameters: params,
                connectionName: 'default'
            });

            CSReporter.pass(`Parameterized query executed: ${resultSet.rowCount} rows`);
        } catch (error) {
            CSReporter.error(`Failed to execute parameterized query: ${(error as Error).message}`);
            throw new Error(`Failed to execute parameterized query: ${(error as Error).message}`);
        }
    }

    /**
     * Execute stored procedure with data table parameters
     *
     * @example
     * Given I execute stored procedure "GetUserDetails" with parameters:
     *   | userId        | 12345 |
     *   | includeHistory | true  |
     * And store as "userDetails"
     */
    @CSBDDStepDef('I execute stored procedure {string} with parameters: {dataTable} and store as {string}')
    async executeStoredProcedure(
        procedureName: string,
        parameters: Array<{[key: string]: string}>,
        resultName: string
    ): Promise<void> {
        try {
            // Convert data table to parameter array
            const params: any[] = [];
            parameters.forEach(row => {
                const key = Object.keys(row)[0];
                let value: any = row[key];

                // Try to resolve as variable
                value = this.resolveWithContext(String(value));

                params.push(value);
            });

            CSReporter.info(`Executing stored procedure: ${procedureName}`);
            CSReporter.debug(`Parameters: ${JSON.stringify(params)}`);

            const db = this.dbManager.getConnection('default');

            // Build CALL statement
            const placeholders = params.map(() => '?').join(', ');
            const callStatement = `CALL ${procedureName}(${placeholders})`;

            const resultSet = await db.execute(callStatement, params);

            // Store in cache
            this.queryCache.storeResultSet(resultName, resultSet, {
                query: callStatement,
                parameters: params,
                connectionName: 'default'
            });

            CSReporter.pass(`Stored procedure executed: ${resultSet.rowCount} rows`);
        } catch (error) {
            CSReporter.error(`Failed to execute stored procedure: ${(error as Error).message}`);
            throw new Error(`Failed to execute stored procedure: ${(error as Error).message}`);
        }
    }

    /**
     * Use first row of query results as variables in API context
     *
     * @example
     * Given I use query result "user" row 0 as variables
     * # Sets all columns from first row as variables
     */
    @CSBDDStepDef('I use query result {string} row {int} as variables')
    async useQueryResultAsVariables(resultName: string, rowIndex: number): Promise<void> {
        const row = this.queryCache.getRow(resultName, rowIndex);

        if (!row) {
            throw new Error(`Query result '${resultName}' row ${rowIndex} not found`);
        }

        const apiContext = this.apiContextManager.getCurrentContext();

        for (const [key, value] of Object.entries(row)) {
            apiContext.setVariable(key, value);
            CSReporter.debug(`Set variable: ${key} = ${value}`);
        }

        CSReporter.pass(`Loaded ${Object.keys(row).length} variables from query result row ${rowIndex}`);
    }

    /**
     * Validate API response path against query results (basic validation)
     *
     * @example
     * Then I validate response path "data" against query result "activeUsers"
     */
    @CSBDDStepDef('I validate response path {string} against query result {string}')
    async validateResponseAgainstQueryResult(
        responsePath: string,
        queryResultName: string
    ): Promise<void> {
        await this.validateWithMapping(responsePath, queryResultName, null, null);
    }

    /**
     * Validate API response path against query results with key field matching
     *
     * @example
     * Then I validate response path "data" against query result "activeUsers" using key "id"
     */
    @CSBDDStepDef('I validate response path {string} against query result {string} using key {string}')
    async validateResponseWithKey(
        responsePath: string,
        queryResultName: string,
        keyField: string
    ): Promise<void> {
        await this.validateWithMapping(responsePath, queryResultName, keyField, null);
    }

    /**
     * Validate API response against query results with field mapping (data table)
     *
     * @example
     * Then I validate response path "data" against query result "users" with mapping:
     *   | user_id    | id        |
     *   | first_name | firstName |
     *   | last_name  | lastName  |
     */
    @CSBDDStepDef('I validate response path {string} against query result {string} with mapping: {dataTable}')
    async validateResponseWithFieldMapping(
        responsePath: string,
        queryResultName: string,
        mappingTable: Array<{[key: string]: string}>
    ): Promise<void> {
        // Convert data table to field mappings
        const mappings: FieldMapping[] = [];

        mappingTable.forEach(row => {
            const entries = Object.entries(row);
            if (entries.length === 2) {
                mappings.push({
                    source: entries[0][1],  // DB field
                    target: entries[1][1]   // API field
                });
            }
        });

        await this.validateWithMapping(responsePath, queryResultName, null, mappings);
    }

    /**
     * Validate API response against query results with field mapping string
     *
     * @example
     * Then I validate response path "data" against query result "users" with mapping "user_id:id,first_name:firstName"
     */
    @CSBDDStepDef('I validate response path {string} against query result {string} with mapping {string}')
    async validateResponseWithMappingString(
        responsePath: string,
        queryResultName: string,
        mappingString: string
    ): Promise<void> {
        const mappings = CSFieldMapper.parseMappingString(mappingString);
        await this.validateWithMapping(responsePath, queryResultName, null, mappings);
    }

    /**
     * Validate API response against query results with key and mapping
     *
     * @example
     * Then I validate response path "data" against query result "users" using key "id" with mapping:
     *   | user_id    | id        |
     *   | first_name | firstName |
     */
    @CSBDDStepDef('I validate response path {string} against query result {string} using key {string} with mapping: {dataTable}')
    async validateResponseWithKeyAndMapping(
        responsePath: string,
        queryResultName: string,
        keyField: string,
        mappingTable: Array<{[key: string]: string}>
    ): Promise<void> {
        const mappings: FieldMapping[] = [];

        mappingTable.forEach(row => {
            const entries = Object.entries(row);
            if (entries.length === 2) {
                mappings.push({
                    source: entries[0][1],
                    target: entries[1][1]
                });
            }
        });

        await this.validateWithMapping(responsePath, queryResultName, keyField, mappings);
    }

    /**
     * Validate specific field in API response equals specific field in query result
     *
     * @example
     * Then I validate response field "email" equals query result "userDetails" field "email_address"
     */
    @CSBDDStepDef('I validate response field {string} equals query result {string} field {string}')
    async validateResponseFieldEqualsQueryField(
        responseField: string,
        queryResultName: string,
        dbField: string
    ): Promise<void> {
        // Get API response
        const apiContext = this.apiContextManager.getCurrentContext();
        const response = apiContext.getLastResponse();

        if (!response) {
            throw new Error('No API response available. Send request first.');
        }

        // Get query result (first row)
        const dbRow = this.queryCache.getRow(queryResultName, 0);

        if (!dbRow) {
            throw new Error(`Query result '${queryResultName}' not found or empty`);
        }

        if (!(dbField in dbRow)) {
            throw new Error(`Field '${dbField}' not found in query result`);
        }

        // Extract response field value
        const responseData = typeof response.body === 'string'
            ? JSON.parse(response.body)
            : response.body;

        const responsePath = responseField.split('.');
        let responseValue: any = responseData;

        for (const segment of responsePath) {
            if (responseValue && typeof responseValue === 'object') {
                responseValue = responseValue[segment];
            } else {
                throw new Error(`Response path '${responseField}' not found`);
            }
        }

        const dbValue = dbRow[dbField];

        // Compare values (string comparison)
        const responseStr = String(responseValue).trim();
        const dbStr = String(dbValue).trim();

        if (responseStr !== dbStr) {
            CSReporter.error(
                `Field validation failed:\n` +
                `  Response field '${responseField}': ${responseStr}\n` +
                `  DB field '${dbField}': ${dbStr}`
            );
            throw new Error(
                `Field value mismatch: '${responseField}' (${responseStr}) != '${dbField}' (${dbStr})`
            );
        }

        CSReporter.pass(`Field '${responseField}' matches DB field '${dbField}': ${responseStr}`);
    }

    /**
     * Check if data exists in database table with WHERE clause
     *
     * @example
     * Then I check if data exists in table "orders" where "user_id='user123' AND status='active'"
     */
    @CSBDDStepDef('I check if data exists in table {string} where {string}')
    async checkDataExistsInTable(tableName: string, whereClause: string): Promise<void> {
        try {
            // Resolve placeholders in WHERE clause
            const resolvedWhere = this.resolveWithContext(whereClause);

            const query = `SELECT COUNT(*) as count FROM ${tableName} WHERE ${resolvedWhere}`;

            CSReporter.info(`Checking data existence in table: ${tableName}`);
            CSReporter.debug(`WHERE clause: ${resolvedWhere}`);

            const db = this.dbManager.getConnection('default');
            const resultSet = await db.execute(query);

            if (resultSet.rows.length === 0) {
                throw new Error(`No results returned from existence check`);
            }

            const count = Number(resultSet.rows[0].count);

            if (count === 0) {
                throw new Error(
                    `Data not found in table '${tableName}' with condition: ${resolvedWhere}`
                );
            }

            CSReporter.pass(`Data exists in table '${tableName}': ${count} row(s) found`);
        } catch (error) {
            CSReporter.error(`Data existence check failed: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Check if stored procedure with parameters returns data
     *
     * @example
     * Then I check if stored procedure "CheckOrderExists" with parameters:
     *   | orderId | 12345 |
     * Returns data
     */
    @CSBDDStepDef('I check if stored procedure {string} with parameters: {dataTable} returns data')
    async checkStoredProcedureReturnsData(
        procedureName: string,
        parameters: Array<{[key: string]: string}>
    ): Promise<void> {
        try {
            // Execute stored procedure
            const tempResultName = `temp_sp_check_${Date.now()}`;
            await this.executeStoredProcedure(procedureName, parameters, tempResultName);

            // Check if results exist
            const rowCount = this.queryCache.getRowCount(tempResultName);

            if (rowCount === 0) {
                throw new Error(
                    `Stored procedure '${procedureName}' returned no data`
                );
            }

            CSReporter.pass(`Stored procedure '${procedureName}' returned ${rowCount} row(s)`);
        } catch (error) {
            CSReporter.error(`Stored procedure check failed: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Core validation logic with mapping and key-based matching
     */
    private async validateWithMapping(
        responsePath: string,
        queryResultName: string,
        keyField: string | null,
        fieldMappings: FieldMapping[] | null
    ): Promise<void> {
        // Get API response
        const apiContext = this.apiContextManager.getCurrentContext();
        const response = apiContext.getLastResponse();

        if (!response) {
            throw new Error('No API response available. Send request first.');
        }

        // Get query results from cache
        const queryResults = this.queryCache.getResults(queryResultName);

        if (queryResults.length === 0) {
            throw new Error(`Query result '${queryResultName}' not found or empty`);
        }

        CSReporter.info(
            `Validating response path '${responsePath}' against ${queryResults.length} DB record(s)`
        );

        // Extract API response array at path
        const responseData = typeof response.body === 'string'
            ? JSON.parse(response.body)
            : response.body;

        const pathSegments = responsePath.split('.');
        let apiRecords: any = responseData;

        for (const segment of pathSegments) {
            if (apiRecords && typeof apiRecords === 'object') {
                apiRecords = apiRecords[segment];
            } else {
                throw new Error(`Response path '${responsePath}' not found`);
            }
        }

        if (!Array.isArray(apiRecords)) {
            throw new Error(`Response path '${responsePath}' is not an array`);
        }

        CSReporter.debug(`Found ${apiRecords.length} API record(s) at path '${responsePath}'`);

        // Apply field mappings to DB results
        let dbRecordsToMatch = queryResults;

        if (fieldMappings && fieldMappings.length > 0) {
            const fieldMapper = new CSFieldMapper({ mappings: fieldMappings });
            dbRecordsToMatch = fieldMapper.mapSourceArrayToTarget(queryResults);
            CSReporter.debug(`Applied ${fieldMappings.length} field mapping(s)`);
        }

        // Configure record matcher
        const matchConfig: RecordMatchConfig = {
            keyFields: keyField ? [keyField] : undefined,
            useFuzzyMatching: !keyField, // Use fuzzy if no key specified
            minMatchScore: 70,
            treatNullAsEmpty: true,
            caseSensitive: false,
            trimValues: true
        };

        const matcher = new CSRecordMatcher(matchConfig);

        // Perform matching
        const matchResult: DatasetMatchResult = matcher.matchDatasets(
            dbRecordsToMatch,
            apiRecords,
            keyField ? [keyField] : undefined
        );

        // Report results
        this.reportMatchResults(matchResult, keyField);

        // Fail if validation didn't pass
        if (matchResult.unmatchedSourceCount > 0 || matchResult.matchPercentage < 100) {
            throw new Error(
                `Validation failed: ${matchResult.matchedCount}/${matchResult.sourceCount} records matched ` +
                `(${matchResult.matchPercentage.toFixed(1)}%)`
            );
        }

        CSReporter.pass(
            `✓ All ${matchResult.matchedCount} record(s) validated successfully`
        );
    }

    /**
     * Report detailed match results
     */
    private reportMatchResults(result: DatasetMatchResult, keyField: string | null): void {
        CSReporter.info('\n=== Validation Summary ===');
        CSReporter.info(`DB Records: ${result.sourceCount}`);
        CSReporter.info(`API Records: ${result.targetCount}`);
        CSReporter.info(`Matched: ${result.matchedCount}`);

        if (result.unmatchedSourceCount > 0) {
            CSReporter.error(`Unmatched DB Records: ${result.unmatchedSourceCount}`);
        }

        if (result.unmatchedTargetCount > 0) {
            CSReporter.warn(`Unmatched API Records: ${result.unmatchedTargetCount}`);
        }

        CSReporter.info(`Match Percentage: ${result.matchPercentage.toFixed(1)}%`);

        // Report individual match details
        result.matches.forEach((match, index) => {
            if (match.matchedIndex >= 0) {
                const matchType = match.keyFieldMatch ? '(key match)' : '(fuzzy match)';
                CSReporter.debug(
                    `Record ${index + 1}: Matched ${matchType} - ` +
                    `${match.matchedFields.length} fields OK, ` +
                    `${match.mismatchedFields.length} mismatches`
                );

                if (match.mismatchedFields.length > 0) {
                    CSReporter.error(`  Mismatched fields: ${match.mismatchedFields.join(', ')}`);
                }
            } else {
                CSReporter.error(`Record ${index + 1}: NO MATCH FOUND`);
            }
        });
    }
}
