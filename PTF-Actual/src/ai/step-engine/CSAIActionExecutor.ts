/**
 * CSAIActionExecutor - Action/Assertion/Query Dispatch
 *
 * Maps ParsedStep intent + MatchedElement to framework wrapper calls.
 * Uses CSWebElement for element interactions (smart waits, retries, self-healing),
 * CSBrowserManager for navigation (spinner detection, proper timeouts),
 * and CSAssert for assertion failures (screenshot capture before throw).
 *
 * Handles:
 *   - Actions: click, fill, select, check, hover, scroll, navigate, press-key, etc.
 *   - Assertions: verify visible/hidden/text/enabled/disabled/checked/count/url/title
 *   - Queries: get text/value/attribute/count/list/url/title, check exists
 *
 * Includes error recovery: scroll into view, wait, retry with alternatives.
 *
 * @module ai/step-engine
 */

import { Page, Locator } from 'playwright';
import { CSReporter } from '../../reporter/CSReporter';
import { CSWebElement, CSElementFactory } from '../../element/CSWebElement';
import {
    ParsedStep,
    MatchedElement,
    ActionResult,
    StepParameters,
    StepModifiers,
    CSAIStepConfig,
    DEFAULT_AI_STEP_CONFIG
} from './CSAIStepTypes';

// Lazy-load modules that import @playwright/test to avoid dual-package conflict.
// The AI step engine imports from 'playwright'; CSBrowserManager and CSAssert import
// from '@playwright/test'. Lazy require() at runtime avoids Playwright's double-require guard.
let _CSBrowserManager: any = null;
let _CSAssert: any = null;

function getBrowserManager(): any {
    if (!_CSBrowserManager) {
        _CSBrowserManager = require('../../browser/CSBrowserManager').CSBrowserManager;
    }
    return _CSBrowserManager.getInstance();
}

function getCSAssert(): any {
    if (!_CSAssert) {
        _CSAssert = require('../../assertions/CSAssert').CSAssert;
    }
    return _CSAssert.getInstance();
}

export class CSAIActionExecutor {
    private static instance: CSAIActionExecutor;
    private config: CSAIStepConfig;

    /** Guard flag to prevent infinite recursion during error recovery */
    private inRecovery: boolean = false;

    private constructor(config?: Partial<CSAIStepConfig>) {
        this.config = { ...DEFAULT_AI_STEP_CONFIG, ...config };
    }

    /** Get singleton instance */
    public static getInstance(config?: Partial<CSAIStepConfig>): CSAIActionExecutor {
        if (!CSAIActionExecutor.instance) {
            CSAIActionExecutor.instance = new CSAIActionExecutor(config);
        }
        return CSAIActionExecutor.instance;
    }

    /**
     * Execute a parsed step against a matched element
     *
     * @param page - Playwright page
     * @param step - Parsed step with intent and parameters
     * @param element - Matched element with locator (null for page-level operations)
     * @returns ActionResult with success status and optional return value
     */
    public async execute(
        page: Page,
        step: ParsedStep,
        element: MatchedElement | null
    ): Promise<ActionResult> {
        const startTime = Date.now();
        const timeout = step.parameters.timeout || this.config.timeout;

        try {
            let result: ActionResult;

            switch (step.category) {
                case 'action':
                    result = await this.executeAction(page, step, element, timeout);
                    break;
                case 'assertion':
                    result = await this.executeAssertion(page, step, element, timeout);
                    break;
                case 'query':
                    result = await this.executeQuery(page, step, element, timeout);
                    break;
                default:
                    throw new Error(`Unknown step category: ${step.category}`);
            }

            result.duration = Date.now() - startTime;
            return result;

        } catch (error: any) {
            // Try error recovery (but NOT if we're already in a recovery attempt)
            if (!this.inRecovery) {
                const recovered = await this.tryErrorRecovery(page, step, element, error, timeout);
                if (recovered) {
                    recovered.duration = Date.now() - startTime;
                    return recovered;
                }
            }

            return {
                success: false,
                error: error.message,
                duration: Date.now() - startTime,
                method: `${step.category}:${step.intent}`
            };
        }
    }

    // ========================================================================
    // ACTION EXECUTION (uses CSWebElement for smart waits, retries, logging)
    // ========================================================================

