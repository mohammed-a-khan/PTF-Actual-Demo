/**
 * API Response Comparison Steps
 * Step definitions for storing and comparing API responses
 * Supports deep JSON comparison with various options
 *
 * 
 */

import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSApiContextManager } from '../../api/context/CSApiContextManager';
import { CSResponseComparator, ComparisonOptions } from '../../api/utils/CSResponseComparator';
import { CSReporter } from '../../reporter/CSReporter';

export class CSAPIComparisonSteps {
    private comparator: CSResponseComparator;

    constructor() {
        this.comparator = CSResponseComparator.getInstance();
    }

    /**
     * Store current response with a name
     * Example: user store current response as "initialResponse"
     */
    @CSBDDStepDef('user store current response as {string}')
    public async storeCurrentResponse(responseName: string): Promise<void> {
        try {
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();
            const response = apiContext.getLastResponse();

            if (!response) {
                throw new Error('No response found. Execute an API request first.');
            }

            // Store response with the given name
            apiContext.saveResponse(responseName, response);

            CSReporter.info(`Response stored as "${responseName}"`);
            CSReporter.debug(`Status: ${response.status}`);

        } catch (error: any) {
            CSReporter.error(`Failed to store response: ${error.message}`);
            throw error;
        }
    }

    /**
     * Validate current response matches stored response (exact match)
     * Example: user validate current response matches stored response "initialResponse"
     */
    @CSBDDStepDef('user validate current response matches stored response {string}')
    public async validateResponseMatches(storedResponseName: string): Promise<void> {
        try {
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();
            const currentResponse = apiContext.getLastResponse();
            const storedResponse = apiContext.getResponse(storedResponseName);

            if (!currentResponse) {
                throw new Error('No current response found. Execute an API request first.');
            }

            if (!storedResponse) {
                throw new Error(`Stored response "${storedResponseName}" not found`);
            }

            // Compare responses
            const result = this.comparator.compareResponses(storedResponse, currentResponse);

            if (!result.isEqual) {
                const formatted = this.comparator.formatResult(result);
                CSReporter.error(formatted);
                throw new Error(
                    `Current response does not match stored response "${storedResponseName}":\n` +
                    result.summary
                );
            }

            CSReporter.pass(
                `Current response matches stored response "${storedResponseName}"`
            );

        } catch (error: any) {
            CSReporter.error(`Response comparison failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Validate current response matches stored response (ignore array order)
     * Example: user validate current response matches stored response "baselineResponse" ignoring array order
     */
    @CSBDDStepDef('user validate current response matches stored response {string} ignoring array order')
    public async validateResponseMatchesIgnoringOrder(storedResponseName: string): Promise<void> {
        await this.validateResponseMatchesWithOptions(storedResponseName, {
            ignoreArrayOrder: true
        });
    }

    /**
     * Validate current response matches stored response (ignore extra fields)
     * Example: user validate current response matches stored response "expectedResponse" ignoring extra fields
     */
    @CSBDDStepDef('user validate current response matches stored response {string} ignoring extra fields')
    public async validateResponseMatchesIgnoringExtra(storedResponseName: string): Promise<void> {
        await this.validateResponseMatchesWithOptions(storedResponseName, {
            ignoreExtraFields: true
        });
    }

    /**
     * Validate current response body matches stored response body
     * Example: user validate current response body matches stored response body "baseline"
     */
    @CSBDDStepDef('user validate current response body matches stored response body {string}')
    public async validateResponseBodyMatches(storedResponseName: string): Promise<void> {
        try {
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();
            const currentResponse = apiContext.getLastResponse();
            const storedResponse = apiContext.getResponse(storedResponseName);

            if (!currentResponse) {
                throw new Error('No current response found. Execute an API request first.');
            }

            if (!storedResponse) {
                throw new Error(`Stored response "${storedResponseName}" not found`);
            }

            // Compare bodies only
            const result = this.comparator.compareObjects(
                storedResponse.body,
                currentResponse.body
            );

            if (!result.isEqual) {
                const formatted = this.comparator.formatResult(result);
                CSReporter.error(formatted);
                throw new Error(
                    `Current response body does not match stored response "${storedResponseName}":\n` +
                    result.summary
                );
            }

            CSReporter.pass(
                `Current response body matches stored response "${storedResponseName}"`
            );

        } catch (error: any) {
            CSReporter.error(`Response body comparison failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Validate response field matches stored response field
     * Example: user validate response field "data.user" matches stored response "baseline" field "data.user"
     */
    @CSBDDStepDef('user validate response field {string} matches stored response {string} field {string}')
    public async validateFieldMatches(
        currentFieldPath: string,
        storedResponseName: string,
        storedFieldPath: string
    ): Promise<void> {
        try {
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();
            const currentResponse = apiContext.getLastResponse();
            const storedResponse = apiContext.getResponse(storedResponseName);

            if (!currentResponse) {
                throw new Error('No current response found. Execute an API request first.');
            }

            if (!storedResponse) {
                throw new Error(`Stored response "${storedResponseName}" not found`);
            }

            // Extract field values
            const currentValue = this.extractValue(currentResponse.body, currentFieldPath);
            const storedValue = this.extractValue(storedResponse.body, storedFieldPath);

            // Compare values
            const result = this.comparator.compareObjects(storedValue, currentValue);

            if (!result.isEqual) {
                throw new Error(
                    `Field "${currentFieldPath}" does not match stored field "${storedFieldPath}":\n` +
                    result.summary
                );
            }

            CSReporter.pass(
                `Field "${currentFieldPath}" matches stored field "${storedFieldPath}"`
            );

        } catch (error: any) {
            CSReporter.error(`Field comparison failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Compare two stored responses
     * Example: user validate stored response "response1" matches stored response "response2"
     */
    @CSBDDStepDef('user validate stored response {string} matches stored response {string}')
    public async validateStoredResponsesMatch(
        responseName1: string,
        responseName2: string
    ): Promise<void> {
        try {
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();
            const response1 = apiContext.getResponse(responseName1);
            const response2 = apiContext.getResponse(responseName2);

            if (!response1) {
                throw new Error(`Stored response "${responseName1}" not found`);
            }

            if (!response2) {
                throw new Error(`Stored response "${responseName2}" not found`);
            }

            // Compare responses
            const result = this.comparator.compareResponses(response1, response2);

            if (!result.isEqual) {
                const formatted = this.comparator.formatResult(result);
                CSReporter.error(formatted);
                throw new Error(
                    `Stored responses do not match:\n${result.summary}`
                );
            }

            CSReporter.pass(
                `Stored response "${responseName1}" matches "${responseName2}"`
            );

        } catch (error: any) {
            CSReporter.error(`Stored response comparison failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Print stored response
     * Example: user print stored response "baseline"
     */
    @CSBDDStepDef('user print stored response {string}')
    public async printStoredResponse(responseName: string): Promise<void> {
        try {
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();
            const response = apiContext.getResponse(responseName);

            if (!response) {
                CSReporter.warn(`Stored response "${responseName}" not found`);
                return;
            }

            CSReporter.info(`Stored Response "${responseName}":`);
            CSReporter.info(`  Status: ${response.status}`);
            CSReporter.info(`  Body: ${JSON.stringify(response.body, null, 2)}`);

        } catch (error: any) {
            CSReporter.error(`Failed to print stored response: ${error.message}`);
            throw error;
        }
    }

    /**
     * Clear stored response
     * Example: user clear stored response "temporary"
     */
    @CSBDDStepDef('user clear stored response {string}')
    public async clearStoredResponse(responseName: string): Promise<void> {
        try {
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();

            // Remove from responses map
            const responses = (apiContext as any).responses as Map<string, any>;
            if (responses && responses.has(responseName)) {
                responses.delete(responseName);
                CSReporter.info(`Stored response "${responseName}" cleared`);
            } else {
                CSReporter.warn(`Stored response "${responseName}" not found`);
            }

        } catch (error: any) {
            CSReporter.error(`Failed to clear stored response: ${error.message}`);
            throw error;
        }
    }

    /**
     * Clear all stored responses
     * Example: user clear all stored responses
     */
    @CSBDDStepDef('user clear all stored responses')
    public async clearAllStoredResponses(): Promise<void> {
        try {
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();

            // Clear responses map (keep 'last')
            const responses = (apiContext as any).responses as Map<string, any>;
            if (responses) {
                const lastResponse = responses.get('last');
                responses.clear();
                if (lastResponse) {
                    responses.set('last', lastResponse);
                }
                CSReporter.info('All stored responses cleared (except current)');
            }

        } catch (error: any) {
            CSReporter.error(`Failed to clear stored responses: ${error.message}`);
            throw error;
        }
    }

    /**
     * Validate response matches with custom options
     */
    private async validateResponseMatchesWithOptions(
        storedResponseName: string,
        options: ComparisonOptions
    ): Promise<void> {
        try {
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();
            const currentResponse = apiContext.getLastResponse();
            const storedResponse = apiContext.getResponse(storedResponseName);

            if (!currentResponse) {
                throw new Error('No current response found. Execute an API request first.');
            }

            if (!storedResponse) {
                throw new Error(`Stored response "${storedResponseName}" not found`);
            }

            // Compare responses with options
            const result = this.comparator.compareResponses(
                storedResponse,
                currentResponse,
                options
            );

            if (!result.isEqual) {
                const formatted = this.comparator.formatResult(result);
                CSReporter.error(formatted);
                throw new Error(
                    `Current response does not match stored response "${storedResponseName}":\n` +
                    result.summary
                );
            }

            CSReporter.pass(
                `Current response matches stored response "${storedResponseName}" with options`
            );

        } catch (error: any) {
            CSReporter.error(`Response comparison failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Extract value from object using dot notation
     */
    private extractValue(data: any, path: string): any {
        const parts = path.split('.');
        let value = data;

        for (const part of parts) {
            if (value === null || value === undefined) {
                return undefined;
            }

            const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
            if (arrayMatch) {
                value = value[arrayMatch[1]];
                if (Array.isArray(value)) {
                    value = value[parseInt(arrayMatch[2])];
                }
            } else {
                value = value[part];
            }
        }

        return value;
    }
}
