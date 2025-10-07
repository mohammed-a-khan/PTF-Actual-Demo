import { CSAPIClient } from './CSAPIClient';
import { CSAPIRunner } from './CSAPIRunner';
import { CSAPIValidator } from './CSAPIValidator';
import { CSApiChainContext, CSChainWorkflow, CSChainStep } from './context/CSApiChainContext';
import { CSRequestOptions, CSResponse, CSValidationResult, CSApiChain } from './types/CSApiTypes';
import { CSReporter } from '../reporter/CSReporter';
import { EventEmitter } from 'events';

export interface CSExecutionOptions {
    mode: 'parallel' | 'sequential' | 'batch';
    maxConcurrency?: number;
    batchSize?: number;
    delayBetweenRequests?: number;
    delayBetweenBatches?: number;
    retryOnFailure?: boolean;
    stopOnError?: boolean;
    timeout?: number;
    validateResponses?: boolean;
    collectMetrics?: boolean;
}

export interface CSExecutionResult {
    id: string;
    mode: string;
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    responses: Map<string, CSResponse>;
    validations: Map<string, CSValidationResult>;
    errors: Map<string, Error>;
    metrics?: CSExecutionMetrics;
    duration: number;
    status: 'success' | 'partial' | 'failed';
}

export interface CSExecutionMetrics {
    avgResponseTime: number;
    minResponseTime: number;
    maxResponseTime: number;
    totalDataTransferred: number;
    requestsPerSecond: number;
    successRate: number;
    errorRate: number;
    statusCodeDistribution: Map<number, number>;
}

export class CSAPIExecutor extends EventEmitter {
    private apiClient: CSAPIClient;
    private apiRunner: CSAPIRunner;
    private apiValidator: CSAPIValidator;
    private executionQueue: Map<string, CSRequestOptions[]>;
    private activeExecutions: Map<string, AbortController>;
    private executionResults: Map<string, CSExecutionResult>;

    constructor() {
        super();
        this.apiClient = new CSAPIClient();
        this.apiRunner = new CSAPIRunner();
        this.apiValidator = new CSAPIValidator();
        this.executionQueue = new Map();
        this.activeExecutions = new Map();
        this.executionResults = new Map();
    }

    public async execute(
        requests: CSRequestOptions[],
        options: CSExecutionOptions
    ): Promise<CSExecutionResult> {
        const executionId = this.generateExecutionId();
        const abortController = new AbortController();
        this.activeExecutions.set(executionId, abortController);

        const result: CSExecutionResult = {
            id: executionId,
            mode: options.mode,
            totalRequests: requests.length,
            successfulRequests: 0,
            failedRequests: 0,
            responses: new Map(),
            validations: new Map(),
            errors: new Map(),
            duration: 0,
            status: 'success'
        };

        const startTime = Date.now();

        try {
            this.emit('execution:start', { executionId, requests: requests.length, mode: options.mode });
            CSReporter.info(`Starting ${options.mode} execution with ${requests.length} requests`);

            switch (options.mode) {
                case 'sequential':
                    await this.executeSequential(executionId, requests, options, result, abortController.signal);
                    break;

                case 'parallel':
                    await this.executeParallel(executionId, requests, options, result, abortController.signal);
                    break;

                case 'batch':
                    await this.executeBatch(executionId, requests, options, result, abortController.signal);
                    break;

                default:
                    throw new Error(`Unknown execution mode: ${options.mode}`);
            }

            // Collect metrics if requested
            if (options.collectMetrics) {
                result.metrics = this.calculateMetrics(result);
            }

            // Determine overall status
            if (result.failedRequests === 0) {
                result.status = 'success';
            } else if (result.successfulRequests > 0) {
                result.status = 'partial';
            } else {
                result.status = 'failed';
            }

        } catch (error) {
            CSReporter.error(`Execution failed: ${(error as Error).message}`);
            result.status = 'failed';
            this.emit('execution:error', { executionId, error });
        } finally {
            result.duration = Date.now() - startTime;
            this.activeExecutions.delete(executionId);
            this.executionResults.set(executionId, result);

            CSReporter.info(`Execution completed: ${result.successfulRequests}/${result.totalRequests} successful (${result.duration}ms)`);
            this.emit('execution:complete', { executionId, result });
        }

        return result;
    }

