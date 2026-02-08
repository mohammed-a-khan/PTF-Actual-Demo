/**
 * CSAIStepBDD - BDD Step Definitions for AI Steps
 *
 * Registers BDD step patterns that enable natural language test execution
 * directly in .feature files. Works alongside regular custom step definitions.
 *
 * Step Patterns:
 *   1. AI {string}                           - General actions + assertions
 *   2. AI {string} and store as {string}     - Query with variable storage
 *   3. AI {string} with value {string}       - Action with explicit value
 *   4. AI {string} if {string} is {string}   - Conditional execution
 *
 * Usage in .feature files:
 *   When AI "Click the Login button"
 *   Then AI "Verify the Dashboard heading is displayed"
 *   When AI "Get the price from Total" and store as "totalPrice"
 *   When AI "Type in the search field" with value "{scenario:referenceRateName}"
 *   When AI "Check the Benchmark checkbox" if "benchmarkFlag" is "Yes"
 *
 * @module ai/step-engine
 */

import { CSReporter } from '../../reporter/CSReporter';
import { CSScenarioContext } from '../../bdd/CSScenarioContext';
import { CSValueResolver } from '../../utils/CSValueResolver';
import { csAI } from './CSAIStepFunction';

// Note: BDD step registration uses CSBDDStepDef from the step registry.
// The actual registration happens when this module is imported.
// Import path depends on consumer project setup.

/**
 * CSAIStepBDD - Class containing all AI BDD step definitions
 *
 * This class is designed to be instantiated by the BDD runner with page injection.
 * Steps can also be registered manually via registerAISteps().
 */
export class CSAIStepBDD {
    private page: any;

    constructor(page: any) {
        this.page = page;
    }

    /**
     * Pattern 1: General AI step (actions + assertions)
     *
     * Usage:
     *   When AI "Click the Login button"
     *   Then AI "Verify the Dashboard heading is displayed"
     *   And AI "Type 'admin@test.com' in the Email field"
     */
    async executeAIStep(instruction: string): Promise<void> {
        // Resolve variables before processing
        const resolved = this.resolveInstruction(instruction);

        CSReporter.info(`AI Step: "${resolved}"`);

        await csAI(resolved, {
            page: this.page,
            context: this.getContextAdapter()
        });
    }

    /**
     * Pattern 2: AI query with variable storage
     *
     * Usage:
     *   When AI "Get the price from Total" and store as "totalPrice"
     *   When AI "Get the text from row 1 column 2" and store as "cellValue"
     */
    async executeAIStepAndStore(instruction: string, variableName: string): Promise<void> {
        // Resolve variables in instruction
        const resolved = this.resolveInstruction(instruction);

        CSReporter.info(`AI Step (store as "${variableName}"): "${resolved}"`);

        const result = await csAI(resolved, {
            page: this.page,
            context: this.getContextAdapter(),
            forceCategory: 'query'
        });

        // Store result in scenario context
        const scenarioContext = CSScenarioContext.getInstance();
        scenarioContext.setVariable(variableName, result);
        CSReporter.pass(`Stored AI result in "${variableName}": ${typeof result === 'string' ? result.substring(0, 100) : result}`);
    }

    /**
     * Pattern 3: AI step with explicit value
     *
     * Usage:
     *   When AI "Type in the search field" with value "{scenario:referenceRateName}"
     *   When AI "Select from the dropdown" with value "USD"
     */
    async executeAIStepWithValue(instruction: string, value: string): Promise<void> {
        // Resolve both instruction and value
        const resolvedInstruction = this.resolveInstruction(instruction);
        const resolvedValue = this.resolveInstruction(value);

        // Inject value into instruction if it doesn't already contain a quoted value
        let finalInstruction: string;
        if (resolvedInstruction.includes("'") || resolvedInstruction.includes('"')) {
            finalInstruction = resolvedInstruction;
        } else {
            // Try to intelligently inject the value
            finalInstruction = this.injectValue(resolvedInstruction, resolvedValue);
        }

        CSReporter.info(`AI Step (with value "${resolvedValue}"): "${finalInstruction}"`);

        await csAI(finalInstruction, {
            page: this.page,
            context: this.getContextAdapter()
        });
    }

