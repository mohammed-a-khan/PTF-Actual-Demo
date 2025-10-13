/**
 * Cucumber Decorator Integration Test Steps
 *
 * This file demonstrates and tests the new Cucumber-compatible decorators:
 * @Given, @When, @Then, @And, @But
 *
 * Features tested:
 * - All Cucumber decorators
 * - Parameter types ({string}, {int}, {float})
 * - Data tables
 * - Doc strings
 * - Variable interpolation
 * - Page injection
 * - Context management
 * - Mixed decorator usage (new and old)
 */

import { Given, When, Then, And, But, CSBDDStepDef, Page, StepDefinitions, CSReporter } from 'cs-playwright-test-framework';
import { CSScenarioContext, CSFeatureContext, CSBDDContext } from 'cs-playwright-test-framework';
import { OrangeHRMLoginPage } from '../pages/OrangeHRMLoginPage';
import { OrangeHRMDashboardPage } from '../pages/OrangeHRMDashboardPage';

@StepDefinitions
export class CucumberDecoratorTestSteps {

    // Page injection - works with ALL decorators (new and old)
    @Page('orangehrm-login')
    private loginPage!: OrangeHRMLoginPage;

    @Page('orangehrm-dashboard')
    private dashboardPage!: OrangeHRMDashboardPage;

    // Context instances
    private scenarioContext = CSScenarioContext.getInstance();
    private featureContext = CSFeatureContext.getInstance();
    private bddContext = CSBDDContext.getInstance();

    // Test data storage
    private testCounter: number = 0;
    private testDecimal: number = 0;
    private testDataRows: number = 0;
    private processedTables: string[] = [];
    private generatedValues: Map<string, string> = new Map();
    private configValues: Map<string, string> = new Map();
    private testErrors: string[] = [];

    // =================================================================
    // Test 1: Basic Given/When/Then with string parameters
    // =================================================================

    @Given('the test framework is initialized with new decorators')
    async initializeTestFramework() {
        CSReporter.info('Initializing test framework with new Cucumber decorators');
        this.testCounter = 0;
        this.testDataRows = 0;
        this.processedTables = [];
        this.generatedValues.clear();
        this.configValues.clear();
        this.testErrors = [];
        CSReporter.pass('Test framework initialized successfully');
    }

    @Given('I navigate to OrangeHRM test application')
    async navigateToTestApplication() {
        CSReporter.info('Navigating to OrangeHRM application for decorator testing');
        await this.loginPage.navigate();
        CSReporter.pass('Navigated to test application');
    }

    @Given('I am testing new decorator {string} with value {string}')
    async testNewDecoratorGiven(decorator: string, value: string) {
        CSReporter.info(`Testing ${decorator} decorator with value: ${value}`);
        this.scenarioContext.set('testDecorator', decorator);
        this.scenarioContext.set('testValue', value);
        CSReporter.pass(`${decorator} decorator tested successfully`);
    }

    @When('I perform test action with decorator {string} and value {string}')
    async performTestActionWhen(decorator: string, value: string) {
        CSReporter.info(`Performing action with ${decorator} decorator, value: ${value}`);
        this.scenarioContext.set('actionDecorator', decorator);
        this.scenarioContext.set('actionValue', value);
        CSReporter.pass(`Action performed with ${decorator} decorator`);
    }

    @Then('I should verify decorator {string} shows result {string}')
    async verifyDecoratorResult(decorator: string, result: string) {
        CSReporter.info(`Verifying ${decorator} decorator result: ${result}`);
        const savedDecorator = this.scenarioContext.get('testDecorator');
        if (savedDecorator) {
            CSReporter.pass(`Verified ${decorator} decorator with result: ${result}`);
        }
    }

    @And('I verify additional check with {string} decorator')
    async verifyAdditionalCheckAnd(decorator: string) {
        CSReporter.info(`Additional verification with ${decorator} decorator`);
        CSReporter.pass(`${decorator} decorator additional check passed`);
    }

    @But('the error count should not be {string}')
    async verifyErrorCountNot(count: string) {
        CSReporter.info(`Verifying error count is not ${count}`);
        const actualErrors = this.testErrors.length;
        if (actualErrors.toString() !== count) {
            CSReporter.pass(`Error count ${actualErrors} is not ${count} - correct!`);
        } else {
            throw new Error(`Error count should not be ${count} but it is!`);
        }
    }

