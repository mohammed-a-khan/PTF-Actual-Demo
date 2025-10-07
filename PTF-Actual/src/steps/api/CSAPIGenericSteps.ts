import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSAPIClient } from '../../api/CSAPIClient';
import { CSApiContext } from '../../api/context/CSApiContext';
import { CSApiContextManager } from '../../api/context/CSApiContextManager';
import { CSReporter } from '../../reporter/CSReporter';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';

export class CSAPIGenericSteps {
    private apiContextManager: CSApiContextManager;
    private currentContext: CSApiContext | null = null;
    private apiClient: CSAPIClient;

    constructor() {
        this.apiContextManager = CSApiContextManager.getInstance();
        this.apiClient = new CSAPIClient();
    }

    @CSBDDStepDef("user is working with {string} API")
    async setAPIContext(apiName: string): Promise<void> {
        CSReporter.info(`Setting up API context for '${apiName}' API`);

        if (this.apiContextManager.hasContext(apiName)) {
            this.currentContext = this.apiContextManager.getContext(apiName);
            CSReporter.debug(`Reusing existing API context for '${apiName}'`);
        } else {
            this.currentContext = this.apiContextManager.createContext(apiName);
            CSReporter.debug(`Created new API context for '${apiName}'`);
        }

        this.apiContextManager.setCurrentContext(apiName);
    }

    @CSBDDStepDef("the API base URL is {string}")
    async setBaseURL(baseUrl: string): Promise<void> {
        if (!this.currentContext) {
            throw new Error('No API context set. Use "user is working with" step first.');
        }

        this.currentContext.baseUrl = baseUrl;
        this.apiClient.setBaseUrl(baseUrl);
        CSReporter.info(`API base URL set to: ${baseUrl}`);
    }

    @CSBDDStepDef("the API endpoint is {string}")
    async setEndpoint(endpoint: string): Promise<void> {
        if (!this.currentContext) {
            throw new Error('No API context set');
        }

        this.currentContext.setVariable('endpoint', endpoint);
        CSReporter.debug(`API endpoint set to: ${endpoint}`);
    }

    @CSBDDStepDef("the API timeout is {int} seconds")
    async setTimeout(timeoutSeconds: number): Promise<void> {
        const timeoutMs = timeoutSeconds * 1000;
        if (this.currentContext) {
            this.currentContext.timeout = timeoutMs;
        }
        this.apiClient.setTimeout(timeoutMs);
        CSReporter.debug(`API timeout set to: ${timeoutSeconds} seconds`);
    }

    @CSBDDStepDef("API response should be saved as {string}")
    async saveResponse(responseName: string): Promise<void> {
        if (!this.currentContext) {
            throw new Error('No API context set');
        }

        const lastResponse = this.currentContext.getLastResponse();
        if (lastResponse) {
            this.currentContext.saveResponse(responseName, lastResponse);
            CSReporter.info(`Response saved as '${responseName}'`);
        } else {
            throw new Error('No response available to save');
        }
    }

    @CSBDDStepDef("I clear the API context")
    async clearContext(): Promise<void> {
        if (this.currentContext) {
            const contextId = this.currentContext.id;
            this.currentContext.clear();
            CSReporter.info(`Cleared API context: ${contextId}`);
        }
    }

    @CSBDDStepDef("I use environment {string}")
    async setEnvironment(environment: string): Promise<void> {
        const config = CSConfigurationManager.getInstance();
        config.set('ENVIRONMENT', environment);

        // Load environment-specific configuration
        const envConfig = config.get(`environments.${environment}`);
        if (envConfig && typeof envConfig === 'object') {
            const env = envConfig as any;
            if (env.baseUrl) {
                await this.setBaseURL(env.baseUrl);
            }
            if (env.headers && typeof env.headers === 'object') {
                Object.entries(env.headers).forEach(([key, value]) => {
                    this.apiClient.setDefaultHeader(key, value as string);
                });
            }
            CSReporter.info(`Environment set to: ${environment}`);
        } else {
            CSReporter.warn(`Environment '${environment}' not found in configuration`);
        }
    }

    @CSBDDStepDef("I set variable {string} to {string}")
    async setVariable(variableName: string, value: string): Promise<void> {
        if (!this.currentContext) {
            throw new Error('No API context set');
        }

        this.currentContext.setVariable(variableName, value);
        CSReporter.debug(`Variable '${variableName}' set to: ${value}`);
    }

    @CSBDDStepDef("I extract {string} from response and save as {string}")
    async extractFromResponse(jsonPath: string, variableName: string): Promise<void> {
        if (!this.currentContext) {
            throw new Error('No API context set');
        }

        const lastResponse = this.currentContext.getLastResponse();
        if (!lastResponse) {
            throw new Error('No response available to extract from');
        }

        // Simple JSONPath extraction (for complex paths, use a JSONPath library)
        const path = jsonPath.replace('$.', '').split('.');
        let value = lastResponse.body;

        for (const segment of path) {
            if (value && typeof value === 'object') {
                value = value[segment];
            }
        }

        this.currentContext.setVariable(variableName, value);
        CSReporter.info(`Extracted value '${value}' from '${jsonPath}' and saved as '${variableName}'`);
    }

    @CSBDDStepDef("I wait for {int} seconds")
    async waitForSeconds(seconds: number): Promise<void> {
        CSReporter.debug(`Waiting for ${seconds} seconds...`);
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    }

    @CSBDDStepDef("I print the current context")
    async printContext(): Promise<void> {
        if (!this.currentContext) {
            CSReporter.info('No API context set');
            return;
        }

        CSReporter.info('Current API Context:');
        CSReporter.info(`  ID: ${this.currentContext.id}`);
        CSReporter.info(`  Name: ${this.currentContext.name || 'N/A'}`);
        CSReporter.info(`  Base URL: ${this.currentContext.baseUrl || 'N/A'}`);
        CSReporter.info(`  Variables: ${this.currentContext.variables.size} defined`);
        CSReporter.info(`  Responses: ${this.currentContext.responses.size} saved`);
        CSReporter.info(`  Cookies: ${this.currentContext.cookies.length} stored`);
    }

    @CSBDDStepDef("I print the last response")
    async printLastResponse(): Promise<void> {
        if (!this.currentContext) {
            throw new Error('No API context set');
        }

        const lastResponse = this.currentContext.getLastResponse();
        if (!lastResponse) {
            CSReporter.info('No response available');
            return;
        }

        CSReporter.info('Last Response:');
        CSReporter.info(`  Status: ${lastResponse.status} ${lastResponse.statusText}`);
        CSReporter.info(`  Duration: ${lastResponse.duration}ms`);
        CSReporter.info(`  Headers: ${JSON.stringify(lastResponse.headers, null, 2)}`);
        CSReporter.info(`  Body: ${JSON.stringify(lastResponse.body, null, 2)}`);
    }
}