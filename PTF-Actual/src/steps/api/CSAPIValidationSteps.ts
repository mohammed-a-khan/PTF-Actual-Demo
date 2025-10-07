import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSApiContextManager } from '../../api/context/CSApiContextManager';
import { CSAPIValidator } from '../../api/CSAPIValidator';
import { CSReporter } from '../../reporter/CSReporter';
import { CSValidationConfig } from '../../api/types/CSApiTypes';
import { CSJSONPathValidator, CSJSONPathValidationConfig } from '../../api/validators/CSJSONPathValidator';

export class CSAPIValidationSteps {
    private contextManager: CSApiContextManager;
    private validator: CSAPIValidator;

    constructor() {
        this.contextManager = CSApiContextManager.getInstance();
        this.validator = new CSAPIValidator();
    }

    @CSBDDStepDef("the response status should be {int}")
    async validateResponseStatusCode(expectedStatus: number): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const response = context?.getLastResponse();

        if (!response) {
            throw new Error('No response available to validate');
        }

        const validations: CSValidationConfig[] = [{
            type: 'status',
            config: { expected: expectedStatus }
        }];

        const result = await this.validator.validate(response, validations);

        if (!result.valid) {
            throw new Error(`Status validation failed: Expected ${expectedStatus}, got ${response.status}`);
        }

