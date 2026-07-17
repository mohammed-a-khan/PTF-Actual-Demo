/**
 * PTF-ADO MCP Azure DevOps Tools
 * Complete Azure DevOps integration for CI/CD operations
 * Includes pipelines, builds, test runs, work items, and PR management
 *
 * @module CSMCPAzureDevOpsTools
 */

import * as https from 'https';
import * as http from 'http';
import {
    MCPToolDefinition,
    MCPToolResult,
    MCPToolContext,
    MCPTextContent,
    AzureDevOpsConfig,
    AzureDevOpsPipeline,
    AzureDevOpsBuild,
    AzureDevOpsTestRun,
    AzureDevOpsTestResult,
    AzureDevOpsWorkItem,
    AzureDevOpsPullRequest,
} from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';
import { CSConfigurationManager } from '../../../core/CSConfigurationManager';

// ============================================================================
// Azure DevOps API Client
// ============================================================================

interface AzureDevOpsApiResponse {
    statusCode: number;
    data: unknown;
}

class AzureDevOpsClient {
    private config: AzureDevOpsConfig;
    private baseUrl: string;
    private proxyAgent: https.Agent | undefined;

    constructor(config: AzureDevOpsConfig) {
        this.config = config;
        this.baseUrl = config.baseUrl || 'https://dev.azure.com';
        this.proxyAgent = AzureDevOpsClient.resolveProxyAgent();
    }

    /** The configured project name — used to scope search/core queries. */
    getProject(): string {
        return this.config.project;
    }

    /**
     * Build an HTTP(S)/SOCKS proxy agent from the same `ADO_PROXY_*` config
     * the framework's CSADOClient honours, so ADO calls work behind a
     * corporate proxy. Returns undefined when proxying is disabled or the
     * host is unresolved. Failures are swallowed — a missing proxy agent
     * just means a direct connection is attempted.
     */
    private static resolveProxyAgent(): https.Agent | undefined {
        try {
            const cfg = CSConfigurationManager.getInstance();
            const enabled = cfg.getBoolean
                ? cfg.getBoolean('ADO_PROXY_ENABLED', false)
                : String(cfg.get('ADO_PROXY_ENABLED', 'false')).toLowerCase() === 'true';
            // Also honour standard env proxies when ADO_PROXY_* is unset.
            const envProxy =
                process.env.HTTPS_PROXY ||
                process.env.https_proxy ||
                process.env.HTTP_PROXY ||
                process.env.http_proxy;
            if (!enabled && !envProxy) return undefined;

            let proxyUrl: string;
            if (enabled) {
                const protocol = cfg.get('ADO_PROXY_PROTOCOL', 'http');
                const host = cfg.get('ADO_PROXY_HOST', '');
                const port = cfg.getNumber ? cfg.getNumber('ADO_PROXY_PORT', 8080) : 8080;
                if (!host) return envProxy ? AzureDevOpsClient.agentFor(envProxy) : undefined;
                const authRequired = cfg.getBoolean
                    ? cfg.getBoolean('ADO_PROXY_AUTH_REQUIRED', false)
                    : false;
                let auth = '';
                if (authRequired) {
                    const user = cfg.get('ADO_PROXY_USERNAME', '');
                    const pass = cfg.get('ADO_PROXY_PASSWORD', '');
                    if (user && pass) auth = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`;
                }
                proxyUrl = `${protocol}://${auth}${host}:${port}`;
            } else {
                proxyUrl = envProxy as string;
            }
            return AzureDevOpsClient.agentFor(proxyUrl);
        } catch {
            return undefined;
        }
    }

    private static agentFor(proxyUrl: string): https.Agent | undefined {
        try {
            if (/^socks/i.test(proxyUrl)) {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { SocksProxyAgent } = require('socks-proxy-agent');
                return new SocksProxyAgent(proxyUrl) as unknown as https.Agent;
            }
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { HttpsProxyAgent } = require('https-proxy-agent');
            return new HttpsProxyAgent(proxyUrl) as unknown as https.Agent;
        } catch {
            return undefined;
        }
    }

    /**
     * Make an API request to Azure DevOps.
     *
     * `contentType` defaults to `application/json` but JSON Patch endpoints
     * (work item create / update) MUST use `application/json-patch+json` per
     * Azure DevOps REST API spec.
     */
    async request(
        method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
        path: string,
        body?: unknown,
        apiVersion: string = '7.1',
        contentType: string = 'application/json'
    ): Promise<AzureDevOpsApiResponse> {
        const url = new URL(`${this.baseUrl}/${this.config.organization}/${this.config.project}/_apis/${path}`);
        url.searchParams.set('api-version', apiVersion);

        const options: https.RequestOptions = {
            hostname: url.hostname,
            port: url.port || 443,
            path: `${url.pathname}${url.search}`,
            method,
            headers: {
                'Content-Type': contentType,
                'Authorization': `Basic ${Buffer.from(`:${this.config.personalAccessToken}`).toString('base64')}`,
            },
            // Route through the corporate proxy when ADO_PROXY_* / HTTPS_PROXY
            // is configured (matches the framework's CSADOClient behaviour).
            ...(this.proxyAgent ? { agent: this.proxyAgent } : {}),
        };

        return new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        const jsonData = data ? JSON.parse(data) : {};
                        resolve({
                            statusCode: res.statusCode || 500,
                            data: jsonData,
                        });
                    } catch (error) {
                        resolve({
                            statusCode: res.statusCode || 500,
                            data: { raw: data },
                        });
                    }
                });
            });

            req.on('error', (error) => {
                reject(error);
            });

            if (body) {
                req.write(JSON.stringify(body));
            }

            req.end();
        });
    }

    /**
     * Make a request to the Build API
     */
    async buildRequest(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<AzureDevOpsApiResponse> {
        return this.request(method, `build/${path}`, body);
    }

    /**
     * Make a request to the Test API
     */
    async testRequest(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<AzureDevOpsApiResponse> {
        return this.request(method, `test/${path}`, body);
    }

    /**
     * Make a request to the Git API
     */
    async gitRequest(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<AzureDevOpsApiResponse> {
        return this.request(method, `git/${path}`, body);
    }

    /**
     * Make a request to the Work Item Tracking API.
     *
     * Pass `contentType='application/json-patch+json'` when sending a JSON
     * Patch document (work item create/update). Defaults to `application/json`
     * for non-patch endpoints like `wiql`.
     */
    async witRequest(
        method: 'GET' | 'POST' | 'PATCH',
        path: string,
        body?: unknown,
        contentType: string = 'application/json'
    ): Promise<AzureDevOpsApiResponse> {
        return this.request(method, `wit/${path}`, body, '7.1', contentType);
    }

    /**
     * Make a request to the Pipelines API
     */
    async pipelinesRequest(method: 'GET' | 'POST', path: string, body?: unknown): Promise<AzureDevOpsApiResponse> {
        return this.request(method, `pipelines/${path}`, body);
    }

    /**
     * Make a request to the Test Plan API (distinct from the legacy Test API).
     * Used for plans, suites, and the plan-suite-case hierarchy.
     */
    async testPlanRequest(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<AzureDevOpsApiResponse> {
        return this.request(method, `testplan/${path}`, body);
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
 * Resolve an ADO config value. Priority:
 *   1. Tool param (highest — explicit caller intent)
 *   2. CSConfigurationManager (8-level hierarchy with auto-decryption of
 *      `ENCRYPTED:...` values; pulls from `process.env` and project/env
 *      .env files transparently)
 *   3. Direct `process.env` (defensive fallback when CSConfigurationManager
 *      has not been initialized — e.g. in unit tests)
 *
 * The `ENCRYPTED:` prefix is decrypted automatically by
 * CSConfigurationManager's `decryptValues()` pass; callers always see the
 * plaintext.
 */
function resolveAdoConfig(
    paramValue: unknown,
    configKey: string,
): string | undefined {
    const fromParam = typeof paramValue === 'string' ? paramValue.trim() : '';
    if (fromParam.length > 0) return fromParam;
    try {
        const fromCfg = CSConfigurationManager.getInstance().get(configKey, '');
        if (fromCfg && fromCfg.length > 0) return fromCfg;
    } catch {
        // CSConfigurationManager not initialized — fall through to env.
    }
    const fromEnv = process.env[configKey];
    if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
        return fromEnv.trim();
    }
    return undefined;
}

function getClient(params: Record<string, unknown>): AzureDevOpsClient {
    const organization = resolveAdoConfig(params.organization, 'ADO_ORGANIZATION');
    const project = resolveAdoConfig(params.project, 'ADO_PROJECT');
    const personalAccessToken = resolveAdoConfig(params.pat, 'ADO_PAT');

    const config: AzureDevOpsConfig = {
        organization: organization ?? '',
        project: project ?? '',
        personalAccessToken: personalAccessToken ?? '',
        baseUrl: params.baseUrl as string | undefined,
    };

    if (!config.organization || !config.project || !config.personalAccessToken) {
        const missing: string[] = [];
        if (!config.organization) missing.push('organization (ADO_ORGANIZATION)');
        if (!config.project) missing.push('project (ADO_PROJECT)');
        if (!config.personalAccessToken) missing.push('pat (ADO_PAT)');
        throw new Error(
            `Missing required Azure DevOps configuration: ${missing.join(', ')}. ` +
                'Provide via tool params, set in your project .env, or set as process env vars.',
        );
    }

    return new AzureDevOpsClient(config);
}

// Common parameters for all Azure DevOps tools
const adoCommonParams = (builder: ReturnType<typeof defineTool>) => {
    return builder
        .stringParam('organization', 'Azure DevOps organization name', { required: true })
        .stringParam('project', 'Azure DevOps project name', { required: true })
        .stringParam('pat', 'Personal Access Token for authentication', { required: true })
        .stringParam('baseUrl', 'Base URL for Azure DevOps (default: https://dev.azure.com)');
};

// ============================================================================
// Pipeline Tools
// ============================================================================

const adoPipelinesListTool = adoCommonParams(defineTool())
    .name('ado_pipelines_list')
    .title('List Azure DevOps Pipelines')
    .description('List all pipelines in the Azure DevOps project')
    .openWorld()
    .category('cicd')
    .stringParam('folder', 'Filter pipelines by folder path')
    .numberParam('top', 'Maximum number of pipelines to return')
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', 'Listing Azure DevOps pipelines');

        let path = '';
        const queryParams: string[] = [];
        if (params.folder) queryParams.push(`folder=${encodeURIComponent(params.folder as string)}`);
        if (params.top) queryParams.push(`$top=${params.top}`);
        if (queryParams.length > 0) path = `?${queryParams.join('&')}`;

        const response = await client.pipelinesRequest('GET', path);

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to list pipelines: ${JSON.stringify(response.data)}`);
        }

        const data = response.data as { value: AzureDevOpsPipeline[]; count: number };
        return createJsonResult({
            pipelines: data.value,
            count: data.count || data.value?.length || 0,
        });
    })
    .readOnly()
    .build();

const adoPipelinesRunTool = adoCommonParams(defineTool())
    .name('ado_pipelines_run')
    .title('Run Azure DevOps Pipeline')
    .description('Trigger a pipeline run in Azure DevOps')
    .openWorld()
    .category('cicd')
    .numberParam('pipelineId', 'ID of the pipeline to run', { required: true })
    .stringParam('branch', 'Source branch to run the pipeline on (e.g., refs/heads/main)')
    .objectParam('variables', 'Pipeline variables as key-value pairs')
    .objectParam('templateParameters', 'Template parameters as key-value pairs')
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Running pipeline ${params.pipelineId}`);

        const body: Record<string, unknown> = {};

        if (params.branch) {
            body.resources = {
                repositories: {
                    self: {
                        refName: params.branch,
                    },
                },
            };
        }

        if (params.variables) {
            body.variables = params.variables;
        }

        if (params.templateParameters) {
            body.templateParameters = params.templateParameters;
        }

        const response = await client.pipelinesRequest('POST', `${params.pipelineId}/runs`, body);

        if (response.statusCode !== 200 && response.statusCode !== 201) {
            return createErrorResult(`Failed to run pipeline: ${JSON.stringify(response.data)}`);
        }

        return createJsonResult({
            status: 'pipeline_triggered',
            run: response.data,
        });
    })
    .build();

const adoPipelinesGetRunTool = adoCommonParams(defineTool())
    .name('ado_pipelines_get_run')
    .title('Get Pipeline Run')
    .description('Get details of a specific pipeline run')
    .openWorld()
    .category('cicd')
    .numberParam('pipelineId', 'ID of the pipeline', { required: true })
    .numberParam('runId', 'ID of the run', { required: true })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Getting pipeline run ${params.runId}`);

        const response = await client.pipelinesRequest('GET', `${params.pipelineId}/runs/${params.runId}`);

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to get pipeline run: ${JSON.stringify(response.data)}`);
        }

        return createJsonResult(response.data);
    })
    .readOnly()
    .build();

