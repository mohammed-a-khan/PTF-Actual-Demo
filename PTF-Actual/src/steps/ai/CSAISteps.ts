/**
 * Built-in AI Step Definitions - Zero-Step Natural Language Test Execution
 *
 * Enables natural language test steps in .feature files using the AI Step Engine.
 * Uses grammar-based NLP parsing + Playwright accessibility tree matching.
 * No external LLM required.
 *
 * These steps are automatically available to all framework consumers.
 * No need to create a separate ai-steps.steps.ts in your project.
 *
 * Usage in .feature files:
 *   When AI "Click the Login button"
 *   Then AI "Verify the Dashboard heading is displayed"
 *   When AI "Get the text from the heading" and store as "headingText"
 *   When AI "Type in the search field" with value "{scenario:searchTerm}"
 *   When AI "Check the Terms checkbox" if "acceptTerms" is "Yes"
 */

import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSReporter } from '../../reporter/CSReporter';
import { createAIStepHandler } from '../../ai/step-engine/CSAIStepBDD';

export class CSAISteps {

    /**
     * Get AI step handler with the current browser page.
     * Uses lazy import for CSBrowserManager to avoid circular dependencies.
     */
    private async getAIHandler() {
        const { CSBrowserManager } = await import('../../browser/CSBrowserManager');
        const browserManager = CSBrowserManager.getInstance();
        const page = browserManager.getPage();
        if (!page) {
            throw new Error('AI Step: No active page. Ensure a browser is launched before using AI steps.');
        }
        return createAIStepHandler(page);
    }

    /**
     * Pattern 1: General AI step (actions + assertions)
     * Usage: When AI "Click the Login button"
     *        Then AI "Verify the Dashboard heading is displayed"
     */
    @CSBDDStepDef('AI {string}')
    async aiStep(instruction: string): Promise<void> {
        CSReporter.debug(`AI Step: Dispatching instruction to handler`);
        const handler = await this.getAIHandler();
        await handler.executeAIStep(instruction);
    }

    /**
     * Pattern 2: AI query with variable storage
     * Usage: When AI "Get the text from the heading" and store as "headingText"
     */
    @CSBDDStepDef('AI {string} and store as {string}')
    async aiStepAndStore(instruction: string, variableName: string): Promise<void> {
        CSReporter.debug(`AI Step: Dispatching store-as instruction to handler`);
        const handler = await this.getAIHandler();
        await handler.executeAIStepAndStore(instruction, variableName);
    }

    /**
     * Pattern 3: AI step with explicit value injection
     * Usage: When AI "Type in the search field" with value "{scenario:searchTerm}"
     */
    @CSBDDStepDef('AI {string} with value {string}')
    async aiStepWithValue(instruction: string, value: string): Promise<void> {
        CSReporter.debug(`AI Step: Dispatching with-value instruction to handler`);
        const handler = await this.getAIHandler();
        await handler.executeAIStepWithValue(instruction, value);
    }

    /**
     * Pattern 4: AI conditional step (executes only if flag matches)
     * Usage: When AI "Check the Terms checkbox" if "acceptTerms" is "Yes"
     */
    @CSBDDStepDef('AI {string} if {string} is {string}')
    async aiStepConditional(instruction: string, flagName: string, flagValue: string): Promise<void> {
        CSReporter.debug(`AI Step: Dispatching conditional instruction to handler`);
        const handler = await this.getAIHandler();
        await handler.executeAIStepConditional(instruction, flagName, flagValue);
    }
}

export default CSAISteps;
