import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSApiContext } from '../../api/context/CSApiContext';
import { CSApiContextManager } from '../../api/context/CSApiContextManager';
import { CSAPIClient } from '../../api/CSAPIClient';
import { CSRequestBuilder } from '../../api/client/CSRequestBuilder';
import { CSRequestTemplateEngine } from '../../api/templates/CSRequestTemplateEngine';
import { CSRetryHandler } from '../../api/client/CSRetryHandler';
import { CSReporter } from '../../reporter/CSReporter';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';
import { CSRequestOptions, CSResponse } from '../../api/types/CSApiTypes';
import * as fs from 'fs';
import * as path from 'path';

/**
 * BDD Step Definitions for API Request Execution
 * Provides comprehensive request execution, retries, and batch operations
 */
export class CSAPIRequestExecutionSteps {
    private contextManager: CSApiContextManager;
    private apiClient: CSAPIClient;
    private templateEngine: CSRequestTemplateEngine;
    private configManager: CSConfigurationManager;
    private retryHandler: CSRetryHandler;

    constructor() {
        this.contextManager = CSApiContextManager.getInstance();
        this.apiClient = new CSAPIClient();
        this.templateEngine = new CSRequestTemplateEngine();
        this.configManager = CSConfigurationManager.getInstance();
        this.retryHandler = new CSRetryHandler();
    }

    private getCurrentContext(): CSApiContext {
        const context = this.contextManager.getCurrentContext();
        if (!context) {
            throw new Error('No API context set. Please use "user is working with" step first');
        }
        return context;
    }

