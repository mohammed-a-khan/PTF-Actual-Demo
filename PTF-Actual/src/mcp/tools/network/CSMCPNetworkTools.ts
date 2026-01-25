/**
 * CS Playwright MCP Network & API Tools
 * Network interception, API testing, and request management
 * Real implementation using CSAPIClient and CSNetworkInterceptor
 *
 * @module CSMCPNetworkTools
 */

import {
    MCPToolDefinition,
    MCPToolResult,
    MCPToolContext,
    MCPTextContent,
} from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';

// Lazy load framework components
let CSAPIClient: any = null;
let CSNetworkInterceptor: any = null;
let CSReporter: any = null;
let CSConfigurationManager: any = null;
let CSRequestBuilder: any = null;

function ensureFrameworkLoaded(): void {
    if (!CSAPIClient) {
        CSAPIClient = require('../../../api/CSAPIClient').CSAPIClient;
    }
    if (!CSNetworkInterceptor) {
        CSNetworkInterceptor = require('../../../network/CSNetworkInterceptor').CSNetworkInterceptor;
    }
    if (!CSReporter) {
        CSReporter = require('../../../reporter/CSReporter').CSReporter;
    }
    if (!CSConfigurationManager) {
        CSConfigurationManager = require('../../../core/CSConfigurationManager').CSConfigurationManager;
    }
    if (!CSRequestBuilder) {
        CSRequestBuilder = require('../../../api/client/CSRequestBuilder').CSRequestBuilder;
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

function createTextResult(text: string): MCPToolResult {
    return {
        content: [{ type: 'text', text } as MCPTextContent],
    };
}

function createJsonResult(data: unknown): MCPToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) } as MCPTextContent],
        structuredContent: data as Record<string, unknown>,
    };
}

function createErrorResult(message: string): MCPToolResult {
    return {
        content: [{ type: 'text', text: `Error: ${message}` } as MCPTextContent],
        isError: true,
    };
}

/**
 * Get the network interceptor instance
 */
function getInterceptor(context: MCPToolContext): any {
    ensureFrameworkLoaded();

    // Get interceptor from server context or create singleton
    if (!context.server.networkInterceptor) {
        context.server.networkInterceptor = CSNetworkInterceptor.getInstance();
    }

    return context.server.networkInterceptor;
}

/**
 * Get or create API client
 */
function getApiClient(context: MCPToolContext): any {
    ensureFrameworkLoaded();

    if (!context.server.apiClient) {
        context.server.apiClient = new CSAPIClient();
    }

    return context.server.apiClient;
}

// Store for recording sessions
const recordingSessions = new Map<string, { requests: any[]; responses: any[]; startTime: Date }>();

// Store for mock rules
const mockRules = new Map<string, any>();

// ============================================================================
// Network Interception Tools
// ============================================================================

const networkInterceptTool = defineTool()
    .name('network_intercept')
    .description('Set up network request interception with custom response using CSNetworkInterceptor')
    .category('network')
    .stringParam('urlPattern', 'URL pattern to intercept (glob or regex)', { required: true })
    .stringParam('action', 'Action to take', {
        required: true,
        enum: ['mock', 'delay', 'fail', 'modify', 'block'],
    })
    .objectParam('response', 'Mock response data (for mock action)', {
        status: { type: 'integer', description: 'HTTP status code' },
        headers: { type: 'object', description: 'Response headers' },
        body: { type: 'object', description: 'Response body' },
    })
    .numberParam('delay', 'Delay in milliseconds (for delay action)')
    .numberParam('statusCode', 'HTTP status code for mock response', { default: 200 })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const urlPattern = params.urlPattern as string;
        const action = params.action as string;

        context.log('info', `Setting up network interception for ${urlPattern}`);
        CSReporter.info(`[MCP] Setting up network interception: ${action} for ${urlPattern}`);

        try {
            const interceptor = getInterceptor(context);
            const interceptorId = `intercept_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            // Build mock rule based on action
            const rule: any = {
                url: urlPattern.includes('*') || urlPattern.includes('?')
                    ? new RegExp(urlPattern.replace(/\*/g, '.*').replace(/\?/g, '.'))
                    : urlPattern,
            };

            switch (action) {
                case 'mock':
                    rule.response = {
                        status: (params.statusCode as number) || 200,
                        headers: (params.response as any)?.headers || { 'Content-Type': 'application/json' },
                        body: (params.response as any)?.body || {},
                    };
                    break;

                case 'delay':
                    rule.response = {
                        delay: (params.delay as number) || 1000,
                    };
                    break;

                case 'fail':
                    rule.abort = true;
                    rule.errorCode = 'failed';
                    break;

                case 'block':
                    rule.abort = true;
                    rule.errorCode = 'blockedbyclient';
                    break;

                case 'modify':
                    rule.modify = (request: any) => {
                        // Placeholder for modification logic
                        return request;
                    };
                    break;
            }

            // Store the rule for later reference
            mockRules.set(interceptorId, rule);

            // Add mock rule to interceptor
            interceptor.addMockRule(rule);

            CSReporter.pass(`[MCP] Network interception configured: ${interceptorId}`);

            return createJsonResult({
                status: 'interception_configured',
                urlPattern,
                action,
                interceptorId,
                rule: {
                    urlPattern: urlPattern,
                    action,
                    statusCode: params.statusCode || 200,
                },
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Network interception failed: ${error.message}`);
            return createErrorResult(`Failed to set up interception: ${error.message}`);
        }
    })
    .build();

