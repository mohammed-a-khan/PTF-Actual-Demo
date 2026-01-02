/**
 * CS Playwright Test Framework - Spec Format Features Demo
 *
 * PRODUCTION-READY demonstration of ALL Playwright-aligned spec runner features
 * using real OrangeHRM page objects and actual application functionality.
 *
 * Features Demonstrated:
 * 1. Execution Modes: describe.serial(), describe.parallel(), describe.configure()
 * 2. Describe Features: describe.skip(), describe.fixme(), options
 * 3. Test Annotations: test.skip(), test.fixme(), test.fail(), test.slow()
 * 4. Runtime Annotations: test.skip(condition), test.fail(condition), test.setTimeout()
 * 5. Test Info API: test.info(), annotations, attachments
 * 6. Test Steps: test.step(), nested steps, test.step.skip()
 * 7. Named Hooks: beforeAll('title'), beforeEach('title'), etc.
 * 8. Data-Driven: Serial/parallel data iteration with external sources
 *
 * Usage:
 *   npx cs-playwright-test --project=orangehrm --specs="test/orangehrm/specs/spec-features-demo.spec.ts"
 */

import { describe, test, beforeAll, afterAll, beforeEach, afterEach } from '@mdakhan.mak/cs-playwright-test-framework/spec';

// =============================================================================
// SECTION 1: SERIAL MODE - Dependent Login Flow
// =============================================================================

/**
 * Serial Mode Demo - Tests MUST run in order on the SAME worker.
 * If one test fails, remaining tests are SKIPPED (dependency chain).
 */
describe.serial('1. Serial Mode - OrangeHRM Login Flow', {
    tags: ['@serial', '@login', '@demo', '@TestPlanId:600']
}, () => {

    beforeAll('Initialize login session', async ({ ctx, reporter }) => {
        ctx.set('sessionStart', Date.now());
        reporter.info('Starting serial login flow test session');
        reporter.info('This is before all block');
    });

    afterAll('Report session duration', async ({ ctx, reporter }) => {
        const duration = Date.now() - Number(ctx.get('sessionStart'));
        reporter.info(`Serial login flow completed in ${duration}ms`);
    });

    test('Step 1: Navigate to OrangeHRM login page', {
        tags: ['@TestCaseId:601', '@navigation']
    }, async ({ loginPage, ctx, reporter }) => {
        await test.step('Open login page', async () => {
            await loginPage.navigate();
        });

        await test.step('Verify login form is present', async () => {
            const isOnLoginPage = await loginPage.isAt();
            if (!isOnLoginPage) {
                throw new Error('Failed to reach login page');
            }
        });

        ctx.set('navigated', true);
        reporter.pass('Navigation to login page successful');
    });

    test('Step 2: Enter admin credentials', {
        tags: ['@TestCaseId:602', '@credentials']
    }, async ({ loginPage, ctx, reporter, config }) => {
        // This test depends on Step 1 - if Step 1 fails, this is skipped
        if (!ctx.get('navigated')) {
            throw new Error('Navigation was not completed - cannot proceed');
        }

        await test.step('Enter username', async () => {
            await loginPage.enterUsername('Admin1');
        });

        await test.step('Enter password', async () => {
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.enterPassword(password);
        });

        ctx.set('credentialsEntered', true);
        reporter.pass('Credentials entered successfully');
    });

    test('Step 3: Submit login and verify success', {
        tags: ['@TestCaseId:603', '@verification']
    }, async ({ loginPage, ctx, reporter }) => {
        // This test depends on Step 2
        if (!ctx.get('credentialsEntered')) {
            throw new Error('Credentials were not entered - cannot submit');
        }

        await test.step('Click login button', async () => {
            await loginPage.clickLoginButton();
        });

        await test.step('Verify dashboard is visible', async () => {
            await loginPage.verifyLoginSuccess();
        });

        await test.step('Verify navigation menu', async () => {
            await loginPage.verifyNavigationMenu();
        });

        ctx.set('loggedIn', true);
        reporter.pass('Login flow completed - user is authenticated');
    });
});

// =============================================================================
// SECTION 2: PARALLEL MODE - Independent Menu Navigation Tests
// =============================================================================

