/**
 * API Test Data Management Steps
 * Step definitions for managing test data variables
 * 
 *
 */

import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSBDDContext } from '../../bdd/CSBDDContext';
import { CSPlaceholderResolver } from '../../api/templates/CSPlaceholderResolver';
import { CSReporter } from '../../reporter/CSReporter';
import { expect } from '@playwright/test';

export class CSAPITestDataSteps {
    private context: CSBDDContext;
    private resolver: CSPlaceholderResolver;

    constructor() {
        this.context = CSBDDContext.getInstance();
        this.resolver = new CSPlaceholderResolver();
    }

    /**
     * Set single test data key-value pair
     * Automatically detects and parses JSON arrays/objects from Scenario Outline parameters
     * Example: user set test data "userId" to "12345"
     * Example: user set test data "userName" to "{{faker.name}}"
     * Example: user set test data "tags" to "["tag1", "tag2"]" (auto-parsed to array)
     */
    @CSBDDStepDef('user set test data {string} to {string}')
    public async setTestData(key: string, value: string): Promise<void> {
        try {
            let finalValue: any;

            // Step 1: Resolve any templates/placeholders in the value
            const resolvedValue = this.resolver.resolve(value);

            // Step 2: Try to parse as JSON if it looks like JSON (array or object)
            const trimmedValue = resolvedValue.trim();
            if (trimmedValue.startsWith('[') || trimmedValue.startsWith('{')) {
                try {
                    finalValue = JSON.parse(trimmedValue);
                    CSReporter.debug(`Parsed JSON value for ${key}: ${JSON.stringify(finalValue)}`);
                } catch (parseError) {
                    // If JSON parse fails, treat as string
                    finalValue = resolvedValue;
                    CSReporter.debug(`Value looks like JSON but failed to parse, treating as string: ${key}`);
                }
            } else {
                // Not JSON, use as-is
                finalValue = resolvedValue;
            }

            // Step 3: Store in BDD context (global)
            this.context.setVariable(key, finalValue);

            // Log with proper formatting
            const displayValue = typeof finalValue === 'object'
                ? JSON.stringify(finalValue)
                : finalValue;
            CSReporter.info(`Test data set: ${key} = ${displayValue}`);

        } catch (error: any) {
            CSReporter.error(`Failed to set test data: ${error.message}`);
            throw error;
        }
    }

    /**
     * Set multiple test data from JSON string
     * Example: user set test data {"userId": "12345", "userName": "John Doe"}
     */
    @CSBDDStepDef('user set test data {string}')
    public async setTestDataBulk(dataString: string): Promise<void> {
        try {
            // Parse JSON string
            const data = JSON.parse(dataString);

            if (typeof data !== 'object' || data === null || Array.isArray(data)) {
                throw new Error('Test data must be a JSON object');
            }

            let count = 0;

            // Set each key-value pair
            for (const [key, value] of Object.entries(data)) {
                const resolvedValue = this.resolver.resolve(String(value));
                this.context.setVariable(key, resolvedValue);
                CSReporter.debug(`  ${key} = ${resolvedValue}`);
                count++;
            }

            CSReporter.info(`Set ${count} test data value${count !== 1 ? 's' : ''}`);

        } catch (error: any) {
            CSReporter.error(`Failed to parse test data JSON: ${error.message}`);
            throw new Error(`Failed to parse test data JSON: ${error.message}`);
        }
    }

    /**
     * Set test data from DocString (multiline JSON)
     * Example:
     *   user set test data:
     *     """
     *     {
     *       "userId": "12345",
     *       "userName": "John Doe",
     *       "email": "{{faker.email}}"
     *     }
     *     """
     */
    @CSBDDStepDef('user set test data:')
    public async setTestDataFromDocString(dataString: string): Promise<void> {
        await this.setTestDataBulk(dataString);
    }

    /**
     * Clear all test data
     * Example: user clear all test data
     */
    @CSBDDStepDef('user clear all test data')
    public async clearAllTestData(): Promise<void> {
        try {
            // Clear BDD context world data
            this.context.clear();

            CSReporter.info('All test data cleared');

        } catch (error: any) {
            CSReporter.error(`Failed to clear test data: ${error.message}`);
            throw error;
        }
    }

