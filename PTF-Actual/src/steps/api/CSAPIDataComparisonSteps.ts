/**
 * API Data Comparison Steps
 * Step definitions for comparing API responses against captured data (database or UI)
 * Implements intelligent record matching with scorecard algorithm
 *
 * Java Framework Migration: Implements validateResponseAgainstQueryResultInternal
 * with scorecard matching from GenericApiSteps.java
 */

import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSApiContextManager } from '../../api/context/CSApiContextManager';
import { CSBDDContext } from '../../bdd/CSBDDContext';
import { CSRecordMatcher, DatasetMatchResult } from '../../api/comparison/CSRecordMatcher';
import { CSReporter } from '../../reporter/CSReporter';

export class CSAPIDataComparisonSteps {
    private context: CSBDDContext;
    private recordMatcher: CSRecordMatcher;

    constructor() {
        this.context = CSBDDContext.getInstance();
        this.recordMatcher = new CSRecordMatcher({
            useFuzzyMatching: true,
            minMatchScore: 50,
            treatNullAsEmpty: true,
            caseSensitive: false,
            trimValues: true
        });
    }

    /**
     * Validate API response against captured data (database or UI)
     * This is the KEY step from Java framework
     *
     * Example: user validate "employee" API response against captured data at "employeeList" with key "employeeId"
     * Example: user validate "deal" API response against captured data at "data.deals" with key "dealId,securityId"
     */
    @CSBDDStepDef('user validate {string} API response against captured data at {string} with key {string}')
    public async validateApiResponseAgainstCapturedData(
        dataType: string,
        responsePath: string,
        keyField: string
    ): Promise<void> {
        CSReporter.info(`Validating ${dataType} API response against captured data`);

        try {
            // Get API response
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();
            const lastResponse = apiContext.getResponse('last');

            if (!lastResponse) {
                throw new Error('No API response available. Send a request first.');
            }

            // Get captured data from context (database or UI captured data)
            const capturedDataKey = `captured.${dataType}`;
            const capturedData = this.context.getVariable(capturedDataKey);

            if (!capturedData || !Array.isArray(capturedData)) {
                throw new Error(
                    `No captured data found for key: ${capturedDataKey}. ` +
                    `Ensure data is captured before validation.`
                );
            }

            // Extract response data at specified path
            const responseData = this.extractDataFromResponsePath(
                lastResponse.body,
                responsePath
            );

            if (!responseData || !Array.isArray(responseData)) {
                throw new Error(
                    `Response data not found or not an array at path: ${responsePath}`
                );
            }

            // Parse key fields
            const keyFields = keyField ? keyField.split(',').map(k => k.trim()) : undefined;

            // Perform matching
            const matchResult = this.recordMatcher.matchDatasets(
                capturedData,
                responseData,
                keyFields
            );

            // Report results
            this.reportMatchResults(matchResult, dataType, keyFields);

            // Fail if there are mismatches
            if (matchResult.matchedCount < capturedData.length) {
                throw new Error(
                    `Data validation failed: ${matchResult.matchedCount}/${capturedData.length} records matched`
                );
            }

            CSReporter.pass(
                `All ${matchResult.matchedCount} ${dataType} records matched successfully!`
            );

        } catch (error: any) {
            CSReporter.error(`Failed to validate API response: ${error.message}`);
            throw error;
        }
    }

    /**
     * Validate API response against database query result
     *
     * Example: user validate API response field "deals" against database query result "dealQuery" with key "dealId"
     */
    @CSBDDStepDef('user validate API response field {string} against database query result {string} with key {string}')
    public async validateResponseFieldAgainstDatabaseQuery(
        responseField: string,
        queryResultKey: string,
        keyField: string
    ): Promise<void> {
        CSReporter.info(`Validating response field "${responseField}" against database query result`);

        try {
            // Get API response
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();
            const lastResponse = apiContext.getResponse('last');

            if (!lastResponse) {
                throw new Error('No API response available. Send a request first.');
            }

            // Get database query result
            const dbDataKey = `db.query.${queryResultKey}`;
            const dbData = this.context.getVariable(dbDataKey);

            if (!dbData || !Array.isArray(dbData)) {
                throw new Error(
                    `No database query result found for key: ${dbDataKey}. ` +
                    `Execute query first using database steps.`
                );
            }

            // Extract response data
            const responseData = lastResponse.body[responseField];

            if (!responseData) {
                throw new Error(`Response does not contain field: ${responseField}`);
            }

            // Ensure response data is an array
            const responseArray = Array.isArray(responseData)
                ? responseData
                : [responseData];

            // Parse key fields
            const keyFields = keyField ? keyField.split(',').map(k => k.trim()) : undefined;

            // Perform matching
            const matchResult = this.recordMatcher.matchDatasets(
                dbData,
                responseArray,
                keyFields
            );

            // Report results
            this.reportMatchResults(matchResult, 'database', keyFields);

            // Fail if there are mismatches
            if (matchResult.matchedCount < dbData.length) {
                throw new Error(
                    `Database validation failed: ${matchResult.matchedCount}/${dbData.length} records matched`
                );
            }

            CSReporter.pass(
                `All ${matchResult.matchedCount} database records matched successfully!`
            );

        } catch (error: any) {
            CSReporter.error(`Failed to validate against database: ${error.message}`);
            throw error;
        }
    }