/**
 * Parallel Mode Demo - Tests can run on DIFFERENT workers simultaneously.
 * Each test is independent and logs in fresh.
 */
describe.parallel('2. Parallel Mode - Independent Module Tests', {
    tags: ['@parallel', '@modules', '@demo', '@TestPlanId:610']
}, () => {

    test('Navigate to Admin module independently', {
        tags: ['@TestCaseId:611', '@admin']
    }, async ({ loginPage, dashboardPage, reporter, config }) => {
        // Each parallel test logs in independently
        const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
        await loginPage.navigate();
        await loginPage.login('Admin', password);
        await loginPage.verifyLoginSuccess();

        await dashboardPage.clickMenuItem('Admin');
        await dashboardPage.verifyPageHeader('Admin');
        await dashboardPage.verifyUrlContains('admin');

        reporter.pass('Admin module navigation verified');
    });

    test('Navigate to PIM module independently', {
        tags: ['@TestCaseId:612', '@pim']
    }, async ({ loginPage, dashboardPage, reporter, config }) => {
        const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
        await loginPage.navigate();
        await loginPage.login('Admin', password);
        await loginPage.verifyLoginSuccess();

        await dashboardPage.clickMenuItem('PIM');
        await dashboardPage.verifyPageHeader('PIM');
        await dashboardPage.verifyUrlContains('pim');

        reporter.pass('PIM module navigation verified');
    });

    test('Navigate to Leave module independently', {
        tags: ['@TestCaseId:613', '@leave']
    }, async ({ loginPage, dashboardPage, reporter, config }) => {
        const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
        await loginPage.navigate();
        await loginPage.login('Admin', password);
        await loginPage.verifyLoginSuccess();

        await dashboardPage.clickMenuItem('Leave');
        await dashboardPage.verifyPageHeader('Leave');
        await dashboardPage.verifyUrlContains('leave');

        reporter.pass('Leave module navigation verified');
    });
});

// =============================================================================
// SECTION 3: DESCRIBE.CONFIGURE - Configure Execution Mode
// =============================================================================

/**
 * describe.configure() Demo - Set mode, timeout, retries for all tests
 */
describe('3. Configure Mode - Dashboard Verification', {
    tags: ['@configure', '@dashboard', '@demo', '@TestPlanId:620']
}, () => {
    // Configure all tests in this describe to run serially with extended timeout
    describe.configure({
        mode: 'serial',
        timeout: 60000,
        retries: 1
    });

    beforeEach('Login before each test', async ({ loginPage, config }) => {
        const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
        await loginPage.navigate();
        await loginPage.login('Admin', password);
    });

    test('Verify dashboard loads successfully', {
        tags: ['@TestCaseId:621']
    }, async ({ dashboardPage, reporter }) => {
        await dashboardPage.verifyDashboardLoaded();
        reporter.pass('Dashboard loaded with configured serial mode');
    });

    test('Verify all menu items are visible', {
        tags: ['@TestCaseId:622']
    }, async ({ dashboardPage, reporter }) => {
        await dashboardPage.verifyAllMenuItemsVisible();
        reporter.pass('All menu items verified with 60s timeout');
    });
});

// =============================================================================
// SECTION 4: DESCRIBE SKIP/FIXME
// =============================================================================

/**
 * describe.skip() - Skip entire describe block
 */
describe.skip('4. Skipped - Legacy Module Tests', {
    tags: ['@skip', '@legacy', '@demo']
}, () => {
    test('Legacy feature test', async () => {
        throw new Error('This should not run - describe is skipped');
    });
});

/**
 * describe.fixme() - Mark describe as needing fixes
 */
describe.fixme('4. Fixme - New Reporting Module', 'Reporting module not yet deployed to test environment', () => {
    test('Generate monthly report', async () => {
        throw new Error('Reporting API not available');
    });

    test('Export report to PDF', async () => {
        throw new Error('PDF export feature pending');
    });
});

// =============================================================================
// SECTION 5: TEST ANNOTATIONS (Decorator Style)
// =============================================================================

