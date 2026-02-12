import 'reflect-metadata';
import { CSReporter } from '../reporter/CSReporter';
import { CSBDDContext } from './CSBDDContext';
import { CSFeatureContext } from './CSFeatureContext';
import { CSScenarioContext } from './CSScenarioContext';
import { CSValueResolver } from '../utils/CSValueResolver';

// Lazy load intelligent step executor for zero-code feature
let CSIntelligentStepExecutor: any = null;

export interface StepDefinitionOptions {
    timeout?: number;
    retry?: number;
    tags?: string[];
    order?: number;
    description?: string;
    stepClass?: any;
}

export interface StepDefinition {
    pattern: RegExp | string;
    handler: Function;
    options?: StepDefinitionOptions;
    type: 'Given' | 'When' | 'Then' | 'And' | 'But';
    stepClass?: any; // Reference to the step definition class
}

// Use a global singleton for step definitions to avoid module instance issues
// Force single instance across all module loads
const GLOBAL_KEY = '__CS_STEP_DEFINITIONS_MAP__';

// Initialize only once
if (!(global as any)[GLOBAL_KEY]) {
    (global as any)[GLOBAL_KEY] = new Map<string, StepDefinition[]>();
    // Also mark that we've initialized it
    (global as any).__CS_STEP_DEFS_INITIALIZED__ = true;
}

const stepDefinitions: Map<string, StepDefinition[]> = (global as any)[GLOBAL_KEY];

// Register a step definition globally
export function registerStepDefinition(pattern: string | RegExp, handler: Function, options?: StepDefinitionOptions): void {
    const stepDef: StepDefinition = {
        pattern,
        handler,
        options,
        type: 'Given' // Default type, will work for all
    };

    const className = 'global'; // Use 'global' as key for all steps
    if (!stepDefinitions.has(className)) {
        stepDefinitions.set(className, []);
    }
    stepDefinitions.get(className)!.push(stepDef);
}

// Legacy decorators removed - use @CSBDDStepDef from CSStepRegistry instead

export function CSBefore(options?: { tags?: string[], order?: number }) {
    return function(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        registerHook('before', descriptor.value, options, target.constructor.name);
        return descriptor;
    };
}

export function CSAfter(options?: { tags?: string[], order?: number }) {
    return function(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        registerHook('after', descriptor.value, options, target.constructor.name);
        return descriptor;
    };
}

export function CSBeforeStep(options?: { tags?: string[], order?: number }) {
    return function(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        registerHook('beforeStep', descriptor.value, options, target.constructor.name);
        return descriptor;
    };
}

export function CSAfterStep(options?: { tags?: string[], order?: number }) {
    return function(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        registerHook('afterStep', descriptor.value, options, target.constructor.name);
        return descriptor;
    };
}

// registerStepDefinition removed - using CSStepRegistry instead

function createRegexFromString(pattern: string): RegExp {
    // Convert Cucumber expressions to regex
    // Support both single quotes ('...') and double quotes ("...") for {string}
    // Use alternation so opening " matches closing " (allowing ' inside), and vice versa
    let regexPattern = pattern
        .replace(/\{string\}/g, '(?:"([^"]*)"|\'([^\']*)\')')
        .replace(/\{int\}/g, '(\\d+)')
        .replace(/\{float\}/g, '([+-]?\\d*\\.?\\d+)')
        .replace(/\{word\}/g, '(\\w+)')
        .replace(/\{.*?\}/g, '(.*?)');

    return new RegExp(`^${regexPattern}$`);
}

interface Hook {
    type: 'before' | 'after' | 'beforeStep' | 'afterStep';
    handler: Function;
    options?: { tags?: string[], order?: number };
}

const hooks: Hook[] = [];

function registerHook(
    type: 'before' | 'after' | 'beforeStep' | 'afterStep',
    handler: Function,
    options?: { tags?: string[], order?: number },
    className?: string
) {
    hooks.push({
        type,
        handler,
        options
    });
    
    CSReporter.debug(`Registered ${type} hook`);
}

