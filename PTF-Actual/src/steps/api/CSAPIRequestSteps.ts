import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSAPIClient } from '../../api/CSAPIClient';
import { CSApiContextManager } from '../../api/context/CSApiContextManager';
import { CSRequestBuilder } from '../../api/client/CSRequestBuilder';
import { CSReporter } from '../../reporter/CSReporter';
import { CSRequestOptions } from '../../api/types/CSApiTypes';

export class CSAPIRequestSteps {
    private apiClient: CSAPIClient;
    private requestBuilder: CSRequestBuilder;
    private contextManager: CSApiContextManager;

    constructor() {
        this.apiClient = new CSAPIClient();
        this.requestBuilder = new CSRequestBuilder();
        this.contextManager = CSApiContextManager.getInstance();
    }

    @CSBDDStepDef("I send a GET request to {string}")
    async sendGetRequest(endpoint: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const url = this.resolveUrl(endpoint);

        // Get query parameters from context if they were set
        const queryParams = context?.getVariable('queryParams') || {};

        // Build the URL with query parameters
        let fullUrl = url;
        if (Object.keys(queryParams).length > 0) {
            const queryString = new URLSearchParams(queryParams).toString();
            fullUrl = `${url}${url.includes('?') ? '&' : '?'}${queryString}`;
            CSReporter.debug(`GET request URL with params: ${fullUrl}`);
        }

        CSReporter.info(`Sending GET request to: ${fullUrl}`);
        const response = await this.apiClient.get(fullUrl);

        if (context) {
            context.saveResponse('last', response);
            context.addToHistory({
                url: fullUrl,
                method: 'GET',
                headers: {},
                startTime: Date.now() - response.duration
            });
        }

        CSReporter.pass(`GET request successful: ${response.status}`);
    }

    @CSBDDStepDef("I send a POST request to {string}")
    async sendPostRequest(endpoint: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const url = this.resolveUrl(endpoint);

        const body = context?.getVariable('requestBody');

        // Get query parameters from context if they were set
        const queryParams = context?.getVariable('queryParams') || {};

        // Build the URL with query parameters
        let fullUrl = url;
        if (Object.keys(queryParams).length > 0) {
            const queryString = new URLSearchParams(queryParams).toString();
            fullUrl = `${url}${url.includes('?') ? '&' : '?'}${queryString}`;
        }

        CSReporter.info(`Sending POST request to: ${fullUrl}`);
        const response = await this.apiClient.post(fullUrl, body);

        if (context) {
            context.saveResponse('last', response);
            context.addToHistory({
                url,
                method: 'POST',
                headers: {},
                body,
                startTime: Date.now() - response.duration
            });
        }

        CSReporter.pass(`POST request successful: ${response.status}`);
    }

    @CSBDDStepDef("I send a POST request to {string} with body:")
    async sendPostRequestWithBody(endpoint: string, body: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const url = this.resolveUrl(endpoint);

        let parsedBody: any;
        try {
            parsedBody = JSON.parse(body);
        } catch {
            parsedBody = body;
        }

        // Get query parameters from context if they were set
        const queryParams = context?.getVariable('queryParams') || {};

        // Build the URL with query parameters
        let fullUrl = url;
        if (Object.keys(queryParams).length > 0) {
            const queryString = new URLSearchParams(queryParams).toString();
            fullUrl = `${url}${url.includes('?') ? '&' : '?'}${queryString}`;
        }

        CSReporter.info(`Sending POST request to: ${fullUrl}`);
        const response = await this.apiClient.post(fullUrl, parsedBody);

        if (context) {
            context.saveResponse('last', response);
            context.addToHistory({
                url: fullUrl,
                method: 'POST',
                headers: {},
                body: parsedBody,
                startTime: Date.now() - response.duration
            });
        }

        CSReporter.pass(`POST request successful: ${response.status}`);
    }

    @CSBDDStepDef("I send a PUT request to {string}")
    async sendPutRequest(endpoint: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const url = this.resolveUrl(endpoint);
        const body = context?.getVariable('requestBody');

        // Get query parameters from context if they were set
        const queryParams = context?.getVariable('queryParams') || {};

        // Build the URL with query parameters
        let fullUrl = url;
        if (Object.keys(queryParams).length > 0) {
            const queryString = new URLSearchParams(queryParams).toString();
            fullUrl = `${url}${url.includes('?') ? '&' : '?'}${queryString}`;
        }

        CSReporter.info(`Sending PUT request to: ${fullUrl}`);
        const response = await this.apiClient.put(fullUrl, body);

        if (context) {
            context.saveResponse('last', response);
        }

        CSReporter.pass(`PUT request successful: ${response.status}`);
    }

    @CSBDDStepDef("I send a DELETE request to {string}")
    async sendDeleteRequest(endpoint: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const url = this.resolveUrl(endpoint);

        // Get query parameters from context if they were set
        const queryParams = context?.getVariable('queryParams') || {};

        // Build the URL with query parameters
        let fullUrl = url;
        if (Object.keys(queryParams).length > 0) {
            const queryString = new URLSearchParams(queryParams).toString();
            fullUrl = `${url}${url.includes('?') ? '&' : '?'}${queryString}`;
        }

        CSReporter.info(`Sending DELETE request to: ${fullUrl}`);
        const response = await this.apiClient.delete(fullUrl);

        if (context) {
            context.saveResponse('last', response);
        }

        CSReporter.pass(`DELETE request successful: ${response.status}`);
    }