// ============================================================================
// Build Tools
// ============================================================================

const adoBuildsListTool = adoCommonParams(defineTool())
    .name('ado_builds_list')
    .title('List Builds')
    .description('List builds in the Azure DevOps project')
    .openWorld()
    .category('cicd')
    .numberParam('definitionId', 'Filter by build definition ID')
    .stringParam('status', 'Filter by build status', {
        enum: ['all', 'cancelling', 'completed', 'inProgress', 'none', 'notStarted', 'postponed'],
    })
    .stringParam('result', 'Filter by build result', {
        enum: ['canceled', 'failed', 'none', 'partiallySucceeded', 'succeeded'],
    })
    .stringParam('branchName', 'Filter by branch name')
    .numberParam('top', 'Maximum number of builds to return', { default: 20 })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', 'Listing Azure DevOps builds');

        const queryParams: string[] = [];
        if (params.definitionId) queryParams.push(`definitions=${params.definitionId}`);
        if (params.status) queryParams.push(`statusFilter=${params.status}`);
        if (params.result) queryParams.push(`resultFilter=${params.result}`);
        if (params.branchName) queryParams.push(`branchName=${encodeURIComponent(params.branchName as string)}`);
        if (params.top) queryParams.push(`$top=${params.top}`);

        const path = `builds${queryParams.length > 0 ? '?' + queryParams.join('&') : ''}`;
        const response = await client.buildRequest('GET', path);

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to list builds: ${JSON.stringify(response.data)}`);
        }

        const data = response.data as { value: AzureDevOpsBuild[]; count: number };
        return createJsonResult({
            builds: data.value,
            count: data.count || data.value?.length || 0,
        });
    })
    .readOnly()
    .build();

const adoBuildsGetTool = adoCommonParams(defineTool())
    .name('ado_builds_get')
    .title('Get Build')
    .description('Get details of a specific build')
    .openWorld()
    .category('cicd')
    .numberParam('buildId', 'ID of the build', { required: true })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Getting build ${params.buildId}`);

        const response = await client.buildRequest('GET', `builds/${params.buildId}`);

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to get build: ${JSON.stringify(response.data)}`);
        }

        return createJsonResult(response.data);
    })
    .readOnly()
    .build();

const adoBuildsQueueTool = adoCommonParams(defineTool())
    .name('ado_builds_queue')
    .title('Queue Build')
    .description('Queue a new build')
    .openWorld()
    .category('cicd')
    .numberParam('definitionId', 'Build definition ID', { required: true })
    .stringParam('sourceBranch', 'Source branch (e.g., refs/heads/main)')
    .stringParam('sourceVersion', 'Specific commit SHA to build')
    .objectParam('parameters', 'Build parameters as key-value pairs')
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Queueing build for definition ${params.definitionId}`);

        const body: Record<string, unknown> = {
            definition: { id: params.definitionId },
        };

        if (params.sourceBranch) body.sourceBranch = params.sourceBranch;
        if (params.sourceVersion) body.sourceVersion = params.sourceVersion;
        if (params.parameters) body.parameters = JSON.stringify(params.parameters);

        const response = await client.buildRequest('POST', 'builds', body);

        if (response.statusCode !== 200 && response.statusCode !== 201) {
            return createErrorResult(`Failed to queue build: ${JSON.stringify(response.data)}`);
        }

        return createJsonResult({
            status: 'build_queued',
            build: response.data,
        });
    })
    .build();

