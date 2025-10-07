import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSBDDContext } from '../../bdd/CSBDDContext';
import { CSFeatureContext } from '../../bdd/CSFeatureContext';
import { CSScenarioContext } from '../../bdd/CSScenarioContext';
import { CSReporter } from '../../reporter/CSReporter';
import * as crypto from 'crypto';

/**
 * Common Step Definitions for Data Sharing and Context Management
 * These steps work across UI Testing, Database Testing, API Testing, etc.
 */
export class CSCommonSteps {
    private context: CSBDDContext;
    private featureContext: CSFeatureContext;
    private scenarioContext: CSScenarioContext;

    constructor() {
        this.context = CSBDDContext.getInstance();
        this.featureContext = CSFeatureContext.getInstance();
        this.scenarioContext = CSScenarioContext.getInstance();
    }

    // =================================================================
    // SAVING DATA TO CONTEXT - Works for any type of data
    // =================================================================

    /**
     * Saves a simple string value to the current scenario context
     * Example: Given user saves "john.doe" as "username"
     */
    @CSBDDStepDef("user saves {string} as {string}")
    async saveValue(value: string, variableName: string): Promise<void> {
        // Save to scenario context (available within current scenario)
        this.scenarioContext.set(variableName, value);
        CSReporter.pass(`Saved '${value}' as '${variableName}' in scenario context`);
    }

    /**
     * Saves a value to the feature context (available across scenarios in the same feature)
     * Example: Given user saves "john.doe" as "username" in feature context
     */
    @CSBDDStepDef("user saves {string} as {string} in feature context")
    async saveValueToFeature(value: string, variableName: string): Promise<void> {
        // Save to feature context (available across all scenarios in this feature)
        this.featureContext.set(variableName, value);
        CSReporter.pass(`Saved '${value}' as '${variableName}' in feature context`);
    }

    /**
     * Saves a value to the world context (available globally)
     * Example: Given user saves "john.doe" as "username" globally
     */
    @CSBDDStepDef("user saves {string} as {string} globally")
    async saveValueGlobally(value: string, variableName: string): Promise<void> {
        // Save to world data (available everywhere)
        this.context.set(variableName, value);
        CSReporter.pass(`Saved '${value}' as '${variableName}' globally`);
    }

    // =================================================================
    // SAVING COMPLEX DATA TYPES
    // =================================================================

