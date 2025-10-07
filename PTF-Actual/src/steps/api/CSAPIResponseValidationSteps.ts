import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSApiContext } from '../../api/context/CSApiContext';
import { CSApiContextManager } from '../../api/context/CSApiContextManager';
import { CSJSONPathValidator } from '../../api/validators/CSJSONPathValidator';
import { CSSchemaValidator } from '../../api/validators/CSSchemaValidator';
import { CSXMLValidator } from '../../api/validators/CSXMLValidator';
import { CSRegexValidator } from '../../api/validators/CSRegexValidator';
import { CSCustomValidator } from '../../api/validators/CSCustomValidator';
import { CSResponseTimeValidator } from '../../api/validators/CSResponseTimeValidator';
import { CSReporter } from '../../reporter/CSReporter';
import { CSResponse, CSValidationResult } from '../../api/types/CSApiTypes';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * BDD Step Definitions for API Response Validation
 * Provides comprehensive response validation and assertion capabilities
 */
export class CSAPIResponseValidationSteps {
    private contextManager: CSApiContextManager;
    private jsonPathValidator: CSJSONPathValidator;
    private schemaValidator: CSSchemaValidator;
    private xmlValidator: CSXMLValidator;
    private regexValidator: CSRegexValidator;
    private customValidator: CSCustomValidator;
    private responseTimeValidator: CSResponseTimeValidator;

    constructor() {
        this.contextManager = CSApiContextManager.getInstance();
        this.jsonPathValidator = new CSJSONPathValidator();
        this.schemaValidator = new CSSchemaValidator();
        this.xmlValidator = new CSXMLValidator();
        this.regexValidator = new CSRegexValidator();
        this.customValidator = new CSCustomValidator();
        this.responseTimeValidator = new CSResponseTimeValidator();
    }

    private getCurrentContext(): CSApiContext {
        const context = this.contextManager.getCurrentContext();
        if (!context) {
            throw new Error('No API context set. Please use "user is working with" step first');
        }
        return context;
    }

    private getResponse(alias?: string): CSResponse {
        const context = this.getCurrentContext();
        const response = alias ? context.getResponse(alias) : context.getLastResponse();

        if (!response) {
            throw new Error(alias ? `No response found with alias '${alias}'` : 'No response available');
        }

        return response;
    }