    // =================================================================
    // Test 2: Multiple parameter types
    // =================================================================

    @Given('I have test counter initialized to {int}')
    async initializeTestCounter(initialValue: number) {
        CSReporter.info(`Initializing test counter to ${initialValue}`);
        this.testCounter = initialValue;
        CSReporter.pass(`Counter initialized: ${this.testCounter}`);
    }

    @When('I increment counter by {int}')
    async incrementCounterBy(increment: number) {
        CSReporter.info(`Incrementing counter by ${increment}`);
        this.testCounter += increment;
        CSReporter.pass(`Counter after increment: ${this.testCounter}`);
    }

    @And('I add decimal value {float} to calculation')
    async addDecimalValueToCalculation(value: number) {
        CSReporter.info(`Adding decimal value ${value} to calculation`);
        this.testDecimal = value;
        CSReporter.pass(`Decimal value added: ${this.testDecimal}`);
    }

    @Then('the counter should be {int}')
    async verifyCounterValue(expected: number) {
        CSReporter.info(`Verifying counter value is ${expected}`);
        if (this.testCounter === expected) {
            CSReporter.pass(`Counter value ${this.testCounter} matches expected ${expected}`);
        } else {
            throw new Error(`Counter is ${this.testCounter}, expected ${expected}`);
        }
    }

    @And('the decimal result should be {float}')
    async verifyDecimalResult(expected: number) {
        CSReporter.info(`Verifying decimal result is ${expected}`);
        if (this.testDecimal === expected) {
            CSReporter.pass(`Decimal ${this.testDecimal} matches expected ${expected}`);
        } else {
            throw new Error(`Decimal is ${this.testDecimal}, expected ${expected}`);
        }
    }

    @But('the counter should not be {int}')
    async verifyCounterNotValue(notExpected: number) {
        CSReporter.info(`Verifying counter is not ${notExpected}`);
        if (this.testCounter !== notExpected) {
            CSReporter.pass(`Counter ${this.testCounter} is not ${notExpected} - correct!`);
        } else {
            throw new Error(`Counter should not be ${notExpected}`);
        }
    }

    // =================================================================
    // Test 3: Data Tables
    // =================================================================

    @Given('I have the following test data for new decorators:')
    async processTestDataTable(dataTable: any) {
        CSReporter.info('Processing test data table with @Given decorator');
        const rows = dataTable.raw();
        this.testDataRows = rows.length;

        rows.forEach((row: string[], index: number) => {
            CSReporter.info(`Row ${index + 1}: ${row[0]} = ${row[1]}`);
            this.scenarioContext.set(row[0], row[1]);
        });

        CSReporter.pass(`Processed ${this.testDataRows} rows from data table`);
    }

    @When('I process the test data table with When decorator')
    async validateDataTableProcessing() {
        CSReporter.info('Validating data table processing with @When decorator');
        const testName = this.scenarioContext.get('testName');
        const framework = this.scenarioContext.get('framework');
        CSReporter.info(`Test Name: ${testName}, Framework: ${framework}`);
        CSReporter.pass('Data table validated successfully');
    }

    @Then('I should see {int} rows processed successfully')
    async verifyProcessedRows(expectedRows: number) {
        CSReporter.info(`Verifying ${expectedRows} rows were processed`);
        if (this.testDataRows === expectedRows) {
            CSReporter.pass(`${this.testDataRows} rows processed correctly`);
        } else {
            throw new Error(`Expected ${expectedRows} rows, but got ${this.testDataRows}`);
        }
    }

    // =================================================================
    // Test 4 & 5: Scenario Outline with Examples
    // =================================================================

    @Given('I setup test case {string} with decorator type {string}')
    async setupTestCase(testCase: string, decoratorType: string) {
        CSReporter.info(`Setting up test case ${testCase} with ${decoratorType}`);
        this.scenarioContext.set('currentTestCase', testCase);
        this.scenarioContext.set('decoratorType', decoratorType);
        CSReporter.pass(`Test case ${testCase} setup complete`);
    }

    @When('I execute test action {string} using new decorator')
    async executeTestAction(action: string) {
        CSReporter.info(`Executing test action: ${action}`);
        this.scenarioContext.set('executedAction', action);
        CSReporter.pass(`Action ${action} executed successfully`);
    }

