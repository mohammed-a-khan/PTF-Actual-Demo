/**
 * Orange HRM Login and Navigation - Spec Format
 * Tests login functionality and navigation features using CS Framework standards
 *
 * Uses:
 * - Auto-injected page objects: loginPage, dashboardPage
 * - CSExpect/CSAssert for assertions (NOT raw Playwright)
 * - Page object methods (NOT page.fill, page.click)
 */

import { describe, test, beforeEach } from '@mdakhan.mak/cs-playwright-test-framework/spec';

describe('Orange HRM Demo Site - Login and Navigation', {
    tags: ['@orangehrm', '@login', '@navigation', '@demo', '@TestPlanId:417', '@TestSuiteId:418']
}, () => {

    // Background: Navigate to the application before each test
    beforeEach(async ({ navigate, config }) => {
        const baseUrl = config.get('BASE_URL');
        await navigate(baseUrl);
    });

    // TC501 - Standard user login with valid credentials
    test('Standard user login with valid credentials', {
        tags: ['@TC501', '@smoke', '@high', '@critical', '@TestCaseId:419']
    }, async ({ loginPage, expect, reporter, config }) => {
        // When I enter username and password using page object
        const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
        await loginPage.enterUsername('Admin123');
        await loginPage.enterPassword(password);

        // And I click on the Login button
        await loginPage.clickLoginButton();

        // Then I should be logged in successfully
        // And I should see the Dashboard page
        await loginPage.verifyLoginSuccess();
        reporter.pass('Dashboard page is visible - Login successful');

        // And I should see the main navigation menu
        await loginPage.verifyNavigationMenu();
        reporter.pass('Navigation menu is visible');
    });

    // TC502 - Verify main menu navigation items are visible
    test('Verify main menu navigation items are visible', {
        tags: ['@TC502', '@regression', '@medium', '@TestCaseId:420']
    }, async ({ loginPage, dashboardPage, expect, reporter, config }) => {
        // Given I am logged in using page object method
        const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
        await loginPage.login('Admin', password);
        await loginPage.verifyLoginSuccess();

        // Then I should see all menu items using page object
        await dashboardPage.verifyAllMenuItemsVisible();
        reporter.pass('All navigation menu items verified');
    });

    // TC503 - Verify navigation to each module using data-driven approach
    describe('Verify navigation to each module', {
        tags: ['@TC503', '@regression', '@medium', '@TestPlanId:413', '@TestSuiteId:414', '@TestCaseId:{415,416}'],
        dataSource: {
            type: 'inline',
            data: [
                { moduleName: 'Admin', expectedHeader: 'Admin', urlFragment: 'admin' },
                { moduleName: 'PIM', expectedHeader: 'PIM', urlFragment: 'pim1' },
                { moduleName: 'Leave', expectedHeader: 'Leave', urlFragment: 'leave' },
                { moduleName: 'Time', expectedHeader: 'Time', urlFragment: 'time' },
                { moduleName: 'Recruitment', expectedHeader: 'Recruitment', urlFragment: 'recruitment' }
            ]
        }
    }, () => {
        test('Navigate to {moduleName} module', async ({ loginPage, dashboardPage, expect, reporter, config, data }) => {
            // Given I am logged in
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();

            // When I click on menu item using page object
            await dashboardPage.clickMenuItem(data.moduleName);

            // Then I should see the page header
            await dashboardPage.verifyPageHeader(data.expectedHeader);
            reporter.pass(`Page header shows: ${data.expectedHeader}`);

            // And the URL should contain the fragment
            await dashboardPage.verifyUrlContains(data.urlFragment);
            reporter.pass(`URL contains: ${data.urlFragment}`);
        });
    });

    // TC504 - Login with invalid credentials
    test('Login with invalid credentials', {
        tags: ['@TC504', '@negative', '@security']
    }, async ({ loginPage, expect, reporter }) => {
        // When I enter invalid credentials using page object
        await loginPage.enterUsername('InvalidUser');
        await loginPage.enterPassword('wrongpassword');

        // And I click on the Login button
        await loginPage.clickLoginButton();

        // Then I should see an error message
        await loginPage.verifyErrorMessage('Invalid credentials');
        reporter.pass('Error message displayed for invalid credentials');

        // And I should remain on the login page
        await loginPage.verifyStillOnLoginPage();
        reporter.pass('User remained on login page');
    });

    // TC505 - User logout functionality
    test('User logout functionality', {
        tags: ['@TC505', '@smoke', '@logout']
    }, async ({ loginPage, dashboardPage, expect, reporter, config }) => {
        // Given I am logged in using page object
        const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
        await loginPage.login('Admin', password);
        await loginPage.verifyLoginSuccess();

        // When I click on user profile dropdown
        await dashboardPage.clickUserProfileDropdown();

        // And I click on Logout option
        await dashboardPage.clickLogoutOption();

        // Then I should be redirected to login page
        await dashboardPage.verifyRedirectToLogin();
        reporter.pass('Redirected to login page');

        // And I should see the login form
        const isOnLoginPage = await loginPage.isAt();
        expect.toEqual(isOnLoginPage, true);
        reporter.pass('Login form is visible after logout');
    });
});