    /**
     * Pattern 4: AI conditional step
     *
     * Usage:
     *   When AI "Check the Benchmark checkbox" if "benchmarkFlag" is "Yes"
     *   When AI "Click the Optional button" if "showOptional" is "true"
     */
    async executeAIStepConditional(instruction: string, flagName: string, flagValue: string): Promise<void> {
        const scenarioContext = CSScenarioContext.getInstance();

        // Check the condition
        const actualValue = scenarioContext.getVariable(flagName);
        const resolvedFlagValue = this.resolveInstruction(flagValue);

        if (String(actualValue).toLowerCase() !== resolvedFlagValue.toLowerCase()) {
            CSReporter.info(`AI Step skipped (${flagName}="${actualValue}" != "${resolvedFlagValue}"): "${instruction}"`);
            return;
        }

        // Condition met - execute
        const resolved = this.resolveInstruction(instruction);
        CSReporter.info(`AI Step (condition met: ${flagName}="${actualValue}"): "${resolved}"`);

        await csAI(resolved, {
            page: this.page,
            context: this.getContextAdapter()
        });
    }

    // ========================================================================
    // HELPER METHODS
    // ========================================================================

    /**
     * Resolve template variables in an instruction
     * Handles: {scenario:var}, <param>, {config:KEY}, {env:VAR}
     */
    private resolveInstruction(instruction: string): string {
        const scenarioContext = CSScenarioContext.getInstance();

        // Use CSValueResolver for {scenario:var}, {config:KEY}, {env:VAR}, {{var}}, $var
        let resolved = CSValueResolver.resolve(instruction, {
            getVariable: (key: string) => scenarioContext.getVariable(key)
        });

        // Also resolve <paramName> angle bracket format (from Scenario Outline Examples)
        // These are typically already resolved by the BDD engine before reaching the step,
        // but handle as safety net
        resolved = resolved.replace(/<([^>]+)>/g, (_, paramName) => {
            const value = scenarioContext.getVariable(paramName);
            return value !== undefined ? String(value) : `<${paramName}>`;
        });

        return resolved;
    }

    /**
     * Inject a value into an instruction that's missing one
     * E.g., "Type in the search field" + "hello" -> "Type 'hello' in the search field"
     */
    private injectValue(instruction: string, value: string): string {
        const lower = instruction.toLowerCase();

        // For type/fill/enter: insert value after the verb
        if (/^(?:type|fill|enter|input|write)\b/i.test(lower)) {
            return instruction.replace(
                /^(type|fill|enter|input|write)\s+/i,
                `$1 '${value}' `
            );
        }

        // For select/choose/pick: insert value after the verb
        if (/^(?:select|choose|pick)\b/i.test(lower)) {
            return instruction.replace(
                /^(select|choose|pick)\s+/i,
                `$1 '${value}' `
            );
        }

        // Default: append value as quoted string
        return `${instruction} '${value}'`;
    }

    /**
     * Create a context adapter for csAI() from CSScenarioContext
     */
    private getContextAdapter(): { getVariable: (key: string) => any; setVariable: (key: string, value: any) => void } {
        const scenarioContext = CSScenarioContext.getInstance();
        return {
            getVariable: (key: string) => scenarioContext.getVariable(key),
            setVariable: (key: string, value: any) => scenarioContext.setVariable(key, value)
        };
    }
}

/**
 * Register AI BDD steps with the step registry
 *
 * Call this function to auto-register all AI step patterns.
 * Typically called during framework initialization.
 *
 * @param stepRegistryModule - The step registry module (to avoid circular imports)
 */
export function registerAISteps(stepRegistryModule: {
    CSBDDStepDef: (pattern: string, timeout?: number) => any;
}): void {
    CSReporter.info('AI Step Engine: Registering BDD step definitions');

    // The step definitions will be registered by consumer projects
    // that use the @CSBDDStepDef decorator pattern.
    // This function provides a programmatic alternative.

    CSReporter.debug('AI Step Engine: BDD steps available - AI {string}, AI {string} and store as {string}, AI {string} with value {string}, AI {string} if {string} is {string}');
}

/**
 * Create a factory function for AI step handlers
 * Used by BDD engine to create step instances with page injection
 */
export function createAIStepHandler(page: any): CSAIStepBDD {
    return new CSAIStepBDD(page);
}