    private async executeSequential(
        executionId: string,
        requests: CSRequestOptions[],
        options: CSExecutionOptions,
        result: CSExecutionResult,
        signal: AbortSignal
    ): Promise<void> {
        for (let i = 0; i < requests.length; i++) {
            if (signal.aborted) {
                CSReporter.warn('Execution aborted');
                break;
            }

            const request = requests[i];
            const requestId = `${executionId}_${i}`;

            try {
                this.emit('request:start', { executionId, requestId, index: i });

                // Execute request
                const response = await this.executeRequest(request, options.timeout);
                result.responses.set(requestId, response);

                // Validate response if requested
                if (options.validateResponses && request.validations) {
                    const validation = await this.apiValidator.validate(response, request.validations);
                    result.validations.set(requestId, validation);

                    if (!validation.valid) {
                        throw new Error(`Validation failed for request ${i}`);
                    }
                }

                result.successfulRequests++;
                this.emit('request:success', { executionId, requestId, response });

                // Delay between requests if configured
                if (options.delayBetweenRequests && i < requests.length - 1) {
                    await this.delay(options.delayBetweenRequests);
                }

            } catch (error) {
                result.failedRequests++;
                result.errors.set(requestId, error as Error);
                this.emit('request:error', { executionId, requestId, error });

                if (options.stopOnError) {
                    CSReporter.error(`Stopping execution due to error: ${(error as Error).message}`);
                    break;
                }

                if (options.retryOnFailure) {
                    CSReporter.debug(`Retrying failed request ${i}`);
                    // Retry logic would go here
                }
            }
        }
    }

    private async executeParallel(
        executionId: string,
        requests: CSRequestOptions[],
        options: CSExecutionOptions,
        result: CSExecutionResult,
        signal: AbortSignal
    ): Promise<void> {
        const maxConcurrency = options.maxConcurrency || requests.length;
        const chunks = this.chunkArray(requests, maxConcurrency);

        for (const chunk of chunks) {
            if (signal.aborted) {
                CSReporter.warn('Execution aborted');
                break;
            }

            const promises = chunk.map(async (request, index) => {
                const requestId = `${executionId}_${requests.indexOf(request)}`;

                try {
                    this.emit('request:start', { executionId, requestId, index });

                    const response = await this.executeRequest(request, options.timeout);
                    result.responses.set(requestId, response);

                    if (options.validateResponses && request.validations) {
                        const validation = await this.apiValidator.validate(response, request.validations);
                        result.validations.set(requestId, validation);

                        if (!validation.valid) {
                            throw new Error(`Validation failed for request ${requestId}`);
                        }
                    }

                    result.successfulRequests++;
                    this.emit('request:success', { executionId, requestId, response });

                } catch (error) {
                    result.failedRequests++;
                    result.errors.set(requestId, error as Error);
                    this.emit('request:error', { executionId, requestId, error });

                    if (options.stopOnError) {
                        throw error;
                    }
                }
            });

            try {
                await Promise.all(promises);
            } catch (error) {
                if (options.stopOnError) {
                    CSReporter.error(`Stopping parallel execution due to error: ${(error as Error).message}`);
                    break;
                }
            }

            // Delay between chunks if configured
            if (options.delayBetweenRequests && chunks.indexOf(chunk) < chunks.length - 1) {
                await this.delay(options.delayBetweenRequests);
            }
        }
    }

