import { expect as playwrightExpect, Page, Locator } from '@playwright/test';
import { CSReporter } from '../reporter/CSReporter';
import { CSBrowserManager } from '../browser/CSBrowserManager';
import { CSTestResultsManager } from '../reporter/CSTestResultsManager';
import { CSScenarioContext } from '../bdd/CSScenarioContext';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Custom Expect wrapper for CS Framework
 * Provides screenshot capture before assertion failures
 * and better error handling for test stability
 */
export class CSExpect {
    private static instance: CSExpect;
    private browserManager: CSBrowserManager;
    private resultsManager: CSTestResultsManager;
    private scenarioContext: CSScenarioContext;
    private softMode: boolean = false;
    private assertionCount: number = 0;
    private failedAssertions: Array<{ message: string; screenshot?: string }> = [];

    private constructor() {
        this.browserManager = CSBrowserManager.getInstance();
        this.resultsManager = CSTestResultsManager.getInstance();
        this.scenarioContext = CSScenarioContext.getInstance();
    }

    public static getInstance(): CSExpect {
        if (!CSExpect.instance) {
            CSExpect.instance = new CSExpect();
        }
        return CSExpect.instance;
    }

    /**
     * Enable soft assertion mode - assertions won't stop test execution
     */
    public enableSoftMode(): void {
        this.softMode = true;
        this.failedAssertions = [];
        CSReporter.debug('Soft assertion mode enabled');
    }

    /**
     * Disable soft assertion mode
     */
    public disableSoftMode(): void {
        this.softMode = false;
        CSReporter.debug('Soft assertion mode disabled');
    }

    /**
     * Check if there were any soft assertion failures
     */
    public async assertAll(): Promise<void> {
        if (this.failedAssertions.length > 0) {
            const errorMessage = this.failedAssertions.map(f => f.message).join('\n');
            CSReporter.error(`${this.failedAssertions.length} soft assertions failed:\n${errorMessage}`);
            this.failedAssertions = [];
            throw new Error(`Multiple assertion failures: ${errorMessage}`);
        }
    }

    /**
     * Capture screenshot before assertion
     */
    private async capturePreAssertionScreenshot(description: string): Promise<string | undefined> {
        try {
            // Check if pre-assertion screenshots are enabled
            const config = CSConfigurationManager.getInstance();
            const preAssertionScreenshot = config.getBoolean('PRE_ASSERTION_SCREENSHOT', true);

            if (!preAssertionScreenshot) {
                CSReporter.debug('Pre-assertion screenshot disabled by configuration');
                return undefined;
            }

            const page = this.browserManager.getPage();

            // Check if page is valid
            if (!page || page.isClosed()) {
                CSReporter.debug('Cannot capture pre-assertion screenshot - page is closed or invalid');
                return undefined;
            }

            // Wait for page to be stable - improved timing strategy
            try {
                // First ensure the page has basic content loaded
                await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});

                // Check if page has any visible content (not blank)
                try {
                    await page.waitForFunction(() => {
                        const body = document.body;
                        return body && body.innerText && body.innerText.trim().length > 0;
                    }, { timeout: 2000 });
                } catch {
                    CSReporter.debug('Page appears to have no visible text content');
                }

                // Wait a moment for any error messages or dynamic content to appear
                await page.waitForTimeout(1000);

            } catch (error) {
                CSReporter.debug(`Page stabilization had issues: ${error}`);
            }

            const dirs = this.resultsManager.getDirectories();
            const screenshotDir = dirs.screenshots;