        CSReporter.pass(`Response status is ${expectedStatus}`);
    }

    @CSBDDStepDef("the response status should be between {int} and {int}")
    async validateResponseStatusInRange(minStatus: number, maxStatus: number): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const response = context?.getLastResponse();

        if (!response) {
            throw new Error('No response available to validate');
        }

        if (response.status < minStatus || response.status > maxStatus) {
            throw new Error(`Status validation failed: Expected ${minStatus}-${maxStatus}, got ${response.status}`);
        }

        CSReporter.pass(`Response status ${response.status} is between ${minStatus} and ${maxStatus}`);
    }

    @CSBDDStepDef("the response header {string} should exist")
    async validateHeaderExists(headerName: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const response = context?.getLastResponse();

        if (!response) {
            throw new Error('No response available to validate');
        }

        const validations: CSValidationConfig[] = [{
            type: 'header',
            config: {
                name: headerName,
                exists: true
            }
        }];

        const result = await this.validator.validate(response, validations);

        if (!result.valid) {
            throw new Error(`Header '${headerName}' not found in response`);
        }

        CSReporter.pass(`Response header '${headerName}' exists`);
    }

    @CSBDDStepDef("the response header {string} should be {string}")
    async validateHeaderValue(headerName: string, expectedValue: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const response = context?.getLastResponse();

        if (!response) {
            throw new Error('No response available to validate');
        }

        const validations: CSValidationConfig[] = [{
            type: 'header',
            config: {
                name: headerName,
                value: expectedValue
            }
        }];

        const result = await this.validator.validate(response, validations);

        if (!result.valid) {
            const actualValue = response.headers[headerName.toLowerCase()];
            throw new Error(`Header validation failed: '${headerName}' expected '${expectedValue}', got '${actualValue}'`);
        }

        CSReporter.pass(`Response header '${headerName}' is '${expectedValue}'`);
    }

    @CSBDDStepDef("the response header {string} should contain {string}")
    async validateHeaderContains(headerName: string, expectedValue: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const response = context?.getLastResponse();

        if (!response) {
            throw new Error('No response available to validate');
        }

        const actualValue = response.headers[headerName.toLowerCase()];

        if (!actualValue) {
            throw new Error(`Header validation failed: Header '${headerName}' not found in response`);
        }

        if (!String(actualValue).includes(expectedValue)) {
            throw new Error(`Header validation failed: '${headerName}' expected to contain '${expectedValue}', got '${actualValue}'`);
        }

        CSReporter.pass(`Response header '${headerName}' contains '${expectedValue}'`);
    }

    @CSBDDStepDef("the response body should contain {string}")
    async validateBodyContains(expectedText: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const response = context?.getLastResponse();

        if (!response) {
            throw new Error('No response available to validate');
        }

        const validations: CSValidationConfig[] = [{
            type: 'body',
            config: {
                contains: expectedText
            }
        }];

        const result = await this.validator.validate(response, validations);

        if (!result.valid) {
            throw new Error(`Body validation failed: Response does not contain '${expectedText}'`);
        }

        CSReporter.pass(`Response body contains '${expectedText}'`);
    }

    @CSBDDStepDef("the response body should not contain {string}")
    async validateBodyNotContains(unexpectedText: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const response = context?.getLastResponse();

        if (!response) {
            throw new Error('No response available to validate');
        }

        const validations: CSValidationConfig[] = [{
            type: 'body',
            config: {
                notContains: unexpectedText
            }
        }];

        const result = await this.validator.validate(response, validations);

        if (!result.valid) {
            throw new Error(`Body validation failed: Response contains '${unexpectedText}'`);
        }

        CSReporter.pass(`Response body does not contain '${unexpectedText}'`);
    }

    @CSBDDStepDef("the response body JSON path {string} should exist")
    async validateJsonPathExists(jsonPath: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const response = context?.getLastResponse();

        if (!response) {
            throw new Error('No response available to validate');
        }

        const validations: CSValidationConfig[] = [{
            type: 'jsonpath',
            config: {
                path: jsonPath,
                exists: true
            }
        }];

        const result = await this.validator.validate(response, validations);

        if (!result.valid) {
            throw new Error(`JSONPath validation failed: Path '${jsonPath}' does not exist`);
        }

        CSReporter.pass(`JSONPath '${jsonPath}' exists in response`);
    }

    @CSBDDStepDef("the response body JSON path {string} should not contain {string}")
    async validateJsonPathNotContains(jsonPath: string, unexpectedValue: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const response = context?.getLastResponse();

        if (!response) {
            throw new Error('No response available to validate');
        }

        try {
            // First try to check if the path exists
            const checkExistence: CSValidationConfig[] = [{
                type: 'jsonpath',
                config: {
                    path: jsonPath,
                    exists: true
                }
            }];

            const existsResult = await this.validator.validate(response, checkExistence);

            if (!existsResult.valid) {
                // Path doesn't exist, which means it doesn't contain the value - this is valid
                CSReporter.pass(`JSONPath '${jsonPath}' does not exist, therefore does not contain '${unexpectedValue}'`);
                return;
            }

            // Path exists, now check if it contains the value
            const validations: CSValidationConfig[] = [{
                type: 'jsonpath',
                config: {
                    path: jsonPath,
                    custom: (value: any) => {
                        if (value === undefined || value === null) {
                            return true; // Pass if value doesn't exist
                        }
                        const valueStr = String(value);
                        if (valueStr.includes(unexpectedValue)) {
                            return `Value at '${jsonPath}' should not contain '${unexpectedValue}' but was '${valueStr}'`;
                        }
                        return true;
                    }
                } as CSJSONPathValidationConfig
            }];

            const result = await this.validator.validate(response, validations);

            if (!result.valid) {
                const error = result.errors?.[0];
                throw new Error(error?.message || `JSONPath validation failed: '${jsonPath}' should not contain '${unexpectedValue}'`);
            }

            CSReporter.pass(`JSONPath '${jsonPath}' does not contain '${unexpectedValue}'`);
        } catch (error) {
            // If there's any error in validation, treat it as path not existing (which is valid for "not contains")
            if ((error as Error).message?.includes('Cannot read properties')) {
                CSReporter.pass(`JSONPath '${jsonPath}' does not contain '${unexpectedValue}'`);
                return;
            }
            throw error;
        }
    }

    @CSBDDStepDef("the response body JSON path {string} should be {string}")
    async validateJsonPathValue(jsonPath: string, expectedValue: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const response = context?.getLastResponse();

        if (!response) {
            throw new Error('No response available to validate');
        }

        // Convert expected value to appropriate type
        // Keep as string by default to match string values from query params
        let expected: any = expectedValue;
        if (expectedValue === 'true') expected = true;
        else if (expectedValue === 'false') expected = false;
        else if (expectedValue === 'null') expected = null;
        // Keep as string to allow matching both string and number values

        const validations: CSValidationConfig[] = [{
            type: 'jsonpath',
            config: {
                path: jsonPath,
                value: expected
            }
        }];

        const result = await this.validator.validate(response, validations);

        if (!result.valid) {
            throw new Error(`JSONPath validation failed: '${jsonPath}' expected '${expectedValue}'`);
        }

        CSReporter.pass(`JSONPath '${jsonPath}' equals '${expectedValue}'`);
    }

    @CSBDDStepDef("the response body JSON path {string} should be true")
    async validateJsonPathTrue(jsonPath: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const response = context?.getLastResponse();

        if (!response) {
            throw new Error('No response available to validate');
        }

        const validations: CSValidationConfig[] = [{
            type: 'jsonpath',
            config: {
                path: jsonPath,
                value: true
            }
        }];

        const result = await this.validator.validate(response, validations);

        if (!result.valid) {
            throw new Error(`JSONPath validation failed: '${jsonPath}' expected 'true'`);
        }

        CSReporter.pass(`JSONPath '${jsonPath}' equals 'true'`);
    }

    @CSBDDStepDef("the response body JSON path {string} should be false")
    async validateJsonPathFalse(jsonPath: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const response = context?.getLastResponse();

        if (!response) {
            throw new Error('No response available to validate');
        }

        const validations: CSValidationConfig[] = [{
            type: 'jsonpath',
            config: {
                path: jsonPath,
                value: false
            }
        }];

        const result = await this.validator.validate(response, validations);

        if (!result.valid) {
            throw new Error(`JSONPath validation failed: '${jsonPath}' expected 'false'`);
        }

        CSReporter.pass(`JSONPath '${jsonPath}' equals 'false'`);
    }

    @CSBDDStepDef("the response body JSON path {string} should be {int}")
    async validateJsonPathInt(jsonPath: string, expectedValue: number): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const response = context?.getLastResponse();

        if (!response) {
            throw new Error('No response available to validate');
        }

        const validations: CSValidationConfig[] = [{
            type: 'jsonpath',
            config: {
                path: jsonPath,
                value: expectedValue
            }
        }];

        const result = await this.validator.validate(response, validations);

        if (!result.valid) {
            throw new Error(`JSONPath validation failed: '${jsonPath}' expected '${expectedValue}'`);
        }

        CSReporter.pass(`JSONPath '${jsonPath}' equals '${expectedValue}'`);
    }

    @CSBDDStepDef("the response body JSON path {string} should be {float}")
    async validateJsonPathFloat(jsonPath: string, expectedValue: number): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const response = context?.getLastResponse();

        if (!response) {
            throw new Error('No response available to validate');
        }

        const validations: CSValidationConfig[] = [{
            type: 'jsonpath',
            config: {
                path: jsonPath,
                value: expectedValue
            }
        }];

        const result = await this.validator.validate(response, validations);

        if (!result.valid) {
            throw new Error(`JSONPath validation failed: '${jsonPath}' expected '${expectedValue}'`);
        }

        CSReporter.pass(`JSONPath '${jsonPath}' equals '${expectedValue}'`);
    }

    @CSBDDStepDef("the response body JSON path {string} should be null")
    async validateJsonPathNull(jsonPath: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const response = context?.getLastResponse();

        if (!response) {
            throw new Error('No response available to validate');
        }

        const validations: CSValidationConfig[] = [{
            type: 'jsonpath',
            config: {
                path: jsonPath,
                value: null
            }
        }];

        const result = await this.validator.validate(response, validations);

        if (!result.valid) {
            throw new Error(`JSONPath validation failed: '${jsonPath}' expected 'null'`);
        }

        CSReporter.pass(`JSONPath '${jsonPath}' equals 'null'`);
    }

    @CSBDDStepDef("the response body should match schema:")
    async validateJsonSchema(schemaString: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const response = context?.getLastResponse();

        if (!response) {
            throw new Error('No response available to validate');
        }

        const schema = JSON.parse(schemaString);

        const validations: CSValidationConfig[] = [{
            type: 'schema',
            config: {
                schema,
                type: 'json'
            }
        }];

        const result = await this.validator.validate(response, validations);

        if (!result.valid) {
            throw new Error(`Schema validation failed: ${result.errors?.map(e => e.message).join(', ')}`);
        }

        CSReporter.pass('Response body matches JSON schema');
    }

    @CSBDDStepDef("the response body should be empty")
    async validateBodyEmpty(): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const response = context?.getLastResponse();

        if (!response) {
            throw new Error('No response available to validate');
        }

        const validations: CSValidationConfig[] = [{
            type: 'body',
            config: {
                empty: true
            }
        }];

        const result = await this.validator.validate(response, validations);

        if (!result.valid) {
            throw new Error('Body validation failed: Response body is not empty');
        }

        CSReporter.pass('Response body is empty');
    }

    @CSBDDStepDef("the response time should be less than {int} ms")
    async validateResponseDuration(maxDuration: number): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const response = context?.getLastResponse();

        if (!response) {
            throw new Error('No response available to validate');
        }

        if (response.duration > maxDuration) {
            throw new Error(`Response time validation failed: ${response.duration}ms > ${maxDuration}ms`);
        }

        CSReporter.pass(`Response time ${response.duration}ms is less than ${maxDuration}ms`);
    }

    @CSBDDStepDef("I validate the response with custom validation:")
    async validateCustomResponse(validationCode: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const response = context?.getLastResponse();

        if (!response) {
            throw new Error('No response available to validate');
        }

        // Create a function from the validation code
        const validationFunc = new Function('response', 'context', validationCode);

        try {
            const result = await validationFunc(response, context);
            if (result === false) {
                throw new Error('Custom validation failed');
            }
            CSReporter.pass('Custom validation passed');
        } catch (error) {
            throw new Error(`Custom validation failed: ${(error as Error).message}`);
        }
    }
}