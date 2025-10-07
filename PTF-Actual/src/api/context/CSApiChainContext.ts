import { CSResponse, CSRequestOptions, CSValidationResult } from '../types/CSApiTypes';
import { CSReporter } from '../../reporter/CSReporter';

export interface CSChainState {
    id: string;
    currentStep: number;
    totalSteps: number;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    startTime?: number;
    endTime?: number;
    duration?: number;
    variables: Map<string, any>;
    responses: Map<string, CSResponse>;
    validations: Map<string, CSValidationResult>;
    errors: Error[];
    metadata: Map<string, any>;
}

export interface CSChainStep {
    id: string;
    name?: string;
    type: 'request' | 'validation' | 'extraction' | 'transformation' | 'condition' | 'loop' | 'delay' | 'parallel' | 'script';
    config: any;
    dependencies?: string[];
    condition?: (context: CSApiChainContext) => boolean;
    retries?: number;
    timeout?: number;
    continueOnError?: boolean;
    parallel?: boolean;
}

export interface CSChainWorkflow {
    id: string;
    name: string;
    description?: string;
    steps: CSChainStep[];
    variables?: Record<string, any>;
    setup?: () => Promise<void>;
    teardown?: () => Promise<void>;
    onStepComplete?: (step: CSChainStep, result: any) => void;
    onError?: (error: Error, step?: CSChainStep) => void;
}

export class CSApiChainContext {
    private state: CSChainState;
    private workflow?: CSChainWorkflow;
    private stepResults: Map<string, any>;
    private extractedValues: Map<string, any>;
    private conditionalFlags: Map<string, boolean>;
    private loopCounters: Map<string, number>;
    private parallelPromises: Map<string, Promise<any>>;
    private abortController?: AbortController;

    constructor(id: string) {
        this.state = {
            id,
            currentStep: 0,
            totalSteps: 0,
            status: 'pending',
            variables: new Map(),
            responses: new Map(),
            validations: new Map(),
            errors: [],
            metadata: new Map()
        };
        this.stepResults = new Map();
        this.extractedValues = new Map();
        this.conditionalFlags = new Map();
        this.loopCounters = new Map();
        this.parallelPromises = new Map();
    }

    public initialize(workflow: CSChainWorkflow): void {
        this.workflow = workflow;
        this.state.totalSteps = workflow.steps.length;
        this.state.status = 'pending';

        // Initialize variables
        if (workflow.variables) {
            for (const [key, value] of Object.entries(workflow.variables)) {
                this.state.variables.set(key, value);
            }
        }

        CSReporter.info(`Chain context initialized: ${workflow.name}`);
    }

    public async start(): Promise<void> {
        if (!this.workflow) {
            throw new Error('Workflow not initialized');
        }

        if (this.state.status !== 'pending') {
            throw new Error(`Cannot start chain in ${this.state.status} status`);
        }

        this.state.status = 'running';
        this.state.startTime = Date.now();
        this.abortController = new AbortController();

        // Run setup if defined
        if (this.workflow.setup) {
            try {
                await this.workflow.setup();
            } catch (error) {
                CSReporter.error(`Setup failed: ${(error as Error).message}`);
                this.state.errors.push(error as Error);
            }
        }

        CSReporter.info(`Chain started: ${this.workflow.name}`);
    }

    public async complete(): Promise<void> {
        if (!this.workflow) {
            throw new Error('Workflow not initialized');
        }

        // Wait for any pending parallel operations
        if (this.parallelPromises.size > 0) {
            await Promise.allSettled(Array.from(this.parallelPromises.values()));
        }

        // Run teardown if defined
        if (this.workflow.teardown) {
            try {
                await this.workflow.teardown();
            } catch (error) {
                CSReporter.error(`Teardown failed: ${(error as Error).message}`);
                this.state.errors.push(error as Error);
            }
        }

        this.state.status = this.state.errors.length > 0 ? 'failed' : 'completed';
        this.state.endTime = Date.now();
        this.state.duration = this.state.endTime - (this.state.startTime || 0);

        CSReporter.info(`Chain completed: ${this.workflow.name} (${this.state.duration}ms)`);
    }

    public cancel(): void {
        this.state.status = 'cancelled';
        this.abortController?.abort();

        // Cancel parallel promises
        this.parallelPromises.clear();

        CSReporter.info(`Chain cancelled: ${this.state.id}`);
    }

    public setCurrentStep(stepIndex: number): void {
        this.state.currentStep = stepIndex;
    }

    public incrementStep(): void {
        this.state.currentStep++;
    }

    public isStepReady(step: CSChainStep): boolean {
        if (!step.dependencies || step.dependencies.length === 0) {
            return true;
        }

        // Check if all dependencies are completed
        for (const dep of step.dependencies) {
            if (!this.stepResults.has(dep)) {
                return false;
            }
        }

        return true;
    }