describe('5. Test Annotations - Decorator Style', {
    tags: ['@annotations', '@demo', '@TestPlanId:630']
}, () => {

    beforeEach('Setup for annotation tests', async ({ loginPage, config }) => {
        const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
        await loginPage.navigate();
        await loginPage.login('Admin', password);
    });

    // Normal test that passes
    test('Normal dashboard verification', {
        tags: ['@TestCaseId:631']
    }, async ({ dashboardPage, reporter }) => {
        await dashboardPage.verifyDashboardLoaded();
        reporter.pass('Normal test completed successfully');
    });

    // Skipped test
    test.skip('Bulk employee import', 'CSV import feature temporarily disabled', async () => {
        throw new Error('Should not run - test is skipped');
    });

    // Fixme test
    test.fixme('Advanced search filters', 'Search autocomplete has known bug #789', async () => {
        throw new Error('Should not run - marked as fixme');
    });

    // Expected failure test
    test.fail('Invalid session handling', 'Known bug: Session not invalidated on browser close', async ({ dashboardPage }) => {
        // This test expects the assertion to fail
        await dashboardPage.verifyPageHeader('NonExistentPage');
    });

    // Slow test with extended timeout
    test.slow('Full menu navigation cycle', async ({ dashboardPage, reporter }) => {
        // This test has 3x the normal timeout
        const menus = ['Admin', 'PIM', 'Leave', 'Time', 'Recruitment'];

        for (const menu of menus) {
            await test.step(`Navigate to ${menu}`, async () => {
                await dashboardPage.clickMenuItem(menu);
                await dashboardPage.verifyPageHeader(menu);
            });
        }

        reporter.pass('Completed full menu navigation (slow test)');
    });
});

// =============================================================================
// SECTION 6: RUNTIME ANNOTATIONS (Inside Test Body)
// =============================================================================

describe('6. Runtime Annotations', {
    tags: ['@runtime', '@demo', '@TestPlanId:640']
}, () => {

    beforeEach('Login for runtime tests', async ({ loginPage, config }) => {
        const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
        await loginPage.navigate();
        await loginPage.login('Admin', password);
    });

    test('Skip in CI environment', {
        tags: ['@TestCaseId:641', '@local-only']
    }, async ({ dashboardPage, reporter }) => {
        const isCI = process.env.CI === 'true';
        test.skip(isCI, 'Visual validation requires real browser - skipping in CI');

        // This only runs locally
        await dashboardPage.verifyDashboardLoaded();
        const menuItems = await dashboardPage.getMenuItems();
        reporter.info(`Found ${menuItems.length} menu items: ${menuItems.join(', ')}`);
        reporter.pass('Local-only visual validation completed');
    });

    test('Conditional fixme based on feature flag', {
        tags: ['@TestCaseId:642', '@feature-flag']
    }, async ({ dashboardPage, reporter, config }) => {
        const newUIEnabled = config.get('NEW_UI_ENABLED', 'false') === 'true';
        test.fixme(!newUIEnabled, 'New UI feature flag not enabled in this environment');

        await dashboardPage.verifyAllMenuItemsVisible();
        reporter.pass('New UI verification completed');
    });

    test('Expected failure on Firefox', {
        tags: ['@TestCaseId:643', '@browser-compat']
    }, async ({ dashboardPage, reporter }) => {
        const browserName = process.env.BROWSER || 'chromium';
        test.fail(browserName === 'firefox', 'Known Firefox rendering issue with dashboard widgets');

        await dashboardPage.verifyDashboardLoaded();
        reporter.pass(`Dashboard verified on ${browserName}`);
    });

    test('Extended timeout for slow network', {
        tags: ['@TestCaseId:644', '@timeout']
    }, async ({ dashboardPage, reporter }) => {
        // Dynamically extend timeout for slow environments
        const isSlowNetwork = process.env.SLOW_NETWORK === 'true';
        if (isSlowNetwork) {
            test.setTimeout(120000); // 2 minutes
        }

        await dashboardPage.verifyDashboardLoaded();
        await dashboardPage.verifyAllMenuItemsVisible();
        reporter.pass('Dashboard verification with dynamic timeout completed');
    });
});

// =============================================================================
// SECTION 7: TEST INFO API
// =============================================================================