const networkRemoveInterceptTool = defineTool()
    .name('network_remove_intercept')
    .description('Remove a network interception rule')
    .category('network')
    .stringParam('interceptorId', 'ID of the interceptor to remove', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const interceptorId = params.interceptorId as string;

        context.log('info', `Removing network interceptor ${interceptorId}`);
        CSReporter.info(`[MCP] Removing network interceptor: ${interceptorId}`);

        try {
            const rule = mockRules.get(interceptorId);
            if (rule) {
                const interceptor = getInterceptor(context);
                interceptor.removeMockRule(rule);
                mockRules.delete(interceptorId);
            }

            CSReporter.pass(`[MCP] Interceptor removed: ${interceptorId}`);
            return createTextResult(`Interceptor ${interceptorId} removed`);
        } catch (error: any) {
            return createErrorResult(`Failed to remove interceptor: ${error.message}`);
        }
    })
    .build();

const networkRecordTool = defineTool()
    .name('network_record')
    .description('Start recording network traffic using CSNetworkInterceptor')
    .category('network')
    .stringParam('urlPattern', 'URL pattern to record (optional, records all if not specified)')
    .booleanParam('includeHeaders', 'Include request/response headers', { default: true })
    .booleanParam('includeBody', 'Include request/response body', { default: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        context.log('info', 'Starting network recording');
        CSReporter.info('[MCP] Starting network recording');

        try {
            const interceptor = getInterceptor(context);
            const recordingId = `recording_${Date.now()}`;

            // Start recording
            interceptor.startRecording();

            // Store recording session
            recordingSessions.set(recordingId, {
                requests: [],
                responses: [],
                startTime: new Date(),
            });

            CSReporter.pass(`[MCP] Network recording started: ${recordingId}`);

            return createJsonResult({
                status: 'recording_started',
                recordingId,
                urlPattern: params.urlPattern || '*',
                startTime: new Date().toISOString(),
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Recording start failed: ${error.message}`);
            return createErrorResult(`Failed to start recording: ${error.message}`);
        }
    })
    .build();

const networkStopRecordTool = defineTool()
    .name('network_stop_record')
    .description('Stop recording network traffic and get recorded requests')
    .category('network')
    .stringParam('recordingId', 'ID of the recording to stop', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const recordingId = params.recordingId as string;

        context.log('info', `Stopping network recording ${recordingId}`);
        CSReporter.info(`[MCP] Stopping network recording: ${recordingId}`);

        try {
            const interceptor = getInterceptor(context);

            // Stop recording and get results
            interceptor.stopRecording();

            const requests = interceptor.getRecordedRequests();
            const responses = interceptor.getRecordedResponses();

            // Clean up session
            recordingSessions.delete(recordingId);

            CSReporter.pass(`[MCP] Recording stopped. Captured ${requests.length} requests`);

            return createJsonResult({
                status: 'recording_stopped',
                recordingId,
                requests: requests.map((req: any) => ({
                    url: req.url,
                    method: req.method,
                    headers: req.headers,
                    timestamp: req.timestamp,
                })),
                responses: responses.map((res: any) => ({
                    url: res.url,
                    status: res.status,
                    duration: res.duration,
                })),
                count: requests.length,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Recording stop failed: ${error.message}`);
            return createErrorResult(`Failed to stop recording: ${error.message}`);
        }
    })
    .build();

const networkWaitForRequestTool = defineTool()
    .name('network_wait_for_request')
    .description('Wait for a specific network request to be made')
    .category('network')
    .stringParam('urlPattern', 'URL pattern to wait for', { required: true })
    .stringParam('method', 'HTTP method to match', { enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] })
    .numberParam('timeout', 'Timeout in milliseconds', { default: 30000 })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const urlPattern = params.urlPattern as string;
        const method = params.method as string;
        const timeout = (params.timeout as number) || 30000;

        context.log('info', `Waiting for request matching ${urlPattern}`);
        CSReporter.info(`[MCP] Waiting for request: ${method || 'ANY'} ${urlPattern}`);

        try {
            // Get page from browser context
            const page = context.server.browser?.page as any;
            if (!page) {
                throw new Error('No browser page available. Use browser_launch first.');
            }

            // Wait for request using Playwright
            const request = await page.waitForRequest(
                (req: any) => {
                    const matchesUrl = req.url().includes(urlPattern) ||
                        new RegExp(urlPattern.replace(/\*/g, '.*')).test(req.url());
                    const matchesMethod = !method || req.method().toUpperCase() === method.toUpperCase();
                    return matchesUrl && matchesMethod;
                },
                { timeout }
            );

            CSReporter.pass(`[MCP] Request captured: ${request.method()} ${request.url()}`);

            return createJsonResult({
                status: 'request_captured',
                url: request.url(),
                method: request.method(),
                headers: request.headers(),
                postData: request.postData(),
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Wait for request failed: ${error.message}`);
            return createErrorResult(`Wait for request failed: ${error.message}`);
        }
    })
    .build();

const networkWaitForResponseTool = defineTool()
    .name('network_wait_for_response')
    .description('Wait for a specific network response')
    .category('network')
    .stringParam('urlPattern', 'URL pattern to wait for', { required: true })
    .numberParam('statusCode', 'Expected status code')
    .numberParam('timeout', 'Timeout in milliseconds', { default: 30000 })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const urlPattern = params.urlPattern as string;
        const expectedStatus = params.statusCode as number | undefined;
        const timeout = (params.timeout as number) || 30000;

        context.log('info', `Waiting for response from ${urlPattern}`);
        CSReporter.info(`[MCP] Waiting for response: ${urlPattern}`);

        try {
            const page = context.server.browser?.page as any;
            if (!page) {
                throw new Error('No browser page available. Use browser_launch first.');
            }

            // Wait for response using Playwright
            const response = await page.waitForResponse(
                (res: any) => {
                    const matchesUrl = res.url().includes(urlPattern) ||
                        new RegExp(urlPattern.replace(/\*/g, '.*')).test(res.url());
                    const matchesStatus = !expectedStatus || res.status() === expectedStatus;
                    return matchesUrl && matchesStatus;
                },
                { timeout }
            );

            CSReporter.pass(`[MCP] Response captured: ${response.status()} ${response.url()}`);

            let body = null;
            try {
                body = await response.json();
            } catch {
                try {
                    body = await response.text();
                } catch {
                    // Body not available
                }
            }

            return createJsonResult({
                status: 'response_captured',
                url: response.url(),
                statusCode: response.status(),
                statusText: response.statusText(),
                headers: response.headers(),
                body,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Wait for response failed: ${error.message}`);
            return createErrorResult(`Wait for response failed: ${error.message}`);
        }
    })
    .build();