    @CSBDDStepDef("I send a PATCH request to {string}")
    async sendPatchRequest(endpoint: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const url = this.resolveUrl(endpoint);
        const body = context?.getVariable('requestBody');

        // Get query parameters from context if they were set
        const queryParams = context?.getVariable('queryParams') || {};

        // Build the URL with query parameters
        let fullUrl = url;
        if (Object.keys(queryParams).length > 0) {
            const queryString = new URLSearchParams(queryParams).toString();
            fullUrl = `${url}${url.includes('?') ? '&' : '?'}${queryString}`;
        }

        CSReporter.info(`Sending PATCH request to: ${fullUrl}`);
        const response = await this.apiClient.patch(fullUrl, body);

        if (context) {
            context.saveResponse('last', response);
        }

        CSReporter.pass(`PATCH request successful: ${response.status}`);
    }

    @CSBDDStepDef("I set request header {string} to {string}")
    async setRequestHeader(headerName: string, headerValue: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();

        // Replace variables in header value
        const resolvedValue = this.resolveVariables(headerValue);

        this.apiClient.setDefaultHeader(headerName, resolvedValue);

        if (context) {
            context.setHeader(headerName, resolvedValue);
        }

        CSReporter.debug(`Request header set: ${headerName} = ${resolvedValue}`);
    }

    @CSBDDStepDef("I set request headers:")
    async setRequestHeaders(dataTable: any): Promise<void> {
        const headers = dataTable.raw();

        for (const [headerName, headerValue] of headers) {
            await this.setRequestHeader(headerName, headerValue);
        }
    }

    @CSBDDStepDef("I set request body to:")
    async setRequestBody(body: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();

        let parsedBody: any;
        try {
            // Try to parse as JSON
            parsedBody = JSON.parse(body);
        } catch {
            // If not JSON, treat as string
            parsedBody = body;
        }

        // Replace variables in body
        const resolvedBody = this.resolveVariablesInObject(parsedBody);

        if (context) {
            context.setVariable('requestBody', resolvedBody);
        }

        CSReporter.debug(`Request body set: ${JSON.stringify(resolvedBody)}`);
    }

    @CSBDDStepDef("I set query parameter {string} to {string}")
    async setQueryParameter(paramName: string, paramValue: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();

        const resolvedValue = this.resolveVariables(paramValue);

        if (context) {
            let queryParams = context.getVariable('queryParams') || {};
            queryParams[paramName] = resolvedValue;
            context.setVariable('queryParams', queryParams);
        }

        CSReporter.debug(`Query parameter set: ${paramName} = ${resolvedValue}`);
    }

    @CSBDDStepDef("I upload file {string} to {string}")
    async uploadFile(filePath: string, endpoint: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const url = this.resolveUrl(endpoint);

        // Get query parameters from context if they were set
        const queryParams = context?.getVariable('queryParams') || {};

        // Build the URL with query parameters
        let fullUrl = url;
        if (Object.keys(queryParams).length > 0) {
            const queryString = new URLSearchParams(queryParams).toString();
            fullUrl = `${url}${url.includes('?') ? '&' : '?'}${queryString}`;
        }

        CSReporter.info(`Uploading file ${filePath} to: ${fullUrl}`);

        const response = await this.apiClient.getHttpClient().uploadFile(
            fullUrl,
            filePath,
            'file'
        );

        if (context) {
            context.saveResponse('last', response);
        }

        CSReporter.pass(`File upload successful: ${response.status}`);
    }

    @CSBDDStepDef("I download file from {string} to {string}")
    async downloadFile(endpoint: string, destinationPath: string): Promise<void> {
        const context = this.contextManager.getCurrentContext();
        const url = this.resolveUrl(endpoint);

        // Get query parameters from context if they were set
        const queryParams = context?.getVariable('queryParams') || {};

        // Build the URL with query parameters
        let fullUrl = url;
        if (Object.keys(queryParams).length > 0) {
            const queryString = new URLSearchParams(queryParams).toString();
            fullUrl = `${url}${url.includes('?') ? '&' : '?'}${queryString}`;
        }

        CSReporter.info(`Downloading file from ${fullUrl} to: ${destinationPath}`);

        await this.apiClient.getHttpClient().downloadFile(
            fullUrl,
            destinationPath,
            undefined,
            (progress: number) => {
                CSReporter.debug(`Download progress: ${Math.round(progress)}%`);
            }
        );

        CSReporter.pass(`File downloaded successfully to: ${destinationPath}`);
    }

    private resolveUrl(endpoint: string): string {
        const context = this.contextManager.getCurrentContext();

        // Replace variables in endpoint
        endpoint = this.resolveVariables(endpoint);

        // If endpoint is already a full URL, return as is
        if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
            return endpoint;
        }

        // Otherwise, combine with base URL
        const baseUrl = context?.baseUrl || this.apiClient.getBaseUrl() || '';
        return baseUrl + endpoint;
    }

    private resolveVariables(text: string): string {
        const context = this.contextManager.getCurrentContext();
        if (!context) return text;

        // Replace variables in format {{variableName}}
        return text.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
            const value = context.getVariable(varName);
            return value !== undefined ? String(value) : match;
        });
    }

    private resolveVariablesInObject(obj: any): any {
        if (typeof obj === 'string') {
            return this.resolveVariables(obj);
        }

        if (Array.isArray(obj)) {
            return obj.map(item => this.resolveVariablesInObject(item));
        }

        if (obj && typeof obj === 'object') {
            const resolved: any = {};
            for (const [key, value] of Object.entries(obj)) {
                resolved[key] = this.resolveVariablesInObject(value);
            }
            return resolved;
        }

        return obj;
    }
}