const adoBuildsCancelTool = adoCommonParams(defineTool())
    .name('ado_builds_cancel')
    .title('Cancel Build')
    .description('Cancel a running build')
    .openWorld()
    .category('cicd')
    .numberParam('buildId', 'ID of the build to cancel', { required: true })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Cancelling build ${params.buildId}`);

        const response = await client.buildRequest('PATCH', `builds/${params.buildId}`, {
            status: 'cancelling',
        });

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to cancel build: ${JSON.stringify(response.data)}`);
        }

        return createJsonResult({
            status: 'build_cancelled',
            build: response.data,
        });
    })
    .destructive()
    .build();

const adoBuildsGetLogsTool = adoCommonParams(defineTool())
    .name('ado_builds_get_logs')
    .title('Get Build Logs')
    .description('Get build logs')
    .openWorld()
    .category('cicd')
    .numberParam('buildId', 'ID of the build', { required: true })
    .numberParam('logId', 'Specific log ID to retrieve (optional, returns all log IDs if not specified)')
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Getting logs for build ${params.buildId}`);

        const path = params.logId
            ? `builds/${params.buildId}/logs/${params.logId}`
            : `builds/${params.buildId}/logs`;

        const response = await client.buildRequest('GET', path);

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to get build logs: ${JSON.stringify(response.data)}`);
        }

        return createJsonResult(response.data);
    })
    .readOnly()
    .build();

// ============================================================================
// Test Run Tools
// ============================================================================

const adoTestRunsListTool = adoCommonParams(defineTool())
    .name('ado_test_runs_list')
    .title('List Test Runs')
    .description('List test runs in the Azure DevOps project')
    .openWorld()
    .category('cicd')
    .numberParam('buildId', 'Filter by build ID')
    .stringParam('state', 'Filter by test run state', {
        enum: ['Unspecified', 'NotStarted', 'InProgress', 'Completed', 'Waiting', 'Aborted', 'NeedsInvestigation'],
    })
    .numberParam('top', 'Maximum number of test runs to return', { default: 20 })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', 'Listing test runs');

        const queryParams: string[] = [];
        if (params.buildId) queryParams.push(`buildUri=vstfs:///Build/Build/${params.buildId}`);
        if (params.state) queryParams.push(`state=${params.state}`);
        if (params.top) queryParams.push(`$top=${params.top}`);

        const path = `runs${queryParams.length > 0 ? '?' + queryParams.join('&') : ''}`;
        const response = await client.testRequest('GET', path);

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to list test runs: ${JSON.stringify(response.data)}`);
        }

        const data = response.data as { value: AzureDevOpsTestRun[]; count: number };
        return createJsonResult({
            testRuns: data.value,
            count: data.count || data.value?.length || 0,
        });
    })
    .readOnly()
    .build();

const adoTestRunsGetTool = adoCommonParams(defineTool())
    .name('ado_test_runs_get')
    .title('Get Test Run')
    .description('Get details of a specific test run')
    .openWorld()
    .category('cicd')
    .numberParam('runId', 'ID of the test run', { required: true })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Getting test run ${params.runId}`);

        const response = await client.testRequest('GET', `runs/${params.runId}`);

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to get test run: ${JSON.stringify(response.data)}`);
        }

        return createJsonResult(response.data);
    })
    .readOnly()
    .build();

const adoTestResultsListTool = adoCommonParams(defineTool())
    .name('ado_test_results_list')
    .title('List Test Results')
    .description('List test results for a test run')
    .openWorld()
    .category('cicd')
    .numberParam('runId', 'ID of the test run', { required: true })
    .stringParam('outcome', 'Filter by outcome', {
        enum: ['None', 'Passed', 'Failed', 'Inconclusive', 'Timeout', 'Aborted', 'Blocked', 'NotExecuted', 'Warning', 'Error'],
    })
    .numberParam('top', 'Maximum number of results to return', { default: 100 })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Getting test results for run ${params.runId}`);

        const queryParams: string[] = [];
        if (params.outcome) queryParams.push(`outcomes=${params.outcome}`);
        if (params.top) queryParams.push(`$top=${params.top}`);

        const path = `runs/${params.runId}/results${queryParams.length > 0 ? '?' + queryParams.join('&') : ''}`;
        const response = await client.testRequest('GET', path);

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to get test results: ${JSON.stringify(response.data)}`);
        }

        const data = response.data as { value: AzureDevOpsTestResult[]; count: number };
        return createJsonResult({
            testResults: data.value,
            count: data.count || data.value?.length || 0,
        });
    })
    .readOnly()
    .build();

const adoTestResultsGetFailedTool = adoCommonParams(defineTool())
    .name('ado_test_results_get_failed')
    .title('Get Failed Test Results')
    .description('Get failed test results with error details for a test run')
    .openWorld()
    .category('cicd')
    .numberParam('runId', 'ID of the test run', { required: true })
    .numberParam('top', 'Maximum number of failed tests to return', { default: 50 })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Getting failed test results for run ${params.runId}`);

        const path = `runs/${params.runId}/results?outcomes=Failed&$top=${params.top || 50}`;
        const response = await client.testRequest('GET', path);

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to get test results: ${JSON.stringify(response.data)}`);
        }

        const data = response.data as { value: AzureDevOpsTestResult[] };
        const failedTests = data.value?.map(result => ({
            id: result.id,
            testCaseTitle: result.testCaseTitle,
            outcome: result.outcome,
            errorMessage: result.errorMessage,
            stackTrace: result.stackTrace,
            durationInMs: result.durationInMs,
        })) || [];

        return createJsonResult({
            failedTests,
            count: failedTests.length,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Work Item Tools
// ============================================================================

const adoWorkItemsGetTool = adoCommonParams(defineTool())
    .name('ado_work_items_get')
    .title('Get Work Item')
    .description('Get a work item by ID, optionally expanded to include relations/fields/links')
    .openWorld()
    .category('cicd')
    .numberParam('id', 'Work item ID', { required: true, integer: true })
    .arrayParam('fields', 'Specific fields to retrieve (comma-joined). Mutually exclusive with $expand.', 'string')
    .stringParam('expand', 'Expand parameter for work item attributes', {
        enum: ['none', 'relations', 'fields', 'links', 'all'],
    })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Getting work item ${params.id}`);

        const queryParams: string[] = [];
        if (params.fields && Array.isArray(params.fields) && (params.fields as string[]).length > 0) {
            queryParams.push(`fields=${(params.fields as string[]).join(',')}`);
        } else if (params.expand) {
            queryParams.push(`$expand=${params.expand}`);
        }

        const path = `workitems/${params.id}${queryParams.length > 0 ? '?' + queryParams.join('&') : ''}`;
        const response = await client.witRequest('GET', path);

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to get work item: ${JSON.stringify(response.data)}`);
        }

        return createJsonResult(response.data);
    })
    .readOnly()
    .build();

const adoWorkItemsCreateTool = adoCommonParams(defineTool())
    .name('ado_work_items_create')
    .title('Create Work Item')
    .description('Create a new work item. Use `fields` to set arbitrary fields like Microsoft.VSTS.TCM.Steps for Test Case work items.')
    .openWorld()
    .category('cicd')
    .stringParam('type', 'Work item type (e.g., Bug, Task, User Story, Test Case)', { required: true })
    .stringParam('title', 'Work item title', { required: true })
    .stringParam('description', 'Work item description')
    .stringParam('assignedTo', 'User to assign the work item to')
    .stringParam('state', 'Initial state')
    .stringParam('areaPath', 'Area path')
    .stringParam('iterationPath', 'Iteration path')
    .arrayParam('tags', 'Tags to add', 'string')
    .objectParam('fields', 'Arbitrary fields map (key = field reference name e.g. "Microsoft.VSTS.TCM.Steps", value = string). Wins over the convenience params on conflict.')
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Creating work item of type ${params.type}`);

        const operations: Array<{ op: string; path: string; value: unknown }> = [
            { op: 'add', path: '/fields/System.Title', value: params.title },
        ];

        if (params.description) {
            operations.push({ op: 'add', path: '/fields/System.Description', value: params.description });
        }
        if (params.assignedTo) {
            operations.push({ op: 'add', path: '/fields/System.AssignedTo', value: params.assignedTo });
        }
        if (params.state) {
            operations.push({ op: 'add', path: '/fields/System.State', value: params.state });
        }
        if (params.areaPath) {
            operations.push({ op: 'add', path: '/fields/System.AreaPath', value: params.areaPath });
        }
        if (params.iterationPath) {
            operations.push({ op: 'add', path: '/fields/System.IterationPath', value: params.iterationPath });
        }
        if (params.tags && Array.isArray(params.tags)) {
            operations.push({ op: 'add', path: '/fields/System.Tags', value: (params.tags as string[]).join('; ') });
        }
        if (params.fields && typeof params.fields === 'object') {
            for (const [key, value] of Object.entries(params.fields as Record<string, unknown>)) {
                operations.push({ op: 'add', path: `/fields/${key}`, value });
            }
        }

        const response = await client.witRequest(
            'POST',
            `workitems/$${encodeURIComponent(params.type as string)}`,
            operations,
            'application/json-patch+json'
        );

        if (response.statusCode !== 200 && response.statusCode !== 201) {
            return createErrorResult(`Failed to create work item: ${JSON.stringify(response.data)}`);
        }

        return createJsonResult({
            status: 'work_item_created',
            workItem: response.data,
        });
    })
    .build();