const networkGetRequestsTool = defineTool()
    .name('network_get_requests')
    .description('Get all captured network requests from CSNetworkInterceptor')
    .category('network')
    .stringParam('urlPattern', 'Filter by URL pattern')
    .stringParam('method', 'Filter by HTTP method')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        context.log('info', 'Getting captured network requests');

        try {
            const interceptor = getInterceptor(context);
            let requests = interceptor.getRecordedRequests();

            // Filter by URL pattern if specified
            if (params.urlPattern) {
                const pattern = params.urlPattern as string;
                requests = requests.filter((req: any) =>
                    req.url.includes(pattern) ||
                    new RegExp(pattern.replace(/\*/g, '.*')).test(req.url)
                );
            }

            // Filter by method if specified
            if (params.method) {
                requests = requests.filter((req: any) =>
                    req.method.toUpperCase() === (params.method as string).toUpperCase()
                );
            }

            return createJsonResult({
                requests: requests.map((req: any) => ({
                    url: req.url,
                    method: req.method,
                    headers: req.headers,
                    timestamp: req.timestamp,
                })),
                count: requests.length,
            });
        } catch (error: any) {
            return createErrorResult(`Failed to get requests: ${error.message}`);
        }
    })
    .readOnly()
    .build();

const networkClearRequestsTool = defineTool()
    .name('network_clear_requests')
    .description('Clear all captured network requests')
    .category('network')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        context.log('info', 'Clearing captured network requests');
        CSReporter.info('[MCP] Clearing captured network requests');

        try {
            const interceptor = getInterceptor(context);
            interceptor.clearRecordedRequests();

            CSReporter.pass('[MCP] Network requests cleared');
            return createTextResult('Network requests cleared');
        } catch (error: any) {
            return createErrorResult(`Failed to clear requests: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// API Testing Tools using CSAPIClient
// ============================================================================

const apiRequestTool = defineTool()
    .name('api_request')
    .description('Make an HTTP API request using CSAPIClient')
    .category('api')
    .stringParam('url', 'Request URL', { required: true })
    .stringParam('method', 'HTTP method', {
        required: true,
        enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
    })
    .objectParam('headers', 'Request headers')
    .objectParam('body', 'Request body (for POST/PUT/PATCH)')
    .objectParam('query', 'Query parameters')
    .numberParam('timeout', 'Request timeout in milliseconds', { default: 30000 })
    .booleanParam('followRedirects', 'Follow redirects', { default: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const url = params.url as string;
        const method = params.method as string;

        context.log('info', `Making ${method} request to ${url}`);
        CSReporter.info(`[MCP] API Request: ${method} ${url}`);

        const startTime = Date.now();

        try {
            const apiClient = getApiClient(context);

            // Build request options
            const options: any = {
                url,
                method,
                headers: params.headers as Record<string, string>,
                body: params.body,
                query: params.query as Record<string, string>,
                timeout: params.timeout || 30000,
                followRedirects: params.followRedirects !== false,
            };

            // Make request using CSAPIClient
            const response = await apiClient.request(options);

            const responseTime = Date.now() - startTime;

            CSReporter.pass(`[MCP] API Response: ${response.status} (${responseTime}ms)`);

            return createJsonResult({
                status: response.status,
                statusMessage: response.statusText,
                headers: response.headers,
                body: response.data,
                responseTime,
                cookies: response.cookies,
            });
        } catch (error: any) {
            const responseTime = Date.now() - startTime;
            CSReporter.fail(`[MCP] API Request failed: ${error.message}`);

            // Check if error has response data
            if (error.response) {
                return createJsonResult({
                    status: error.response.status,
                    statusMessage: error.response.statusText,
                    headers: error.response.headers,
                    body: error.response.data,
                    responseTime,
                    error: error.message,
                });
            }

            return createErrorResult(`Request failed: ${error.message}`);
        }
    })
    .build();

const apiVerifyResponseTool = defineTool()
    .name('api_verify_response')
    .description('Make API request and verify response against expected values')
    .category('api')
    .stringParam('url', 'Request URL', { required: true })
    .stringParam('method', 'HTTP method', { default: 'GET' })
    .numberParam('expectedStatus', 'Expected HTTP status code')
    .objectParam('expectedBody', 'Expected response body (partial match)')
    .objectParam('expectedHeaders', 'Expected response headers')
    .stringParam('jsonPath', 'JSONPath expression to validate specific field')
    .stringParam('expectedValue', 'Expected value for JSONPath')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const url = params.url as string;
        const method = (params.method as string) || 'GET';

        context.log('info', `Verifying API response from ${url}`);
        CSReporter.info(`[MCP] Verifying API response: ${method} ${url}`);

        try {
            const apiClient = getApiClient(context);

            // Make request
            const response = await apiClient.request({
                url,
                method,
            });

            const checks: Record<string, any> = {};
            let allPassed = true;

            // Check status code
            if (params.expectedStatus !== undefined) {
                const statusMatch = response.status === params.expectedStatus;
                checks.status = {
                    expected: params.expectedStatus,
                    actual: response.status,
                    passed: statusMatch,
                };
                if (!statusMatch) allPassed = false;
            }

            // Check headers
            if (params.expectedHeaders) {
                const expectedHeaders = params.expectedHeaders as Record<string, string>;
                const headerChecks: Record<string, any> = {};
                let headersMatch = true;

                for (const [key, expectedValue] of Object.entries(expectedHeaders)) {
                    const actualValue = response.headers[key.toLowerCase()];
                    const matches = actualValue === expectedValue;
                    headerChecks[key] = {
                        expected: expectedValue,
                        actual: actualValue,
                        passed: matches,
                    };
                    if (!matches) {
                        headersMatch = false;
                        allPassed = false;
                    }
                }

                checks.headers = { checks: headerChecks, passed: headersMatch };
            }

            // Check body (partial match)
            if (params.expectedBody) {
                const expectedBody = params.expectedBody;
                const actualBody = response.data;
                const bodyMatch = deepPartialMatch(actualBody, expectedBody);
                checks.body = {
                    passed: bodyMatch,
                    expected: expectedBody,
                };
                if (!bodyMatch) allPassed = false;
            }

            // Check JSONPath
            if (params.jsonPath && params.expectedValue !== undefined) {
                const actualValue = getValueByPath(response.data, params.jsonPath as string);
                const valueMatch = String(actualValue) === String(params.expectedValue);
                checks.jsonPath = {
                    path: params.jsonPath,
                    expected: params.expectedValue,
                    actual: actualValue,
                    passed: valueMatch,
                };
                if (!valueMatch) allPassed = false;
            }

            if (allPassed) {
                CSReporter.pass('[MCP] API verification passed');
            } else {
                CSReporter.fail('[MCP] API verification failed');
            }

            return createJsonResult({
                verified: allPassed,
                url,
                status: response.status,
                checks,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] API verification failed: ${error.message}`);
            return createErrorResult(`Verification failed: ${error.message}`);
        }
    })
    .build();