// Helper function to convert pattern to regex
function patternToRegex(pattern: string | RegExp): RegExp {
    if (pattern instanceof RegExp) return pattern;

    if (typeof pattern === 'string') {
        // First escape special regex characters
        let regexPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Then replace Cucumber placeholders with regex groups
        // Support both single quotes ('...') and double quotes ("...") for {string}
        // Use alternation so opening " matches closing " (allowing ' inside), and vice versa
        regexPattern = regexPattern.replace(/\\\{string\\\}/g, '(?:"([^"]*)"|\'([^\']*)\')');

        regexPattern = regexPattern.replace(/\\\{int\\\}/g, '(\\d+)');
        regexPattern = regexPattern.replace(/\\\{float\\\}/g, '([\\d\\.]+)');
        regexPattern = regexPattern.replace(/\\\{word\\\}/g, '(\\w+)');

        return new RegExp(`^${regexPattern}$`);
    }

    return new RegExp(`^${pattern}$`);
}

export function findStepDefinition(stepText: string, stepType?: string): StepDefinition | undefined {
    // Check the stepDefinitions Map (now includes bridged CSStepRegistry steps)
    for (const [className, definitions] of stepDefinitions) {
        for (const stepDef of definitions) {
            const regex = patternToRegex(stepDef.pattern);
            if (regex.test(stepText)) {
                // Cache the compiled regex for later use
                (stepDef as any).compiledRegex = regex;
                return stepDef;
            }
        }
    }

    // Steps from CSStepRegistry are now bridged to stepDefinitions Map
    // so we don't need to check CSStepRegistry separately

    return undefined;
}

export function getStepDefinitions(): Map<string, StepDefinition[]> {
    return stepDefinitions;
}

export function getHooks(type: 'before' | 'after' | 'beforeStep' | 'afterStep', tags?: string[]): Hook[] {
    return hooks
        .filter(hook => hook.type === type)
        .filter(hook => {
            if (!tags || !hook.options?.tags) return true;
            return hook.options.tags.some(tag => tags.includes(tag));
        })
        .sort((a, b) => (a.options?.order || 0) - (b.options?.order || 0));
}

export function clearStepDefinitions(): void {
    stepDefinitions.clear();
    hooks.length = 0;
}

export function clearStepInstanceCache(): void {
    stepInstanceCache.clear();
    CSReporter.debug('Step instance cache cleared');
}

