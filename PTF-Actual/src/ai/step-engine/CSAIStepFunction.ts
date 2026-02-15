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
): Promise<string | number | boolean | string[] | Record<string, any> | Record<string, any>[] | any | void> {
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

    CSReporter.info(`Executing AI: "${instruction}"`);

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
            // For assertions, validate that the page is in a healthy state first
            // This catches cases where an assertion passes on a 404/error page
            if (parsedStep.category === 'assertion') {
                await validatePageHealth(options.page, parsedStep);
            }

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
                // For verify-not-present and verify-hidden, NOT finding the element is actually SUCCESS
                if (parsedStep.intent === 'verify-not-present') {
                    CSReporter.pass(`AI Step: Element "${parsedStep.target.rawText}" not found — verify-not-present passed`);
                    const duration = Date.now() - startTime;
                    CSReporter.addAction(`AI: ${instruction}`, 'pass', duration);
                    return true;
                }
                if (parsedStep.intent === 'verify-hidden') {
                    CSReporter.pass(`AI Step: Element "${parsedStep.target.rawText}" not found — verify-hidden passed (not in DOM)`);
                    const duration = Date.now() - startTime;
                    CSReporter.addAction(`AI: ${instruction}`, 'pass', duration);
                    return true;
                }
                CSReporter.warn(`AI Step: Could not find element matching "${parsedStep.target.rawText}"`);
                throw new Error(`Element not found: "${parsedStep.target.rawText}". Ensure the element is visible on the page.`);
            }

            if (matchedElement) {
                CSReporter.debug(`AI Match: ${matchedElement.description} (confidence: ${matchedElement.confidence.toFixed(2)}, method: ${matchedElement.method})`);
            }
        }

        // Step 3: Execute
        const result = await executor.execute(options.page, parsedStep, matchedElement);

        // After DOM-modifying actions, invalidate the accessibility tree cache
        // so subsequent steps get a fresh snapshot. This is critical for sequences like:
        //   select from dropdown A -> select from dropdown B
        // where selecting A might change the DOM state (e.g., trigger onChange events)
        if (parsedStep.category === 'action' && isDOMModifyingAction(parsedStep.intent)) {
            matcher.invalidateCache();
        }

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
 * Check if an action intent modifies the DOM and should trigger cache invalidation.
 * This ensures subsequent element searches get a fresh accessibility snapshot.
 */
function isDOMModifyingAction(intent: string): boolean {
    const domModifyingIntents = [
        'click', 'double-click', 'right-click',
        'fill', 'type', 'clear',
        'select', 'check', 'uncheck', 'toggle',
        'press-key', 'navigate',
        'upload', 'drag',
        'execute-js'
    ];
    return domModifyingIntents.includes(intent);
}

/**
 * Validate page health before assertions to catch 404/error pages early.
 * Warns (and optionally fails) if the page appears to be in an error state,
 * preventing assertions from falsely passing against wrong page content.
 */