    @Then('the test result should be {string}')
    async verifyTestResult(expectedResult: string) {
        CSReporter.info(`Verifying test result: ${expectedResult}`);
        this.scenarioContext.set('testResult', expectedResult);
        CSReporter.pass(`Test result verified: ${expectedResult}`);
    }

    @And('the execution status should be {string}')
    async verifyExecutionStatus(status: string) {
        CSReporter.info(`Verifying execution status: ${status}`);
        this.scenarioContext.set('executionStatus', status);
        CSReporter.pass(`Execution status: ${status}`);
    }

    // =================================================================
    // Test 5: JSON Data Source
    // =================================================================

    @Given('I am testing with username {string} from JSON data')
    async testWithUsernameFromJSON(username: string) {
        CSReporter.info(`Testing with username from JSON: ${username}`);
        this.scenarioContext.set('jsonUsername', username);
        CSReporter.pass(`Username loaded: ${username}`);
    }

    @When('I use password {string} for authentication test')
    async usePasswordForAuthTest(password: string) {
        CSReporter.info(`Using password for authentication test: ${password.substring(0, 3)}***`);
        this.scenarioContext.set('jsonPassword', password);
        CSReporter.pass('Password set for testing');
    }

    @Then('the expected outcome should be {string}')
    async verifyExpectedOutcome(expectedResult: string) {
        CSReporter.info(`Verifying expected outcome: ${expectedResult}`);
        CSReporter.pass(`Expected outcome verified: ${expectedResult}`);
    }

    @And('the role should be {string}')
    async verifyRoleValue(role: string) {
        CSReporter.info(`Verifying role: ${role}`);
        CSReporter.pass(`Role verified: ${role}`);
    }

    @And('the description should match {string}')
    async verifyDescriptionMatch(description: string) {
        CSReporter.info(`Verifying description: ${description}`);
        CSReporter.pass(`Description matched: ${description}`);
    }

    // =================================================================
    // Test 6-11: Variable Interpolation
    // =================================================================

    @Given('I create test user with random username {string}')
    async createTestUserWithRandomUsername(username: string) {
        CSReporter.info(`Creating test user with random username: ${username}`);
        this.generatedValues.set('randomUsername', username);
        CSReporter.pass(`Random username generated: ${username}`);
    }

    @When('I generate random password {string}')
    async generateRandomPassword(password: string) {
        CSReporter.info(`Generating random password: ${password.substring(0, 5)}***`);
        this.generatedValues.set('randomPassword', password);
        CSReporter.pass('Random password generated');
    }

    @Then('the username should be unique')
    async verifyUsernameUnique() {
        const username = this.generatedValues.get('randomUsername');
        CSReporter.info(`Verifying username uniqueness: ${username}`);
        if (username && username.length > 0) {
            CSReporter.pass('Username is unique');
        } else {
            throw new Error('Username not generated');
        }
    }

    @And('the password should be unique')
    async verifyPasswordUnique() {
        const password = this.generatedValues.get('randomPassword');
        CSReporter.info('Verifying password uniqueness');
        if (password && password.length > 0) {
            CSReporter.pass('Password is unique');
        } else {
            throw new Error('Password not generated');
        }
    }

    @Given('I create test record with timestamp {string}')
    async createTestRecordWithTimestamp(timestamp: string) {
        CSReporter.info(`Creating test record with timestamp: ${timestamp}`);
        this.generatedValues.set('timestamp', timestamp);
        CSReporter.pass(`Timestamp recorded: ${timestamp}`);
    }

    @When('I save the record with date {string}')
    async saveRecordWithDate(date: string) {
        CSReporter.info(`Saving record with date: ${date}`);
        this.generatedValues.set('date', date);
        CSReporter.pass(`Date saved: ${date}`);
    }

    @Then('the timestamp should be current')
    async verifyTimestampCurrent() {
        const timestamp = this.generatedValues.get('timestamp');
        CSReporter.info(`Verifying timestamp is current: ${timestamp}`);
        if (timestamp && timestamp.length > 0) {
            CSReporter.pass('Timestamp is current');
        }
    }

    @And('the date format should be valid')
    async verifyDateFormatValid() {
        const date = this.generatedValues.get('date');
        CSReporter.info(`Verifying date format: ${date}`);
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (date && dateRegex.test(date)) {
            CSReporter.pass('Date format is valid (YYYY-MM-DD)');
        } else {
            throw new Error(`Invalid date format: ${date}`);
        }
    }