describe('7. Test Info API', {
    tags: ['@testinfo', '@demo', '@TestPlanId:650']
}, () => {

    test('Access test metadata', {
        tags: ['@TestCaseId:651', '@metadata']
    }, async ({ loginPage, config, reporter }) => {
        const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
        await loginPage.navigate();
        await loginPage.login('Admin', password);

        const info = test.info();

        reporter.info(`Test title: ${info.title}`);
        reporter.info(`Title path: ${info.titlePath.join(' > ')}`);
        reporter.info(`Retry attempt: ${info.retry}`);
        reporter.info(`Project: ${info.project}`);
        reporter.info(`Timeout: ${info.timeout}ms`);

        await loginPage.verifyLoginSuccess();
        reporter.pass('Test metadata accessed and login verified');
    });

    test('Add custom annotations and attachments', {
        tags: ['@TestCaseId:652', '@attachments']
    }, async ({ loginPage, dashboardPage, config, reporter }) => {
        const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
        await loginPage.navigate();
        await loginPage.login('Admin', password);
        await loginPage.verifyLoginSuccess();

        const info = test.info();

        // Add custom annotations
        info.annotations.push({ type: 'owner', description: 'QA Team' });
        info.annotations.push({ type: 'jira', description: 'OHRM-1234' });
        info.annotations.push({ type: 'category', description: 'Smoke Test' });

        // Get menu items and attach as JSON
        const menuItems = await dashboardPage.getMenuItems();

        await info.attach('menu-items', {
            body: JSON.stringify({ menus: menuItems, count: menuItems.length }, null, 2),
            contentType: 'application/json'
        });

        // Attach test execution log
        await info.attach('execution-log', {
            body: `Test executed at: ${new Date().toISOString()}\nUser: Admin\nMenus found: ${menuItems.length}`,
            contentType: 'text/plain'
        });

        reporter.pass('Custom annotations and attachments added to test report');
    });
});

// =============================================================================
// SECTION 8: TEST STEPS
// =============================================================================

describe('8. Test Steps - Nested Steps Demo', {
    tags: ['@nestedSteps', '@steps', '@demo', '@TestPlanId:660']
}, () => {

    test('Complete login workflow with steps', {
        tags: ['@TestCaseId:661', '@workflow']
    }, async ({ loginPage, dashboardPage, config, reporter }) => {
        const password = config.get('ORANGEHRM_PASSWORD', 'admin123');

        await test.step('Navigate to application', async () => {
            await loginPage.navigate();
            reporter.info('Navigated to OrangeHRM');
        });

        await test.step('Authenticate user', async () => {
            await test.step('Enter username', async () => {
                await loginPage.enterUsername('Admin');
            });

            await test.step('Enter password', async () => {
                await loginPage.enterPassword(password);
            });

            await test.step('Submit login form', async () => {
                await loginPage.clickLoginButton();
            });
        });

        await test.step('Verify successful login', async () => {
            await test.step('Check dashboard visibility', async () => {
                await loginPage.verifyLoginSuccess();
            });

            await test.step('Check navigation menu', async () => {
                await loginPage.verifyNavigationMenu();
            });
        });

        await test.step('Verify dashboard elements', async () => {
            await dashboardPage.verifyDashboardLoaded();
            await dashboardPage.verifyAllMenuItemsVisible();
        });

        reporter.pass('Complete login workflow with nested steps verified');
    });

    test('Navigation with skipped optional step', {
        tags: ['@TestCaseId:662', '@optional']
    }, async ({ loginPage, dashboardPage, config, reporter }) => {
        const password = config.get('ORANGEHRM_PASSWORD', 'admin123');

        await test.step('Login to application', async () => {
            await loginPage.navigate();
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();
        });

        await test.step('Navigate to Admin module', async () => {
            await dashboardPage.clickMenuItem('Admin');
            await dashboardPage.verifyPageHeader('Admin');
        });

        // Skip optional advanced configuration step
        await test.step.skip('Configure advanced settings', async () => {
            // This step is skipped but appears in report
            reporter.info('Advanced settings configuration would happen here');
        });

        await test.step('Verify Admin page loaded', async () => {
            await dashboardPage.verifyUrlContains('admin');
        });

        reporter.pass('Navigation completed with optional step skipped');
    });

    test('Step with return value', {
        tags: ['@TestCaseId:663', '@return-value']
    }, async ({ loginPage, dashboardPage, config, reporter }) => {
        const password = config.get('ORANGEHRM_PASSWORD', 'admin123');

        await loginPage.navigate();
        await loginPage.login('Admin', password);

        const menuCount = await test.step('Count menu items', async () => {
            const items = await dashboardPage.getMenuItems();
            return items.length;
        });

        await test.step('Verify menu count', async () => {
            reporter.info(`Found ${menuCount} menu items`);
            if (menuCount < 5) {
                throw new Error(`Expected at least 5 menu items, found ${menuCount}`);
            }
        });

        reporter.pass(`Menu count verification passed: ${menuCount} items`);
    });
});

