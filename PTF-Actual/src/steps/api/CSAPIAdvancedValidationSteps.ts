/**
 * API Advanced Validation Steps
 * Step definitions for advanced response validation
 * Includes pattern matching, error messages, and success checks
 *
 * 
 */

import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSApiContextManager } from '../../api/context/CSApiContextManager';
import { CSPatternValidator } from '../../api/validators/CSPatternValidator';
import { CSReporter } from '../../reporter/CSReporter';
import { expect } from '@playwright/test';

export class CSAPIAdvancedValidationSteps {
    private patternValidator: CSPatternValidator;

    constructor() {
        this.patternValidator = new CSPatternValidator();
    }

    /**
     * Validate response field matches regex pattern
     * Example: the response field "email" should match pattern "email"
     * Example: the response field "phone" should match pattern "^\\+1[0-9]{10}$"
     */
    @CSBDDStepDef('the response field {string} should match pattern {string}')
    public async validateFieldMatchesPattern(
        fieldPath: string,
        pattern: string
    ): Promise<void> {
        const apiContext = CSApiContextManager.getInstance().getCurrentContext();
        const response = apiContext.getLastResponse();

        if (!response) {
            throw new Error('No response found. Execute an API request first.');
        }

        // Extract field value
        const value = this.extractValue(response.body, fieldPath);

        if (value === undefined || value === null) {
            throw new Error(`Field "${fieldPath}" not found in response`);
        }

        // Validate pattern
        const result = this.patternValidator.validate(String(value), pattern);

        if (!result.isValid) {
            const errorDetails = result.error ? `\n  Error: ${result.error}` : '';
            throw new Error(
                `Field "${fieldPath}" does not match pattern:` +
                `\n  Pattern: ${pattern}` +
                `\n  Value: ${value}` +
                errorDetails
            );
        }

        CSReporter.pass(`Field "${fieldPath}" matches pattern: ${pattern}`);

        // If there are matched groups, log them
        if (result.matchedGroups && result.matchedGroups.length > 0) {
            CSReporter.debug(`Captured groups: ${result.matchedGroups.join(', ')}`);
        }
    }

    /**
     * Validate response field does NOT match pattern
     * Example: the response field "username" should not match pattern "admin"
     */
    @CSBDDStepDef('the response field {string} should not match pattern {string}')
    public async validateFieldNotMatchesPattern(
        fieldPath: string,
        pattern: string
    ): Promise<void> {
        const apiContext = CSApiContextManager.getInstance().getCurrentContext();
        const response = apiContext.getLastResponse();

        if (!response) {
            throw new Error('No response found. Execute an API request first.');
        }

        const value = this.extractValue(response.body, fieldPath);

        if (value === undefined || value === null) {
            throw new Error(`Field "${fieldPath}" not found in response`);
        }

        const result = this.patternValidator.validate(String(value), pattern);

        if (result.isValid) {
            throw new Error(
                `Field "${fieldPath}" should NOT match pattern but it does:` +
                `\n  Pattern: ${pattern}` +
                `\n  Value: ${value}`
            );
        }

        CSReporter.pass(`Field "${fieldPath}" does not match pattern: ${pattern}`);
    }

    /**
     * Validate response status is successful (2xx)
     * Example: the response should be successful
     */
    @CSBDDStepDef('the response should be successful')
    public async validateResponseSuccessful(): Promise<void> {
        const apiContext = CSApiContextManager.getInstance().getCurrentContext();
        const response = apiContext.getLastResponse();

        if (!response) {
            throw new Error('No response found. Execute an API request first.');
        }

        if (response.status < 200 || response.status >= 300) {
            const bodyPreview = typeof response.body === 'object'
                ? JSON.stringify(response.body, null, 2)
                : String(response.body);

            throw new Error(
                `Response is not successful:` +
                `\n  Status: ${response.status}` +
                `\n  Body: ${bodyPreview.substring(0, 500)}`
            );
        }

        CSReporter.pass(`Response is successful with status: ${response.status}`);
    }

    /**
     * Validate response status is error (4xx or 5xx)
     * Example: the response should be error
     */
    @CSBDDStepDef('the response should be error')
    public async validateResponseError(): Promise<void> {
        const apiContext = CSApiContextManager.getInstance().getCurrentContext();
        const response = apiContext.getLastResponse();

        if (!response) {
            throw new Error('No response found. Execute an API request first.');
        }

        if (response.status < 400) {
            throw new Error(`Response is not an error. Status: ${response.status}`);
        }

        CSReporter.pass(`Response is error with status: ${response.status}`);
    }

