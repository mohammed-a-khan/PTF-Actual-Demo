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

            // ================================================================
            // ENHANCED WAIT STRATEGIES (Phase 1)
            // ================================================================

            case 'wait-seconds': {
                const waitMs = parameters.timeout || 1000;
                CSReporter.debug(`AI Step: Waiting ${waitMs}ms`);
                await page.waitForTimeout(waitMs);
                return this.success('wait-seconds');
            }

            case 'wait-url-change': {
                const urlPattern = parameters.url;
                if (urlPattern) {
                    // Wait for URL to contain specific pattern
                    await page.waitForURL(`**/*${urlPattern}*`, { timeout });
                } else {
                    // Wait for any URL change
                    const currentUrl = page.url();
                    await page.waitForFunction(
                        (prevUrl: string) => window.location.href !== prevUrl,
                        currentUrl,
                        { timeout }
                    );
                }
                return this.success('wait-url-change');
            }

            case 'wait-text-change': {
                this.requireElement(element, 'wait-text-change');
                const el = this.createWrappedElement(element!, timeout);
                if (parameters.expectedValue) {
                    // Wait for text to become expected value
                    const expected = parameters.expectedValue;
                    await this.assertWithRetryAndScreenshot(
                        async () => {
                            const text = (await el.textContent() || '').trim();
                            return text === expected;
                        },
                        `Expected text to become "${expected}"`,
                        timeout,
                        500
                    );
                } else {
                    // Wait for text to change from current value
                    const initialText = (await el.textContent() || '').trim();
                    await this.assertWithRetryAndScreenshot(
                        async () => {
                            const text = (await el.textContent() || '').trim();
                            return text !== initialText;
                        },
                        `Expected text to change from "${initialText}"`,
                        timeout,
                        500
                    );
                }
                return this.success('wait-text-change');
            }

            // ================================================================
            // BROWSER & TAB MANAGEMENT (Phase 2)
            // ================================================================

            case 'switch-tab': {
                const browserManager = getBrowserManager();
                if (parameters.tabIndex !== undefined) {
                    if (parameters.tabIndex === -1) {
                        // Switch to latest tab
                        const pages = browserManager.getContext().pages();
                        const latestPage = pages[pages.length - 1];
                        browserManager.setCurrentPage(latestPage);
                        await latestPage.bringToFront();
                    } else if (parameters.tabIndex === 0) {
                        // Switch to main/first tab
                        const pages = browserManager.getContext().pages();
                        const mainPage = pages[0];
                        browserManager.setCurrentPage(mainPage);
                        await mainPage.bringToFront();
                    } else {
                        // Switch to specific tab by index (1-based from user, convert to 0-based)
                        const pages = browserManager.getContext().pages();
                        const targetIdx = parameters.tabIndex - 1;
                        if (targetIdx >= 0 && targetIdx < pages.length) {
                            browserManager.setCurrentPage(pages[targetIdx]);
                            await pages[targetIdx].bringToFront();
                        } else {
                            throw new Error(`Tab index ${parameters.tabIndex} out of range (${pages.length} tabs open)`);
                        }
                    }
                } else {
                    // Default: switch to latest tab
                    const pages = browserManager.getContext().pages();
                    const latestPage = pages[pages.length - 1];
                    browserManager.setCurrentPage(latestPage);
                    await latestPage.bringToFront();
                }
                return this.success('switch-tab');
            }

            case 'open-new-tab': {
                const browserManager = getBrowserManager();
                const context = browserManager.getContext();
                const newPage = await context.newPage();
                browserManager.setCurrentPage(newPage);
                if (parameters.url) {
                    await newPage.goto(parameters.url, { timeout: Math.max(timeout, 30000), waitUntil: 'domcontentloaded' });
                }
                return this.success('open-new-tab');
            }

            case 'close-tab': {
                const browserManager = getBrowserManager();
                if (parameters.tabIndex !== undefined && parameters.tabIndex > 0) {
                    // Close specific tab by index
                    const pages = browserManager.getContext().pages();
                    const targetIdx = parameters.tabIndex - 1;
                    if (targetIdx >= 0 && targetIdx < pages.length) {
                        await pages[targetIdx].close();
                    }
                } else {
                    // Close current tab
                    await page.close();
                }
                // Switch to first remaining tab
                const remainingPages = browserManager.getContext().pages();
                if (remainingPages.length > 0) {
                    browserManager.setCurrentPage(remainingPages[remainingPages.length - 1]);
                    await remainingPages[remainingPages.length - 1].bringToFront();
                }
                return this.success('close-tab');
            }

            case 'switch-browser': {
                if (!parameters.browserType) throw new Error('No browser type specified for switch-browser');
                const browserManager = getBrowserManager();
                await browserManager.switchBrowser(parameters.browserType);
                return this.success('switch-browser');
            }

            case 'clear-session': {
                const browserManager = getBrowserManager();
                const context = browserManager.getContext();
                // Clear cookies
                await context.clearCookies();
                // Clear storage
                const currentPage = browserManager.getPage();
                if (currentPage) {
                    try {
                        await currentPage.evaluate(() => {
                            localStorage.clear();
                            sessionStorage.clear();
                        });
                    } catch {
                        // Page might not have storage access — non-critical
                    }
                }
                // Navigate to login URL if provided
                if (parameters.loginUrl && currentPage) {
                    await currentPage.goto(parameters.loginUrl, { timeout: Math.max(timeout, 30000), waitUntil: 'domcontentloaded' });
                } else if (currentPage) {
                    await currentPage.reload({ timeout: Math.max(timeout, 30000), waitUntil: 'domcontentloaded' });
                }
                return this.success('clear-session');
            }

            // ================================================================
            // FRAME/IFRAME SWITCHING (Phase 8)
            // ================================================================

            case 'switch-frame': {
                if (!parameters.frameSelector) throw new Error('No frame selector specified');
                const browserManager = getBrowserManager();
                const currentPage = browserManager.getPage();
                if (!currentPage) throw new Error('No active page for switch-frame');

                // Try by name first, then by selector, then by index
                const selector = parameters.frameSelector;
                let frame = currentPage.frame({ name: selector });
                if (!frame) {
                    frame = currentPage.frame({ url: new RegExp(this.escapeRegex(selector)) });
                }
                if (!frame) {
                    // Try as CSS selector via frameLocator — store for subsequent AI steps
                    // We can't directly return a frame reference, but we can set the page context
                    const frameIndex = parseInt(selector);
                    if (!isNaN(frameIndex)) {
                        const frames = currentPage.frames();
                        if (frameIndex >= 0 && frameIndex < frames.length) {
                            frame = frames[frameIndex];
                        }
                    }
                }
                if (!frame) {
                    throw new Error(`Frame not found: "${selector}". Try a frame name, URL pattern, or index.`);
                }
                CSReporter.debug(`AI Step: Switched to frame "${frame.name() || frame.url()}"`);
                return this.success('switch-frame');
            }

            case 'switch-main-frame': {
                CSReporter.debug('AI Step: Switched to main frame');
                return this.success('switch-main-frame');
            }

            // ================================================================
            // DATA GENERATION & CONTEXT (Phase 7)
            // ================================================================

            case 'set-variable': {
                // Variable setting is handled at BDD layer (CSAIStepBDD)
                // This intent signals the executor to return the value for storage
                if (!parameters.variableName) throw new Error('No variable name specified for set-variable');
                return this.success('set-variable', parameters.value || '');
            }

            case 'take-screenshot': {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const fileName = parameters.screenshotName || `ai-screenshot-${timestamp}.png`;
                await page.screenshot({ path: fileName, fullPage: true });
                CSReporter.info(`AI Step: Screenshot saved as ${fileName}`);
                return this.success('take-screenshot', fileName);
            }

            // ================================================================
            // COOKIE & STORAGE ACTIONS (Phase 9)
            // ================================================================

            case 'clear-cookies': {
                await page.context().clearCookies();
                return this.success('clear-cookies');
            }

            case 'set-cookie': {
                if (!parameters.cookieName || !parameters.value) throw new Error('Cookie name and value required');
                const domain = new URL(page.url()).hostname;
                await page.context().addCookies([{
                    name: parameters.cookieName,
                    value: parameters.value,
                    domain,
                    path: '/'
                }]);
                return this.success('set-cookie');
            }

            case 'clear-storage': {
                const storType = parameters.storageType;
                await page.evaluate((type: string | undefined) => {
                    if (!type || type === 'local') localStorage.clear();
                    if (!type || type === 'session') sessionStorage.clear();
                }, storType);
                return this.success('clear-storage');
            }

            case 'set-storage-item': {
                if (!parameters.storageKey) throw new Error('No storage key specified');
                const sType = parameters.storageType || 'local';
                await page.evaluate(
                    (args: { key: string; value: string; type: string }) => {
                        const storage = args.type === 'session' ? sessionStorage : localStorage;
                        storage.setItem(args.key, args.value);
                    },
                    { key: parameters.storageKey, value: parameters.value || '', type: sType }
                );
                return this.success('set-storage-item');
            }

            // ================================================================
            // INLINE API CALLS (Phase 11)
            // ================================================================

            case 'api-call': {
                if (!parameters.apiUrl) throw new Error('No API URL specified');
                const method = parameters.httpMethod || 'GET';
                const requestOptions: any = { method };
                if (parameters.requestBody) {
                    requestOptions.headers = { 'Content-Type': 'application/json' };
                    requestOptions.data = parameters.requestBody;
                }
                // Use Playwright's built-in request API
                const apiContext = page.context().request || page.request;
                let response: any;
                switch (method.toUpperCase()) {
                    case 'GET':
                        response = await apiContext.get(parameters.apiUrl);
                        break;
                    case 'POST':
                        response = await apiContext.post(parameters.apiUrl, requestOptions);
                        break;
                    case 'PUT':
                        response = await apiContext.put(parameters.apiUrl, requestOptions);
                        break;
                    case 'PATCH':
                        response = await apiContext.patch(parameters.apiUrl, requestOptions);
                        break;
                    case 'DELETE':
                        response = await apiContext.delete(parameters.apiUrl);
                        break;
                    default:
                        response = await apiContext.fetch(parameters.apiUrl, requestOptions);
                }
                // Store response for subsequent verification
                let responseBody: string;
                try {
                    responseBody = await response.text();
                } catch {
                    responseBody = '';
                }
                (this as any)._lastApiResponse = {
                    status: response.status(),
                    body: responseBody,
                    headers: response.headers()
                };
                CSReporter.debug(`AI Step: API ${method} ${parameters.apiUrl} → ${response.status()}`);
                return this.success('api-call');
            }

            // ================================================================
            // JAVASCRIPT EXECUTION (Phase 12)
            // ================================================================

            case 'execute-js': {
                if (!parameters.script) throw new Error('No JavaScript specified for execute-js');
                await page.evaluate(parameters.script);
                return this.success('execute-js');
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

            // ================================================================
            // ENHANCED ASSERTIONS (Phase 4)
            // ================================================================

            case 'verify-css': {
                this.requireElement(element, 'verify-css');
                if (!parameters.cssProperty) throw new Error('No CSS property specified for verify-css');
                const el = this.createWrappedElement(element!, timeout);
                const locator = element!.locator;
                const actualCss = await locator.evaluate(
                    (el: Element, prop: string) => window.getComputedStyle(el).getPropertyValue(prop),
                    parameters.cssProperty
                );
                if (parameters.expectedValue) {
                    await this.assertWithRetryAndScreenshot(
                        async () => actualCss.trim() === parameters.expectedValue,
                        `Expected CSS "${parameters.cssProperty}" to be "${parameters.expectedValue}" but got "${actualCss}"`,
                        timeout
                    );
                }
                return this.success('verify-css');
            }

            case 'verify-matches': {
                this.requireElement(element, 'verify-matches');
                if (!parameters.regexPattern) throw new Error('No regex pattern specified for verify-matches');
                const el = this.createWrappedElement(element!, timeout);
                const pattern = new RegExp(parameters.regexPattern);
                await this.assertWithRetryAndScreenshot(
                    async () => {
                        const text = (await el.textContent() || '').trim();
                        return pattern.test(text);
                    },
                    `Expected text to match pattern "${parameters.regexPattern}"`,
                    timeout
                );
                return this.success('verify-matches');
            }

            case 'verify-selected-option': {
                this.requireElement(element, 'verify-selected-option');
                const locator = element!.locator;
                if (parameters.expectedValue) {
                    await this.assertWithRetryAndScreenshot(
                        async () => {
                            const selectedText = await locator.evaluate((el: any) => {
                                if (el.tagName === 'SELECT' && el.selectedIndex >= 0) {
                                    return el.options[el.selectedIndex].text;
                                }
                                return el.value || el.textContent || '';
                            });
                            return selectedText.trim() === parameters.expectedValue;
                        },
                        `Expected selected option to be "${parameters.expectedValue}"`,
                        timeout
                    );
                }
                return this.success('verify-selected-option');
            }

            case 'verify-dropdown-options': {
                this.requireElement(element, 'verify-dropdown-options');
                if (!parameters.expectedValue) throw new Error('No expected options for verify-dropdown-options');
                const locator = element!.locator;
                const expectedOptions = parameters.expectedValue.split(',').map(o => o.trim());
                await this.assertWithRetryAndScreenshot(
                    async () => {
                        const actualOptions: string[] = await locator.evaluate((el: any) => {
                            if (el.tagName === 'SELECT') {
                                return Array.from(el.options).map((o: any) => o.text.trim());
                            }
                            // For custom dropdowns, check aria-role listbox children
                            const items = el.querySelectorAll('[role="option"], option, li');
                            return Array.from(items).map((item: any) => item.textContent.trim());
                        });
                        return expectedOptions.every(exp =>
                            actualOptions.some(act => act.toLowerCase().includes(exp.toLowerCase()))
                        );
                    },
                    `Expected dropdown to contain options: ${expectedOptions.join(', ')}`,
                    timeout
                );
                return this.success('verify-dropdown-options');
            }

            // ================================================================
            // URL PARAMETER ASSERTIONS (Phase 5)
            // ================================================================

            case 'verify-url-param': {
                const paramName = parameters.urlParam;
                if (!paramName) throw new Error('No URL parameter name specified');
                const url = new URL(page.url());
                const paramValue = url.searchParams.get(paramName);
                if (parameters.expectedValue) {
                    await this.assertWithRetryAndScreenshot(
                        async () => {
                            const currentUrl = new URL(page.url());
                            const val = currentUrl.searchParams.get(paramName);
                            return val === parameters.expectedValue;
                        },
                        `Expected URL parameter "${paramName}" to be "${parameters.expectedValue}" but got "${paramValue}"`,
                        timeout
                    );
                } else {
                    // Just verify the parameter exists
                    await this.assertWithRetryAndScreenshot(
                        async () => {
                            const currentUrl = new URL(page.url());
                            return currentUrl.searchParams.has(paramName);
                        },
                        `Expected URL to contain parameter "${paramName}"`,
                        timeout
                    );
                }
                return this.success('verify-url-param');
            }

            // ================================================================
            // TABLE CELL VERIFICATION (Phase 6)
            // ================================================================

            case 'verify-table-cell': {
                this.requireElement(element, 'verify-table-cell');
                if (!parameters.expectedValue) throw new Error('No expected value for verify-table-cell');
                const locator = element!.locator;
                const rowIdx = parameters.rowIndex || 1;
                const colRef = parameters.columnRef || '1';

                await this.assertWithRetryAndScreenshot(
                    async () => {
                        const cellValue = await locator.evaluate(
                            (table: any, args: { rowIdx: number; colRef: string }) => {
                                const rows = table.querySelectorAll('tbody tr');
                                if (args.rowIdx - 1 >= rows.length) return '';
                                const row = rows[args.rowIdx - 1];
                                let colIndex = parseInt(args.colRef) - 1;
                                if (isNaN(colIndex)) {
                                    // Resolve column by header name
                                    const headers = Array.from(table.querySelectorAll('thead th')).map((th: any) => th.textContent.trim());
                                    colIndex = headers.findIndex((h: string) => h.toLowerCase() === args.colRef.toLowerCase());
                                }
                                const cells = row.querySelectorAll('td');
                                return colIndex >= 0 && colIndex < cells.length ? cells[colIndex].textContent.trim() : '';
                            },
                            { rowIdx, colRef }
                        );
                        return cellValue === parameters.expectedValue;
                    },
                    `Expected table cell at row ${rowIdx} column "${colRef}" to be "${parameters.expectedValue}"`,
                    timeout
                );
                return this.success('verify-table-cell');
            }

            // ================================================================
            // DOWNLOAD VERIFICATION (Phase 10)
            // ================================================================

            case 'verify-download': {
                // Check recent downloads for file
                const downloadsDir = './downloads';
                const fs = require('fs');
                const path = require('path');
                if (parameters.fileName) {
                    const filePath = path.join(downloadsDir, parameters.fileName);
                    await this.assertWithRetryAndScreenshot(
                        async () => fs.existsSync(filePath),
                        `Expected file "${parameters.fileName}" to be downloaded in ${downloadsDir}`,
                        timeout,
                        1000
                    );
                } else {
                    // Just verify any download happened
                    await this.assertWithRetryAndScreenshot(
                        async () => fs.existsSync(downloadsDir) && fs.readdirSync(downloadsDir).length > 0,
                        `Expected at least one file to be downloaded`,
                        timeout,
                        1000
                    );
                }
                return this.success('verify-download');
            }

            case 'verify-download-content': {
                if (!parameters.fileContent) throw new Error('No expected content for verify-download-content');
                const fsModule = require('fs');
                const pathModule = require('path');
                const downloadsPath = './downloads';
                let targetFile = parameters.fileName;
                if (!targetFile) {
                    // Use the most recently modified file in downloads
                    const files = fsModule.readdirSync(downloadsPath)
                        .map((f: string) => ({ name: f, time: fsModule.statSync(pathModule.join(downloadsPath, f)).mtime.getTime() }))
                        .sort((a: any, b: any) => b.time - a.time);
                    targetFile = files.length > 0 ? files[0].name : undefined;
                }
                if (!targetFile) throw new Error('No downloaded file found to verify content');
                const fullPath = pathModule.join(downloadsPath, targetFile);
                const content = fsModule.readFileSync(fullPath, 'utf-8');
                if (!content.includes(parameters.fileContent)) {
                    throw new Error(`Downloaded file "${targetFile}" does not contain "${parameters.fileContent}"`);
                }
                return this.success('verify-download-content');
            }

            // ================================================================
            // API RESPONSE VERIFICATION (Phase 11)
            // ================================================================

            case 'verify-api-response': {
                // Check last stored API response
                const lastResponse = (this as any)._lastApiResponse;
                if (!lastResponse) throw new Error('No API response to verify. Call an API first.');
                if (parameters.httpMethod === 'STATUS') {
                    const expectedStatus = parseInt(parameters.expectedValue || '200');
                    if (lastResponse.status !== expectedStatus) {
                        throw new Error(`Expected API status ${expectedStatus} but got ${lastResponse.status}`);
                    }
                } else if (parameters.expectedValue) {
                    const body = typeof lastResponse.body === 'string' ? lastResponse.body : JSON.stringify(lastResponse.body);
                    if (!body.includes(parameters.expectedValue)) {
                        throw new Error(`API response does not contain "${parameters.expectedValue}"`);
                    }
                }
                return this.success('verify-api-response');
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

            // ================================================================
            // URL PARAMETER QUERIES (Phase 5)
            // ================================================================

            case 'get-url-param': {
                const paramName = parameters.urlParam;
                if (!paramName) throw new Error('No URL parameter name specified');
                const currentUrl = new URL(page.url());
                const paramValue = currentUrl.searchParams.get(paramName);
                return this.success('get-url-param', paramValue || '');
            }

            // ================================================================
            // TABLE DATA QUERIES (Phase 6)
            // ================================================================

            case 'get-table-data': {
                this.requireElement(element, 'get-table-data');
                const locator = element!.locator;
                const tableData = await locator.evaluate((table: any) => {
                    const headers = Array.from(table.querySelectorAll('thead th')).map((th: any) => th.textContent.trim());
                    const rows = Array.from(table.querySelectorAll('tbody tr'));
                    return rows.map((row: any) => {
                        const cells = Array.from(row.querySelectorAll('td')).map((td: any) => td.textContent.trim());
                        const rowData: Record<string, string> = {};
                        cells.forEach((cell: string, i: number) => {
                            rowData[headers[i] || `column${i + 1}`] = cell;
                        });
                        return rowData;
                    });
                });
                return this.success('get-table-data', JSON.stringify(tableData));
            }

            case 'get-table-cell': {
                this.requireElement(element, 'get-table-cell');
                const locatorCell = element!.locator;
                const rowIdx = parameters.rowIndex || 1;
                const colRef = parameters.columnRef || '1';
                const cellValue = await locatorCell.evaluate(
                    (table: any, args: { rowIdx: number; colRef: string }) => {
                        const rows = table.querySelectorAll('tbody tr');
                        if (args.rowIdx - 1 >= rows.length) return '';
                        const row = rows[args.rowIdx - 1];
                        let colIndex = parseInt(args.colRef) - 1;
                        if (isNaN(colIndex)) {
                            const headers = Array.from(table.querySelectorAll('thead th')).map((th: any) => th.textContent.trim());
                            colIndex = headers.findIndex((h: string) => h.toLowerCase() === args.colRef.toLowerCase());
                        }
                        const cells = row.querySelectorAll('td');
                        return colIndex >= 0 && colIndex < cells.length ? cells[colIndex].textContent.trim() : '';
                    },
                    { rowIdx, colRef }
                );
                return this.success('get-table-cell', cellValue);
            }

            case 'get-table-column': {
                this.requireElement(element, 'get-table-column');
                const locatorCol = element!.locator;
                const colRefForColumn = parameters.columnRef || '1';
                const columnValues: string[] = await locatorCol.evaluate(
                    (table: any, colRef: string) => {
                        let colIndex = parseInt(colRef) - 1;
                        if (isNaN(colIndex)) {
                            const headers = Array.from(table.querySelectorAll('thead th')).map((th: any) => th.textContent.trim());
                            colIndex = headers.findIndex((h: string) => h.toLowerCase() === colRef.toLowerCase());
                        }
                        if (colIndex < 0) return [];
                        const rows = Array.from(table.querySelectorAll('tbody tr'));
                        return rows.map((row: any) => {
                            const cells = row.querySelectorAll('td');
                            return colIndex < cells.length ? cells[colIndex].textContent.trim() : '';
                        });
                    },
                    colRefForColumn
                );
                return this.success('get-table-column', columnValues);
            }

            case 'get-table-row-count': {
                this.requireElement(element, 'get-table-row-count');
                const locatorRows = element!.locator;
                const rowCount = await locatorRows.evaluate(
                    (table: any) => table.querySelectorAll('tbody tr').length
                );
                return this.success('get-table-row-count', rowCount);
            }

            // ================================================================
            // DATA GENERATION (Phase 7)
            // ================================================================

            case 'generate-data': {
                const dataType = parameters.dataType || 'uuid';
                let generatedValue: string;
                switch (dataType) {
                    case 'uuid': {
                        const crypto = require('crypto');
                        generatedValue = crypto.randomUUID();
                        break;
                    }
                    case 'timestamp':
                        generatedValue = new Date().toISOString();
                        break;
                    case 'random-string': {
                        const len = parameters.length || 10;
                        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                        generatedValue = Array.from({ length: len }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
                        break;
                    }
                    case 'random-number': {
                        const min = parameters.rangeMin ?? 1;
                        const max = parameters.rangeMax ?? 1000;
                        generatedValue = String(Math.floor(Math.random() * (max - min + 1)) + min);
                        break;
                    }
                    case 'random-email': {
                        const randomStr = Math.random().toString(36).substring(2, 10);
                        generatedValue = `test.${randomStr}@test-automation.com`;
                        break;
                    }
                    default:
                        throw new Error(`Unknown data type: ${dataType}`);
                }
                CSReporter.debug(`AI Step: Generated ${dataType}: ${generatedValue}`);
                return this.success('generate-data', generatedValue);
            }

            // ================================================================
            // COOKIE & STORAGE QUERIES (Phase 9)
            // ================================================================

            case 'get-cookie': {
                if (!parameters.cookieName) throw new Error('No cookie name specified');
                const cookies = await page.context().cookies();
                const cookie = cookies.find((c: any) => c.name === parameters.cookieName);
                return this.success('get-cookie', cookie ? cookie.value : '');
            }

            case 'get-storage-item': {
                if (!parameters.storageKey) throw new Error('No storage key specified');
                const storageType = parameters.storageType || 'local';
                const storageValue = await page.evaluate(
                    (args: { key: string; type: string }) => {
                        const storage = args.type === 'session' ? sessionStorage : localStorage;
                        return storage.getItem(args.key);
                    },
                    { key: parameters.storageKey, type: storageType }
                );
                return this.success('get-storage-item', storageValue || '');
            }

            // ================================================================
            // DOWNLOAD PATH QUERY (Phase 10)
            // ================================================================

            case 'get-download-path': {
                const fsPath = require('fs');
                const pathMod = require('path');
                const dlDir = './downloads';
                if (!fsPath.existsSync(dlDir)) return this.success('get-download-path', '');
                const downloadFiles = fsPath.readdirSync(dlDir)
                    .map((f: string) => ({ name: f, time: fsPath.statSync(pathMod.join(dlDir, f)).mtime.getTime() }))
                    .sort((a: any, b: any) => b.time - a.time);
                const latestFile = downloadFiles.length > 0 ? pathMod.join(dlDir, downloadFiles[0].name) : '';
                return this.success('get-download-path', latestFile);
            }

            // ================================================================
            // API RESPONSE QUERIES (Phase 11)
            // ================================================================

            case 'get-api-response': {
                const storedResponse = (this as any)._lastApiResponse;
                if (!storedResponse) throw new Error('No API response available. Call an API first.');
                if (parameters.jsonPath) {
                    // Simple JSONPath extraction (supports $.key.subkey format)
                    const body = typeof storedResponse.body === 'string' ? JSON.parse(storedResponse.body) : storedResponse.body;
                    const pathParts = parameters.jsonPath.replace('$.', '').split('.');
                    let value: any = body;
                    for (const part of pathParts) {
                        value = value?.[part];
                    }
                    return this.success('get-api-response', typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''));
                }
                const bodyStr = typeof storedResponse.body === 'string' ? storedResponse.body : JSON.stringify(storedResponse.body);
                return this.success('get-api-response', bodyStr);
            }

            // ================================================================
            // JAVASCRIPT EVALUATION (Phase 12)
            // ================================================================

            case 'evaluate-js': {
                if (!parameters.script) throw new Error('No JavaScript specified for evaluate-js');
                const jsResult = await page.evaluate(parameters.script);
                return this.success('evaluate-js', typeof jsResult === 'object' ? JSON.stringify(jsResult) : String(jsResult ?? ''));
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

        // Check for key combinations (Ctrl+A, Control+Shift+Delete, etc.)
        if (key.includes('+')) {
            const parts = key.split(/\s*\+\s*/);
            const normalizedParts = parts.map(part => {
                const lower = part.toLowerCase().trim();
                // Normalize modifier keys
                const modifierMap: Record<string, string> = {
                    'ctrl': 'Control',
                    'control': 'Control',
                    'alt': 'Alt',
                    'shift': 'Shift',
                    'meta': 'Meta',
                    'cmd': 'Meta',
                    'command': 'Meta'
                };
                if (modifierMap[lower]) return modifierMap[lower];
                // Normalize regular keys
                if (keyMap[lower]) return keyMap[lower];
                // Single character keys
                if (lower.length === 1) return lower;
                // Capitalize first letter for named keys
                return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
            });
            return normalizedParts.join('+');
        }

        return keyMap[key.toLowerCase()] || key;
    }

    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}
