import { Page, Locator } from '@playwright/test';
import { CSReporter } from '../reporter/CSReporter';
import { CSBrowserManager } from '../browser/CSBrowserManager';
import { CSTestResultsManager } from '../reporter/CSTestResultsManager';
import { CSScenarioContext } from '../bdd/CSScenarioContext';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Custom Assert class for CS Framework
 * Provides direct assertions with screenshot capture BEFORE throwing errors
 * This ensures screenshots are taken while the page is still valid
 */
export class CSAssert {
    private static instance: CSAssert;
    private browserManager: CSBrowserManager;
    private resultsManager: CSTestResultsManager;
    private scenarioContext: CSScenarioContext;

    private constructor() {
        this.browserManager = CSBrowserManager.getInstance();
        this.resultsManager = CSTestResultsManager.getInstance();
        this.scenarioContext = CSScenarioContext.getInstance();
    }

    public static getInstance(): CSAssert {
        if (!CSAssert.instance) {
            CSAssert.instance = new CSAssert();
        }
        return CSAssert.instance;
    }

    /**
     * Take screenshot before assertion failure
     */
    private async captureScreenshot(testName: string): Promise<string | undefined> {
        try {
            const page = this.browserManager.getPage();

            // Critical: Check if page is valid BEFORE taking screenshot
            if (!page) {
                CSReporter.warn('No page available for screenshot');
                return undefined;
            }

            if (page.isClosed()) {
                CSReporter.warn('Page is already closed - cannot take screenshot');
                return undefined;
            }

            // Get current URL for debugging
            const currentUrl = page.url();
            CSReporter.debug(`Taking assertion screenshot at URL: ${currentUrl}`);

            const dirs = this.resultsManager.getDirectories();
            const screenshotDir = dirs.screenshots;

            if (!fs.existsSync(screenshotDir)) {
                fs.mkdirSync(screenshotDir, { recursive: true });
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `assert-fail-${testName.replace(/[^a-zA-Z0-9]/g, '-')}-${timestamp}.png`;
            const screenshotPath = path.join(screenshotDir, filename);

            // Take screenshot immediately
            await page.screenshot({
                path: screenshotPath,
                fullPage: false,
                timeout: 3000 // Short timeout to avoid hanging
            });

            // Add screenshot to current step so it appears in step details
            this.scenarioContext.setCurrentStepScreenshot(screenshotPath);
            // Also add to general screenshots collection
            this.scenarioContext.addScreenshot(screenshotPath, 'assertion-failure');

            CSReporter.info(`Assertion failure screenshot saved: ${filename}`);
            return screenshotPath;
        } catch (error) {
            CSReporter.error(`Failed to capture assertion screenshot: ${error}`);
            return undefined;
        }
    }

    /**
     * Assert that a condition is true
     * For async conditions that need evaluation, use assertTrueAsync
     */
    public async assertTrue(
        condition: boolean,
        message: string = 'Assertion failed'
    ): Promise<void> {
        if (!condition) {
            // Take screenshot FIRST, before throwing
            await this.captureScreenshot(`assertTrue-${message}`);

            CSReporter.fail(`Assert True Failed: ${message}`);
            throw new Error(`Assert True Failed: ${message}`);
        }
        CSReporter.pass(`Assert True Passed: ${message}`);
    }

    /**
     * Assert with screenshot captured BEFORE condition evaluation
     * Use this when the condition check itself might affect page state
     */
    public async assertWithScreenshot<T>(
        conditionFn: () => Promise<T> | T,
        validator: (result: T) => boolean,
        message: string = 'Assertion failed'
    ): Promise<T> {
        // Capture screenshot BEFORE evaluating condition
        const screenshotPath = await this.captureScreenshot(`pre-check-${message}`);

        try {
            const result = await conditionFn();
            const isValid = validator(result);

            if (!isValid) {
                CSReporter.fail(`Assert Failed: ${message}`);
                throw new Error(`Assert Failed: ${message}`);
            }

            // If assertion passed, remove the pre-captured screenshot
            if (screenshotPath) {
                try {
                    fs.unlinkSync(screenshotPath);
                    CSReporter.debug('Removed pre-check screenshot as assertion passed');
                } catch {
                    // Ignore if can't delete
                }
            }

            CSReporter.pass(`Assert Passed: ${message}`);
            return result;
        } catch (error: any) {
            // Screenshot already captured, just re-throw
            throw error;
        }
    }

    /**
     * Assert that a condition is false
     */
    public async assertFalse(
        condition: boolean,
        message: string = 'Assertion failed'
    ): Promise<void> {
        if (condition) {
            // Take screenshot FIRST, before throwing
            await this.captureScreenshot(`assertFalse-${message}`);

            CSReporter.fail(`Assert False Failed: ${message}`);
            throw new Error(`Assert False Failed: ${message}`);
        }
        CSReporter.pass(`Assert False Passed: ${message}`);
    }

    /**
     * Assert that two values are equal
     */
    public async assertEqual(
        actual: any,
        expected: any,
        message?: string
    ): Promise<void> {
        const msg = message || `Expected ${expected} but got ${actual}`;

        if (actual !== expected) {
            // Take screenshot FIRST, before throwing
            await this.captureScreenshot(`assertEqual-${msg}`);

            CSReporter.fail(`Assert Equal Failed: ${msg}`);
            throw new Error(`Assert Equal Failed: ${msg}`);
        }
        CSReporter.pass(`Assert Equal Passed: ${msg}`);
    }

    /**
     * Assert that two values are not equal
     */
    public async assertNotEqual(
        actual: any,
        notExpected: any,
        message?: string
    ): Promise<void> {
        const msg = message || `Expected not to be ${notExpected}`;

        if (actual === notExpected) {
            // Take screenshot FIRST, before throwing
            await this.captureScreenshot(`assertNotEqual-${msg}`);

            CSReporter.fail(`Assert Not Equal Failed: ${msg}`);
            throw new Error(`Assert Not Equal Failed: ${msg}`);
        }
        CSReporter.pass(`Assert Not Equal Passed: ${msg}`);
    }

    /**
     * Assert that a value contains expected substring/element
     */
    public async assertContains(
        haystack: string | any[],
        needle: any,
        message?: string
    ): Promise<void> {
        const msg = message || `Expected to contain ${needle}`;
        const contains = Array.isArray(haystack)
            ? haystack.includes(needle)
            : haystack.includes(needle);

        if (!contains) {
            // Take screenshot FIRST, before throwing
            await this.captureScreenshot(`assertContains-${msg}`);

            CSReporter.fail(`Assert Contains Failed: ${msg}`);
            throw new Error(`Assert Contains Failed: ${msg}`);
        }
        CSReporter.pass(`Assert Contains Passed: ${msg}`);
    }

    /**
     * Assert that an element is visible on the page
     */
    public async assertVisible(
        locator: Locator | string,
        message?: string
    ): Promise<void> {
        const page = this.browserManager.getPage();
        if (!page || page.isClosed()) {
            throw new Error('Page is not available for assertion');
        }

        const msg = message || `Element should be visible`;

        try {
            const element = typeof locator === 'string' ? page.locator(locator) : locator;
            const isVisible = await element.isVisible({ timeout: 5000 });

            if (!isVisible) {
                // Take screenshot FIRST, before throwing
                await this.captureScreenshot(`assertVisible-${msg}`);

                CSReporter.fail(`Assert Visible Failed: ${msg}`);
                throw new Error(`Assert Visible Failed: ${msg}`);
            }
            CSReporter.pass(`Assert Visible Passed: ${msg}`);
        } catch (error: any) {
            // Take screenshot on any error
            await this.captureScreenshot(`assertVisible-error-${msg}`);

            CSReporter.fail(`Assert Visible Failed: ${msg} - ${error.message}`);
            throw error;
        }
    }

    /**
     * Assert that an element is not visible on the page
     */
    public async assertNotVisible(
        locator: Locator | string,
        message?: string
    ): Promise<void> {
        const page = this.browserManager.getPage();
        if (!page || page.isClosed()) {
            throw new Error('Page is not available for assertion');
        }

        const msg = message || `Element should not be visible`;

        try {
            const element = typeof locator === 'string' ? page.locator(locator) : locator;
            const isVisible = await element.isVisible({ timeout: 1000 }).catch(() => false);

            if (isVisible) {
                // Take screenshot FIRST, before throwing
                await this.captureScreenshot(`assertNotVisible-${msg}`);

                CSReporter.fail(`Assert Not Visible Failed: ${msg}`);
                throw new Error(`Assert Not Visible Failed: ${msg}`);
            }
            CSReporter.pass(`Assert Not Visible Passed: ${msg}`);
        } catch (error: any) {
            // Take screenshot on any error
            await this.captureScreenshot(`assertNotVisible-error-${msg}`);

            CSReporter.fail(`Assert Not Visible Failed: ${msg} - ${error.message}`);
            throw error;
        }
    }

    /**
     * Assert that element has specific text
     */
    public async assertText(
        locator: Locator | string,
        expectedText: string | RegExp,
        message?: string
    ): Promise<void> {
        const page = this.browserManager.getPage();
        if (!page || page.isClosed()) {
            throw new Error('Page is not available for assertion');
        }

        const msg = message || `Element should have text: ${expectedText}`;

        try {
            const element = typeof locator === 'string' ? page.locator(locator) : locator;
            const actualText = await element.textContent({ timeout: 5000 });

            const matches = expectedText instanceof RegExp
                ? expectedText.test(actualText || '')
                : actualText === expectedText;

            if (!matches) {
                // Take screenshot FIRST, before throwing
                await this.captureScreenshot(`assertText-${msg}`);

                CSReporter.fail(`Assert Text Failed: ${msg}. Actual: "${actualText}"`);
                throw new Error(`Assert Text Failed: ${msg}. Actual: "${actualText}"`);
            }
            CSReporter.pass(`Assert Text Passed: ${msg}`);
        } catch (error: any) {
            // Take screenshot on any error
            await this.captureScreenshot(`assertText-error-${msg}`);

            CSReporter.fail(`Assert Text Failed: ${msg} - ${error.message}`);
            throw error;
        }
    }

    /**
     * Assert that page URL matches expected
     */
    public async assertUrl(
        expected: string | RegExp,
        message?: string
    ): Promise<void> {
        const page = this.browserManager.getPage();
        if (!page || page.isClosed()) {
            throw new Error('Page is not available for assertion');
        }

        const actualUrl = page.url();
        const msg = message || `URL should match: ${expected}`;

        const matches = expected instanceof RegExp
            ? expected.test(actualUrl)
            : actualUrl.includes(expected.toString());

        if (!matches) {
            // Take screenshot FIRST, before throwing
            await this.captureScreenshot(`assertUrl-${msg}`);

            CSReporter.fail(`Assert URL Failed: ${msg}. Actual: "${actualUrl}"`);
            throw new Error(`Assert URL Failed: ${msg}. Actual: "${actualUrl}"`);
        }
        CSReporter.pass(`Assert URL Passed: ${msg}`);
    }

    /**
     * Assert that page title matches expected
     */
    public async assertTitle(
        expected: string | RegExp,
        message?: string
    ): Promise<void> {
        const page = this.browserManager.getPage();
        if (!page || page.isClosed()) {
            throw new Error('Page is not available for assertion');
        }

        const actualTitle = await page.title();
        const msg = message || `Title should match: ${expected}`;

        const matches = expected instanceof RegExp
            ? expected.test(actualTitle)
            : actualTitle === expected;

        if (!matches) {
            // Take screenshot FIRST, before throwing
            await this.captureScreenshot(`assertTitle-${msg}`);

            CSReporter.fail(`Assert Title Failed: ${msg}. Actual: "${actualTitle}"`);
            throw new Error(`Assert Title Failed: ${msg}. Actual: "${actualTitle}"`);
        }
        CSReporter.pass(`Assert Title Passed: ${msg}`);
    }

    /**
     * Soft assert - captures screenshot but doesn't throw immediately
     * Collects all failures and can be checked later
     */
    private softAssertions: Array<{ message: string; screenshot?: string }> = [];

    public async softAssert(
        condition: boolean,
        message: string = 'Soft assertion failed'
    ): Promise<void> {
        if (!condition) {
            const screenshot = await this.captureScreenshot(`soft-${message}`);
            this.softAssertions.push({ message, screenshot });
            CSReporter.warn(`Soft Assert Failed: ${message}`);
        } else {
            CSReporter.debug(`Soft Assert Passed: ${message}`);
        }
    }

    /**
     * Check all soft assertions and fail if any failed
     */
    public async assertAllSoft(): Promise<void> {
        if (this.softAssertions.length > 0) {
            const failures = this.softAssertions.map(f => f.message).join('\n');
            this.softAssertions = []; // Clear for next test

            CSReporter.fail(`${this.softAssertions.length} soft assertions failed:\n${failures}`);
            throw new Error(`Soft assertions failed:\n${failures}`);
        }
        CSReporter.pass('All soft assertions passed');
    }

    /**
     * Clear soft assertions
     */
    public clearSoftAssertions(): void {
        this.softAssertions = [];
    }
}

// Export singleton instance
export const csAssert = CSAssert.getInstance();

// Export convenience function
export function assert(): CSAssert {
    return CSAssert.getInstance();
}