    /**
     * Print current test data (for debugging)
     * Example: user print all test data
     */
    @CSBDDStepDef('user print all test data')
    public async printAllTestData(): Promise<void> {
        try {
            const worldData = (this.context as any).worldData as Map<string, any>;

            if (!worldData || worldData.size === 0) {
                CSReporter.info('No test data available');
                return;
            }

            CSReporter.info('Current Test Data:');
            for (const [key, value] of worldData.entries()) {
                const displayValue = typeof value === 'object'
                    ? JSON.stringify(value)
                    : String(value);
                CSReporter.info(`  ${key} = ${displayValue}`);
            }

        } catch (error: any) {
            CSReporter.error(`Failed to print test data: ${error.message}`);
            throw error;
        }
    }

    /**
     * Print specific test data value
     * Example: user print test data "userId"
     */
    @CSBDDStepDef('user print test data {string}')
    public async printTestData(key: string): Promise<void> {
        try {
            const value = this.context.getVariable(key);

            if (value === undefined) {
                CSReporter.warn(`Test data "${key}" does not exist`);
                return;
            }

            const displayValue = typeof value === 'object'
                ? JSON.stringify(value, null, 2)
                : String(value);

            CSReporter.info(`Test data "${key}": ${displayValue}`);

        } catch (error: any) {
            CSReporter.error(`Failed to print test data: ${error.message}`);
            throw error;
        }
    }

    /**
     * Verify test data exists
     * Example: test data "userId" should exist
     */
    @CSBDDStepDef('test data {string} should exist')
    public async verifyTestDataExists(key: string): Promise<void> {
        const value = this.context.getVariable(key);

        if (value === undefined) {
            throw new Error(`Test data "${key}" does not exist`);
        }

        CSReporter.pass(`Test data "${key}" exists with value: ${value}`);
    }

    /**
     * Verify test data value
     * Example: test data "userId" should be "12345"
     */
    @CSBDDStepDef('test data {string} should be {string}')
    public async verifyTestDataValue(key: string, expectedValue: string): Promise<void> {
        const actualValue = this.context.getVariable(key);
        const resolvedExpected = this.resolver.resolve(expectedValue);

        if (actualValue === undefined) {
            throw new Error(`Test data "${key}" does not exist`);
        }

        const actual = String(actualValue);

        expect(actual).toBe(resolvedExpected);

        CSReporter.pass(`Test data "${key}" verified: ${actual}`);
    }

    /**
     * Verify test data contains substring
     * Example: test data "userName" should contain "John"
     */
    @CSBDDStepDef('test data {string} should contain {string}')
    public async verifyTestDataContains(key: string, substring: string): Promise<void> {
        const actualValue = this.context.getVariable(key);

        if (actualValue === undefined) {
            throw new Error(`Test data "${key}" does not exist`);
        }

        const actual = String(actualValue);
        const resolvedSubstring = this.resolver.resolve(substring);

        if (!actual.includes(resolvedSubstring)) {
            throw new Error(
                `Test data "${key}" does not contain expected substring:\n` +
                `  Expected to contain: ${resolvedSubstring}\n` +
                `  Actual value: ${actual}`
            );
        }

        CSReporter.pass(`Test data "${key}" contains: ${resolvedSubstring}`);
    }

    /**
     * Remove specific test data key
     * Example: user remove test data "userId"
     */
    @CSBDDStepDef('user remove test data {string}')
    public async removeTestData(key: string): Promise<void> {
        try {
            const worldData = (this.context as any).worldData as Map<string, any>;

            if (worldData && worldData.has(key)) {
                worldData.delete(key);
                CSReporter.info(`Test data "${key}" removed`);
            } else {
                CSReporter.warn(`Test data "${key}" not found`);
            }

        } catch (error: any) {
            CSReporter.error(`Failed to remove test data: ${error.message}`);
            throw error;
        }
    }