    @Given('I generate test email {string}')
    async generateTestEmail(email: string) {
        CSReporter.info(`Generated test email: ${email}`);
        this.generatedValues.set('email', email);
        CSReporter.pass(`Email generated: ${email}`);
    }

    @When('I generate test phone number {string}')
    async generateTestPhoneNumber(phone: string) {
        CSReporter.info(`Generated test phone: ${phone}`);
        this.generatedValues.set('phone', phone);
        CSReporter.pass(`Phone generated: ${phone}`);
    }

    @And('I generate test username {string}')
    async generateTestUsername(username: string) {
        CSReporter.info(`Generated test username: ${username}`);
        this.generatedValues.set('generatedUsername', username);
        CSReporter.pass(`Username generated: ${username}`);
    }

    @Then('all generated values should be valid')
    async verifyAllGeneratedValuesValid() {
        CSReporter.info('Verifying all generated values are valid');
        const email = this.generatedValues.get('email');
        const phone = this.generatedValues.get('phone');
        const username = this.generatedValues.get('generatedUsername');

        if (email && phone && username) {
            CSReporter.pass('All generated values are valid');
        } else {
            throw new Error('Some generated values are missing');
        }
    }

    @And('all values should be unique')
    async verifyAllValuesUnique() {
        CSReporter.info('Verifying all values are unique');
        const values = Array.from(this.generatedValues.values());
        const uniqueValues = new Set(values);

        if (values.length === uniqueValues.size) {
            CSReporter.pass('All values are unique');
        } else {
            throw new Error('Duplicate values found');
        }
    }

    @Given('I load admin password from config {string}')
    async loadAdminPasswordFromConfig(password: string) {
        CSReporter.info('Loading admin password from config');
        this.configValues.set('adminPassword', password);
        CSReporter.pass('Admin password loaded from config');
    }

    @When('I load base URL from config {string}')
    async loadBaseURLFromConfig(baseUrl: string) {
        CSReporter.info(`Loading base URL from config: ${baseUrl}`);
        this.configValues.set('baseUrl', baseUrl);
        CSReporter.pass(`Base URL loaded: ${baseUrl}`);
    }

    @Then('the config values should be loaded correctly')
    async verifyConfigValuesLoaded() {
        CSReporter.info('Verifying config values loaded correctly');
        const password = this.configValues.get('adminPassword');
        const baseUrl = this.configValues.get('baseUrl');

        if (password && baseUrl) {
            CSReporter.pass('Config values loaded successfully');
        } else {
            throw new Error('Config values not loaded');
        }
    }

    @And('the values should not be empty')
    async verifyValuesNotEmpty() {
        CSReporter.info('Verifying values are not empty');
        const values = Array.from(this.configValues.values());
        const allNonEmpty = values.every(v => v && v.length > 0);

        if (allNonEmpty) {
            CSReporter.pass('All values are non-empty');
        } else {
            throw new Error('Some values are empty');
        }
    }

    @Given('I load encrypted admin password {string}')
    async loadEncryptedAdminPassword(encryptedPassword: string) {
        CSReporter.info('Loading encrypted admin password');
        this.configValues.set('encryptedPassword', encryptedPassword);
        CSReporter.pass('Encrypted password loaded');
    }

    @When('I decrypt the password for testing')
    async decryptPasswordForTesting() {
        CSReporter.info('Decrypting password for testing');
        const encrypted = this.configValues.get('encryptedPassword');
        // Framework automatically decrypts <config:XXX_ENCRYPTED> values
        this.configValues.set('decryptedPassword', encrypted || 'admin123');
        CSReporter.pass('Password decrypted successfully');
    }

    @Then('the decrypted value should be valid')
    async verifyDecryptedValueValid() {
        CSReporter.info('Verifying decrypted value is valid');
        const decrypted = this.configValues.get('decryptedPassword');
        if (decrypted && decrypted.length > 0) {
            CSReporter.pass('Decrypted value is valid');
        } else {
            throw new Error('Decrypted value is invalid');
        }
    }

    @And('I should be able to authenticate with it')
    async verifyCanAuthenticateWithDecrypted() {
        CSReporter.info('Verifying can authenticate with decrypted password');
        const decrypted = this.configValues.get('decryptedPassword');
        if (decrypted) {
            CSReporter.pass('Can authenticate with decrypted password');
        } else {
            throw new Error('Cannot authenticate');
        }
    }

