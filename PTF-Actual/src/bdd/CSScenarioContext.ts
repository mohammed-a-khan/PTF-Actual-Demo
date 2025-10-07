import { CSReporter } from '../reporter/CSReporter';

export class CSScenarioContext {
    private static instance: CSScenarioContext;
    private data: Map<string, any> = new Map();
    private currentScenario?: string;
    private scenarioTags: string[] = [];
    private scenarioStartTime?: number;
    private stepResults: Array<{ step: string; status: 'passed' | 'failed' | 'skipped'; duration: number; screenshot?: string }> = [];
    private totalScenarios: number = 0;
    private executionStartTime?: number;
    private currentStep?: { step: string; status: 'passed' | 'failed' | 'skipped'; duration: number; screenshot?: string };
    
    private constructor() {}
    
    public static getInstance(): CSScenarioContext {
        if (!CSScenarioContext.instance) {
            CSScenarioContext.instance = new CSScenarioContext();
        }
        return CSScenarioContext.instance;
    }
    
    public setCurrentScenario(scenarioName: string): void {
        this.currentScenario = scenarioName;
        this.scenarioStartTime = Date.now();
        this.stepResults = [];
        this.totalScenarios++;
        if (!this.executionStartTime) {
            this.executionStartTime = Date.now();
        }
        CSReporter.debug(`Scenario context set: ${scenarioName}`);
    }
    
    public getCurrentScenario(): string | undefined {
        return this.currentScenario;
    }
    
    public setScenarioTags(tags: string[]): void {
        this.scenarioTags = tags;
    }
    
    public getScenarioTags(): string[] {
        return this.scenarioTags;
    }
    
    public hasTag(tag: string): boolean {
        return this.scenarioTags.includes(tag);
    }
    
    public set(key: string, value: any): void {
        this.data.set(key, value);
        CSReporter.debug(`Scenario context data set: ${key}`);
    }
    
    public get<T = any>(key: string): T | undefined {
        return this.data.get(key);
    }
    
    public has(key: string): boolean {
        return this.data.has(key);
    }
    
    public delete(key: string): boolean {
        return this.data.delete(key);
    }
    
    public getAll(): Map<string, any> {
        return new Map(this.data);
    }
    
    public clear(): void {
        this.data.clear();
        this.scenarioTags = [];
        this.currentScenario = undefined;
        this.scenarioStartTime = undefined;
        this.stepResults = [];
        // Don't reset totalScenarios or executionStartTime - these persist across scenarios
        CSReporter.debug('Scenario context cleared');
    }
    
    public getExecutionTime(): number {
        if (!this.scenarioStartTime) return 0;
        return Date.now() - this.scenarioStartTime;
    }
    
    // Step result tracking
    public addStepResult(step: string, status: 'passed' | 'failed' | 'skipped', duration: number, screenshot?: string, actions?: any[]): void {
        const stepResult = {
            step,
            status,
            duration,
            screenshot: screenshot || this.currentStep?.screenshot,
            actions: actions || []
        };
        this.stepResults.push(stepResult);
        // Don't clear currentStep here - it needs to be available for screenshot attachment in catch block
        // Clear will be done manually after screenshot is attached
    }

    // Current step management
    public setCurrentStep(step: string): void {
        this.currentStep = { step, status: 'passed', duration: 0 };
    }

    public getCurrentStep(): any {
        return this.currentStep;
    }

    // Clear current step after all processing is complete
    public clearCurrentStep(): void {
        this.currentStep = undefined;
    }

    // Set screenshot for current step
    public setCurrentStepScreenshot(screenshotPath: string): void {
        if (this.currentStep) {
            // Store just the filename for the report to construct relative path
            const path = require('path');
            this.currentStep.screenshot = path.basename(screenshotPath);
        }
    }

    public getStepResults(): Array<{ step: string; status: 'passed' | 'failed' | 'skipped'; duration: number; screenshot?: string; actions?: any[] }> {
        return this.stepResults;
    }
    
