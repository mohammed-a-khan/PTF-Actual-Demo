import { CSAPIClient } from './CSAPIClient';
import { CSRequestOptions, CSResponse, CSApiChain, CSChainStep } from './types/CSApiTypes';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';

export class CSAPIRunner {
    private apiClient: CSAPIClient;
    private configManager: CSConfigurationManager;
    private runningChains: Map<string, boolean>;

    constructor() {
        this.apiClient = new CSAPIClient();
        this.configManager = CSConfigurationManager.getInstance();
        this.runningChains = new Map();
    }

    public async runChain(chain: CSApiChain): Promise<Map<string, CSResponse>> {
        if (this.runningChains.has(chain.id)) {
            throw new Error(`Chain ${chain.id} is already running`);
        }

        this.runningChains.set(chain.id, true);
        const responses = new Map<string, CSResponse>();

        try {
            CSReporter.info(`Starting API chain: ${chain.name || chain.id}`);

            // Set up context if provided
            if (chain.context) {
                this.apiClient.getContext().import(chain.context);
            }

            // Set up variables
            if (chain.variables) {
                Object.entries(chain.variables).forEach(([key, value]) => {
                    this.apiClient.setVariable(key, value);
                });
            }

            // Execute steps
            for (let i = 0; i < chain.steps.length; i++) {
                const step = chain.steps[i];

                try {
                    const stepResponse = await this.executeStep(step, responses);

                    if (stepResponse) {
                        responses.set(step.id, stepResponse);

                        if (chain.onStepComplete) {
                            chain.onStepComplete(step, stepResponse);
                        }
                    }
                } catch (error) {
                    CSReporter.error(`Step ${step.name || step.id} failed: ${(error as Error).message}`);

                    if (chain.onError) {
                        chain.onError(error, step);
                    }

                    if (!step.continueOnError && !chain.continueOnError) {
                        throw error;
                    }
                }
            }

            CSReporter.info(`API chain completed: ${chain.name || chain.id}`);
            return responses;

        } finally {
            this.runningChains.delete(chain.id);
        }
    }

    private async executeStep(step: CSChainStep, previousResponses: Map<string, CSResponse>): Promise<CSResponse | null> {
        CSReporter.debug(`Executing step: ${step.name || step.id} (${step.type})`);

        // Check condition
        if (step.condition) {
            const context = this.apiClient.getContext();
            if (!step.condition(context)) {
                CSReporter.debug(`Step skipped due to condition: ${step.name || step.id}`);
                return null;
            }
        }

        switch (step.type) {
            case 'request':
                return await this.executeRequestStep(step);

            case 'validation':
                return await this.executeValidationStep(step, previousResponses);

            case 'extraction':
                return await this.executeExtractionStep(step, previousResponses);

            case 'transformation':
                return await this.executeTransformationStep(step);

            case 'condition':
                return await this.executeConditionalStep(step, previousResponses);

            case 'loop':
                return await this.executeLoopStep(step, previousResponses);

            case 'delay':
                return await this.executeDelayStep(step);

            default:
                throw new Error(`Unknown step type: ${step.type}`);
        }
    }

    private async executeRequestStep(step: CSChainStep): Promise<CSResponse> {
        const config = step.config as CSRequestOptions;

        // Apply step-specific timeout and retries
        if (step.timeout) config.timeout = step.timeout;
        if (step.retries) config.retries = step.retries;

        const response = await this.apiClient.request(config);

        // Save response with step ID for reference
        this.apiClient.getContext().saveResponse(step.id, response);

        return response;
    }

    private async executeValidationStep(step: CSChainStep, previousResponses: Map<string, CSResponse>): Promise<null> {
        const config = step.config as { responseId: string; validations: any[] };
        const response = previousResponses.get(config.responseId) || this.apiClient.getResponse(config.responseId);

        if (!response) {
            throw new Error(`Response '${config.responseId}' not found for validation`);
        }

        // TODO: Implement validation when validator classes are ready
        CSReporter.debug(`Validation step executed for response: ${config.responseId}`);

        return null;
    }

    private async executeExtractionStep(step: CSChainStep, previousResponses: Map<string, CSResponse>): Promise<null> {
        const config = step.config as { responseId: string; extractions: Array<{ path: string; variable: string }> };
        const response = previousResponses.get(config.responseId) || this.apiClient.getResponse(config.responseId);

        if (!response) {
            throw new Error(`Response '${config.responseId}' not found for extraction`);
        }

        for (const extraction of config.extractions) {
            this.apiClient.extractFromResponse(config.responseId, extraction.path, extraction.variable);
        }

        CSReporter.debug(`Extracted ${config.extractions.length} values from response: ${config.responseId}`);

        return null;
    }