const apiGraphqlTool = defineTool()
    .name('api_graphql')
    .description('Execute a GraphQL query or mutation using CSAPIClient')
    .category('api')
    .stringParam('url', 'GraphQL endpoint URL', { required: true })
    .stringParam('query', 'GraphQL query or mutation', { required: true })
    .objectParam('variables', 'Query variables')
    .objectParam('headers', 'Request headers')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const url = params.url as string;
        const query = params.query as string;

        context.log('info', `Executing GraphQL query on ${url}`);
        CSReporter.info(`[MCP] GraphQL request: ${url}`);

        try {
            const apiClient = getApiClient(context);

            const response = await apiClient.request({
                url,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(params.headers as Record<string, string> || {}),
                },
                body: {
                    query,
                    variables: params.variables || {},
                },
            });

            const graphqlResponse = response.data;

            if (graphqlResponse.errors && graphqlResponse.errors.length > 0) {
                CSReporter.warn(`[MCP] GraphQL returned errors: ${graphqlResponse.errors.length}`);
            } else {
                CSReporter.pass('[MCP] GraphQL query executed successfully');
            }

            return createJsonResult({
                data: graphqlResponse.data,
                errors: graphqlResponse.errors || [],
                extensions: graphqlResponse.extensions,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] GraphQL request failed: ${error.message}`);
            return createErrorResult(`GraphQL request failed: ${error.message}`);
        }
    })
    .build();

const apiSoapTool = defineTool()
    .name('api_soap')
    .description('Make a SOAP API request using CSAPIClient')
    .category('api')
    .stringParam('url', 'SOAP endpoint URL', { required: true })
    .stringParam('action', 'SOAP action', { required: true })
    .stringParam('body', 'SOAP XML body', { required: true })
    .objectParam('headers', 'Additional headers')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const url = params.url as string;
        const action = params.action as string;
        const body = params.body as string;

        context.log('info', `Making SOAP request to ${url}`);
        CSReporter.info(`[MCP] SOAP request: ${action} to ${url}`);

        try {
            const apiClient = getApiClient(context);

            const response = await apiClient.request({
                url,
                method: 'POST',
                headers: {
                    'Content-Type': 'text/xml; charset=utf-8',
                    'SOAPAction': action,
                    ...(params.headers as Record<string, string> || {}),
                },
                body,
            });

            CSReporter.pass(`[MCP] SOAP response: ${response.status}`);

            return createJsonResult({
                status: response.status,
                response: response.data,
                headers: response.headers,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] SOAP request failed: ${error.message}`);
            return createErrorResult(`SOAP request failed: ${error.message}`);
        }
    })
    .build();