async function validatePageHealth(page: import('playwright').Page, step: ParsedStep): Promise<void> {
    try {
        const title = await page.title();
        const url = page.url();

        // Detect common error page patterns
        const errorTitlePatterns = [
            /404/i, /not\s*found/i, /error/i, /500/i, /server\s*error/i,
            /403/i, /forbidden/i, /401/i, /unauthorized/i,
            /502/i, /bad\s*gateway/i, /503/i, /service\s*unavailable/i
        ];

        const isLikelyErrorPage = errorTitlePatterns.some(p => p.test(title));

        if (isLikelyErrorPage) {
            CSReporter.warn(
                `AI Step: Page may be in error state (title: "${title}", url: "${url}"). ` +
                `Assertion "${step.rawText}" may produce false results.`
            );
        }

        // Also check for about:blank or empty pages
        if (url === 'about:blank' || url === '') {
            throw new Error(
                `Cannot run assertion "${step.rawText}" — page is blank (about:blank). ` +
                `Ensure navigation completed before asserting.`
            );
        }
    } catch (error: any) {
        // Only re-throw if it's our own error, not a Playwright internal error
        if (error.message.includes('Cannot run assertion')) {
            throw error;
        }
        CSReporter.debug(`AI Step: Page health check failed (non-critical): ${error.message}`);
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

    // Phase 1: Enhanced wait strategies (page-level)
    if (step.intent === 'wait-seconds') return true;
    if (step.intent === 'wait-url-change') return true;

    // Phase 2: Browser & tab management (all page-level)
    if (step.intent === 'switch-tab') return true;
    if (step.intent === 'open-new-tab') return true;
    if (step.intent === 'close-tab') return true;
    if (step.intent === 'switch-browser') return true;
    if (step.intent === 'clear-session') return true;

    // Phase 5: URL parameter operations (page-level)
    if (step.intent === 'get-url-param') return true;
    if (step.intent === 'verify-url-param') return true;

    // Phase 7: Data generation & context (page-level)
    if (step.intent === 'generate-data') return true;
    if (step.intent === 'set-variable') return true;
    if (step.intent === 'take-screenshot') return true;

    // Phase 8: Frame switching (page-level)
    if (step.intent === 'switch-frame') return true;
    if (step.intent === 'switch-main-frame') return true;

    // Phase 9: Cookie & storage operations (page-level)
    if (step.intent === 'clear-cookies') return true;
    if (step.intent === 'get-cookie') return true;
    if (step.intent === 'set-cookie') return true;
    if (step.intent === 'clear-storage') return true;
    if (step.intent === 'set-storage-item') return true;
    if (step.intent === 'get-storage-item') return true;

    // Phase 10: Download operations (page-level)
    if (step.intent === 'verify-download') return true;
    if (step.intent === 'get-download-path') return true;
    if (step.intent === 'verify-download-content') return true;

    // Phase 11: API calls (page-level)
    if (step.intent === 'api-call') return true;
    if (step.intent === 'verify-api-response') return true;
    if (step.intent === 'get-api-response') return true;

    // Phase 12: JavaScript execution (page-level)
    if (step.intent === 'execute-js') return true;
    if (step.intent === 'evaluate-js') return true;

    // Database operations (all page-level — use DB client, not page elements)
    if (step.intent === 'db-query') return true;
    if (step.intent === 'db-query-file') return true;
    if (step.intent === 'db-update') return true;
    if (step.intent === 'db-resolve-or-use') return true;
    if (step.intent === 'verify-db-exists') return true;
    if (step.intent === 'verify-db-not-exists') return true;
    if (step.intent === 'verify-db-field') return true;
    if (step.intent === 'verify-db-count') return true;
    if (step.intent === 'get-db-value') return true;
    if (step.intent === 'get-db-row') return true;
    if (step.intent === 'get-db-rows') return true;
    if (step.intent === 'get-db-count') return true;

    // File operations (page-level)
    if (step.intent === 'parse-csv') return true;
    if (step.intent === 'parse-xlsx') return true;
    if (step.intent === 'parse-file') return true;
    if (step.intent === 'verify-file-name-pattern') return true;
    if (step.intent === 'verify-file-row-count') return true;
    if (step.intent === 'get-file-row-count') return true;
    if (step.intent === 'get-file-headers') return true;
    if (step.intent === 'verify-data-match') return true;

    // Context operations (page-level)
    if (step.intent === 'set-context-field') return true;
    if (step.intent === 'copy-context-var') return true;
    if (step.intent === 'clear-context-var') return true;
    if (step.intent === 'get-context-field') return true;
    if (step.intent === 'get-context-count') return true;
    if (step.intent === 'get-context-keys') return true;

    // Comparison operations (page-level)
    if (step.intent === 'verify-tolerance') return true;
    if (step.intent === 'verify-context-field') return true;
    if (step.intent === 'verify-context-match') return true;
    if (step.intent === 'verify-count-match') return true;
    if (step.intent === 'verify-accumulated') return true;

    // Mapping operations (page-level)
    if (step.intent === 'load-mapping') return true;
    if (step.intent === 'transform-data') return true;
    if (step.intent === 'prepare-test-data') return true;
    if (step.intent === 'get-mapped-value') return true;

    // Helper/Orchestration (page-level)
    if (step.intent === 'call-helper') return true;
    if (step.intent === 'get-helper-value') return true;

    // API extensions (all page-level — use HTTP client, not page elements)
    if (step.intent === 'api-call-file') return true;
    if (step.intent === 'api-upload') return true;
    if (step.intent === 'api-download') return true;
    if (step.intent === 'api-set-context') return true;
    if (step.intent === 'api-set-header') return true;
    if (step.intent === 'api-set-auth') return true;
    if (step.intent === 'api-clear-context') return true;
    if (step.intent === 'api-poll') return true;
    if (step.intent === 'api-save-response') return true;
    if (step.intent === 'api-save-request') return true;
    if (step.intent === 'api-print') return true;
    if (step.intent === 'api-chain') return true;
    if (step.intent === 'api-execute-chain') return true;
    if (step.intent === 'api-soap') return true;
    if (step.intent === 'verify-api-schema') return true;

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