    private async executeAction(
        page: Page,
        step: ParsedStep,
        element: MatchedElement | null,
        timeout: number
    ): Promise<ActionResult> {
        const { intent, parameters } = step;

        switch (intent) {
            case 'click': {
                this.requireElement(element, 'click');
                const el = this.createWrappedElement(element!, timeout);
                await el.click({ timeout });
                return this.success('click');
            }

            case 'double-click': {
                this.requireElement(element, 'double-click');
                const el = this.createWrappedElement(element!, timeout);
                await el.dblclick({ timeout });
                return this.success('double-click');
            }

            case 'right-click': {
                this.requireElement(element, 'right-click');
                const el = this.createWrappedElement(element!, timeout);
                await el.click({ button: 'right', timeout });
                return this.success('right-click');
            }

            case 'fill':
            case 'type': {
                this.requireElement(element, 'fill');
                this.requireValue(parameters, 'fill');
                const el = this.createWrappedElement(element!, timeout);
                await el.fill(parameters.value!, { timeout });
                return this.success('fill');
            }

            case 'clear': {
                this.requireElement(element, 'clear');
                const el = this.createWrappedElement(element!, timeout);
                await el.clear({ timeout });
                return this.success('clear');
            }

            case 'select': {
                this.requireElement(element, 'select');
                this.requireValue(parameters, 'select');
                const el = this.createWrappedElement(element!, timeout);
                await el.selectOption(parameters.value!, { timeout });
                return this.success('select');
            }

            case 'check': {
                this.requireElement(element, 'check');
                const el = this.createWrappedElement(element!, timeout);
                await el.check({ timeout });
                return this.success('check');
            }

            case 'uncheck': {
                this.requireElement(element, 'uncheck');
                const el = this.createWrappedElement(element!, timeout);
                await el.uncheck({ timeout });
                return this.success('uncheck');
            }

            case 'toggle': {
                this.requireElement(element, 'toggle');
                const el = this.createWrappedElement(element!, timeout);
                const isChecked = await el.isChecked();
                if (isChecked) {
                    await el.uncheck({ timeout });
                } else {
                    await el.check({ timeout });
                }
                return this.success('toggle');
            }

            case 'hover': {
                this.requireElement(element, 'hover');
                const el = this.createWrappedElement(element!, timeout);
                await el.hover({ timeout });
                return this.success('hover');
            }

            case 'scroll-to': {
                this.requireElement(element, 'scroll-to');
                const el = this.createWrappedElement(element!, timeout);
                await el.scrollIntoViewIfNeeded({ timeout });
                return this.success('scroll-to');
            }

            case 'scroll': {
                // Page-level scroll — no element wrapper needed
                const direction = parameters.value || 'down';
                const scrollAmount = direction === 'up' || direction === 'left' ? -500 : 500;
                if (direction === 'up' || direction === 'down') {
                    await page.mouse.wheel(0, scrollAmount);
                } else {
                    await page.mouse.wheel(scrollAmount, 0);
                }
                return this.success('scroll');
            }

            case 'focus': {
                this.requireElement(element, 'focus');
                const el = this.createWrappedElement(element!, timeout);
                await el.focus({ timeout });
                return this.success('focus');
            }

            case 'press-key': {
                const key = this.normalizeKey(parameters.key || '');
                if (!key) throw new Error('No key specified for press-key action');
                if (element) {
                    const el = this.createWrappedElement(element, timeout);
                    await el.press(key, { timeout });
                } else {
                    // Page-level keyboard — no element wrapper available
                    await page.keyboard.press(key);
                }
                return this.success('press-key');
            }

            case 'navigate':
                return await this.executeNavigation(page, parameters, timeout);

            case 'upload': {
                this.requireElement(element, 'upload');
                if (!parameters.filePath) throw new Error('No file path specified for upload');
                const el = this.createWrappedElement(element!, timeout);
                await el.setInputFiles(parameters.filePath, { timeout });
                return this.success('upload');
            }

            case 'drag': {
                this.requireElement(element, 'drag');
                if (!parameters.dragTarget) throw new Error('No drag target specified');
                const el = this.createWrappedElement(element!, timeout);
                // Build locator for drag target using text search
                const dragTargetLocator = page.getByText(parameters.dragTarget, { exact: false }).first();
                await el.dragTo(dragTargetLocator, { timeout });
                return this.success('drag');
            }

            case 'wait-for': {
                this.requireElement(element, 'wait-for');
                const el = this.createWrappedElement(element!, timeout);
                if (step.modifiers.negated) {
                    await el.waitForHidden(timeout);
                } else {
                    await el.waitForVisible(timeout);
                }
                return this.success('wait-for');
            }

            default:
                throw new Error(`Unsupported action intent: ${intent}`);
        }
    }

