import { CSReporter } from '../reporter/CSReporter';

export interface StepDefinition {
    pattern: string;
    handler: Function;
    timeout?: number;
}

class CSSimpleStepRegistry {
    private static instance: CSSimpleStepRegistry;
    private steps: Map<string, StepDefinition> = new Map();

    private constructor() {
        CSReporter.debug('Simple Step Registry initialized');
    }

    public static getInstance(): CSSimpleStepRegistry {
        if (!CSSimpleStepRegistry.instance) {
            CSSimpleStepRegistry.instance = new CSSimpleStepRegistry();
        }
        return CSSimpleStepRegistry.instance;
    }

    public registerStep(pattern: string, handler: Function, timeout?: number): void {
        // Convert Cucumber-style patterns to regex patterns
        let regexPattern = pattern;
        
        // Replace {string} with regex for quoted strings
        regexPattern = regexPattern.replace(/\{string\}/g, '"([^"]*)"');
        
        // Replace {int} with regex for numbers
        regexPattern = regexPattern.replace(/\{int\}/g, '(\\d+)');
        
        // Replace {float} with regex for decimals
        regexPattern = regexPattern.replace(/\{float\}/g, '([\\d\\.]+)');
        
        const step: StepDefinition = { pattern: regexPattern, handler, timeout };
        this.steps.set(regexPattern, step);
        
        CSReporter.debug(`Registered step: ${pattern}`);
    }

    public findStep(stepText: string): StepDefinition | undefined {
        // Try exact match first
        if (this.steps.has(stepText)) {
            return this.steps.get(stepText);
        }
        
        // Try regex patterns
        for (const [pattern, stepDef] of this.steps) {
            try {
                const regex = new RegExp(`^${pattern}$`);
                if (regex.test(stepText)) {
                    return stepDef;
                }
            } catch (e) {
                // If pattern is not a regex, try exact match
                if (pattern === stepText) {
                    return stepDef;
                }
            }
        }
        
        return undefined;
    }

    public async executeStep(stepText: string, context?: any, dataTable?: any[][], docString?: string): Promise<void> {
        const stepDef = this.findStep(stepText);
        
        if (!stepDef) {
            throw new Error(`Step definition not found for: ${stepText}`);
        }
        
        // Extract parameters from step text
        const args: any[] = [];
        
        try {
            const regex = new RegExp(`^${stepDef.pattern}$`);
            const matches = stepText.match(regex);
            
            if (matches && matches.length > 1) {
                // Add captured groups as arguments
                args.push(...matches.slice(1));
            }
        } catch (e) {
            // No regex matching needed
        }
        
        // Add data table or doc string if present
        if (dataTable) args.push(dataTable);
        if (docString) args.push(docString);
        
        // Execute the step
        await stepDef.handler.call(context || {}, ...args);
    }

    public getSteps(): Map<string, StepDefinition> {
        return this.steps;
    }

    public clearSteps(): void {
        this.steps.clear();
    }
}

// Export singleton instance
export const simpleStepRegistry = CSSimpleStepRegistry.getInstance();

// Simple decorator for step definitions
export function CSBDDStepDef(pattern: string, timeout?: number): any {
    return function(target: any, propertyKey: string, descriptor: PropertyDescriptor): PropertyDescriptor {
        const originalMethod = descriptor.value;
        
        // Register the step immediately when decorator is applied
        simpleStepRegistry.registerStep(pattern, originalMethod, timeout);
        
        return descriptor;
    };
}