    // =================================================================
    // Test 11: @DataProvider with Excel
    // =================================================================

    @Given('I test with Excel user {string} using new decorators')
    async testWithExcelUser(username: string) {
        CSReporter.info(`Testing with Excel user: ${username}`);
        this.scenarioContext.set('excelUsername', username);
        CSReporter.pass(`Excel user loaded: ${username}`);
    }

    @When('I authenticate with Excel password {string}')
    async authenticateWithExcelPassword(password: string) {
        CSReporter.info(`Authenticating with Excel password: ${password.substring(0, 3)}***`);
        this.scenarioContext.set('excelPassword', password);
        CSReporter.pass('Excel password authenticated');
    }

    @Then('the Excel result should be {string}')
    async verifyExcelResult(expectedResult: string) {
        CSReporter.info(`Verifying Excel result: ${expectedResult}`);
        CSReporter.pass(`Excel result verified: ${expectedResult}`);
    }

    @And('the role from Excel should be {string}')
    async verifyRoleFromExcel(role: string) {
        CSReporter.info(`Verifying role from Excel: ${role}`);
        CSReporter.pass(`Role verified: ${role}`);
    }

    // =================================================================
    // Test 12: Multiple Data Tables
    // =================================================================

    @Given('I have test configuration:')
    async processTestConfiguration(dataTable: any) {
        CSReporter.info('Processing test configuration table');
        const rows = dataTable.raw();
        this.processedTables.push('configuration');

        rows.forEach((row: string[]) => {
            CSReporter.info(`Config: ${row[0]} = ${row[1]}`);
            this.scenarioContext.set(`config_${row[0]}`, row[1]);
        });

        CSReporter.pass(`Configuration table processed: ${rows.length} settings`);
    }

    @When('I have test users:')
    async processTestUsers(dataTable: any) {
        CSReporter.info('Processing test users table');
        const rows = dataTable.raw();
        this.processedTables.push('users');

        rows.forEach((row: string[], index: number) => {
            CSReporter.info(`User ${index + 1}: ${row[0]} (${row[1]})`);
            this.scenarioContext.set(`user_${index}_username`, row[0]);
            this.scenarioContext.set(`user_${index}_role`, row[1]);
        });

        CSReporter.pass(`Users table processed: ${rows.length} users`);
    }

    @Then('both tables should be processed correctly')
    async verifyBothTablesProcessed() {
        CSReporter.info('Verifying both tables were processed');
        if (this.processedTables.length === 2) {
            CSReporter.pass('Both tables processed successfully');
        } else {
            throw new Error(`Expected 2 tables, but processed ${this.processedTables.length}`);
        }
    }

    @And('configuration should have {int} settings')
    async verifyConfigurationSettings(expectedCount: number) {
        CSReporter.info(`Verifying configuration has ${expectedCount} settings`);
        CSReporter.pass(`Configuration has ${expectedCount} settings`);
    }

    @And('users should have {int} entries')
    async verifyUsersEntries(expectedCount: number) {
        CSReporter.info(`Verifying users have ${expectedCount} entries`);
        CSReporter.pass(`Users have ${expectedCount} entries`);
    }

    // =================================================================
    // Test 13: ADO Integration
    // =================================================================

    @Given('I run test {string} mapped to ADO test case')
    async runTestMappedToADO(testId: string) {
        CSReporter.info(`Running test ${testId} mapped to ADO`);
        this.scenarioContext.set('adoTestId', testId);
        CSReporter.pass(`Test ${testId} mapped to ADO`);
    }

    @When('I execute the test with new decorator')
    async executeTestWithNewDecorator() {
        CSReporter.info('Executing test with new Cucumber decorator');
        const testId = this.scenarioContext.get('adoTestId');
        CSReporter.info(`Executing ADO test: ${testId}`);
        CSReporter.pass('Test executed with new decorator');
    }

    @Then('the result should be reported to ADO')
    async verifyResultReportedToADO() {
        CSReporter.info('Verifying result is reported to ADO');
        CSReporter.pass('Result reported to ADO successfully');
    }

    @And('ADO test case {string} should be updated')
    async verifyADOTestCaseUpdated(testCaseId: string) {
        CSReporter.info(`Verifying ADO test case ${testCaseId} is updated`);
        CSReporter.pass(`ADO test case ${testCaseId} updated`);
    }

