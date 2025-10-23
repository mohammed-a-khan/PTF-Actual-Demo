/**
 * API Payload Steps
 * Step definitions for loading and sending API payloads from files
 * Supports JSON, XML, YAML formats with template variable resolution
 *
 */

import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSPayloadLoader } from '../../api/utils/CSPayloadLoader';
import { CSApiContextManager } from '../../api/context/CSApiContextManager';
import { CSReporter } from '../../reporter/CSReporter';
import { CSAPIClient } from '../../api/CSAPIClient';
import { CSRequestOptions } from '../../api/types/CSApiTypes';

export class CSAPIPayloadSteps {
    private payloadLoader: CSPayloadLoader;
    private apiClient: CSAPIClient;

    constructor() {
        this.payloadLoader = CSPayloadLoader.getInstance();
        this.apiClient = new CSAPIClient();
    }

    /**
     * Send request with payload file (uses current API context)
     * Example: user send a "POST" request with payload file "users/create-user.json"
     */
    @CSBDDStepDef('user send a {string} request with payload file {string}')
    public async sendRequestWithPayloadFile(
        method: string,
        payloadFile: string
    ): Promise<void> {
        CSReporter.info(`Sending ${method} request with payload file: ${payloadFile}`);

        try {
            // Load and process payload
            const payload = await this.payloadLoader.loadPayload(payloadFile);

            // Get API context
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();

            // Build request options
            const requestOptions: CSRequestOptions = {
                method: method.toUpperCase() as any,
                url: apiContext.baseUrl || '',
                body: payload
            };

            // Send request
            const response = await this.apiClient.request(requestOptions);

            // Store response
            apiContext.saveResponse('last', response);

            CSReporter.pass(
                `${method} request sent successfully:\n` +
                `  File: ${payloadFile}\n` +
                `  Status: ${response.status}`
            );

        } catch (error: any) {
            CSReporter.error(`Failed to send request with payload file: ${error.message}`);
            throw error;
        }
    }

    /**
     * Send request to named API with payload file
     * Example: user send a "POST" request to "users" API with payload file "users/create-user.json"
     */
    @CSBDDStepDef('user send a {string} request to {string} API with payload file {string}')
    public async sendRequestToApiWithPayloadFile(
        method: string,
        apiName: string,
        payloadFile: string
    ): Promise<void> {
        CSReporter.info(`Sending ${method} request to ${apiName} API with payload: ${payloadFile}`);

        try {
            // Set API context
            const contextManager = CSApiContextManager.getInstance();
            contextManager.setCurrentContext(apiName);

            // Load and process payload
            const payload = await this.payloadLoader.loadPayload(payloadFile);

            // Get API context
            const apiContext = contextManager.getCurrentContext();

            // Build request options
            const requestOptions: CSRequestOptions = {
                method: method.toUpperCase() as any,
                url: apiContext.baseUrl || '',
                body: payload
            };

            // Send request
            const response = await this.apiClient.request(requestOptions);

            // Store response
            apiContext.saveResponse('last', response);

            CSReporter.pass(
                `${method} request to ${apiName} sent successfully:\n` +
                `  File: ${payloadFile}\n` +
                `  Status: ${response.status}`
            );

        } catch (error: any) {
            CSReporter.error(`Failed to send request to API: ${error.message}`);
            throw error;
        }
    }

    /**
     * Send request to specific endpoint with payload file
     * Example: user send a "PUT" request to "/api/users/123" with payload file "users/update-user.json"
     */
    @CSBDDStepDef('user send a {string} request to {string} with payload file {string}')
    public async sendRequestToEndpointWithPayloadFile(
        method: string,
        endpoint: string,
        payloadFile: string
    ): Promise<void> {
        CSReporter.info(`Sending ${method} to ${endpoint} with payload: ${payloadFile}`);

        try {
            // Load and process payload
            const payload = await this.payloadLoader.loadPayload(payloadFile);

            // Get API context
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();

            // Build request options with explicit endpoint
            const requestOptions: CSRequestOptions = {
                method: method.toUpperCase() as any,
                url: endpoint,
                body: payload
            };

            // Send request
            const response = await this.apiClient.request(requestOptions);

            // Store response
            apiContext.saveResponse('last', response);

            CSReporter.pass(
                `${method} to ${endpoint} completed successfully:\n` +
                `  File: ${payloadFile}\n` +
                `  Status: ${response.status}`
            );

        } catch (error: any) {
            CSReporter.error(`Failed to send request to endpoint: ${error.message}`);
            throw error;
        }
    }

