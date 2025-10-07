import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSApiContext } from '../../api/context/CSApiContext';
import { CSApiContextManager } from '../../api/context/CSApiContextManager';
import { CSReporter } from '../../reporter/CSReporter';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';
import * as fs from 'fs';
import * as path from 'path';

/**
 * BDD Step Definitions for API Request Header Management
 * Provides comprehensive header manipulation and management
 */
export class CSAPIRequestHeaderSteps {
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

    @CSBDDStepDef("user sets request header {string} to {string}")
    async setRequestHeaderValue(headerName: string, headerValue: string): Promise<void> {
        CSReporter.info(`Setting header ${headerName} to ${headerValue}`);

        try {
            const context = this.getCurrentContext();
            const interpolatedValue = this.interpolateValue(headerValue, context);

            context.setHeader(headerName, interpolatedValue);
            CSReporter.pass(`Header ${headerName} set to: ${interpolatedValue}`);
        } catch (error) {
            CSReporter.fail(`Failed to set header: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets request headers:")
    async setRequestHeadersFromTable(dataTable: any): Promise<void> {
        CSReporter.info('Setting multiple request headers');

        try {
            const context = this.getCurrentContext();
            const rows = dataTable.raw ? dataTable.raw() : dataTable;
            let headerCount = 0;

            for (const row of rows) {
                const headerName = row[0];
                const headerValue = row[1];

                if (!headerName) {
                    CSReporter.warn('Skipping empty header name');
                    continue;
                }

                const interpolatedValue = this.interpolateValue(String(headerValue || ''), context);
                context.setHeader(headerName, interpolatedValue);
                headerCount++;
            }

            CSReporter.pass(`Set ${headerCount} request headers`);
        } catch (error) {
            CSReporter.fail(`Failed to set headers: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user removes request header {string}")
    async removeRequestHeader(headerName: string): Promise<void> {
        CSReporter.info(`Removing header ${headerName}`);

        try {
            const context = this.getCurrentContext();
            context.removeHeader(headerName);
            CSReporter.pass(`Header ${headerName} removed`);
        } catch (error) {
            CSReporter.fail(`Failed to remove header: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user clears all request headers")
    async clearRequestHeaders(): Promise<void> {
        CSReporter.info('Clearing all request headers');

        try {
            const context = this.getCurrentContext();
            context.clearHeaders();
            CSReporter.pass('All request headers cleared');
        } catch (error) {
            CSReporter.fail(`Failed to clear headers: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets Authorization header with Bearer token {string}")
    async setAuthorizationBearer(token: string): Promise<void> {
        CSReporter.info('Setting Authorization header with Bearer token');

        try {
            const context = this.getCurrentContext();
            const interpolatedToken = this.interpolateValue(token, context);

            context.setHeader('Authorization', `Bearer ${interpolatedToken}`);
            CSReporter.pass('Authorization header set with Bearer token');
        } catch (error) {
            CSReporter.fail(`Failed to set Authorization header: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets Authorization header with Basic auth {string} {string}")
    async setAuthorizationBasic(username: string, password: string): Promise<void> {
        CSReporter.info('Setting Authorization header with Basic auth');

        try {
            const context = this.getCurrentContext();
            const interpolatedUsername = this.interpolateValue(username, context);
            const interpolatedPassword = this.interpolateValue(password, context);

            const credentials = Buffer.from(`${interpolatedUsername}:${interpolatedPassword}`).toString('base64');
            context.setHeader('Authorization', `Basic ${credentials}`);

            CSReporter.pass('Authorization header set with Basic auth');
        } catch (error) {
            CSReporter.fail(`Failed to set Authorization header: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets Content-Type to {string}")
    async setContentType(contentType: string): Promise<void> {
        CSReporter.info(`Setting Content-Type to ${contentType}`);

        try {
            const context = this.getCurrentContext();
            context.setHeader('Content-Type', contentType);
            CSReporter.pass(`Content-Type set to: ${contentType}`);
        } catch (error) {
            CSReporter.fail(`Failed to set Content-Type: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets Accept header to {string}")
    async setAcceptHeader(acceptType: string): Promise<void> {
        CSReporter.info(`Setting Accept header to ${acceptType}`);

        try {
            const context = this.getCurrentContext();
            context.setHeader('Accept', acceptType);
            CSReporter.pass(`Accept header set to: ${acceptType}`);
        } catch (error) {
            CSReporter.fail(`Failed to set Accept header: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets User-Agent to {string}")
    async setUserAgent(userAgent: string): Promise<void> {
        CSReporter.info(`Setting User-Agent to ${userAgent}`);

        try {
            const context = this.getCurrentContext();
            context.setHeader('User-Agent', userAgent);
            CSReporter.pass(`User-Agent set to: ${userAgent}`);
        } catch (error) {
            CSReporter.fail(`Failed to set User-Agent: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user loads headers from {string} file")
    async loadHeadersFromFile(filePath: string): Promise<void> {
        CSReporter.info(`Loading headers from file: ${filePath}`);

        try {
            const context = this.getCurrentContext();
            const resolvedPath = this.resolveFilePath(filePath);

            if (!fs.existsSync(resolvedPath)) {
                throw new Error(`Headers file not found: ${resolvedPath}`);
            }

            const fileContent = fs.readFileSync(resolvedPath, 'utf8');
            const headers = this.parseHeadersFile(fileContent);

            for (const [headerName, headerValue] of Object.entries(headers)) {
                const interpolatedValue = this.interpolateValue(String(headerValue), context);
                context.setHeader(headerName, interpolatedValue);
            }

            CSReporter.pass(`Loaded ${Object.keys(headers).length} headers from file`);
        } catch (error) {
            CSReporter.fail(`Failed to load headers from file: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets header {string} from environment variable {string}")
    async setHeaderFromEnvironment(headerName: string, envVar: string): Promise<void> {
        CSReporter.info(`Setting header ${headerName} from environment variable ${envVar}`);

        try {
            const context = this.getCurrentContext();
            const envValue = process.env[envVar];

            if (!envValue) {
                throw new Error(`Environment variable ${envVar} not found`);
            }

            context.setHeader(headerName, envValue);
            CSReporter.pass(`Header ${headerName} set from environment variable`);
        } catch (error) {
            CSReporter.fail(`Failed to set header from environment: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets header {string} from config {string}")
    async setHeaderFromConfig(headerName: string, configKey: string): Promise<void> {
        CSReporter.info(`Setting header ${headerName} from config ${configKey}`);

        try {
            const context = this.getCurrentContext();
            const configValue = this.configManager.get(configKey);

            if (!configValue) {
                throw new Error(`Config key ${configKey} not found`);
            }

            context.setHeader(headerName, String(configValue));
            CSReporter.pass(`Header ${headerName} set from config`);
        } catch (error) {
            CSReporter.fail(`Failed to set header from config: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets header {string} with timestamp")
    async setHeaderWithTimestamp(headerName: string): Promise<void> {
        CSReporter.info(`Setting header ${headerName} with timestamp`);

        try {
            const context = this.getCurrentContext();
            const timestamp = new Date().toISOString();

            context.setHeader(headerName, timestamp);
            CSReporter.pass(`Header ${headerName} set with timestamp: ${timestamp}`);
        } catch (error) {
            CSReporter.fail(`Failed to set header with timestamp: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets header {string} with UUID")
    async setHeaderWithUUID(headerName: string): Promise<void> {
        CSReporter.info(`Setting header ${headerName} with UUID`);

        try {
            const context = this.getCurrentContext();
            const uuid = this.generateUUID();

            context.setHeader(headerName, uuid);
            CSReporter.pass(`Header ${headerName} set with UUID: ${uuid}`);
        } catch (error) {
            CSReporter.fail(`Failed to set header with UUID: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets header {string} with random number between {int} and {int}")
    async setHeaderWithRandomNumber(headerName: string, min: number, max: number): Promise<void> {
        CSReporter.info(`Setting header ${headerName} with random number between ${min} and ${max}`);

        try {
            const context = this.getCurrentContext();
            const randomNumber = Math.floor(Math.random() * (max - min + 1)) + min;

            context.setHeader(headerName, String(randomNumber));
            CSReporter.pass(`Header ${headerName} set with random number: ${randomNumber}`);
        } catch (error) {
            CSReporter.fail(`Failed to set header with random number: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets CORS headers for origin {string}")
    async setCORSHeaders(origin: string): Promise<void> {
        CSReporter.info(`Setting CORS headers for origin ${origin}`);

        try {
            const context = this.getCurrentContext();

            context.setHeader('Origin', origin);
            context.setHeader('Access-Control-Request-Method', 'GET,POST,PUT,DELETE');
            context.setHeader('Access-Control-Request-Headers', 'Content-Type,Authorization');

            CSReporter.pass(`CORS headers set for origin: ${origin}`);
        } catch (error) {
            CSReporter.fail(`Failed to set CORS headers: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets cache control header to {string}")
    async setCacheControlHeader(cacheControl: string): Promise<void> {
        CSReporter.info(`Setting Cache-Control header to ${cacheControl}`);

        try {
            const context = this.getCurrentContext();
            context.setHeader('Cache-Control', cacheControl);
            CSReporter.pass(`Cache-Control header set to: ${cacheControl}`);
        } catch (error) {
            CSReporter.fail(`Failed to set Cache-Control header: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets custom header {string} with base64 encoded value {string}")
    async setBase64EncodedHeader(headerName: string, value: string): Promise<void> {
        CSReporter.info(`Setting header ${headerName} with base64 encoded value`);

        try {
            const context = this.getCurrentContext();
            const interpolatedValue = this.interpolateValue(value, context);
            const encodedValue = Buffer.from(interpolatedValue).toString('base64');

            context.setHeader(headerName, encodedValue);
            CSReporter.pass(`Header ${headerName} set with base64 encoded value`);
        } catch (error) {
            CSReporter.fail(`Failed to set base64 encoded header: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets header {string} with MD5 hash of {string}")
    async setHeaderWithMD5(headerName: string, value: string): Promise<void> {
        CSReporter.info(`Setting header ${headerName} with MD5 hash`);

        try {
            const context = this.getCurrentContext();
            const crypto = require('crypto');
            const interpolatedValue = this.interpolateValue(value, context);
            const md5Hash = crypto.createHash('md5').update(interpolatedValue).digest('hex');

            context.setHeader(headerName, md5Hash);
            CSReporter.pass(`Header ${headerName} set with MD5 hash: ${md5Hash}`);
        } catch (error) {
            CSReporter.fail(`Failed to set header with MD5: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets header {string} with SHA256 hash of {string}")
    async setHeaderWithSHA256(headerName: string, value: string): Promise<void> {
        CSReporter.info(`Setting header ${headerName} with SHA256 hash`);

        try {
            const context = this.getCurrentContext();
            const crypto = require('crypto');
            const interpolatedValue = this.interpolateValue(value, context);
            const sha256Hash = crypto.createHash('sha256').update(interpolatedValue).digest('hex');

            context.setHeader(headerName, sha256Hash);
            CSReporter.pass(`Header ${headerName} set with SHA256 hash: ${sha256Hash}`);
        } catch (error) {
            CSReporter.fail(`Failed to set header with SHA256: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user copies header {string} to {string}")
    async copyHeader(sourceHeader: string, targetHeader: string): Promise<void> {
        CSReporter.info(`Copying header ${sourceHeader} to ${targetHeader}`);

        try {
            const context = this.getCurrentContext();
            const sourceValue = context.headers[sourceHeader];

            if (!sourceValue) {
                throw new Error(`Source header ${sourceHeader} not found`);
            }

            context.setHeader(targetHeader, String(sourceValue));
            CSReporter.pass(`Header ${sourceHeader} copied to ${targetHeader}`);
        } catch (error) {
            CSReporter.fail(`Failed to copy header: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user appends {string} to header {string}")
    async appendToHeader(value: string, headerName: string): Promise<void> {
        CSReporter.info(`Appending to header ${headerName}`);

        try {
            const context = this.getCurrentContext();
            const currentValue = context.headers[headerName] || '';
            const interpolatedValue = this.interpolateValue(value, context);

            context.setHeader(headerName, String(currentValue) + interpolatedValue);
            CSReporter.pass(`Appended to header ${headerName}`);
        } catch (error) {
            CSReporter.fail(`Failed to append to header: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets conditional header {string} to {string} if {string} equals {string}")
    async setConditionalHeader(headerName: string, headerValue: string, varName: string, expectedValue: string): Promise<void> {
        CSReporter.info(`Setting conditional header ${headerName}`);

        try {
            const context = this.getCurrentContext();
            const actualValue = context.getVariable(varName);

            if (String(actualValue) === expectedValue) {
                const interpolatedValue = this.interpolateValue(headerValue, context);
                context.setHeader(headerName, interpolatedValue);
                CSReporter.pass(`Conditional header ${headerName} set`);
            } else {
                CSReporter.info(`Condition not met, header ${headerName} not set`);
            }
        } catch (error) {
            CSReporter.fail(`Failed to set conditional header: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user prints current request headers")
    async printRequestHeaders(): Promise<void> {
        try {
            const context = this.getCurrentContext();
            CSReporter.info('Current request headers:');

            for (const [key, value] of Object.entries(context.headers)) {
                CSReporter.info(`  ${key}: ${value}`);
            }
        } catch (error) {
            CSReporter.fail(`Failed to print headers: ${(error as Error).message}`);
            throw error;
        }
    }

    // Helper methods
    private interpolateValue(value: string, context: CSApiContext): string {
        if (!value.includes('{{')) {
            return value;
        }

        let interpolated = value;
        interpolated = interpolated.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
            const varValue = context.getVariable(varName);
            return varValue !== undefined ? String(varValue) : match;
        });

        return interpolated;
    }

    private resolveFilePath(filePath: string): string {
        if (path.isAbsolute(filePath)) {
            return filePath;
        }

        const testDataPath = this.configManager.get('TEST_DATA_PATH') || './test-data';
        const resolvedPath = path.join(testDataPath, 'api', filePath);

        if (fs.existsSync(resolvedPath)) {
            return resolvedPath;
        }

        const cwdPath = path.join(process.cwd(), filePath);
        if (fs.existsSync(cwdPath)) {
            return cwdPath;
        }

        return filePath;
    }

    private parseHeadersFile(content: string): Record<string, string> {
        const headers: Record<string, string> = {};

        try {
            // Try to parse as JSON first
            const jsonHeaders = JSON.parse(content);
            if (typeof jsonHeaders === 'object' && !Array.isArray(jsonHeaders)) {
                return jsonHeaders;
            }
        } catch {
            // If not JSON, parse as key:value pairs
            const lines = content.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed && trimmed.includes(':')) {
                    const [key, ...valueParts] = trimmed.split(':');
                    headers[key.trim()] = valueParts.join(':').trim();
                }
            }
        }

        return headers;
    }

    private generateUUID(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
}