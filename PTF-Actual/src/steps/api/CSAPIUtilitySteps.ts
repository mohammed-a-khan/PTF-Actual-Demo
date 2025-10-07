import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSApiContext } from '../../api/context/CSApiContext';
import { CSApiContextManager } from '../../api/context/CSApiContextManager';
import { CSReporter } from '../../reporter/CSReporter';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';
import { CSResponse } from '../../api/types/CSApiTypes';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * BDD Step Definitions for API Utility Operations
 * Provides helper functions for data manipulation, logging, and debugging
 */
export class CSAPIUtilitySteps {
    private contextManager: CSApiContextManager;
    private configManager: CSConfigurationManager;

    constructor() {
        this.contextManager = CSApiContextManager.getInstance();
        this.configManager = CSConfigurationManager.getInstance();
    }

    private getCurrentContext(): CSApiContext {
        const context = this.contextManager.getCurrentContext();
        if (!context) {
            throw new Error('No API context set. Please use "user is working with" step first');
        }
        return context;
    }

    // Removed - duplicate with CSCommonSteps
    // Use the step from CSCommonSteps instead

    @CSBDDStepDef("user saves response JSON path {string} as {string}")
    async saveJSONPathAsVariable(jsonPath: string, variableName: string): Promise<void> {
        CSReporter.info(`Saving JSON path ${jsonPath} as variable ${variableName}`);

        try {
            const context = this.getCurrentContext();
            const response = context.getLastResponse();

            if (!response) {
                throw new Error('No response available');
            }

            const value = this.extractJSONPath(response, jsonPath);
            context.setVariable(variableName, value);

            CSReporter.pass(`Variable ${variableName} saved from JSON path: ${JSON.stringify(value)}`);
        } catch (error) {
            CSReporter.fail(`Failed to save JSON path: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user saves response header {string} as {string}")
    async saveHeaderAsVariable(headerName: string, variableName: string): Promise<void> {
        CSReporter.info(`Saving header ${headerName} as variable ${variableName}`);

        try {
            const context = this.getCurrentContext();
            const response = context.getLastResponse();

            if (!response) {
                throw new Error('No response available');
            }

            const headerValue = this.findHeader(response.headers, headerName);
            if (!headerValue) {
                throw new Error(`Header '${headerName}' not found in response`);
            }

            context.setVariable(variableName, headerValue);
            CSReporter.pass(`Variable ${variableName} saved with header value: ${headerValue}`);
        } catch (error) {
            CSReporter.fail(`Failed to save header: ${(error as Error).message}`);
            throw error;
        }
    }

    // Removed - duplicate with CSCommonSteps
    // generateAndSaveUUID - Use the step from CSCommonSteps instead

    // Removed - duplicate with CSCommonSteps
    // generateAndSaveTimestamp - Use the step from CSCommonSteps instead

    // Removed - duplicate with CSCommonSteps
    // generateRandomNumberAndSave - Use the step from CSCommonSteps instead

    // Removed - duplicate with CSCommonSteps
    // generateRandomStringAndSave - Use the step from CSCommonSteps instead

    @CSBDDStepDef("user prints variable {string}")
    async printVariable(variableName: string): Promise<void> {
        try {
            const context = this.getCurrentContext();
            const value = context.getVariable(variableName);

            CSReporter.info(`Variable ${variableName}: ${JSON.stringify(value, null, 2)}`);
        } catch (error) {
            CSReporter.fail(`Failed to print variable: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user prints response body")
    async printResponseBody(): Promise<void> {
        try {
            const context = this.getCurrentContext();
            const response = context.getLastResponse();

            if (!response) {
                CSReporter.warn('No response available to print');
                return;
            }

            CSReporter.info('Response body:');
            CSReporter.info(JSON.stringify(response.body, null, 2));
        } catch (error) {
            CSReporter.fail(`Failed to print response body: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user prints response headers")
    async printResponseHeaders(): Promise<void> {
        try {
            const context = this.getCurrentContext();
            const response = context.getLastResponse();

            if (!response) {
                CSReporter.warn('No response available to print');
                return;
            }

            CSReporter.info('Response headers:');
            for (const [key, value] of Object.entries(response.headers)) {
                CSReporter.info(`  ${key}: ${value}`);
            }
        } catch (error) {
            CSReporter.fail(`Failed to print response headers: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user saves response to file {string}")
    async saveResponseToFile(filePath: string): Promise<void> {
        CSReporter.info(`Saving response to file: ${filePath}`);

        try {
            const context = this.getCurrentContext();
            const response = context.getLastResponse();

            if (!response) {
                throw new Error('No response available to save');
            }

            const resolvedPath = this.resolveFilePath(filePath);
            const dir = path.dirname(resolvedPath);

            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const responseData = {
                status: response.status,
                headers: response.headers,
                body: response.body,
                duration: response.duration,
                timestamp: new Date().toISOString()
            };

            fs.writeFileSync(resolvedPath, JSON.stringify(responseData, null, 2));
            CSReporter.pass(`Response saved to: ${resolvedPath}`);
        } catch (error) {
            CSReporter.fail(`Failed to save response: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user loads variables from file {string}")
    async loadVariablesFromFile(filePath: string): Promise<void> {
        CSReporter.info(`Loading variables from file: ${filePath}`);

        try {
            const context = this.getCurrentContext();
            const resolvedPath = this.resolveFilePath(filePath);

            if (!fs.existsSync(resolvedPath)) {
                throw new Error(`Variables file not found: ${resolvedPath}`);
            }

            const fileContent = fs.readFileSync(resolvedPath, 'utf8');
            const variables = JSON.parse(fileContent);

            if (typeof variables !== 'object' || Array.isArray(variables)) {
                throw new Error('Variables file must contain a JSON object');
            }

            for (const [key, value] of Object.entries(variables)) {
                context.setVariable(key, value);
            }

            CSReporter.pass(`Loaded ${Object.keys(variables).length} variables from file`);
        } catch (error) {
            CSReporter.fail(`Failed to load variables: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user saves variables to file {string}")
    async saveVariablesToFile(filePath: string): Promise<void> {
        CSReporter.info(`Saving variables to file: ${filePath}`);

        try {
            const context = this.getCurrentContext();
            const resolvedPath = this.resolveFilePath(filePath);
            const dir = path.dirname(resolvedPath);

            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const variables = context.variables;
            fs.writeFileSync(resolvedPath, JSON.stringify(variables, null, 2));

            CSReporter.pass(`Saved ${Object.keys(variables).length} variables to: ${resolvedPath}`);
        } catch (error) {
            CSReporter.fail(`Failed to save variables: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user transforms {string} to uppercase and saves as {string}")
    async transformToUppercase(value: string, variableName: string): Promise<void> {
        CSReporter.info(`Transforming to uppercase and saving as ${variableName}`);

        try {
            const context = this.getCurrentContext();
            const interpolatedValue = this.interpolateValue(value, context);
            const transformed = interpolatedValue.toUpperCase();

            context.setVariable(variableName, transformed);
            CSReporter.pass(`Uppercase value saved as ${variableName}: ${transformed}`);
        } catch (error) {
            CSReporter.fail(`Failed to transform to uppercase: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user transforms {string} to lowercase and saves as {string}")
    async transformToLowercase(value: string, variableName: string): Promise<void> {
        CSReporter.info(`Transforming to lowercase and saving as ${variableName}`);

        try {
            const context = this.getCurrentContext();
            const interpolatedValue = this.interpolateValue(value, context);
            const transformed = interpolatedValue.toLowerCase();

            context.setVariable(variableName, transformed);
            CSReporter.pass(`Lowercase value saved as ${variableName}: ${transformed}`);
        } catch (error) {
            CSReporter.fail(`Failed to transform to lowercase: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user base64 encodes {string} and saves as {string}")
    async base64Encode(value: string, variableName: string): Promise<void> {
        CSReporter.info(`Base64 encoding and saving as ${variableName}`);

        try {
            const context = this.getCurrentContext();
            const interpolatedValue = this.interpolateValue(value, context);
            const encoded = Buffer.from(interpolatedValue).toString('base64');

            context.setVariable(variableName, encoded);
            CSReporter.pass(`Base64 encoded value saved as ${variableName}: ${encoded}`);
        } catch (error) {
            CSReporter.fail(`Failed to base64 encode: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user base64 decodes {string} and saves as {string}")
    async base64Decode(value: string, variableName: string): Promise<void> {
        CSReporter.info(`Base64 decoding and saving as ${variableName}`);

        try {
            const context = this.getCurrentContext();
            const interpolatedValue = this.interpolateValue(value, context);
            const decoded = Buffer.from(interpolatedValue, 'base64').toString('utf-8');

            context.setVariable(variableName, decoded);
            CSReporter.pass(`Base64 decoded value saved as ${variableName}: ${decoded}`);
        } catch (error) {
            CSReporter.fail(`Failed to base64 decode: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user URL encodes {string} and saves as {string}")
    async urlEncode(value: string, variableName: string): Promise<void> {
        CSReporter.info(`URL encoding and saving as ${variableName}`);

        try {
            const context = this.getCurrentContext();
            const interpolatedValue = this.interpolateValue(value, context);
            const encoded = encodeURIComponent(interpolatedValue);

            context.setVariable(variableName, encoded);
            CSReporter.pass(`URL encoded value saved as ${variableName}: ${encoded}`);
        } catch (error) {
            CSReporter.fail(`Failed to URL encode: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user URL decodes {string} and saves as {string}")
    async urlDecode(value: string, variableName: string): Promise<void> {
        CSReporter.info(`URL decoding and saving as ${variableName}`);

        try {
            const context = this.getCurrentContext();
            const interpolatedValue = this.interpolateValue(value, context);
            const decoded = decodeURIComponent(interpolatedValue);

            context.setVariable(variableName, decoded);
            CSReporter.pass(`URL decoded value saved as ${variableName}: ${decoded}`);
        } catch (error) {
            CSReporter.fail(`Failed to URL decode: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user calculates MD5 hash of {string} and saves as {string}")
    async calculateMD5(value: string, variableName: string): Promise<void> {
        CSReporter.info(`Calculating MD5 hash and saving as ${variableName}`);

        try {
            const context = this.getCurrentContext();
            const interpolatedValue = this.interpolateValue(value, context);
            const hash = crypto.createHash('md5').update(interpolatedValue).digest('hex');

            context.setVariable(variableName, hash);
            CSReporter.pass(`MD5 hash saved as ${variableName}: ${hash}`);
        } catch (error) {
            CSReporter.fail(`Failed to calculate MD5: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user calculates SHA256 hash of {string} and saves as {string}")
    async calculateSHA256(value: string, variableName: string): Promise<void> {
        CSReporter.info(`Calculating SHA256 hash and saving as ${variableName}`);

        try {
            const context = this.getCurrentContext();
            const interpolatedValue = this.interpolateValue(value, context);
            const hash = crypto.createHash('sha256').update(interpolatedValue).digest('hex');

            context.setVariable(variableName, hash);
            CSReporter.pass(`SHA256 hash saved as ${variableName}: ${hash}`);
        } catch (error) {
            CSReporter.fail(`Failed to calculate SHA256: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user waits for {int} seconds")
    async waitForDuration(seconds: number): Promise<void> {
        CSReporter.info(`Waiting for ${seconds} seconds`);

        try {
            await new Promise(resolve => setTimeout(resolve, seconds * 1000));
            CSReporter.pass(`Waited for ${seconds} seconds`);
        } catch (error) {
            CSReporter.fail(`Failed to wait: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user clears variable {string}")
    async clearVariable(variableName: string): Promise<void> {
        CSReporter.info(`Clearing variable ${variableName}`);

        try {
            const context = this.getCurrentContext();
            context.removeVariable(variableName);
            CSReporter.pass(`Variable ${variableName} cleared`);
        } catch (error) {
            CSReporter.fail(`Failed to clear variable: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user clears all variables")
    async clearAllVariables(): Promise<void> {
        CSReporter.info('Clearing all variables');

        try {
            const context = this.getCurrentContext();
            context.clearVariables();
            CSReporter.pass('All variables cleared');
        } catch (error) {
            CSReporter.fail(`Failed to clear variables: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user exports context to file {string}")
    async exportContextToFile(filePath: string): Promise<void> {
        CSReporter.info(`Exporting context to file: ${filePath}`);

        try {
            const context = this.getCurrentContext();
            const resolvedPath = this.resolveFilePath(filePath);
            const dir = path.dirname(resolvedPath);

            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const exportData = context.export();
            fs.writeFileSync(resolvedPath, JSON.stringify(exportData, null, 2));

            CSReporter.pass(`Context exported to: ${resolvedPath}`);
        } catch (error) {
            CSReporter.fail(`Failed to export context: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user imports context from file {string}")
    async importContextFromFile(filePath: string): Promise<void> {
        CSReporter.info(`Importing context from file: ${filePath}`);

        try {
            const context = this.getCurrentContext();
            const resolvedPath = this.resolveFilePath(filePath);

            if (!fs.existsSync(resolvedPath)) {
                throw new Error(`Context file not found: ${resolvedPath}`);
            }

            const fileContent = fs.readFileSync(resolvedPath, 'utf8');
            const importData = JSON.parse(fileContent);

            context.import(importData);
            CSReporter.pass(`Context imported from: ${resolvedPath}`);
        } catch (error) {
            CSReporter.fail(`Failed to import context: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user compares {string} with {string} and saves result as {string}")
    async compareAndSave(value1: string, value2: string, variableName: string): Promise<void> {
        CSReporter.info(`Comparing ${value1} with ${value2}`);

        try {
            const context = this.getCurrentContext();
            const interpolatedValue1 = this.interpolateValue(value1, context);
            const interpolatedValue2 = this.interpolateValue(value2, context);
            const isEqual = interpolatedValue1 === interpolatedValue2;

            context.setVariable(variableName, isEqual);
            CSReporter.pass(`Comparison result saved as ${variableName}: ${isEqual}`);
        } catch (error) {
            CSReporter.fail(`Failed to compare values: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user concatenates {string} and {string} and saves as {string}")
    async concatenateAndSave(value1: string, value2: string, variableName: string): Promise<void> {
        CSReporter.info(`Concatenating ${value1} and ${value2}`);

        try {
            const context = this.getCurrentContext();
            const interpolatedValue1 = this.interpolateValue(value1, context);
            const interpolatedValue2 = this.interpolateValue(value2, context);
            const concatenated = interpolatedValue1 + interpolatedValue2;

            context.setVariable(variableName, concatenated);
            CSReporter.pass(`Concatenated value saved as ${variableName}: ${concatenated}`);
        } catch (error) {
            CSReporter.fail(`Failed to concatenate: ${(error as Error).message}`);
            throw error;
        }
    }

    // Helper methods
    private interpolateValue(value: string, context: CSApiContext): string {
        if (!value.includes('{{')) {
            return value;
        }

        return value.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
            const varValue = context.getVariable(varName);
            return varValue !== undefined ? String(varValue) : match;
        });
    }

    private extractJSONPath(response: CSResponse, jsonPath: string): any {
        const path = jsonPath.replace('$.', '').replace('$', '');
        const parts = path.split('.');
        let value = response.body;

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

    private resolveFilePath(filePath: string): string {
        if (path.isAbsolute(filePath)) {
            return filePath;
        }

        const outputPath = this.configManager.get('OUTPUT_PATH') || './output';
        return path.join(outputPath, 'api', filePath);
    }

    private generateUUID(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
}