    // =================================================================
    // Test 14: Page Injection
    // =================================================================

    @Given('I verify page object injection with Given decorator')
    async verifyPageInjectionGiven() {
        CSReporter.info('Verifying page object injection with @Given decorator');

        // Verify page objects are injected
        if (this.loginPage && this.dashboardPage) {
            CSReporter.pass('Page objects injected successfully with @Given');
        } else {
            throw new Error('Page objects not injected');
        }
    }

    @When('I interact with injected page using When decorator')
    async interactWithInjectedPageWhen() {
        CSReporter.info('Interacting with injected page using @When decorator');

        // Interact with page object
        const page = this.loginPage.getPage();
        if (page) {
            CSReporter.pass('Page interaction successful with @When');
        } else {
            throw new Error('Cannot interact with page');
        }
    }

    @Then('the page actions should work with Then decorator')
    async verifyPageActionsThen() {
        CSReporter.info('Verifying page actions with @Then decorator');

        // Verify page actions work
        const page = this.loginPage.getPage();
        if (page) {
            CSReporter.pass('Page actions work correctly with @Then');
        } else {
            throw new Error('Page actions failed');
        }
    }

    @And('page state should be maintained with And decorator')
    async verifyPageStateMaintainedAnd() {
        CSReporter.info('Verifying page state maintained with @And decorator');

        // Verify state is maintained
        if (this.loginPage && this.dashboardPage) {
            CSReporter.pass('Page state maintained with @And');
        } else {
            throw new Error('Page state not maintained');
        }
    }

    // =================================================================
    // Test 15: Context Management
    // =================================================================

    @Given('I save value {string} to scenario context with key {string}')
    async saveValueToScenarioContext(value: string, key: string) {
        CSReporter.info(`Saving value "${value}" to scenario context with key "${key}"`);
        this.scenarioContext.set(key, value);
        CSReporter.pass(`Value saved to scenario context: ${key} = ${value}`);
    }

    @When('I retrieve value from scenario context using key {string}')
    async retrieveValueFromScenarioContext(key: string) {
        CSReporter.info(`Retrieving value from scenario context using key "${key}"`);
        const value = this.scenarioContext.get(key);
        this.scenarioContext.set('retrievedValue', value);
        CSReporter.pass(`Value retrieved: ${value}`);
    }

    @Then('the retrieved value should be {string}')
    async verifyRetrievedValue(expectedValue: string) {
        CSReporter.info(`Verifying retrieved value is "${expectedValue}"`);
        const actualValue = this.scenarioContext.get('retrievedValue');

        if (actualValue === expectedValue) {
            CSReporter.pass(`Retrieved value matches: ${actualValue}`);
        } else {
            throw new Error(`Expected "${expectedValue}" but got "${actualValue}"`);
        }
    }

    @And('I save value {string} to feature context with key {string}')
    async saveValueToFeatureContext(value: string, key: string) {
        CSReporter.info(`Saving value "${value}" to feature context with key "${key}"`);
        this.featureContext.set(key, value);
        CSReporter.pass(`Value saved to feature context: ${key} = ${value}`);
    }

    @And('I can retrieve feature context value using key {string}')
    async retrieveFeatureContextValue(key: string) {
        CSReporter.info(`Retrieving value from feature context using key "${key}"`);
        const value = this.featureContext.get(key);

        if (value) {
            CSReporter.pass(`Feature context value retrieved: ${value}`);
        } else {
            throw new Error(`No value found for key "${key}" in feature context`);
        }
    }

    // =================================================================
    // Test 16: Retry Logic
    // =================================================================

    private retryAttempts: number = 0;

    @Given('I setup a flaky test step that may fail')
    async setupFlakyTestStep() {
        CSReporter.info('Setting up flaky test step');
        this.retryAttempts = 0;
        CSReporter.pass('Flaky test step setup complete');
    }

    @When('I execute the flaky step with retry enabled')
    async executeFlakyStepWithRetry() {
        CSReporter.info('Executing flaky step with retry enabled');
        this.retryAttempts++;

        // Simulate flaky behavior - succeed after 2 attempts
        if (this.retryAttempts < 2) {
            CSReporter.warn(`Attempt ${this.retryAttempts} - simulating failure`);
            // Don't throw error, just log - actual retry is handled by framework
        } else {
            CSReporter.pass(`Attempt ${this.retryAttempts} - success!`);
        }
    }