            // Ensure directory exists
            if (!fs.existsSync(screenshotDir)) {
                fs.mkdirSync(screenshotDir, { recursive: true });
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `assertion-${description.replace(/[^a-zA-Z0-9]/g, '-')}-${timestamp}.png`;
            const screenshotPath = path.join(screenshotDir, filename);

            // Take screenshot with error handling
            await page.screenshot({
                path: screenshotPath,
                fullPage: false // Just visible viewport for assertions
            });

            // Add screenshot to current step so it appears in step details
            this.scenarioContext.setCurrentStepScreenshot(screenshotPath);
            // Also add to general screenshots collection
            this.scenarioContext.addScreenshot(screenshotPath, 'assertion-check');

            CSReporter.debug(`Pre-assertion screenshot captured: ${filename}`);
            return screenshotPath;
        } catch (error) {
            CSReporter.debug(`Failed to capture pre-assertion screenshot: ${error}`);
            return undefined;
        }
    }

    /**
     * Wrap an assertion with screenshot capture
     */
    private async wrapAssertion<T>(
        assertion: () => Promise<T>,
        description: string,
        element?: Locator
    ): Promise<T> {
        this.assertionCount++;

        // Skip pre-assertion screenshot if explicitly disabled
        const config = CSConfigurationManager.getInstance();
        const capturePreScreenshot = config.getBoolean('PRE_ASSERTION_SCREENSHOT', true);

        let preScreenshot: string | undefined = undefined;
        if (capturePreScreenshot) {
            // ALWAYS capture screenshot BEFORE trying the assertion to ensure we get the current state
            // This is critical for scenarios where the page might change after assertion failure
            preScreenshot = await this.capturePreAssertionScreenshot(`pre-assertion-${description}`);
        }

        try {
            // Try the assertion
            const result = await assertion();
            CSReporter.pass(`Assertion passed: ${description}`);
            // Delete the pre-screenshot if assertion passes and we're not in always mode
            const config = CSConfigurationManager.getInstance();
            const captureMode = config.get('SCREENSHOT_CAPTURE_MODE', 'on-failure').toLowerCase();
            if (captureMode !== 'always' && captureMode !== 'debug' && preScreenshot) {
                // Optionally delete the screenshot file if not needed
                try {
                    const fs = require('fs');
                    if (fs.existsSync(preScreenshot)) {
                        fs.unlinkSync(preScreenshot);
                    }
                } catch {
                    // Ignore deletion errors
                }
            }
            return result;
        } catch (error: any) {
            // Use the pre-captured screenshot
            let screenshotFile = preScreenshot;

            // Try to highlight the element if provided (after screenshot)
            if (element) {
                try {
                    await element.evaluate((el: any) => {
                        el.style.border = '3px solid red';
                        el.style.backgroundColor = 'rgba(255, 0, 0, 0.1)';
                    }).catch(() => {});

                    // Take another screenshot with highlighted element if we can
                    if (screenshotFile) {
                        const highlightedScreenshot = await this.capturePreAssertionScreenshot(`${description}-highlighted`);
                        if (highlightedScreenshot) {
                            screenshotFile = highlightedScreenshot;
                        }
                    }
                } catch {
                    // Ignore highlighting errors
                }
            }

            const errorMessage = `Assertion failed: ${description} - ${error.message}`;

            if (this.softMode) {
                // In soft mode, store the failure and continue
                this.failedAssertions.push({
                    message: errorMessage,
                    screenshot: screenshotFile
                });
                CSReporter.warn(`Soft assertion failed: ${description}`);
                if (screenshotFile) {
                    CSReporter.info(`Screenshot saved: ${screenshotFile}`);
                }
                return undefined as any; // Continue execution
            } else {
                // In normal mode, report and throw
                CSReporter.error(errorMessage);
                if (screenshotFile) {
                    CSReporter.info(`Screenshot saved: ${screenshotFile}`);
                    // Make sure the screenshot is attached to the scenario context
                    this.scenarioContext.setCurrentStepScreenshot(screenshotFile);
                }
                throw error;
            }
        }
    }

    /**
     * Assert that an element is visible
     */
    public async toBeVisible(
        locator: Locator,
        options?: { timeout?: number; message?: string }
    ): Promise<void> {
        const description = options?.message || `Element to be visible`;
        const timeout = options?.timeout || 5000;

        await this.wrapAssertion(
            async () => {
                if (this.softMode) {
                    await playwrightExpect.soft(locator).toBeVisible({ timeout });
                } else {
                    await playwrightExpect(locator).toBeVisible({ timeout });
                }
            },
            description,
            locator
        );
    }

    /**
     * Assert that an element has specific text
     */
    public async toHaveText(
        locator: Locator,
        expected: string | RegExp,
        options?: { timeout?: number; message?: string }
    ): Promise<void> {
        const description = options?.message || `Element to have text: ${expected}`;
        const timeout = options?.timeout || 5000;

        await this.wrapAssertion(
            async () => {
                if (this.softMode) {
                    await playwrightExpect.soft(locator).toHaveText(expected, { timeout });
                } else {
                    await playwrightExpect(locator).toHaveText(expected, { timeout });
                }
            },
            description,
            locator
        );
    }

    /**
     * Assert that an element is enabled
     */
    public async toBeEnabled(
        locator: Locator,
        options?: { timeout?: number; message?: string }
    ): Promise<void> {
        const description = options?.message || `Element to be enabled`;
        const timeout = options?.timeout || 5000;

        await this.wrapAssertion(
            async () => {
                if (this.softMode) {
                    await playwrightExpect.soft(locator).toBeEnabled({ timeout });
                } else {
                    await playwrightExpect(locator).toBeEnabled({ timeout });
                }
            },
            description,
            locator
        );
    }

    /**
     * Assert that a value equals expected
     */
    public async toEqual<T>(
        actual: T,
        expected: T,
        message?: string
    ): Promise<void> {
        const description = message || `Value to equal: ${expected}`;

        await this.wrapAssertion(
            async () => {
                if (actual !== expected) {
                    throw new Error(`Expected ${expected} but got ${actual}`);
                }
            },
            description
        );
    }

    /**
     * Assert that a value is truthy
     */
    public async toBeTruthy(
        actual: any,
        message?: string
    ): Promise<void> {
        const description = message || `Value to be truthy`;

        await this.wrapAssertion(
            async () => {
                if (!actual) {
                    throw new Error(`Expected value to be truthy but got ${actual}`);
                }
            },
            description
        );
    }

    /**
     * Assert that a value is falsy
     */
    public async toBeFalsy(
        actual: any,
        message?: string
    ): Promise<void> {
        const description = message || `Value to be falsy`;

        await this.wrapAssertion(
            async () => {
                if (actual) {
                    throw new Error(`Expected value to be falsy but got ${actual}`);
                }
            },
            description
        );
    }

    /**
     * Assert that a value contains expected
     */
    public async toContain(
        actual: string | any[],
        expected: any,
        message?: string
    ): Promise<void> {
        const description = message || `Value to contain: ${expected}`;

        await this.wrapAssertion(
            async () => {
                const contains = Array.isArray(actual)
                    ? actual.includes(expected)
                    : actual.includes(expected);
                if (!contains) {
                    throw new Error(`Expected to contain ${expected} but got ${actual}`);
                }
            },
            description
        );
    }

    /**
     * Assert with custom retry logic
     */
    public async toPass(
        assertion: () => Promise<void>,
        options?: { timeout?: number; intervals?: number[]; message?: string }
    ): Promise<void> {
        const description = options?.message || `Custom assertion to pass`;
        const timeout = options?.timeout || 10000;

        await this.wrapAssertion(
            async () => {
                await playwrightExpect(assertion).toPass({
                    timeout,
                    intervals: options?.intervals
                });
            },
            description
        );
    }

    /**
     * Poll for a condition to be true
     */
    public async poll(
        fn: () => any,
        options?: { timeout?: number; intervals?: number[]; message?: string }
    ): Promise<void> {
        const description = options?.message || `Polling condition`;
        const timeout = options?.timeout || 10000;

        await this.wrapAssertion(
            async () => {
                await playwrightExpect.poll(fn, {
                    timeout,
                    intervals: options?.intervals
                }).toBeTruthy();
            },
            description
        );
    }

    /**
     * Get assertion statistics
     */
    public getStats(): { total: number; failed: number } {
        return {
            total: this.assertionCount,
            failed: this.failedAssertions.length
        };
    }

    /**
     * Reset assertion counters
     */
    public reset(): void {
        this.assertionCount = 0;
        this.failedAssertions = [];
        this.softMode = false;
    }
}

// Export singleton instance for convenience
export const csExpect = CSExpect.getInstance();

// Export helper function for easy use
export function expect(): CSExpect {
    return CSExpect.getInstance();
}