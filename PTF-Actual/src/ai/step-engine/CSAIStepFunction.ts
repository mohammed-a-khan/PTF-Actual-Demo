/**
 * CSAIStepFunction - Main csAI() Orchestrator
 *
 * The public entry point for the AI Step Engine. Orchestrates:
 *   1. Parse instruction (grammar rules + NLP fallback)
 *   2. Find element (accessibility tree + cascade)
 *   3. Execute action/assertion/query
 *   4. Report result
 *   5. Return value (void for actions, typed for queries)
 *
 * Usage:
 *   import { csAI } from '@mdakhan.mak/cs-playwright-test-framework/ai/step-engine';
 *
 *   // In a step definition:
 *   await csAI('Click the Login button', { page });
 *   const total = await csAI('Get the price from the Total field', { page });
 *   const hasError = await csAI('Check if there are error messages', { page });
 *
 * @module ai/step-engine
 */

import { CSReporter } from '../../reporter/CSReporter';
import { CSAIStepParser } from './CSAIStepParser';
import { CSAccessibilityTreeMatcher } from './CSAccessibilityTreeMatcher';
import { CSAIActionExecutor } from './CSAIActionExecutor';
import {
    CSAIOptions,
    ParsedStep,
    MatchedElement,
    ActionResult,
    CSAIStepConfig,
    DEFAULT_AI_STEP_CONFIG
} from './CSAIStepTypes';

/** Global configuration for the AI Step Engine */
let globalConfig: CSAIStepConfig = { ...DEFAULT_AI_STEP_CONFIG };

/** Lazy-loaded module instances */
let parser: CSAIStepParser | null = null;
let matcher: CSAccessibilityTreeMatcher | null = null;
let executor: CSAIActionExecutor | null = null;

/**
 * Execute a natural language instruction against a Playwright page
 *
 * @param instruction - Natural language instruction (e.g., "Click the Login button")
 * @param options - Options including page, context, timeout, etc.
 * @returns For queries: string | number | boolean | string[]. For actions/assertions: void
 *
 * @example
 * // Action
 * await csAI('Click the Submit button', { page });
 *
 * // Query
 * const text = await csAI('Get the text from the heading', { page });
 *
 * // Assertion
 * await csAI('Verify the Dashboard heading is displayed', { page });
 *
 * // With variable resolution
 * await csAI("Type '{scenario:referenceRateName}' in the search field", { page, context: scenarioContext });
 */