    @CSBDDStepDef("user sends {string} request to {string}")
    async sendRequest(method: string, endpoint: string): Promise<void> {
        CSReporter.info(`Sending ${method} request to ${endpoint}`);

        try {
            const context = this.getCurrentContext();
            const url = this.buildUrl(endpoint, context);
            const options = this.buildRequestOptions(method, context);

            const response = await this.apiClient.request({ ...options, url, method: method.toUpperCase() as any });

            context.setLastResponse(response);
            context.saveResponse('last', response);

            CSReporter.pass(`${method} request successful: ${response.status}`);
        } catch (error) {
            CSReporter.fail(`${method} request failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sends {string} request to {string} and saves response as {string}")
    async sendRequestAndSave(method: string, endpoint: string, alias: string): Promise<void> {
        CSReporter.info(`Sending ${method} request to ${endpoint} and saving as ${alias}`);

        try {
            const context = this.getCurrentContext();
            const url = this.buildUrl(endpoint, context);
            const options = this.buildRequestOptions(method, context);

            const response = await this.apiClient.request({ ...options, url, method: method.toUpperCase() as any });

            context.setLastResponse(response);
            context.saveResponse(alias, response);

            CSReporter.pass(`${method} request successful, saved as ${alias}: ${response.status}`);
        } catch (error) {
            CSReporter.fail(`${method} request failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user executes request with retry count {int}")
    async executeRequestWithRetry(retryCount: number): Promise<void> {
        CSReporter.info(`Executing request with ${retryCount} retries`);

        try {
            const context = this.getCurrentContext();
            const method = context.getVariable('method') || 'GET';
            const endpoint = context.getVariable('requestPath') || '/';
            const url = this.buildUrl(endpoint, context);
            const options = this.buildRequestOptions(method, context);

            const response = await this.retryHandler.executeWithRetry(
                async () => await this.apiClient.request({ ...options, url, method: method.toUpperCase() as any }),
                {
                    maxRetries: retryCount,
                    retryDelay: context.getVariable('retryDelay') || 1000,
                    shouldRetry: (error) => {
                        const status = (error as any).response?.status;
                        return !status || status >= 500 || status === 429;
                    }
                }
            );

            context.setLastResponse(response);
            context.saveResponse('last', response);

            CSReporter.pass(`Request successful after retries: ${response.status}`);
        } catch (error) {
            CSReporter.fail(`Request failed after ${retryCount} retries: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user executes parallel requests:")
    async executeParallelRequests(dataTable: any): Promise<void> {
        CSReporter.info('Executing parallel requests');

        try {
            const context = this.getCurrentContext();
            const rows = dataTable.raw ? dataTable.raw() : dataTable;
            const promises: Promise<CSResponse>[] = [];
            const aliases: string[] = [];

            for (const row of rows) {
                const method = row[0];
                const endpoint = row[1];
                const alias = row[2] || `request_${promises.length}`;

                const url = this.buildUrl(endpoint, context);
                const options = this.buildRequestOptions(method, context);

                promises.push(
                    this.apiClient.request({ ...options, url, method: method.toUpperCase() as any })
                );
                aliases.push(alias);
            }

            const responses = await Promise.all(promises);

            for (let i = 0; i < responses.length; i++) {
                context.saveResponse(aliases[i], responses[i]);
            }

            context.setLastResponse(responses[responses.length - 1]);

            CSReporter.pass(`Executed ${responses.length} parallel requests successfully`);
        } catch (error) {
            CSReporter.fail(`Parallel requests failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user executes sequential requests with delay {int} ms:")
    async executeSequentialRequestsWithDelay(delayMs: number, dataTable: any): Promise<void> {
        CSReporter.info(`Executing sequential requests with ${delayMs}ms delay`);

        try {
            const context = this.getCurrentContext();
            const rows = dataTable.raw ? dataTable.raw() : dataTable;
            let successCount = 0;

            for (const row of rows) {
                const method = row[0];
                const endpoint = row[1];
                const alias = row[2] || `request_${successCount}`;

                const url = this.buildUrl(endpoint, context);
                const options = this.buildRequestOptions(method, context);

                const response = await this.apiClient.request({ ...options, url, method: method.toUpperCase() as any });
                context.saveResponse(alias, response);
                successCount++;

                if (successCount < rows.length) {
                    await this.delay(delayMs);
                }
            }

            CSReporter.pass(`Executed ${successCount} sequential requests successfully`);
        } catch (error) {
            CSReporter.fail(`Sequential requests failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sends request with custom timeout {int} seconds")
    async sendRequestWithTimeout(timeoutSeconds: number): Promise<void> {
        CSReporter.info(`Sending request with ${timeoutSeconds} second timeout`);

        try {
            const context = this.getCurrentContext();
            const method = context.getVariable('method') || 'GET';
            const endpoint = context.getVariable('requestPath') || '/';
            const url = this.buildUrl(endpoint, context);
            const options = this.buildRequestOptions(method, context);

            options.timeout = timeoutSeconds * 1000;

            const response = await this.apiClient.request({ ...options, url, method: method.toUpperCase() as any });

            context.setLastResponse(response);
            context.saveResponse('last', response);

            CSReporter.pass(`Request successful: ${response.status}`);
        } catch (error) {
            CSReporter.fail(`Request failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sends GraphQL query to {string}:")
    async sendGraphQLQuery(endpoint: string, query: string): Promise<void> {
        CSReporter.info(`Sending GraphQL query to ${endpoint}`);

        try {
            const context = this.getCurrentContext();
            const url = this.buildUrl(endpoint, context);

            const variables = context.getVariable('graphqlVariables') || {};
            const operationName = context.getVariable('graphqlOperationName');

            const body = {
                query: query.trim(),
                variables,
                ...(operationName && { operationName })
            };

            const options: CSRequestOptions = {
                url,
                method: 'POST',
                headers: {
                    ...context.headers,
                    'Content-Type': 'application/json'
                },
                body
            };

            const response = await this.apiClient.request(options);

            context.setLastResponse(response);
            context.saveResponse('last_graphql', response);

            CSReporter.pass(`GraphQL query successful: ${response.status}`);
        } catch (error) {
            CSReporter.fail(`GraphQL query failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user executes request and measures performance")
    async executeRequestAndMeasurePerformance(): Promise<void> {
        CSReporter.info('Executing request and measuring performance');

        try {
            const context = this.getCurrentContext();
            const method = context.getVariable('method') || 'GET';
            const endpoint = context.getVariable('requestPath') || '/';
            const url = this.buildUrl(endpoint, context);
            const options = this.buildRequestOptions(method, context);

            const startTime = Date.now();
            const response = await this.apiClient.request({ ...options, url, method: method.toUpperCase() as any });
            const endTime = Date.now();
            const duration = endTime - startTime;

            context.setLastResponse(response);
            context.saveResponse('last', response);
            context.setVariable('lastRequestDuration', duration);

            CSReporter.info(`Request duration: ${duration}ms`);
            CSReporter.info(`Response size: ${JSON.stringify(response.body).length} bytes`);
            CSReporter.pass(`Request successful: ${response.status} (${duration}ms)`);
        } catch (error) {
            CSReporter.fail(`Request failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user executes batch requests from {string} file")
    async executeBatchRequestsFromFile(filePath: string): Promise<void> {
        CSReporter.info(`Executing batch requests from file: ${filePath}`);

        try {
            const context = this.getCurrentContext();
            const resolvedPath = this.resolveFilePath(filePath);

            if (!fs.existsSync(resolvedPath)) {
                throw new Error(`Batch file not found: ${resolvedPath}`);
            }

            const fileContent = fs.readFileSync(resolvedPath, 'utf8');
            const requests = JSON.parse(fileContent);

            if (!Array.isArray(requests)) {
                throw new Error('Batch file must contain an array of requests');
            }

            let successCount = 0;
            const responses: CSResponse[] = [];

            for (const request of requests) {
                const url = this.buildUrl(request.url || request.path, context);
                const options: CSRequestOptions = {
                    url,
                    method: request.method || 'GET',
                    headers: { ...context.headers, ...request.headers },
                    body: request.body
                };

                try {
                    const response = await this.apiClient.request(options);
                    responses.push(response);

                    if (request.alias) {
                        context.saveResponse(request.alias, response);
                    }

                    successCount++;
                } catch (e) {
                    CSReporter.warn(`Request to ${url} failed: ${(e as Error).message}`);
                }
            }

            context.setVariable('batchResponses', responses);
            CSReporter.pass(`Executed ${successCount}/${requests.length} batch requests successfully`);
        } catch (error) {
            CSReporter.fail(`Batch execution failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sends request with exponential backoff retry")
    async sendRequestWithExponentialBackoff(): Promise<void> {
        CSReporter.info('Sending request with exponential backoff retry');

        try {
            const context = this.getCurrentContext();
            const method = context.getVariable('method') || 'GET';
            const endpoint = context.getVariable('requestPath') || '/';
            const url = this.buildUrl(endpoint, context);
            const options = this.buildRequestOptions(method, context);

            const maxRetries = context.getVariable('retryCount') || 3;
            const baseDelay = context.getVariable('retryDelay') || 1000;

            const response = await this.retryHandler.executeWithRetry(
                async () => await this.apiClient.request({ ...options, url, method: method.toUpperCase() as any }),
                {
                    maxRetries,
                    retryDelay: baseDelay,
                    exponentialBackoff: true,
                    maxDelay: baseDelay * Math.pow(2, maxRetries)
                }
            );

            context.setLastResponse(response);
            context.saveResponse('last', response);

            CSReporter.pass(`Request successful with exponential backoff: ${response.status}`);
        } catch (error) {
            CSReporter.fail(`Request failed after exponential backoff: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user executes conditional request if {string} equals {string}")
    async executeConditionalRequest(varName: string, expectedValue: string): Promise<void> {
        CSReporter.info(`Executing conditional request if ${varName} equals ${expectedValue}`);

        try {
            const context = this.getCurrentContext();
            const actualValue = context.getVariable(varName);

            if (String(actualValue) !== expectedValue) {
                CSReporter.info(`Condition not met: ${varName}=${actualValue}, expected ${expectedValue}`);
                return;
            }

            const method = context.getVariable('method') || 'GET';
            const endpoint = context.getVariable('requestPath') || '/';
            const url = this.buildUrl(endpoint, context);
            const options = this.buildRequestOptions(method, context);

            const response = await this.apiClient.request({ ...options, url, method: method.toUpperCase() as any });

            context.setLastResponse(response);
            context.saveResponse('last', response);

            CSReporter.pass(`Conditional request successful: ${response.status}`);
        } catch (error) {
            CSReporter.fail(`Conditional request failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user executes request with circuit breaker")
    async executeRequestWithCircuitBreaker(): Promise<void> {
        CSReporter.info('Executing request with circuit breaker');

        try {
            const context = this.getCurrentContext();
            const method = context.getVariable('method') || 'GET';
            const endpoint = context.getVariable('requestPath') || '/';
            const url = this.buildUrl(endpoint, context);
            const options = this.buildRequestOptions(method, context);

            const failureThreshold = context.getVariable('circuitBreakerThreshold') || 5;
            const resetTimeout = context.getVariable('circuitBreakerTimeout') || 30000;

            // Simple circuit breaker implementation
            const circuitState = context.getVariable('circuitState') || { failures: 0, isOpen: false, lastFailTime: 0 };

            if (circuitState.isOpen) {
                const timeSinceLastFail = Date.now() - circuitState.lastFailTime;
                if (timeSinceLastFail < resetTimeout) {
                    throw new Error('Circuit breaker is OPEN - request blocked');
                }
                circuitState.isOpen = false;
                circuitState.failures = 0;
            }

            try {
                const response = await this.apiClient.request({ ...options, url, method: method.toUpperCase() as any });

                circuitState.failures = 0;
                context.setVariable('circuitState', circuitState);

                context.setLastResponse(response);
                context.saveResponse('last', response);

                CSReporter.pass(`Request successful, circuit breaker CLOSED: ${response.status}`);
            } catch (error) {
                circuitState.failures++;
                circuitState.lastFailTime = Date.now();

                if (circuitState.failures >= failureThreshold) {
                    circuitState.isOpen = true;
                    CSReporter.warn(`Circuit breaker OPENED after ${failureThreshold} failures`);
                }

                context.setVariable('circuitState', circuitState);
                throw error;
            }
        } catch (error) {
            CSReporter.fail(`Request failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user sends paginated requests to {string} until {string}")
    async sendPaginatedRequests(endpoint: string, stopCondition: string): Promise<void> {
        CSReporter.info(`Sending paginated requests to ${endpoint} until ${stopCondition}`);

        try {
            const context = this.getCurrentContext();
            const responses: CSResponse[] = [];
            let page = 1;
            let hasMore = true;

            while (hasMore) {
                const url = this.buildUrl(endpoint, context);
                const paginatedUrl = `${url}${url.includes('?') ? '&' : '?'}page=${page}`;

                const options = this.buildRequestOptions('GET', context);
                const response = await this.apiClient.request({ ...options, url: paginatedUrl, method: 'GET' });

                responses.push(response);
                context.saveResponse(`page_${page}`, response);

                // Evaluate stop condition
                if (stopCondition.includes('empty')) {
                    hasMore = response.body && Array.isArray(response.body) && response.body.length > 0;
                } else if (stopCondition.includes('pages:')) {
                    const maxPages = parseInt(stopCondition.split(':')[1]);
                    hasMore = page < maxPages;
                } else {
                    hasMore = false;
                }

                page++;
            }

            context.setVariable('paginatedResponses', responses);
            context.setVariable('totalPages', page - 1);

            CSReporter.pass(`Retrieved ${page - 1} pages of data`);
        } catch (error) {
            CSReporter.fail(`Paginated request failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef("user polls {string} every {int} seconds until status is {int}")
    async pollEndpointUntilStatus(endpoint: string, intervalSeconds: number, expectedStatus: number): Promise<void> {
        CSReporter.info(`Polling ${endpoint} every ${intervalSeconds}s until status ${expectedStatus}`);

        try {
            const context = this.getCurrentContext();
            const url = this.buildUrl(endpoint, context);
            const options = this.buildRequestOptions('GET', context);
            const maxAttempts = context.getVariable('maxPollAttempts') || 10;

            let attempts = 0;
            let response: CSResponse;

            while (attempts < maxAttempts) {
                response = await this.apiClient.request({ ...options, url, method: 'GET' });

                if (response.status === expectedStatus) {
                    context.setLastResponse(response);
                    context.saveResponse('poll_success', response);
                    CSReporter.pass(`Polling successful after ${attempts + 1} attempts: status ${expectedStatus}`);
                    return;
                }

                attempts++;
                if (attempts < maxAttempts) {
                    CSReporter.info(`Attempt ${attempts}: status ${response.status}, waiting ${intervalSeconds}s...`);
                    await this.delay(intervalSeconds * 1000);
                }
            }

            throw new Error(`Polling failed: status ${response!.status} after ${maxAttempts} attempts`);
        } catch (error) {
            CSReporter.fail(`Polling failed: ${(error as Error).message}`);
            throw error;
        }
    }

    // Helper methods
    private buildUrl(endpoint: string, context: CSApiContext): string {
        const interpolatedEndpoint = this.interpolateValue(endpoint, context);

        if (interpolatedEndpoint.startsWith('http://') || interpolatedEndpoint.startsWith('https://')) {
            return interpolatedEndpoint;
        }

        const baseUrl = context.baseUrl || '';
        return baseUrl + interpolatedEndpoint;
    }

    private buildRequestOptions(method: string, context: CSApiContext): Partial<CSRequestOptions> {
        const body = context.getVariable('requestBody');
        const queryParams = context.getVariable('queryParams');

        return {
            headers: { ...context.headers },
            body,
            timeout: context.timeout,
            proxy: context.proxy,
            auth: context.auth,
            ...(queryParams && { params: queryParams })
        };
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

    private async delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}