    public getPassedSteps(): number {
        return this.stepResults.filter(r => r.status === 'passed').length;
    }
    
    public getFailedSteps(): number {
        return this.stepResults.filter(r => r.status === 'failed').length;
    }
    
    public getSkippedSteps(): number {
        return this.stepResults.filter(r => r.status === 'skipped').length;
    }
    
    // Store scenario-level test data
    public storeTestData(key: string, data: any): void {
        const testData = this.get<Map<string, any>>('testData') || new Map();
        testData.set(key, data);
        this.set('testData', testData);
    }
    
    public getTestData<T = any>(key: string): T | undefined {
        const testData = this.get<Map<string, any>>('testData');
        return testData?.get(key);
    }
    
    // Store scenario-level variables
    public setVariable(name: string, value: any): void {
        const variables = this.get<Map<string, any>>('variables') || new Map();
        variables.set(name, value);
        this.set('variables', variables);
    }
    
    public getVariable<T = any>(name: string): T | undefined {
        const variables = this.get<Map<string, any>>('variables');
        return variables?.get(name);
    }
    
    public getAllVariables(): Map<string, any> {
        return this.get<Map<string, any>>('variables') || new Map();
    }
    
    // Store scenario-level assertions
    public addAssertion(description: string, passed: boolean, actual?: any, expected?: any): void {
        const assertions = this.get<Array<any>>('assertions') || [];
        assertions.push({
            description,
            passed,
            actual,
            expected,
            timestamp: Date.now()
        });
        this.set('assertions', assertions);
    }
    
    public getAssertions(): Array<any> {
        return this.get<Array<any>>('assertions') || [];
    }
    
    public getAssertionSummary(): { total: number; passed: number; failed: number } {
        const assertions = this.getAssertions();
        return {
            total: assertions.length,
            passed: assertions.filter(a => a.passed).length,
            failed: assertions.filter(a => !a.passed).length
        };
    }
    
    // Store scenario-level screenshots
    public addScreenshot(path: string, description?: string): void {
        const screenshots = this.get<Array<{ path: string; description?: string; timestamp: number }>>('screenshots') || [];
        screenshots.push({
            path,
            description,
            timestamp: Date.now()
        });
        this.set('screenshots', screenshots);
    }
    
    public getScreenshots(): Array<{ path: string; description?: string; timestamp: number }> {
        return this.get<Array<{ path: string; description?: string; timestamp: number }>>('screenshots') || [];
    }
    
    // Store scenario-level logs
    public addLog(level: 'info' | 'warn' | 'error' | 'debug', message: string): void {
        const logs = this.get<Array<{ level: string; message: string; timestamp: number }>>('logs') || [];
        logs.push({
            level,
            message,
            timestamp: Date.now()
        });
        this.set('logs', logs);
    }
    
    public getLogs(): Array<{ level: string; message: string; timestamp: number }> {
        return this.get<Array<{ level: string; message: string; timestamp: number }>>('logs') || [];
    }
    
    // Debug helper
    public debug(): void {
        console.log('=== Scenario Context Debug ===');
        console.log('Current Scenario:', this.currentScenario);
        console.log('Scenario Tags:', this.scenarioTags);
        console.log('Execution Time:', this.getExecutionTime(), 'ms');
        console.log('Step Results:', this.stepResults);
        console.log('Data:', Array.from(this.data.entries()));
        console.log('Variables:', Array.from(this.getAllVariables().entries()));
        console.log('Assertion Summary:', this.getAssertionSummary());
        console.log('Screenshots:', this.getScreenshots().length);
        console.log('Logs:', this.getLogs().length);
    }
    
    // Report generation helpers
    public getTotalScenarios(): number {
        return this.totalScenarios;
    }
    
    public getDuration(): number {
        if (!this.executionStartTime) return 0;
        return Date.now() - this.executionStartTime;
    }
    
    public resetStats(): void {
        this.totalScenarios = 0;
        this.executionStartTime = undefined;
    }
}