export async function csAI(
    instruction: string,
    options: CSAIOptions
): Promise<string | number | boolean | string[] | void> {
    const startTime = Date.now();
    const config = { ...globalConfig, ...options.config };

    if (!config.enabled) {
        throw new Error('AI Step Engine is disabled. Set AI_STEP_ENGINE_ENABLED=true to enable.');
    }

    if (!options.page) {
        throw new Error('csAI() requires a Playwright page object in options.');
    }

    if (!instruction || !instruction.trim()) {
        throw new Error('csAI() requires a non-empty instruction.');
    }

    CSReporter.info(`AI Step: "${instruction}"`);

    try {
        // Lazy-load modules
        if (!parser) parser = CSAIStepParser.getInstance();
        if (!matcher) matcher = CSAccessibilityTreeMatcher.getInstance(config);
        if (!executor) executor = CSAIActionExecutor.getInstance(config);

        // Step 1: Parse instruction
        const parsedStep = await parser.parse(instruction.trim());
        CSReporter.debug(`AI Parse: ${parsedStep.category}:${parsedStep.intent} (confidence: ${parsedStep.confidence.toFixed(2)}, rule: ${parsedStep.matchedRuleId || 'NLP'})`);

        // Override category if forced
        if (options.forceCategory) {
            (parsedStep as any).category = options.forceCategory;
        }

        // Step 2: Find element (skip for page-level operations)
        let matchedElement: MatchedElement | null = null;
        const needsElement = !isPageLevelOperation(parsedStep);

        if (needsElement) {
            // Retry element search with progressive waits to handle page transitions
            // Assertions get more retries since they often follow actions that trigger navigation
            const maxAttempts = parsedStep.category === 'assertion' ? 4 : 3;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                // Invalidate accessibility cache for fresh snapshot
                matcher.invalidateCache();

                matchedElement = await matcher.findElement(
                    options.page,
                    parsedStep.target,
                    parsedStep.intent
                );

                if (matchedElement) break;

                // Element not found - wait and retry (handles page transitions after clicks/navigation)
                if (attempt < maxAttempts && parsedStep.target.descriptors.length > 0) {
                    const waitMs = attempt * 2000; // 2s, 4s
                    CSReporter.debug(`AI Step: Element "${parsedStep.target.rawText}" not found, waiting ${waitMs}ms before retry (attempt ${attempt}/${maxAttempts})`);
                    await new Promise(resolve => setTimeout(resolve, waitMs));
                    // Also try waiting for network to settle (helps with SPA page transitions)
                    try {
                        await options.page.waitForLoadState('networkidle', { timeout: 3000 });
                    } catch {
                        // Non-critical - continue with retry
                    }
                }
            }

            if (!matchedElement && parsedStep.target.descriptors.length > 0) {
                CSReporter.warn(`AI Step: Could not find element matching "${parsedStep.target.rawText}"`);
                throw new Error(`Element not found: "${parsedStep.target.rawText}". Ensure the element is visible on the page.`);
            }

            if (matchedElement) {
                CSReporter.debug(`AI Match: ${matchedElement.description} (confidence: ${matchedElement.confidence.toFixed(2)}, method: ${matchedElement.method})`);
            }
        }

        // Step 3: Execute
        const result = await executor.execute(options.page, parsedStep, matchedElement);

        // Step 4: Report
        const duration = Date.now() - startTime;
        if (result.success) {
            CSReporter.pass(`AI Step completed: ${parsedStep.intent} (${duration}ms)`);
            CSReporter.addAction(`AI: ${instruction}`, 'pass', duration);
        } else {
            CSReporter.fail(`AI Step failed: ${result.error}`);
            CSReporter.addAction(`AI: ${instruction}`, 'fail', duration);
            throw new Error(`AI Step failed: ${result.error}`);
        }

        // Step 5: Return value for queries
        if (parsedStep.category === 'query' && result.returnValue !== undefined) {
            CSReporter.debug(`AI Query result: ${typeof result.returnValue === 'string' ? result.returnValue.substring(0, 100) : result.returnValue}`);
            return result.returnValue;
        }

        // Return boolean for assertions (true = passed)
        if (parsedStep.category === 'assertion') {
            return true;
        }

        return undefined;

    } catch (error: any) {
        const duration = Date.now() - startTime;
        CSReporter.fail(`AI Step failed (${duration}ms): ${error.message}`);
        CSReporter.addAction(`AI: ${instruction}`, 'fail', duration);

        // Take screenshot on failure if configured
        if (config.screenshotOnFailure) {
            try {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const screenshotPath = `ai-step-failure-${timestamp}.png`;
                await options.page.screenshot({ path: screenshotPath, fullPage: false });
                CSReporter.debug(`AI Step failure screenshot: ${screenshotPath}`);
            } catch {
                // Screenshot failed - non-critical
            }
        }

        throw error;
    }
}

/**
 * Check if the operation is page-level (doesn't need an element)
 */
function isPageLevelOperation(step: ParsedStep): boolean {
    // Navigation operations
    if (step.intent === 'navigate') return true;

    // Page-level queries
    if (step.intent === 'get-url' || step.intent === 'get-title') return true;

    // Page-level assertions
    if (step.intent === 'verify-url' || step.intent === 'verify-title') return true;

    // Keyboard actions without target
    if (step.intent === 'press-key' && step.target.descriptors.length === 0) return true;

    // Scroll without target
    if (step.intent === 'scroll' && step.target.rawText === 'page') return true;

    return false;
}

/**
 * Configure the AI Step Engine globally
 */
export function configureAIStepEngine(config: Partial<CSAIStepConfig>): void {
    globalConfig = { ...globalConfig, ...config };
    CSReporter.debug(`AI Step Engine configured: ${JSON.stringify(config)}`);
}

/**
 * Get current AI Step Engine configuration
 */
export function getAIStepConfig(): Readonly<CSAIStepConfig> {
    return { ...globalConfig };
}
