/**
 * ADO Integration Example - Spec Format
 * Demonstrates Azure DevOps test case mapping with describe/it syntax
 *
 * Uses:
 * - Auto-injected page objects via @CSPage decorator
 * - CSExpect/CSAssert for assertions
 * - Page object methods (NOT raw Playwright APIs)
 */

import { describe, test, beforeEach } from '@mdakhan.mak/cs-playwright-test-framework/spec';

// Feature-level ADO tags applied to all tests
describe('Azure DevOps Integration Example', {
    tags: ['@ado-integration', '@TestPlanId:417', '@TestSuiteId:418']
}, () => {

    // Background: Navigate to the Orange HRM application
    beforeEach(async ({ navigate, config }) => {
        const baseUrl = config.get('BASE_URL');
        await navigate(baseUrl);
    });

    // @TestCaseId:419 @smoke @login
    test('Login with invalid credentials', {
        tags: ['@TestCaseId:419', '@smoke', '@login']
    }, async ({ loginPage, expect, reporter }) => {
        // loginPage is auto-injected via @CSPage('orangehrm-login') decorator

        // When I enter username "InvalidUser" and password "wrongpassword"
        await loginPage.enterUsername('InvalidUser');
        await loginPage.enterPassword('wrongpassword');

        // And I click on the Login button
        await loginPage.clickLoginButton();

        // Then I should see an error message "Invalid credentials"
        await loginPage.verifyErrorMessage('Invalid credentials');
        reporter.pass('Error message displayed for invalid credentials');

        // And I should remain on the login page
        await loginPage.verifyStillOnLoginPage();
        reporter.pass('User remained on login page');
    });

    // @TestCaseId:420 @regression @login
    test('User logout functionality', {
        tags: ['@TestCaseId:420', '@regression', '@login']
    }, async ({ loginPage, dashboardPage, expect, reporter, config }) => {
        // Given I am logged in to Orange HRM application
        const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
        await loginPage.login('Admin', password);
        await loginPage.verifyLoginSuccess();
        reporter.info('Logged in successfully');

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
        reporter.pass('Login form is visible');
    });

    // @TestPlanId:413 @TestSuiteId:414 @TestCaseId:{415,416} @smoke @high @critical
    test('Standard user login with valid credentials', {
        tags: ['@TestPlanId:413', '@TestSuiteId:414', '@TestCaseId:{415,416}', '@smoke', '@high', '@critical']
    }, async ({ loginPage, expect, reporter, config }) => {
        // When I enter username "Admin" and password from config
        const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
        await loginPage.enterUsername('Admin');
        await loginPage.enterPassword(password);

        // And I click on the Login button
        await loginPage.clickLoginButton();

        // Then I should be logged in successfully
        // And I should see the Dashboard page
        await loginPage.verifyLoginSuccess();
        reporter.pass('Dashboard page is visible');

        // And I should see the main navigation menu
        await loginPage.verifyNavigationMenu();
        reporter.pass('Navigation menu is visible');
    });
});

/*
 * ADO Integration Notes:
 *
 * Feature-level tags will be inherited by all tests
 * Use @TestPlanId and @TestSuiteId at describe level for common mapping
 * Use @TestCaseId at test level for specific test case mapping
 *
 * Supported tag formats:
 * - Single test case: @TestCaseId:419
 * - Multiple test cases: @TestCaseId:{419,420,421}
 */