    // ========================================================================
    // ASSERTION EXECUTION (uses CSWebElement + CSAssert for screenshots)
    // ========================================================================

    private async executeAssertion(
        page: Page,
        step: ParsedStep,
        element: MatchedElement | null,
        timeout: number
    ): Promise<ActionResult> {
        const { intent, parameters, modifiers } = step;

        switch (intent) {
            case 'verify-visible': {
                this.requireElement(element, 'verify-visible');
                const el = this.createWrappedElement(element!, timeout);
                await el.waitForVisible(timeout);
                return this.success('verify-visible');
            }

            case 'verify-hidden': {
                this.requireElement(element, 'verify-hidden');
                const el = this.createWrappedElement(element!, timeout);
                await el.waitForHidden(timeout);
                return this.success('verify-hidden');
            }

            case 'verify-not-present': {
                this.requireElement(element, 'verify-not-present');
                const el = this.createWrappedElement(element!, timeout);
                await this.assertWithRetryAndScreenshot(
                    async () => (await el.count()) === 0,
                    `Expected element to not be present but it exists`,
                    timeout
                );
                return this.success('verify-not-present');
            }

            case 'verify-text': {
                this.requireElement(element, 'verify-text');
                const el = this.createWrappedElement(element!, timeout);
                if (parameters.expectedValue !== undefined) {
                    if (modifiers.negated) {
                        await this.assertWithRetryAndScreenshot(
                            async () => {
                                const text = (await el.textContent() || '').trim();
                                return text !== parameters.expectedValue;
                            },
                            `Expected text to NOT be "${parameters.expectedValue}"`,
                            timeout
                        );
                    } else {
                        await this.assertWithRetryAndScreenshot(
                            async () => {
                                const text = (await el.textContent() || '').trim();
                                return text === parameters.expectedValue;
                            },
                            `Expected text "${parameters.expectedValue}" but got different content`,
                            timeout
                        );
                    }
                } else {
                    await this.assertWithRetryAndScreenshot(
                        async () => {
                            const text = (await el.textContent() || '').trim();
                            return text.length > 0;
                        },
                        `Expected element to have text but it was empty`,
                        timeout
                    );
                }
                return this.success('verify-text');
            }

            case 'verify-contains': {
                this.requireElement(element, 'verify-contains');
                if (!parameters.expectedValue) throw new Error('No expected value for verify-contains');
                const el = this.createWrappedElement(element!, timeout);
                await this.assertWithRetryAndScreenshot(
                    async () => {
                        const text = (await el.textContent() || '');
                        return text.toLowerCase().includes(parameters.expectedValue!.toLowerCase());
                    },
                    `Expected element to contain text "${parameters.expectedValue}"`,
                    timeout
                );
                return this.success('verify-contains');
            }

            case 'verify-not-contains': {
                this.requireElement(element, 'verify-not-contains');
                if (!parameters.expectedValue) throw new Error('No expected value for verify-not-contains');
                const el = this.createWrappedElement(element!, timeout);
                await this.assertWithRetryAndScreenshot(
                    async () => {
                        const text = (await el.textContent() || '');
                        return !text.toLowerCase().includes(parameters.expectedValue!.toLowerCase());
                    },
                    `Expected element to NOT contain text "${parameters.expectedValue}"`,
                    timeout
                );
                return this.success('verify-not-contains');
            }

            case 'verify-enabled': {
                this.requireElement(element, 'verify-enabled');
                const el = this.createWrappedElement(element!, timeout);
                await this.assertWithRetryAndScreenshot(
                    async () => await el.isEnabled(),
                    `Expected element to be enabled but it is disabled`,
                    timeout
                );
                return this.success('verify-enabled');
            }

            case 'verify-disabled': {
                this.requireElement(element, 'verify-disabled');
                const el = this.createWrappedElement(element!, timeout);
                await this.assertWithRetryAndScreenshot(
                    async () => await el.isDisabled(),
                    `Expected element to be disabled but it is enabled`,
                    timeout
                );
                return this.success('verify-disabled');
            }

            case 'verify-checked': {
                this.requireElement(element, 'verify-checked');
                const el = this.createWrappedElement(element!, timeout);
                await this.assertWithRetryAndScreenshot(
                    async () => await el.isChecked(),
                    `Expected element to be checked but it is not`,
                    timeout
                );
                return this.success('verify-checked');
            }

            case 'verify-unchecked': {
                this.requireElement(element, 'verify-unchecked');
                const el = this.createWrappedElement(element!, timeout);
                await this.assertWithRetryAndScreenshot(
                    async () => !(await el.isChecked()),
                    `Expected element to be unchecked but it is checked`,
                    timeout
                );
                return this.success('verify-unchecked');
            }

            case 'verify-count': {
                this.requireElement(element, 'verify-count');
                if (parameters.count === undefined) throw new Error('No count specified for verify-count');
                const el = this.createWrappedElement(element!, timeout);
                await this.assertWithRetryAndScreenshot(
                    async () => (await el.count()) === parameters.count,
                    `Expected count to be ${parameters.count}`,
                    timeout
                );
                return this.success('verify-count');
            }

            case 'verify-value': {
                this.requireElement(element, 'verify-value');
                const el = this.createWrappedElement(element!, timeout);
                if (parameters.expectedValue !== undefined) {
                    await this.assertWithRetryAndScreenshot(
                        async () => {
                            const val = await el.inputValue();
                            return val === parameters.expectedValue;
                        },
                        `Expected input value "${parameters.expectedValue}"`,
                        timeout
                    );
                }
                return this.success('verify-value');
            }

            case 'verify-attribute': {
                this.requireElement(element, 'verify-attribute');
                if (!parameters.attribute) throw new Error('No attribute specified for verify-attribute');
                const el = this.createWrappedElement(element!, timeout);
                if (parameters.expectedValue !== undefined) {
                    await this.assertWithRetryAndScreenshot(
                        async () => {
                            const val = await el.getAttribute(parameters.attribute!);
                            return val === parameters.expectedValue;
                        },
                        `Expected attribute "${parameters.attribute}" to be "${parameters.expectedValue}"`,
                        timeout
                    );
                }
                return this.success('verify-attribute');
            }

            // Page-level assertions — no element wrapper needed
            case 'verify-url': {
                if (parameters.expectedValue) {
                    const expected = parameters.expectedValue;
                    if (expected.includes('*') || expected.startsWith('/')) {
                        const regex = new RegExp(this.escapeRegex(expected).replace('\\*', '.*'));
                        await this.assertWithRetryAndScreenshot(
                            async () => regex.test(page.url()),
                            `Expected URL to match "${expected}" but got "${page.url()}"`,
                            timeout
                        );
                    } else {
                        await this.assertWithRetryAndScreenshot(
                            async () => page.url().includes(expected),
                            `Expected URL to contain "${expected}" but got "${page.url()}"`,
                            timeout
                        );
                    }
                }
                return this.success('verify-url');
            }

            case 'verify-title': {
                if (parameters.expectedValue) {
                    const expected = parameters.expectedValue;
                    await this.assertWithRetryAndScreenshot(
                        async () => {
                            const title = await page.title();
                            return title.includes(expected);
                        },
                        `Expected page title to contain "${parameters.expectedValue}"`,
                        timeout
                    );
                }
                return this.success('verify-title');
            }

            default:
                throw new Error(`Unsupported assertion intent: ${intent}`);
        }
    }

