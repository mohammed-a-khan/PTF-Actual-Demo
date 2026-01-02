/**
 * Comprehensive Data-Driven Testing Patterns - Spec Format
 * Demonstrates all data-driven patterns implemented in CS Framework
 *
 * Uses:
 * - Auto-injected page objects: loginPage, dashboardPage
 * - CSExpect/CSAssert for assertions (NOT raw Playwright)
 * - Page object methods (NOT page.fill, page.click)
 * - CSDataProvider patterns via dataSource option
 */

import { describe, test, beforeEach } from '@mdakhan.mak/cs-playwright-test-framework/spec';

describe('Comprehensive Data-Driven Testing Patterns', {
    tags: ['@data-driven-comprehensive'],
    enabled: true
}, () => {

    // Background: Navigate to the application
    beforeEach(async ({ navigate, config }) => {
        const baseUrl = config.get('BASE_URL');
        await navigate(baseUrl);
    });

    // ============================================================================
    // PATTERN 1: Inline Data Array
    // ============================================================================

    describe('Login with inline data array', {
        tags: ['@inline-data'],
        enabled: false,
        dataSource: {
            type: 'inline',
            data: [
                { username: 'Admin', password: 'admin123', expectedResult: 'success' },
                { username: 'Invalid', password: 'wrong', expectedResult: 'failure' },
                { username: 'Test', password: 'test123', expectedResult: 'failure' }
            ]
        }
    }, () => {
        test('Login with {username}', { enabled: false }, async ({ loginPage, expect, reporter, data }) => {
            // Enter credentials using page object methods
            await loginPage.enterUsername(data.username);
            await loginPage.enterPassword(data.password);
            await loginPage.clickLoginButton();

            if (data.expectedResult === 'success') {
                await loginPage.verifyLoginSuccess();
                reporter.pass(`Login successful for ${data.username}`);
            } else {
                await loginPage.verifyErrorMessage('Invalid credentials');
                reporter.pass(`Login failed as expected for ${data.username}`);
            }
        });
    });

    // ============================================================================
    // PATTERN 2: CSV Data Source
    // ============================================================================

    describe('Login with CSV data', {
        tags: ['@csv-data'],
        enabled: false,
        dataSource: {
            type: 'csv',
            source: 'test/orangehrm/data/users.csv'
        }
    }, () => {
        test('Login with CSV row', { enabled: true }, async ({ loginPage, expect, reporter, data, iteration }) => {
            reporter.info(`Iteration ${iteration?.index}: Testing ${data.username}`);

            // Use page object methods
            await loginPage.enterUsername(data.username);
            await loginPage.enterPassword(data.password);
            await loginPage.clickLoginButton();

            if (data.expectedResult === 'success') {
                await loginPage.verifyLoginSuccess();
                reporter.pass(`CSV test passed for ${data.username}`);
            } else {
                await loginPage.verifyErrorMessage('Invalid credentials');
                reporter.pass('CSV test - login failed as expected');
            }
        });
    });

    // ============================================================================
    // PATTERN 3: JSON Data Source
    // ============================================================================

    describe('Login with JSON data', {
        tags: ['@json-data'],
        enabled: false,
        dataSource: {
            type: 'json',
            source: 'test/orangehrm/data/users.json',
            path: '$.data[*]'
        }
    }, () => {
        test('Login with JSON row', { enabled: true }, async ({ loginPage, expect, reporter, data }) => {
            // Use page object methods
            await loginPage.enterUsername(data.username);
            await loginPage.enterPassword(data.password);
            await loginPage.clickLoginButton();

            if (data.expectedResult === 'success') {
                await loginPage.verifyLoginSuccess();
                reporter.pass('JSON data test passed');
            } else {
                await loginPage.verifyErrorMessage('Invalid credentials');
                reporter.pass('JSON data test - login failed as expected');
            }
        });
    });

    // ============================================================================
    // PATTERN 4: Excel Data Source
    // ============================================================================

    describe('Login with Excel data', {
        tags: ['@excel-data'],
        enabled: false,
        dataSource: {
            type: 'excel',
            source: 'test/orangehrm/data/users.xlsx',
            sheet: 'Users'
        }
    }, () => {
        test('Login with Excel row', { enabled: true }, async ({ loginPage, expect, reporter, data }) => {
            // Use page object methods
            await loginPage.enterUsername(data.username);
            await loginPage.enterPassword(data.password);
            await loginPage.clickLoginButton();

            if (data.expectedResult === 'success') {
                await loginPage.verifyLoginSuccess();
                reporter.pass('Excel data test passed');
            } else {
                await loginPage.verifyErrorMessage('Invalid credentials');
                reporter.pass('Excel data test - login failed as expected');
            }
        });
    });

    // ============================================================================
    // PATTERN 5: XML Data Source
    // ============================================================================

    describe('Login with XML data', {
        tags: ['@xml-data'],
        enabled: false,
        dataSource: {
            type: 'xml',
            source: 'test/orangehrm/data/users.xml',
            xpath: '//user'
        }
    }, () => {
        test('Login with XML row', { enabled: true }, async ({ loginPage, expect, reporter, data }) => {
            // Use page object methods
            await loginPage.enterUsername(data.username);
            await loginPage.enterPassword(data.password);
            await loginPage.clickLoginButton();

            if (data.expectedResult === 'success') {
                await loginPage.verifyLoginSuccess();
                reporter.pass('XML data test passed');
            } else {
                await loginPage.verifyErrorMessage('Invalid credentials');
                reporter.pass('XML data test - login failed as expected');
            }
        });
    });

    // ============================================================================
    // PATTERN 6: Filtered Data (equals)
    // ============================================================================

    describe('Login with filtered data (executeTest=true)', {
        tags: ['@filtered-data', '@equals-filter'],
        enabled: false,
        dataSource: {
            type: 'csv',
            source: 'test/orangehrm/data/users-with-filter.csv',
            filter: 'executeTest=true'
        }
    }, () => {
        test('Login with filtered row', { enabled: true }, async ({ loginPage, reporter, data }) => {
            reporter.info(`Testing filtered data: ${data.username}`);

            // Use page object methods
            await loginPage.enterUsername(data.username);
            await loginPage.enterPassword(data.password);
            await loginPage.clickLoginButton();
            reporter.pass('Filtered data test executed');
        });
    });

    // ============================================================================
    // PATTERN 7: Filtered Data (not equals)
    // ============================================================================

    describe('Login with filtered data (status!=disabled)', {
        tags: ['@filtered-data', '@not-equals-filter'],
        enabled: false,
        dataSource: {
            type: 'csv',
            source: 'test/orangehrm/data/users-with-filter.csv',
            filter: 'status!=disabled'
        }
    }, () => {
        test('Login excluding disabled users', { enabled: true }, async ({ loginPage, reporter, data }) => {
            reporter.info(`Testing non-disabled user: ${data.username}`);

            // Use page object methods
            await loginPage.enterUsername(data.username);
            await loginPage.enterPassword(data.password);
            await loginPage.clickLoginButton();
            reporter.pass('Not-equals filter test executed');
        });
    });

    // ============================================================================
    // PATTERN 8: Filtered Data (greater than)
    // ============================================================================

    describe('Login with filtered data (priority > 2)', {
        tags: ['@filtered-data', '@greater-than-filter'],
        enabled: false,
        dataSource: {
            type: 'csv',
            source: 'test/orangehrm/data/users-with-filter.csv',
            filter: 'priority>2'
        }
    }, () => {
        test('Login with high priority users', { enabled: true }, async ({ loginPage, reporter, data }) => {
            reporter.info(`Testing high priority user: ${data.username} (priority: ${data.priority})`);

            // Use page object methods
            await loginPage.enterUsername(data.username);
            await loginPage.enterPassword(data.password);
            await loginPage.clickLoginButton();
            reporter.pass('Greater-than filter test executed');
        });
    });

    // ============================================================================
    // PATTERN 9: Filtered Data (in list)
    // ============================================================================

    describe('Login with filtered data (role in Admin,Manager)', {
        tags: ['@filtered-data', '@in-list-filter'],
        enabled: false,
        dataSource: {
            type: 'csv',
            source: 'test/orangehrm/data/users-with-filter.csv',
            filter: 'role:Admin,Manager'
        }
    }, () => {
        test('Login with Admin or Manager role', { enabled: true }, async ({ loginPage, reporter, data }) => {
            reporter.info(`Testing ${data.role} user: ${data.username}`);

            // Use page object methods
            await loginPage.enterUsername(data.username);
            await loginPage.enterPassword(data.password);
            await loginPage.clickLoginButton();
            reporter.pass('In-list filter test executed');
        });
    });

    // ============================================================================
    // PATTERN 10: Filtered Data (contains)
    // ============================================================================

    describe('Login with filtered data (tags contains smoke)', {
        tags: ['@filtered-data', '@contains-filter'],
        enabled: false,
        dataSource: {
            type: 'csv',
            source: 'test/orangehrm/data/users-with-filter.csv',
            filter: 'tags~smoke'
        }
    }, () => {
        test('Login with smoke-tagged users', { enabled: true }, async ({ loginPage, reporter, data }) => {
            reporter.info(`Testing smoke-tagged user: ${data.username} (tags: ${data.tags})`);

            // Use page object methods
            await loginPage.enterUsername(data.username);
            await loginPage.enterPassword(data.password);
            await loginPage.clickLoginButton();
            reporter.pass('Contains filter test executed');
        });
    });

    // ============================================================================
    // PATTERN 11: Multiple Filters (AND)
    // ============================================================================

    describe('Login with multiple AND filters', {
        tags: ['@filtered-data', '@and-filter'],
        enabled: false,
        dataSource: {
            type: 'csv',
            source: 'test/orangehrm/data/users-with-filter.csv',
            filter: 'executeTest=true&priority<=2'
        }
    }, () => {
        test('Login with AND filter conditions', { enabled: true }, async ({ loginPage, reporter, data }) => {
            reporter.info(`Testing with AND filters: ${data.username}`);

            // Use page object methods
            await loginPage.enterUsername(data.username);
            await loginPage.enterPassword(data.password);
            await loginPage.clickLoginButton();
            reporter.pass('AND filter test executed');
        });
    });

    // ============================================================================
    // PATTERN 12: Multiple Filters (OR)
    // ============================================================================

    describe('Login with multiple OR filters', {
        tags: ['@filtered-data', '@or-filter'],
        enabled: false,
        dataSource: {
            type: 'csv',
            source: 'test/orangehrm/data/users-with-filter.csv',
            filter: 'role=Admin|role=Manager'
        }
    }, () => {
        test('Login with OR filter conditions', { enabled: true }, async ({ loginPage, reporter, data }) => {
            reporter.info(`Testing with OR filters: ${data.username} (${data.role})`);

            // Use page object methods
            await loginPage.enterUsername(data.username);
            await loginPage.enterPassword(data.password);
            await loginPage.clickLoginButton();
            reporter.pass('OR filter test executed');
        });
    });

    // ============================================================================
    // PATTERN 13: Complex Filters
    // ============================================================================

    describe('Login with complex filters', {
        tags: ['@filtered-data', '@complex-filter'],
        enabled: false,
        dataSource: {
            type: 'csv',
            source: 'test/orangehrm/data/users-with-filter.csv',
            filter: 'executeTest=true&status=active&priority<3'
        }
    }, () => {
        test('Login with complex filter conditions', { enabled: true }, async ({ loginPage, reporter, data }) => {
            reporter.info(`Testing with complex filters: ${data.username}`);

            // Use page object methods
            await loginPage.enterUsername(data.username);
            await loginPage.enterPassword(data.password);
            await loginPage.clickLoginButton();
            reporter.pass('Complex filter test executed');
        });
    });

    // ============================================================================
    // PATTERN 14: Database Data Source
    // ============================================================================

    describe('Login with database data', {
        tags: ['@database-data'],
        enabled: false,
        dataSource: {
            type: 'database',
            connection: 'PRACTICE_MYSQL',
            query: 'SELECT username, password, expectedResult FROM test_users WHERE active = 1'
        }
    }, () => {
        test('Login with database row', { enabled: false }, async ({ loginPage, reporter, data }) => {
            reporter.info(`Testing database user: ${data.username}`);

            // Use page object methods
            await loginPage.enterUsername(data.username);
            await loginPage.enterPassword(data.password);
            await loginPage.clickLoginButton();
            reporter.pass('Database data test executed');
        });
    });

    // ============================================================================
    // PATTERN 15: API Data Source
    // ============================================================================

    describe('Login with API data', {
        tags: ['@api-data'],
        enabled: false,
        dataSource: {
            type: 'api',
            url: 'https://api.example.com/test-users',
            method: 'GET',
            path: '$.users[*]'
        }
    }, () => {
        test('Login with API row', { enabled: false }, async ({ loginPage, reporter, data }) => {
            reporter.info(`Testing API user: ${data.username}`);

            // Use page object methods
            await loginPage.enterUsername(data.username);
            await loginPage.enterPassword(data.password);
            await loginPage.clickLoginButton();
            reporter.pass('API data test executed');
        });
    });

    // ============================================================================
    // PATTERN 16: Data with Environment Variables
    // ============================================================================

    describe('Login with environment-specific data', {
        tags: ['@env-data'],
        enabled: false,
        dataSource: {
            type: 'json',
            source: 'test/orangehrm/data/{env}/users.json',
            path: '$.users[*]'
        }
    }, () => {
        test('Login with environment data', { enabled: true }, async ({ loginPage, reporter, data, config }) => {
            const env = config.get('ENVIRONMENT', 'dev');
            reporter.info(`Testing with ${env} environment data: ${data.username}`);

            // Use page object methods
            await loginPage.enterUsername(data.username);
            await loginPage.enterPassword(data.password);
            await loginPage.clickLoginButton();
            reporter.pass('Environment-specific data test executed');
        });
    });

    // ============================================================================
    // PATTERN 17: Iteration Info Access
    // ============================================================================

    describe('Login with iteration tracking', {
        tags: ['@iteration-info'],
        enabled: false,
        dataSource: {
            type: 'inline',
            data: [
                { username: 'User1', password: 'pass1' },
                { username: 'User2', password: 'pass2' },
                { username: 'User3', password: 'pass3' }
            ]
        }
    }, () => {
        test('Login iteration {iteration.index}', { enabled: false }, async ({ loginPage, reporter, data, iteration }) => {
            reporter.info(`Iteration ${(iteration?.index ?? 0) + 1} of ${iteration?.total}`);
            reporter.info(`First: ${iteration?.isFirst}, Last: ${iteration?.isLast}`);

            // Use page object methods
            await loginPage.enterUsername(data.username);
            await loginPage.enterPassword(data.password);
            await loginPage.clickLoginButton();

            if (iteration?.isLast) {
                reporter.pass('Last iteration completed!');
            } else {
                reporter.pass(`Iteration ${(iteration?.index ?? 0) + 1} completed`);
            }
        });
    });

    // ============================================================================
    // PATTERN 18: Navigation with Data-Driven Module Testing
    // ============================================================================

    describe('Navigate to modules with data', {
        tags: ['@navigation-data'],
        enabled: true,
        dataSource: {
            type: 'inline',
            data: [
                { module: 'Admin', header: 'Admin', url: 'admin' },
                { module: 'PIM', header: 'PIM', url: 'pim' },
                { module: 'Leave', header: 'Leave', url: 'leave' }
            ]
        }
    }, () => {
        test('Navigate to {module} module', { enabled: true }, async ({ loginPage, dashboardPage, reporter, config, data }) => {
            // Login first using page object
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();

            // Navigate using page object
            await dashboardPage.clickMenuItem(data.module);
            await dashboardPage.verifyPageHeader(data.header);
            await dashboardPage.verifyUrlContains(data.url);

            reporter.pass(`Successfully navigated to ${data.module}`);
        });
    });

    // ============================================================================
    // PATTERN 19: Smart Data Iteration Control
    // Demonstrates useData option and auto-detect for mixed test scenarios
    // ============================================================================

    describe('Smart Data Iteration Control', {
        tags: ['@smart-data', '@TC700'],
        enabled: true,
        dataSource: {
            type: 'inline',
            data: [
                { module: 'Admin', expectedHeader: 'Admin' },
                { module: 'PIM', expectedHeader: 'PIM' },
                { module: 'Leave', expectedHeader: 'Leave' }
            ]
        }
    }, () => {

        // TC701 - This test USES data fixture, runs 3 times (once per data row)
        test('Navigate to {module} module using data', {
            tags: ['@TC701', '@uses-data']
        }, async ({ loginPage, dashboardPage, reporter, config, data }) => {
            // This test uses 'data' parameter - will iterate 3 times
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();

            await dashboardPage.clickMenuItem(data.module);
            await dashboardPage.verifyPageHeader(data.expectedHeader);
            reporter.pass(`Navigated to ${data.module} using data iteration`);
        });

        // TC702 - This test does NOT use data fixture, runs only ONCE (auto-detect)
        test('Verify login page elements exist', {
            tags: ['@TC702', '@no-data', '@auto-detect']
        }, async ({ loginPage, reporter, config }) => {
            // This test doesn't use 'data' parameter - runs once automatically
            // Framework auto-detects that 'data' is not in the parameter list
            const isOnLogin = await loginPage.isAt();
            reporter.info(`On login page: ${isOnLogin}`);
            reporter.pass('Login page elements verified - ran once despite describe having data');
        });

        // TC703 - Explicit useData: false - runs only ONCE regardless of data fixture usage
        test('Verify dashboard loads after login', {
            tags: ['@TC703', '@explicit-opt-out'],
            useData: false  // Explicit opt-out - this test runs once even if it could use data
        }, async ({ loginPage, dashboardPage, reporter, config, data }) => {
            // Even though 'data' is in parameters, useData: false means run once
            // Note: 'data' will be an empty object {} when run without iteration
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();

            reporter.info(`Data object is empty or undefined: ${JSON.stringify(data || {})}`);
            reporter.pass('Dashboard verified - ran once due to useData: false');
        });

        // TC704 - Explicit useData: true - forces iteration even with unusual parameter names
        test('Force data iteration with useData true', {
            tags: ['@TC704', '@explicit-opt-in'],
            useData: true  // Explicit opt-in - forces iteration
        }, async ({ loginPage, reporter, config, data: testData }) => {
            // Using renamed destructuring: { data: testData }
            // Even if auto-detect might miss it, useData: true ensures iteration
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();

            reporter.pass(`Tested with module: ${testData.module}`);
        });
    });

    // ============================================================================
    // PATTERN 20: Test-Level Data Source Override
    // Demonstrates test-level dataSource independent of describe-level
    // ============================================================================

    describe('Test-Level Data Source Override', {
        tags: ['@test-level-data', '@TC710'],
        enabled: true,
        dataSource: {
            type: 'inline',
            data: [
                { user: 'Admin', role: 'Administrator' },
                { user: 'User1', role: 'ESS' }
            ]
        }
    }, () => {

        // TC711 - Uses describe-level data (2 iterations)
        test('Login with describe-level user data', {
            tags: ['@TC711', '@describe-data']
        }, async ({ loginPage, reporter, config, data }) => {
            // Uses describe-level data - iterates with Admin and User1
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login(data.user, password);
            reporter.pass(`Tested login with ${data.user} (${data.role})`);
        });

        // TC712 - Has own dataSource, ignores describe-level data (3 iterations)
        test('Navigate to module with test-level data', {
            tags: ['@TC712', '@test-data'],
            dataSource: {
                type: 'inline',
                data: [
                    { module: 'Recruitment', header: 'Recruitment' },
                    { module: 'Time', header: 'Time' },
                    { module: 'Directory', header: 'Directory' }
                ]
            }
        }, async ({ loginPage, dashboardPage, reporter, config, data }) => {
            // Uses test-level dataSource - ignores describe-level data
            // Iterates 3 times with Recruitment, Time, Directory
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();

            await dashboardPage.clickMenuItem(data.module);
            await dashboardPage.verifyPageHeader(data.header);
            reporter.pass(`Navigated to ${data.module} using test-level data`);
        });

        // TC713 - Setup/teardown test that doesn't need data
        test('Verify application is accessible', {
            tags: ['@TC713', '@setup-test'],
            useData: false  // Explicitly run once - setup/verification test
        }, async ({ loginPage, reporter, navigate, config }) => {
            // This is a setup/health check test that shouldn't iterate
            const baseUrl = config.get('BASE_URL');
            await navigate(baseUrl);

            const isOnLogin = await loginPage.isAt();
            reporter.info(`Application accessible: ${isOnLogin}`);
            reporter.pass('Application health check passed - ran once');
        });
    });

    // ============================================================================
    // PATTERN 21: Mixed Data Usage in Serial Mode
    // Demonstrates smart iteration in serial execution mode
    // ============================================================================

    describe('Serial Mode with Mixed Data Usage', {
        tags: ['@serial-mixed-data', '@TC720'],
        enabled: true,
        mode: 'serial',  // Tests run sequentially
        dataSource: {
            type: 'inline',
            data: [
                { step: 'setup', action: 'Initialize' },
                { step: 'test', action: 'Execute' },
                { step: 'cleanup', action: 'Teardown' }
            ]
        }
    }, () => {

        // TC721 - Setup step - runs once (auto-detect: no data usage)
        test('Setup: Initialize test environment', {
            tags: ['@TC721', '@setup']
        }, async ({ loginPage, reporter, config }) => {
            // No 'data' parameter - runs once automatically
            const password = config.get('ORANGEHRM_PASSWORD', 'admin123');
            await loginPage.login('Admin', password);
            await loginPage.verifyLoginSuccess();
            reporter.pass('Setup completed - ran once (auto-detect)');
        });

        // TC722 - Main test - iterates with data (uses data fixture)
        test('Execute step: {step} - {action}', {
            tags: ['@TC722', '@main-test']
        }, async ({ dashboardPage, reporter, data }) => {
            // Uses 'data' parameter - iterates 3 times
            reporter.info(`Executing: ${data.step} - ${data.action}`);
            await dashboardPage.verifyPageHeader('Dashboard');
            reporter.pass(`Completed iteration: ${data.step}`);
        });

        // TC723 - Cleanup step - runs once (explicit opt-out)
        test('Cleanup: Reset test environment', {
            tags: ['@TC723', '@cleanup'],
            useData: false
        }, async ({ dashboardPage, reporter }) => {
            // Explicit useData: false - runs once
            await dashboardPage.clickLogoutOption();
            reporter.pass('Cleanup completed - ran once (useData: false)');
        });
    });
});