    /**
     * Saves a data table as a Map to context (for 2-column key-value tables)
     * Example:
     * Given user saves the following data as "userInfo":
     *   | firstName | John |
     *   | lastName  | Doe  |
     *   | email     | john@example.com |
     */
    @CSBDDStepDef("user saves the following data as {string}:")
    async saveDataTable(variableName: string, dataTable: any): Promise<void> {
        const rows = dataTable.raw();

        // Check if this is a multi-column table with headers
        if (rows.length > 0 && rows[0].length > 2) {
            // Multi-column table - treat first row as headers
            const headers = rows[0];
            const dataArray: Record<string, any>[] = [];

            // Convert each row to an object
            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                const rowObject: Record<string, any> = {};

                for (let j = 0; j < headers.length && j < row.length; j++) {
                    rowObject[headers[j]] = row[j];
                }

                dataArray.push(rowObject);
            }

            this.scenarioContext.set(variableName, dataArray);
            CSReporter.pass(`Saved data table with ${dataArray.length} rows and ${headers.length} columns as '${variableName}'`);
        } else {
            // Two-column table - treat as key-value pairs
            const dataMap = new Map<string, string>();

            for (const row of rows) {
                if (row.length >= 2) {
                    dataMap.set(row[0], row[1]);
                }
            }

            this.scenarioContext.set(variableName, dataMap);
            CSReporter.pass(`Saved data table with ${dataMap.size} key-value pairs as '${variableName}'`);
        }
    }

    /**
     * Saves a multi-column table with headers as array of objects
     * Example:
     * Given user saves the following table as "products":
     *   | productId | productName | price | quantity |
     *   | PROD-001  | Laptop      | 999   | 5        |
     *   | PROD-002  | Mouse       | 25    | 10       |
     */
    @CSBDDStepDef("user saves the following table as {string}:")
    async saveTableWithHeaders(variableName: string, dataTable: any): Promise<void> {
        const rows = dataTable.raw();

        if (rows.length < 2) {
            throw new Error('Table must have headers and at least one data row');
        }

        const headers = rows[0];
        const dataArray: Record<string, any>[] = [];

        // Convert each row to an object using headers as keys
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const rowObject: Record<string, any> = {};

            for (let j = 0; j < headers.length && j < row.length; j++) {
                rowObject[headers[j]] = row[j];
            }

            dataArray.push(rowObject);
        }

        this.scenarioContext.set(variableName, dataArray);
        CSReporter.pass(`Saved table with ${dataArray.length} rows as '${variableName}'`);
    }

    /**
     * Saves a single row from a table as an object
     * Example:
     * Given user saves the following record as "user":
     *   | firstName | lastName | email            | age |
     *   | John      | Doe      | john@example.com | 30  |
     */
    @CSBDDStepDef("user saves the following record as {string}:")
    async saveRecord(variableName: string, dataTable: any): Promise<void> {
        const rows = dataTable.raw();

        if (rows.length !== 2) {
            throw new Error('Record table must have exactly one header row and one data row');
        }

        const headers = rows[0];
        const values = rows[1];
        const record: Record<string, any> = {};

        for (let i = 0; i < headers.length && i < values.length; i++) {
            record[headers[i]] = values[i];
        }

        this.scenarioContext.set(variableName, record);
        CSReporter.pass(`Saved record with ${Object.keys(record).length} fields as '${variableName}'`);
    }

    /**
     * Saves a JSON object to context
     * Example:
     * Given user saves the following JSON as "config":
     *   """
     *   {
     *     "url": "https://example.com",
     *     "timeout": 30000,
     *     "retries": 3
     *   }
     *   """
     */
    @CSBDDStepDef("user saves the following JSON as {string}:")
    async saveJSON(variableName: string, jsonString: string): Promise<void> {
        try {
            const jsonObject = JSON.parse(jsonString);
            this.scenarioContext.set(variableName, jsonObject);
            CSReporter.pass(`Saved JSON object as '${variableName}'`);
        } catch (error) {
            CSReporter.fail(`Failed to parse JSON: ${error}`);
            throw error;
        }
    }

    /**
     * Saves an array/list to context
     * Example:
     * Given user saves the following list as "productIds":
     *   | PROD-001 |
     *   | PROD-002 |
     *   | PROD-003 |
     */
    @CSBDDStepDef("user saves the following list as {string}:")
    async saveList(variableName: string, dataTable: any): Promise<void> {
        const list: string[] = [];

        const rows = dataTable.raw();
        for (const row of rows) {
            if (row.length > 0) {
                list.push(row[0]);
            }
        }

        this.scenarioContext.set(variableName, list);
        CSReporter.pass(`Saved list with ${list.length} items as '${variableName}'`);
    }

    // =================================================================
    // UI TESTING - CAPTURING VALUES FROM PAGE
    // =================================================================

    /**
     * Captures text from an element and saves it to context
     * Example: Given user captures text from "#order-id" and saves as "orderId"
     */
    @CSBDDStepDef("user captures text from {string} and saves as {string}")
    async captureElementText(selector: string, variableName: string): Promise<void> {
        const page = this.context.page;
        const element = page.locator(selector);
        const text = await element.textContent();

        this.scenarioContext.set(variableName, text?.trim() || '');
        CSReporter.pass(`Captured text '${text}' from '${selector}' and saved as '${variableName}'`);
    }

    /**
     * Captures value from input field and saves it
     * Example: Given user captures value from "#username-input" and saves as "enteredUsername"
     */
    @CSBDDStepDef("user captures value from {string} and saves as {string}")
    async captureInputValue(selector: string, variableName: string): Promise<void> {
        const page = this.context.page;
        const element = page.locator(selector);
        const value = await element.inputValue();

        this.scenarioContext.set(variableName, value);
        CSReporter.pass(`Captured value '${value}' from '${selector}' and saved as '${variableName}'`);
    }

    /**
     * Captures attribute value and saves it
     * Example: Given user captures "href" attribute from "#link" and saves as "linkUrl"
     */
    @CSBDDStepDef("user captures {string} attribute from {string} and saves as {string}")
    async captureAttribute(attribute: string, selector: string, variableName: string): Promise<void> {
        const page = this.context.page;
        const element = page.locator(selector);
        const value = await element.getAttribute(attribute);

        this.scenarioContext.set(variableName, value || '');
        CSReporter.pass(`Captured ${attribute}='${value}' from '${selector}' and saved as '${variableName}'`);
    }

    /**
     * Captures current URL and saves it
     * Example: Given user captures current URL and saves as "currentPage"
     */
    @CSBDDStepDef("user captures current URL and saves as {string}")
    async captureCurrentURL(variableName: string): Promise<void> {
        const url = this.context.page.url();
        this.scenarioContext.set(variableName, url);
        CSReporter.pass(`Captured URL '${url}' and saved as '${variableName}'`);
    }

    /**
     * Captures all text from multiple elements
     * Example: Given user captures all text from ".product-name" and saves as "productNames"
     */
    @CSBDDStepDef("user captures all text from {string} and saves as {string}")
    async captureAllText(selector: string, variableName: string): Promise<void> {
        const page = this.context.page;
        const elements = page.locator(selector);
        const texts = await elements.allTextContents();

        this.scenarioContext.set(variableName, texts);
        CSReporter.pass(`Captured ${texts.length} text values from '${selector}' and saved as '${variableName}'`);
    }

    // =================================================================
    // DATABASE TESTING - CAPTURING QUERY RESULTS
    // =================================================================

    /**
     * Saves database query result to context
     * Example: Given user saves query result as "users"
     * (Assumes query was executed in previous step)
     */
    @CSBDDStepDef("user saves query result as {string}")
    async saveQueryResult(variableName: string): Promise<void> {
        // Get the last query result from context
        const result = this.scenarioContext.get('lastQueryResult');
        if (!result) {
            throw new Error('No query result available. Execute a query first.');
        }

        this.scenarioContext.set(variableName, result);
        CSReporter.pass(`Saved query result as '${variableName}'`);
    }

    /**
     * Saves a specific column value from first row
     * Example: Given user saves column "user_id" from result as "userId"
     */
    @CSBDDStepDef("user saves column {string} from result as {string}")
    async saveColumnValue(columnName: string, variableName: string): Promise<void> {
        const result = this.scenarioContext.get('lastQueryResult') as any[];
        if (!result || result.length === 0) {
            throw new Error('No query result available');
        }

        const value = result[0][columnName];
        this.scenarioContext.set(variableName, value);
        CSReporter.pass(`Saved ${columnName}='${value}' as '${variableName}'`);
    }

    // =================================================================
    // USING SAVED DATA - Works everywhere
    // =================================================================

    /**
     * Uses saved value in any step
     * Examples:
     * - When user enters "{{username}}" in "#username-input"
     * - Then user verifies text contains "{{orderId}}"
     * - When user queries database for user "{{userId}}"
     *
     * The framework automatically resolves {{variableName}} patterns!
     */

    /**
     * Explicitly retrieve and use a saved value
     * Example: When user uses saved value "username"
     */
    @CSBDDStepDef("user uses saved value {string}")
    async useSavedValue(variableName: string): Promise<void> {
        // Try different contexts in order: scenario -> feature -> world
        let value = this.scenarioContext.get(variableName);

        if (value === undefined) {
            value = this.featureContext.get(variableName);
        }

        if (value === undefined) {
            value = this.context.get(variableName);
        }

        if (value === undefined) {
            throw new Error(`Variable '${variableName}' not found in any context`);
        }

        CSReporter.pass(`Retrieved value for '${variableName}': ${JSON.stringify(value)}`);
        return value;
    }

    // =================================================================
    // UTILITY GENERATORS
    // =================================================================

    /**
     * Generates UUID and saves it
     * Example: Given user generates UUID and saves as "sessionId"
     */
    @CSBDDStepDef("user generates UUID and saves as {string}")
    async generateUUID(variableName: string): Promise<void> {
        const uuid = crypto.randomUUID();
        this.scenarioContext.set(variableName, uuid);
        CSReporter.pass(`Generated UUID '${uuid}' and saved as '${variableName}'`);
    }

    /**
     * Generates timestamp and saves it
     * Example: Given user generates timestamp and saves as "startTime"
     */
    @CSBDDStepDef("user generates timestamp and saves as {string}")
    async generateTimestamp(variableName: string): Promise<void> {
        const timestamp = Date.now();
        this.scenarioContext.set(variableName, timestamp);
        CSReporter.pass(`Generated timestamp '${timestamp}' and saved as '${variableName}'`);
    }

    /**
     * Generates random number and saves it
     * Example: Given user generates random number between 1000 and 9999 and saves as "orderId"
     */
    @CSBDDStepDef("user generates random number between {int} and {int} and saves as {string}")
    async generateRandomNumber(min: number, max: number, variableName: string): Promise<void> {
        const randomNum = Math.floor(Math.random() * (max - min + 1)) + min;
        this.scenarioContext.set(variableName, randomNum);
        CSReporter.pass(`Generated random number '${randomNum}' and saved as '${variableName}'`);
    }

    /**
     * Generates random string and saves it
     * Example: Given user generates random string of length 10 and saves as "password"
     */
    @CSBDDStepDef("user generates random string of length {int} and saves as {string}")
    async generateRandomString(length: number, variableName: string): Promise<void> {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        this.scenarioContext.set(variableName, result);
        CSReporter.pass(`Generated random string '${result}' and saved as '${variableName}'`);
    }

    // =================================================================
    // DEBUGGING AND VERIFICATION
    // =================================================================

    /**
     * Prints all saved variables for debugging
     * Example: Given user prints all saved variables
     */
    @CSBDDStepDef("user prints all saved variables")
    async printAllVariables(): Promise<void> {
        console.log('\n=== SAVED VARIABLES ===');

        console.log('\nScenario Context:');
        const scenarioVars = this.scenarioContext.getAll();
        for (const [key, value] of scenarioVars) {
            console.log(`  ${key}: ${JSON.stringify(value)}`);
        }

        console.log('\nFeature Context:');
        const featureVars = this.featureContext.getAll();
        for (const [key, value] of featureVars) {
            console.log(`  ${key}: ${JSON.stringify(value)}`);
        }

        console.log('\nWorld Context:');
        this.context.debug();

        CSReporter.info('Printed all saved variables to console');
    }

    /**
     * Verifies a saved value exists
     * Example: Then user verifies variable "orderId" exists
     */
    @CSBDDStepDef("user verifies variable {string} exists")
    async verifyVariableExists(variableName: string): Promise<void> {
        const exists = this.scenarioContext.has(variableName) ||
                      this.featureContext.has(variableName) ||
                      this.context.has(variableName);

        if (!exists) {
            throw new Error(`Variable '${variableName}' does not exist in any context`);
        }

        CSReporter.pass(`Variable '${variableName}' exists`);
    }

    /**
     * Clears all variables in scenario context
     * Example: Given user clears all scenario variables
     */
    @CSBDDStepDef("user clears all scenario variables")
    async clearScenarioVariables(): Promise<void> {
        this.scenarioContext.clear();
        CSReporter.pass('Cleared all scenario variables');
    }

    // =================================================================
    // BROWSER MANAGEMENT - Switching & Context Clearing
    // =================================================================

    /**
     * Switch to a different browser during test execution
     * Supports: chrome, edge, firefox, webkit, safari
     * Works with browser reuse and parallel execution
     * Example: When user switches to "edge" browser
     * Example: When user switches to "chrome" browser
     */
    @CSBDDStepDef("user switches to {string} browser")
    async switchBrowser(browserType: string): Promise<void> {
        const { CSBrowserManager } = await import('../../browser/CSBrowserManager');
        const browserManager = CSBrowserManager.getInstance();

        await browserManager.switchBrowser(browserType, {
            preserveUrl: true,
            clearState: false
        });

        CSReporter.pass(`Switched to ${browserType} browser`);
    }

    /**
     * Switch to a different browser and clear all state (cookies, storage)
     * Example: When user switches to "firefox" browser and clears state
     */
    @CSBDDStepDef("user switches to {string} browser and clears state")
    async switchBrowserAndClearState(browserType: string): Promise<void> {
        const { CSBrowserManager } = await import('../../browser/CSBrowserManager');
        const browserManager = CSBrowserManager.getInstance();

        await browserManager.switchBrowser(browserType, {
            preserveUrl: true,
            clearState: true
        });

        CSReporter.pass(`Switched to ${browserType} browser with state cleared`);
    }

    /**
     * Switch to a different browser without preserving current URL
     * Example: When user switches to "safari" browser without preserving URL
     */
    @CSBDDStepDef("user switches to {string} browser without preserving URL")
    async switchBrowserWithoutUrl(browserType: string): Promise<void> {
        const { CSBrowserManager } = await import('../../browser/CSBrowserManager');
        const browserManager = CSBrowserManager.getInstance();

        await browserManager.switchBrowser(browserType, {
            preserveUrl: false,
            clearState: false
        });

        CSReporter.pass(`Switched to ${browserType} browser (URL not preserved)`);
    }

    /**
     * Clear browser context and prepare for re-authentication
     * Navigates to BASE_URL (login page) by default
     * Clears cookies, localStorage, sessionStorage, cache
     * Keeps browser instance alive (for performance)
     * Perfect for multi-user scenarios (e.g., approver workflows)
     * Example: When user clears browser context for re-authentication
     */
    @CSBDDStepDef("user clears browser context for re-authentication")
    async clearContextForReauth(): Promise<void> {
        const { CSBrowserManager } = await import('../../browser/CSBrowserManager');
        const browserManager = CSBrowserManager.getInstance();

        // This will navigate to BASE_URL from config by default
        await browserManager.clearContextAndReauthenticate();

        CSReporter.pass('Browser context cleared and navigated to login page');
    }

    /**
     * Clear browser context and navigate to a specific login URL
     * Example: When user clears browser context and goes to "https://app.example.com/admin/login"
     */
    @CSBDDStepDef("user clears browser context and goes to {string}")
    async clearContextAndNavigate(loginUrl: string): Promise<void> {
        const { CSBrowserManager } = await import('../../browser/CSBrowserManager');
        const browserManager = CSBrowserManager.getInstance();

        await browserManager.clearContextAndReauthenticate({
            loginUrl: loginUrl,
            waitForNavigation: true
        });

        CSReporter.pass(`Browser context cleared and navigated to ${loginUrl}`);
    }

    /**
     * Clear browser context without navigation
     * You'll need to navigate manually in next steps
     * Useful when you need custom navigation logic after clearing
     * Example: When user clears browser context without navigation
     */
    @CSBDDStepDef("user clears browser context without navigation")
    async clearContextWithoutNavigation(): Promise<void> {
        const { CSBrowserManager } = await import('../../browser/CSBrowserManager');
        const browserManager = CSBrowserManager.getInstance();

        await browserManager.clearContextAndReauthenticate({
            skipNavigation: true
        });

        CSReporter.pass('Browser context cleared (no navigation - you must navigate manually)');
    }
}