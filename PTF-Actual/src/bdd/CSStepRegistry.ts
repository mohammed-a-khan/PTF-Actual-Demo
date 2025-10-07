// Removed Cucumber imports - using our own BDD implementation
import { CSBrowserManager } from '../browser/CSBrowserManager';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';
import { registerStepDefinition } from './CSBDDDecorators';

export interface StepDefinition {
    pattern: string | RegExp;
    handler: Function;
    timeout?: number;
}

export interface WorldContext {
    config: CSConfigurationManager;
    browserManager: CSBrowserManager;
    reporter: typeof CSReporter;
    testData: any;
    sharedData: any;
    currentScenario?: any;
    parameters?: any;
    stepResults: StepResult[];
    scenarioContext: Map<string, any>;
    setContext: (key: string, value: any) => void;
    getContext: (key: string) => any;
    addStepResult: (result: StepResult) => void;
    getLastStepResult: () => StepResult | undefined;
    clearContext: () => void;
}

export interface StepResult {
    stepName: string;
    status: 'passed' | 'failed' | 'skipped';
    duration: number;
    error?: Error;
    data?: any;
}

export class CSStepRegistry {
    private static instance: CSStepRegistry;
    private steps: Map<string, StepDefinition[]> = new Map();
    private config: CSConfigurationManager;

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.initializeWorld();
        this.registerHooks();
        this.setDefaultTimeouts();
    }

    public static getInstance(): CSStepRegistry {
        if (!CSStepRegistry.instance) {
            CSStepRegistry.instance = new CSStepRegistry();
        }
        return CSStepRegistry.instance;
    }

    private initializeWorld(): void {
        // Initialize world context without Cucumber
        // This will be managed by CSBDDContext instead
        /*
            this.config = CSConfigurationManager.getInstance();
            this.browserManager = CSBrowserManager.getInstance();
            this.reporter = CSReporter;
            this.testData = {};
            this.sharedData = {};
            this.parameters = parameters;
            this.stepResults = [];
            this.scenarioContext = new Map<string, any>();
            
            // Add helper methods to World
            this.setContext = (key: string, value: any) => {
                this.scenarioContext.set(key, value);
            };
            
            this.getContext = (key: string) => {
                return this.scenarioContext.get(key);
            };
            
            this.addStepResult = (result: StepResult) => {
                this.stepResults.push(result);
            };
            
            this.getLastStepResult = () => {
                return this.stepResults[this.stepResults.length - 1];
            };
            
            this.clearContext = () => {
                this.scenarioContext.clear();
                this.stepResults = [];
            };
        */
    }

    private setDefaultTimeouts(): void {
        const timeout = this.config.getNumber('TIMEOUT', 30000);

        // Store timeout in config for use by BDD Runner
        this.config.set('TIMEOUT', timeout.toString());
        
        CSReporter.debug(`BDD timeout configured: ${timeout}ms`);
    }

    private registerHooks(): void {
        // Hooks will be managed by CSBDDRunner directly
        /*
            CSReporter.info('Starting test suite execution');
            
            // Initialize configuration
            const config = CSConfigurationManager.getInstance();
            await config.initialize();
            
            // Print configuration if debug mode
            if (config.getBoolean('DEBUG_MODE', false)) {
                config.debug();
            }
        });

        // Before each scenario
        Before({ timeout: 30000 }, async function(this: any, scenario: any) {
            CSReporter.startTest(scenario.pickle.name);
            
            // Launch browser based on reuse configuration
            const browserReuseEnabled = this.config.getBoolean('BROWSER_REUSE_ENABLED', false);

            if (!browserReuseEnabled || !this.browserManager.getBrowser()) {
                await this.browserManager.launch();
            }
            
            // Store scenario context
            this.currentScenario = scenario;
        });

        // After each scenario
        After({ timeout: 30000 }, async function(this: any, scenario: any) {
            const status = scenario.result?.status === 'PASSED' ? 'pass' : 'fail';
            const error = scenario.result?.message;
            
            if (status === 'fail' && error) {
                CSReporter.failScenario(error);
            } else {
                CSReporter.endTest(status);
            }
            
            // Handle browser based on reuse configuration
            const browserReuseEnabled = this.config.getBoolean('BROWSER_REUSE_ENABLED', false);

            if (!browserReuseEnabled) {
                await this.browserManager.close();
            } else {
                // Keep browser open for reuse
                await this.browserManager.closePage();
                await this.browserManager.closeContext();
            }
            
            // Clear test data
            this.testData = {};
        });

        // Before each step
        BeforeStep({ timeout: 5000 }, async function(this: WorldContext, { pickleStep }: any) {
            const stepName = pickleStep.text;
            CSReporter.debug(`Starting step: ${stepName}`);
            
            // Store current step context
            this.setContext('currentStep', {
                name: stepName,
                startTime: Date.now(),
                type: pickleStep.type
            });
        });

        // After each step
        AfterStep({ timeout: 10000 }, async function(this: WorldContext, { result, pickleStep }: any) {
            const stepName = pickleStep.text;
            const stepContext = this.getContext('currentStep');
            const duration = stepContext ? Date.now() - stepContext.startTime : 0;
            
            const stepResult: StepResult = {
                stepName,
                status: result.status === 'PASSED' ? 'passed' : result.status === 'FAILED' ? 'failed' : 'skipped',
                duration,
                error: result.message ? new Error(result.message) : undefined
            };
            
            this.addStepResult(stepResult);
            
            if (result.status === 'PASSED') {
                CSReporter.debug(`Step completed: ${stepName} - Duration: ${duration}ms`);
            } else if (result.status === 'FAILED') {
                CSReporter.warn(`Step failed: ${stepName} - ${result.message || 'Unknown error'}`);
                
                // Take screenshot on step failure if configured
                if (this.config.getBoolean('SCREENSHOT_ON_STEP_FAILURE', false)) {
                    try {
                        const page = this.browserManager.getPage();
                        if (page) {
                            // Get the current test results directory from CSTestResultsManager
                            const CSTestResultsManager = require('../reporter/CSTestResultsManager').CSTestResultsManager;
                            const resultsManager = CSTestResultsManager.getInstance();
                            const dirs = resultsManager.getDirectories();
                            const screenshotDir = dirs.screenshots;

                            // Ensure screenshot directory exists
                            const fs = require('fs');
                            if (!fs.existsSync(screenshotDir)) {
                                fs.mkdirSync(screenshotDir, { recursive: true });
                            }

                            const screenshotName = `step-failure-${Date.now()}.png`;
                            const screenshotPath = `${screenshotDir}/${screenshotName}`;
                            await page.screenshot({ path: screenshotPath });
                            CSReporter.debug(`Step failure screenshot captured: ${screenshotPath}`);
                            
                            // Attach screenshot to the result
                            result.screenshot = screenshotPath;
                            
                            // Also try to attach to scenario context if available
                            if (this.scenarioContext && typeof (this.scenarioContext as any).getCurrentStep === 'function') {
                                const currentStep = (this.scenarioContext as any).getCurrentStep();
                                if (currentStep) {
                                    currentStep.screenshot = screenshotPath;
                                }
                            }
                        }
                    } catch (error) {
                        CSReporter.debug(`Failed to capture step failure screenshot: ${(error as Error).message}`);
                    }
                }
            }
        });

        // After all tests
        AfterAll({ timeout: 60000 }, async function() {
            CSReporter.info('Completing test suite execution');
            
            // Close all browsers
            await CSBrowserManager.getInstance().closeAll();
            
            // Generate final reports
            await CSReporter.generateReports();
        });
        */
    }

    public registerStep(pattern: string | RegExp, handler: Function, timeout?: number, stepClass?: any): void {
        const step: StepDefinition = { pattern, handler, timeout };
        
        // Store the step class if provided
        if (stepClass) {
            (step as any).stepClass = stepClass;
        }
        
        // Register with our BDD Decorators instead of Cucumber
        registerStepDefinition(pattern, handler, { timeout, stepClass });
        
        // Store in registry for tracking
        const key = pattern.toString();
        if (!this.steps.has(key)) {
            this.steps.set(key, []);
        }
        this.steps.get(key)!.push(step);
    }

    public getSteps(): Map<string, StepDefinition[]> {
        return this.steps;
    }

    // Scenario Outline support
    public registerOutlineSteps(examples: any[]): void {
        for (const example of examples) {
            CSReporter.debug(`Processing scenario outline example: ${JSON.stringify(example)}`);
        }
    }

    // Helper methods for step management
    public getStepCount(): number {
        let count = 0;
        for (const stepList of this.steps.values()) {
            count += stepList.length;
        }
        return count;
    }

    public findStepsByPattern(pattern: string): StepDefinition[] {
        const results: StepDefinition[] = [];
        for (const [key, stepList] of this.steps.entries()) {
            if (key.includes(pattern)) {
                results.push(...stepList);
            }
        }
        return results;
    }

    public getStepStats(): { total: number; byType: Record<string, number> } {
        const stats = { total: 0, byType: {} as Record<string, number> };
        
        for (const stepList of this.steps.values()) {
            stats.total += stepList.length;
            for (const step of stepList) {
                const type = step.pattern instanceof RegExp ? 'regex' : 'string';
                stats.byType[type] = (stats.byType[type] || 0) + 1;
            }
        }
        
        return stats;
    }

    // World context helpers
    public static attachToWorld(worldInstance: any, data: any): void {
        worldInstance.attachedData = { ...worldInstance.attachedData, ...data };
    }

    public static getFromWorld(worldInstance: any, key: string): any {
        return worldInstance.attachedData?.[key];
    }
}

