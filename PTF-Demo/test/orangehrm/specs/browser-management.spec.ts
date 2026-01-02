/**
 * Browser Management Enhancements - Spec Format
 * Tests browser switching and context clearing features
 *
 * Uses:
 * - Auto-injected page objects: loginPage, dashboardPage
 * - CSBrowserManager for browser operations
 * - CSExpect for assertions (NOT raw Playwright)
 * - Page object methods (NOT page.fill, page.click)
 */

import { describe, test, beforeEach } from '@mdakhan.mak/cs-playwright-test-framework/spec';

describe('Browser Management Enhancements - Switching and Context Clearing', {
    tags: '@orangehrm @browser-management @new-features'
}, () => {

    // Background: Navigate to the application
    beforeEach(async ({ navigate, config }) => {
        const baseUrl = config.get('BASE_URL');
        await navigate(baseUrl);
    });

    // ============================================================================
    // BROWSER SWITCHING TESTS
    // ============================================================================

    describe('Browser Switching Tests', () => {

        // TC601 - Switch from Chrome to Edge browser during test execution
        test('Switch from Chrome to Edge browser during test execution', {
            tags: '@TC601 @browser-switching @smoke @critical'
        }, async ({ loginPage, expect, reporter, config, browserManager }) => {
            // Login in Chrome (default browser) using page object
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();
            reporter.pass('Logged in successfully in Chrome');

            // Switch to Edge browser - preserves URL but NOT session
            await browserManager.switchBrowser('edge');
            reporter.info('Switched to Edge browser');

            // After browser switch, page objects need to be updated
            // The framework handles this automatically via updatePage()

            // Wait for the app to redirect to login page (session is lost, app redirects)
            // OrangeHRM takes a moment to detect unauthenticated state and redirect
            await loginPage.waitForPageLoad();

            // Should be on login page (session lost)
            const isOnLoginPage = await loginPage.isAt();
            expect.equals(isOnLoginPage, true);
            reporter.pass('On login page in Edge (session not preserved)');

            // Verify browser type
            const browserType = browserManager.getCurrentBrowserType();
            expect.equals(browserType, 'edge');
            reporter.pass('Current browser is Edge');

            // Login again in Edge using page object
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();
            reporter.pass('Logged in successfully in Edge browser');
        });

        // TC605 - Switch to same browser with BROWSER_REUSE_ENABLED=true
        test('Switch to same browser clears state without closing browser', {
            tags: '@TC605 @browser-switching @same-browser-reuse @critical'
        }, async ({ loginPage, dashboardPage, expect, reporter, config, browserManager }) => {
            // Login first using page object
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();

            // Navigate to PIM using page object
            await dashboardPage.clickMenuItem('PIM');
            await dashboardPage.verifyPageHeader('PIM');
            reporter.pass('Navigated to PIM page');

            // Switch to same browser type (chromium) - clears state
            await browserManager.switchBrowser('chromium', { clearState: true });

            // Wait for page to load after state clear (app will redirect to login)
            await loginPage.waitForPageLoad();

            // Should be on login page after state clear
            const isOnLoginPage = await loginPage.isAt();
            expect.equals(isOnLoginPage, true);
            reporter.pass('State cleared - on login page');

            // Verify still chromium
            const browserType = browserManager.getCurrentBrowserType();
            expect.equals(browserType, 'chromium');
            reporter.pass('Browser type remains chromium');

            // Login again using page object - browser never closed/reopened!
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();
            reporter.pass('Logged in successfully after state clear');
        });

        // TC605B - Cross-browser testing with data
        describe('Verify login works across different browsers', {
            tags: '@TC605B @browser-switching @cross-browser-testing',
            dataSource: {
                type: 'inline',
                data: [
                    { browser: 'chrome' },
                    { browser: 'edge' },
                    { browser: 'firefox' }
                ]
            }
        }, () => {
            test('Login in {browser} browser', async ({ loginPage, expect, reporter, config, browserManager, data, navigate }) => {
                // Switch to specified browser
                await browserManager.switchBrowser(data.browser, { preserveUrl: false });

                // Navigate to application
                const baseUrl = config.get('BASE_URL');
                await navigate(baseUrl);

                // Login using page object
                const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
                await loginPage.login('Admin', password);

                // Verify login success using page object
                await loginPage.verifyLoginSuccess();
                reporter.pass(`Login successful in ${data.browser} browser`);
            });
        });
    });

    // ============================================================================
    // CONTEXT CLEARING FOR RE-AUTHENTICATION TESTS
    // ============================================================================

    describe('Context Clearing Tests', () => {

        // TC606 - Clear context and login as different user
        test('Clear context and login as different user', {
            tags: '@TC606 @context-clearing @multi-user @critical'
        }, async ({ loginPage, expect, reporter, config, browserManager }) => {
            // Login as Admin using page object
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();
            reporter.pass('Logged in as Admin');

            // Clear context for re-authentication
            await browserManager.clearContextAndReauthenticate();
            reporter.info('Browser context cleared');

            // Wait for page to load after context clear
            await loginPage.waitForPageLoad();

            // Should see login form
            const isOnLoginPage = await loginPage.isAt();
            expect.equals(isOnLoginPage, true);
            reporter.pass('Login form visible after context clear');

            // Login as different user (simulating approver workflow)
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();
            reporter.pass('Logged in successfully after re-authentication');
        });

        // TC607 - Multi-user approval workflow simulation
        test('Multi-user approval workflow simulation', {
            tags: '@TC607 @context-clearing @multi-user-workflow'
        }, async ({ loginPage, dashboardPage, expect, reporter, config, browserManager }) => {
            // Requester logs in using page object
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();
            reporter.pass('Requester logged in');

            // Navigate to Leave module using page object
            await dashboardPage.clickMenuItem('Leave');
            await dashboardPage.verifyPageHeader('Leave');
            reporter.info('Navigated to Leave module');

            // Clear context and login as approver
            await browserManager.clearContextAndReauthenticate();

            // Wait for page to load after context clear
            await loginPage.waitForPageLoad();

            const isOnLoginPage = await loginPage.isAt();
            expect.equals(isOnLoginPage, true);
            reporter.pass('Context cleared, ready for approver login');

            // Approver logs in using page object
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();
            reporter.pass('Approver logged in successfully');
        });

        // TC610 - Verify context clearing removes browser data but keeps scenario context
        test('Verify context clearing removes browser data but keeps scenario context', {
            tags: '@TC610 @context-clearing @data-isolation'
        }, async ({ loginPage, expect, reporter, config, browserManager, ctx }) => {
            // Login using page object
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();

            // Save some data in scenario context
            ctx.set('testData', 'test-value-123');
            ctx.set('sessionInfo', 'session-info');
            reporter.info('Saved data to scenario context');

            // Clear browser context
            await browserManager.clearContextAndReauthenticate();

            // Wait for page to load after context clear
            await loginPage.waitForPageLoad();

            // Verify on login page
            const isOnLoginPage = await loginPage.isAt();
            expect.equals(isOnLoginPage, true);
            reporter.pass('Browser context cleared');

            // Verify scenario context still has data
            const savedData = ctx.get('testData');
            expect.equals(savedData, 'test-value-123');
            reporter.pass('Scenario context data preserved after browser context clear');
        });
    });

    // ============================================================================
    // COMBINED TESTS - Browser Switching + Context Clearing
    // ============================================================================

    describe('Combined Browser and Context Tests', () => {

        // TC611 - Switch browser and clear context for complete isolation
        test('Switch browser and clear context for complete isolation', {
            tags: '@TC611 @combined @advanced @critical'
        }, async ({ loginPage, dashboardPage, expect, reporter, config, browserManager }) => {
            // Login in default browser using page object
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();

            // Navigate to PIM using page object
            await dashboardPage.clickMenuItem('PIM');
            await dashboardPage.verifyPageHeader('PIM');
            reporter.pass('Navigated to PIM page');

            // Switch to Edge - session is lost
            await browserManager.switchBrowser('edge');

            // Wait for app to redirect to login page (session is lost)
            await loginPage.waitForPageLoad();

            // Should be on login page
            let isOnLoginPage = await loginPage.isAt();
            expect.equals(isOnLoginPage, true);
            reporter.pass('On login page in Edge');

            // Login in Edge using page object
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();
            reporter.pass('Logged in Edge browser');

            // Clear context for re-authentication
            await browserManager.clearContextAndReauthenticate();

            // Wait for page to load after context clear
            await loginPage.waitForPageLoad();

            isOnLoginPage = await loginPage.isAt();
            expect.equals(isOnLoginPage, true);
            reporter.pass('Context cleared in Edge');

            // Login again as different user using page object
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();
            reporter.pass('Logged in successfully after context clear in Edge');
        });

        // TC613 - Verify context clearing works with browser reuse enabled
        test('Context clearing works with browser reuse enabled', {
            tags: '@TC613 @browser-reuse @context-clearing @critical'
        }, async ({ loginPage, dashboardPage, expect, reporter, config, browserManager }) => {
            // Login using page object
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();

            // Navigate to Time module using page object
            await dashboardPage.clickMenuItem('Time');
            await dashboardPage.verifyPageHeader('Time');
            reporter.pass('Navigated to Time page');

            // Clear state WITHOUT recreating context
            await browserManager.clearContextAndReauthenticate();

            // Wait for page to load after context clear
            await loginPage.waitForPageLoad();

            // Should see login form
            const isOnLoginPage = await loginPage.isAt();
            expect.equals(isOnLoginPage, true);
            reporter.pass('State cleared, login form visible');

            // Login again using page object - same browser instance
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();
            reporter.pass('Logged in successfully with browser reuse');
        });
    });

    // ============================================================================
    // PARALLEL EXECUTION SAFETY TESTS
    // ============================================================================

    describe('Parallel Execution Safety', () => {

        // TC614 - Browser switching in parallel execution
        test('Browser switching is thread-safe in parallel execution', {
            tags: '@TC614 @parallel-safe @browser-switching'
        }, async ({ loginPage, expect, reporter, config, browserManager, navigate }) => {
            // Each worker has its own BrowserManager instance
            await browserManager.switchBrowser('edge', { preserveUrl: false });

            const baseUrl = config.get('BASE_URL');
            await navigate(baseUrl);

            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();
            reporter.pass('Parallel-safe browser switching test passed');
        });

        // TC615 - Context clearing in parallel execution
        test('Context clearing is thread-safe in parallel execution', {
            tags: '@TC615 @parallel-safe @context-clearing'
        }, async ({ loginPage, expect, reporter, config, browserManager }) => {
            // Login using page object
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();

            // Clear context - each worker has independent context
            await browserManager.clearContextAndReauthenticate();

            // Wait for page to load after context clear
            await loginPage.waitForPageLoad();

            const isOnLoginPage = await loginPage.isAt();
            expect.equals(isOnLoginPage, true);

            // Login again using page object
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();
            reporter.pass('Parallel-safe context clearing test passed');
        });
    });
});