    public shouldSkipStep(step: CSChainStep): boolean {
        if (step.condition) {
            try {
                return !step.condition(this);
            } catch (error) {
                CSReporter.warn(`Step condition evaluation failed: ${(error as Error).message}`);
                return true;
            }
        }

        return false;
    }

    public saveStepResult(stepId: string, result: any): void {
        this.stepResults.set(stepId, result);
        CSReporter.debug(`Step result saved: ${stepId}`);
    }

    public getStepResult(stepId: string): any {
        return this.stepResults.get(stepId);
    }

    public saveResponse(key: string, response: CSResponse): void {
        this.state.responses.set(key, response);
    }

    public getResponse(key: string): CSResponse | undefined {
        return this.state.responses.get(key);
    }

    public saveValidation(key: string, validation: CSValidationResult): void {
        this.state.validations.set(key, validation);
    }

    public getValidation(key: string): CSValidationResult | undefined {
        return this.state.validations.get(key);
    }

    public setVariable(key: string, value: any): void {
        this.state.variables.set(key, value);
    }

    public getVariable(key: string): any {
        return this.state.variables.get(key);
    }

    public hasVariable(key: string): boolean {
        return this.state.variables.has(key);
    }

    public extractValue(responseKey: string, path: string, variableName: string): any {
        const response = this.state.responses.get(responseKey);
        if (!response) {
            throw new Error(`Response '${responseKey}' not found`);
        }

        const value = this.extractFromPath(response.body, path);
        this.extractedValues.set(variableName, value);
        this.setVariable(variableName, value);

        CSReporter.debug(`Extracted ${variableName} from ${responseKey}.${path}`);
        return value;
    }

    private extractFromPath(data: any, path: string): any {
        const parts = path.split('.');
        let current = data;

        for (const part of parts) {
            if (current === null || current === undefined) {
                return undefined;
            }

            // Handle array index
            const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
            if (arrayMatch) {
                current = current[arrayMatch[1]];
                if (Array.isArray(current)) {
                    current = current[parseInt(arrayMatch[2])];
                }
            } else {
                current = current[part];
            }
        }

        return current;
    }

    public setConditionalFlag(name: string, value: boolean): void {
        this.conditionalFlags.set(name, value);
    }

    public getConditionalFlag(name: string): boolean | undefined {
        return this.conditionalFlags.get(name);
    }

    public initializeLoop(name: string, count: number = 0): void {
        this.loopCounters.set(name, count);
    }

    public incrementLoop(name: string): number {
        const current = this.loopCounters.get(name) || 0;
        const next = current + 1;
        this.loopCounters.set(name, next);
        return next;
    }

    public getLoopCounter(name: string): number {
        return this.loopCounters.get(name) || 0;
    }

    public registerParallelOperation(id: string, promise: Promise<any>): void {
        this.parallelPromises.set(id, promise);

        // Clean up when promise resolves
        promise.finally(() => {
            this.parallelPromises.delete(id);
        });
    }

    public async waitForParallelOperations(ids?: string[]): Promise<void> {
        const promises = ids
            ? ids.map(id => this.parallelPromises.get(id)).filter(Boolean)
            : Array.from(this.parallelPromises.values());

        if (promises.length > 0) {
            await Promise.allSettled(promises as Promise<any>[]);
        }
    }

    public addError(error: Error, stepId?: string): void {
        this.state.errors.push(error);
        if (stepId) {
            CSReporter.error(`Error in step '${stepId}': ${error.message}`);
        }
    }

    public getErrors(): Error[] {
        return [...this.state.errors];
    }

    public hasErrors(): boolean {
        return this.state.errors.length > 0;
    }

    public setMetadata(key: string, value: any): void {
        this.state.metadata.set(key, value);
    }

    public getMetadata(key?: string): any {
        if (key) {
            return this.state.metadata.get(key);
        }
        return Object.fromEntries(this.state.metadata);
    }

    public getState(): CSChainState {
        return {
            ...this.state,
            variables: new Map(this.state.variables),
            responses: new Map(this.state.responses),
            validations: new Map(this.state.validations),
            metadata: new Map(this.state.metadata),
            errors: [...this.state.errors]
        };
    }

    public getProgress(): number {
        if (this.state.totalSteps === 0) return 0;
        return (this.state.currentStep / this.state.totalSteps) * 100;
    }

    public getStatus(): string {
        return this.state.status;
    }

    public isRunning(): boolean {
        return this.state.status === 'running';
    }

    public isCompleted(): boolean {
        return this.state.status === 'completed';
    }

    public isFailed(): boolean {
        return this.state.status === 'failed';
    }

    public isCancelled(): boolean {
        return this.state.status === 'cancelled';
    }

    public getDuration(): number | undefined {
        if (this.state.startTime) {
            if (this.state.endTime) {
                return this.state.endTime - this.state.startTime;
            }
            return Date.now() - this.state.startTime;
        }
        return undefined;
    }