    @CSBDDStepDef("response status should be {int}")
    async validateResponseStatus(expectedStatus: number): Promise<void> {
        CSReporter.info(`Validating response status is ${expectedStatus}`);

        try {
            const response = this.getResponse();

            if (response.status !== expectedStatus) {
                throw new Error(`Expected status ${expectedStatus}, but got ${response.status}`);
            }

            CSReporter.pass(`Response status is ${expectedStatus}`);
        } catch (error) {
            CSReporter.fail(`Status validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response status should be between {int} and {int}")
    async validateResponseStatusRange(minStatus: number, maxStatus: number): Promise<void> {
        CSReporter.info(`Validating response status is between ${minStatus} and ${maxStatus}`);

        try {
            const response = this.getResponse();

            if (response.status < minStatus || response.status > maxStatus) {
                throw new Error(`Expected status between ${minStatus}-${maxStatus}, but got ${response.status}`);
            }

            CSReporter.pass(`Response status ${response.status} is in range ${minStatus}-${maxStatus}`);
        } catch (error) {
            CSReporter.fail(`Status range validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response header {string} should be {string}")
    async validateResponseHeader(headerName: string, expectedValue: string): Promise<void> {
        CSReporter.info(`Validating header ${headerName} equals ${expectedValue}`);

        try {
            const context = this.getCurrentContext();
            const response = this.getResponse();
            const interpolatedValue = this.interpolateValue(expectedValue, context);

            const actualValue = this.findHeader(response.headers, headerName);

            if (!actualValue) {
                throw new Error(`Header '${headerName}' not found in response`);
            }

            if (actualValue !== interpolatedValue) {
                throw new Error(`Expected header '${headerName}' to be '${interpolatedValue}', but got '${actualValue}'`);
            }

            CSReporter.pass(`Header ${headerName} equals ${interpolatedValue}`);
        } catch (error) {
            CSReporter.fail(`Header validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response header {string} should contain {string}")
    async validateResponseHeaderContains(headerName: string, expectedSubstring: string): Promise<void> {
        CSReporter.info(`Validating header ${headerName} contains ${expectedSubstring}`);

        try {
            const context = this.getCurrentContext();
            const response = this.getResponse();
            const interpolatedValue = this.interpolateValue(expectedSubstring, context);

            const actualValue = this.findHeader(response.headers, headerName);

            if (!actualValue) {
                throw new Error(`Header '${headerName}' not found in response`);
            }

            if (!actualValue.includes(interpolatedValue)) {
                throw new Error(`Expected header '${headerName}' to contain '${interpolatedValue}', but got '${actualValue}'`);
            }

            CSReporter.pass(`Header ${headerName} contains ${interpolatedValue}`);
        } catch (error) {
            CSReporter.fail(`Header validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response header {string} should exist")
    async validateResponseHeaderExists(headerName: string): Promise<void> {
        CSReporter.info(`Validating header ${headerName} exists`);

        try {
            const response = this.getResponse();
            const actualValue = this.findHeader(response.headers, headerName);

            if (!actualValue) {
                throw new Error(`Header '${headerName}' not found in response`);
            }

            CSReporter.pass(`Header ${headerName} exists with value: ${actualValue}`);
        } catch (error) {
            CSReporter.fail(`Header validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response JSON path {string} should equal {string}")
    async validateJSONPath(jsonPath: string, expectedValue: string): Promise<void> {
        CSReporter.info(`Validating JSON path ${jsonPath} equals ${expectedValue}`);

        try {
            const context = this.getCurrentContext();
            const response = this.getResponse();
            const interpolatedValue = this.interpolateValue(expectedValue, context);

            const result = await this.jsonPathValidator.validate(response, {
                path: jsonPath,
                value: interpolatedValue
            });

            if (!result.valid) {
                throw new Error(result.message || `JSON path validation failed`);
            }

            CSReporter.pass(`JSON path ${jsonPath} equals ${interpolatedValue}`);
        } catch (error) {
            CSReporter.fail(`JSON path validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response JSON path {string} should exist")
    async validateJSONPathExists(jsonPath: string): Promise<void> {
        CSReporter.info(`Validating JSON path ${jsonPath} exists`);

        try {
            const response = this.getResponse();

            const result = await this.jsonPathValidator.validate(response, {
                path: jsonPath,
                exists: true
            });

            if (!result.valid) {
                throw new Error(result.message || `JSON path ${jsonPath} does not exist`);
            }

            CSReporter.pass(`JSON path ${jsonPath} exists`);
        } catch (error) {
            CSReporter.fail(`JSON path validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response JSON path {string} should be of type {string}")
    async validateJSONPathType(jsonPath: string, expectedType: string): Promise<void> {
        CSReporter.info(`Validating JSON path ${jsonPath} is of type ${expectedType}`);

        try {
            const response = this.getResponse();

            const result = await this.jsonPathValidator.validate(response, {
                path: jsonPath,
                type: expectedType
            });

            if (!result.valid) {
                throw new Error(result.message || `JSON path type validation failed`);
            }

            CSReporter.pass(`JSON path ${jsonPath} is of type ${expectedType}`);
        } catch (error) {
            CSReporter.fail(`JSON path type validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response body should match JSON schema in {string}")
    async validateJSONSchema(schemaFile: string): Promise<void> {
        CSReporter.info(`Validating response body against JSON schema: ${schemaFile}`);

        try {
            const response = this.getResponse();
            const schemaPath = this.resolveFilePath(schemaFile);

            if (!fs.existsSync(schemaPath)) {
                throw new Error(`Schema file not found: ${schemaPath}`);
            }

            const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

            const result = await this.schemaValidator.validate(response, {
                schema,
                type: 'json-schema'
            });

            if (!result.valid) {
                throw new Error(result.message || 'JSON schema validation failed');
            }

            CSReporter.pass('Response body matches JSON schema');
        } catch (error) {
            CSReporter.fail(`JSON schema validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response body should contain {string}")
    async validateResponseBodyContains(expectedText: string): Promise<void> {
        CSReporter.info(`Validating response body contains: ${expectedText}`);

        try {
            const context = this.getCurrentContext();
            const response = this.getResponse();
            const interpolatedText = this.interpolateValue(expectedText, context);

            const bodyText = typeof response.body === 'string'
                ? response.body
                : JSON.stringify(response.body);

            if (!bodyText.includes(interpolatedText)) {
                throw new Error(`Response body does not contain: ${interpolatedText}`);
            }

            CSReporter.pass(`Response body contains: ${interpolatedText}`);
        } catch (error) {
            CSReporter.fail(`Body validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response body should match regex {string}")
    async validateResponseBodyRegex(pattern: string): Promise<void> {
        CSReporter.info(`Validating response body matches regex: ${pattern}`);

        try {
            const response = this.getResponse();

            const result = await this.regexValidator.validate(response, {
                pattern,
                flags: 'gim'
            });

            if (!result.valid) {
                throw new Error(result.message || 'Regex validation failed');
            }

            CSReporter.pass(`Response body matches regex: ${pattern}`);
        } catch (error) {
            CSReporter.fail(`Regex validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response time should be less than {int} ms")
    async validateResponseTime(maxTime: number): Promise<void> {
        CSReporter.info(`Validating response time is less than ${maxTime}ms`);

        try {
            const response = this.getResponse();

            const result = await this.responseTimeValidator.validate(response, {
                maxTime
            });

            if (!result.valid) {
                throw new Error(result.message || `Response time exceeds ${maxTime}ms`);
            }

            CSReporter.pass(`Response time (${response.duration}ms) is less than ${maxTime}ms`);
        } catch (error) {
            CSReporter.fail(`Response time validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response size should be less than {int} bytes")
    async validateResponseSize(maxSize: number): Promise<void> {
        CSReporter.info(`Validating response size is less than ${maxSize} bytes`);

        try {
            const response = this.getResponse();
            const bodySize = Buffer.byteLength(JSON.stringify(response.body), 'utf8');

            if (bodySize > maxSize) {
                throw new Error(`Response size (${bodySize} bytes) exceeds ${maxSize} bytes`);
            }

            CSReporter.pass(`Response size (${bodySize} bytes) is less than ${maxSize} bytes`);
        } catch (error) {
            CSReporter.fail(`Response size validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response XML path {string} should equal {string}")
    async validateXMLPath(xmlPath: string, expectedValue: string): Promise<void> {
        CSReporter.info(`Validating XML path ${xmlPath} equals ${expectedValue}`);

        try {
            const context = this.getCurrentContext();
            const response = this.getResponse();
            const interpolatedValue = this.interpolateValue(expectedValue, context);

            const result = await this.xmlValidator.validate(response, {
                xpath: xmlPath,
                value: interpolatedValue
            });

            if (!result.valid) {
                throw new Error(result.message || 'XML path validation failed');
            }

            CSReporter.pass(`XML path ${xmlPath} equals ${interpolatedValue}`);
        } catch (error) {
            CSReporter.fail(`XML path validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response body should be empty")
    async validateResponseBodyEmpty(): Promise<void> {
        CSReporter.info('Validating response body is empty');

        try {
            const response = this.getResponse();

            if (response.body && Object.keys(response.body).length > 0) {
                throw new Error('Response body is not empty');
            }

            CSReporter.pass('Response body is empty');
        } catch (error) {
            CSReporter.fail(`Body validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response should have {int} cookies")
    async validateCookieCount(expectedCount: number): Promise<void> {
        CSReporter.info(`Validating response has ${expectedCount} cookies`);

        try {
            const response = this.getResponse();
            const actualCount = response.cookies?.length || 0;

            if (actualCount !== expectedCount) {
                throw new Error(`Expected ${expectedCount} cookies, but got ${actualCount}`);
            }

            CSReporter.pass(`Response has ${expectedCount} cookies`);
        } catch (error) {
            CSReporter.fail(`Cookie validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response cookie {string} should exist")
    async validateCookieExists(cookieName: string): Promise<void> {
        CSReporter.info(`Validating cookie ${cookieName} exists`);

        try {
            const response = this.getResponse();
            const cookie = response.cookies?.find((c: any) => c.name === cookieName);

            if (!cookie) {
                throw new Error(`Cookie '${cookieName}' not found in response`);
            }

            CSReporter.pass(`Cookie ${cookieName} exists with value: ${cookie.value}`);
        } catch (error) {
            CSReporter.fail(`Cookie validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response body MD5 hash should be {string}")
    async validateResponseBodyMD5(expectedHash: string): Promise<void> {
        CSReporter.info(`Validating response body MD5 hash is ${expectedHash}`);

        try {
            const response = this.getResponse();
            const bodyText = typeof response.body === 'string'
                ? response.body
                : JSON.stringify(response.body);

            const actualHash = crypto.createHash('md5').update(bodyText).digest('hex');

            if (actualHash !== expectedHash) {
                throw new Error(`Expected MD5 hash ${expectedHash}, but got ${actualHash}`);
            }

            CSReporter.pass(`Response body MD5 hash matches: ${expectedHash}`);
        } catch (error) {
            CSReporter.fail(`MD5 validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response JSON path {string} array should have length {int}")
    async validateJSONArrayLength(jsonPath: string, expectedLength: number): Promise<void> {
        CSReporter.info(`Validating JSON array ${jsonPath} has length ${expectedLength}`);

        try {
            const response = this.getResponse();

            const result = await this.jsonPathValidator.validate(response, {
                path: jsonPath,
                arrayLength: expectedLength
            });

            if (!result.valid) {
                throw new Error(result.message || `Array length validation failed`);
            }

            CSReporter.pass(`JSON array ${jsonPath} has length ${expectedLength}`);
        } catch (error) {
            CSReporter.fail(`Array length validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response JSON should have properties:")
    async validateJSONProperties(dataTable: any): Promise<void> {
        CSReporter.info('Validating JSON properties');

        try {
            const response = this.getResponse();
            const rows = dataTable.raw ? dataTable.raw() : dataTable;
            let failedValidations: string[] = [];

            for (const row of rows) {
                const propertyPath = row[0];
                const expectedValue = row[1];

                if (!propertyPath) continue;

                const result = await this.jsonPathValidator.validate(response, {
                    path: propertyPath,
                    value: expectedValue
                });

                if (!result.valid) {
                    failedValidations.push(`${propertyPath}: ${result.message}`);
                }
            }

            if (failedValidations.length > 0) {
                throw new Error(`Validation failed for properties:\n${failedValidations.join('\n')}`);
            }

            CSReporter.pass(`All ${rows.length} JSON properties validated successfully`);
        } catch (error) {
            CSReporter.fail(`JSON properties validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response from {string} status should be {int}")
    async validateNamedResponseStatus(alias: string, expectedStatus: number): Promise<void> {
        CSReporter.info(`Validating response '${alias}' status is ${expectedStatus}`);

        try {
            const response = this.getResponse(alias);

            if (response.status !== expectedStatus) {
                throw new Error(`Expected status ${expectedStatus}, but got ${response.status}`);
            }

            CSReporter.pass(`Response '${alias}' status is ${expectedStatus}`);
        } catch (error) {
            CSReporter.fail(`Status validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response body should be valid JSON")
    async validateResponseIsJSON(): Promise<void> {
        CSReporter.info('Validating response body is valid JSON');

        try {
            const response = this.getResponse();

            if (typeof response.body === 'string') {
                try {
                    JSON.parse(response.body);
                } catch {
                    throw new Error('Response body is not valid JSON');
                }
            }

            CSReporter.pass('Response body is valid JSON');
        } catch (error) {
            CSReporter.fail(`JSON validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("response should match custom validation {string}")
    async validateCustom(validationName: string): Promise<void> {
        CSReporter.info(`Running custom validation: ${validationName}`);

        try {
            const response = this.getResponse();
            const context = this.getCurrentContext();

            const customValidation = context.getVariable(`validation_${validationName}`);
            if (!customValidation || typeof customValidation !== 'function') {
                throw new Error(`Custom validation '${validationName}' not found`);
            }

            const result = await this.customValidator.validate(response, {
                validator: customValidation
            });

            if (!result.valid) {
                throw new Error(result.message || 'Custom validation failed');
            }

            CSReporter.pass(`Custom validation '${validationName}' passed`);
        } catch (error) {
            CSReporter.fail(`Custom validation failed: ${(error as Error).message}`);
            throw error;
        }
    }

    // Helper methods
    private findHeader(headers: any, headerName: string): string | undefined {
        if (!headers) return undefined;

        const lowerHeaderName = headerName.toLowerCase();
        for (const [key, value] of Object.entries(headers)) {
            if (key.toLowerCase() === lowerHeaderName) {
                return String(value);
            }
        }

        return undefined;
    }

    private interpolateValue(value: string, context: CSApiContext): string {
        if (!value.includes('{{')) {
            return value;
        }

        return value.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
            const varValue = context.getVariable(varName);
            return varValue !== undefined ? String(varValue) : match;
        });
    }

    private resolveFilePath(filePath: string): string {
        if (path.isAbsolute(filePath)) {
            return filePath;
        }

        const testDataPath = process.env.TEST_DATA_PATH || './test-data';
        const resolvedPath = path.join(testDataPath, 'api', 'schemas', filePath);

        if (fs.existsSync(resolvedPath)) {
            return resolvedPath;
        }

        const cwdPath = path.join(process.cwd(), filePath);
        if (fs.existsSync(cwdPath)) {
            return cwdPath;
        }

        return filePath;
    }
}