    /**
     * Validate API response against UI captured data
     *
     * Example: user validate "employee" API response against UI captured data using path "employeeList" with key "employeeId"
     */
    @CSBDDStepDef('user validate {string} API response against UI captured data using path {string} with key {string}')
    public async validateApiResponseAgainstUIData(
        dataType: string,
        responsePath: string,
        keyField: string
    ): Promise<void> {
        CSReporter.info(`Validating ${dataType} API response against UI captured data`);

        try {
            // Get API response
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();
            const lastResponse = apiContext.getResponse('last');

            if (!lastResponse) {
                throw new Error('No API response available. Send a request first.');
            }

            // Get UI captured data
            const uiDataKey = `ui.captured.${dataType}`;
            const uiData = this.context.getVariable(uiDataKey);

            if (!uiData || !Array.isArray(uiData)) {
                throw new Error(
                    `No UI captured data found for key: ${uiDataKey}. ` +
                    `Capture UI data first before validation.`
                );
            }

            // Extract response data at specified path
            const responseData = this.extractDataFromResponsePath(
                lastResponse.body,
                responsePath
            );

            if (!responseData || !Array.isArray(responseData)) {
                throw new Error(
                    `Response data not found or not an array at path: ${responsePath}`
                );
            }

            // Parse key fields
            const keyFields = keyField ? keyField.split(',').map(k => k.trim()) : undefined;

            // Perform matching
            const matchResult = this.recordMatcher.matchDatasets(
                uiData,
                responseData,
                keyFields
            );

            // Report results
            this.reportMatchResults(matchResult, dataType, keyFields);

            // Fail if there are mismatches
            if (matchResult.matchedCount < uiData.length) {
                throw new Error(
                    `UI data validation failed: ${matchResult.matchedCount}/${uiData.length} records matched`
                );
            }

            CSReporter.pass(
                `All ${matchResult.matchedCount} UI records matched successfully!`
            );

        } catch (error: any) {
            CSReporter.error(`Failed to validate against UI data: ${error.message}`);
            throw error;
        }
    }

    /**
     * Store captured data for later validation
     *
     * Example: user store data as "employeeData" for validation
     * Example: user store database query result as "dealData" for validation
     */
    @CSBDDStepDef('user store data as {string} for validation')
    public async storeDataForValidation(dataKey: string): Promise<void> {
        CSReporter.info(`Storing data as: ${dataKey}`);

        try {
            // This step expects data to be already in context
            // It's a placeholder to make test scenarios more readable
            const data = this.context.getVariable(dataKey);

            if (!data) {
                throw new Error(`No data found for key: ${dataKey}`);
            }

            const capturedKey = `captured.${dataKey}`;
            this.context.setVariable(capturedKey, data);

            CSReporter.pass(`Data stored as: ${capturedKey} for validation`);

        } catch (error: any) {
            CSReporter.error(`Failed to store data: ${error.message}`);
            throw error;
        }
    }

    /**
     * Compare datasets with detailed field-level reporting
     *
     * Example: user compare datasets "expected" and "actual" with key "id"
     */
    @CSBDDStepDef('user compare datasets {string} and {string} with key {string}')
    public async compareDatasets(
        expectedDataKey: string,
        actualDataKey: string,
        keyField: string
    ): Promise<void> {
        CSReporter.info(`Comparing datasets: ${expectedDataKey} vs ${actualDataKey}`);

        try {
            // Get expected data
            const expectedData = this.context.getVariable(expectedDataKey);
            if (!expectedData || !Array.isArray(expectedData)) {
                throw new Error(`Expected data not found or not an array: ${expectedDataKey}`);
            }

            // Get actual data
            const actualData = this.context.getVariable(actualDataKey);
            if (!actualData || !Array.isArray(actualData)) {
                throw new Error(`Actual data not found or not an array: ${actualDataKey}`);
            }

            // Parse key fields
            const keyFields = keyField ? keyField.split(',').map(k => k.trim()) : undefined;

            // Perform matching
            const matchResult = this.recordMatcher.matchDatasets(
                expectedData,
                actualData,
                keyFields
            );

            // Report results
            this.reportMatchResults(matchResult, 'comparison', keyFields);

            // Fail if there are mismatches
            if (matchResult.matchedCount < expectedData.length) {
                throw new Error(
                    `Dataset comparison failed: ${matchResult.matchedCount}/${expectedData.length} records matched`
                );
            }

            CSReporter.pass(
                `Datasets matched successfully: ${matchResult.matchedCount}/${expectedData.length} records`
            );

        } catch (error: any) {
            CSReporter.error(`Failed to compare datasets: ${error.message}`);
            throw error;
        }
    }