// =============================================================================
// SECTION 9: NAMED HOOKS
// =============================================================================

describe('9. Named Hooks Demo', {
    tags: ['@hooks', '@demo', '@TestPlanId:670']
}, () => {

    beforeAll('Initialize test session', async ({ ctx, reporter }) => {
        ctx.set('sessionId', `session-${Date.now()}`);
        ctx.set('testsRun', 0);
        reporter.info(`Test session initialized: ${ctx.get('sessionId')}`);
    });

    afterAll('Report session statistics', async ({ ctx, reporter }) => {
        const sessionId = ctx.get('sessionId');
        const testsRun = Number(ctx.get('testsRun'));
        reporter.info(`Session ${sessionId} completed: ${testsRun} tests executed`);
    });

    beforeEach('Reset test context', async ({ ctx, loginPage, config }) => {
        ctx.set('testStart', Date.now());

        // Login before each test
        const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
        await loginPage.navigate();
        await loginPage.login('Admin', password);
    });

    afterEach('Log test duration', async ({ ctx, reporter }) => {
        const startTime = Number(ctx.get('testStart'));
        const duration = Date.now() - startTime;
        const testsRun = Number(ctx.get('testsRun')) + 1;
        ctx.set('testsRun', testsRun);
        reporter.info(`Test completed in ${duration}ms (test #${testsRun})`);
    });

    test('Dashboard check with named hooks', {
        tags: ['@TestCaseId:671']
    }, async ({ dashboardPage, ctx, reporter }) => {
        const sessionId = ctx.get('sessionId');
        reporter.info(`Running in session: ${sessionId}`);

        await dashboardPage.verifyDashboardLoaded();
        reporter.pass('Dashboard verified with named hooks');
    });

    test('Menu navigation with named hooks', {
        tags: ['@TestCaseId:672']
    }, async ({ dashboardPage, reporter }) => {
        await dashboardPage.clickMenuItem('Admin');
        await dashboardPage.verifyPageHeader('Admin');
        reporter.pass('Menu navigation verified with named hooks');
    });

    test('Verify all menus with named hooks', {
        tags: ['@TestCaseId:673']
    }, async ({ dashboardPage, reporter }) => {
        await dashboardPage.verifyAllMenuItemsVisible();
        reporter.pass('All menus verified with named hooks');
    });
});

// =============================================================================
// SECTION 10: DATA-DRIVEN WITH SERIAL MODE
// =============================================================================

/**
 * Data-Driven Serial Mode - All data rows run sequentially.
 * If one iteration fails, remaining iterations are SKIPPED.
 */
describe.serial('10. Data-Driven Serial - Module Navigation', {
    tags: ['@data-driven', '@serial', '@demo', '@TestPlanId:680'],
    dataSource: {
        type: 'inline',
        data: [
            { moduleName: 'Admin', expectedHeader: 'Admin', urlFragment: 'admin' },
            { moduleName: 'PIM', expectedHeader: 'PIM', urlFragment: 'pim' },
            { moduleName: 'Leave', expectedHeader: 'Leave', urlFragment: 'leave' },
            { moduleName: 'Time', expectedHeader: 'Time', urlFragment: 'time' }
        ]
    }
}, () => {

    beforeAll('Login for data-driven tests', async ({ loginPage, config, reporter }) => {
        const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
        await loginPage.navigate();
        await loginPage.login('Admin', password);
        await loginPage.verifyLoginSuccess();
        reporter.info('Logged in for serial data-driven navigation tests');
    });

    test('Navigate to {moduleName} module', {
        tags: ['@TestCaseId:681']
    }, async ({ dashboardPage, data, iteration, reporter }) => {
        reporter.info(`Iteration ${iteration?.current}/${iteration?.total}: Testing ${data.moduleName}`);

        await test.step(`Click ${data.moduleName} menu`, async () => {
            await dashboardPage.clickMenuItem(data.moduleName);
        });

        await test.step(`Verify ${data.moduleName} header`, async () => {
            await dashboardPage.verifyPageHeader(data.expectedHeader);
        });

        await test.step(`Verify URL contains ${data.urlFragment}`, async () => {
            await dashboardPage.verifyUrlContains(data.urlFragment);
        });

        reporter.pass(`Module ${data.moduleName} navigation verified (${iteration?.current}/${iteration?.total})`);
    });
});