    private async executeTransformationStep(step: CSChainStep): Promise<null> {
        const config = step.config as { variable: string; transform: (value: any) => any };
        const value = this.apiClient.getVariable(config.variable);
        const transformed = config.transform(value);

        this.apiClient.setVariable(config.variable, transformed);

        CSReporter.debug(`Transformed variable: ${config.variable}`);

        return null;
    }

    private async executeConditionalStep(step: CSChainStep, previousResponses: Map<string, CSResponse>): Promise<CSResponse | null> {
        const config = step.config as {
            condition: (context: any) => boolean;
            ifTrue?: CSChainStep;
            ifFalse?: CSChainStep;
        };

        const context = this.apiClient.getContext();
        const conditionResult = config.condition(context);

        if (conditionResult && config.ifTrue) {
            return await this.executeStep(config.ifTrue, previousResponses);
        } else if (!conditionResult && config.ifFalse) {
            return await this.executeStep(config.ifFalse, previousResponses);
        }

        return null;
    }

    private async executeLoopStep(step: CSChainStep, previousResponses: Map<string, CSResponse>): Promise<null> {
        const config = step.config as {
            items: any[] | string;
            itemVariable: string;
            steps: CSChainStep[];
            maxIterations?: number;
        };

        const items = typeof config.items === 'string'
            ? this.apiClient.getVariable(config.items)
            : config.items;

        if (!Array.isArray(items)) {
            throw new Error(`Loop items must be an array`);
        }

        const maxIterations = config.maxIterations || items.length;
        const iterations = Math.min(items.length, maxIterations);

        for (let i = 0; i < iterations; i++) {
            this.apiClient.setVariable(config.itemVariable, items[i]);
            this.apiClient.setVariable(`${config.itemVariable}_index`, i);
            this.apiClient.setVariable(`${config.itemVariable}_count`, items.length);

            for (const loopStep of config.steps) {
                await this.executeStep(loopStep, previousResponses);
            }
        }

        CSReporter.debug(`Loop completed with ${iterations} iterations`);

        return null;
    }

    private async executeDelayStep(step: CSChainStep): Promise<null> {
        const config = step.config as { delay: number; message?: string };

        if (config.message) {
            CSReporter.debug(config.message);
        }

        await this.sleep(config.delay);

        return null;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    public async runParallel(chains: CSApiChain[]): Promise<Map<string, Map<string, CSResponse>>> {
        CSReporter.info(`Running ${chains.length} chains in parallel`);

        const results = await Promise.all(
            chains.map(chain => this.runChain(chain))
        );

        const allResponses = new Map<string, Map<string, CSResponse>>();

        chains.forEach((chain, index) => {
            allResponses.set(chain.id, results[index]);
        });

        return allResponses;
    }

    public async runSequential(chains: CSApiChain[]): Promise<Map<string, Map<string, CSResponse>>> {
        CSReporter.info(`Running ${chains.length} chains sequentially`);

        const allResponses = new Map<string, Map<string, CSResponse>>();

        for (const chain of chains) {
            const responses = await this.runChain(chain);
            allResponses.set(chain.id, responses);
        }

        return allResponses;
    }

    public createChain(name: string, steps: CSChainStep[]): CSApiChain {
        return {
            id: `chain_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            name,
            steps
        };
    }

    public createRequestStep(id: string, options: CSRequestOptions): CSChainStep {
        return {
            id,
            type: 'request',
            config: options
        };
    }

    public createValidationStep(id: string, responseId: string, validations: any[]): CSChainStep {
        return {
            id,
            type: 'validation',
            config: { responseId, validations }
        };
    }

    public createExtractionStep(
        id: string,
        responseId: string,
        extractions: Array<{ path: string; variable: string }>
    ): CSChainStep {
        return {
            id,
            type: 'extraction',
            config: { responseId, extractions }
        };
    }

    public createDelayStep(id: string, delay: number, message?: string): CSChainStep {
        return {
            id,
            type: 'delay',
            config: { delay, message }
        };
    }

    public createLoopStep(
        id: string,
        items: any[] | string,
        itemVariable: string,
        steps: CSChainStep[]
    ): CSChainStep {
        return {
            id,
            type: 'loop',
            config: { items, itemVariable, steps }
        };
    }

    public getAPIClient(): CSAPIClient {
        return this.apiClient;
    }

    public isChainRunning(chainId: string): boolean {
        return this.runningChains.has(chainId);
    }

    public getRunningChains(): string[] {
        return Array.from(this.runningChains.keys());
    }
}