    // ========================================================================
    // QUERY EXECUTION (uses CSWebElement for retries, stale-element recovery)
    // ========================================================================

    private async executeQuery(
        page: Page,
        step: ParsedStep,
        element: MatchedElement | null,
        timeout: number
    ): Promise<ActionResult> {
        const { intent, parameters } = step;

        switch (intent) {
            case 'get-text': {
                this.requireElement(element, 'get-text');
                const el = this.createWrappedElement(element!, timeout);
                await el.waitForVisible(timeout);
                const text = await el.textContent() || '';
                return this.success('get-text', text.trim());
            }

            case 'get-value': {
                this.requireElement(element, 'get-value');
                const el = this.createWrappedElement(element!, timeout);
                await el.waitForVisible(timeout);
                const value = await el.inputValue();
                return this.success('get-value', value);
            }

            case 'get-attribute': {
                this.requireElement(element, 'get-attribute');
                if (!parameters.attribute) throw new Error('No attribute specified for get-attribute');
                const el = this.createWrappedElement(element!, timeout);
                const attr = await el.getAttribute(parameters.attribute);
                return this.success('get-attribute', attr || '');
            }

            case 'get-count': {
                this.requireElement(element, 'get-count');
                const el = this.createWrappedElement(element!, timeout);
                const count = await el.count();
                return this.success('get-count', count);
            }

            case 'get-list': {
                this.requireElement(element, 'get-list');
                const el = this.createWrappedElement(element!, timeout);
                const texts = await el.allTextContents();
                return this.success('get-list', texts);
            }

            // Page-level queries — no element wrapper needed
            case 'get-url': {
                const url = page.url();
                return this.success('get-url', url);
            }

            case 'get-title': {
                const title = await page.title();
                return this.success('get-title', title);
            }

            case 'check-exists': {
                if (!element) {
                    return this.success('check-exists', false);
                }
                const el = this.createWrappedElement(element, timeout);
                const exists = (await el.count()) > 0;
                return this.success('check-exists', exists);
            }

            default:
                throw new Error(`Unsupported query intent: ${intent}`);
        }
    }

