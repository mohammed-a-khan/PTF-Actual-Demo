import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSApiContext } from '../../api/context/CSApiContext';
import { CSApiContextManager } from '../../api/context/CSApiContextManager';
import { CSApiChainContext, CSChainStep } from '../../api/context/CSApiChainContext';
import { CSJSONPathValidator } from '../../api/validators/CSJSONPathValidator';
import { CSXMLValidator } from '../../api/validators/CSXMLValidator';
import { CSReporter } from '../../reporter/CSReporter';
import { CSResponse } from '../../api/types/CSApiTypes';

/**
 * BDD Step Definitions for API Request Chaining
 * Provides comprehensive chaining operations between API responses and requests
 */
export class CSAPIChainingSteps {
    private contextManager: CSApiContextManager;
    private chainContext: CSApiChainContext | null = null;
    private jsonPathValidator: CSJSONPathValidator;
    private xmlValidator: CSXMLValidator;

    constructor() {
        this.contextManager = CSApiContextManager.getInstance();
        this.jsonPathValidator = new CSJSONPathValidator();
        this.xmlValidator = new CSXMLValidator();
    }

    private getChainContext(): CSApiChainContext {
        if (!this.chainContext) {
            this.chainContext = new CSApiChainContext('default-chain');
        }
        return this.chainContext;
    }

    private getCurrentContext(): CSApiContext {
        const context = this.contextManager.getCurrentContext();
        if (!context) {
            throw new Error('No API context set. Please use "user is working with" step first');
        }
        return context;
    }