    /**
     * Validate validation error message for field
     * Supports multiple common error response structures
     *
     * Example: the validation error message for "email" should be "Invalid email format"
     */
    @CSBDDStepDef('the validation error message for {string} should be {string}')
    public async validateErrorMessage(
        field: string,
        expectedMessage: string
    ): Promise<void> {
        const apiContext = CSApiContextManager.getInstance().getCurrentContext();
        const response = apiContext.getLastResponse();

        if (!response) {
            throw new Error('No response found. Execute an API request first.');
        }

        // Common error response structures:
        // 1. { "errors": { "field": "message" } }
        // 2. { "validationErrors": [{ "field": "field", "message": "message" }] }
        // 3. { "error": { "field": { "message": "message" } } }
        // 4. { "errors": [{ "field": "field", "message": "message" }] }
        // 5. { "fieldErrors": { "field": "message" } }

        let actualMessage: string | undefined;

        // Structure 1: errors.field
        if (response.body?.errors?.[field]) {
            actualMessage = response.body.errors[field];
        }
        // Structure 2: validationErrors array
        else if (Array.isArray(response.body?.validationErrors)) {
            const error = response.body.validationErrors.find(
                (e: any) => e.field === field
            );
            if (error) {
                actualMessage = error.message;
            }
        }
        // Structure 3: error.field.message
        else if (response.body?.error?.[field]?.message) {
            actualMessage = response.body.error[field].message;
        }
        // Structure 4: errors array
        else if (Array.isArray(response.body?.errors)) {
            const error = response.body.errors.find(
                (e: any) => e.field === field || e.fieldName === field || e.name === field
            );
            if (error) {
                actualMessage = error.message || error.error || error.description;
            }
        }
        // Structure 5: fieldErrors.field
        else if (response.body?.fieldErrors?.[field]) {
            actualMessage = response.body.fieldErrors[field];
        }

        if (!actualMessage) {
            throw new Error(
                `Validation error message for field "${field}" not found in response:` +
                `\n${JSON.stringify(response.body, null, 2)}`
            );
        }

        expect(actualMessage).toBe(expectedMessage);

        CSReporter.pass(
            `Validation error message for "${field}" verified: ${actualMessage}`
        );
    }

    /**
     * Validate validation error message contains text
     * Example: the validation error message for "password" should contain "8 characters"
     */
    @CSBDDStepDef('the validation error message for {string} should contain {string}')
    public async validateErrorMessageContains(
        field: string,
        expectedText: string
    ): Promise<void> {
        const apiContext = CSApiContextManager.getInstance().getCurrentContext();
        const response = apiContext.getLastResponse();

        if (!response) {
            throw new Error('No response found. Execute an API request first.');
        }

        // Use same extraction logic as validateErrorMessage
        let actualMessage: string | undefined;

        if (response.body?.errors?.[field]) {
            actualMessage = response.body.errors[field];
        } else if (Array.isArray(response.body?.validationErrors)) {
            const error = response.body.validationErrors.find((e: any) => e.field === field);
            if (error) {
                actualMessage = error.message;
            }
        } else if (response.body?.error?.[field]?.message) {
            actualMessage = response.body.error[field].message;
        } else if (Array.isArray(response.body?.errors)) {
            const error = response.body.errors.find(
                (e: any) => e.field === field || e.fieldName === field
            );
            if (error) {
                actualMessage = error.message || error.error;
            }
        } else if (response.body?.fieldErrors?.[field]) {
            actualMessage = response.body.fieldErrors[field];
        }

        if (!actualMessage) {
            throw new Error(
                `Validation error message for field "${field}" not found in response`
            );
        }

        if (!actualMessage.includes(expectedText)) {
            throw new Error(
                `Validation error message for field "${field}" does not contain expected text:` +
                `\n  Expected to contain: ${expectedText}` +
                `\n  Actual message: ${actualMessage}`
            );
        }

        CSReporter.pass(
            `Validation error message for "${field}" contains: ${expectedText}`
        );
    }

    /**
     * Validate field value matches one of multiple patterns
     * Example: the response field "status" should match one of patterns "active|inactive|pending"
     */
    @CSBDDStepDef('the response field {string} should match one of patterns {string}')
    public async validateFieldMatchesOneOfPatterns(
        fieldPath: string,
        patternsString: string
    ): Promise<void> {
        const apiContext = CSApiContextManager.getInstance().getCurrentContext();
        const response = apiContext.getLastResponse();

        if (!response) {
            throw new Error('No response found. Execute an API request first.');
        }

        const value = this.extractValue(response.body, fieldPath);

        if (value === undefined || value === null) {
            throw new Error(`Field "${fieldPath}" not found in response`);
        }

        // Split patterns by | or comma
        const patterns = patternsString.split(/[|,]/).map(p => p.trim());

        // Check if value matches any pattern
        let matched = false;
        let matchedPattern: string | undefined;

        for (const pattern of patterns) {
            const result = this.patternValidator.validate(String(value), pattern);
            if (result.isValid) {
                matched = true;
                matchedPattern = pattern;
                break;
            }
        }

        if (!matched) {
            throw new Error(
                `Field "${fieldPath}" does not match any of the patterns:` +
                `\n  Patterns: ${patterns.join(', ')}` +
                `\n  Value: ${value}`
            );
        }

        CSReporter.pass(
            `Field "${fieldPath}" matches pattern "${matchedPattern}": ${value}`
        );
    }

    /**
     * Validate response time is within limit
     * Example: the response time should be less than 1000 milliseconds
     */
    @CSBDDStepDef('the response time should be less than {int} milliseconds')
    public async validateResponseTime(maxTime: number): Promise<void> {
        const apiContext = CSApiContextManager.getInstance().getCurrentContext();
        const response = apiContext.getLastResponse();

        if (!response) {
            throw new Error('No response found. Execute an API request first.');
        }

        const responseTime = response.duration || 0;

        if (responseTime > maxTime) {
            throw new Error(
                `Response time exceeds limit:` +
                `\n  Limit: ${maxTime}ms` +
                `\n  Actual: ${responseTime}ms`
            );
        }

        CSReporter.pass(`Response time ${responseTime}ms is within limit of ${maxTime}ms`);
    }

    /**
     * Extract value from response using dot notation
     * Supports array indexing: field[0].nested
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
}