const adoWorkItemsUpdateTool = adoCommonParams(defineTool())
    .name('ado_work_items_update')
    .title('Update Work Item')
    .description('Update an existing work item. Use `fields` to replace arbitrary fields like Microsoft.VSTS.TCM.Steps.')
    .openWorld()
    .category('cicd')
    .numberParam('id', 'Work item ID', { required: true, integer: true })
    .stringParam('title', 'New title')
    .stringParam('description', 'New description')
    .stringParam('assignedTo', 'User to assign to')
    .stringParam('state', 'New state')
    .stringParam('comment', 'Comment to add (appended to System.History)')
    .objectParam('fields', 'Arbitrary fields map (key = field reference name, value = new value). Wins over the convenience params on conflict.')
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Updating work item ${params.id}`);

        const operations: Array<{ op: string; path: string; value: unknown }> = [];

        if (params.title) {
            operations.push({ op: 'replace', path: '/fields/System.Title', value: params.title });
        }
        if (params.description) {
            operations.push({ op: 'replace', path: '/fields/System.Description', value: params.description });
        }
        if (params.assignedTo) {
            operations.push({ op: 'replace', path: '/fields/System.AssignedTo', value: params.assignedTo });
        }
        if (params.state) {
            operations.push({ op: 'replace', path: '/fields/System.State', value: params.state });
        }
        if (params.comment) {
            operations.push({ op: 'add', path: '/fields/System.History', value: params.comment });
        }
        if (params.fields && typeof params.fields === 'object') {
            for (const [key, value] of Object.entries(params.fields as Record<string, unknown>)) {
                operations.push({ op: 'replace', path: `/fields/${key}`, value });
            }
        }

        if (operations.length === 0) {
            return createErrorResult('No updates specified');
        }

        const response = await client.witRequest(
            'PATCH',
            `workitems/${params.id}`,
            operations,
            'application/json-patch+json'
        );

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to update work item: ${JSON.stringify(response.data)}`);
        }

        return createJsonResult({
            status: 'work_item_updated',
            workItem: response.data,
        });
    })
    .build();

const adoWorkItemsQueryTool = adoCommonParams(defineTool())
    .name('ado_work_items_query')
    .title('Query Work Items (WIQL)')
    .description('Query work items using WIQL. Note: many enterprise ADO tenants restrict WIQL execution; prefer ado_work_items_get_batch when navigating from a known suite or set of IDs.')
    .openWorld()
    .category('cicd')
    .stringParam('wiql', 'WIQL query string', { required: true })
    .numberParam('top', 'Maximum number of results', { default: 200 })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', 'Querying work items');

        const response = await client.witRequest('POST', 'wiql', {
            query: params.wiql,
            $top: params.top || 200,
        });

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to query work items: ${JSON.stringify(response.data)}`);
        }

        return createJsonResult(response.data);
    })
    .readOnly()
    .build();

/**
 * Batch fetch up to 200 work items by ID. WIQL-free alternative used by
 * Mode A: list a suite's test case refs, then batch-fetch the work items in
 * a single round-trip with `$expand=fields` to surface
 * `Microsoft.VSTS.TCM.Steps`.
 */
const adoWorkItemsGetBatchTool = adoCommonParams(defineTool())
    .name('ado_work_items_get_batch')
    .title('Get Work Items (Batch)')
    .description('Fetch up to 200 work items by ID in a single call. WIQL-free; use this when you already have IDs (e.g. from ado_test_suite_test_cases_list).')
    .openWorld()
    .category('cicd')
    .arrayParam('ids', 'Work item IDs to fetch (max 200 per call)', 'number', { required: true })
    .arrayParam('fields', 'Specific fields to retrieve. Omit when using `expand`.', 'string')
    .stringParam('expand', 'Expand parameter for work item attributes', {
        enum: ['none', 'relations', 'fields', 'links', 'all'],
    })
    .stringParam('errorPolicy', 'How to handle individual ID failures', {
        enum: ['fail', 'omit'],
        default: 'omit',
    })
    .handler(async (params, context) => {
        const client = getClient(params);
        const ids = (params.ids as number[]) || [];
        if (ids.length === 0) {
            return createErrorResult('ids must contain at least one work item ID');
        }
        if (ids.length > 200) {
            return createErrorResult(`Azure DevOps batch endpoint accepts up to 200 IDs per call; got ${ids.length}`);
        }
        context.log('info', `Batch-fetching ${ids.length} work item(s)`);

        const body: Record<string, unknown> = { ids };
        if (params.fields && Array.isArray(params.fields) && (params.fields as string[]).length > 0) {
            body.fields = params.fields;
        } else if (params.expand) {
            body.$expand = params.expand;
        }
        if (params.errorPolicy) {
            body.errorPolicy = params.errorPolicy;
        }

        const response = await client.witRequest('POST', 'workitemsbatch', body);

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to batch-fetch work items: ${JSON.stringify(response.data)}`);
        }

        const data = response.data as { value: unknown[]; count: number };
        return createJsonResult({
            workItems: data.value,
            count: data.count || data.value?.length || 0,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Pull Request Tools
// ============================================================================

const adoPullRequestsListTool = adoCommonParams(defineTool())
    .name('ado_pull_requests_list')
    .title('List Pull Requests')
    .description('List pull requests in a repository')
    .openWorld()
    .category('cicd')
    .stringParam('repositoryId', 'Repository ID or name', { required: true })
    .stringParam('status', 'Filter by PR status', {
        enum: ['active', 'abandoned', 'completed', 'all'],
        default: 'active',
    })
    .stringParam('targetRefName', 'Filter by target branch (e.g., refs/heads/main)')
    .stringParam('creatorId', 'Filter by creator ID')
    .numberParam('top', 'Maximum number of PRs to return', { default: 20 })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Listing pull requests for repository ${params.repositoryId}`);

        const queryParams: string[] = [];
        if (params.status) queryParams.push(`searchCriteria.status=${params.status}`);
        if (params.targetRefName) queryParams.push(`searchCriteria.targetRefName=${encodeURIComponent(params.targetRefName as string)}`);
        if (params.creatorId) queryParams.push(`searchCriteria.creatorId=${params.creatorId}`);
        if (params.top) queryParams.push(`$top=${params.top}`);

        const path = `repositories/${params.repositoryId}/pullrequests${queryParams.length > 0 ? '?' + queryParams.join('&') : ''}`;
        const response = await client.gitRequest('GET', path);

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to list pull requests: ${JSON.stringify(response.data)}`);
        }

        const data = response.data as { value: AzureDevOpsPullRequest[]; count: number };
        return createJsonResult({
            pullRequests: data.value,
            count: data.count || data.value?.length || 0,
        });
    })
    .readOnly()
    .build();