    /**
     * Send request with inline payload (from DocString)
     * Example:
     *   user send a "POST" request with payload:
     *     """
     *     {
     *       "userId": "{{userId}}",
     *       "name": "John Doe"
     *     }
     *     """
     */
    @CSBDDStepDef('user send a {string} request with payload:')
    public async sendRequestWithInlinePayload(
        method: string,
        payloadString: string
    ): Promise<void> {
        CSReporter.info(`Sending ${method} request with inline payload`);

        try {
            // Process inline payload (could be JSON, XML, or template)
            const payload = await this.payloadLoader.processPayloadString(payloadString);

            // Get API context
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();

            // Build request options
            const requestOptions: CSRequestOptions = {
                method: method.toUpperCase() as any,
                url: apiContext.baseUrl || '',
                body: payload
            };

            // Send request
            const response = await this.apiClient.request(requestOptions);

            // Store response
            apiContext.saveResponse('last', response);

            CSReporter.pass(`${method} request sent successfully with status: ${response.status}`);

        } catch (error: any) {
            CSReporter.error(`Failed to send request with inline payload: ${error.message}`);
            throw error;
        }
    }

    /**
     * Send request to endpoint with inline payload
     * Example:
     *   user send a "POST" request to "/api/users" with payload:
     *     """
     *     {"name": "John Doe"}
     *     """
     */
    @CSBDDStepDef('user send a {string} request to {string} with payload:')
    public async sendRequestToEndpointWithInlinePayload(
        method: string,
        endpoint: string,
        payloadString: string
    ): Promise<void> {
        CSReporter.info(`Sending ${method} to ${endpoint} with inline payload`);

        try {
            // Process inline payload
            const payload = await this.payloadLoader.processPayloadString(payloadString);

            // Get API context
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();

            // Build request options
            const requestOptions: CSRequestOptions = {
                method: method.toUpperCase() as any,
                url: endpoint,
                body: payload
            };

            // Send request
            const response = await this.apiClient.request(requestOptions);

            // Store response
            apiContext.saveResponse('last', response);

            CSReporter.pass(`${method} to ${endpoint} completed with status: ${response.status}`);

        } catch (error: any) {
            CSReporter.error(`Failed to send request: ${error.message}`);
            throw error;
        }
    }

    /**
     * Load payload from file without sending request (for inspection/debugging)
     * Example: user load payload from file "users/create-user.json"
     */
    @CSBDDStepDef('user load payload from file {string}')
    public async loadPayloadFromFile(payloadFile: string): Promise<void> {
        CSReporter.info(`Loading payload from file: ${payloadFile}`);

        try {
            // Load and process payload
            const payload = await this.payloadLoader.loadPayload(payloadFile);

            // Get API context
            const apiContext = CSApiContextManager.getInstance().getCurrentContext();

            // Store in context as 'lastPayload'
            apiContext.setVariable('lastPayload', payload);

            CSReporter.pass(`Payload loaded successfully from: ${payloadFile}`);
            CSReporter.debug(`Payload content: ${JSON.stringify(payload, null, 2)}`);

        } catch (error: any) {
            CSReporter.error(`Failed to load payload file: ${error.message}`);
            throw error;
        }
    }

    /**
     * Print last loaded payload (for debugging)
     * Example: user print last payload
     */
    @CSBDDStepDef('user print last payload')
    public async printLastPayload(): Promise<void> {
        const apiContext = CSApiContextManager.getInstance().getCurrentContext();
        const payload = apiContext.getVariable('lastPayload');

        if (!payload) {
            CSReporter.warn('No payload found. Load a payload first.');
            return;
        }

        CSReporter.info('Last Loaded Payload:');
        CSReporter.info(JSON.stringify(payload, null, 2));
    }
}