// Decorator for step definitions
export function CSBDDStepDef(description: string, timeout?: number): any {
    return function(target: any, propertyKey: string | symbol | any, descriptor?: PropertyDescriptor): any {
        // Handle both old and new decorator API
        const actualPropertyKey = typeof propertyKey === 'string' ? propertyKey : propertyKey.name;
        const actualDescriptor = descriptor || Object.getOwnPropertyDescriptor(target, actualPropertyKey);

        if (!actualDescriptor) return;

        const registry = CSStepRegistry.getInstance();
        // Pass the step class (target.constructor) to the registry
        registry.registerStep(description, actualDescriptor.value, timeout, target.constructor);

        return actualDescriptor;
    };
}

// Data provider decorator
export function CSDataProvider(source: string, options?: any) {
    return function(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;
        
        descriptor.value = async function(...args: any[]) {
            const data = await loadDataFromSource(source, options);
            
            for (const row of data) {
                // Inject data into context
                (this as any).testData = row;
                await originalMethod.apply(this, args);
            }
        };
        
        return descriptor;
    };
}

async function loadDataFromSource(source: string, options?: any): Promise<any[]> {
    const config = CSConfigurationManager.getInstance();
    
    // Determine source type
    if (source.endsWith('.xlsx') || source.endsWith('.xls')) {
        return await loadExcelData(source, options);
    } else if (source.endsWith('.csv')) {
        return await loadCSVData(source);
    } else if (source.endsWith('.json')) {
        return await loadJSONData(source);
    } else if (source.startsWith('api:')) {
        return await loadAPIData(source.substring(4));
    } else if (source.startsWith('db:')) {
        return await loadDatabaseData(source.substring(3));
    }
    
    return [];
}

async function loadExcelData(filePath: string, options?: any): Promise<any[]> {
    const XLSX = require('xlsx');
    const workbook = XLSX.readFile(filePath);
    const sheetName = options?.sheet || workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    return XLSX.utils.sheet_to_json(sheet);
}

async function loadCSVData(filePath: string): Promise<any[]> {
    const fs = require('fs');
    const { parse } = require('csv-parse/sync');
    const content = fs.readFileSync(filePath, 'utf8');
    return parse(content, { columns: true });
}

async function loadJSONData(filePath: string): Promise<any[]> {
    const fs = require('fs');
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
}

async function loadAPIData(endpoint: string): Promise<any[]> {
    // Placeholder for API data loading
    CSReporter.debug(`Loading data from API: ${endpoint}`);
    return [];
}

async function loadDatabaseData(query: string): Promise<any[]> {
    // Placeholder for database data loading
    CSReporter.debug(`Loading data from database: ${query}`);
    return [];
}