const adoPullRequestsGetTool = adoCommonParams(defineTool())
    .name('ado_pull_requests_get')
    .title('Get Pull Request')
    .description('Get details of a specific pull request')
    .openWorld()
    .category('cicd')
    .stringParam('repositoryId', 'Repository ID or name', { required: true })
    .numberParam('pullRequestId', 'Pull request ID', { required: true })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Getting pull request ${params.pullRequestId}`);

        const response = await client.gitRequest('GET', `repositories/${params.repositoryId}/pullrequests/${params.pullRequestId}`);

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to get pull request: ${JSON.stringify(response.data)}`);
        }

        return createJsonResult(response.data);
    })
    .readOnly()
    .build();

const adoPullRequestsCreateTool = adoCommonParams(defineTool())
    .name('ado_pull_requests_create')
    .title('Create Azure DevOps Pull Request')
    .description('Create a new pull request')
    .openWorld()
    .category('cicd')
    .stringParam('repositoryId', 'Repository ID or name', { required: true })
    .stringParam('sourceRefName', 'Source branch (e.g., refs/heads/feature-branch)', { required: true })
    .stringParam('targetRefName', 'Target branch (e.g., refs/heads/main)', { required: true })
    .stringParam('title', 'Pull request title', { required: true })
    .stringParam('description', 'Pull request description')
    .booleanParam('isDraft', 'Create as draft PR', { default: false })
    .arrayParam('reviewers', 'Reviewer IDs', 'string')
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', 'Creating pull request');

        const body: Record<string, unknown> = {
            sourceRefName: params.sourceRefName,
            targetRefName: params.targetRefName,
            title: params.title,
            description: params.description || '',
            isDraft: params.isDraft === true,
        };

        if (params.reviewers && Array.isArray(params.reviewers)) {
            body.reviewers = (params.reviewers as string[]).map(id => ({ id }));
        }

        const response = await client.gitRequest('POST', `repositories/${params.repositoryId}/pullrequests`, body);

        if (response.statusCode !== 200 && response.statusCode !== 201) {
            return createErrorResult(`Failed to create pull request: ${JSON.stringify(response.data)}`);
        }

        return createJsonResult({
            status: 'pull_request_created',
            pullRequest: response.data,
        });
    })
    .build();

const adoPullRequestsCommentTool = adoCommonParams(defineTool())
    .name('ado_pull_requests_comment')
    .title('Comment On Pull Request')
    .description('Add a comment to a pull request')
    .openWorld()
    .category('cicd')
    .stringParam('repositoryId', 'Repository ID or name', { required: true })
    .numberParam('pullRequestId', 'Pull request ID', { required: true })
    .stringParam('content', 'Comment content (supports markdown)', { required: true })
    .stringParam('filePath', 'File path for inline comment')
    .numberParam('lineNumber', 'Line number for inline comment')
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Adding comment to PR ${params.pullRequestId}`);

        const body: Record<string, unknown> = {
            comments: [{
                parentCommentId: 0,
                content: params.content,
                commentType: 1, // Text
            }],
            status: 1, // Active
        };

        if (params.filePath) {
            (body as Record<string, unknown>).threadContext = {
                filePath: params.filePath,
                rightFileStart: params.lineNumber ? { line: params.lineNumber, offset: 1 } : undefined,
                rightFileEnd: params.lineNumber ? { line: params.lineNumber, offset: 1 } : undefined,
            };
        }

        const response = await client.gitRequest('POST', `repositories/${params.repositoryId}/pullrequests/${params.pullRequestId}/threads`, body);

        if (response.statusCode !== 200 && response.statusCode !== 201) {
            return createErrorResult(`Failed to add comment: ${JSON.stringify(response.data)}`);
        }

        return createJsonResult({
            status: 'comment_added',
            thread: response.data,
        });
    })
    .build();

// ============================================================================
// Test Plan / Suite / Suite-Case Tools
// ============================================================================

const adoTestPlansListTool = adoCommonParams(defineTool())
    .name('ado_test_plans_list')
    .title('List Test Plans')
    .description('List Azure DevOps test plans for the configured project')
    .openWorld()
    .category('cicd')
    .stringParam('owner', 'Filter by plan owner (display name or descriptor)')
    .booleanParam('includePlanDetails', 'Include detailed plan metadata in the response', { default: false })
    .booleanParam('filterActivePlans', 'Return only active plans', { default: true })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', 'Listing test plans');

        const queryParams: string[] = [];
        if (params.owner) queryParams.push(`owner=${encodeURIComponent(params.owner as string)}`);
        if (params.includePlanDetails === true) queryParams.push('includePlanDetails=true');
        if (params.filterActivePlans === false) queryParams.push('filterActivePlans=false');

        const path = `plans${queryParams.length > 0 ? '?' + queryParams.join('&') : ''}`;
        const response = await client.testPlanRequest('GET', path);

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to list test plans: ${JSON.stringify(response.data)}`);
        }

        const data = response.data as { value: unknown[]; count: number };
        return createJsonResult({
            plans: data.value,
            count: data.count || data.value?.length || 0,
        });
    })
    .readOnly()
    .build();

const adoTestSuitesListTool = adoCommonParams(defineTool())
    .name('ado_test_suites_list')
    .title('List Test Suites')
    .description('List test suites under a given test plan')
    .openWorld()
    .category('cicd')
    .numberParam('planId', 'Test plan ID', { required: true, integer: true })
    .stringParam('expand', 'Expand options', { enum: ['none', 'children', 'defaultTesters'] })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Listing test suites for plan ${params.planId}`);

        const queryParams: string[] = [];
        if (params.expand) queryParams.push(`expand=${params.expand}`);

        const path = `Plans/${params.planId}/suites${queryParams.length > 0 ? '?' + queryParams.join('&') : ''}`;
        const response = await client.testPlanRequest('GET', path);

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to list test suites: ${JSON.stringify(response.data)}`);
        }

        const data = response.data as { value: unknown[]; count: number };
        return createJsonResult({
            suites: data.value,
            count: data.count || data.value?.length || 0,
        });
    })
    .readOnly()
    .build();

