import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSApiContext } from '../../api/context/CSApiContext';
import { CSApiContextManager } from '../../api/context/CSApiContextManager';
import { CSRequestTemplateEngine } from '../../api/templates/CSRequestTemplateEngine';
import { CSReporter } from '../../reporter/CSReporter';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';
import * as fs from 'fs';
import * as path from 'path';

/**
 * BDD Step Definitions for API Request Configuration
 * Provides comprehensive request configuration options
 */
export class CSAPIRequestConfigSteps {
    private contextManager: CSApiContextManager;
    private templateEngine: CSRequestTemplateEngine;
    private configManager: CSConfigurationManager;

    constructor() {
        this.contextManager = CSApiContextManager.getInstance();
        this.templateEngine = new CSRequestTemplateEngine();
        this.configManager = CSConfigurationManager.getInstance();
    }

    private getCurrentContext(): CSApiContext {
        const context = this.contextManager.getCurrentContext();
        if (!context) {
            throw new Error('No API context set. Please use "user is working with" step first');
        }
        return context;
    }

    @CSBDDStepDef("user loads request from {string} file")
    async loadRequestFromFile(filePath: string): Promise<void> {
        CSReporter.info(`Loading request from file: ${filePath}`);

        try {
            const context = this.getCurrentContext();
            const resolvedPath = this.resolveFilePath(filePath);

            if (!fs.existsSync(resolvedPath)) {
                throw new Error(`Request file not found: ${resolvedPath}`);
            }

            const fileContent = fs.readFileSync(resolvedPath, 'utf8');
            const requestConfig = this.parseRequestFile(resolvedPath, fileContent);

            // Process template variables
            const processedConfig = await this.templateEngine.processRequest(requestConfig as any, context);

            this.applyRequestConfig(context, processedConfig);

            CSReporter.pass(`Request loaded from file: ${path.basename(resolvedPath)}`);
        } catch (error) {
            CSReporter.fail(`Failed to load request from file: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets request method to {string}")
    async setRequestMethod(method: string): Promise<void> {
        CSReporter.info(`Setting request method to ${method}`);

        try {
            const context = this.getCurrentContext();
            const upperMethod = method.toUpperCase();

            const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE'];
            if (!validMethods.includes(upperMethod)) {
                throw new Error(`Invalid HTTP method: ${method}. Valid methods are: ${validMethods.join(', ')}`);
            }

            context.setVariable('method', upperMethod);
            CSReporter.pass(`Request method set to ${upperMethod}`);
        } catch (error) {
            CSReporter.fail(`Failed to set request method: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets request path to {string}")
    async setRequestPath(path: string): Promise<void> {
        CSReporter.info(`Setting request path to ${path}`);

        try {
            const context = this.getCurrentContext();
            const interpolatedPath = this.interpolateValue(path, context);

            context.setVariable('requestPath', interpolatedPath);
            CSReporter.pass(`Request path set to: ${interpolatedPath}`);
        } catch (error) {
            CSReporter.fail(`Failed to set request path: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets request timeout to {int} seconds")
    async setRequestTimeout(timeoutSeconds: number): Promise<void> {
        CSReporter.info(`Setting request timeout to ${timeoutSeconds} seconds`);

        try {
            if (timeoutSeconds <= 0) {
                throw new Error('Timeout must be greater than 0 seconds');
            }

            const context = this.getCurrentContext();
            const timeoutMs = timeoutSeconds * 1000;

            context.timeout = timeoutMs;
            context.setVariable('requestTimeout', timeoutMs);

            CSReporter.pass(`Request timeout set to ${timeoutSeconds} seconds`);
        } catch (error) {
            CSReporter.fail(`Failed to set request timeout: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user disables redirect following for request")
    async disableRequestRedirects(): Promise<void> {
        CSReporter.info('Disabling redirect following');

        try {
            const context = this.getCurrentContext();
            context.setVariable('followRedirects', false);
            CSReporter.pass('Redirect following disabled');
        } catch (error) {
            CSReporter.fail(`Failed to disable redirects: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user enables redirect following for request")
    async enableRequestRedirects(): Promise<void> {
        CSReporter.info('Enabling redirect following');

        try {
            const context = this.getCurrentContext();
            context.setVariable('followRedirects', true);
            CSReporter.pass('Redirect following enabled');
        } catch (error) {
            CSReporter.fail(`Failed to enable redirects: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets query parameters:")
    async setQueryParameters(dataTable: any): Promise<void> {
        CSReporter.info('Setting query parameters');

        try {
            const context = this.getCurrentContext();
            const params: Record<string, string> = {};

            const rows = dataTable.raw ? dataTable.raw() : dataTable;

            for (const row of rows) {
                const key = row[0];
                const value = row[1];

                if (!key) {
                    throw new Error('Query parameter key cannot be empty');
                }

                const interpolatedValue = this.interpolateValue(String(value || ''), context);
                params[key] = interpolatedValue;
            }

            const existingParams = context.getVariable('queryParams') || {};
            context.setVariable('queryParams', { ...existingParams, ...params });

            CSReporter.pass(`Set ${Object.keys(params).length} query parameters`);
        } catch (error) {
            CSReporter.fail(`Failed to set query parameters: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets query parameter {string} to {string}")
    async setQueryParam(key: string, value: string): Promise<void> {
        CSReporter.info(`Setting query parameter ${key}`);

        try {
            const context = this.getCurrentContext();
            const interpolatedValue = this.interpolateValue(value, context);

            const existingParams = context.getVariable('queryParams') || {};
            existingParams[key] = interpolatedValue;
            context.setVariable('queryParams', existingParams);

            CSReporter.pass(`Query parameter ${key} set to: ${interpolatedValue}`);
        } catch (error) {
            CSReporter.fail(`Failed to set query parameter: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user removes query parameter {string}")
    async removeQueryParameter(key: string): Promise<void> {
        CSReporter.info(`Removing query parameter ${key}`);

        try {
            const context = this.getCurrentContext();
            const existingParams = context.getVariable('queryParams') || {};
            delete existingParams[key];
            context.setVariable('queryParams', existingParams);

            CSReporter.pass(`Query parameter ${key} removed`);
        } catch (error) {
            CSReporter.fail(`Failed to remove query parameter: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user clears all query parameters")
    async clearQueryParameters(): Promise<void> {
        CSReporter.info('Clearing all query parameters');

        try {
            const context = this.getCurrentContext();
            context.setVariable('queryParams', {});
            CSReporter.pass('All query parameters cleared');
        } catch (error) {
            CSReporter.fail(`Failed to clear query parameters: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user enables HTTP/2 for request")
    async enableHTTP2(): Promise<void> {
        CSReporter.info('Enabling HTTP/2');

        try {
            const context = this.getCurrentContext();
            context.setVariable('http2', true);
            CSReporter.pass('HTTP/2 enabled');
        } catch (error) {
            CSReporter.fail(`Failed to enable HTTP/2: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets request encoding to {string}")
    async setRequestEncoding(encoding: string): Promise<void> {
        CSReporter.info(`Setting request encoding to ${encoding}`);

        try {
            const context = this.getCurrentContext();
            const validEncodings = ['gzip', 'deflate', 'br', 'identity'];

            if (!validEncodings.includes(encoding.toLowerCase())) {
                throw new Error(`Invalid encoding: ${encoding}. Valid encodings are: ${validEncodings.join(', ')}`);
            }

            context.setVariable('encoding', encoding.toLowerCase());
            context.setHeader('Accept-Encoding', encoding.toLowerCase());

            CSReporter.pass(`Request encoding set to ${encoding.toLowerCase()}`);
        } catch (error) {
            CSReporter.fail(`Failed to set request encoding: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets maximum response size to {int} MB")
    async setMaxResponseSize(sizeMB: number): Promise<void> {
        CSReporter.info(`Setting maximum response size to ${sizeMB} MB`);

        try {
            if (sizeMB <= 0) {
                throw new Error('Maximum response size must be greater than 0 MB');
            }

            const context = this.getCurrentContext();
            const sizeBytes = sizeMB * 1024 * 1024;

            context.setVariable('maxResponseSize', sizeBytes);
            CSReporter.pass(`Maximum response size set to ${sizeMB} MB`);
        } catch (error) {
            CSReporter.fail(`Failed to set max response size: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets retry count to {int}")
    async setRetryCount(retryCount: number): Promise<void> {
        CSReporter.info(`Setting retry count to ${retryCount}`);

        try {
            if (retryCount < 0) {
                throw new Error('Retry count cannot be negative');
            }

            const context = this.getCurrentContext();
            context.setVariable('retryCount', retryCount);
            CSReporter.pass(`Retry count set to ${retryCount}`);
        } catch (error) {
            CSReporter.fail(`Failed to set retry count: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets retry delay to {int} milliseconds")
    async setRetryDelay(delayMs: number): Promise<void> {
        CSReporter.info(`Setting retry delay to ${delayMs} ms`);

        try {
            if (delayMs < 0) {
                throw new Error('Retry delay cannot be negative');
            }

            const context = this.getCurrentContext();
            context.setVariable('retryDelay', delayMs);
            CSReporter.pass(`Retry delay set to ${delayMs} ms`);
        } catch (error) {
            CSReporter.fail(`Failed to set retry delay: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user enables SSL certificate validation")
    async enableSSLValidation(): Promise<void> {
        CSReporter.info('Enabling SSL certificate validation');

        try {
            const context = this.getCurrentContext();
            context.setVariable('rejectUnauthorized', true);
            CSReporter.pass('SSL certificate validation enabled');
        } catch (error) {
            CSReporter.fail(`Failed to enable SSL validation: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user disables SSL certificate validation")
    async disableSSLValidation(): Promise<void> {
        CSReporter.info('Disabling SSL certificate validation');

        try {
            const context = this.getCurrentContext();
            context.setVariable('rejectUnauthorized', false);
            CSReporter.warn('SSL certificate validation disabled - use only for testing!');
        } catch (error) {
            CSReporter.fail(`Failed to disable SSL validation: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets proxy to {string}")
    async setProxy(proxyUrl: string): Promise<void> {
        CSReporter.info(`Setting proxy to ${proxyUrl}`);

        try {
            const context = this.getCurrentContext();
            const url = new URL(proxyUrl);

            context.proxy = {
                host: url.hostname,
                port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80)
            };

            if (url.username && url.password) {
                context.proxy.auth = {
                    username: url.username,
                    password: url.password
                };
            }

            CSReporter.pass(`Proxy set to ${url.hostname}:${context.proxy.port}`);
        } catch (error) {
            CSReporter.fail(`Failed to set proxy: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets keep-alive to {string}")
    async setKeepAlive(enabled: string): Promise<void> {
        const isEnabled = enabled.toLowerCase() === 'true';
        CSReporter.info(`Setting keep-alive to ${isEnabled}`);

        try {
            const context = this.getCurrentContext();
            context.setVariable('keepAlive', isEnabled);
            CSReporter.pass(`Keep-alive ${isEnabled ? 'enabled' : 'disabled'}`);
        } catch (error) {
            CSReporter.fail(`Failed to set keep-alive: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sets request to stream mode")
    async setStreamMode(): Promise<void> {
        CSReporter.info('Setting request to stream mode');

        try {
            const context = this.getCurrentContext();
            context.setVariable('responseType', 'stream');
            CSReporter.pass('Stream mode enabled');
        } catch (error) {
            CSReporter.fail(`Failed to set stream mode: ${(error as Error).message}`);
            throw error;
        }
    }

    // Helper methods
    private resolveFilePath(filePath: string): string {
        if (path.isAbsolute(filePath)) {
            return filePath;
        }

        const testDataPath = this.configManager.get('TEST_DATA_PATH') || './test-data';
        const resolvedPath = path.join(testDataPath, 'api', filePath);

        if (fs.existsSync(resolvedPath)) {
            return resolvedPath;
        }

        // Try relative to current directory
        const cwdPath = path.join(process.cwd(), filePath);
        if (fs.existsSync(cwdPath)) {
            return cwdPath;
        }

        return filePath;
    }

    private parseRequestFile(filePath: string, content: string): any {
        const ext = path.extname(filePath).toLowerCase();

        switch (ext) {
            case '.json':
                return JSON.parse(content);

            case '.yaml':
            case '.yml':
                // If yaml support is needed, add js-yaml library
                try {
                    const yaml = require('js-yaml');
                    return yaml.load(content);
                } catch {
                    throw new Error('YAML support not available. Please install js-yaml package');
                }

            default:
                // Try to parse as JSON
                try {
                    return JSON.parse(content);
                } catch (error) {
                    throw new Error(`Unable to parse request file. Supported formats: JSON, YAML`);
                }
        }
    }

    private applyRequestConfig(context: CSApiContext, config: any): void {
        if (config.method) {
            context.setVariable('method', config.method.toUpperCase());
        }

        if (config.url) {
            try {
                const url = new URL(config.url);
                context.baseUrl = `${url.protocol}//${url.host}`;
                context.setVariable('requestPath', url.pathname);

                // Extract query parameters
                const queryParams: Record<string, string> = {};
                url.searchParams.forEach((value, key) => {
                    queryParams[key] = value;
                });

                if (Object.keys(queryParams).length > 0) {
                    context.setVariable('queryParams', queryParams);
                }
            } catch {
                // If not a valid URL, treat as path
                context.setVariable('requestPath', config.url);
            }
        } else if (config.path) {
            context.setVariable('requestPath', config.path);
        }

        if (config.headers) {
            Object.entries(config.headers).forEach(([key, value]) => {
                context.setHeader(key, String(value));
            });
        }

        if (config.queryParameters || config.params) {
            const params = config.queryParameters || config.params;
            const queryParams: Record<string, string> = {};
            Object.entries(params).forEach(([key, value]) => {
                queryParams[key] = String(value);
            });
            context.setVariable('queryParams', queryParams);
        }

        if (config.body) {
            context.setVariable('requestBody', config.body);
        }

        if (config.timeout) {
            context.timeout = config.timeout;
        }

        if (config.auth) {
            context.auth = config.auth;
        }
    }

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
}