    /**
     * Print captured data for debugging
     *
     * Example: user print captured data "employeeData"
     */
    @CSBDDStepDef('user print captured data {string}')
    public async printCapturedData(dataKey: string): Promise<void> {
        const capturedKey = `captured.${dataKey}`;
        const data = this.context.getVariable(capturedKey);

        if (!data) {
            CSReporter.warn(`No captured data found for key: ${capturedKey}`);
            return;
        }

        CSReporter.info(`Captured data for "${dataKey}":`);
        CSReporter.info(JSON.stringify(data, null, 2));
    }

    /**
     * Extract data from response using dot notation path
     */
    private extractDataFromResponsePath(responseBody: any, path: string): any {
        if (!path || path.trim() === '') {
            return responseBody;
        }

        const parts = path.split('.');
        let current = responseBody;

        for (const part of parts) {
            if (current === null || current === undefined) {
                return null;
            }

            // Handle array indexing: field[0]
            const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
            if (arrayMatch) {
                const fieldName = arrayMatch[1];
                const index = parseInt(arrayMatch[2]);

                if (!(fieldName in current)) {
                    return null;
                }

                current = current[fieldName];
                if (Array.isArray(current) && index < current.length) {
                    current = current[index];
                } else {
                    return null;
                }
            } else {
                // Simple field access
                if (!(part in current)) {
                    return null;
                }
                current = current[part];
            }
        }

        return current;
    }

    /**
     * Report detailed match results
     */
    private reportMatchResults(
        matchResult: DatasetMatchResult,
        dataType: string,
        keyFields?: string[]
    ): void {
        CSReporter.info(`\n=== ${dataType.toUpperCase()} Data Validation Summary ===`);
        CSReporter.info(`Expected records: ${matchResult.sourceCount}`);
        CSReporter.info(`Actual records: ${matchResult.targetCount}`);
        CSReporter.info(`Matched records: ${matchResult.matchedCount}`);
        CSReporter.info(`Match percentage: ${matchResult.matchPercentage.toFixed(1)}%`);

        if (keyFields && keyFields.length > 0) {
            CSReporter.info(`Key fields used: ${keyFields.join(', ')}`);
        } else {
            CSReporter.info(`Matching method: Scorecard (fuzzy matching)`);
        }

        // Report unmatched records
        if (matchResult.unmatchedSourceCount > 0) {
            CSReporter.warn(
                `\n⚠️  ${matchResult.unmatchedSourceCount} expected record(s) not found in response`
            );
        }

        if (matchResult.unmatchedTargetCount > 0) {
            CSReporter.warn(
                `⚠️  ${matchResult.unmatchedTargetCount} extra record(s) in response`
            );
        }

        // Report detailed field-level mismatches
        let mismatchCount = 0;
        for (let i = 0; i < matchResult.matches.length; i++) {
            const match = matchResult.matches[i];

            if (match.matchedIndex === -1) {
                CSReporter.error(`\n❌ Record #${i + 1}: No match found`);
                mismatchCount++;
            } else if (match.mismatchedFields.length > 0) {
                CSReporter.warn(
                    `\n⚠️  Record #${i + 1}: Matched with mismatches ` +
                    `(Score: ${match.matchScore.toFixed(1)}%)`
                );
                CSReporter.info(`  Matched fields: ${match.matchedFields.join(', ')}`);
                CSReporter.warn(`  Mismatched fields: ${match.mismatchedFields.join(', ')}`);

                // Report field values for mismatches
                for (const field of match.mismatchedFields) {
                    const expectedValue = matchResult.matches[i].matchedRecord
                        ? (matchResult.matches[i] as any).matchedRecord[field]
                        : 'N/A';
                    CSReporter.warn(
                        `    ✗ ${field}: expected value mismatch`
                    );
                }

                mismatchCount++;
            } else {
                CSReporter.pass(
                    `✓ Record #${i + 1}: Perfect match ` +
                    `(${match.matchedFields.length} fields)`
                );
            }
        }

        CSReporter.info(`\n=== Validation Complete ===`);
        if (mismatchCount > 0) {
            CSReporter.error(`Found ${mismatchCount} record(s) with issues`);
        } else {
            CSReporter.pass(`All records matched perfectly!`);
        }
    }
}