const adoTestSuiteTestCasesListTool = adoCommonParams(defineTool())
    .name('ado_test_suite_test_cases_list')
    .title('List Test Suite Test Cases')
    .description('List test cases in a given test suite')
    .openWorld()
    .category('cicd')
    .numberParam('planId', 'Test plan ID', { required: true, integer: true })
    .numberParam('suiteId', 'Test suite ID', { required: true, integer: true })
    .stringParam('expand', 'Expand options for the work item references')
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Listing test cases for suite ${params.suiteId}`);

        const queryParams: string[] = [];
        if (params.expand) queryParams.push(`expand=${params.expand}`);

        const path = `Plans/${params.planId}/Suites/${params.suiteId}/TestCase${queryParams.length > 0 ? '?' + queryParams.join('&') : ''}`;
        const response = await client.testPlanRequest('GET', path);

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to list test cases: ${JSON.stringify(response.data)}`);
        }

        const data = response.data as { value: unknown[]; count: number };
        return createJsonResult({
            testCases: data.value,
            count: data.count || data.value?.length || 0,
        });
    })
    .readOnly()
    .build();

const adoTestSuiteAddTestCasesTool = adoCommonParams(defineTool())
    .name('ado_test_suite_add_test_cases')
    .title('Add Test Cases to Suite')
    .description('Add one or more existing test cases (work items) to a test suite. Only static and requirement-based suites accept manual additions.')
    .openWorld()
    .category('cicd')
    .numberParam('planId', 'Test plan ID', { required: true, integer: true })
    .numberParam('suiteId', 'Test suite ID', { required: true, integer: true })
    .arrayParam('testCaseIds', 'Test case work item IDs to add', 'number', { required: true })
    .handler(async (params, context) => {
        const client = getClient(params);
        const ids = (params.testCaseIds as number[]) || [];
        if (ids.length === 0) {
            return createErrorResult('testCaseIds must contain at least one work item ID');
        }
        context.log('info', `Adding ${ids.length} test case(s) to suite ${params.suiteId}`);

        // SuiteTestCaseCreateUpdateParameters[] — { workItem: { id } } per case.
        const body = ids.map((id) => ({ workItem: { id } }));
        const path = `Plans/${params.planId}/Suites/${params.suiteId}/TestCase`;
        const response = await client.testPlanRequest('POST', path, body);

        if (response.statusCode !== 200 && response.statusCode !== 201) {
            return createErrorResult(`Failed to add test cases to suite: ${JSON.stringify(response.data)}`);
        }

        return createJsonResult({
            status: 'test_cases_added',
            planId: params.planId,
            suiteId: params.suiteId,
            testCaseIds: ids,
            data: response.data,
        });
    })
    .build();

// ============================================================================
// Repository Tools
// ============================================================================

const adoRepositoriesListTool = adoCommonParams(defineTool())
    .name('ado_repositories_list')
    .title('List Repositories')
    .description('List Git repositories in the project')
    .openWorld()
    .category('cicd')
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', 'Listing repositories');

        const response = await client.gitRequest('GET', 'repositories');

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to list repositories: ${JSON.stringify(response.data)}`);
        }

        const data = response.data as { value: unknown[]; count: number };
        return createJsonResult({
            repositories: data.value,
            count: data.count || data.value?.length || 0,
        });
    })
    .readOnly()
    .build();

const adoBranchesListTool = adoCommonParams(defineTool())
    .name('ado_branches_list')
    .title('List Branches')
    .description('List branches in a repository')
    .openWorld()
    .category('cicd')
    .stringParam('repositoryId', 'Repository ID or name', { required: true })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Listing branches for repository ${params.repositoryId}`);

        const response = await client.gitRequest('GET', `repositories/${params.repositoryId}/refs?filter=heads/`);

        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to list branches: ${JSON.stringify(response.data)}`);
        }

        const data = response.data as { value: unknown[]; count: number };
        return createJsonResult({
            branches: data.value,
            count: data.count || data.value?.length || 0,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Repo content + deep work-item analysis (parity with the official MS ADO MCP
// server's repo file read + work-item comments/revisions — used by the
// source-code, defect, and deep-analysis modes).
// ============================================================================

const adoRepoGetFileContentTool = adoCommonParams(defineTool())
    .name('ado_repo_get_file_content')
    .title('Get Repo File Content')
    .description('Get the content of a file in an Azure DevOps Git repository at a given path/branch.')
    .openWorld()
    .category('cicd')
    .stringParam('repositoryId', 'Repository ID or name', { required: true })
    .stringParam('filePath', 'Path to the file (e.g. /src/app/login.component.ts)', { required: true })
    .stringParam('branch', 'Branch name (defaults to the default branch)')
    .handler(async (params, context) => {
        const client = getClient(params);
        const p = encodeURIComponent(String(params.filePath));
        let route = `repositories/${params.repositoryId}/items?path=${p}&includeContent=true`;
        if (params.branch) route += `&versionDescriptor.version=${encodeURIComponent(String(params.branch))}&versionDescriptor.versionType=branch`;
        context.log('info', `Getting file content ${params.filePath}`);
        const response = await client.gitRequest('GET', route);
        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to get file content: ${JSON.stringify(response.data)}`);
        }
        const data = response.data as { content?: string; [k: string]: unknown };
        return createJsonResult({ path: params.filePath, content: data.content ?? data });
    })
    .readOnly()
    .build();