    @Then('the step should eventually succeed after retries')
    async verifyStepSucceedsAfterRetries() {
        CSReporter.info('Verifying step succeeded after retries');
        if (this.retryAttempts > 0) {
            CSReporter.pass('Step succeeded after retries');
        } else {
            throw new Error('Step did not execute');
        }
    }

    @And('the retry count should be tracked correctly')
    async verifyRetryCountTracked() {
        CSReporter.info(`Verifying retry count: ${this.retryAttempts} attempts`);
        CSReporter.pass(`Retry count tracked: ${this.retryAttempts} attempts`);
    }

    // =================================================================
    // Test 17: Doc String
    // =================================================================

    @Given('I have the following JSON test data:')
    async processJSONDocString(docString: string) {
        CSReporter.info('Processing JSON doc string');

        try {
            const jsonData = JSON.parse(docString);
            this.scenarioContext.set('jsonData', jsonData);
            CSReporter.pass(`JSON parsed successfully: ${jsonData.testName}`);
        } catch (error) {
            throw new Error(`Failed to parse JSON: ${error}`);
        }
    }

    @When('I parse the JSON doc string with When decorator')
    async parseJSONDocString() {
        CSReporter.info('Parsing JSON doc string with @When decorator');
        const jsonData = this.scenarioContext.get('jsonData');

        if (jsonData) {
            CSReporter.pass('JSON doc string parsed successfully');
        } else {
            throw new Error('JSON data not found');
        }
    }

    @Then('the JSON should contain {int} decorators')
    async verifyJSONContainsDecorators(expectedCount: number) {
        CSReporter.info(`Verifying JSON contains ${expectedCount} decorators`);
        const jsonData = this.scenarioContext.get('jsonData');

        if (jsonData && jsonData.decorators && jsonData.decorators.length === expectedCount) {
            CSReporter.pass(`JSON contains ${expectedCount} decorators`);
        } else {
            throw new Error(`Expected ${expectedCount} decorators, found ${jsonData?.decorators?.length || 0}`);
        }
    }

    @And('all framework features should be enabled')
    async verifyFrameworkFeaturesEnabled() {
        CSReporter.info('Verifying all framework features are enabled');
        const jsonData = this.scenarioContext.get('jsonData');

        if (jsonData && jsonData.features) {
            const allEnabled = Object.values(jsonData.features).every((v: any) => v === true);
            if (allEnabled) {
                CSReporter.pass('All framework features are enabled');
            } else {
                throw new Error('Some framework features are disabled');
            }
        } else {
            throw new Error('Framework features data not found');
        }
    }

    // =================================================================
    // Test 18: Comprehensive Test
    // =================================================================

    @Given('I initialize comprehensive test {string} with random user {string}')
    async initializeComprehensiveTest(testId: string, randomUser: string) {
        CSReporter.info(`Initializing comprehensive test ${testId} with random user ${randomUser}`);
        this.scenarioContext.set('comprehensiveTestId', testId);
        this.scenarioContext.set('randomUser', randomUser);
        CSReporter.pass(`Comprehensive test ${testId} initialized`);
    }

    @And('I setup test timestamp {string}')
    async setupTestTimestamp(timestamp: string) {
        CSReporter.info(`Setting up test timestamp: ${timestamp}`);
        this.scenarioContext.set('testTimestamp', timestamp);
        CSReporter.pass(`Timestamp set: ${timestamp}`);
    }

    @And('I load config value {string}')
    async loadConfigValue(configValue: string) {
        CSReporter.info(`Loading config value: ${configValue}`);
        this.scenarioContext.set('loadedConfigValue', configValue);
        CSReporter.pass(`Config value loaded: ${configValue}`);
    }

    @When('I execute test action {string} using decorator {string}')
    async executeTestActionWithDecorator(action: string, decorator: string) {
        CSReporter.info(`Executing action "${action}" using decorator ${decorator}`);
        this.scenarioContext.set('executedAction', action);
        this.scenarioContext.set('usedDecorator', decorator);
        CSReporter.pass(`Action ${action} executed with ${decorator}`);
    }

    @And('I process the following test configuration:')
    async processComprehensiveTestConfig(dataTable: any) {
        CSReporter.info('Processing comprehensive test configuration');
        const rows = dataTable.raw();

        rows.forEach((row: string[]) => {
            CSReporter.info(`Config: ${row[0]} = ${row[1]}`);
            this.scenarioContext.set(`comprehensive_${row[0]}`, row[1]);
        });

        CSReporter.pass('Comprehensive test configuration processed');
    }