const apiSetContextTool = defineTool()
    .name('api_set_context')
    .description('Set API context (base URL, headers, auth) for subsequent requests')
    .category('api')
    .stringParam('baseUrl', 'Base URL for all requests')
    .objectParam('headers', 'Default headers to include')
    .objectParam('auth', 'Authentication configuration', {
        type: { type: 'string', description: 'Auth type: basic, bearer, oauth2' },
        username: { type: 'string', description: 'Username for basic auth' },
        password: { type: 'string', description: 'Password for basic auth' },
        token: { type: 'string', description: 'Token for bearer auth' },
    })
    .numberParam('timeout', 'Default timeout in milliseconds')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        context.log('info', 'Setting API context');
        CSReporter.info('[MCP] Setting API context');

        try {
            const apiClient = getApiClient(context);

            if (params.baseUrl) {
                apiClient.setBaseUrl(params.baseUrl as string);
            }

            if (params.headers) {
                const headers = params.headers as Record<string, string>;
                for (const [key, value] of Object.entries(headers)) {
                    apiClient.setDefaultHeader(key, value);
                }
            }

            if (params.auth) {
                apiClient.setAuth(params.auth);
            }

            if (params.timeout) {
                apiClient.setTimeout(params.timeout as number);
            }

            CSReporter.pass('[MCP] API context configured');

            return createJsonResult({
                status: 'context_configured',
                baseUrl: params.baseUrl,
                headersSet: params.headers ? Object.keys(params.headers as object).length : 0,
                authConfigured: !!params.auth,
                timeout: params.timeout,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Context setup failed: ${error.message}`);
            return createErrorResult(`Failed to set context: ${error.message}`);
        }
    })
    .build();

const apiGetLastResponseTool = defineTool()
    .name('api_get_last_response')
    .description('Get the last API response from context')
    .category('api')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        try {
            const apiClient = getApiClient(context);
            const lastResponse = apiClient.getLastResponse();

            if (!lastResponse) {
                return createJsonResult({
                    message: 'No previous response available',
                    response: null,
                });
            }

            return createJsonResult({
                status: lastResponse.status,
                statusText: lastResponse.statusText,
                headers: lastResponse.headers,
                body: lastResponse.data,
            });
        } catch (error: any) {
            return createErrorResult(`Failed to get last response: ${error.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Helper Functions for Response Verification
// ============================================================================

function deepPartialMatch(actual: any, expected: any): boolean {
    if (expected === null || expected === undefined) {
        return actual === expected;
    }

    if (typeof expected !== 'object') {
        return actual === expected;
    }

    if (Array.isArray(expected)) {
        if (!Array.isArray(actual)) return false;
        return expected.every((item, index) => deepPartialMatch(actual[index], item));
    }

    if (typeof actual !== 'object' || actual === null) {
        return false;
    }

    for (const key of Object.keys(expected)) {
        if (!deepPartialMatch(actual[key], expected[key])) {
            return false;
        }
    }

    return true;
}

function getValueByPath(obj: any, path: string): any {
    // Simple JSONPath-like implementation
    const parts = path.replace(/^\$\.?/, '').split('.');
    let current = obj;

    for (const part of parts) {
        if (current === null || current === undefined) {
            return undefined;
        }

        // Handle array notation like items[0]
        const arrayMatch = part.match(/^(.+)\[(\d+)\]$/);
        if (arrayMatch) {
            current = current[arrayMatch[1]];
            if (Array.isArray(current)) {
                current = current[parseInt(arrayMatch[2], 10)];
            }
        } else {
            current = current[part];
        }
    }

    return current;
}

// ============================================================================
// Export all network/API tools
// ============================================================================

export const networkTools: MCPToolDefinition[] = [
    // Network Interception
    networkInterceptTool,
    networkRemoveInterceptTool,
    networkRecordTool,
    networkStopRecordTool,
    networkWaitForRequestTool,
    networkWaitForResponseTool,
    networkGetRequestsTool,
    networkClearRequestsTool,

    // API Testing
    apiRequestTool,
    apiVerifyResponseTool,
    apiGraphqlTool,
    apiSoapTool,
    apiSetContextTool,
    apiGetLastResponseTool,
];

/**
 * Register all network/API tools with the registry
 */
export function registerNetworkTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(networkTools);
}