export async function executeStep(
    stepText: string,
    stepType: string,
    context: CSBDDContext,
    dataTable?: any[][],
    docString?: string
): Promise<void> {
    const stepDef = findStepDefinition(stepText, stepType);

    if (!stepDef) {
        // Try intelligent step execution (zero-code feature)
        try {
            if (!CSIntelligentStepExecutor) {
                CSIntelligentStepExecutor = require('./CSIntelligentStepExecutor').CSIntelligentStepExecutor;
            }

            const intelligentExecutor = CSIntelligentStepExecutor.getInstance();

            if (intelligentExecutor.isEnabled()) {
                CSReporter.debug(`[ZeroCode] No step definition found, trying intelligent execution: ${stepType} ${stepText}`);

                // Get page from context
                const page = (context as any).page;
                if (!page) {
                    throw new Error('Page not available for intelligent step execution');
                }

                // Try to execute intelligently
                const result = await intelligentExecutor.executeIntelligently(stepText, stepType, context, page);

                if (result.success) {
                    CSReporter.info(`[ZeroCode] ✅ ${result.message}`);
                    return; // SUCCESS - step executed without step definition!
                } else {
                    CSReporter.debug(`[ZeroCode] Intelligent execution failed: ${result.message}`);
                    // Fall through to throw error
                }
            }
        } catch (error: any) {
            CSReporter.debug(`[ZeroCode] Error during intelligent execution: ${error.message}`);
            // Fall through to throw error
        }

        // If intelligent execution failed or is disabled, throw original error
        throw new Error(`Step definition not found for: ${stepType} ${stepText}`);
    }

    // Store current step text in context for page injection
    (context as any).currentStepText = stepText;

    // Use the cached regex from findStepDefinition or build it once
    const regex = (stepDef as any).compiledRegex || patternToRegex(stepDef.pattern);
    const matches = stepText.match(regex);
    const args: any[] = [];

    if (matches && matches.length > 1) {
        // Extract captured groups, converting types as needed
        for (let i = 1; i < matches.length; i++) {
            let value = matches[i];

            // Skip undefined groups from {string} alternation (e.g., "..." matched but '...' group is undefined)
            if (value === undefined) continue;

            // Remove quotes if present (for string parameters)
            if (value && value.startsWith('"') && value.endsWith('"')) {
                value = value.slice(1, -1);
            }

            // AUTOMATIC RESOLUTION: Apply decryption and variable substitution
            // This ensures step definitions receive fully resolved values
            if (typeof value === 'string') {
                value = CSValueResolver.resolve(value, context);
            }

            // Check if it's a number after resolution
            if (/^\d+$/.test(value)) {
                args.push(parseInt(value, 10));
            } else if (/^\d*\.\d+$/.test(value)) {
                args.push(parseFloat(value));
            } else {
                args.push(value);
            }
        }
    }
    
    // Add data table or doc string if present
    if (dataTable) {
        // Resolve all values in data table
        const resolvedDataTable = dataTable.map(row =>
            row.map(cell => typeof cell === 'string' ? CSValueResolver.resolve(cell, context) : cell)
        );
        args.push(new DataTable(resolvedDataTable));
    }
    if (docString) {
        // Resolve doc string
        const resolvedDocString = CSValueResolver.resolve(docString, context);
        args.push(resolvedDocString);
    }
    
    // Execute with retry logic if specified
    const retries = stepDef.options?.retry || 0;
    let lastError: any;
    
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            // Create a step class instance with page injection
            const stepInstance = await createStepInstanceWithPageInjection(context, stepDef.handler);
            await stepDef.handler.call(stepInstance, ...args);
            return;
        } catch (error) {
            lastError = error;
            if (attempt < retries) {
                CSReporter.warn(`Step failed (attempt ${attempt + 1}/${retries + 1}): ${error}`);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }
    
    throw lastError;
}

export class DataTable {
    private rows: any[][];
    
    constructor(rows: any[][]) {
        this.rows = rows;
    }
    
    raw(): any[][] {
        return this.rows;
    }
    
    getRows(): any[][] {
        return this.rows.slice(1);
    }
    
    hashes(): Record<string, any>[] {
        const headers = this.rows[0];
        return this.rows.slice(1).map(row => {
            const hash: Record<string, any> = {};
            headers.forEach((header, index) => {
                hash[header] = row[index];
            });
            return hash;
        });
    }
    
    rowsHash(): Record<string, any> {
        const hash: Record<string, any> = {};
        this.rows.forEach(row => {
            hash[row[0]] = row[1];
        });
        return hash;
    }
}

export function CSDataProvider(data: any[] | (() => any[])) {
    return function(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;
        
        descriptor.value = async function(...args: any[]) {
            const dataSet = typeof data === 'function' ? data() : data;
            
            for (const dataItem of dataSet) {
                CSReporter.info(`Running with data: ${JSON.stringify(dataItem)}`);
                await originalMethod.apply(this, [dataItem, ...args]);
            }
        };
        
        return descriptor;
    };
}

// Page injection decorators
export function StepDefinitions(target: any) {
    // Mark class as having step definitions for injection system
    Reflect.defineMetadata('isStepDefinitionClass', true, target);
    return target;
}

