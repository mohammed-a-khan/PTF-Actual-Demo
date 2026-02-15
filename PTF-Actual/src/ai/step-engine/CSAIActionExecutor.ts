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

        // Table row-scoped actions: resolve element within a specific table row
        // before proceeding with normal action execution
        if (parameters.rowIndex && parameters.tableRef) {
            // Use descriptors (stop-words filtered) for cleaner search text
            const searchText = step.target.descriptors.length > 0
                ? step.target.descriptors.join(' ')
                : step.target.rawText;
            const resolved = await this.resolveTableRowElement(
                page,
                searchText,
                parameters.rowIndex,
                parameters.tableRef,
                step.target.elementType
            );
            if (resolved) {
                element = {
                    locator: resolved,
                    confidence: 0.85,
                    description: `table-row[${parameters.rowIndex}] > ${step.target.rawText}`,
                    method: 'table-row-resolution',
                    alternatives: []
                };
                CSReporter.debug(`CSAIActionExecutor: Resolved element in table "${parameters.tableRef}" row ${parameters.rowIndex}`);
            } else {
                CSReporter.warn(`CSAIActionExecutor: Could not resolve element in table row — falling back to normal matching`);
            }
        }

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
                try {
                    const el = this.createWrappedElement(element!, timeout);
                    await el.fill(parameters.value!, { timeout });
                } catch (fillError: any) {
                    // If the matched element is a container (tr, div, td, span, etc.),
                    // the fill will fail because it's not an input. Drill down to find
                    // the actual fillable child element inside the container.
                    if (fillError.message?.includes('not an <input>')) {
                        CSReporter.debug('CSAIActionExecutor: Matched element is a container — searching for fillable element');
                        // Try children first, then sibling cell, then parent row
                        const resolved = await this.findInTableLayout(
                            element!.locator,
                            'input:visible, textarea:visible, [contenteditable="true"]:visible, [contenteditable=""]:visible'
                        );
                        if (resolved) {
                            await resolved.fill(parameters.value!, { timeout });
                        } else {
                            throw fillError;
                        }
                    } else {
                        throw fillError;
                    }
                }
                return this.success('fill');
            }

            case 'clear': {
                this.requireElement(element, 'clear');
                try {
                    const el = this.createWrappedElement(element!, timeout);
                    await el.clear({ timeout });
                } catch (clearError: any) {
                    if (clearError.message?.includes('not an <input>')) {
                        const resolved = await this.findInTableLayout(
                            element!.locator,
                            'input:visible, textarea:visible, [contenteditable="true"]:visible, [contenteditable=""]:visible'
                        );
                        if (resolved) {
                            await resolved.clear({ timeout });
                        } else {
                            throw clearError;
                        }
                    } else {
                        throw clearError;
                    }
                }
                return this.success('clear');
            }

            case 'select': {
                this.requireElement(element, 'select');
                this.requireValue(parameters, 'select');
                const selectValue = parameters.value!;

                // Resolve the actual <select> element:
                // - If matched element is an <option>, navigate UP to parent <select>
                // - If matched element is a container, drill DOWN or check SIBLINGS for <select>
                // Legacy table layout: <tr><td>Label:</td><td><select>...</select></td></tr>
                let selectLocator = element!.locator;
                try {
                    const tagName = await selectLocator.evaluate((el: Element) => el.tagName.toLowerCase()).catch(() => '');
                    if (tagName === 'option' || tagName === 'optgroup') {
                        const parentSelect = selectLocator.locator('xpath=ancestor::select');
                        if (await parentSelect.count() > 0) {
                            CSReporter.debug('CSAIActionExecutor: Matched <option> — navigating up to parent <select>');
                            selectLocator = parentSelect.first();
                        }
                    } else if (tagName === 'select') {
                        // Already a <select> — use as-is
                    } else {
                        // Try inside the matched element first
                        const childSelect = selectLocator.locator('select').first();
                        if (await childSelect.count() > 0) {
                            CSReporter.debug('CSAIActionExecutor: Matched container — drilling down to child <select>');
                            selectLocator = childSelect;
                        } else {
                            // Table layout: label is in one <td>, <select> is in a sibling <td>
                            // Check next sibling, then parent <tr> descendants
                            const siblingSelect = selectLocator.locator('xpath=following-sibling::td[1]//select').first();
                            if (await siblingSelect.count() > 0) {
                                CSReporter.debug('CSAIActionExecutor: Table layout — found <select> in next sibling cell');
                                selectLocator = siblingSelect;
                            } else {
                                const rowSelect = selectLocator.locator('xpath=ancestor::tr[1]//select').first();
                                if (await rowSelect.count() > 0) {
                                    CSReporter.debug('CSAIActionExecutor: Table layout — found <select> in parent row');
                                    selectLocator = rowSelect;
                                }
                            }
                        }
                    }
                } catch {
                    // Proceed with original locator
                }

                // Playwright's selectOption with a plain string matches by `value` attribute,
                // `label` text, or `index`. Users typically specify the visible label text
                // (e.g., "select '202501'"), so try label match first for reliability.
                try {
                    await selectLocator.selectOption({ label: selectValue }, { timeout });
                } catch {
                    // Label match failed — try by value attribute, then by plain string (which
                    // tries value, label, and index in that order)
                    try {
                        await selectLocator.selectOption({ value: selectValue }, { timeout });
                    } catch {
                        // Last resort: pass plain string which tries all strategies
                        const el = this.createWrappedElement(element!, timeout);
                        await el.selectOption(selectValue, { timeout });
                    }
                }

                // Brief wait for DOM to settle after select — many apps trigger onChange
                // events that update dependent elements (e.g., cascading dropdowns).
                // This prevents the next step from acting on stale DOM.
                await page.waitForTimeout(300);
                try {
                    await page.waitForLoadState('networkidle', { timeout: 2000 });
                } catch {
                    // Network might not settle in 2s — non-critical
                }
                return this.success('select');
            }

            case 'check': {
                this.requireElement(element, 'check');
                try {
                    const el = this.createWrappedElement(element!, timeout);
                    await el.check({ timeout });
                } catch (checkError: any) {
                    // Label cell matched instead of the checkbox — find it in table layout
                    const resolved = await this.findInTableLayout(element!.locator, 'input[type="checkbox"]');
                    if (resolved) {
                        await resolved.check({ timeout });
                    } else {
                        throw checkError;
                    }
                }
                return this.success('check');
            }

            case 'uncheck': {
                this.requireElement(element, 'uncheck');
                try {
                    const el = this.createWrappedElement(element!, timeout);
                    await el.uncheck({ timeout });
                } catch (uncheckError: any) {
                    const resolved = await this.findInTableLayout(element!.locator, 'input[type="checkbox"]');
                    if (resolved) {
                        await resolved.uncheck({ timeout });
                    } else {
                        throw uncheckError;
                    }
                }
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

                // Find drag target: try text search, then role-based search
                let dragTargetLocator = page.getByText(parameters.dragTarget, { exact: false });
                let dtCount = await dragTargetLocator.count();
                if (dtCount === 0) {
                    // Try getByRole with name
                    dragTargetLocator = page.getByRole('region', { name: parameters.dragTarget });
                    dtCount = await dragTargetLocator.count();
                }
                if (dtCount === 0) {
                    throw new Error(`Drag target not found: "${parameters.dragTarget}"`);
                }
                // If multiple matches, use first but log a warning
                if (dtCount > 1) {
                    CSReporter.debug(`CSAIActionExecutor: Drag target "${parameters.dragTarget}" matched ${dtCount} elements — using first`);
                }
                await el.dragTo(dragTargetLocator.first(), { timeout });
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
                const requestedMs = parameters.timeout || 1000;
                // Cap wait time to 30 seconds to prevent exceeding test framework timeouts
                const maxWaitMs = 30000;
                const waitMs = Math.min(requestedMs, maxWaitMs);
                if (requestedMs > maxWaitMs) {
                    CSReporter.warn(`AI Step: Wait time ${requestedMs}ms exceeds maximum ${maxWaitMs}ms — capped to ${maxWaitMs}ms`);
                }
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
                        (prevUrl) => window.location.href !== prevUrl,
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

            case 'wait-page-load': {
                const loadState = (parameters.loadState as 'domcontentloaded' | 'load' | 'networkidle') || 'load';
                CSReporter.debug(`AI Step: Waiting for page load state: ${loadState}`);
                await page.waitForLoadState(loadState, { timeout });
                return this.success('wait-page-load');
            }

            // ================================================================
            // BROWSER & TAB MANAGEMENT (Phase 2)
            // ================================================================

            case 'switch-tab': {
                const browserManager = getBrowserManager();
                const pages = browserManager.getContext().pages();
                if (pages.length === 0) {
                    throw new Error('No tabs available to switch to');
                }
                if (parameters.tabIndex !== undefined) {
                    if (parameters.tabIndex === -1) {
                        // Switch to latest tab
                        const latestPage = pages[pages.length - 1];
                        browserManager.setCurrentPage(latestPage);
                        await latestPage.bringToFront();
                    } else if (parameters.tabIndex === 0) {
                        // Switch to main/first tab
                        browserManager.setCurrentPage(pages[0]);
                        await pages[0].bringToFront();
                    } else {
                        // Switch to specific tab by index (1-based from user, convert to 0-based)
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

            case 'api-call':
            case 'api-call-file': {
                return await this.executeApiCall(page, parameters, intent);
            }

            case 'api-set-context': {
                return this.executeApiSetContext(parameters);
            }

            case 'api-set-header': {
                return this.executeApiSetHeader(parameters);
            }

            case 'api-set-auth': {
                return this.executeApiSetAuth(parameters);
            }

            case 'api-clear-context': {
                (this as any)._apiHeaders = {};
                (this as any)._apiBaseUrl = undefined;
                (this as any)._apiAuth = undefined;
                (this as any)._apiTimeout = undefined;
                CSReporter.pass('API context cleared');
                return this.success('api-clear-context');
            }

            case 'api-upload': {
                return await this.executeApiUpload(page, parameters);
            }

            case 'api-download': {
                return await this.executeApiDownload(page, parameters);
            }

            case 'api-poll': {
                return await this.executeApiPoll(page, parameters);
            }

            case 'api-save-response': {
                return this.executeApiSaveResponse(parameters);
            }

            case 'api-save-request': {
                return this.executeApiSaveRequest(parameters);
            }

            case 'api-print': {
                return this.executeApiPrint(parameters);
            }

            case 'api-chain': {
                return await this.executeApiChain(page, parameters);
            }

            case 'api-execute-chain': {
                return await this.executeApiExecuteChain(page, parameters);
            }

            case 'api-soap': {
                return await this.executeApiSoap(page, parameters);
            }

            // ================================================================
            // JAVASCRIPT EXECUTION (Phase 12)
            // ================================================================

            case 'execute-js': {
                if (!parameters.script) throw new Error('No JavaScript specified for execute-js');
                CSReporter.debug(`AI Step: Executing JavaScript: ${parameters.script.substring(0, 200)}${parameters.script.length > 200 ? '...' : ''}`);
                await page.evaluate(parameters.script);
                return this.success('execute-js');
            }

            // ================================================================
            // DATABASE ACTIONS (Phase 2)
            // ================================================================
            case 'db-query':
            case 'db-query-file': {
                return await this.executeDatabaseQuery(parameters, intent === 'db-query-file');
            }

            case 'db-update': {
                return await this.executeDatabaseUpdate(parameters);
            }

            case 'db-resolve-or-use': {
                return await this.executeDatabaseResolveOrUse(parameters);
            }

            // ================================================================
            // CONTEXT ACTIONS (Phase 4)
            // ================================================================
            case 'copy-context-var': {
                return this.executeContextCopy(parameters);
            }

            case 'set-context-field': {
                return this.executeContextSetField(parameters);
            }

            case 'clear-context-var': {
                return this.executeContextClear(parameters);
            }

            // ================================================================
            // FILE ACTIONS (Phase 3)
            // ================================================================
            case 'parse-csv': {
                return await this.executeParseCSV(parameters);
            }

            case 'parse-xlsx': {
                return await this.executeParseXLSX(parameters);
            }

            case 'parse-file': {
                return await this.executeParseFile(parameters);
            }

            // ================================================================
            // MAPPING ACTIONS (Phase 6)
            // ================================================================
            case 'load-mapping': {
                return await this.executeLoadMapping(parameters);
            }

            case 'transform-data': {
                return await this.executeTransformData(parameters);
            }

            case 'prepare-test-data': {
                return await this.executePrepareTestData(parameters);
            }

            // ================================================================
            // ORCHESTRATION ACTIONS (Phase 7)
            // ================================================================
            case 'call-helper': {
                return await this.executeCallHelper(parameters);
            }

            // ================================================================
            // TABLE EXTENSION ACTIONS (Phase 8)
            // ================================================================
            case 'expand-row':
            case 'collapse-row': {
                return await this.executeExpandCollapseRow(page, element, parameters, timeout);
            }

            case 'sort-column': {
                // Just click the column header — the element matcher will find it
                this.requireElement(element, 'sort-column');
                const el = this.createWrappedElement(element!, timeout);
                await el.click({ timeout });
                return this.success('sort-column');
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
                // Guard: reject low-confidence matches for assertions to avoid false positives
                // (e.g., matching random text on a 404 page)
                if (element!.confidence < this.config.confidenceThreshold) {
                    throw new Error(
                        `Element match confidence too low for assertion (${element!.confidence.toFixed(2)} < ${this.config.confidenceThreshold}). ` +
                        `Matched: ${element!.description}. The element may not be the intended target.`
                    );
                }
                const el = this.createWrappedElement(element!, timeout);
                // Use polling assertion instead of bare waitForVisible to ensure the element
                // is actually visible AND attached to the live DOM (not just cached)
                await this.assertWithRetryAndScreenshot(
                    async () => {
                        const isVisible = await el.isVisible();
                        if (!isVisible) return false;
                        // Additional check: verify the element is actually in the viewport or DOM
                        // by confirming it has non-zero bounding box dimensions
                        try {
                            const box = await element!.locator.boundingBox({ timeout: 2000 });
                            return box !== null && box.width > 0 && box.height > 0;
                        } catch {
                            // boundingBox can fail for off-screen elements; isVisible is sufficient
                            return true;
                        }
                    },
                    `Expected "${step.target.rawText}" to be visible on the page`,
                    timeout
                );
                return this.success('verify-visible');
            }

            case 'verify-hidden': {
                if (!element || !element.locator) {
                    // Element wasn't found at all — this counts as "hidden" (not visible on page)
                    return this.success('verify-hidden');
                }
                const el = this.createWrappedElement(element!, timeout);
                // Use polling to check hidden state — handles both "exists but hidden"
                // and "detached from DOM during check"
                await this.assertWithRetryAndScreenshot(
                    async () => {
                        const count = await el.count();
                        if (count === 0) return true; // Not in DOM = hidden
                        const visible = await el.isVisible();
                        return !visible;
                    },
                    `Expected "${step.target.rawText}" to be hidden but it is visible`,
                    timeout
                );
                return this.success('verify-hidden');
            }

            case 'verify-not-present': {
                if (!element || !element.locator) {
                    // Element not found at all — this IS the expected state
                    return this.success('verify-not-present');
                }
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
                    const expected = parameters.expectedValue.trim();
                    if (modifiers.negated) {
                        await this.assertWithRetryAndScreenshot(
                            async () => {
                                const text = this.normalizeWhitespace(await el.textContent() || '');
                                return text !== expected && !text.includes(expected);
                            },
                            `Expected text to NOT be "${expected}"`,
                            timeout
                        );
                    } else {
                        await this.assertWithRetryAndScreenshot(
                            async () => {
                                const text = this.normalizeWhitespace(await el.textContent() || '');
                                // Try exact match first, then containment
                                if (text === expected || text.includes(expected)) return true;

                                // Table layout fallback: if the matched element is a <th> or label,
                                // the value is in the adjacent <td>. Check the parent <tr> row text
                                // which contains both label and value. Common in legacy IE-era apps:
                                //   <tr><th>Full Name</th><td>John Smith</td></tr>
                                try {
                                    const rowText = await element!.locator.evaluate((el: Element) => {
                                        // Walk up to find the closest <tr>
                                        let parent: Element | null = el.parentElement;
                                        for (let i = 0; i < 5 && parent; i++) {
                                            if (parent.tagName === 'TR') {
                                                // Get text from <td> siblings only (exclude the <th> label)
                                                const tds = parent.querySelectorAll('td');
                                                return Array.from(tds).map(td => td.textContent?.trim() || '').join(' ');
                                            }
                                            parent = parent.parentElement;
                                        }
                                        return '';
                                    });
                                    if (rowText && (rowText === expected || rowText.includes(expected))) {
                                        return true;
                                    }
                                } catch {
                                    // Non-critical fallback
                                }

                                return false;
                            },
                            `Expected text "${expected}" but got different content`,
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
                // Use broadLocator (non-narrowed) for counting — the main locator may be
                // narrowed to .first()/.nth() which would always count as 1
                const countLocator = element!.broadLocator || element!.locator;
                await this.assertWithRetryAndScreenshot(
                    async () => {
                        const actualCount = await countLocator.count();
                        return actualCount === parameters.count;
                    },
                    `Expected count to be ${parameters.count}`,
                    timeout
                );
                return this.success('verify-count');
            }

            case 'verify-value': {
                this.requireElement(element, 'verify-value');
                if (parameters.expectedValue === undefined) {
                    throw new Error('No expected value specified for verify-value. Use: verify the field value is "expected"');
                }
                const expected = parameters.expectedValue;

                // Strategy 1: Try inputValue() — works for <input>, <textarea>, <select>
                let useInputValue = true;
                try {
                    await element!.locator.inputValue({ timeout: 2000 });
                } catch {
                    useInputValue = false;
                }

                if (useInputValue) {
                    const el = this.createWrappedElement(element!, timeout);
                    await this.assertWithRetryAndScreenshot(
                        async () => {
                            const val = await el.inputValue();
                            return val === expected;
                        },
                        `Expected input value to be "${expected}"`,
                        timeout
                    );
                } else {
                    // Strategy 2: Not an input — read text from sibling cell (table layout)
                    // Pattern: <td>Label:</td><td>Value</td>
                    await this.assertWithRetryAndScreenshot(
                        async () => {
                            // Try sibling <td> text first
                            try {
                                const siblingText = await element!.locator.evaluate((el: Element) => {
                                    // Check next sibling cell
                                    const next = el.nextElementSibling;
                                    if (next && next.tagName === 'TD') {
                                        return (next.textContent || '').trim();
                                    }
                                    // Check parent <tr> for all <td> values
                                    let parent: Element | null = el.parentElement;
                                    for (let i = 0; i < 5 && parent; i++) {
                                        if (parent.tagName === 'TR') {
                                            const tds = parent.querySelectorAll('td');
                                            for (let j = 0; j < tds.length; j++) {
                                                if (tds[j] === el && j + 1 < tds.length) {
                                                    return (tds[j + 1].textContent || '').trim();
                                                }
                                            }
                                        }
                                        parent = parent.parentElement;
                                    }
                                    return '';
                                });
                                if (siblingText === expected || siblingText.includes(expected)) {
                                    return true;
                                }
                            } catch { /* continue to text fallback */ }

                            // Try own text content
                            const ownText = (await element!.locator.textContent() || '').trim();
                            return ownText === expected || ownText.includes(expected);
                        },
                        `Expected field value to be "${expected}"`,
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
                } else {
                    // No expected value — verify the attribute exists (is not null)
                    await this.assertWithRetryAndScreenshot(
                        async () => {
                            const val = await el.getAttribute(parameters.attribute!);
                            return val !== null;
                        },
                        `Expected element to have attribute "${parameters.attribute}" but it was not found`,
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
                const locatorCss = element!.locator;
                if (parameters.expectedValue) {
                    const cssProp = parameters.cssProperty;
                    const expectedCss = parameters.expectedValue;
                    await this.assertWithRetryAndScreenshot(
                        async () => {
                            // Evaluate CSS value INSIDE the polling loop to handle transitions
                            const actualCss = await locatorCss.evaluate(
                                (el: Element, prop: string) => window.getComputedStyle(el).getPropertyValue(prop),
                                cssProp
                            );
                            return actualCss.trim() === expectedCss;
                        },
                        `Expected CSS "${parameters.cssProperty}" to be "${parameters.expectedValue}"`,
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
                return this.executeVerifyApiResponse(parameters);
            }

            case 'verify-api-schema': {
                return await this.executeVerifyApiSchema(parameters);
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
                } else {
                    // No expected value — verify URL is not blank/about:blank
                    const currentUrl = page.url();
                    if (!currentUrl || currentUrl === 'about:blank') {
                        throw new Error(`Expected a valid URL but page is at "${currentUrl}"`);
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
                } else {
                    // No expected value — verify page has a non-empty title
                    const title = await page.title();
                    if (!title || title.trim().length === 0) {
                        throw new Error('Expected page to have a title but it was empty');
                    }
                }
                return this.success('verify-title');
            }

            // ================================================================
            // DATABASE ASSERTIONS (Phase 2)
            // ================================================================
            case 'verify-db-exists':
            case 'verify-db-not-exists': {
                return await this.executeDatabaseVerifyExists(parameters, intent === 'verify-db-not-exists');
            }

            case 'verify-db-field': {
                return await this.executeDatabaseVerifyField(parameters);
            }

            case 'verify-db-count': {
                return await this.executeDatabaseVerifyCount(parameters);
            }

            // ================================================================
            // FILE ASSERTIONS (Phase 3)
            // ================================================================
            case 'verify-file-name-pattern': {
                return await this.executeVerifyFileNamePattern(parameters);
            }

            case 'verify-file-row-count': {
                return await this.executeVerifyFileRowCount(parameters);
            }

            // ================================================================
            // COMPARISON ASSERTIONS (Phase 5)
            // ================================================================
            case 'verify-tolerance': {
                return this.executeVerifyTolerance(parameters);
            }

            case 'verify-context-field': {
                return this.executeVerifyContextField(parameters);
            }

            case 'verify-context-match': {
                return await this.executeVerifyContextMatch(parameters);
            }

            case 'verify-count-match': {
                return this.executeVerifyCountMatch(parameters);
            }

            case 'verify-data-match': {
                return await this.executeVerifyDataMatch(parameters);
            }

            case 'verify-accumulated': {
                return await this.executeVerifyAccumulated(parameters);
            }

            // ================================================================
            // TABLE EXTENSION ASSERTIONS (Phase 8)
            // ================================================================
            case 'verify-column-sorted': {
                return await this.executeVerifyColumnSorted(page, element, parameters, timeout);
            }

            case 'verify-column-exists': {
                return await this.executeVerifyColumnExists(page, element, parameters, timeout);
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
                    // Try thead th first, then fallback to first row th/td for headers
                    let headers = Array.from(table.querySelectorAll('thead th')).map((th: any) => th.textContent.trim());
                    let dataRows: Element[];
                    if (headers.length === 0) {
                        // No thead — check if first row has th elements
                        const firstRow = table.querySelector('tr');
                        if (firstRow) {
                            const firstRowThs = firstRow.querySelectorAll('th');
                            if (firstRowThs.length > 0) {
                                headers = Array.from(firstRowThs).map((th: any) => th.textContent.trim());
                                // Skip first row in data since it's headers
                                const allRows = Array.from(table.querySelectorAll('tr'));
                                dataRows = allRows.slice(1) as Element[];
                            } else {
                                // No th anywhere — use column indices
                                dataRows = Array.from(table.querySelectorAll('tbody tr'));
                                if (dataRows.length === 0) {
                                    dataRows = Array.from(table.querySelectorAll('tr'));
                                }
                            }
                        } else {
                            dataRows = [];
                        }
                    } else {
                        dataRows = Array.from(table.querySelectorAll('tbody tr'));
                    }
                    return (dataRows || []).map((row: any) => {
                        const cells = Array.from(row.querySelectorAll('td, th')).map((td: any) => td.textContent.trim());
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
                    // Extended data types (Phase 4)
                    case 'random-decimal': {
                        const decMin = parameters.rangeMin ?? 0;
                        const decMax = parameters.rangeMax ?? 100;
                        const decimals = parameters.decimalPlaces ?? 2;
                        generatedValue = (Math.random() * (decMax - decMin) + decMin).toFixed(decimals);
                        break;
                    }
                    case 'formatted-number': {
                        const fmt = parameters.numberFormat || 'x.0yy';
                        generatedValue = fmt.replace(/[xy]/g, (ch: string) => {
                            if (ch === 'x') return String(Math.floor(Math.random() * 9) + 1);
                            return String(Math.floor(Math.random() * 10));
                        });
                        break;
                    }
                    case 'business-days-ago':
                    case 'business-days-from-now': {
                        const offset = parameters.businessDaysOffset || 1;
                        const direction = dataType === 'business-days-ago' ? -1 : 1;
                        const date = new Date();
                        let remaining = offset;
                        while (remaining > 0) {
                            date.setDate(date.getDate() + direction);
                            const day = date.getDay();
                            if (day !== 0 && day !== 6) remaining--;
                        }
                        const dfmt = parameters.dateFormat || 'MM/DD/YYYY';
                        generatedValue = this.formatDateValue(date, dfmt);
                        break;
                    }
                    case 'formatted-date': {
                        const dateFmt = parameters.dateFormat || 'MM/DD/YYYY';
                        generatedValue = this.formatDateValue(new Date(), dateFmt);
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
                return this.executeGetApiResponse(parameters);
            }

            // ================================================================
            // JAVASCRIPT EVALUATION (Phase 12)
            // ================================================================

            case 'evaluate-js': {
                if (!parameters.script) throw new Error('No JavaScript specified for evaluate-js');
                const jsResult = await page.evaluate(parameters.script);
                return this.success('evaluate-js', typeof jsResult === 'object' ? JSON.stringify(jsResult) : String(jsResult ?? ''));
            }

            // ================================================================
            // DATABASE QUERIES (Phase 2)
            // ================================================================
            case 'get-db-value': {
                return await this.executeDatabaseGetValue(parameters);
            }

            case 'get-db-row': {
                return await this.executeDatabaseGetRow(parameters);
            }

            case 'get-db-rows': {
                return await this.executeDatabaseGetRows(parameters);
            }

            case 'get-db-count': {
                return await this.executeDatabaseGetCount(parameters);
            }

            // ================================================================
            // CONTEXT QUERIES (Phase 4)
            // ================================================================
            case 'get-context-field': {
                return this.executeContextGetField(parameters);
            }

            case 'get-context-count': {
                return this.executeContextGetCount(parameters);
            }

            case 'get-context-keys': {
                return this.executeContextGetKeys(parameters);
            }

            // ================================================================
            // FORM CAPTURE QUERIES (Phase 9)
            // ================================================================
            case 'capture-form-data': {
                return await this.executeCaptureFormData(page, parameters, timeout);
            }

            // ================================================================
            // FILE QUERIES (Phase 3)
            // ================================================================
            case 'get-file-row-count': {
                return await this.executeGetFileRowCount();
            }

            case 'get-file-headers': {
                return await this.executeGetFileHeaders();
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

            // Recovery 2: For fill/type/clear on container elements, find fillable child
            // This handles cases where the accessibility tree matcher resolves to a <tr>, <div>,
            // <td>, etc. instead of the <input> or <textarea> inside it
            if (element && (step.intent === 'fill' || step.intent === 'type' || step.intent === 'clear') &&
                error.message?.includes('not an <input>')) {
                try {
                    CSReporter.debug('CSAIActionExecutor: Recovery — searching for fillable child in container');
                    const fillableChild = element.locator
                        .locator('input:visible, textarea:visible, [contenteditable="true"]:visible, [contenteditable=""]:visible')
                        .first();
                    if (await fillableChild.count() > 0) {
                        const childElement: MatchedElement = {
                            locator: fillableChild,
                            confidence: element.confidence,
                            description: `${element.description} > input`,
                            method: element.method,
                            alternatives: []
                        };
                        return await this.execute(page, step, childElement);
                    }
                } catch {
                    // Recovery 2 failed — continue to next
                }
            }

            // Recovery 3: For select on <option>/<optgroup>, navigate up to parent <select>
            if (element && step.intent === 'select') {
                try {
                    const tagName = await element.locator.evaluate((el: Element) => el.tagName.toLowerCase()).catch(() => '');
                    if (tagName === 'option' || tagName === 'optgroup') {
                        CSReporter.debug('CSAIActionExecutor: Recovery — navigating from <option> up to parent <select>');
                        const parentSelect = element.locator.locator('xpath=ancestor::select');
                        if (await parentSelect.count() > 0) {
                            const selectElement: MatchedElement = {
                                locator: parentSelect.first(),
                                confidence: element.confidence,
                                description: `${element.description} > parent select`,
                                method: element.method,
                                alternatives: []
                            };
                            return await this.execute(page, step, selectElement);
                        }
                    }
                } catch {
                    // Recovery 3 failed — continue to next
                }
            }

            // Recovery 4: Try with alternative locators
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
    /**
     * Table layout resolver: when the matched element is a label cell (td/th),
     * find the actual interactive element in children, sibling cell, or parent row.
     * Returns the found locator or null if nothing found.
     */
    /**
     * Resolve an element within a specific table row.
     * Used for row-scoped actions like "Type 'X' in 'Y' at row 1 in the Z table".
     *
     * Strategy:
     * 1. Find the table by matching description text
     * 2. Get the Nth data row (1-based, skipping header rows)
     * 3. Within that row, find the target by column header name or element attributes
     */
    private async resolveTableRowElement(
        page: Page,
        targetText: string,
        rowIndex: number,
        tableRef: string,
        elementType?: string
    ): Promise<Locator | null> {
        try {
            // Find tables on the page
            const tables = page.locator('table');
            const tableCount = await tables.count();
            if (tableCount === 0) return null;

            // Try to match the table by description
            let targetTable: Locator | null = null;
            const refLower = tableRef.toLowerCase();
            for (let i = 0; i < tableCount; i++) {
                const table = tables.nth(i);
                // Check table text content
                const tableText = await table.textContent().catch(() => '');
                if (tableText && tableText.toLowerCase().includes(refLower)) {
                    targetTable = table;
                    break;
                }
                // Check preceding heading (h1-h4) that may name this table
                const heading = await table.evaluate((el: Element) => {
                    let prev = el.previousElementSibling;
                    for (let j = 0; j < 5 && prev; j++) {
                        if (/^H[1-4]$/.test(prev.tagName)) return (prev.textContent || '').trim();
                        prev = prev.previousElementSibling;
                    }
                    return '';
                }).catch(() => '');
                if (heading && heading.toLowerCase().includes(refLower)) {
                    targetTable = table;
                    break;
                }
            }
            // Fallback: use the last table on the page (data tables are usually at the bottom)
            if (!targetTable) {
                targetTable = tables.nth(tableCount - 1);
                CSReporter.debug(`CSAIActionExecutor: Table "${tableRef}" not found by text — using last table`);
            }

            // Get all rows
            const rows = targetTable.locator('tr');
            const rowCount = await rows.count();
            if (rowCount < 2) return null; // Need at least header + 1 data row

            // Find header row — first row with <th> elements, or first row
            let headerRow: Locator | null = null;
            let dataStartIndex = 0;
            for (let i = 0; i < Math.min(rowCount, 3); i++) {
                const row = rows.nth(i);
                const thCount = await row.locator('th').count();
                if (thCount > 0) {
                    headerRow = row;
                    dataStartIndex = i + 1;
                    break;
                }
            }
            if (!headerRow) {
                // No <th> found — assume first row is header
                headerRow = rows.nth(0);
                dataStartIndex = 1;
            }

            // Get the target data row (1-based)
            const dataRowIdx = dataStartIndex + (rowIndex - 1);
            if (dataRowIdx >= rowCount) {
                CSReporter.debug(`CSAIActionExecutor: Row ${rowIndex} out of range (${rowCount - dataStartIndex} data rows)`);
                return null;
            }
            const dataRow = rows.nth(dataRowIdx);

            // Strategy A: Find by column header name
            // Get header cells and find the column index matching targetText
            const headerCells = headerRow.locator('th, td');
            const headerCount = await headerCells.count();
            let colIndex = -1;
            const targetLower = targetText.toLowerCase().replace(/[:\s]+$/, '').trim();
            for (let i = 0; i < headerCount; i++) {
                const cellText = (await headerCells.nth(i).textContent() || '').trim()
                    .replace(/[:\s]+$/, '').trim().toLowerCase();
                if (cellText === targetLower || cellText.includes(targetLower) || targetLower.includes(cellText)) {
                    colIndex = i;
                    break;
                }
            }

            if (colIndex >= 0) {
                // Found the column — get the cell in the data row at that index
                const dataCells = dataRow.locator('td');
                if (colIndex < await dataCells.count()) {
                    const cell = dataCells.nth(colIndex);
                    // Find the interactive element inside the cell
                    const selectors = elementType === 'dropdown' ? 'select' :
                        elementType === 'checkbox' ? 'input[type="checkbox"]' :
                        'input:visible, textarea:visible, select:visible, [contenteditable]:visible';
                    const interactive = cell.locator(selectors).first();
                    if (await interactive.count() > 0) {
                        CSReporter.debug(`CSAIActionExecutor: Table row — found ${elementType || 'input'} in column "${targetText}" row ${rowIndex}`);
                        return interactive;
                    }
                    // For click actions, might target a button/link — try those
                    const clickable = cell.locator('input[type="submit"], input[type="button"], button, a').first();
                    if (await clickable.count() > 0) {
                        return clickable;
                    }
                    // Return the cell itself as last resort
                    return cell;
                }
            }

            // Strategy B: Search the entire data row for the element
            // Look for input/button/select that matches targetText by value, name, or nearby label
            const allInputs = dataRow.locator('input:visible, textarea:visible, select:visible, button:visible, input[type="submit"]');
            const inputCount = await allInputs.count();
            for (let i = 0; i < inputCount; i++) {
                const input = allInputs.nth(i);
                const attrs = await input.evaluate((el: Element) => ({
                    value: (el as HTMLInputElement).value || '',
                    name: el.getAttribute('name') || '',
                    id: el.id || '',
                    type: (el as HTMLInputElement).type || '',
                    placeholder: el.getAttribute('placeholder') || ''
                })).catch(() => ({ value: '', name: '', id: '', type: '', placeholder: '' }));

                const target = targetText.toLowerCase();
                if (attrs.value.toLowerCase().includes(target) ||
                    attrs.name.toLowerCase().includes(target) ||
                    attrs.id.toLowerCase().includes(target) ||
                    attrs.placeholder.toLowerCase().includes(target)) {
                    CSReporter.debug(`CSAIActionExecutor: Table row — found element by attribute match in row ${rowIndex}`);
                    return input;
                }
            }

            CSReporter.debug(`CSAIActionExecutor: Table row — no matching element found for "${targetText}" in row ${rowIndex}`);
            return null;
        } catch (error: any) {
            CSReporter.debug(`CSAIActionExecutor: Table row resolution failed: ${error.message}`);
            return null;
        }
    }

    private async findInTableLayout(locator: Locator, cssSelector: string): Promise<Locator | null> {
        try {
            // 1. Inside the matched element
            const child = locator.locator(cssSelector).first();
            if (await child.count() > 0) {
                CSReporter.debug(`CSAIActionExecutor: Table layout — found ${cssSelector} inside matched element`);
                return child;
            }
            // 2. Next sibling <td>
            const sibling = locator.locator(`xpath=following-sibling::td[1]//${cssSelector.replace(':visible', '')}`).first();
            if (await sibling.count() > 0) {
                CSReporter.debug(`CSAIActionExecutor: Table layout — found ${cssSelector} in next sibling cell`);
                return sibling;
            }
            // 3. Anywhere in the parent <tr>
            const inRow = locator.locator(`xpath=ancestor::tr[1]//${cssSelector.replace(':visible', '')}`).first();
            if (await inRow.count() > 0) {
                CSReporter.debug(`CSAIActionExecutor: Table layout — found ${cssSelector} in parent row`);
                return inRow;
            }
        } catch {
            // Non-critical — caller will use original locator
        }
        return null;
    }

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

    private success(method: string, returnValue?: any): ActionResult {
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

    /** Normalize whitespace: collapse runs of whitespace to single space and trim */
    private normalizeWhitespace(text: string): string {
        return text.replace(/\s+/g, ' ').trim();
    }

    // ========================================================================
    // DATABASE HANDLER METHODS (Phase 2)
    // ========================================================================

    /**
     * Lazy-load CSDBUtils and CSAIColumnNormalizer to avoid circular dependencies.
     * Returns { CSDBUtils, CSAIColumnNormalizer } or throws if DB module unavailable.
     */
    private getDBModules(): { CSDBUtils: any; CSAIColumnNormalizer: any } {
        const { CSAIColumnNormalizer } = require('./CSAIColumnNormalizer');
        const { CSDBUtils } = require('../../database/utils/CSDBUtils');
        return { CSDBUtils, CSAIColumnNormalizer };
    }

    /**
     * Parse JSON params string and resolve each param via CSValueResolver.
     */
    private resolveDbParams(dbParams: string | undefined): any[] {
        if (!dbParams) return [];
        try {
            const parsed = JSON.parse(dbParams);
            if (!Array.isArray(parsed)) return [parsed];
            return parsed;
        } catch {
            return [dbParams];
        }
    }

    /** Execute a database query (named or from file) and return normalized rows */
    private async executeDatabaseQuery(parameters: StepParameters, fromFile: boolean): Promise<ActionResult> {
        const { CSDBUtils, CSAIColumnNormalizer } = this.getDBModules();
        const alias = parameters.dbAlias || 'default';
        const params = this.resolveDbParams(parameters.dbParams);

        let result: any;
        if (fromFile) {
            if (!parameters.dbFile) throw new Error('No SQL file specified for db-query-file');
            result = await CSDBUtils.executeFromFile(parameters.dbFile, params, alias);
        } else {
            if (!parameters.dbQuery) throw new Error('No query specified for db-query');
            result = await CSDBUtils.executeNamedQuery(parameters.dbQuery, params, alias);
        }

        // Normalize all row column names
        const rows = result.rows || [];
        const normalizedRows = CSAIColumnNormalizer.normalizeRows(rows);
        const returnObj = { rows: normalizedRows, rowCount: normalizedRows.length, fields: result.fields };

        CSReporter.pass(`Database query returned ${normalizedRows.length} row(s)`);
        return this.success('db-query', normalizedRows as any);
    }

    /** Execute a database update (INSERT/UPDATE/DELETE) */
    private async executeDatabaseUpdate(parameters: StepParameters): Promise<ActionResult> {
        const { CSDBUtils } = this.getDBModules();
        const alias = parameters.dbAlias || 'default';
        const params = this.resolveDbParams(parameters.dbParams);

        if (!parameters.dbQuery) throw new Error('No query specified for db-update');
        const result = await CSDBUtils.executeNamedQuery(parameters.dbQuery, params, alias);
        const affected = result.affectedRows ?? result.rowCount ?? 0;

        CSReporter.pass(`Database update executed: ${affected} row(s) affected`);
        return this.success('db-update', affected);
    }

    /** Resolve a value from database if not already provided */
    private async executeDatabaseResolveOrUse(parameters: StepParameters): Promise<ActionResult> {
        const { CSDBUtils, CSAIColumnNormalizer } = this.getDBModules();
        const providedValue = parameters.value || '';

        // Check if the provided value is valid (not empty, not unresolved variable pattern)
        const isValid = providedValue &&
            providedValue !== 'undefined' &&
            providedValue !== 'null' &&
            providedValue.trim() !== '' &&
            !providedValue.includes('{scenario:') &&
            !providedValue.includes('{context:') &&
            !providedValue.includes('{{') &&
            !providedValue.startsWith('$');

        if (isValid) {
            CSReporter.pass(`Using provided value for '${parameters.variableName}': ${providedValue}`);
            return this.success('db-resolve-or-use', providedValue);
        }

        // Value not provided — resolve from database
        const alias = parameters.dbAlias || 'default';
        const params = this.resolveDbParams(parameters.dbParams);
        if (!parameters.dbQuery) throw new Error('No query specified for db-resolve-or-use');

        const result = await CSDBUtils.executeNamedQuery(parameters.dbQuery, params, alias);
        const rows = result.rows || [];
        if (rows.length === 0) throw new Error(`Database query '${parameters.dbQuery}' returned no rows for resolve`);

        const row = CSAIColumnNormalizer.normalizeRow(rows[0]);
        let resolvedValue: any;

        if (parameters.dbField) {
            resolvedValue = CSAIColumnNormalizer.getField(row, parameters.dbField);
            if (resolvedValue === undefined) {
                throw new Error(`Field '${parameters.dbField}' not found in database result. Available: ${CSAIColumnNormalizer.getAvailableColumns(row).join(', ')}`);
            }
        } else {
            // No field specified — return the entire row
            resolvedValue = row;
        }

        CSReporter.pass(`Resolved '${parameters.variableName}' from database: ${typeof resolvedValue === 'object' ? JSON.stringify(resolvedValue).substring(0, 100) : resolvedValue}`);
        return this.success('db-resolve-or-use', typeof resolvedValue === 'object' ? resolvedValue as any : String(resolvedValue));
    }

    /** Verify database record exists or not */
    private async executeDatabaseVerifyExists(parameters: StepParameters, expectNotExists: boolean): Promise<ActionResult> {
        const { CSDBUtils } = this.getDBModules();
        const alias = parameters.dbAlias || 'default';
        const params = this.resolveDbParams(parameters.dbParams);
        if (!parameters.dbQuery) throw new Error('No query specified for verify-db-exists');

        const result = await CSDBUtils.executeNamedQuery(parameters.dbQuery, params, alias);
        const exists = (result.rows || []).length > 0;

        if (expectNotExists) {
            if (exists) throw new Error(`Expected database record NOT to exist, but query '${parameters.dbQuery}' returned ${result.rows.length} row(s)`);
            CSReporter.pass(`Database record does not exist as expected`);
        } else {
            if (!exists) throw new Error(`Expected database record to exist, but query '${parameters.dbQuery}' returned 0 rows`);
            CSReporter.pass(`Database record exists as expected`);
        }
        return this.success(expectNotExists ? 'verify-db-not-exists' : 'verify-db-exists');
    }

    /** Verify a specific field value in database result */
    private async executeDatabaseVerifyField(parameters: StepParameters): Promise<ActionResult> {
        const { CSDBUtils, CSAIColumnNormalizer } = this.getDBModules();
        const alias = parameters.dbAlias || 'default';
        const params = this.resolveDbParams(parameters.dbParams);
        if (!parameters.dbQuery) throw new Error('No query specified for verify-db-field');
        if (!parameters.dbField) throw new Error('No field specified for verify-db-field');

        const result = await CSDBUtils.executeNamedQuery(parameters.dbQuery, params, alias);
        const rows = result.rows || [];
        if (rows.length === 0) throw new Error(`Database query '${parameters.dbQuery}' returned no rows`);

        const row = CSAIColumnNormalizer.normalizeRow(rows[0]);
        const actual = CSAIColumnNormalizer.getField(row, parameters.dbField);
        if (actual === undefined) {
            throw new Error(`Field '${parameters.dbField}' not found in database result. Available: ${CSAIColumnNormalizer.getAvailableColumns(row).join(', ')}`);
        }

        const expected = parameters.expectedValue || '';
        const op = parameters.comparisonOp || 'equals';

        switch (op) {
            case 'contains':
                if (!String(actual).toLowerCase().includes(String(expected).toLowerCase())) {
                    throw new Error(`Expected field '${parameters.dbField}' to contain "${expected}" but got "${actual}"`);
                }
                break;
            case 'not-equals':
                if (String(actual).trim() === String(expected).trim()) {
                    throw new Error(`Expected field '${parameters.dbField}' to NOT equal "${expected}" but it does`);
                }
                break;
            case 'greater-than':
                if (parseFloat(String(actual)) <= parseFloat(expected)) {
                    throw new Error(`Expected field '${parameters.dbField}' to be greater than ${expected} but got ${actual}`);
                }
                break;
            case 'less-than':
                if (parseFloat(String(actual)) >= parseFloat(expected)) {
                    throw new Error(`Expected field '${parameters.dbField}' to be less than ${expected} but got ${actual}`);
                }
                break;
            case 'equals':
            default:
                if (parameters.tolerance !== undefined) {
                    const diff = Math.abs(parseFloat(String(actual)) - parseFloat(expected));
                    if (diff > parameters.tolerance) {
                        throw new Error(`Expected field '${parameters.dbField}' to equal ${expected} within tolerance ${parameters.tolerance} but got ${actual} (diff: ${diff})`);
                    }
                } else {
                    if (String(actual).trim() !== String(expected).trim()) {
                        throw new Error(`Expected field '${parameters.dbField}' to be "${expected}" but got "${actual}"`);
                    }
                }
                break;
        }

        CSReporter.pass(`Database field '${parameters.dbField}' ${op} "${expected}" ✓ (actual: "${actual}")`);
        return this.success('verify-db-field');
    }

    /** Verify database row count */
    private async executeDatabaseVerifyCount(parameters: StepParameters): Promise<ActionResult> {
        const { CSDBUtils } = this.getDBModules();
        const alias = parameters.dbAlias || 'default';
        const params = this.resolveDbParams(parameters.dbParams);
        if (!parameters.dbQuery) throw new Error('No query specified for verify-db-count');

        const result = await CSDBUtils.executeNamedQuery(parameters.dbQuery, params, alias);
        const actualCount = (result.rows || []).length;
        const expected = parseInt(parameters.expectedValue || '0');
        const op = parameters.comparisonOp || 'equals';

        switch (op) {
            case 'greater-than':
                if (actualCount <= expected) {
                    throw new Error(`Expected database count greater than ${expected} but got ${actualCount}`);
                }
                break;
            case 'less-than':
                if (actualCount >= expected) {
                    throw new Error(`Expected database count less than ${expected} but got ${actualCount}`);
                }
                break;
            case 'equals':
            default:
                if (actualCount !== expected) {
                    throw new Error(`Expected database count ${expected} but got ${actualCount}`);
                }
                break;
        }

        CSReporter.pass(`Database count ${op} ${expected} ✓ (actual: ${actualCount})`);
        return this.success('verify-db-count');
    }

    /** Get single value from database */
    private async executeDatabaseGetValue(parameters: StepParameters): Promise<ActionResult> {
        const { CSDBUtils } = this.getDBModules();
        const alias = parameters.dbAlias || 'default';
        const params = this.resolveDbParams(parameters.dbParams);
        if (!parameters.dbQuery) throw new Error('No query specified for get-db-value');

        const value = await CSDBUtils.executeSingleValue(parameters.dbQuery, params, alias);
        CSReporter.pass(`Database value: ${String(value).substring(0, 100)}`);
        return this.success('get-db-value', value !== null && value !== undefined ? String(value) : '');
    }

    /** Get single row from database (normalized) */
    private async executeDatabaseGetRow(parameters: StepParameters): Promise<ActionResult> {
        const { CSDBUtils, CSAIColumnNormalizer } = this.getDBModules();
        const alias = parameters.dbAlias || 'default';
        const params = this.resolveDbParams(parameters.dbParams);
        if (!parameters.dbQuery) throw new Error('No query specified for get-db-row');

        const result = await CSDBUtils.executeNamedQuery(parameters.dbQuery, params, alias);
        const rows = result.rows || [];
        if (rows.length === 0) throw new Error(`Database query '${parameters.dbQuery}' returned no rows`);

        const normalizedRow = CSAIColumnNormalizer.normalizeRow(rows[0]);
        CSReporter.pass(`Database row retrieved: ${Object.keys(normalizedRow).length} fields`);
        return this.success('get-db-row', normalizedRow as any);
    }

    /** Get multiple rows from database (normalized) */
    private async executeDatabaseGetRows(parameters: StepParameters): Promise<ActionResult> {
        const { CSDBUtils, CSAIColumnNormalizer } = this.getDBModules();
        const alias = parameters.dbAlias || 'default';
        const params = this.resolveDbParams(parameters.dbParams);
        if (!parameters.dbQuery) throw new Error('No query specified for get-db-rows');

        const result = await CSDBUtils.executeNamedQuery(parameters.dbQuery, params, alias);
        const normalizedRows = CSAIColumnNormalizer.normalizeRows(result.rows || []);
        CSReporter.pass(`Database query returned ${normalizedRows.length} row(s)`);
        return this.success('get-db-rows', normalizedRows as any);
    }

    /** Get row count from database */
    private async executeDatabaseGetCount(parameters: StepParameters): Promise<ActionResult> {
        const { CSDBUtils } = this.getDBModules();
        const alias = parameters.dbAlias || 'default';
        const params = this.resolveDbParams(parameters.dbParams);
        if (!parameters.dbQuery) throw new Error('No query specified for get-db-count');

        const result = await CSDBUtils.executeNamedQuery(parameters.dbQuery, params, alias);
        const count = (result.rows || []).length;
        CSReporter.pass(`Database count: ${count}`);
        return this.success('get-db-count', count);
    }

    // ========================================================================
    // CONTEXT HANDLER METHODS (Phase 4)
    // ========================================================================

    /** Get scenario context singleton (lazy-loaded) */
    private getScenarioContext(): any {
        const { CSScenarioContext } = require('../../bdd/CSScenarioContext');
        return CSScenarioContext.getInstance();
    }

    /** Get field from context variable */
    private executeContextGetField(parameters: StepParameters): ActionResult {
        const { CSAIColumnNormalizer } = require('./CSAIColumnNormalizer');
        const ctx = this.getScenarioContext();
        const varName = parameters.sourceContextVar;
        if (!varName) throw new Error('No context variable specified');
        if (!parameters.contextField) throw new Error('No field specified');

        const obj = ctx.getVariable(varName);
        if (obj === undefined) throw new Error(`Context variable '${varName}' not found`);

        let value: any;
        if (Array.isArray(obj)) {
            const rowIdx = parameters.contextRowIndex ?? 0;
            if (rowIdx >= obj.length) throw new Error(`Row index ${rowIdx} out of range (array has ${obj.length} items)`);
            value = CSAIColumnNormalizer.getField(obj[rowIdx], parameters.contextField);
        } else if (typeof obj === 'object' && obj !== null) {
            if (obj.rows && Array.isArray(obj.rows)) {
                const rowIdx = parameters.contextRowIndex ?? 0;
                if (rowIdx >= obj.rows.length) throw new Error(`Row index ${rowIdx} out of range (${obj.rows.length} rows)`);
                value = CSAIColumnNormalizer.getField(obj.rows[rowIdx], parameters.contextField);
            } else {
                value = CSAIColumnNormalizer.getField(obj, parameters.contextField);
            }
        } else {
            throw new Error(`Context variable '${varName}' is not an object or array`);
        }

        if (value === undefined) {
            const available = typeof obj === 'object' && obj !== null
                ? CSAIColumnNormalizer.getAvailableColumns(Array.isArray(obj) ? obj[0] || {} : obj.rows ? obj.rows[0] || {} : obj)
                : [];
            throw new Error(`Field '${parameters.contextField}' not found in context '${varName}'. Available: ${available.join(', ')}`);
        }

        CSReporter.pass(`Context field '${parameters.contextField}' from '${varName}': ${String(value).substring(0, 100)}`);
        return this.success('get-context-field', typeof value === 'object' ? value as any : String(value));
    }

    /** Get count of items in context variable */
    private executeContextGetCount(parameters: StepParameters): ActionResult {
        const ctx = this.getScenarioContext();
        const varName = parameters.sourceContextVar;
        if (!varName) throw new Error('No context variable specified');

        const obj = ctx.getVariable(varName);
        if (obj === undefined) throw new Error(`Context variable '${varName}' not found`);

        let count: number;
        if (Array.isArray(obj)) {
            count = obj.length;
        } else if (typeof obj === 'object' && obj !== null && obj.rows && Array.isArray(obj.rows)) {
            count = obj.rows.length;
        } else if (typeof obj === 'number') {
            count = obj;
        } else {
            throw new Error(`Cannot get count — context '${varName}' is not an array or countable`);
        }

        CSReporter.pass(`Count of context '${varName}': ${count}`);
        return this.success('get-context-count', count);
    }

    /** Get keys from context variable */
    private executeContextGetKeys(parameters: StepParameters): ActionResult {
        const ctx = this.getScenarioContext();
        const varName = parameters.sourceContextVar;
        if (!varName) throw new Error('No context variable specified');

        const obj = ctx.getVariable(varName);
        if (obj === undefined) throw new Error(`Context variable '${varName}' not found`);

        let keys: string[];
        if (Array.isArray(obj) && obj.length > 0) {
            keys = Object.keys(obj[0]);
        } else if (typeof obj === 'object' && obj !== null) {
            if (obj.rows && Array.isArray(obj.rows) && obj.rows.length > 0) {
                keys = Object.keys(obj.rows[0]);
            } else {
                keys = Object.keys(obj);
            }
        } else {
            throw new Error(`Cannot get keys — context '${varName}' is not an object`);
        }

        CSReporter.pass(`Keys from context '${varName}': ${keys.join(', ')}`);
        return this.success('get-context-keys', keys);
    }

    /** Copy one context variable to another */
    private executeContextCopy(parameters: StepParameters): ActionResult {
        const ctx = this.getScenarioContext();
        const source = parameters.sourceContextVar;
        const target = parameters.targetContextVar;
        if (!source) throw new Error('No source context variable specified');
        if (!target) throw new Error('No target context variable specified');

        const value = ctx.getVariable(source);
        if (value === undefined) throw new Error(`Context variable '${source}' not found`);

        // Deep copy to avoid shared references
        const copied = typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
        ctx.setVariable(target, copied);

        CSReporter.pass(`Copied context '${source}' to '${target}'`);
        return this.success('copy-context-var');
    }

    /** Set a field value in context variable, or concatenate/format */
    private executeContextSetField(parameters: StepParameters): ActionResult {
        const ctx = this.getScenarioContext();
        const op = parameters.comparisonOp;

        if (op === 'concatenate') {
            const var1 = ctx.getVariable(parameters.sourceContextVar || '');
            const var2 = ctx.getVariable(parameters.targetContextVar || '');
            const sep = parameters.separator || '';
            const result = `${String(var1 || '')}${sep}${String(var2 || '')}`;
            return this.success('set-context-field', result);
        }

        if (op === 'format-date') {
            const rawDate = ctx.getVariable(parameters.sourceContextVar || '');
            if (!rawDate) throw new Error(`Context variable '${parameters.sourceContextVar}' not found`);
            const date = new Date(rawDate);
            if (isNaN(date.getTime())) throw new Error(`Cannot parse date from context '${parameters.sourceContextVar}': ${rawDate}`);
            const formatted = this.formatDateValue(date, parameters.dateFormat || 'MM/DD/YYYY');
            return this.success('set-context-field', formatted);
        }

        // Default: set a field in an existing context object
        const { CSAIColumnNormalizer } = require('./CSAIColumnNormalizer');
        const varName = parameters.sourceContextVar;
        if (!varName) throw new Error('No context variable specified');
        if (!parameters.contextField) throw new Error('No field specified');

        const obj = ctx.getVariable(varName);
        if (obj === undefined) throw new Error(`Context variable '${varName}' not found`);
        if (typeof obj !== 'object' || obj === null) throw new Error(`Context variable '${varName}' is not an object`);

        CSAIColumnNormalizer.setField(obj, parameters.contextField, parameters.value);
        CSReporter.pass(`Set field '${parameters.contextField}' in context '${varName}' to '${parameters.value}'`);
        return this.success('set-context-field');
    }

    /** Clear a context variable */
    private executeContextClear(parameters: StepParameters): ActionResult {
        const ctx = this.getScenarioContext();
        const varName = parameters.sourceContextVar;
        if (!varName) throw new Error('No context variable specified');

        ctx.setVariable(varName, undefined);
        CSReporter.pass(`Cleared context '${varName}'`);
        return this.success('clear-context-var');
    }

    // ========================================================================
    // FILE OPERATION HANDLERS (Phase 3)
    // ========================================================================

    /** Parse a CSV file and return normalized rows */
    private async executeParseCSV(parameters: StepParameters): Promise<ActionResult> {
        const { CSAIColumnNormalizer } = require('./CSAIColumnNormalizer');
        let filePath = parameters.fileName || '';

        if (!filePath) {
            // Get most recent downloaded CSV file
            const ctx = this.getScenarioContext();
            const downloadPath = ctx.getVariable('_lastDownloadPath');
            if (downloadPath) {
                filePath = String(downloadPath);
            } else {
                throw new Error('No CSV file specified and no recent download found. Use: Parse CSV file \'path/to/file.csv\'');
            }
        }

        const fs = require('fs');
        const path = require('path');

        // Resolve relative paths
        if (!path.isAbsolute(filePath)) {
            const cwd = process.cwd();
            filePath = path.resolve(cwd, filePath);
        }

        if (!fs.existsSync(filePath)) {
            throw new Error(`CSV file not found: ${filePath}`);
        }

        // Parse CSV using CSCsvUtility if available, otherwise use basic parsing
        try {
            const { CSCsvUtility } = require('../../utils/CSCsvUtility');
            const rows = await CSCsvUtility.readAsJSON(filePath, { columns: true, skipEmptyLines: true, trim: true });
            const normalized = CSAIColumnNormalizer.normalizeRows(rows);
            CSReporter.pass(`Parsed CSV: ${normalized.length} rows from '${path.basename(filePath)}'`);
            return this.success('parse-csv', normalized);
        } catch (csvError: any) {
            // Fallback: basic CSV parsing
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n').filter((l: string) => l.trim());
            if (lines.length < 1) throw new Error('CSV file is empty');

            const headers = lines[0].split(',').map((h: string) => h.trim().replace(/^"|"$/g, ''));
            const rows: Record<string, any>[] = [];
            for (let i = 1; i < lines.length; i++) {
                const values = lines[i].split(',').map((v: string) => v.trim().replace(/^"|"$/g, ''));
                const row: Record<string, any> = {};
                headers.forEach((h: string, idx: number) => { row[h] = values[idx] || ''; });
                rows.push(row);
            }
            const normalized = CSAIColumnNormalizer.normalizeRows(rows);
            CSReporter.pass(`Parsed CSV: ${normalized.length} rows from '${path.basename(filePath)}'`);
            return this.success('parse-csv', normalized);
        }
    }

    /** Parse an XLSX file and return normalized rows */
    private async executeParseXLSX(parameters: StepParameters): Promise<ActionResult> {
        const { CSAIColumnNormalizer } = require('./CSAIColumnNormalizer');
        const path = require('path');

        let filePath = '';
        const sheetName = parameters.mappingSheet || '';

        // Get most recent downloaded XLSX if no specific path
        const ctx = this.getScenarioContext();
        const downloadPath = ctx.getVariable('_lastDownloadPath');
        if (downloadPath) {
            filePath = String(downloadPath);
        } else {
            throw new Error('No XLSX file found. Download an XLSX file first or specify a path.');
        }

        try {
            const XLSX = require('xlsx');
            const workbook = XLSX.readFile(filePath);
            const targetSheet = sheetName || workbook.SheetNames[0];
            const sheet = workbook.Sheets[targetSheet];
            if (!sheet) {
                throw new Error(`Sheet '${targetSheet}' not found. Available: ${workbook.SheetNames.join(', ')}`);
            }
            const rows: Record<string, any>[] = XLSX.utils.sheet_to_json(sheet);
            const normalized = CSAIColumnNormalizer.normalizeRows(rows);
            CSReporter.pass(`Parsed XLSX: ${normalized.length} rows from sheet '${targetSheet}' of '${path.basename(filePath)}'`);
            return this.success('parse-xlsx', normalized);
        } catch (e: any) {
            if (e.message.includes('Cannot find module')) {
                throw new Error('XLSX parsing requires the \'xlsx\' package. Install with: npm install xlsx');
            }
            throw e;
        }
    }

    /** Parse a JSON or YAML file */
    private async executeParseFile(parameters: StepParameters): Promise<ActionResult> {
        const { CSAIColumnNormalizer } = require('./CSAIColumnNormalizer');
        const fs = require('fs');
        const path = require('path');

        const filePath = parameters.fileName;
        const dataType = parameters.dataType || '';
        if (!filePath) throw new Error('No file path specified');

        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`File not found: ${resolvedPath}`);
        }

        const content = fs.readFileSync(resolvedPath, 'utf-8');
        let data: any;

        if (dataType === 'json' || resolvedPath.endsWith('.json')) {
            data = JSON.parse(content);
        } else if (dataType === 'yaml' || resolvedPath.endsWith('.yml') || resolvedPath.endsWith('.yaml')) {
            try {
                const yaml = require('js-yaml');
                data = yaml.load(content);
            } catch (e: any) {
                if (e.message.includes('Cannot find module')) {
                    throw new Error('YAML parsing requires the \'js-yaml\' package. Install with: npm install js-yaml');
                }
                throw e;
            }
        } else {
            throw new Error(`Unsupported file type for '${path.basename(resolvedPath)}'. Use JSON or YAML.`);
        }

        // Normalize if array of objects
        if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
            data = CSAIColumnNormalizer.normalizeRows(data);
        }

        CSReporter.pass(`Parsed ${dataType || path.extname(resolvedPath)} file: '${path.basename(resolvedPath)}'`);
        return this.success('parse-file', data);
    }

    /** Verify downloaded file name matches a regex pattern */
    private async executeVerifyFileNamePattern(parameters: StepParameters): Promise<ActionResult> {
        const pattern = parameters.regexPattern;
        if (!pattern) throw new Error('No regex pattern specified');

        const ctx = this.getScenarioContext();
        const downloadPath = ctx.getVariable('_lastDownloadPath');
        if (!downloadPath) throw new Error('No downloaded file found. Download a file first.');

        const path = require('path');
        const fileName = path.basename(String(downloadPath));
        const regex = new RegExp(pattern);

        if (!regex.test(fileName)) {
            const csAssert = getCSAssert();
            csAssert.fail(`File name '${fileName}' does not match pattern '${pattern}'`);
            return { success: false, error: `File name mismatch`, duration: 0, method: 'verify-file-name-pattern' };
        }

        CSReporter.pass(`File name '${fileName}' matches pattern '${pattern}'`);
        return this.success('verify-file-name-pattern');
    }

    /** Verify file row count */
    private async executeVerifyFileRowCount(parameters: StepParameters): Promise<ActionResult> {
        const ctx = this.getScenarioContext();
        const lastParsed = ctx.getVariable('_lastParsedFileData');

        if (!lastParsed || !Array.isArray(lastParsed)) {
            throw new Error('No parsed file data found. Parse a file first (CSV, XLSX, etc.).');
        }

        const actualCount = lastParsed.length;

        if (parameters.sourceContextVar) {
            // Compare with count from context variable
            const contextData = ctx.getVariable(parameters.sourceContextVar);
            let expectedCount: number;
            if (Array.isArray(contextData)) {
                expectedCount = contextData.length;
            } else if (typeof contextData === 'number') {
                expectedCount = contextData;
            } else {
                throw new Error(`Context '${parameters.sourceContextVar}' is not an array or number`);
            }

            if (actualCount !== expectedCount) {
                const csAssert = getCSAssert();
                csAssert.fail(`File row count ${actualCount} does not equal context '${parameters.sourceContextVar}' count ${expectedCount}`);
                return { success: false, error: 'Row count mismatch', duration: 0, method: 'verify-file-row-count' };
            }
            CSReporter.pass(`File row count (${actualCount}) equals context '${parameters.sourceContextVar}' count (${expectedCount})`);
        } else {
            const expected = parseInt(parameters.expectedValue || '0');
            if (actualCount !== expected) {
                const csAssert = getCSAssert();
                csAssert.fail(`File row count ${actualCount} does not equal expected ${expected}`);
                return { success: false, error: 'Row count mismatch', duration: 0, method: 'verify-file-row-count' };
            }
            CSReporter.pass(`File row count is ${actualCount} as expected`);
        }

        return this.success('verify-file-row-count');
    }

    /** Get row count from last parsed file */
    private async executeGetFileRowCount(): Promise<ActionResult> {
        const ctx = this.getScenarioContext();
        const lastParsed = ctx.getVariable('_lastParsedFileData');
        if (!lastParsed || !Array.isArray(lastParsed)) {
            throw new Error('No parsed file data found. Parse a file first.');
        }
        return this.success('get-file-row-count', lastParsed.length);
    }

    /** Get headers from last parsed file */
    private async executeGetFileHeaders(): Promise<ActionResult> {
        const ctx = this.getScenarioContext();
        const lastParsed = ctx.getVariable('_lastParsedFileData');
        if (!lastParsed || !Array.isArray(lastParsed) || lastParsed.length === 0) {
            throw new Error('No parsed file data found or file is empty. Parse a file first.');
        }
        const headers = Object.keys(lastParsed[0]);
        return this.success('get-file-headers', headers);
    }

    // ========================================================================
    // COMPARISON HANDLERS (Phase 5)
    // ========================================================================

    /** Verify two values are equal within a numeric tolerance */
    private executeVerifyTolerance(parameters: StepParameters): ActionResult {
        const actual = parameters.value || '';
        const expected = parameters.expectedValue || '';
        const tolerance = parameters.tolerance || 0;
        const comparisonOp = parameters.comparisonOp || '';

        if (comparisonOp === 'order-independent') {
            // Split, sort, compare
            const sortList = (s: string) => s.split(',').map(v => v.trim()).sort().join(', ');
            const sortedActual = sortList(actual);
            const sortedExpected = sortList(expected);
            if (sortedActual !== sortedExpected) {
                const csAssert = getCSAssert();
                csAssert.fail(`Order-independent match failed: '${actual}' vs '${expected}' (sorted: '${sortedActual}' vs '${sortedExpected}')`);
                return { success: false, error: 'Order-independent mismatch', duration: 0, method: 'verify-tolerance' };
            }
            CSReporter.pass(`Values match order-independently: '${actual}' ≈ '${expected}'`);
            return this.success('verify-tolerance');
        }

        const numActual = parseFloat(actual);
        const numExpected = parseFloat(expected);
        if (isNaN(numActual) || isNaN(numExpected)) {
            throw new Error(`Cannot compare non-numeric values with tolerance: '${actual}' vs '${expected}'`);
        }

        const diff = Math.abs(numActual - numExpected);
        if (diff > tolerance) {
            const csAssert = getCSAssert();
            csAssert.fail(`Value ${numActual} differs from ${numExpected} by ${diff} (tolerance: ${tolerance})`);
            return { success: false, error: 'Tolerance exceeded', duration: 0, method: 'verify-tolerance' };
        }

        CSReporter.pass(`Values match within tolerance: ${numActual} ≈ ${numExpected} (diff: ${diff}, tolerance: ${tolerance})`);
        return this.success('verify-tolerance');
    }

    /** Verify a specific field in a context variable */
    private executeVerifyContextField(parameters: StepParameters): ActionResult {
        const { CSAIColumnNormalizer } = require('./CSAIColumnNormalizer');
        const ctx = this.getScenarioContext();

        const varName = parameters.sourceContextVar;
        const fieldName = parameters.contextField;
        const expected = parameters.expectedValue || '';
        const op = parameters.comparisonOp || 'equals';
        const tolerance = parameters.tolerance;

        if (!varName) throw new Error('No context variable specified');
        if (!fieldName) throw new Error('No field name specified');

        const obj = ctx.getVariable(varName);
        if (obj === undefined) throw new Error(`Context variable '${varName}' not found`);

        let dataObj = obj;
        if (Array.isArray(obj) && obj.length > 0) {
            dataObj = obj[0]; // First row for arrays
        } else if (obj && typeof obj === 'object' && obj.rows && Array.isArray(obj.rows) && obj.rows.length > 0) {
            dataObj = obj.rows[0]; // ResultSet
        }

        const actual = CSAIColumnNormalizer.getField(dataObj, fieldName);
        if (actual === undefined) {
            const available = CSAIColumnNormalizer.getAvailableColumns(dataObj);
            throw new Error(`Field '${fieldName}' not found in context '${varName}'. Available: ${available.join(', ')}`);
        }

        const actualStr = String(actual).trim();
        const expectedStr = String(expected).trim();

        let passed = false;
        let reason = '';

        switch (op) {
            case 'contains':
                passed = actualStr.toLowerCase().includes(expectedStr.toLowerCase());
                reason = passed ? 'contains' : `'${actualStr}' does not contain '${expectedStr}'`;
                break;
            case 'not-equals':
                passed = actualStr !== expectedStr;
                reason = passed ? 'not equal' : `'${actualStr}' equals '${expectedStr}' (expected not-equal)`;
                break;
            default:
                if (tolerance !== undefined && tolerance > 0) {
                    const numActual = parseFloat(actualStr);
                    const numExpected = parseFloat(expectedStr);
                    if (!isNaN(numActual) && !isNaN(numExpected)) {
                        const diff = Math.abs(numActual - numExpected);
                        passed = diff <= tolerance;
                        reason = passed ? `within tolerance (diff: ${diff})` : `diff ${diff} > tolerance ${tolerance}`;
                    } else {
                        passed = actualStr === expectedStr;
                        reason = passed ? 'exact match' : `'${actualStr}' !== '${expectedStr}'`;
                    }
                } else {
                    passed = actualStr === expectedStr;
                    reason = passed ? 'exact match' : `'${actualStr}' !== '${expectedStr}'`;
                }
        }

        if (!passed) {
            const csAssert = getCSAssert();
            csAssert.fail(`Context '${varName}' field '${fieldName}': ${reason}. Actual='${actualStr}', Expected='${expectedStr}'`);
            return { success: false, error: reason, duration: 0, method: 'verify-context-field' };
        }

        CSReporter.pass(`Context '${varName}' field '${fieldName}' = '${actualStr}' (${reason})`);
        return this.success('verify-context-field');
    }

    /** Verify two context variables match (field-by-field) */
    private async executeVerifyContextMatch(parameters: StepParameters): Promise<ActionResult> {
        const { CSAIDataComparator } = require('./CSAIDataComparator');
        const ctx = this.getScenarioContext();

        const sourceVar = parameters.sourceContextVar;
        const targetVar = parameters.targetContextVar;
        if (!sourceVar || !targetVar) throw new Error('Both source and target context variables are required');

        const source = ctx.getVariable(sourceVar);
        const target = ctx.getVariable(targetVar);
        if (source === undefined) throw new Error(`Context variable '${sourceVar}' not found`);
        if (target === undefined) throw new Error(`Context variable '${targetVar}' not found`);

        const config: any = {};
        if (parameters.tolerance) config.tolerance = parameters.tolerance;
        if (parameters.exceptFields) {
            config.ignoreFields = parameters.exceptFields.split(',').map((f: string) => f.trim());
        }

        const sourceObj = Array.isArray(source) ? (source[0] || {}) : source;
        const targetObj = Array.isArray(target) ? (target[0] || {}) : target;

        const result = CSAIDataComparator.compareObjects(sourceObj, targetObj, config);

        if (!result.passed) {
            const csAssert = getCSAssert();
            const mismatchDetails = result.mismatches
                .map((m: any) => `  ${m.field}: expected='${m.expected}' actual='${m.actual}' (${m.reason})`)
                .join('\n');
            csAssert.fail(`Context match failed between '${sourceVar}' and '${targetVar}':\n${mismatchDetails}`);
            return { success: false, error: result.summary, duration: 0, method: 'verify-context-match' };
        }

        CSReporter.pass(`Context '${sourceVar}' matches '${targetVar}': ${result.summary}`);
        return this.success('verify-context-match');
    }

    /** Verify count comparison between context variables or against literal */
    private executeVerifyCountMatch(parameters: StepParameters): ActionResult {
        const ctx = this.getScenarioContext();
        const sourceVar = parameters.sourceContextVar;
        if (!sourceVar) throw new Error('No source context variable specified');

        const source = ctx.getVariable(sourceVar);
        if (source === undefined) throw new Error(`Context variable '${sourceVar}' not found`);

        const getCount = (val: any): number => {
            if (Array.isArray(val)) return val.length;
            if (val && typeof val === 'object' && val.rows && Array.isArray(val.rows)) return val.rows.length;
            if (typeof val === 'number') return val;
            throw new Error(`Cannot get count from non-array/non-number value`);
        };

        const sourceCount = getCount(source);
        let expectedCount: number;
        const op = parameters.comparisonOp || 'equals';

        if (parameters.targetContextVar) {
            // Compare with another context variable's count
            const target = ctx.getVariable(parameters.targetContextVar);
            if (target === undefined) throw new Error(`Context variable '${parameters.targetContextVar}' not found`);
            expectedCount = getCount(target);
        } else {
            expectedCount = parseInt(parameters.expectedValue || '0');
        }

        let passed = false;
        let description = '';

        switch (op) {
            case 'greater-than':
                passed = sourceCount > expectedCount;
                description = `${sourceCount} > ${expectedCount}`;
                break;
            case 'less-than':
                passed = sourceCount < expectedCount;
                description = `${sourceCount} < ${expectedCount}`;
                break;
            default:
                passed = sourceCount === expectedCount;
                description = `${sourceCount} === ${expectedCount}`;
        }

        if (!passed) {
            const csAssert = getCSAssert();
            csAssert.fail(`Count comparison failed: ${description} (source='${sourceVar}')`);
            return { success: false, error: `Count mismatch: ${description}`, duration: 0, method: 'verify-count-match' };
        }

        CSReporter.pass(`Count comparison passed: ${description}`);
        return this.success('verify-count-match');
    }

    /** Verify data match between two arrays with optional mapping/keys */
    private async executeVerifyDataMatch(parameters: StepParameters): Promise<ActionResult> {
        const { CSAIDataComparator } = require('./CSAIDataComparator');
        const ctx = this.getScenarioContext();

        const sourceVar = parameters.sourceContextVar;
        const targetVar = parameters.targetContextVar;
        if (!sourceVar || !targetVar) throw new Error('Both source and target context variables are required');

        const source = ctx.getVariable(sourceVar);
        const target = ctx.getVariable(targetVar);
        if (!source) throw new Error(`Context variable '${sourceVar}' not found`);
        if (!target) throw new Error(`Context variable '${targetVar}' not found`);

        const sourceArr = Array.isArray(source) ? source : [source];
        const targetArr = Array.isArray(target) ? target : [target];

        let config: any = {};

        // Load mapping file if specified
        if (parameters.mappingFile) {
            config = await CSAIDataComparator.loadMappingConfig(parameters.mappingFile);
        }

        // Override key fields if specified
        if (parameters.keyFields) {
            config.keyFields = parameters.keyFields.split(',').map((f: string) => f.trim());
        }

        const result = CSAIDataComparator.compareArrays(sourceArr, targetArr, config);

        if (!result.passed) {
            const csAssert = getCSAssert();
            const mismatchDetails = result.mismatches
                .slice(0, 10) // Limit to first 10 mismatches for readability
                .map((m: any) => `  ${m.field}: expected='${m.expected}' actual='${m.actual}' (${m.reason})`)
                .join('\n');
            const suffix = result.mismatches.length > 10 ? `\n  ... and ${result.mismatches.length - 10} more` : '';
            csAssert.fail(`Data match failed between '${sourceVar}' and '${targetVar}':\n${mismatchDetails}${suffix}`);
            return { success: false, error: result.summary, duration: 0, method: 'verify-data-match' };
        }

        CSReporter.pass(`Data match passed: ${result.summary}`);
        return this.success('verify-data-match');
    }

    /** Verify accumulated field comparison with tolerance and order-independent fields */
    private async executeVerifyAccumulated(parameters: StepParameters): Promise<ActionResult> {
        const { CSAIDataComparator } = require('./CSAIDataComparator');
        const ctx = this.getScenarioContext();

        const sourceVar = parameters.sourceContextVar;
        const targetVar = parameters.targetContextVar;
        if (!sourceVar || !targetVar) throw new Error('Both source and target context variables are required');

        const source = ctx.getVariable(sourceVar);
        const target = ctx.getVariable(targetVar);
        if (source === undefined) throw new Error(`Context variable '${sourceVar}' not found`);
        if (target === undefined) throw new Error(`Context variable '${targetVar}' not found`);

        const config: any = {};
        if (parameters.tolerance) config.tolerance = parameters.tolerance;
        if (parameters.orderIndependentFields) {
            config.orderIndependentFields = parameters.orderIndependentFields.split(',').map((f: string) => f.trim());
        }

        const sourceObj = Array.isArray(source) ? (source[0] || {}) : source;
        const targetObj = Array.isArray(target) ? (target[0] || {}) : target;

        const result = CSAIDataComparator.compareObjects(sourceObj, targetObj, config);

        if (!result.passed) {
            const csAssert = getCSAssert();
            const mismatchDetails = result.mismatches
                .map((m: any) => `  ${m.field}: expected='${m.expected}' actual='${m.actual}' (${m.reason})`)
                .join('\n');
            csAssert.fail(`Accumulated comparison failed between '${sourceVar}' and '${targetVar}':\n${mismatchDetails}`);
            return { success: false, error: result.summary, duration: 0, method: 'verify-accumulated' };
        }

        CSReporter.pass(`Accumulated comparison passed: ${result.summary}`);
        return this.success('verify-accumulated');
    }

    // ========================================================================
    // MAPPING HANDLERS (Phase 6)
    // ========================================================================

    /** Load a mapping config file into context */
    private async executeLoadMapping(parameters: StepParameters): Promise<ActionResult> {
        const { CSAIDataComparator } = require('./CSAIDataComparator');
        const path = require('path');

        const filePath = parameters.mappingFile;
        if (!filePath) throw new Error('No mapping file specified');

        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
        const config = await CSAIDataComparator.loadMappingConfig(resolvedPath, parameters.mappingSheet);

        CSReporter.pass(`Loaded mapping file: '${path.basename(resolvedPath)}'`);
        return this.success('load-mapping', config);
    }

    /** Transform context data using a mapping configuration */
    private async executeTransformData(parameters: StepParameters): Promise<ActionResult> {
        const { CSAIColumnNormalizer } = require('./CSAIColumnNormalizer');
        const { CSAIDataComparator } = require('./CSAIDataComparator');
        const ctx = this.getScenarioContext();

        const sourceVar = parameters.sourceContextVar;
        if (!sourceVar) throw new Error('No source context variable specified');

        const source = ctx.getVariable(sourceVar);
        if (source === undefined) throw new Error(`Context variable '${sourceVar}' not found`);

        // Get mapping config from context variable or file
        let mappingConfig: any;
        if (parameters.mappingFile) {
            const path = require('path');
            const resolvedPath = path.isAbsolute(parameters.mappingFile)
                ? parameters.mappingFile
                : path.resolve(process.cwd(), parameters.mappingFile);
            mappingConfig = await CSAIDataComparator.loadMappingConfig(resolvedPath);
        } else if (parameters.targetContextVar) {
            mappingConfig = ctx.getVariable(parameters.targetContextVar);
            if (!mappingConfig) throw new Error(`Mapping context variable '${parameters.targetContextVar}' not found`);
        } else {
            throw new Error('No mapping file or mapping context variable specified');
        }

        const mappings = mappingConfig.mappings || [];
        const transformRow = (row: Record<string, any>): Record<string, any> => {
            const result: Record<string, any> = {};
            for (const mapping of mappings) {
                const sourceField = mapping.source;
                const targetField = mapping.target || sourceField;
                let value = CSAIColumnNormalizer.getField(row, sourceField);
                if (value !== undefined && mapping.transform) {
                    value = CSAIDataComparator.applyTransform(value, mapping.transform, mapping.transformArg);
                }
                if (value !== undefined) {
                    result[targetField] = value;
                }
            }
            return result;
        };

        let transformed: any;
        if (Array.isArray(source)) {
            transformed = source.map(transformRow);
        } else if (typeof source === 'object') {
            transformed = transformRow(source);
        } else {
            throw new Error(`Context '${sourceVar}' is not an object or array — cannot transform`);
        }

        CSReporter.pass(`Transformed context '${sourceVar}' using mapping (${mappings.length} field mappings)`);
        return this.success('transform-data', transformed);
    }

    /** Prepare test data using a mapping definition file */
    private async executePrepareTestData(parameters: StepParameters): Promise<ActionResult> {
        const fs = require('fs');
        const path = require('path');
        const { CSAIColumnNormalizer } = require('./CSAIColumnNormalizer');
        const ctx = this.getScenarioContext();

        const filePath = parameters.mappingFile;
        if (!filePath) throw new Error('No mapping file specified for test data preparation');

        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`Test data mapping file not found: ${resolvedPath}`);
        }

        // Load the definition file (YAML or JSON)
        const content = fs.readFileSync(resolvedPath, 'utf-8');
        let definition: any;
        if (resolvedPath.endsWith('.json')) {
            definition = JSON.parse(content);
        } else {
            try {
                const yaml = require('js-yaml');
                definition = yaml.load(content);
            } catch (e: any) {
                if (e.message.includes('Cannot find module')) {
                    throw new Error('YAML parsing requires the \'js-yaml\' package. Install with: npm install js-yaml');
                }
                throw e;
            }
        }

        const fields = definition.fields || [];
        const result: Record<string, any> = {};

        // If existing context provided, start with its values
        if (parameters.sourceContextVar) {
            const existing = ctx.getVariable(parameters.sourceContextVar);
            if (existing && typeof existing === 'object') {
                Object.assign(result, existing);
            }
        }

        for (const field of fields) {
            const name = field.name;
            if (!name) continue;

            switch (field.source) {
                case 'static':
                    result[name] = field.value || '';
                    break;

                case 'context': {
                    const val = ctx.getVariable(field.contextVar || '');
                    result[name] = val !== undefined ? val : '';
                    break;
                }

                case 'generated': {
                    result[name] = this.generateFieldValue(field);
                    break;
                }

                case 'database': {
                    const { CSDBUtils } = this.getDBModules();
                    const dbAlias = field.dbAlias || '';
                    const query = field.query || '';
                    if (dbAlias && query) {
                        try {
                            const rows = await CSDBUtils.executeNamedQuery(dbAlias, query, []);
                            if (rows.length > 0) {
                                const normalizedRow = CSAIColumnNormalizer.normalizeRow(rows[0]);
                                result[name] = field.extract
                                    ? CSAIColumnNormalizer.getField(normalizedRow, field.extract)
                                    : normalizedRow;
                            }
                        } catch (dbError: any) {
                            CSReporter.warn(`Test data preparation: DB field '${name}' failed: ${dbError.message}`);
                        }
                    }
                    break;
                }

                case 'helper': {
                    const { CSAIHelperRegistry } = require('./CSAIHelperRegistry');
                    if (field.helperClass && field.helperMethod) {
                        try {
                            result[name] = await CSAIHelperRegistry.call(
                                `${field.helperClass}.${field.helperMethod}`,
                                field.args ? JSON.parse(JSON.stringify(field.args)) : []
                            );
                        } catch (helperError: any) {
                            CSReporter.warn(`Test data preparation: Helper field '${name}' failed: ${helperError.message}`);
                        }
                    }
                    break;
                }

                case 'derived': {
                    // Replace {fieldName} references with already-resolved values
                    let expr = field.expression || '';
                    for (const [key, value] of Object.entries(result)) {
                        expr = expr.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
                    }
                    result[name] = expr;
                    break;
                }

                default:
                    result[name] = field.value || '';
            }
        }

        CSReporter.pass(`Test data prepared: ${Object.keys(result).length} fields from '${path.basename(resolvedPath)}'`);
        return this.success('prepare-test-data', result);
    }

    /** Generate a field value based on generator config (for test data prep) */
    private generateFieldValue(field: any): any {
        const generator = field.generator || '';
        const args = field.args || {};

        switch (generator) {
            case 'randomDecimal': {
                const min = parseFloat(args.min || '0');
                const max = parseFloat(args.max || '100');
                const decimals = parseInt(args.decimals || '2');
                return (Math.random() * (max - min) + min).toFixed(decimals);
            }
            case 'businessDaysAgo': {
                const days = parseInt(field.arg || args.days || '1');
                return this.calcBusinessDays(-days);
            }
            case 'businessDaysFromNow': {
                const days = parseInt(field.arg || args.days || '1');
                return this.calcBusinessDays(days);
            }
            case 'uuid': {
                return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                    const r = Math.random() * 16 | 0;
                    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
                });
            }
            case 'timestamp':
                return new Date().toISOString();
            case 'randomString': {
                const len = parseInt(field.arg || args.length || '10');
                const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
            }
            default:
                return field.value || '';
        }
    }

    /** Calculate business days offset from today */
    private calcBusinessDays(offset: number): string {
        const date = new Date();
        const direction = offset >= 0 ? 1 : -1;
        let remaining = Math.abs(offset);
        while (remaining > 0) {
            date.setDate(date.getDate() + direction);
            const day = date.getDay();
            if (day !== 0 && day !== 6) remaining--;
        }
        return this.formatDateValue(date, 'MM/DD/YYYY');
    }

    // ========================================================================
    // TABLE EXTENSION HANDLERS (Phase 8)
    // ========================================================================

    /** Expand or collapse a table row */
    private async executeExpandCollapseRow(
        page: Page, element: MatchedElement | null, parameters: StepParameters, timeout: number
    ): Promise<ActionResult> {
        const action = parameters.expandAction || 'expand';
        const rowIndex = parameters.rowIndex;
        const searchText = parameters.value; // From expand-row-by-text

        // Find the table
        const table = element ? element.locator : page.locator('table').first();
        const rows = table.locator('tbody tr, tr').filter({ hasNot: page.locator('th') });

        let targetRow: Locator;
        if (searchText) {
            targetRow = rows.filter({ hasText: searchText }).first();
        } else if (rowIndex) {
            targetRow = rows.nth(rowIndex - 1);
        } else {
            throw new Error('No row index or search text specified for expand/collapse');
        }

        // Look for expand/collapse button
        const expandBtn = targetRow.locator(
            'button[aria-label*="xpand"], button[aria-label*="ollapse"], ' +
            '[aria-expanded], button:has(svg), button:has(.chevron), ' +
            '.expand-toggle, .row-toggle'
        ).first();

        const isExpanded = await expandBtn.getAttribute('aria-expanded').catch(() => null);

        if (action === 'expand' && isExpanded === 'true') {
            CSReporter.pass('Row is already expanded');
            return this.success('expand-row');
        }
        if (action === 'collapse' && isExpanded === 'false') {
            CSReporter.pass('Row is already collapsed');
            return this.success('collapse-row');
        }

        await expandBtn.click({ timeout });
        // Brief wait for animation
        await page.waitForTimeout(500);

        CSReporter.pass(`Row ${action === 'expand' ? 'expanded' : 'collapsed'} successfully`);
        return this.success(action === 'expand' ? 'expand-row' : 'collapse-row');
    }

    /** Verify a column is sorted in specified direction */
    private async executeVerifyColumnSorted(
        page: Page, element: MatchedElement | null, parameters: StepParameters, timeout: number
    ): Promise<ActionResult> {
        const columnRef = parameters.columnRef || '';
        const direction = parameters.sortDirection || 'ascending';
        const dataType = parameters.sortDataType || 'string';

        // Find table and extract column values
        const table = element ? element.locator : page.locator('table').first();
        const headers = await table.locator('thead th, th').allTextContents();
        const colIdx = headers.findIndex(h => h.trim().toLowerCase().includes(columnRef.toLowerCase()));
        if (colIdx === -1) throw new Error(`Column '${columnRef}' not found. Available: ${headers.join(', ')}`);

        const cells = await table.locator(`tbody td:nth-child(${colIdx + 1})`).allTextContents();
        const values = cells.map(c => c.trim()).filter(c => c.length > 0);

        // Check sorting
        for (let i = 1; i < values.length; i++) {
            let cmp: number;
            if (dataType === 'date') {
                cmp = new Date(values[i]).getTime() - new Date(values[i - 1]).getTime();
            } else if (dataType === 'number') {
                cmp = parseFloat(values[i]) - parseFloat(values[i - 1]);
            } else {
                cmp = values[i].localeCompare(values[i - 1]);
            }

            const valid = direction === 'ascending' ? cmp >= 0 : cmp <= 0;
            if (!valid) {
                const csAssert = getCSAssert();
                csAssert.fail(
                    `Column '${columnRef}' not sorted ${direction}: '${values[i - 1]}' before '${values[i]}' at row ${i}`
                );
                return { success: false, error: 'Sort order violated', duration: 0, method: 'verify-column-sorted' };
            }
        }

        CSReporter.pass(`Column '${columnRef}' is sorted ${direction} (${values.length} values checked)`);
        return this.success('verify-column-sorted');
    }

    /** Verify a column exists or does not exist in a table */
    private async executeVerifyColumnExists(
        page: Page, element: MatchedElement | null, parameters: StepParameters, timeout: number
    ): Promise<ActionResult> {
        const columnRef = parameters.columnRef || '';
        const notExists = parameters.comparisonOp === 'not-exists';

        const table = element ? element.locator : page.locator('table').first();
        const headers = await table.locator('thead th, th').allTextContents();
        const found = headers.some(h => h.trim().toLowerCase().includes(columnRef.toLowerCase()));

        if (notExists) {
            if (found) {
                const csAssert = getCSAssert();
                csAssert.fail(`Column '${columnRef}' exists but was expected not to`);
                return { success: false, error: 'Column unexpectedly exists', duration: 0, method: 'verify-column-exists' };
            }
            CSReporter.pass(`Column '${columnRef}' does not exist as expected`);
        } else {
            if (!found) {
                const csAssert = getCSAssert();
                csAssert.fail(`Column '${columnRef}' not found. Available: ${headers.join(', ')}`);
                return { success: false, error: 'Column not found', duration: 0, method: 'verify-column-exists' };
            }
            CSReporter.pass(`Column '${columnRef}' exists in table`);
        }

        return this.success('verify-column-exists');
    }

    // ========================================================================
    // FORM CAPTURE HANDLERS (Phase 9)
    // ========================================================================

    /** Capture form field values from the page or a scoped section */
    private async executeCaptureFormData(
        page: Page, parameters: StepParameters, timeout: number
    ): Promise<ActionResult> {
        const scope = parameters.captureScope || '';
        const specificFields = parameters.captureFields || '';

        let container: Locator;
        if (scope === 'modal') {
            container = page.locator('[role="dialog"], dialog, .modal').first();
        } else if (scope) {
            container = page.locator(`section:has-text("${scope}"), [aria-label*="${scope}"], fieldset:has(legend:has-text("${scope}"))`).first();
        } else {
            container = page.locator('body');
        }

        const result: Record<string, any> = {};

        if (specificFields) {
            // Capture only named fields
            const fieldNames = specificFields.split(',').map(f => f.trim());
            for (const fieldName of fieldNames) {
                const input = container.locator(
                    `[aria-label*="${fieldName}" i], label:has-text("${fieldName}") + input, ` +
                    `label:has-text("${fieldName}") + select, label:has-text("${fieldName}") + textarea, ` +
                    `input[placeholder*="${fieldName}" i]`
                ).first();

                try {
                    const tagName = await input.evaluate((el: any) => el.tagName.toLowerCase()).catch(() => '');
                    if (tagName === 'select') {
                        result[fieldName] = await input.locator('option:checked').textContent().catch(() => '') || '';
                    } else if (tagName === 'input') {
                        const type = await input.getAttribute('type') || 'text';
                        if (type === 'checkbox' || type === 'radio') {
                            result[fieldName] = String(await input.isChecked());
                        } else {
                            result[fieldName] = await input.inputValue().catch(() => '') || '';
                        }
                    } else if (tagName === 'textarea') {
                        result[fieldName] = await input.inputValue().catch(() => '') || '';
                    } else {
                        result[fieldName] = await input.textContent().catch(() => '') || '';
                    }
                } catch {
                    // Try getting as static text
                    const textEl = container.locator(`text="${fieldName}"`).locator('..').locator('span, div, p').first();
                    result[fieldName] = await textEl.textContent().catch(() => '') || '';
                }
            }
        } else {
            // Capture all labeled form elements
            const labels = await container.locator('label').all();
            for (const label of labels) {
                const labelText = (await label.textContent() || '').trim().replace(/:$/, '');
                if (!labelText) continue;

                const forAttr = await label.getAttribute('for');
                let input: Locator;
                if (forAttr) {
                    input = container.locator(`#${forAttr}`);
                } else {
                    input = label.locator('input, select, textarea').first();
                }

                try {
                    const tagName = await input.evaluate((el: any) => el.tagName.toLowerCase()).catch(() => '');
                    if (tagName === 'select') {
                        result[labelText] = await input.locator('option:checked').textContent().catch(() => '') || '';
                    } else if (tagName === 'input') {
                        const type = await input.getAttribute('type') || 'text';
                        if (type === 'checkbox' || type === 'radio') {
                            result[labelText] = String(await input.isChecked());
                        } else {
                            result[labelText] = await input.inputValue().catch(() => '') || '';
                        }
                    } else if (tagName === 'textarea') {
                        result[labelText] = await input.inputValue().catch(() => '') || '';
                    }
                } catch {
                    // Skip fields that can't be captured
                }
            }
        }

        CSReporter.pass(`Captured ${Object.keys(result).length} form field(s)`);
        return this.success('capture-form-data', result);
    }

    // ========================================================================
    // ORCHESTRATION HANDLERS (Phase 7)
    // ========================================================================

    /** Call a consumer-registered helper method */
    private async executeCallHelper(parameters: StepParameters): Promise<ActionResult> {
        const { CSAIHelperRegistry } = require('./CSAIHelperRegistry');

        const helperClass = parameters.helperClass;
        const helperMethod = parameters.helperMethod;
        if (!helperClass) throw new Error('No helper class specified');
        if (!helperMethod) throw new Error('No helper method specified');

        const classAndMethod = `${helperClass}.${helperMethod}`;

        // Build args
        let args: any[] = [];
        if (parameters.helperArgs) {
            try {
                args = JSON.parse(parameters.helperArgs);
                if (!Array.isArray(args)) args = [args];
            } catch {
                args = [parameters.helperArgs];
            }
        } else if (parameters.sourceContextVar && parameters.targetContextVar) {
            // Context args mode: pass two context variable values
            const ctx = this.getScenarioContext();
            const arg1 = ctx.getVariable(parameters.sourceContextVar);
            const arg2 = ctx.getVariable(parameters.targetContextVar);
            args = [arg1, arg2];
        }

        const result = await CSAIHelperRegistry.call(classAndMethod, args);
        CSReporter.pass(`Helper '${classAndMethod}' called successfully`);
        return this.success('call-helper', result);
    }

    // ========================================================================
    // UTILITY METHODS
    // ========================================================================
    // API HANDLER METHODS (Phase 11)
    // ========================================================================

    /** Execute an API call (GET/POST/PUT/PATCH/DELETE/HEAD) with full parameter support */
    private async executeApiCall(page: any, parameters: any, intent: string): Promise<ActionResult> {
        const method = (parameters.httpMethod || 'GET').toUpperCase();
        let url = parameters.apiUrl;
        if (!url) throw new Error('No API URL specified');

        // Prepend base URL if set and URL is relative
        const baseUrl = (this as any)._apiBaseUrl;
        if (baseUrl && url.startsWith('/')) {
            url = baseUrl.replace(/\/$/, '') + url;
        }

        // Append query params
        if (parameters.apiQueryParams) {
            const sep = url.includes('?') ? '&' : '?';
            url = url + sep + parameters.apiQueryParams;
        }

        // Build request options
        const requestOptions: any = {};
        const headers: Record<string, string> = { ...((this as any)._apiHeaders || {}) };

        // Auth
        const auth = (this as any)._apiAuth;
        if (auth) {
            if (auth.type === 'basic') {
                const b64 = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
                headers['Authorization'] = `Basic ${b64}`;
            } else if (auth.type === 'bearer') {
                headers['Authorization'] = `Bearer ${auth.token}`;
            } else if (auth.type === 'apikey') {
                headers[auth.paramName || 'X-API-Key'] = auth.key;
            }
        }

        // Body — from inline, file, or context
        if (intent === 'api-call-file' && parameters.apiPayloadFile) {
            const fs = require('fs');
            const path = require('path');
            const filePath = path.resolve(parameters.apiPayloadFile);
            if (!fs.existsSync(filePath)) throw new Error(`API payload file not found: ${filePath}`);
            requestOptions.data = fs.readFileSync(filePath, 'utf-8');
            if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
        } else if (parameters.apiContext && !parameters.apiAuthType) {
            // Body from context variable
            const ctx = this.getScenarioContext();
            const bodyData = ctx.getVariable(parameters.apiContext);
            requestOptions.data = typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData);
            if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
        } else if (parameters.apiFormData) {
            requestOptions.form = {};
            parameters.apiFormData.split('&').forEach((pair: string) => {
                const [key, ...valParts] = pair.split('=');
                requestOptions.form[key] = valParts.join('=');
            });
        } else if (parameters.requestBody) {
            requestOptions.data = parameters.requestBody;
            if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
        }

        requestOptions.headers = headers;

        // Timeout
        const apiTimeout = (this as any)._apiTimeout;
        if (apiTimeout) requestOptions.timeout = apiTimeout;

        // Store request for later reference
        const startTime = Date.now();
        (this as any)._lastApiRequest = { method, url, headers: { ...headers }, body: requestOptions.data || requestOptions.form || null };

        // Execute request using Playwright's built-in request API
        const apiContext = page.context().request || page.request;
        let response: any;
        switch (method) {
            case 'GET': response = await apiContext.get(url, requestOptions); break;
            case 'POST': response = await apiContext.post(url, requestOptions); break;
            case 'PUT': response = await apiContext.put(url, requestOptions); break;
            case 'PATCH': response = await apiContext.patch(url, requestOptions); break;
            case 'DELETE': response = await apiContext.delete(url, requestOptions); break;
            case 'HEAD': response = await apiContext.head(url, requestOptions); break;
            default: response = await apiContext.fetch(url, requestOptions);
        }

        const responseTime = Date.now() - startTime;
        let responseBody: string;
        try { responseBody = await response.text(); } catch { responseBody = ''; }

        (this as any)._lastApiResponse = {
            status: response.status(),
            body: responseBody,
            headers: response.headers(),
            responseTime,
            url: response.url()
        };

        CSReporter.debug(`AI Step: API ${method} ${url} → ${response.status()} (${responseTime}ms)`);
        return this.success('api-call', responseBody);
    }

    /** Set API context properties (base URL, timeout, named context) */
    private executeApiSetContext(parameters: any): ActionResult {
        if (parameters.url) {
            (this as any)._apiBaseUrl = parameters.url;
            CSReporter.pass(`API base URL set to: ${parameters.url}`);
        } else if (parameters.timeout) {
            (this as any)._apiTimeout = parseInt(String(parameters.timeout));
            CSReporter.pass(`API timeout set to: ${parameters.timeout}ms`);
        } else if (parameters.apiContext) {
            (this as any)._apiContextName = parameters.apiContext;
            CSReporter.pass(`API context set to: ${parameters.apiContext}`);
        }
        return this.success('api-set-context');
    }

    /** Set API headers */
    private executeApiSetHeader(parameters: any): ActionResult {
        if (!((this as any)._apiHeaders)) (this as any)._apiHeaders = {};

        if (parameters.apiContext) {
            // Set headers from context variable
            const ctx = this.getScenarioContext();
            const headersObj = ctx.getVariable(parameters.apiContext);
            if (headersObj && typeof headersObj === 'object') {
                Object.assign((this as any)._apiHeaders, headersObj);
                CSReporter.pass(`API headers set from context '${parameters.apiContext}'`);
            }
        } else if (parameters.attribute && parameters.value) {
            (this as any)._apiHeaders[parameters.attribute] = parameters.value;
            CSReporter.pass(`API header '${parameters.attribute}' set`);
        }
        return this.success('api-set-header');
    }

    /** Set API authentication */
    private executeApiSetAuth(parameters: any): ActionResult {
        const authType = parameters.apiAuthType;
        if (!authType) throw new Error('No auth type specified');

        if (authType === 'bearer' && parameters.apiContext) {
            // Bearer token from context
            const ctx = this.getScenarioContext();
            const token = ctx.getVariable(parameters.apiContext);
            (this as any)._apiAuth = { type: 'bearer', token: String(token) };
            CSReporter.pass('API bearer auth set from context');
        } else if (parameters.apiAuthParams) {
            const params = JSON.parse(parameters.apiAuthParams);
            (this as any)._apiAuth = { type: authType, ...params };
            CSReporter.pass(`API auth set: ${authType}`);
        } else {
            (this as any)._apiAuth = { type: authType };
            CSReporter.pass(`API auth type set: ${authType}`);
        }
        return this.success('api-set-auth');
    }

    /** Upload a file via API */
    private async executeApiUpload(page: any, parameters: any): Promise<ActionResult> {
        const url = parameters.apiUrl;
        if (!url) throw new Error('No API URL specified for upload');
        const filePath = parameters.filePath;
        if (!filePath) throw new Error('No file path specified for upload');

        const fs = require('fs');
        const path = require('path');
        const resolvedPath = path.resolve(filePath);
        if (!fs.existsSync(resolvedPath)) throw new Error(`Upload file not found: ${resolvedPath}`);

        const fullUrl = (this as any)._apiBaseUrl && url.startsWith('/')
            ? (this as any)._apiBaseUrl.replace(/\/$/, '') + url : url;

        const apiContext = page.context().request || page.request;
        const response = await apiContext.post(fullUrl, {
            multipart: {
                file: { name: path.basename(resolvedPath), mimeType: 'application/octet-stream', buffer: fs.readFileSync(resolvedPath) }
            },
            headers: { ...((this as any)._apiHeaders || {}) }
        });

        let responseBody: string;
        try { responseBody = await response.text(); } catch { responseBody = ''; }
        (this as any)._lastApiResponse = { status: response.status(), body: responseBody, headers: response.headers() };
        CSReporter.pass(`File uploaded to ${url}: status ${response.status()}`);
        return this.success('api-upload', responseBody);
    }

    /** Download a file via API */
    private async executeApiDownload(page: any, parameters: any): Promise<ActionResult> {
        const url = parameters.apiUrl;
        if (!url) throw new Error('No API URL specified for download');

        const fullUrl = (this as any)._apiBaseUrl && url.startsWith('/')
            ? (this as any)._apiBaseUrl.replace(/\/$/, '') + url : url;

        const apiContext = page.context().request || page.request;
        const response = await apiContext.get(fullUrl, { headers: { ...((this as any)._apiHeaders || {}) } });
        const body = await response.body();

        if (parameters.apiResponseSavePath) {
            const fs = require('fs');
            const path = require('path');
            const savePath = path.resolve(parameters.apiResponseSavePath);
            fs.mkdirSync(path.dirname(savePath), { recursive: true });
            fs.writeFileSync(savePath, body);
            CSReporter.pass(`File downloaded from ${url} and saved to ${savePath}`);
            return this.success('api-download', savePath);
        }

        (this as any)._lastApiResponse = { status: response.status(), body: body.toString(), headers: response.headers() };
        CSReporter.pass(`File downloaded from ${url}: ${body.length} bytes`);
        return this.success('api-download', body.toString());
    }

    /** Poll an API endpoint until a condition is met */
    private async executeApiPoll(page: any, parameters: any): Promise<ActionResult> {
        const url = parameters.apiUrl;
        if (!url) throw new Error('No API URL specified for polling');
        const method = (parameters.httpMethod || 'GET').toUpperCase();
        const pollField = parameters.apiPollField;
        const pollExpected = parameters.apiPollExpected;
        const interval = parameters.apiPollInterval || 2000;
        const maxTime = parameters.apiPollMaxTime || 30000;

        if (!pollField || !pollExpected) throw new Error('Poll field and expected value are required');

        const fullUrl = (this as any)._apiBaseUrl && url.startsWith('/')
            ? (this as any)._apiBaseUrl.replace(/\/$/, '') + url : url;

        const startTime = Date.now();
        const apiContext = page.context().request || page.request;

        while (Date.now() - startTime < maxTime) {
            const response = method === 'GET'
                ? await apiContext.get(fullUrl, { headers: { ...((this as any)._apiHeaders || {}) } })
                : await apiContext.fetch(fullUrl, { method, headers: { ...((this as any)._apiHeaders || {}) } });

            let responseBody: string;
            try { responseBody = await response.text(); } catch { responseBody = ''; }

            (this as any)._lastApiResponse = {
                status: response.status(), body: responseBody, headers: response.headers(),
                responseTime: Date.now() - startTime
            };

            try {
                const body = JSON.parse(responseBody);
                const value = this.extractJsonPath(body, pollField);
                if (String(value) === String(pollExpected)) {
                    CSReporter.pass(`API poll succeeded: ${pollField} = '${pollExpected}' after ${Date.now() - startTime}ms`);
                    return this.success('api-poll', responseBody);
                }
            } catch { /* continue polling */ }

            await new Promise(resolve => setTimeout(resolve, interval));
        }

        throw new Error(`API poll timeout after ${maxTime}ms: ${pollField} never equaled '${pollExpected}'`);
    }

    /** Save API response body to file */
    private executeApiSaveResponse(parameters: any): ActionResult {
        const lastResponse = (this as any)._lastApiResponse;
        if (!lastResponse) throw new Error('No API response to save. Call an API first.');
        const savePath = parameters.apiResponseSavePath;
        if (!savePath) throw new Error('No save path specified');

        const fs = require('fs');
        const path = require('path');
        const resolvedPath = path.resolve(savePath);
        fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
        fs.writeFileSync(resolvedPath, typeof lastResponse.body === 'string' ? lastResponse.body : JSON.stringify(lastResponse.body, null, 2));
        CSReporter.pass(`API response saved to: ${resolvedPath}`);
        return this.success('api-save-response');
    }

    /** Save API request details to file */
    private executeApiSaveRequest(parameters: any): ActionResult {
        const lastRequest = (this as any)._lastApiRequest;
        if (!lastRequest) throw new Error('No API request to save. Call an API first.');
        const savePath = parameters.apiResponseSavePath;
        if (!savePath) throw new Error('No save path specified');

        const fs = require('fs');
        const path = require('path');
        const resolvedPath = path.resolve(savePath);
        fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
        fs.writeFileSync(resolvedPath, JSON.stringify(lastRequest, null, 2));
        CSReporter.pass(`API request saved to: ${resolvedPath}`);
        return this.success('api-save-request');
    }

    /** Print API response or request details */
    private executeApiPrint(parameters: any): ActionResult {
        const target = parameters.apiPrintTarget || 'body';
        const lastResponse = (this as any)._lastApiResponse;
        const lastRequest = (this as any)._lastApiRequest;

        switch (target) {
            case 'body':
                if (!lastResponse) throw new Error('No API response to print');
                CSReporter.info(`API Response Body:\n${typeof lastResponse.body === 'string' ? lastResponse.body : JSON.stringify(lastResponse.body, null, 2)}`);
                break;
            case 'response-headers':
                if (!lastResponse) throw new Error('No API response to print');
                CSReporter.info(`API Response Headers:\n${JSON.stringify(lastResponse.headers, null, 2)}`);
                break;
            case 'request':
                if (!lastRequest) throw new Error('No API request to print');
                CSReporter.info(`API Request:\n${JSON.stringify(lastRequest, null, 2)}`);
                break;
            case 'request-headers':
                if (!lastRequest) throw new Error('No API request to print');
                CSReporter.info(`API Request Headers:\n${JSON.stringify(lastRequest.headers, null, 2)}`);
                break;
            default:
                CSReporter.info(`API Print target '${target}' not recognized`);
        }
        return this.success('api-print');
    }

    /** Execute API chaining operations */
    private async executeApiChain(page: any, parameters: any): Promise<ActionResult> {
        const lastResponse = (this as any)._lastApiResponse;

        // Extract and set bearer token from response
        if (parameters.apiAuthType === 'bearer' && parameters.jsonPath) {
            if (!lastResponse) throw new Error('No API response to extract token from');
            const body = typeof lastResponse.body === 'string' ? JSON.parse(lastResponse.body) : lastResponse.body;
            const token = this.extractJsonPath(body, parameters.jsonPath);
            if (!token) throw new Error(`Token not found at JSONPath '${parameters.jsonPath}'`);
            (this as any)._apiAuth = { type: 'bearer', token: String(token) };

            // If this is a login flow (has URL + body), execute the request first
            if (parameters.apiUrl && parameters.requestBody) {
                const callResult = await this.executeApiCall(page, parameters, 'api-call');
                const resp = (this as any)._lastApiResponse;
                const respBody = typeof resp.body === 'string' ? JSON.parse(resp.body) : resp.body;
                const extractedToken = this.extractJsonPath(respBody, parameters.jsonPath);
                if (extractedToken) {
                    (this as any)._apiAuth = { type: 'bearer', token: String(extractedToken) };
                    CSReporter.pass(`Login flow completed, bearer token extracted from ${parameters.jsonPath}`);
                }
                return callResult;
            }

            CSReporter.pass(`Bearer token extracted from response ${parameters.jsonPath}`);
            return this.success('api-chain', String(token));
        }

        // Store cookies from response
        if (parameters.apiContext && parameters.jsonPath === '$.cookies') {
            if (!lastResponse) throw new Error('No API response to extract cookies from');
            const ctx = this.getScenarioContext();
            ctx.setVariable(parameters.apiContext, lastResponse.headers?.['set-cookie'] || '');
            CSReporter.pass('API response cookies stored');
            return this.success('api-chain');
        }

        // Set body field from previous response
        if (parameters.jsonPath && !parameters.apiAuthType) {
            if (!lastResponse) throw new Error('No API response to extract from');
            const body = typeof lastResponse.body === 'string' ? JSON.parse(lastResponse.body) : lastResponse.body;
            const value = this.extractJsonPath(body, parameters.jsonPath);
            (this as any)._apiChainedValue = value;
            CSReporter.pass(`Chained value extracted from ${parameters.jsonPath}`);
            return this.success('api-chain', value);
        }

        throw new Error('Unsupported API chain operation');
    }

    /** Execute an API chain from a definition file */
    private async executeApiExecuteChain(page: any, parameters: any): Promise<ActionResult> {
        const chainFile = parameters.apiChainFile;
        if (!chainFile) throw new Error('No API chain file specified');

        const fs = require('fs');
        const path = require('path');
        const resolvedPath = path.resolve(chainFile);
        if (!fs.existsSync(resolvedPath)) throw new Error(`API chain file not found: ${resolvedPath}`);

        const chainDef = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
        const steps = chainDef.steps || chainDef;
        if (!Array.isArray(steps)) throw new Error('API chain file must contain a "steps" array');

        const results: any[] = [];
        for (const step of steps) {
            const stepParams = { ...step };
            // Resolve context references in params
            const ctx = this.getScenarioContext();
            for (const [key, val] of Object.entries(stepParams)) {
                if (typeof val === 'string' && val.startsWith('{context:')) {
                    const varName = val.replace(/^\{context:/, '').replace(/\}$/, '');
                    stepParams[key] = ctx.getVariable(varName);
                }
            }
            const result = await this.executeApiCall(page, stepParams, 'api-call');
            results.push((this as any)._lastApiResponse);
        }

        CSReporter.pass(`API chain completed: ${steps.length} steps executed`);
        return this.success('api-execute-chain', results);
    }

    /** Execute a SOAP API request */
    private async executeApiSoap(page: any, parameters: any): Promise<ActionResult> {
        const url = parameters.apiUrl;
        if (!url) throw new Error('No SOAP URL specified');

        let body: string;
        if (parameters.apiPayloadFile) {
            const fs = require('fs');
            const path = require('path');
            const filePath = path.resolve(parameters.apiPayloadFile);
            if (!fs.existsSync(filePath)) throw new Error(`SOAP payload file not found: ${filePath}`);
            body = fs.readFileSync(filePath, 'utf-8');
        } else if (parameters.soapOperation) {
            // Build basic SOAP envelope
            let paramsXml = '';
            if (parameters.soapParams) {
                const params = JSON.parse(parameters.soapParams);
                for (const [key, val] of Object.entries(params)) {
                    paramsXml += `<${key}>${val}</${key}>`;
                }
            }
            body = `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${parameters.soapOperation}>${paramsXml}</${parameters.soapOperation}></soap:Body></soap:Envelope>`;
        } else {
            throw new Error('SOAP request requires either a payload file or operation name');
        }

        const headers: Record<string, string> = {
            'Content-Type': 'text/xml; charset=utf-8',
            ...((this as any)._apiHeaders || {})
        };
        if (parameters.soapOperation) {
            headers['SOAPAction'] = parameters.soapOperation;
        }

        const apiContext = page.context().request || page.request;
        const startTime = Date.now();
        const response = await apiContext.post(url, { data: body, headers });
        const responseTime = Date.now() - startTime;

        let responseBody: string;
        try { responseBody = await response.text(); } catch { responseBody = ''; }

        (this as any)._lastApiResponse = {
            status: response.status(), body: responseBody, headers: response.headers(), responseTime
        };
        (this as any)._lastApiRequest = { method: 'POST', url, headers, body };

        CSReporter.pass(`SOAP ${parameters.soapOperation || 'request'} to ${url}: status ${response.status()}`);
        return this.success('api-soap', responseBody);
    }

    /** Comprehensive API response verification */
    private executeVerifyApiResponse(parameters: any): ActionResult {
        const lastResponse = (this as any)._lastApiResponse;
        if (!lastResponse) throw new Error('No API response to verify. Call an API first.');
        const op = parameters.comparisonOp || '';
        const expected = parameters.expectedValue;

        // Status code verification
        if (parameters.httpMethod === 'STATUS') {
            const expectedStatus = parseInt(expected || '200');
            if (lastResponse.status !== expectedStatus) {
                throw new Error(`Expected API status ${expectedStatus} but got ${lastResponse.status}`);
            }
            return this.success('verify-api-response');
        }

        if (parameters.httpMethod === 'STATUS_RANGE') {
            // Support "2xx", "4xx" patterns
            const statusStr = expected || '2xx';
            const firstDigit = statusStr.charAt(0);
            const actualFirst = String(lastResponse.status).charAt(0);
            if (actualFirst !== firstDigit) {
                throw new Error(`Expected API status in ${firstDigit}xx range but got ${lastResponse.status}`);
            }
            return this.success('verify-api-response');
        }

        const body = typeof lastResponse.body === 'string' ? lastResponse.body : JSON.stringify(lastResponse.body);

        switch (op) {
            case 'contains':
                if (!body.includes(expected || '')) {
                    throw new Error(`API response does not contain "${expected}"`);
                }
                break;
            case 'not-contains':
                if (body.includes(expected || '')) {
                    throw new Error(`API response should not contain "${expected}" but it does`);
                }
                break;
            case 'empty':
                if (body.trim().length > 0) {
                    throw new Error('Expected empty API response but got content');
                }
                break;
            case 'not-empty':
                if (body.trim().length === 0) {
                    throw new Error('Expected non-empty API response but got empty');
                }
                break;
            case 'redirect': {
                const status = lastResponse.status;
                if (status < 300 || status >= 400) {
                    throw new Error(`Expected redirect status (3xx) but got ${status}`);
                }
                if (expected) {
                    const location = lastResponse.headers?.location || lastResponse.url;
                    if (!location?.includes(expected)) {
                        throw new Error(`Expected redirect to contain "${expected}" but got "${location}"`);
                    }
                }
                break;
            }
            case 'response-time-lt': {
                const maxTime = parseFloat(expected || '5000');
                const responseTime = lastResponse.responseTime || 0;
                if (responseTime > maxTime) {
                    throw new Error(`API response time ${responseTime}ms exceeds limit ${maxTime}ms`);
                }
                break;
            }
            case 'exists': {
                // Header existence or JSONPath existence
                if (parameters.attribute) {
                    const headerVal = lastResponse.headers?.[parameters.attribute.toLowerCase()];
                    if (!headerVal) {
                        throw new Error(`API response header '${parameters.attribute}' not found`);
                    }
                } else if (parameters.jsonPath) {
                    const parsed = typeof lastResponse.body === 'string' ? JSON.parse(lastResponse.body) : lastResponse.body;
                    const val = this.extractJsonPath(parsed, parameters.jsonPath);
                    if (val === undefined || val === null) {
                        throw new Error(`JSONPath '${parameters.jsonPath}' does not exist in API response`);
                    }
                }
                break;
            }
            case 'not-exists': {
                if (parameters.jsonPath) {
                    const parsed = typeof lastResponse.body === 'string' ? JSON.parse(lastResponse.body) : lastResponse.body;
                    const val = this.extractJsonPath(parsed, parameters.jsonPath);
                    if (val !== undefined && val !== null) {
                        throw new Error(`JSONPath '${parameters.jsonPath}' should not exist but has value: ${val}`);
                    }
                }
                break;
            }
            case 'equals': {
                if (parameters.attribute) {
                    // Header value check
                    const headerVal = lastResponse.headers?.[parameters.attribute.toLowerCase()] || '';
                    if (!String(headerVal).includes(expected || '')) {
                        throw new Error(`API header '${parameters.attribute}' is '${headerVal}', expected to contain '${expected}'`);
                    }
                } else if (parameters.jsonPath) {
                    // JSONPath value check
                    const parsed = typeof lastResponse.body === 'string' ? JSON.parse(lastResponse.body) : lastResponse.body;
                    const val = this.extractJsonPath(parsed, parameters.jsonPath);
                    if (String(val) !== String(expected)) {
                        throw new Error(`JSONPath '${parameters.jsonPath}' = '${val}', expected '${expected}'`);
                    }
                    // DB comparison
                    if (parameters.sourceContextVar) {
                        const ctx = this.getScenarioContext();
                        const contextVal = ctx.getVariable(parameters.sourceContextVar);
                        if (String(val) !== String(contextVal)) {
                            throw new Error(`JSONPath '${parameters.jsonPath}' = '${val}', expected context '${parameters.sourceContextVar}' = '${contextVal}'`);
                        }
                    }
                } else if (expected) {
                    if (!body.includes(expected)) {
                        throw new Error(`API response does not contain "${expected}"`);
                    }
                }
                break;
            }
            case 'count': {
                if (parameters.jsonPath) {
                    const parsed = typeof lastResponse.body === 'string' ? JSON.parse(lastResponse.body) : lastResponse.body;
                    const val = this.extractJsonPath(parsed, parameters.jsonPath);
                    const count = Array.isArray(val) ? val.length : 0;
                    const expectedCount = parseInt(expected || '0');
                    if (count !== expectedCount) {
                        throw new Error(`JSONPath '${parameters.jsonPath}' count is ${count}, expected ${expectedCount}`);
                    }
                }
                break;
            }
            case 'greater-than': {
                if (parameters.jsonPath) {
                    const parsed = typeof lastResponse.body === 'string' ? JSON.parse(lastResponse.body) : lastResponse.body;
                    const val = parseFloat(String(this.extractJsonPath(parsed, parameters.jsonPath)));
                    const threshold = parseFloat(expected || '0');
                    if (val <= threshold) {
                        throw new Error(`JSONPath '${parameters.jsonPath}' = ${val}, expected greater than ${threshold}`);
                    }
                }
                break;
            }
            case 'less-than': {
                if (parameters.jsonPath) {
                    const parsed = typeof lastResponse.body === 'string' ? JSON.parse(lastResponse.body) : lastResponse.body;
                    const val = parseFloat(String(this.extractJsonPath(parsed, parameters.jsonPath)));
                    const threshold = parseFloat(expected || '0');
                    if (val >= threshold) {
                        throw new Error(`JSONPath '${parameters.jsonPath}' = ${val}, expected less than ${threshold}`);
                    }
                }
                break;
            }
            case 'type': {
                if (parameters.jsonPath) {
                    const parsed = typeof lastResponse.body === 'string' ? JSON.parse(lastResponse.body) : lastResponse.body;
                    const val = this.extractJsonPath(parsed, parameters.jsonPath);
                    const actualType = Array.isArray(val) ? 'array' : typeof val;
                    if (actualType !== (expected || '').toLowerCase()) {
                        throw new Error(`JSONPath '${parameters.jsonPath}' type is '${actualType}', expected '${expected}'`);
                    }
                }
                break;
            }
            case 'matches': {
                if (parameters.jsonPath && parameters.regexPattern) {
                    const parsed = typeof lastResponse.body === 'string' ? JSON.parse(lastResponse.body) : lastResponse.body;
                    const val = String(this.extractJsonPath(parsed, parameters.jsonPath) || '');
                    const regex = new RegExp(parameters.regexPattern);
                    if (!regex.test(val)) {
                        throw new Error(`JSONPath '${parameters.jsonPath}' value '${val}' does not match pattern '${parameters.regexPattern}'`);
                    }
                }
                break;
            }
            default:
                // Fallback: simple body contains check
                if (expected && !body.includes(expected)) {
                    throw new Error(`API response does not contain "${expected}"`);
                }
        }

        return this.success('verify-api-response');
    }

    /** Verify API response against JSON schema */
    private async executeVerifyApiSchema(parameters: any): Promise<ActionResult> {
        const lastResponse = (this as any)._lastApiResponse;
        if (!lastResponse) throw new Error('No API response to verify schema. Call an API first.');
        const schemaFile = parameters.apiSchemaFile;
        if (!schemaFile) throw new Error('No schema file specified');

        const fs = require('fs');
        const path = require('path');
        const resolvedPath = path.resolve(schemaFile);
        if (!fs.existsSync(resolvedPath)) throw new Error(`Schema file not found: ${resolvedPath}`);

        const schema = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
        const body = typeof lastResponse.body === 'string' ? JSON.parse(lastResponse.body) : lastResponse.body;

        // Basic JSON Schema validation (type, required, properties)
        const errors = this.validateJsonSchema(body, schema, '');
        if (errors.length > 0) {
            throw new Error(`API response schema validation failed:\n${errors.join('\n')}`);
        }

        CSReporter.pass(`API response matches schema: ${schemaFile}`);
        return this.success('verify-api-schema');
    }

    /** Enhanced get-api-response with full JSONPath support */
    private executeGetApiResponse(parameters: any): ActionResult {
        const lastResponse = (this as any)._lastApiResponse;

        // Check if extracting from a stored response variable
        if (parameters.apiResponseSavePath && parameters.jsonPath) {
            const ctx = this.getScenarioContext();
            const storedResp = ctx.getVariable(parameters.apiResponseSavePath);
            if (!storedResp) throw new Error(`No stored response found at '${parameters.apiResponseSavePath}'`);
            const body = typeof storedResp === 'string' ? JSON.parse(storedResp) :
                (typeof storedResp === 'object' && storedResp.body) ?
                    (typeof storedResp.body === 'string' ? JSON.parse(storedResp.body) : storedResp.body) : storedResp;
            const value = this.extractJsonPath(body, parameters.jsonPath);
            return this.success('get-api-response', typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''));
        }

        if (!lastResponse) throw new Error('No API response available. Call an API first.');

        if (parameters.jsonPath) {
            // Handle special built-in paths
            switch (parameters.jsonPath) {
                case '$.statusCode':
                    return this.success('get-api-response', String(lastResponse.status));
                case '$.body':
                    return this.success('get-api-response', typeof lastResponse.body === 'string' ? lastResponse.body : JSON.stringify(lastResponse.body));
                case '$.headers':
                    return this.success('get-api-response', JSON.stringify(lastResponse.headers));
                case '$.responseTime':
                    return this.success('get-api-response', String(lastResponse.responseTime || 0));
                case '$.cookies':
                    return this.success('get-api-response', lastResponse.headers?.['set-cookie'] || '');
            }

            // Header extraction
            if (parameters.jsonPath.startsWith('$.headers.')) {
                const headerName = parameters.jsonPath.replace('$.headers.', '');
                const headerVal = lastResponse.headers?.[headerName.toLowerCase()] || '';
                return this.success('get-api-response', String(headerVal));
            }

            // General JSONPath extraction
            const body = typeof lastResponse.body === 'string' ? JSON.parse(lastResponse.body) : lastResponse.body;

            if (parameters.comparisonOp === 'all') {
                // Extract all matching values (for wildcard paths like $.items[*].name)
                const values = this.extractAllJsonPath(body, parameters.jsonPath);
                return this.success('get-api-response', values);
            }

            const value = this.extractJsonPath(body, parameters.jsonPath);
            return this.success('get-api-response', typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''));
        }

        // XPath extraction for SOAP/XML responses
        if (parameters.xpathExpression) {
            // Basic XPath extraction from XML string
            const xmlBody = typeof lastResponse.body === 'string' ? lastResponse.body : '';
            const tagMatch = parameters.xpathExpression.match(/\/\/(\w+)(?:\/(\w+))?$/);
            if (tagMatch) {
                const tag = tagMatch[2] || tagMatch[1];
                const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
                const match = xmlBody.match(regex);
                return this.success('get-api-response', match ? match[1] : '');
            }
            return this.success('get-api-response', '');
        }

        const bodyStr = typeof lastResponse.body === 'string' ? lastResponse.body : JSON.stringify(lastResponse.body);
        return this.success('get-api-response', bodyStr);
    }

    /** Extract a value from an object using JSONPath-like syntax */
    private extractJsonPath(obj: any, jsonPath: string): any {
        if (!obj || !jsonPath) return undefined;
        const path = jsonPath.replace(/^\$\.?/, '');
        if (!path) return obj;

        const parts = path.split(/\.|\[|\]/).filter(p => p.length > 0);
        let current = obj;
        for (const part of parts) {
            if (current === undefined || current === null) return undefined;
            if (part === '*' && Array.isArray(current)) {
                return current; // Return full array for wildcard
            }
            const index = parseInt(part);
            if (!isNaN(index) && Array.isArray(current)) {
                current = current[index];
            } else {
                current = current[part];
            }
        }
        return current;
    }

    /** Extract all matching values from wildcard JSONPath */
    private extractAllJsonPath(obj: any, jsonPath: string): string[] {
        if (!obj || !jsonPath) return [];
        // Handle patterns like $.items[*].name
        const match = jsonPath.match(/^\$\.(.+?)\[\*\]\.(.+)$/);
        if (match) {
            const arrayPath = match[1];
            const fieldName = match[2];
            const arr = this.extractJsonPath(obj, `$.${arrayPath}`);
            if (Array.isArray(arr)) {
                return arr.map(item => String(item?.[fieldName] ?? ''));
            }
        }
        // Fallback: try direct extraction
        const val = this.extractJsonPath(obj, jsonPath);
        if (Array.isArray(val)) return val.map(v => String(v));
        return val !== undefined ? [String(val)] : [];
    }

    /** Basic JSON Schema validator */
    private validateJsonSchema(data: any, schema: any, path: string): string[] {
        const errors: string[] = [];
        if (!schema) return errors;

        if (schema.type) {
            const actualType = Array.isArray(data) ? 'array' : typeof data;
            if (schema.type === 'integer' && typeof data === 'number') {
                if (!Number.isInteger(data)) errors.push(`${path || '$'}: expected integer, got float`);
            } else if (actualType !== schema.type) {
                errors.push(`${path || '$'}: expected type '${schema.type}', got '${actualType}'`);
                return errors;
            }
        }

        if (schema.required && typeof data === 'object' && !Array.isArray(data)) {
            for (const field of schema.required) {
                if (!(field in data)) {
                    errors.push(`${path || '$'}: missing required field '${field}'`);
                }
            }
        }

        if (schema.properties && typeof data === 'object' && !Array.isArray(data)) {
            for (const [key, propSchema] of Object.entries(schema.properties)) {
                if (key in data) {
                    errors.push(...this.validateJsonSchema(data[key], propSchema, `${path}.${key}`));
                }
            }
        }

        if (schema.items && Array.isArray(data)) {
            for (let i = 0; i < data.length; i++) {
                errors.push(...this.validateJsonSchema(data[i], schema.items, `${path}[${i}]`));
            }
        }

        return errors;
    }

    // ========================================================================

    /** Format a Date object using a pattern string */
    private formatDateValue(date: Date, format: string): string {
        const pad = (n: number) => String(n).padStart(2, '0');
        return format
            .replace('YYYY', String(date.getFullYear()))
            .replace('YY', String(date.getFullYear()).slice(-2))
            .replace('MM', pad(date.getMonth() + 1))
            .replace('DD', pad(date.getDate()))
            .replace('HH', pad(date.getHours()))
            .replace('mm', pad(date.getMinutes()))
            .replace('ss', pad(date.getSeconds()));
    }
}