// =============================================================================
// SECTION 11: DATA-DRIVEN WITH PARALLEL MODE
// =============================================================================

/**
 * Data-Driven Parallel Mode - Each data row can run on different workers.
 */
describe('11. Data-Driven Parallel - Independent Logins', {
    tags: ['@data-driven', '@parallel', '@demo', '@TestPlanId:690'],
    dataSource: {
        type: 'inline',
        data: [
            { scenario: 'Valid Admin', username: 'Admin', password: 'admin123', shouldSucceed: true },
            { scenario: 'Invalid User', username: 'InvalidUser', password: 'wrongpass', shouldSucceed: false },
            { scenario: 'Empty Password', username: 'Admin', password: '', shouldSucceed: false }
        ]
    }
}, () => {

    test('Login scenario: {scenario}', {
        tags: ['@TestCaseId:691']
    }, async ({ loginPage, data, iteration, reporter, config }) => {
        reporter.info(`Testing scenario: ${data.scenario} (${iteration?.current}/${iteration?.total})`);

        await loginPage.navigate();
        await loginPage.enterUsername(data.username);
        await loginPage.enterPassword(data.password || '');
        await loginPage.clickLoginButton();

        if (data.shouldSucceed) {
            await loginPage.verifyLoginSuccess();
            reporter.pass(`Login succeeded as expected for: ${data.scenario}`);
        } else {
            await loginPage.verifyStillOnLoginPage();
            reporter.pass(`Login failed as expected for: ${data.scenario}`);
        }
    });
});

// =============================================================================
// SECTION 12: DATA-DRIVEN WITH EXTERNAL CSV
// =============================================================================

describe('12. Data-Driven with CSV - User Login Tests', {
    tags: ['@data-driven', '@csv', '@demo', '@TestPlanId:700'],
    dataSource: {
        type: 'csv',
        source: 'test/orangehrm/data/users.csv',
        filter: 'expectedResult=success' // Only test successful login scenarios
    }
}, () => {

    test('Login with CSV user: {username}', {
        tags: ['@TestCaseId:701']
    }, async ({ loginPage, data, iteration, reporter }) => {
        reporter.info(`CSV Test ${iteration?.current}/${iteration?.total}`);
        reporter.info(`User: ${data.username}, Role: ${data.role}`);

        await loginPage.navigate();
        await loginPage.enterUsername(data.username);
        await loginPage.enterPassword(data.password);
        await loginPage.clickLoginButton();

        if (data.expectedResult === 'success') {
            await loginPage.verifyLoginSuccess();
            reporter.pass(`CSV login successful: ${data.username} (${data.role})`);
        }
    });
});

// =============================================================================
// SECTION 13: DATA-DRIVEN WITH RUNTIME ANNOTATIONS
// =============================================================================

describe('13. Data-Driven with Runtime Skip/Slow', {
    tags: ['@data-driven', '@runtime-annotations', '@demo', '@TestPlanId:710'],
    dataSource: {
        type: 'inline',
        data: [
            { testName: 'Quick Test', isHeavy: false, skipReason: '' },
            { testName: 'Heavy Test', isHeavy: true, skipReason: '' },
            { testName: 'Skipped Test', isHeavy: false, skipReason: 'Feature not ready' }
        ]
    }
}, () => {

    test('Execute: {testName}', {
        tags: ['@TestCaseId:711']
    }, async ({ loginPage, dashboardPage, data, iteration, reporter, config }) => {
        // Runtime skip based on data
        if (data.skipReason) {
            test.skip(true, data.skipReason);
        }

        // Extended timeout for heavy tests
        if (data.isHeavy) {
            test.slow(true, 'Heavy test iteration - extended timeout');
        }

        const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
        await loginPage.navigate();
        await loginPage.login('Admin', password);
        await loginPage.verifyLoginSuccess();

        if (data.isHeavy) {
            // Heavy test does more verification
            await dashboardPage.verifyDashboardLoaded();
            await dashboardPage.verifyAllMenuItemsVisible();
        }

        reporter.pass(`${data.testName} completed (iteration ${iteration?.current}/${iteration?.total})`);
    });
});

