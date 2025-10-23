/**
 * Polling Engine for API Requests
 * Implements retry logic with interval and timeout
 * Polls API endpoint until condition is met or timeout occurs
 *
 */

import { CSReporter } from '../../reporter/CSReporter';
import { CSApiContext } from '../context/CSApiContext';
import { CSResponse } from '../types/CSApiTypes';
import { CSAPIClient } from '../CSAPIClient';

export interface PollingOptions {
    /** Interval between polls in milliseconds */
    interval: number;
    /** Maximum polling time in milliseconds */
    maxTime: number;
    /** Field path to check in response */
    fieldPath: string;
    /** Expected value for field */
    expectedValue: any;
    /** Optional: Check function (overrides fieldPath/expectedValue) */
    checkFunction?: (response: CSResponse) => boolean;
    /** Optional: Description for logging */
    description?: string;
    /** Optional: Fail on timeout (default: true) */
    failOnTimeout?: boolean;
    /** Optional: Log each poll attempt */
    logAttempts?: boolean;
}

export interface PollingResult {
    success: boolean;
    attempts: number;
    duration: number;
    finalResponse?: CSResponse;
    error?: string;
}

export class CSPollingEngine {
    private static instance: CSPollingEngine;

    private constructor() {}

    public static getInstance(): CSPollingEngine {
        if (!CSPollingEngine.instance) {
            CSPollingEngine.instance = new CSPollingEngine();
        }
        return CSPollingEngine.instance;
    }

    /**
     * Poll API endpoint until condition is met
     *
     * @param apiContext - API context to use for requests
     * @param options - Polling options
     * @returns Polling result
     */
    public async poll(
        apiContext: CSApiContext,
        options: PollingOptions
    ): Promise<PollingResult> {
        const startTime = Date.now();
        let attempts = 0;
        let finalResponse: CSResponse | undefined;
        const failOnTimeout = options.failOnTimeout !== false;
        const logAttempts = options.logAttempts !== false;

        const description = options.description ||
            `Poll for ${options.fieldPath} = ${options.expectedValue}`;

        CSReporter.info(
            `Starting polling: ${description}\n` +
            `  Interval: ${options.interval}ms\n` +
            `  Max Time: ${options.maxTime}ms`
        );

        const apiClient = new CSAPIClient();

        while (Date.now() - startTime < options.maxTime) {
            attempts++;

            try {
                // Send request
                const response = await apiClient.request({
                    method: 'GET',
                    url: apiContext.baseUrl || ''
                });

                finalResponse = response;

                // Check condition
                const conditionMet = options.checkFunction
                    ? options.checkFunction(response)
                    : this.checkFieldValue(response, options.fieldPath, options.expectedValue);

                if (logAttempts) {
                    CSReporter.debug(
                        `Poll attempt ${attempts}: ` +
                        `Status ${response.status}, ` +
                        `Condition: ${conditionMet ? 'MET' : 'NOT MET'}`
                    );
                }

                if (conditionMet) {
                    const duration = Date.now() - startTime;
                    CSReporter.pass(
                        `Polling successful after ${attempts} attempt(s) in ${duration}ms`
                    );

                    return {
                        success: true,
                        attempts,
                        duration,
                        finalResponse
                    };
                }

            } catch (error: any) {
                CSReporter.debug(`Poll attempt ${attempts} failed: ${error.message}`);
            }

            // Wait before next attempt
            await this.sleep(options.interval);
        }

        // Timeout reached
        const duration = Date.now() - startTime;
        const errorMessage =
            `Polling timeout after ${attempts} attempt(s) in ${duration}ms\n` +
            `  Expected: ${options.fieldPath} = ${options.expectedValue}\n` +
            `  Last response: ${finalResponse ? JSON.stringify(finalResponse.body) : 'none'}`;

        if (failOnTimeout) {
            CSReporter.error(errorMessage);
            throw new Error(errorMessage);
        } else {
            CSReporter.warn(errorMessage);
            return {
                success: false,
                attempts,
                duration,
                finalResponse,
                error: errorMessage
            };
        }
    }

    /**
     * Poll with custom check function
     */
    public async pollWithCheck(
        apiContext: CSApiContext,
        checkFunction: (response: CSResponse) => boolean,
        interval: number,
        maxTime: number,
        description?: string
    ): Promise<PollingResult> {
        return await this.poll(apiContext, {
            interval,
            maxTime,
            fieldPath: '', // Not used with custom function
            expectedValue: null,
            checkFunction,
            description
        });
    }

    /**
     * Poll until status code matches
     */
    public async pollUntilStatus(
        apiContext: CSApiContext,
        expectedStatus: number,
        interval: number,
        maxTime: number
    ): Promise<PollingResult> {
        return await this.pollWithCheck(
            apiContext,
            (response) => response.status === expectedStatus,
            interval,
            maxTime,
            `Poll until status ${expectedStatus}`
        );
    }

    /**
     * Poll until field exists
     */
    public async pollUntilFieldExists(
        apiContext: CSApiContext,
        fieldPath: string,
        interval: number,
        maxTime: number
    ): Promise<PollingResult> {
        return await this.pollWithCheck(
            apiContext,
            (response) => {
                const value = this.extractValue(response.body, fieldPath);
                return value !== undefined && value !== null;
            },
            interval,
            maxTime,
            `Poll until field "${fieldPath}" exists`
        );
    }

    /**
     * Poll until field matches pattern
     */
    public async pollUntilFieldMatches(
        apiContext: CSApiContext,
        fieldPath: string,
        pattern: RegExp,
        interval: number,
        maxTime: number
    ): Promise<PollingResult> {
        return await this.pollWithCheck(
            apiContext,
            (response) => {
                const value = this.extractValue(response.body, fieldPath);
                if (value === undefined || value === null) {
                    return false;
                }
                return pattern.test(String(value));
            },
            interval,
            maxTime,
            `Poll until field "${fieldPath}" matches pattern`
        );
    }

    /**
     * Check if field value matches expected value
     */
    private checkFieldValue(response: CSResponse, fieldPath: string, expectedValue: any): boolean {
        const actualValue = this.extractValue(response.body, fieldPath);

        // Handle undefined/null
        if (actualValue === undefined || actualValue === null) {
            return false;
        }

        // Compare values
        return actualValue === expectedValue || String(actualValue) === String(expectedValue);
    }

    /**
     * Extract value from response using dot notation
     */
    private extractValue(data: any, path: string): any {
        const parts = path.split('.');
        let value = data;

        for (const part of parts) {
            if (value === null || value === undefined) {
                return undefined;
            }

            // Handle array indexing: field[0]
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

    /**
     * Sleep for specified milliseconds
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Calculate retry count from interval and max time
     */
    public static calculateRetries(interval: number, maxTime: number): number {
        return Math.floor(maxTime / interval);
    }

    /**
     * Convert seconds to milliseconds
     */
    public static secondsToMs(seconds: number): number {
        return seconds * 1000;
    }

    /**
     * Convert minutes to milliseconds
     */
    public static minutesToMs(minutes: number): number {
        return minutes * 60 * 1000;
    }
}