    // ========================================================================
    // NAVIGATION (uses CSBrowserManager for spinner detection, proper timeouts)
    // ========================================================================

    private async executeNavigation(
        page: Page,
        parameters: StepParameters,
        timeout: number
    ): Promise<ActionResult> {
        const url = parameters.url || '';
        // Navigation inherently needs more time than element interactions
        // Use at least 30s for page.goto/goBack/goForward/reload
        const navTimeout = Math.max(timeout, 30000);

        switch (url.toLowerCase()) {
            case 'back':
                await page.goBack({ timeout: navTimeout, waitUntil: 'domcontentloaded' });
                return this.success('navigate-back');
            case 'forward':
                await page.goForward({ timeout: navTimeout, waitUntil: 'domcontentloaded' });
                return this.success('navigate-forward');
            case 'reload':
                await page.reload({ timeout: navTimeout, waitUntil: 'domcontentloaded' });
                return this.success('navigate-reload');
            default:
                if (!url) throw new Error('No URL specified for navigation');
                // Use CSBrowserManager for spinner detection and proper timeout handling
                const browserManager = getBrowserManager();
                await browserManager.navigateAndWaitReady(url, {
                    timeout: navTimeout,
                    waitUntil: 'domcontentloaded'
                });
                return this.success('navigate');
        }
    }

    // ========================================================================
    // ERROR RECOVERY (uses CSWebElement for scroll + alternatives)
    // ========================================================================

    private async tryErrorRecovery(
        page: Page,
        step: ParsedStep,
        element: MatchedElement | null,
        error: Error,
        timeout: number
    ): Promise<ActionResult | null> {
        const retries = this.config.retries;

        if (retries <= 0) return null;

        CSReporter.debug(`CSAIActionExecutor: Attempting error recovery for ${step.intent}: ${error.message}`);

        // Set recovery guard to prevent infinite recursion
        this.inRecovery = true;

        try {
            // Recovery 1: Scroll into view using CSWebElement and retry
            if (element) {
                try {
                    const el = this.createWrappedElement(element, 3000);
                    await el.scrollIntoViewIfNeeded({ timeout: 3000 });
                    await new Promise(resolve => setTimeout(resolve, 500));

                    // Retry the action (inRecovery flag prevents re-entry into recovery)
                    return await this.execute(page, { ...step, parameters: { ...step.parameters, timeout } }, element);
                } catch {
                    // Recovery 1 failed
                }
            }

            // Recovery 2: Try with alternative locators
            // Each alternative gets wrapped in CSWebElement automatically
            // when this.execute() re-enters executeAction/Query/Assertion
            if (element?.alternatives && element.alternatives.length > 0) {
                for (const alt of element.alternatives) {
                    try {
                        CSReporter.debug(`CSAIActionExecutor: Trying alternative locator: ${alt.description}`);
                        const altElement: MatchedElement = {
                            ...alt,
                            alternatives: []
                        };
                        const result = await this.execute(page, step, altElement);
                        if (result.success) return result;
                    } catch {
                        continue;
                    }
                }
            }

            return null;
        } finally {
            // Always reset the recovery guard
            this.inRecovery = false;
        }
    }