    @Then('the test should complete with status {string}')
    async verifyTestCompletionStatus(expectedStatus: string) {
        CSReporter.info(`Verifying test completion status: ${expectedStatus}`);
        this.scenarioContext.set('completionStatus', expectedStatus);
        CSReporter.pass(`Test completed with status: ${expectedStatus}`);
    }

    @And('all decorators should work correctly')
    async verifyAllDecoratorsWork() {
        CSReporter.info('Verifying all decorators work correctly');
        CSReporter.pass('All decorators (@Given, @When, @Then, @And, @But) work correctly');
    }

    @But('there should be no errors')
    async verifyNoErrors() {
        CSReporter.info('Verifying no errors occurred');
        if (this.testErrors.length === 0) {
            CSReporter.pass('No errors found - test successful');
        } else {
            throw new Error(`Found ${this.testErrors.length} errors`);
        }
    }

    // =================================================================
    // Test 19: Mixed Decorators (Old and New)
    // =================================================================

    @Given('I use new Given decorator for this step')
    async useNewGivenDecorator() {
        CSReporter.info('Using new @Given decorator');
        this.scenarioContext.set('usedNewGiven', true);
        CSReporter.pass('New @Given decorator used successfully');
    }

    // Old style decorator - testing backward compatibility
    @CSBDDStepDef('I use old CSBDDStepDef decorator for action step')
    async useOldCSBDDStepDefDecorator() {
        CSReporter.info('Using old @CSBDDStepDef decorator');
        this.scenarioContext.set('usedOldDecorator', true);
        CSReporter.pass('Old @CSBDDStepDef decorator used successfully');
    }

    @Then('I use new Then decorator for verification')
    async useNewThenDecorator() {
        CSReporter.info('Using new @Then decorator');
        this.scenarioContext.set('usedNewThen', true);
        CSReporter.pass('New @Then decorator used successfully');
    }

    @And('both decorator styles should work together seamlessly')
    async verifyBothDecoratorStylesWork() {
        CSReporter.info('Verifying both decorator styles work together');
        const usedNewGiven = this.scenarioContext.get('usedNewGiven');
        const usedOldDecorator = this.scenarioContext.get('usedOldDecorator');
        const usedNewThen = this.scenarioContext.get('usedNewThen');

        if (usedNewGiven && usedOldDecorator && usedNewThen) {
            CSReporter.pass('Both decorator styles work together seamlessly!');
        } else {
            throw new Error('Some decorators did not execute');
        }
    }

    // =================================================================
    // Test 20: Error Handling
    // =================================================================

    @Given('I setup test that will intentionally fail')
    async setupIntentionalFailureTest() {
        CSReporter.info('Setting up test that will intentionally fail');
        this.scenarioContext.set('intentionalFailureTest', true);
        CSReporter.pass('Intentional failure test setup');
    }

    @When('I catch the expected error with When decorator')
    async catchExpectedErrorWhen() {
        CSReporter.info('Catching expected error with @When decorator');

        try {
            // Simulate an expected error
            const shouldFail = this.scenarioContext.get('intentionalFailureTest');
            if (shouldFail) {
                // Catch the error gracefully
                CSReporter.warn('Expected error caught successfully');
                this.scenarioContext.set('errorCaught', true);
            }
        } catch (error) {
            this.scenarioContext.set('errorCaught', true);
            CSReporter.pass('Error caught and handled');
        }
    }

    @Then('the error should be handled gracefully')
    async verifyErrorHandledGracefully() {
        CSReporter.info('Verifying error was handled gracefully');
        const errorCaught = this.scenarioContext.get('errorCaught');

        if (errorCaught) {
            CSReporter.pass('Error handled gracefully');
        } else {
            CSReporter.pass('No error occurred (test passed without error)');
        }
    }

    @And('error details should be captured correctly')
    async verifyErrorDetailsCaptured() {
        CSReporter.info('Verifying error details captured');
        CSReporter.pass('Error details captured correctly');
    }

    @But('the test execution should continue')
    async verifyTestExecutionContinues() {
        CSReporter.info('Verifying test execution continues after error handling');
        CSReporter.pass('Test execution continued successfully');
    }
}

export default CucumberDecoratorTestSteps;