const adoRepoListDirectoryTool = adoCommonParams(defineTool())
    .name('ado_repo_list_directory')
    .title('List Repo Directory')
    .description('List files and folders under a path in an Azure DevOps Git repository (one level or recursive).')
    .openWorld()
    .category('cicd')
    .stringParam('repositoryId', 'Repository ID or name', { required: true })
    .stringParam('scopePath', 'Directory path to list (e.g. /src). Defaults to repo root.')
    .stringParam('recursionLevel', 'none | oneLevel | full', { enum: ['none', 'oneLevel', 'full'], default: 'oneLevel' })
    .stringParam('branch', 'Branch name (defaults to the default branch)')
    .handler(async (params, context) => {
        const client = getClient(params);
        const scope = encodeURIComponent(String(params.scopePath || '/'));
        const rec = String(params.recursionLevel || 'oneLevel');
        let route = `repositories/${params.repositoryId}/items?scopePath=${scope}&recursionLevel=${rec}`;
        if (params.branch) route += `&versionDescriptor.version=${encodeURIComponent(String(params.branch))}&versionDescriptor.versionType=branch`;
        context.log('info', `Listing repo directory ${params.scopePath || '/'}`);
        const response = await client.gitRequest('GET', route);
        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to list directory: ${JSON.stringify(response.data)}`);
        }
        const data = response.data as { value?: Array<{ path: string; isFolder?: boolean; gitObjectType?: string }>; count?: number };
        const items = (data.value ?? []).map((i) => ({ path: i.path, isFolder: i.isFolder || i.gitObjectType === 'tree' }));
        return createJsonResult({ items, count: items.length });
    })
    .readOnly()
    .build();

const adoWitListCommentsTool = adoCommonParams(defineTool())
    .name('ado_work_item_comments_list')
    .title('List Work Item Comments')
    .description('List all comments on a work item (story/bug) — often carries requirements/repro detail beyond the description.')
    .openWorld()
    .category('cicd')
    .numberParam('id', 'Work item ID', { required: true, integer: true })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Listing comments for work item ${params.id}`);
        const response = await client.witRequest('GET', `workItems/${params.id}/comments`);
        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to list comments: ${JSON.stringify(response.data)}`);
        }
        const data = response.data as { comments?: Array<{ text?: string; createdBy?: { displayName?: string } }>; count?: number };
        return createJsonResult({
            comments: (data.comments ?? []).map((c) => ({ by: c.createdBy?.displayName, text: c.text })),
            count: data.count ?? (data.comments?.length ?? 0),
        });
    })
    .readOnly()
    .build();

const adoWitListRevisionsTool = adoCommonParams(defineTool())
    .name('ado_work_item_revisions_list')
    .title('List Work Item Revisions')
    .description('List the revision history of a work item — useful to see how requirements/repro evolved.')
    .openWorld()
    .category('cicd')
    .numberParam('id', 'Work item ID', { required: true, integer: true })
    .numberParam('top', 'Max revisions to return', { integer: true, default: 20 })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Listing revisions for work item ${params.id}`);
        const response = await client.witRequest('GET', `workItems/${params.id}/revisions?$top=${params.top || 20}`);
        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to list revisions: ${JSON.stringify(response.data)}`);
        }
        const data = response.data as { value?: unknown[]; count?: number };
        return createJsonResult({ revisions: data.value ?? [], count: data.count ?? (data.value?.length ?? 0) });
    })
    .readOnly()
    .build();

// ============================================================================
// PR diff / changes, commits, search, wiki, core — full parity with the
// official MS ADO MCP server. These power the PR-impact regression mode
// (map a PR's changed files → the tests that cover them).
// ============================================================================

const adoPullRequestIterationsListTool = adoCommonParams(defineTool())
    .name('ado_pull_request_iterations_list')
    .title('List Pull Request Iterations')
    .description('List the iterations (pushes) of a pull request. The latest iteration id is used to fetch the full changed-file set.')
    .openWorld()
    .category('cicd')
    .stringParam('repositoryId', 'Repository ID or name', { required: true })
    .numberParam('pullRequestId', 'Pull request ID', { required: true, integer: true })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Listing iterations for PR ${params.pullRequestId}`);
        const response = await client.gitRequest('GET', `repositories/${params.repositoryId}/pullRequests/${params.pullRequestId}/iterations`);
        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to list PR iterations: ${JSON.stringify(response.data)}`);
        }
        const data = response.data as { value?: Array<{ id: number; createdDate?: string; description?: string }>; count?: number };
        const iterations = (data.value ?? []).map((i) => ({ id: i.id, createdDate: i.createdDate, description: i.description }));
        return createJsonResult({ iterations, count: iterations.length, latestIterationId: iterations.length ? iterations[iterations.length - 1].id : null });
    })
    .readOnly()
    .build();

const adoPullRequestGetChangesTool = adoCommonParams(defineTool())
    .name('ado_pull_request_get_changes')
    .title('Get Pull Request Changed Files')
    .description('Get the changed files (adds/edits/deletes) of a pull request. This is the primary input to regression-candidate analysis: it tells you exactly which source paths a PR touches so you can map them to existing tests.')
    .openWorld()
    .category('cicd')
    .stringParam('repositoryId', 'Repository ID or name', { required: true })
    .numberParam('pullRequestId', 'Pull request ID', { required: true, integer: true })
    .numberParam('iterationId', 'Iteration id to diff (defaults to the latest iteration)', { integer: true })
    .handler(async (params, context) => {
        const client = getClient(params);
        let iterationId = params.iterationId as number | undefined;
        if (!iterationId) {
            const iters = await client.gitRequest('GET', `repositories/${params.repositoryId}/pullRequests/${params.pullRequestId}/iterations`);
            if (iters.statusCode !== 200) {
                return createErrorResult(`Failed to resolve latest iteration: ${JSON.stringify(iters.data)}`);
            }
            const iv = (iters.data as { value?: Array<{ id: number }> }).value ?? [];
            if (!iv.length) return createErrorResult('Pull request has no iterations (no changes).');
            iterationId = iv[iv.length - 1].id;
        }
        context.log('info', `Getting changes for PR ${params.pullRequestId} iteration ${iterationId}`);
        const response = await client.gitRequest('GET', `repositories/${params.repositoryId}/pullRequests/${params.pullRequestId}/iterations/${iterationId}/changes`);
        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to get PR changes: ${JSON.stringify(response.data)}`);
        }
        const data = response.data as { changeEntries?: Array<{ item?: { path?: string; isFolder?: boolean }; changeType?: string }> };
        const changes = (data.changeEntries ?? [])
            .filter((c) => c.item && !c.item.isFolder && c.item.path)
            .map((c) => ({ path: c.item!.path, changeType: c.changeType }));
        return createJsonResult({ iterationId, changes, changedPaths: changes.map((c) => c.path), count: changes.length });
    })
    .readOnly()
    .build();

const adoPullRequestThreadsListTool = adoCommonParams(defineTool())
    .name('ado_pull_request_threads_list')
    .title('List Pull Request Threads')
    .description('List the review comment threads on a pull request (reviewer feedback, file-anchored discussion). Used by pr_review and regression analysis.')
    .openWorld()
    .category('cicd')
    .stringParam('repositoryId', 'Repository ID or name', { required: true })
    .numberParam('pullRequestId', 'Pull request ID', { required: true, integer: true })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Listing threads for PR ${params.pullRequestId}`);
        const response = await client.gitRequest('GET', `repositories/${params.repositoryId}/pullRequests/${params.pullRequestId}/threads`);
        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to list PR threads: ${JSON.stringify(response.data)}`);
        }
        const data = response.data as { value?: Array<{ id: number; status?: string; threadContext?: { filePath?: string }; comments?: Array<{ author?: { displayName?: string }; content?: string }> }> };
        const threads = (data.value ?? []).map((t) => ({
            id: t.id,
            status: t.status,
            filePath: t.threadContext?.filePath,
            comments: (t.comments ?? []).map((c) => ({ by: c.author?.displayName, text: c.content })),
        }));
        return createJsonResult({ threads, count: threads.length });
    })
    .readOnly()
    .build();

const adoCommitsListTool = adoCommonParams(defineTool())
    .name('ado_commits_list')
    .title('List Repository Commits')
    .description('List commits in a repository (optionally on a branch). Used to drive regression analysis from a commit range rather than a PR.')
    .openWorld()
    .category('cicd')
    .stringParam('repositoryId', 'Repository ID or name', { required: true })
    .stringParam('branch', 'Branch name to list commits from (defaults to the default branch)')
    .numberParam('top', 'Max commits to return', { integer: true, default: 20 })
    .handler(async (params, context) => {
        const client = getClient(params);
        let route = `repositories/${params.repositoryId}/commits?$top=${params.top || 20}`;
        if (params.branch) route += `&searchCriteria.itemVersion.version=${encodeURIComponent(String(params.branch))}`;
        context.log('info', `Listing commits for ${params.repositoryId}`);
        const response = await client.gitRequest('GET', route);
        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to list commits: ${JSON.stringify(response.data)}`);
        }
        const data = response.data as { value?: Array<{ commitId: string; comment?: string; author?: { name?: string; date?: string } }>; count?: number };
        const commits = (data.value ?? []).map((c) => ({ commitId: c.commitId, comment: c.comment, author: c.author?.name, date: c.author?.date }));
        return createJsonResult({ commits, count: commits.length });
    })
    .readOnly()
    .build();

const adoCommitChangesTool = adoCommonParams(defineTool())
    .name('ado_commit_changes')
    .title('Get Commit Changed Files')
    .description('Get the changed files of a single commit — the commit-level equivalent of ado_pull_request_get_changes for regression analysis.')
    .openWorld()
    .category('cicd')
    .stringParam('repositoryId', 'Repository ID or name', { required: true })
    .stringParam('commitId', 'Commit SHA', { required: true })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Getting changes for commit ${params.commitId}`);
        const response = await client.gitRequest('GET', `repositories/${params.repositoryId}/commits/${params.commitId}/changes`);
        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to get commit changes: ${JSON.stringify(response.data)}`);
        }
        const data = response.data as { changes?: Array<{ item?: { path?: string; isFolder?: boolean }; changeType?: string }> };
        const changes = (data.changes ?? [])
            .filter((c) => c.item && !c.item.isFolder && c.item.path)
            .map((c) => ({ path: c.item!.path, changeType: c.changeType }));
        return createJsonResult({ changes, changedPaths: changes.map((c) => c.path), count: changes.length });
    })
    .readOnly()
    .build();

const adoSearchCodeTool = adoCommonParams(defineTool())
    .name('ado_search_code')
    .title('Search Code')
    .description('Search source code across the project (Azure DevOps code search). Used to find which existing test files reference a changed source path/symbol.')
    .openWorld()
    .category('cicd')
    .stringParam('searchText', 'Text/symbol to search for (e.g. a changed file name or class)', { required: true })
    .numberParam('top', 'Max results', { integer: true, default: 25 })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Code search: ${params.searchText}`);
        const body = {
            searchText: params.searchText,
            $top: params.top || 25,
            filters: { Project: [client.getProject()] },
        };
        const response = await client.searchRequest('codesearchresults', body);
        if (response.statusCode !== 200) {
            return createErrorResult(`Code search failed: ${JSON.stringify(response.data)}`);
        }
        const data = response.data as { results?: Array<{ fileName?: string; path?: string; repository?: { name?: string }; matches?: unknown }>; count?: number };
        const results = (data.results ?? []).map((r) => ({ fileName: r.fileName, path: r.path, repository: r.repository?.name }));
        return createJsonResult({ results, count: data.count ?? results.length });
    })
    .readOnly()
    .build();