    private async executeBatch(
        executionId: string,
        requests: CSRequestOptions[],
        options: CSExecutionOptions,
        result: CSExecutionResult,
        signal: AbortSignal
    ): Promise<void> {
        const batchSize = options.batchSize || 10;
        const batches = this.chunkArray(requests, batchSize);

        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            if (signal.aborted) {
                CSReporter.warn('Execution aborted');
                break;
            }

            const batch = batches[batchIndex];
            CSReporter.info(`Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} requests)`);
            this.emit('batch:start', { executionId, batchIndex, size: batch.length });

            // Execute batch in parallel
            const batchPromises = batch.map(async (request, index) => {
                const globalIndex = batchIndex * batchSize + index;
                const requestId = `${executionId}_${globalIndex}`;

                try {
                    const response = await this.executeRequest(request, options.timeout);
                    result.responses.set(requestId, response);

                    if (options.validateResponses && request.validations) {
                        const validation = await this.apiValidator.validate(response, request.validations);
                        result.validations.set(requestId, validation);

                        if (!validation.valid) {
                            throw new Error(`Validation failed`);
                        }
                    }

                    result.successfulRequests++;
                    return { success: true, requestId };

                } catch (error) {
                    result.failedRequests++;
                    result.errors.set(requestId, error as Error);
                    return { success: false, requestId, error };
                }
            });

            const batchResults = await Promise.all(batchPromises);

            // Check if should stop on error
            if (options.stopOnError && batchResults.some(r => !r.success)) {
                CSReporter.error('Stopping batch execution due to errors');
                break;
            }

            this.emit('batch:complete', { executionId, batchIndex, results: batchResults });

            // Delay between batches if configured
            if (options.delayBetweenBatches && batchIndex < batches.length - 1) {
                await this.delay(options.delayBetweenBatches);
            }
        }
    }

    private async executeRequest(request: CSRequestOptions, timeout?: number): Promise<CSResponse> {
        const requestWithTimeout = { ...request };
        if (timeout && !requestWithTimeout.timeout) {
            requestWithTimeout.timeout = timeout;
        }

        return this.apiClient.request(requestWithTimeout);
    }

    public async executeWorkflow(
        workflow: CSChainWorkflow,
        options: CSExecutionOptions
    ): Promise<CSExecutionResult> {
        const context = new CSApiChainContext(workflow.id);
        context.initialize(workflow);

        const executionId = this.generateExecutionId();
        const result: CSExecutionResult = {
            id: executionId,
            mode: 'workflow',
            totalRequests: workflow.steps.length,
            successfulRequests: 0,
            failedRequests: 0,
            responses: new Map(),
            validations: new Map(),
            errors: new Map(),
            duration: 0,
            status: 'success'
        };

        const startTime = Date.now();

        try {
            await context.start();

            // Group steps by dependency level for optimal parallel execution
            const stepGroups = this.groupStepsByDependency(workflow.steps);

            for (const group of stepGroups) {
                const parallelSteps = group.filter(step => !context.shouldSkipStep(step));

                if (parallelSteps.length === 0) continue;

                // Execute steps in parallel within each group
                const stepPromises = parallelSteps.map(async (step) => {
                    try {
                        const stepResult = await this.executeWorkflowStep(step, context);
                        context.saveStepResult(step.id, stepResult);

                        if (stepResult.response) {
                            result.responses.set(step.id, stepResult.response);
                        }

                        if (stepResult.validation) {
                            result.validations.set(step.id, stepResult.validation);
                        }

                        result.successfulRequests++;
                        workflow.onStepComplete?.(step, stepResult);

                    } catch (error) {
                        result.failedRequests++;
                        result.errors.set(step.id, error as Error);
                        context.addError(error as Error, step.id);
                        workflow.onError?.(error as Error, step);

                        if (!step.continueOnError && options.stopOnError) {
                            throw error;
                        }
                    }
                });

                await Promise.all(stepPromises);
            }

            await context.complete();

            if (context.hasErrors()) {
                result.status = result.successfulRequests > 0 ? 'partial' : 'failed';
            }

        } catch (error) {
            CSReporter.error(`Workflow execution failed: ${(error as Error).message}`);
            result.status = 'failed';
            context.cancel();
        } finally {
            result.duration = Date.now() - startTime;
            this.executionResults.set(executionId, result);
        }

        return result;
    }

    private async executeWorkflowStep(step: CSChainStep, context: CSApiChainContext): Promise<any> {
        switch (step.type) {
            case 'request':
                const response = await this.apiClient.request(step.config);
                context.saveResponse(step.id, response);
                return { response };

            case 'validation':
                const responseToValidate = context.getResponse(step.config.responseId);
                if (responseToValidate) {
                    const validation = await this.apiValidator.validate(responseToValidate, step.config.validations);
                    context.saveValidation(step.id, validation);
                    return { validation };
                }
                break;

            case 'extraction':
                const { responseId, path, variable } = step.config;
                const value = context.extractValue(responseId, path, variable);
                return { extracted: { [variable]: value } };

            case 'delay':
                await this.delay(step.config.delay);
                return { delayed: step.config.delay };

            default:
                CSReporter.warn(`Unknown step type: ${step.type}`);
        }

        return null;
    }

    private groupStepsByDependency(steps: CSChainStep[]): CSChainStep[][] {
        const groups: CSChainStep[][] = [];
        const processed = new Set<string>();

        while (processed.size < steps.length) {
            const group: CSChainStep[] = [];

            for (const step of steps) {
                if (processed.has(step.id)) continue;

                // Check if all dependencies are processed
                const canProcess = !step.dependencies ||
                    step.dependencies.every(dep => processed.has(dep));

                if (canProcess) {
                    group.push(step);
                }
            }

            if (group.length === 0) {
                // Circular dependency or error
                CSReporter.warn('Circular dependency detected in workflow steps');
                break;
            }

            group.forEach(step => processed.add(step.id));
            groups.push(group);
        }

        return groups;
    }

    public async executeChains(
        chains: CSApiChain[],
        options: CSExecutionOptions
    ): Promise<Map<string, CSExecutionResult>> {
        const results = new Map<string, CSExecutionResult>();

        if (options.mode === 'parallel') {
            const promises = chains.map(chain =>
                this.apiRunner.runChain(chain).then(responses => ({
                    chainId: chain.id,
                    responses
                }))
            );

            const chainResults = await Promise.all(promises);

            for (const { chainId, responses } of chainResults) {
                const result: CSExecutionResult = {
                    id: chainId,
                    mode: 'chain',
                    totalRequests: responses.size,
                    successfulRequests: responses.size,
                    failedRequests: 0,
                    responses,
                    validations: new Map(),
                    errors: new Map(),
                    duration: 0,
                    status: 'success'
                };
                results.set(chainId, result);
            }
        } else {
            for (const chain of chains) {
                const responses = await this.apiRunner.runChain(chain);
                const result: CSExecutionResult = {
                    id: chain.id,
                    mode: 'chain',
                    totalRequests: responses.size,
                    successfulRequests: responses.size,
                    failedRequests: 0,
                    responses,
                    validations: new Map(),
                    errors: new Map(),
                    duration: 0,
                    status: 'success'
                };
                results.set(chain.id, result);
            }
        }

        return results;
    }

    public abort(executionId: string): boolean {
        const controller = this.activeExecutions.get(executionId);
        if (controller) {
            controller.abort();
            this.activeExecutions.delete(executionId);
            CSReporter.info(`Execution aborted: ${executionId}`);
            this.emit('execution:abort', { executionId });
            return true;
        }
        return false;
    }

    public abortAll(): number {
        const count = this.activeExecutions.size;
        for (const [id, controller] of this.activeExecutions) {
            controller.abort();
            this.emit('execution:abort', { executionId: id });
        }
        this.activeExecutions.clear();
        CSReporter.info(`Aborted ${count} active executions`);
        return count;
    }

    private calculateMetrics(result: CSExecutionResult): CSExecutionMetrics {
        const responseTimes: number[] = [];
        const statusCodes = new Map<number, number>();
        let totalDataTransferred = 0;

        for (const response of result.responses.values()) {
            if (response.duration) {
                responseTimes.push(response.duration);
            }

            const status = response.status;
            statusCodes.set(status, (statusCodes.get(status) || 0) + 1);

            if (response.body) {
                const size = Buffer.isBuffer(response.body)
                    ? response.body.length
                    : Buffer.byteLength(JSON.stringify(response.body));
                totalDataTransferred += size;
            }
        }

        const avgResponseTime = responseTimes.length > 0
            ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
            : 0;

        const minResponseTime = responseTimes.length > 0
            ? Math.min(...responseTimes)
            : 0;

        const maxResponseTime = responseTimes.length > 0
            ? Math.max(...responseTimes)
            : 0;

        const requestsPerSecond = result.duration > 0
            ? (result.totalRequests / result.duration) * 1000
            : 0;

        return {
            avgResponseTime,
            minResponseTime,
            maxResponseTime,
            totalDataTransferred,
            requestsPerSecond,
            successRate: (result.successfulRequests / result.totalRequests) * 100,
            errorRate: (result.failedRequests / result.totalRequests) * 100,
            statusCodeDistribution: statusCodes
        };
    }

    private chunkArray<T>(array: T[], size: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private generateExecutionId(): string {
        return `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    public getExecutionResult(executionId: string): CSExecutionResult | undefined {
        return this.executionResults.get(executionId);
    }

    public getActiveExecutions(): string[] {
        return Array.from(this.activeExecutions.keys());
    }

    public clearResults(): void {
        this.executionResults.clear();
    }
}

export const apiExecutor = new CSAPIExecutor();