    @CSBDDStepDef("user uses response JSON path {string} from {string} as request body field {string}")
    async useJSONPathAsBodyField(jsonPath: string, responseAlias: string, fieldName: string): Promise<void> {
        CSReporter.info(`Using JSON path ${jsonPath} from ${responseAlias} as body field ${fieldName}`);

        try {
            const context = this.getCurrentContext();
            const storedResponse = context.getResponse(responseAlias);

            if (!storedResponse) {
                throw new Error(`No response found with alias '${responseAlias}'`);
            }

            const value = await this.extractJSONPath(storedResponse, jsonPath);

            // Get or create request body
            let body = context.getVariable('requestBody') || {};
            if (typeof body !== 'object') {
                body = {};
            }

            // Set nested property
            this.setNestedProperty(body, fieldName, value);
            context.setVariable('requestBody', body);

            // Add to chain context
            this.getChainContext().saveStepResult(`${responseAlias}.${fieldName}`, value);

            CSReporter.pass(`Extracted value from ${jsonPath} and set to body field ${fieldName}`);
        } catch (error) {
            CSReporter.fail(`Failed to use JSON path: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user uses response header {string} from {string} as request header {string}")
    async useResponseHeaderAsRequestHeader(sourceHeader: string, responseAlias: string, targetHeader: string): Promise<void> {
        CSReporter.info(`Using header ${sourceHeader} from ${responseAlias} as ${targetHeader}`);

        try {
            const context = this.getCurrentContext();
            const storedResponse = context.getResponse(responseAlias);

            if (!storedResponse) {
                throw new Error(`No response found with alias '${responseAlias}'`);
            }

            const headerValue = this.findHeader(storedResponse.headers, sourceHeader);
            if (!headerValue) {
                throw new Error(`Header '${sourceHeader}' not found in response '${responseAlias}'`);
            }

            context.setHeader(targetHeader, headerValue);
            this.getChainContext().saveStepResult(`header.${targetHeader}`, headerValue);

            CSReporter.pass(`Header ${sourceHeader} copied to ${targetHeader}`);
        } catch (error) {
            CSReporter.fail(`Failed to use response header: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user uses {string} in request URL {string}")
    async useVariableInURL(variableName: string, urlPath: string): Promise<void> {
        CSReporter.info(`Using variable ${variableName} in URL path ${urlPath}`);

        try {
            const context = this.getCurrentContext();
            const variableValue = context.getVariable(variableName);

            if (variableValue === undefined) {
                throw new Error(`Variable '${variableName}' not found`);
            }

            const interpolatedPath = urlPath.replace(`{{${variableName}}}`, String(variableValue));
            context.setVariable('requestPath', interpolatedPath);

            CSReporter.pass(`URL path set to: ${interpolatedPath}`);
        } catch (error) {
            CSReporter.fail(`Failed to use variable in URL: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user uses last response JSON path {string} as header {string} with prefix {string}")
    async useLastResponseJSONPathAsHeaderWithPrefix(jsonPath: string, headerName: string, prefix: string): Promise<void> {
        CSReporter.info(`Using last response JSON path ${jsonPath} as header ${headerName} with prefix ${prefix}`);

        try {
            const context = this.getCurrentContext();
            const lastResponse = context.getLastResponse();

            if (!lastResponse) {
                throw new Error('No last response available');
            }

            const value = await this.extractJSONPath(lastResponse, jsonPath);
            const headerValue = prefix + String(value);

            context.setHeader(headerName, headerValue);
            this.getChainContext().saveStepResult(`header.${headerName}`, headerValue);

            CSReporter.pass(`Header ${headerName} set to: ${headerValue}`);
        } catch (error) {
            CSReporter.fail(`Failed to use last response JSON path: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user chains from {string} to request body:")
    async chainMultipleValuesToBody(responseAlias: string, dataTable: any): Promise<void> {
        CSReporter.info(`Chaining multiple values from ${responseAlias} to request body`);

        try {
            const context = this.getCurrentContext();
            const storedResponse = context.getResponse(responseAlias);

            if (!storedResponse) {
                throw new Error(`No response found with alias '${responseAlias}'`);
            }

            let body = context.getVariable('requestBody') || {};
            if (typeof body !== 'object') {
                body = {};
            }

            const rows = dataTable.raw ? dataTable.raw() : dataTable;
            let chainedCount = 0;

            for (const row of rows) {
                const sourcePath = row[0];
                const targetField = row[1];

                if (!sourcePath || !targetField) {
                    continue;
                }

                try {
                    const value = await this.extractJSONPath(storedResponse, sourcePath);
                    this.setNestedProperty(body, targetField, value);
                    chainedCount++;
                } catch (e) {
                    CSReporter.warn(`Failed to extract ${sourcePath}: ${(e as Error).message}`);
                }
            }

            context.setVariable('requestBody', body);
            CSReporter.pass(`Chained ${chainedCount} values to request body`);
        } catch (error) {
            CSReporter.fail(`Failed to chain multiple values: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user uses XML path {string} from {string} as query parameter {string}")
    async useXMLPathAsQueryParameter(xmlPath: string, responseAlias: string, paramName: string): Promise<void> {
        CSReporter.info(`Using XML path ${xmlPath} from ${responseAlias} as query parameter ${paramName}`);

        try {
            const context = this.getCurrentContext();
            const storedResponse = context.getResponse(responseAlias);

            if (!storedResponse) {
                throw new Error(`No response found with alias '${responseAlias}'`);
            }

            const xmlBody = this.getResponseBodyAsString(storedResponse);
            const validation = await this.xmlValidator.validate(storedResponse, {
                xpath: xmlPath,
                exists: true
            });

            if (!validation.valid) {
                throw new Error(`XML path '${xmlPath}' not found`);
            }

            // Extract value using simple XML parsing (for production use proper XML library)
            const value = this.extractSimpleXMLValue(xmlBody, xmlPath);

            const queryParams = context.getVariable('queryParams') || {};
            queryParams[paramName] = String(value);
            context.setVariable('queryParams', queryParams);

            CSReporter.pass(`Query parameter ${paramName} set to: ${value}`);
        } catch (error) {
            CSReporter.fail(`Failed to use XML path: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user creates request body from {string} with transformation:")
    async createBodyFromResponseWithTransformation(responseAlias: string, template: string): Promise<void> {
        CSReporter.info(`Creating request body from ${responseAlias} with transformation`);

        try {
            const context = this.getCurrentContext();
            const storedResponse = context.getResponse(responseAlias);

            if (!storedResponse) {
                throw new Error(`No response found with alias '${responseAlias}'`);
            }

            let transformedBody = template;
            const placeholderRegex = /\{\{(\$[^}]+)\}\}/g;
            let match;

            while ((match = placeholderRegex.exec(template)) !== null) {
                const jsonPath = match[1];
                try {
                    const value = await this.extractJSONPath(storedResponse, jsonPath);
                    transformedBody = transformedBody.replace(match[0], JSON.stringify(value));
                } catch (e) {
                    CSReporter.warn(`Failed to extract ${jsonPath}: ${(e as Error).message}`);
                }
            }

            const finalBody = JSON.parse(transformedBody);
            context.setVariable('requestBody', finalBody);

            CSReporter.pass('Request body created with transformation');
        } catch (error) {
            CSReporter.fail(`Failed to create body from response: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user appends JSON path {string} from {string} to request body array {string}")
    async appendToBodyArray(jsonPath: string, responseAlias: string, arrayField: string): Promise<void> {
        CSReporter.info(`Appending ${jsonPath} from ${responseAlias} to array ${arrayField}`);

        try {
            const context = this.getCurrentContext();
            const storedResponse = context.getResponse(responseAlias);

            if (!storedResponse) {
                throw new Error(`No response found with alias '${responseAlias}'`);
            }

            const value = await this.extractJSONPath(storedResponse, jsonPath);

            let body = context.getVariable('requestBody') || {};
            if (typeof body !== 'object') {
                body = {};
            }

            let array = this.getNestedProperty(body, arrayField);
            if (!Array.isArray(array)) {
                array = [];
            }

            array.push(value);
            this.setNestedProperty(body, arrayField, array);
            context.setVariable('requestBody', body);

            CSReporter.pass(`Appended value to array ${arrayField}, new length: ${array.length}`);
        } catch (error) {
            CSReporter.fail(`Failed to append to body array: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user merges response from {string} into request body")
    async mergeResponseIntoBody(responseAlias: string): Promise<void> {
        CSReporter.info(`Merging response from ${responseAlias} into request body`);

        try {
            const context = this.getCurrentContext();
            const storedResponse = context.getResponse(responseAlias);

            if (!storedResponse) {
                throw new Error(`No response found with alias '${responseAlias}'`);
            }

            let body = context.getVariable('requestBody') || {};
            if (typeof body !== 'object') {
                body = {};
            }

            const responseData = storedResponse.body;
            const mergedBody = this.deepMerge(body, responseData);
            context.setVariable('requestBody', mergedBody);

            CSReporter.pass('Response merged into request body');
        } catch (error) {
            CSReporter.fail(`Failed to merge response: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user uses status code from {string} as query parameter {string}")
    async useStatusCodeAsQueryParameter(responseAlias: string, paramName: string): Promise<void> {
        CSReporter.info(`Using status code from ${responseAlias} as query parameter ${paramName}`);

        try {
            const context = this.getCurrentContext();
            const storedResponse = context.getResponse(responseAlias);

            if (!storedResponse) {
                throw new Error(`No response found with alias '${responseAlias}'`);
            }

            const queryParams = context.getVariable('queryParams') || {};
            queryParams[paramName] = String(storedResponse.status);
            context.setVariable('queryParams', queryParams);

            CSReporter.pass(`Query parameter ${paramName} set to: ${storedResponse.status}`);
        } catch (error) {
            CSReporter.fail(`Failed to use status code: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user clears chain context")
    async clearChainContext(): Promise<void> {
        CSReporter.info('Clearing chain context');
        this.getChainContext().reset();
        CSReporter.pass('Chain context cleared');
    }

    @CSBDDStepDef("user prints chain history")
    async printChainHistory(): Promise<void> {
        CSReporter.info('Chain History:');
        const chainData = this.getChainContext().export();
        CSReporter.info(JSON.stringify(chainData, null, 2));
    }

    // Helper methods
    private async extractJSONPath(response: CSResponse, jsonPath: string): Promise<any> {
        const validation = await this.jsonPathValidator.validate(response, {
            path: jsonPath,
            exists: true
        });

        if (!validation.valid) {
            throw new Error(`JSONPath '${jsonPath}' not found`);
        }

        // Simple JSONPath extraction (for complex paths, use proper JSONPath library)
        const path = jsonPath.replace('$.', '').replace('$', '');
        const parts = path.split('.');
        let value = response.body;

        for (const part of parts) {
            if (value === null || value === undefined) {
                return undefined;
            }

            // Handle array index
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

    private setNestedProperty(obj: any, path: string, value: any): void {
        const keys = path.split('.');
        let current = obj;

        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            if (!current[key] || typeof current[key] !== 'object') {
                current[key] = {};
            }
            current = current[key];
        }

        const lastKey = keys[keys.length - 1];
        if (lastKey) {
            current[lastKey] = value;
        }
    }

    private getNestedProperty(obj: any, path: string): any {
        const keys = path.split('.');
        let current = obj;

        for (const key of keys) {
            if (current && typeof current === 'object' && key in current) {
                current = current[key];
            } else {
                return undefined;
            }
        }

        return current;
    }

    private deepMerge(target: any, source: any): any {
        const result = { ...target };

        for (const key in source) {
            if (source.hasOwnProperty(key)) {
                if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                    if (result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
                        result[key] = this.deepMerge(result[key], source[key]);
                    } else {
                        result[key] = source[key];
                    }
                } else {
                    result[key] = source[key];
                }
            }
        }

        return result;
    }

    private getResponseBodyAsString(response: CSResponse): string {
        if (typeof response.body === 'string') {
            return response.body;
        }

        if (Buffer.isBuffer(response.body)) {
            return response.body.toString('utf-8');
        }

        return JSON.stringify(response.body);
    }

    private extractSimpleXMLValue(xml: string, xpath: string): string {
        // Very simple XML extraction - in production use proper XML parser
        const tagName = xpath.split('/').pop() || '';
        const regex = new RegExp(`<${tagName}>([^<]*)</${tagName}>`, 'i');
        const match = xml.match(regex);
        return match ? match[1] : '';
    }
}