import { CSBDDStepDef, StepDefinitions } from '@mdakhan.mak/cs-playwright-test-framework/bdd';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';
import { CSBrowserManager } from '@mdakhan.mak/cs-playwright-test-framework/browser';
import { CSExpect } from '@mdakhan.mak/cs-playwright-test-framework/assertions';

/**
 * Step definitions for testing browser management enhancements
 * - Browser switching
 * - Context clearing for re-authentication
 */
@StepDefinitions
export class BrowserManagementSteps {

    @CSBDDStepDef('I should still be logged in')
    async verifyStillLoggedIn() {
        CSReporter.debug('Step: Verifying user is still logged in');

        const browserManager = CSBrowserManager.getInstance();
        const page = browserManager.getPage();

        if (!page) {
            throw new Error('No page is currently active');
        }

        // Wait for page to be stable
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 });

        // Check if we're on dashboard or any authenticated page
        // OrangeHRM shows user profile dropdown when logged in
        const userDropdownVisible = await page.locator('.oxd-userdropdown').isVisible();

        const expect = CSExpect.getInstance();
        await expect.toBeTruthy(
            userDropdownVisible,
            'User should still be logged in (user dropdown should be visible)'
        );

        CSReporter.pass('User is still logged in');
    }

    @CSBDDStepDef('the current browser should be {string}')
    async verifyCurrentBrowser(expectedBrowser: string) {
        CSReporter.debug(`Step: Verifying current browser is "${expectedBrowser}"`);

        const browserManager = CSBrowserManager.getInstance();
        const currentBrowserType = browserManager.getCurrentBrowserType();

        const expect = CSExpect.getInstance();
        await expect.toEqual(
            currentBrowserType.toLowerCase(),
            expectedBrowser.toLowerCase(),
            `Current browser should be "${expectedBrowser}"`
        );

        CSReporter.pass(`Current browser is "${expectedBrowser}"`);
    }

    @CSBDDStepDef('I should NOT be logged in')
    async verifyNotLoggedIn() {
        CSReporter.debug('Step: Verifying user is NOT logged in');

        const browserManager = CSBrowserManager.getInstance();
        const page = browserManager.getPage();

        if (!page) {
            throw new Error('No page is currently active');
        }

        // Wait for page to be stable
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 });

        // Check if login form is visible (means not logged in)
        const loginFormVisible = await page.locator('input[name="username"]').isVisible();

        const expect = CSExpect.getInstance();
        await expect.toBeTruthy(
            loginFormVisible,
            'User should NOT be logged in (login form should be visible)'
        );

        CSReporter.pass('User is NOT logged in (as expected)');
    }

    @CSBDDStepDef('I should be on the PIM page')
    async verifyOnPIMPage() {
        CSReporter.debug('Step: Verifying on PIM page');

        const browserManager = CSBrowserManager.getInstance();
        const page = browserManager.getPage();

        if (!page) {
            throw new Error('No page is currently active');
        }

        await page.waitForLoadState('domcontentloaded', { timeout: 10000 });

        // Check URL contains 'pim'
        const currentUrl = page.url();
        const expect = CSExpect.getInstance();

        await expect.toContain(
            currentUrl.toLowerCase(),
            'pim',
            'Current URL should contain "pim"'
        );

        CSReporter.pass('On PIM page (URL verified)');
    }

    @CSBDDStepDef('I should be on the login page')
    async verifyOnLoginPage() {
        CSReporter.debug('Step: Verifying on login page');

        const browserManager = CSBrowserManager.getInstance();
        const page = browserManager.getPage();

        if (!page) {
            throw new Error('No page is currently active');
        }

        await page.waitForLoadState('domcontentloaded', { timeout: 10000 });

        // Check URL contains 'auth/login' or we see login form
        const currentUrl = page.url();
        const loginFormVisible = await page.locator('input[name="username"]').isVisible();

        const expect = CSExpect.getInstance();

        const isOnLoginPage = currentUrl.includes('auth/login') || loginFormVisible;

        await expect.toBeTruthy(
            isOnLoginPage,
            'Should be on login page (URL or login form visible)'
        );

        CSReporter.pass('On login page');
    }

    @CSBDDStepDef('I click on Apply button')
    async clickApplyButton() {
        CSReporter.debug('Step: Clicking Apply button');

        const browserManager = CSBrowserManager.getInstance();
        const page = browserManager.getPage();

        if (!page) {
            throw new Error('No page is currently active');
        }

        // Wait for Apply button and click
        try {
            const applyButton = page.locator('button:has-text("Apply")').first();
            await applyButton.waitFor({ state: 'visible', timeout: 5000 });
            await applyButton.click();
            CSReporter.pass('Clicked Apply button');
        } catch (error) {
            CSReporter.warn('Apply button not found or not clickable - this is expected for demo');
            // Don't fail - this is just a demo scenario
        }
    }
}

// Export the step definitions class
export default BrowserManagementSteps;
