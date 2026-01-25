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

    constructor(config: AzureDevOpsConfig) {
        this.config = config;
        this.baseUrl = config.baseUrl || 'https://dev.azure.com';
    }

    /**
     * Make an API request to Azure DevOps
     */
    async request(
        method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
        path: string,
        body?: unknown,
        apiVersion: string = '7.1'
    ): Promise<AzureDevOpsApiResponse> {
        const url = new URL(`${this.baseUrl}/${this.config.organization}/${this.config.project}/_apis/${path}`);
        url.searchParams.set('api-version', apiVersion);

        const options: https.RequestOptions = {
            hostname: url.hostname,
            port: url.port || 443,
            path: `${url.pathname}${url.search}`,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${Buffer.from(`:${this.config.personalAccessToken}`).toString('base64')}`,
            },
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
     * Make a request to the Work Item Tracking API
     */
    async witRequest(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<AzureDevOpsApiResponse> {
        return this.request(method, `wit/${path}`, body);
    }

    /**
     * Make a request to the Pipelines API
     */
    async pipelinesRequest(method: 'GET' | 'POST', path: string, body?: unknown): Promise<AzureDevOpsApiResponse> {
        return this.request(method, `pipelines/${path}`, body);
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

function getClient(params: Record<string, unknown>): AzureDevOpsClient {
    const config: AzureDevOpsConfig = {
        organization: params.organization as string,
        project: params.project as string,
        personalAccessToken: params.pat as string,
        baseUrl: params.baseUrl as string | undefined,
    };

    if (!config.organization || !config.project || !config.personalAccessToken) {
        throw new Error('Missing required Azure DevOps configuration: organization, project, and pat are required');
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
    .description('List all pipelines in the Azure DevOps project')
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
    .description('Trigger a pipeline run in Azure DevOps')
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
    .description('Get details of a specific pipeline run')
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
    .description('List builds in the Azure DevOps project')
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
    .description('Get details of a specific build')
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
    .description('Queue a new build')
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
    .description('Cancel a running build')
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
    .description('Get build logs')
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
    .description('List test runs in the Azure DevOps project')
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
    .description('Get details of a specific test run')
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
    .description('List test results for a test run')
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
    .description('Get failed test results with error details for a test run')
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
    .description('Get a work item by ID')
    .category('cicd')
    .numberParam('id', 'Work item ID', { required: true })
    .arrayParam('fields', 'Specific fields to retrieve', 'string')
    .handler(async (params, context) => {
        const client = getClient(params);
        context.log('info', `Getting work item ${params.id}`);

        const queryParams: string[] = [];
        if (params.fields && Array.isArray(params.fields)) {
            queryParams.push(`fields=${(params.fields as string[]).join(',')}`);
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
    .description('Create a new work item')
    .category('cicd')
    .stringParam('type', 'Work item type (e.g., Bug, Task, User Story)', { required: true })
    .stringParam('title', 'Work item title', { required: true })
    .stringParam('description', 'Work item description')
    .stringParam('assignedTo', 'User to assign the work item to')
    .stringParam('state', 'Initial state')
    .stringParam('areaPath', 'Area path')
    .stringParam('iterationPath', 'Iteration path')
    .arrayParam('tags', 'Tags to add', 'string')
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

        const response = await client.witRequest('POST', `workitems/$${encodeURIComponent(params.type as string)}`, operations);

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
    .description('Update an existing work item')
    .category('cicd')
    .numberParam('id', 'Work item ID', { required: true })
    .stringParam('title', 'New title')
    .stringParam('description', 'New description')
    .stringParam('assignedTo', 'User to assign to')
    .stringParam('state', 'New state')
    .stringParam('comment', 'Comment to add')
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

        if (operations.length === 0) {
            return createErrorResult('No updates specified');
        }

        const response = await client.witRequest('PATCH', `workitems/${params.id}`, operations);

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
    .description('Query work items using WIQL (Work Item Query Language)')
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

// ============================================================================
// Pull Request Tools
// ============================================================================

const adoPullRequestsListTool = adoCommonParams(defineTool())
    .name('ado_pull_requests_list')
    .description('List pull requests in a repository')
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
    .description('Get details of a specific pull request')
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
    .description('Create a new pull request')
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
    .description('Add a comment to a pull request')
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
// Repository Tools
// ============================================================================

const adoRepositoriesListTool = adoCommonParams(defineTool())
    .name('ado_repositories_list')
    .description('List Git repositories in the project')
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
    .description('List branches in a repository')
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
// Export all Azure DevOps tools
// ============================================================================

export const azureDevOpsTools: MCPToolDefinition[] = [
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
    adoWorkItemsCreateTool,
    adoWorkItemsUpdateTool,
    adoWorkItemsQueryTool,

    // Pull Requests
    adoPullRequestsListTool,
    adoPullRequestsGetTool,
    adoPullRequestsCreateTool,
    adoPullRequestsCommentTool,

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