    /**
     * Set test data from environment variable
     * Example: user set test data "baseUrl" from environment variable "API_BASE_URL"
     */
    @CSBDDStepDef('user set test data {string} from environment variable {string}')
    public async setTestDataFromEnv(key: string, envVar: string): Promise<void> {
        try {
            const value = process.env[envVar];

            if (value === undefined) {
                throw new Error(`Environment variable "${envVar}" not found`);
            }

            this.context.setVariable(key, value);

            CSReporter.info(`Test data "${key}" set from environment variable "${envVar}": ${value}`);

        } catch (error: any) {
            CSReporter.error(`Failed to set test data from environment: ${error.message}`);
            throw error;
        }
    }

    /**
     * Set test data from config
     * Example: user set test data "timeout" from config "DEFAULT_TIMEOUT"
     */
    @CSBDDStepDef('user set test data {string} from config {string}')
    public async setTestDataFromConfig(key: string, configKey: string): Promise<void> {
        try {
            const { CSConfigurationManager } = require('../../core/CSConfigurationManager');
            const config = CSConfigurationManager.getInstance();
            const value = config.get(configKey);

            if (value === undefined) {
                throw new Error(`Configuration key "${configKey}" not found`);
            }

            this.context.setVariable(key, value);

            CSReporter.info(`Test data "${key}" set from config "${configKey}": ${value}`);

        } catch (error: any) {
            CSReporter.error(`Failed to set test data from config: ${error.message}`);
            throw error;
        }
    }

    /**
     * Increment numeric test data
     * Example: user increment test data "counter"
     * Example: user increment test data "counter" by 5
     */
    @CSBDDStepDef('user increment test data {string}')
    public async incrementTestData(key: string): Promise<void> {
        await this.incrementTestDataBy(key, 1);
    }

    @CSBDDStepDef('user increment test data {string} by {int}')
    public async incrementTestDataBy(key: string, amount: number): Promise<void> {
        try {
            const currentValue = this.context.getVariable(key);

            if (currentValue === undefined) {
                throw new Error(`Test data "${key}" does not exist`);
            }

            const numValue = Number(currentValue);

            if (isNaN(numValue)) {
                throw new Error(`Test data "${key}" is not a number: ${currentValue}`);
            }

            const newValue = numValue + amount;
            this.context.setVariable(key, newValue);

            CSReporter.info(`Test data "${key}" incremented: ${numValue} → ${newValue}`);

        } catch (error: any) {
            CSReporter.error(`Failed to increment test data: ${error.message}`);
            throw error;
        }
    }

    /**
     * Generate and set random test data
     * Example: user generate random test data "userId"
     * Example: user generate random test data "email" with type "email"
     */
    @CSBDDStepDef('user generate random test data {string}')
    public async generateRandomTestData(key: string): Promise<void> {
        await this.generateRandomTestDataWithType(key, 'uuid');
    }

    @CSBDDStepDef('user generate random test data {string} with type {string}')
    public async generateRandomTestDataWithType(key: string, type: string): Promise<void> {
        try {
            let value: string;

            // Use placeholder resolver's built-in functions
            switch (type.toLowerCase()) {
                case 'uuid':
                    value = this.resolver.resolve('{{uuid()}}');
                    break;
                case 'email':
                    value = this.resolver.resolve('{{faker.email()}}');
                    break;
                case 'name':
                    value = this.resolver.resolve('{{faker.name()}}');
                    break;
                case 'phone':
                    value = this.resolver.resolve('{{faker.phone()}}');
                    break;
                case 'number':
                    value = this.resolver.resolve('{{randomInt(1, 1000000)}}');
                    break;
                case 'timestamp':
                    value = this.resolver.resolve('{{timestamp()}}');
                    break;
                default:
                    throw new Error(`Unknown random type: ${type}`);
            }

            this.context.setVariable(key, value);

            CSReporter.info(`Random test data "${key}" generated (${type}): ${value}`);

        } catch (error: any) {
            CSReporter.error(`Failed to generate random test data: ${error.message}`);
            throw error;
        }
    }
}