export function Page(pageName: string) {
    return function(target: any, propertyKey: string | symbol | any) {
        // Handle both old and new decorator API
        const actualPropertyKey = typeof propertyKey === 'string' ? propertyKey : 
                                 typeof propertyKey === 'symbol' ? propertyKey.toString() : 
                                 propertyKey.name || 'unknown';
        
        // Store page injection metadata
        const pageInjections = Reflect.getMetadata('pageInjections', target) || [];
        pageInjections.push({ property: actualPropertyKey, pageName });
        Reflect.defineMetadata('pageInjections', pageInjections, target);
    };
}

export function Context(target: any, propertyKey: string) {
    // Store context injection metadata
    const contextInjections = Reflect.getMetadata('contextInjections', target) || [];
    contextInjections.push(propertyKey);
    Reflect.defineMetadata('contextInjections', contextInjections, target);
}

export function ScenarioContext(target: any, propertyKey: string) {
    // Store scenario context injection metadata
    const scenarioInjections = Reflect.getMetadata('scenarioInjections', target) || [];
    scenarioInjections.push(propertyKey);
    Reflect.defineMetadata('scenarioInjections', scenarioInjections, target);
}

export function FeatureContext(target: any, propertyKey: string) {
    // Store feature context injection metadata
    const featureInjections = Reflect.getMetadata('featureInjections', target) || [];
    featureInjections.push(propertyKey);
    Reflect.defineMetadata('featureInjections', featureInjections, target);
}

// Cache for step class instances to maintain state across steps
const stepInstanceCache = new Map<any, any>();

// Create step class instance with page injection
async function createStepInstanceWithPageInjection(context: any, stepHandler: Function): Promise<any> {
    try {
        // Find the step definition to get the step class
        const stepDef = findStepDefinition(context.currentStepText || '', 'Given');

        if (stepDef && stepDef.options?.stepClass) {
            const StepClass = stepDef.options.stepClass;

            // Check if we already have an instance of this step class
            let stepInstance = stepInstanceCache.get(StepClass);
            if (!stepInstance) {
                // Create instance of the step class dynamically
                stepInstance = new StepClass();
                stepInstanceCache.set(StepClass, stepInstance);
                CSReporter.debug(`Created new instance of step class: ${StepClass.name}`);
            } else {
                CSReporter.debug(`Reusing existing instance of step class: ${StepClass.name}`);
            }

            // Get page injection metadata from the step class prototype
            const pageInjections = Reflect.getMetadata('pageInjections', StepClass.prototype) || [];

            const currentPage = context.page;
            if (currentPage && pageInjections.length > 0) {
                // Use CSPageRegistry for lazy loading (preferred) or fall back to CSPageFactory
                const { CSPageRegistry } = await import('../core/CSPageRegistry');
                const pageRegistry = CSPageRegistry.getInstance();

                for (const injection of pageInjections) {
                    const { property, pageName } = injection;

                    // Skip if already injected
                    if ((stepInstance as any)[property]) {
                        continue;
                    }

                    // Try lazy loading from registry first
                    let pageClass = await pageRegistry.getPageClass(pageName);

                    // Fall back to CSPageFactory if not found in registry
                    if (!pageClass) {
                        const { CSPageFactory } = await import('../core/CSPageFactory');
                        const allPages = CSPageFactory.getAllPages();

                        for (const [className, cls] of allPages) {
                            const pageUrl = Reflect.getMetadata('page:url', cls);
                            if (pageUrl === pageName) {
                                pageClass = cls;
                                break;
                            }
                        }
                    }

                    if (pageClass) {
                        const pageInstance = new pageClass(currentPage);
                        (stepInstance as any)[property] = pageInstance;
                        CSReporter.debug(`Injected page: ${pageName} into ${property}`);
                    } else {
                        CSReporter.warn(`Page not found for injection: ${pageName}`);
                    }
                }
            }

            return stepInstance;
        }

        // Fallback to context if no step class found
        return context;
    } catch (error) {
        CSReporter.warn(`Failed to create step instance with page injection: ${error}`);
        return context;
    }
}