    // ========================================================================
    // HELPERS
    // ========================================================================

    /**
     * Create a CSWebElement from a MatchedElement's raw Locator.
     * The CSWebElement wrapper provides: smart waits, retry logic,
     * self-healing (stale element recovery), performance tracking, and logging.
     */
    private createWrappedElement(element: MatchedElement, timeout: number): CSWebElement {
        return CSElementFactory.fromLocator(
            element.locator,
            element.description,
            {
                timeout,
                // retryCount=1 to avoid double-retry: CSWebElement has its own retry loop,
                // and the AI executor's tryErrorRecovery() handles higher-level recovery
                retryCount: 1
            }
        );
    }

    /**
     * Validate that a MatchedElement with a locator exists for an action
     */
    private requireElement(element: MatchedElement | null, action: string): asserts element is MatchedElement {
        if (!element || !element.locator) {
            throw new Error(`No element found for ${action} action. Please check the element description.`);
        }
    }

    private requireValue(params: StepParameters, action: string): void {
        if (params.value === undefined || params.value === null) {
            throw new Error(`No value specified for ${action} action. Provide a quoted value in the instruction.`);
        }
    }

    private success(method: string, returnValue?: string | number | boolean | string[]): ActionResult {
        return {
            success: true,
            returnValue,
            duration: 0,
            method
        };
    }

    /**
     * Polling assertion with CSAssert screenshot capture on final failure.
     * Polls a condition function until it returns true or timeout expires.
     * On failure, uses CSAssert.assertTrue(false) to capture a pre-failure screenshot
     * before throwing the error.
     */
    private async assertWithRetryAndScreenshot(
        conditionFn: () => Promise<boolean>,
        errorMessage: string,
        timeout: number,
        pollInterval: number = 250
    ): Promise<void> {
        const deadline = Date.now() + timeout;
        let lastError: Error | null = null;

        while (Date.now() < deadline) {
            try {
                const result = await conditionFn();
                if (result) return;
            } catch (e: any) {
                lastError = e;
            }
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        // Polling failed — capture screenshot via CSAssert, then throw
        const finalMessage = lastError ? `${errorMessage}: ${lastError.message}` : errorMessage;
        try {
            const csAssert = getCSAssert();
            await csAssert.assertTrue(false, finalMessage);
        } catch {
            // CSAssert.assertTrue(false) always throws — re-throw with our message
            throw new Error(finalMessage);
        }
    }

    private normalizeKey(key: string): string {
        // Map common key names to Playwright key identifiers
        const keyMap: Record<string, string> = {
            'enter': 'Enter',
            'return': 'Enter',
            'tab': 'Tab',
            'escape': 'Escape',
            'esc': 'Escape',
            'space': ' ',
            'spacebar': ' ',
            'backspace': 'Backspace',
            'delete': 'Delete',
            'del': 'Delete',
            'arrow up': 'ArrowUp',
            'arrow down': 'ArrowDown',
            'arrow left': 'ArrowLeft',
            'arrow right': 'ArrowRight',
            'up': 'ArrowUp',
            'down': 'ArrowDown',
            'left': 'ArrowLeft',
            'right': 'ArrowRight',
            'home': 'Home',
            'end': 'End',
            'page up': 'PageUp',
            'page down': 'PageDown',
            'f1': 'F1', 'f2': 'F2', 'f3': 'F3', 'f4': 'F4',
            'f5': 'F5', 'f6': 'F6', 'f7': 'F7', 'f8': 'F8',
            'f9': 'F9', 'f10': 'F10', 'f11': 'F11', 'f12': 'F12'
        };

        return keyMap[key.toLowerCase()] || key;
    }

    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}
