/**
 * Test Dependencies & Workflow Demo - Spec Format
 * Demonstrates:
 * 1. dependsOn option - explicit test dependencies
 * 2. describe.workflow - chained test steps with cleanup
 */

import { describe, test, beforeEach } from '@mdakhan.mak/cs-playwright-test-framework/spec';

describe('Test Dependencies & Workflow Patterns', {
    tags: '@dependencies @demo'
}, () => {

    // Background: Navigate to the application
    beforeEach(async ({ navigate, config }) => {
        const baseUrl = config.get('BASE_URL');
        await navigate(baseUrl);
    });

    // ============================================================================
    // PATTERN 1: dependsOn Option - Explicit Dependencies
    // Tests with dependsOn are skipped if their dependency failed
    // ============================================================================

    describe('Pattern 1: Explicit Dependencies with dependsOn', {
        tags: '@pattern1 @TC800',
        mode: 'serial'  // Required for dependencies to work correctly
    }, () => {

        // TC801 - Setup test (no dependencies)
        test('Setup: Login to application', {
            tags: '@TC801 @setup'
        }, async ({ loginPage, reporter, config, ctx }) => {
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();

            // Store data for dependent tests
            ctx.set('isLoggedIn', true);
            ctx.set('currentUser', 'Admin');
            reporter.pass('Setup completed - logged in successfully');
        });

        // TC802 - Depends on TC801 (explicit dependency by tag)
        test('Verify dashboard after login', {
            tags: '@TC802 @verify',
            dependsOn: '@TC801'  // Will be skipped if TC801 fails
        }, async ({ dashboardPage, reporter, ctx }) => {
            // This test only runs if TC801 passed
            const isLoggedIn = ctx.get('isLoggedIn');
            reporter.info(`Login status from context: ${isLoggedIn}`);

            await dashboardPage.verifyDashboardLoaded();
            reporter.pass('Dashboard verified - dependency satisfied');
        });

        // TC803 - Depends on TC802 (chain dependency)
        test('Navigate to PIM module', {
            tags: '@TC803 @navigation',
            dependsOn: '@TC802'  // Depends on TC802, which depends on TC801
        }, async ({ dashboardPage, reporter }) => {
            await dashboardPage.clickMenuItem('PIM');
            await dashboardPage.verifyPageHeader('PIM');
            reporter.pass('Navigated to PIM - dependency chain satisfied');
        });

        // TC804 - Multiple dependencies (all must pass)
        test('Verify user can access admin features', {
            tags: '@TC804 @admin',
            dependsOn: ['@TC801', '@TC802']  // Both must pass
        }, async ({ dashboardPage, reporter, ctx }) => {
            const currentUser = ctx.get('currentUser');
            reporter.info(`Current user: ${currentUser}`);

            await dashboardPage.clickMenuItem('Admin');
            await dashboardPage.verifyPageHeader('Admin');
            reporter.pass('Admin access verified - all dependencies satisfied');
        });

        // TC805 - Cleanup (no dependencies - always runs in normal flow)
        test('Cleanup: Logout from application', {
            tags: '@TC805 @cleanup'
        }, async ({ dashboardPage, reporter }) => {
            await dashboardPage.clickLogoutOption();
            reporter.pass('Cleanup completed - logged out');
        });
    });

    // ============================================================================
    // PATTERN 2: Dependency by Test Name
    // You can also reference tests by their exact name
    // ============================================================================

    describe('Pattern 2: Dependency by Test Name', {
        tags: '@pattern2 @TC810',
        mode: 'serial'
    }, () => {

        // TC811 - First step
        test('Create employee record', {
            tags: '@TC811'
        }, async ({ loginPage, dashboardPage, reporter, config, ctx }) => {
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();

            // Simulate creating an employee (navigate to PIM)
            await dashboardPage.clickMenuItem('PIM');
            await dashboardPage.verifyPageHeader('PIM');

            // Store employee ID for dependent test
            ctx.set('employeeId', 'EMP-001');
            reporter.pass('Employee record created');
        });

        // TC812 - Depends on test by name
        test('Update employee record', {
            tags: '@TC812',
            dependsOn: 'Create employee record'  // Reference by test name
        }, async ({ dashboardPage, reporter, ctx }) => {
            const employeeId = ctx.get('employeeId');
            reporter.info(`Updating employee: ${employeeId}`);

            // Verify we're still on PIM page
            await dashboardPage.verifyPageHeader('PIM');
            reporter.pass(`Employee ${employeeId} updated`);
        });

        // TC813 - Cleanup
        test('Logout after employee operations', {
            tags: '@TC813'
        }, async ({ dashboardPage, reporter }) => {
            await dashboardPage.clickLogoutOption();
            reporter.pass('Logged out after employee operations');
        });
    });

    // ============================================================================
    // PATTERN 3: describe.workflow - Chained Steps with Cleanup
    // Workflow automatically chains dependencies and cleanup always runs
    // ============================================================================

    describe.workflow('Pattern 3: Approval Workflow', {
        tags: '@pattern3 @TC820 @workflow-demo'
    }, () => {

        // Step 1 - No dependencies needed (first step in workflow)
        test('Step 1: Requester logs in and creates request', {
            tags: '@TC821'
        }, async ({ loginPage, dashboardPage, reporter, config, ctx }) => {
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();

            // Navigate to Leave module (simulating leave request)
            await dashboardPage.clickMenuItem('Leave');
            await dashboardPage.verifyPageHeader('Leave');

            // Store request ID
            ctx.set('requestId', 'REQ-2025-001');
            ctx.set('requestStatus', 'pending');
            reporter.pass('Leave request created: REQ-2025-001');
        });

        // Step 2 - Automatically depends on Step 1 (workflow auto-chains)
        test('Step 2: Switch to approver and view request', {
            tags: '@TC822'
        }, async ({ dashboardPage, browserManager, loginPage, reporter, config, ctx }) => {
            // Clear context to simulate different user session
            await browserManager.clearContextAndReauthenticate();
            await loginPage.waitForPageLoad();

            // Login as approver (same user for demo)
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();

            const requestId = ctx.get('requestId');
            reporter.info(`Approver viewing request: ${requestId}`);

            await dashboardPage.clickMenuItem('Leave');
            await dashboardPage.verifyPageHeader('Leave');
            reporter.pass('Approver viewing pending request');
        });

        // Step 3 - Automatically depends on Step 2
        test('Step 3: Approver approves the request', {
            tags: '@TC823'
        }, async ({ dashboardPage, reporter, ctx }) => {
            const requestId = ctx.get('requestId');

            // Verify on Leave page
            await dashboardPage.verifyPageHeader('Leave');

            // Update status
            ctx.set('requestStatus', 'approved');
            reporter.pass(`Request ${requestId} approved`);
        });

        // Cleanup - Always runs even if previous steps failed
        test.cleanup('Cleanup: Reset test state and logout', {
            tags: '@TC824'
        }, async ({ dashboardPage, reporter, ctx }) => {
            // Get final status for reporting
            const requestId = ctx.get('requestId');
            const status = ctx.get('requestStatus');
            reporter.info(`Final state - Request: ${requestId}, Status: ${status}`);

            try {
                await dashboardPage.clickLogoutOption();
            } catch (e) {
                reporter.info('Already logged out or session expired');
            }
            reporter.pass('Workflow cleanup completed');
        });
    });

    // ============================================================================
    // PATTERN 4: Workflow with Failure Handling
    // Demonstrates that cleanup runs even when steps fail
    // ============================================================================

    describe.workflow('Pattern 4: Workflow with Expected Failure', {
        tags: '@pattern4 @TC830 @failure-demo',
        enabled: false  // Disabled by default - enable to see failure handling
    }, () => {

        test('Step 1: Setup that succeeds', {
            tags: '@TC831'
        }, async ({ loginPage, reporter, config, ctx }) => {
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();

            ctx.set('setupComplete', true);
            reporter.pass('Setup completed successfully');
        });

        test('Step 2: Step that fails intentionally', {
            tags: '@TC832',
            expectedToFail: 'Demonstrating workflow failure handling'
        }, async ({ reporter }) => {
            reporter.info('This step will fail intentionally');
            throw new Error('Intentional failure to demonstrate cleanup behavior');
        });

        test('Step 3: Step that would be skipped', {
            tags: '@TC833'
        }, async ({ reporter }) => {
            // This step should be skipped because Step 2 failed
            reporter.pass('This should not run if Step 2 failed');
        });

        test.cleanup('Cleanup: Runs even after failure', {
            tags: '@TC834'
        }, async ({ dashboardPage, reporter, ctx }) => {
            const setupComplete = ctx.get('setupComplete');
            reporter.info(`Setup was complete: ${setupComplete}`);

            // Cleanup always runs regardless of previous failures
            try {
                await dashboardPage.clickLogoutOption();
            } catch (e) {
                reporter.info('Cleanup: handling logout gracefully');
            }
            reporter.pass('Cleanup executed after workflow failure');
        });
    });

    // ============================================================================
    // PATTERN 5: Mixed - Using both dependsOn and workflow
    // ============================================================================

    describe('Pattern 5: Combined Dependencies and Data', {
        tags: '@pattern5 @TC840',
        mode: 'serial',
        dataSource: {
            type: 'inline',
            data: [
                { module: 'Admin', expected: 'Admin' },
                { module: 'PIM', expected: 'PIM' }
            ]
        }
    }, () => {

        // TC841 - Setup (runs once, doesn't use data)
        test('Setup: Login before navigation tests', {
            tags: '@TC841 @setup',
            useData: false  // Don't iterate with data
        }, async ({ loginPage, reporter, config }) => {
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();
            reporter.pass('Login setup completed');
        });

        // TC842 - Data-driven test that depends on setup
        test('Navigate to {module} module', {
            tags: '@TC842 @navigation',
            dependsOn: '@TC841'  // Depends on setup
        }, async ({ dashboardPage, reporter, data }) => {
            await dashboardPage.clickMenuItem(data.module);
            await dashboardPage.verifyPageHeader(data.expected);
            reporter.pass(`Navigated to ${data.module}`);
        });

        // TC843 - Cleanup (runs once)
        test('Cleanup: Logout after navigation tests', {
            tags: '@TC843 @cleanup',
            useData: false,
            dependsOn: '@TC842'  // Wait for all navigation tests
        }, async ({ dashboardPage, reporter }) => {
            await dashboardPage.clickLogoutOption();
            reporter.pass('Navigation tests cleanup completed');
        });
    });
});