const adoSearchWorkItemsTool = adoCommonParams(defineTool())
    .name('ado_search_work_items')
    .title('Search Work Items')
    .description('Full-text search across work items (stories, bugs, tasks). Used to find related requirements/defects for a change.')
    .openWorld()
    .category('cicd')
    .stringParam('searchText', 'Text to search for', { required: true })
    .numberParam('top', 'Max results', { integer: true, default: 25 })
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Work item search: ${params.searchText}`);
        const body = {
            searchText: params.searchText,
            $top: params.top || 25,
            filters: { 'System.TeamProject': [client.getProject()] },
        };
        const response = await client.searchRequest('workitemsearchresults', body);
        if (response.statusCode !== 200) {
            return createErrorResult(`Work item search failed: ${JSON.stringify(response.data)}`);
        }
        const data = response.data as { results?: Array<{ fields?: Record<string, unknown> }>; count?: number };
        const results = (data.results ?? []).map((r) => ({
            id: r.fields?.['system.id'],
            title: r.fields?.['system.title'],
            type: r.fields?.['system.workitemtype'],
            state: r.fields?.['system.state'],
        }));
        return createJsonResult({ results, count: data.count ?? results.length });
    })
    .readOnly()
    .build();

const adoWikiListTool = adoCommonParams(defineTool())
    .name('ado_wiki_list')
    .title('List Wikis')
    .description('List the wikis in the project (parity with the official ADO MCP server). Wikis often hold requirement/design docs.')
    .openWorld()
    .category('cicd')
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', 'Listing wikis');
        const response = await client.request('GET', 'wiki/wikis');
        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to list wikis: ${JSON.stringify(response.data)}`);
        }
        const data = response.data as { value?: Array<{ id: string; name: string; mappedPath?: string }>; count?: number };
        const wikis = (data.value ?? []).map((w) => ({ id: w.id, name: w.name, mappedPath: w.mappedPath }));
        return createJsonResult({ wikis, count: wikis.length });
    })
    .readOnly()
    .build();

const adoWikiPageGetTool = adoCommonParams(defineTool())
    .name('ado_wiki_page_get')
    .title('Get Wiki Page Content')
    .description('Get the content of a wiki page by path — used to read requirement/design docs stored in an ADO wiki.')
    .openWorld()
    .category('cicd')
    .stringParam('wikiId', 'Wiki id or name', { required: true })
    .stringParam('path', 'Page path (e.g. /Requirements/Login)', { required: true })
    .handler(async (params, context) => {
        const client = getClient(params);
        const p = encodeURIComponent(String(params.path));
        context.log('info', `Getting wiki page ${params.path}`);
        const response = await client.request('GET', `wiki/wikis/${params.wikiId}/pages?path=${p}&includeContent=true`);
        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to get wiki page: ${JSON.stringify(response.data)}`);
        }
        const data = response.data as { content?: string; path?: string };
        return createJsonResult({ path: data.path ?? params.path, content: data.content ?? '' });
    })
    .readOnly()
    .build();

const adoCoreProjectsListTool = adoCommonParams(defineTool())
    .name('ado_core_projects_list')
    .title('List Projects')
    .description('List the projects in the organization (core parity). Useful to discover the correct project name before other calls.')
    .openWorld()
    .category('cicd')
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', 'Listing projects');
        const response = await client.orgRequest('GET', 'projects');
        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to list projects: ${JSON.stringify(response.data)}`);
        }
        const data = response.data as { value?: Array<{ id: string; name: string; state?: string }>; count?: number };
        const projects = (data.value ?? []).map((p) => ({ id: p.id, name: p.name, state: p.state }));
        return createJsonResult({ projects, count: projects.length });
    })
    .readOnly()
    .build();

const adoCoreTeamsListTool = adoCommonParams(defineTool())
    .name('ado_core_teams_list')
    .title('List Project Teams')
    .description('List the teams in a project (core parity).')
    .openWorld()
    .category('cicd')
    .stringParam('projectId', 'Project id or name (defaults to the configured project)')
    .handler(async (params, context) => {
        const client = getClient(params);
        const projectId = String(params.projectId || client.getProject());
        context.log('info', `Listing teams for project ${projectId}`);
        const response = await client.orgRequest('GET', `projects/${encodeURIComponent(projectId)}/teams`);
        if (response.statusCode !== 200) {
            return createErrorResult(`Failed to list teams: ${JSON.stringify(response.data)}`);
        }
        const data = response.data as { value?: Array<{ id: string; name: string }>; count?: number };
        const teams = (data.value ?? []).map((t) => ({ id: t.id, name: t.name }));
        return createJsonResult({ teams, count: teams.length });
    })
    .readOnly()
    .build();

// ============================================================================
// Export all Azure DevOps tools
// ============================================================================

export const azureDevOpsTools: MCPToolDefinition[] = [
    adoRepoGetFileContentTool,
    adoRepoListDirectoryTool,
    adoWitListCommentsTool,
    adoWitListRevisionsTool,
    // Pipelines
    adoPipelinesListTool,
    adoPipelinesRunTool,
    adoPipelinesGetRunTool,

    // Builds
    adoBuildsListTool,
    adoBuildsGetTool,
    adoBuildsQueueTool,
    adoBuildsCancelTool,
    adoBuildsGetLogsTool,

    // Test Runs
    adoTestRunsListTool,
    adoTestRunsGetTool,
    adoTestResultsListTool,
    adoTestResultsGetFailedTool,

    // Work Items
    adoWorkItemsGetTool,
    adoWorkItemsGetBatchTool,
    adoWorkItemsCreateTool,
    adoWorkItemsUpdateTool,
    adoWorkItemsQueryTool,

    // Pull Requests
    adoPullRequestsListTool,
    adoPullRequestsGetTool,
    adoPullRequestsCreateTool,
    adoPullRequestsCommentTool,
    adoPullRequestIterationsListTool,
    adoPullRequestGetChangesTool,
    adoPullRequestThreadsListTool,

    // Commits (PR-impact / regression inputs)
    adoCommitsListTool,
    adoCommitChangesTool,

    // Search (code / work items)
    adoSearchCodeTool,
    adoSearchWorkItemsTool,

    // Wiki
    adoWikiListTool,
    adoWikiPageGetTool,

    // Core (projects / teams)
    adoCoreProjectsListTool,
    adoCoreTeamsListTool,

    // Test Plans / Suites / Suite-Cases
    adoTestPlansListTool,
    adoTestSuitesListTool,
    adoTestSuiteTestCasesListTool,
    adoTestSuiteAddTestCasesTool,

    // Repositories
    adoRepositoriesListTool,
    adoBranchesListTool,
];

/**
 * Register all Azure DevOps tools with the registry
 */
export function registerAzureDevOpsTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(azureDevOpsTools);
}