// =============================================================================
// SECTION 14: COMPLETE E2E WORKFLOW
// =============================================================================

describe.serial('14. Complete E2E Workflow - OrangeHRM', {
    tags: ['@e2e', '@smoke', '@demo', '@TestPlanId:800', '@TestSuiteId:801']
}, () => {

    beforeAll('Initialize E2E session', async ({ ctx, reporter }) => {
        ctx.set('workflowId', `e2e-${Date.now()}`);
        reporter.info('Starting complete E2E workflow');
    });

    afterAll('Complete E2E session', async ({ ctx, reporter }) => {
        reporter.info(`E2E workflow ${ctx.get('workflowId')} completed`);

        const info = test.info();
        info.annotations.push({ type: 'workflow', description: String(ctx.get('workflowId')) });
    });

    test('E2E Step 1: Login to OrangeHRM', {
        tags: ['@TestCaseId:802', '@login']
    }, async ({ loginPage, ctx, reporter, config }) => {
        const password = config.get('ORANGEHRM_PASSWORD', 'admin123');

        await test.step('Navigate to login', async () => {
            await loginPage.navigate();
        });

        await test.step('Authenticate', async () => {
            await loginPage.login('Admin', password);
        });

        await test.step('Verify login success', async () => {
            await loginPage.verifyLoginSuccess();
            await loginPage.verifyNavigationMenu();
        });

        ctx.set('authenticated', true);
        reporter.pass('E2E: Login completed successfully');
    });

    test('E2E Step 2: Verify Dashboard', {
        tags: ['@TestCaseId:803', '@dashboard']
    }, async ({ dashboardPage, ctx, reporter }) => {
        if (!ctx.get('authenticated')) {
            throw new Error('Not authenticated - cannot verify dashboard');
        }

        await test.step('Check dashboard loaded', async () => {
            await dashboardPage.verifyDashboardLoaded();
        });

        await test.step('Verify all menu items', async () => {
            await dashboardPage.verifyAllMenuItemsVisible();
        });

        const menuItems = await dashboardPage.getMenuItems();
        const info = test.info();
        await info.attach('dashboard-menus', {
            body: JSON.stringify({ menus: menuItems }),
            contentType: 'application/json'
        });

        ctx.set('dashboardVerified', true);
        reporter.pass(`E2E: Dashboard verified with ${menuItems.length} menu items`);
    });

    test('E2E Step 3: Navigate Modules', {
        tags: ['@TestCaseId:804', '@navigation']
    }, async ({ dashboardPage, ctx, reporter }) => {
        if (!ctx.get('dashboardVerified')) {
            throw new Error('Dashboard not verified - cannot navigate');
        }

        const modules = ['Admin', 'PIM', 'Leave'];

        for (const module of modules) {
            await test.step(`Navigate to ${module}`, async () => {
                await dashboardPage.clickMenuItem(module);
                await dashboardPage.verifyPageHeader(module);
            });
        }

        ctx.set('navigationComplete', true);
        reporter.pass('E2E: Module navigation completed');
    });

    test('E2E Step 4: Logout', {
        tags: ['@TestCaseId:805', '@logout']
    }, async ({ dashboardPage, loginPage, ctx, reporter }) => {
        if (!ctx.get('navigationComplete')) {
            throw new Error('Navigation not complete - cannot logout');
        }

        await test.step('Click logout', async () => {
            await dashboardPage.clickLogoutOption();
        });

        await test.step('Verify redirect to login', async () => {
            await dashboardPage.verifyRedirectToLogin();
        });

        await test.step('Verify login page displayed', async () => {
            const isOnLogin = await loginPage.isAt();
            if (!isOnLogin) {
                throw new Error('Not redirected to login page');
            }
        });

        reporter.pass('E2E: Logout completed - workflow finished');
    });
});