    public getAbortSignal(): AbortSignal | undefined {
        return this.abortController?.signal;
    }

    public clone(): CSApiChainContext {
        const cloned = new CSApiChainContext(`${this.state.id}_clone`);

        // Clone state
        cloned.state = {
            ...this.state,
            variables: new Map(this.state.variables),
            responses: new Map(this.state.responses),
            validations: new Map(this.state.validations),
            metadata: new Map(this.state.metadata),
            errors: [...this.state.errors]
        };

        // Clone other maps
        cloned.stepResults = new Map(this.stepResults);
        cloned.extractedValues = new Map(this.extractedValues);
        cloned.conditionalFlags = new Map(this.conditionalFlags);
        cloned.loopCounters = new Map(this.loopCounters);

        // Don't clone parallel promises or workflow
        return cloned;
    }

    public export(): any {
        return {
            state: {
                id: this.state.id,
                currentStep: this.state.currentStep,
                totalSteps: this.state.totalSteps,
                status: this.state.status,
                startTime: this.state.startTime,
                endTime: this.state.endTime,
                duration: this.state.duration,
                variables: Array.from(this.state.variables.entries()),
                responseCount: this.state.responses.size,
                validationCount: this.state.validations.size,
                errorCount: this.state.errors.length,
                metadata: Array.from(this.state.metadata.entries())
            },
            stepResults: Array.from(this.stepResults.keys()),
            extractedValues: Array.from(this.extractedValues.entries()),
            conditionalFlags: Array.from(this.conditionalFlags.entries()),
            loopCounters: Array.from(this.loopCounters.entries())
        };
    }

    public import(data: any): void {
        if (data.state) {
            if (data.state.variables) {
                this.state.variables.clear();
                data.state.variables.forEach(([key, value]: [string, any]) => {
                    this.state.variables.set(key, value);
                });
            }

            if (data.state.metadata) {
                this.state.metadata.clear();
                data.state.metadata.forEach(([key, value]: [string, any]) => {
                    this.state.metadata.set(key, value);
                });
            }
        }

        if (data.extractedValues) {
            this.extractedValues.clear();
            data.extractedValues.forEach(([key, value]: [string, any]) => {
                this.extractedValues.set(key, value);
            });
        }

        if (data.conditionalFlags) {
            this.conditionalFlags.clear();
            data.conditionalFlags.forEach(([key, value]: [string, boolean]) => {
                this.conditionalFlags.set(key, value);
            });
        }

        if (data.loopCounters) {
            this.loopCounters.clear();
            data.loopCounters.forEach(([key, value]: [string, number]) => {
                this.loopCounters.set(key, value);
            });
        }
    }

    public reset(): void {
        this.state.currentStep = 0;
        this.state.status = 'pending';
        this.state.startTime = undefined;
        this.state.endTime = undefined;
        this.state.duration = undefined;
        this.state.errors = [];
        this.stepResults.clear();
        this.extractedValues.clear();
        this.conditionalFlags.clear();
        this.loopCounters.clear();
        this.parallelPromises.clear();
    }
}

export class CSApiChainManager {
    private static instance: CSApiChainManager;
    private contexts: Map<string, CSApiChainContext>;
    private activeContext?: string;

    private constructor() {
        this.contexts = new Map();
    }

    public static getInstance(): CSApiChainManager {
        if (!CSApiChainManager.instance) {
            CSApiChainManager.instance = new CSApiChainManager();
        }
        return CSApiChainManager.instance;
    }

    public createContext(id: string): CSApiChainContext {
        const context = new CSApiChainContext(id);
        this.contexts.set(id, context);
        return context;
    }

    public getContext(id: string): CSApiChainContext | undefined {
        return this.contexts.get(id);
    }

    public getActiveContext(): CSApiChainContext | undefined {
        return this.activeContext ? this.contexts.get(this.activeContext) : undefined;
    }

    public setActiveContext(id: string): void {
        if (this.contexts.has(id)) {
            this.activeContext = id;
        }
    }

    public removeContext(id: string): boolean {
        if (this.activeContext === id) {
            this.activeContext = undefined;
        }
        return this.contexts.delete(id);
    }

    public listContexts(): string[] {
        return Array.from(this.contexts.keys());
    }

    public clearAll(): void {
        this.contexts.clear();
        this.activeContext = undefined;
    }

    public getRunningContexts(): CSApiChainContext[] {
        const running: CSApiChainContext[] = [];
        for (const context of this.contexts.values()) {
            if (context.isRunning()) {
                running.push(context);
            }
        }
        return running;
    }

    public cancelAll(): void {
        for (const context of this.contexts.values()) {
            if (context.isRunning()) {
                context.cancel();
            }
        }
    }
}

export const chainManager = CSApiChainManager.getInstance();