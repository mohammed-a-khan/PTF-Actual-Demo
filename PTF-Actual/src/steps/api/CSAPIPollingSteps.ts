/**
 * API Polling Steps
 * Step definitions for polling API endpoints with retry logic
 * Polls until condition is met or timeout occurs
 *
 */

import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSApiContextManager } from '../../api/context/CSApiContextManager';
import { CSPollingEngine, PollingOptions } from '../../api/utils/CSPollingEngine';
import { CSReporter } from '../../reporter/CSReporter';

export class CSAPIPollingSteps {
    private pollingEngine: CSPollingEngine;

    constructor() {
        this.pollingEngine = CSPollingEngine.getInstance();
    }

    /**
     * Poll API every N seconds for M minutes until field equals value
     * Example: user poll "status" API every 5 seconds for maximum 2 minutes until field "status" is "completed"
     */
    @CSBDDStepDef('user poll {string} API every {int} seconds for maximum {int} minutes until field {string} is {string}')
    public async pollApiUntilFieldEquals(
        apiName: string,
        intervalSeconds: number,
        maxTimeMinutes: number,
        fieldPath: string,
        expectedValue: string
    ): Promise<void> {
        CSReporter.info(
            `Polling ${apiName} API for field "${fieldPath}" = "${expectedValue}"`
        );

        try {
            // Set API context
            const contextManager = CSApiContextManager.getInstance();
            contextManager.setCurrentContext(apiName);
            const apiContext = contextManager.getCurrentContext();

            // Convert time units
            const interval = CSPollingEngine.secondsToMs(intervalSeconds);
            const maxTime = CSPollingEngine.minutesToMs(maxTimeMinutes);

            // Poll
            const result = await this.pollingEngine.poll(apiContext, {
                interval,
                maxTime,
                fieldPath,
                expectedValue,
                description: `${apiName} API - ${fieldPath} = ${expectedValue}`
            });

            // Store final response
            if (result.finalResponse) {
                apiContext.saveResponse('last', result.finalResponse);
            }

        } catch (error: any) {
            CSReporter.error(`Polling failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Poll current API endpoint until field equals value
     * Example: user poll every 3 seconds for maximum 1 minute until field "ready" is "true"
     */
    @CSBDDStepDef('user poll every {int} seconds for maximum {int} minutes until field {string} is {string}')
    public async pollUntilFieldEquals(
        intervalSeconds: number,
        maxTimeMinutes: number,
        fieldPath: string,
        expectedValue: string
    ): Promise<void> {
        try {
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();

            const interval = CSPollingEngine.secondsToMs(intervalSeconds);
            const maxTime = CSPollingEngine.minutesToMs(maxTimeMinutes);

            const result = await this.pollingEngine.poll(apiContext, {
                interval,
                maxTime,
                fieldPath,
                expectedValue,
                description: `${fieldPath} = ${expectedValue}`
            });

            if (result.finalResponse) {
                apiContext.saveResponse('last', result.finalResponse);
            }

        } catch (error: any) {
            CSReporter.error(`Polling failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Poll until status code matches
     * Example: user poll every 5 seconds for maximum 2 minutes until status is 200
     */
    @CSBDDStepDef('user poll every {int} seconds for maximum {int} minutes until status is {int}')
    public async pollUntilStatus(
        intervalSeconds: number,
        maxTimeMinutes: number,
        expectedStatus: number
    ): Promise<void> {
        try {
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();

            const interval = CSPollingEngine.secondsToMs(intervalSeconds);
            const maxTime = CSPollingEngine.minutesToMs(maxTimeMinutes);

            const result = await this.pollingEngine.pollUntilStatus(
                apiContext,
                expectedStatus,
                interval,
                maxTime
            );

            if (result.finalResponse) {
                apiContext.saveResponse('last', result.finalResponse);
            }

        } catch (error: any) {
            CSReporter.error(`Polling failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Poll until field exists in response
     * Example: user poll every 2 seconds for maximum 1 minute until field "data.id" exists
     */
    @CSBDDStepDef('user poll every {int} seconds for maximum {int} minutes until field {string} exists')
    public async pollUntilFieldExists(
        intervalSeconds: number,
        maxTimeMinutes: number,
        fieldPath: string
    ): Promise<void> {
        try {
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();

            const interval = CSPollingEngine.secondsToMs(intervalSeconds);
            const maxTime = CSPollingEngine.minutesToMs(maxTimeMinutes);

            const result = await this.pollingEngine.pollUntilFieldExists(
                apiContext,
                fieldPath,
                interval,
                maxTime
            );

            if (result.finalResponse) {
                apiContext.saveResponse('last', result.finalResponse);
            }

        } catch (error: any) {
            CSReporter.error(`Polling failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Poll with millisecond precision
     * Example: user poll every 500 milliseconds for maximum 30000 milliseconds until field "status" is "done"
     */
    @CSBDDStepDef('user poll every {int} milliseconds for maximum {int} milliseconds until field {string} is {string}')
    public async pollMillisecondsUntilFieldEquals(
        interval: number,
        maxTime: number,
        fieldPath: string,
        expectedValue: string
    ): Promise<void> {
        try {
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();

            const result = await this.pollingEngine.poll(apiContext, {
                interval,
                maxTime,
                fieldPath,
                expectedValue,
                description: `${fieldPath} = ${expectedValue}`
            });

            if (result.finalResponse) {
                apiContext.saveResponse('last', result.finalResponse);
            }

        } catch (error: any) {
            CSReporter.error(`Polling failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Poll until field contains substring
     * Example: user poll every 3 seconds for maximum 1 minute until field "message" contains "success"
     */
    @CSBDDStepDef('user poll every {int} seconds for maximum {int} minutes until field {string} contains {string}')
    public async pollUntilFieldContains(
        intervalSeconds: number,
        maxTimeMinutes: number,
        fieldPath: string,
        substring: string
    ): Promise<void> {
        try {
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();

            const interval = CSPollingEngine.secondsToMs(intervalSeconds);
            const maxTime = CSPollingEngine.minutesToMs(maxTimeMinutes);

            const result = await this.pollingEngine.pollWithCheck(
                apiContext,
                (response) => {
                    const value = this.extractValue(response.body, fieldPath);
                    if (value === undefined || value === null) {
                        return false;
                    }
                    return String(value).includes(substring);
                },
                interval,
                maxTime,
                `${fieldPath} contains "${substring}"`
            );

            if (result.finalResponse) {
                apiContext.saveResponse('last', result.finalResponse);
            }

        } catch (error: any) {
            CSReporter.error(`Polling failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Poll until field does NOT equal value
     * Example: user poll every 5 seconds for maximum 2 minutes until field "status" is not "pending"
     */
    @CSBDDStepDef('user poll every {int} seconds for maximum {int} minutes until field {string} is not {string}')
    public async pollUntilFieldNotEquals(
        intervalSeconds: number,
        maxTimeMinutes: number,
        fieldPath: string,
        unexpectedValue: string
    ): Promise<void> {
        try {
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();

            const interval = CSPollingEngine.secondsToMs(intervalSeconds);
            const maxTime = CSPollingEngine.minutesToMs(maxTimeMinutes);

            const result = await this.pollingEngine.pollWithCheck(
                apiContext,
                (response) => {
                    const value = this.extractValue(response.body, fieldPath);
                    if (value === undefined || value === null) {
                        return false;
                    }
                    return String(value) !== unexpectedValue;
                },
                interval,
                maxTime,
                `${fieldPath} is not "${unexpectedValue}"`
            );

            if (result.finalResponse) {
                apiContext.saveResponse('last', result.finalResponse);
            }

        } catch (error: any) {
            CSReporter.error(`Polling failed: ${error.message}`);
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
