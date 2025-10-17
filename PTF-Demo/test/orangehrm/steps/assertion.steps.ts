import { CSBDDStepDef, StepDefinitions, Page } from '@mdakhan.mak/cs-playwright-test-framework/bdd';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';
import { CSBrowserManager } from '@mdakhan.mak/cs-playwright-test-framework/browser';
import { CSExpect } from '@mdakhan.mak/cs-playwright-test-framework/assertions';

@StepDefinitions
export class AssertionSteps {

    @CSBDDStepDef('I verify page title contains {string}')
    async verifyPageTitleContains(expectedTitle: string) {
        CSReporter.debug(`Step: Verifying page title contains "${expectedTitle}"`);

        // Get the current page from browser manager
        const browserManager = CSBrowserManager.getInstance();
        const page = browserManager.getPage();

        if (!page) {
            throw new Error('No page is currently active');
        }

        // Wait for page to be stable - following Playwright best practices
        try {
            await page.waitForLoadState('networkidle', { timeout: 5000 });
        } catch {
            CSReporter.debug('Network idle timeout - continuing anyway');
        }

        const actualTitle = await page.title();
        CSReporter.debug(`Actual page title: "${actualTitle}"`);

        // Use CSExpect which will automatically capture screenshots on failure
        const expect = CSExpect.getInstance();

        // This will fail and trigger screenshot capture automatically
        await expect.toContain(
            actualTitle,
            expectedTitle,
            `Page title should contain "${expectedTitle}"`
        );

        CSReporter.pass(`Page title contains "${expectedTitle}"`);
    }
}

// Export the step definitions class
export default AssertionSteps;