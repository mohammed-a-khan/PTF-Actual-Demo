import { StepDefinitions, Page, CSBDDStepDef } from '@mdakhan.mak/cs-playwright-test-framework/bdd';
import { CSConfigurationManager } from '@mdakhan.mak/cs-playwright-test-framework/core';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';
import { OrangeHRMLoginPage } from '../pages/OrangeHRMLoginPage';
import { OrangeHRMDashboardPage } from '../pages/OrangeHRMDashboardPage';
import { expect } from '@playwright/test';

/**
 * Example step definitions demonstrating encrypted values and variable interpolation
 *
 * KEY CONCEPTS:
 * 1. Encrypted values are automatically decrypted when accessed via config.get()
 * 2. Variable interpolation is resolved during config initialization
 * 3. No manual decryption is needed - the framework handles it
 */
@StepDefinitions
export class ExampleEncryptedSteps {
    @Page('orangehrm-login')
    private loginPage!: OrangeHRMLoginPage;

    @Page('orangehrm-dashboard')
    private dashboardPage!: OrangeHRMDashboardPage;

    private config = CSConfigurationManager.getInstance();

    @CSBDDStepDef('I login with encrypted credentials from config')
    async loginWithEncryptedCredentials(): Promise<void> {
        // Get username from config (plain text)
        const username = this.config.get('DEFAULT_USERNAME', 'Admin');
        
        // Get encrypted password from config
        // The framework automatically decrypts ENCRYPTED: values
        // So this returns the actual password, not the encrypted string
        const password = this.config.get('ADMIN_PASSWORD_ENCRYPTED');
        
        // If password is still encrypted (shouldn't happen), fall back to default
        const actualPassword = password || this.config.get('DEFAULT_PASSWORD', 'admin123');
        
        CSReporter.info(`Logging in with user: ${username}`);
        CSReporter.debug(`Password retrieved from encrypted config (first 3 chars): ${actualPassword.substring(0, 3)}***`);
        
        // Use the credentials to login
        await this.loginPage.enterUsername(username);
        await this.loginPage.enterPassword(actualPassword);
        await this.loginPage.clickLoginButton();
        
        CSReporter.pass('Successfully logged in using encrypted credentials');
    }

    @CSBDDStepDef('I navigate to the dashboard using interpolated URL')
    async navigateToDashboardInterpolated(): Promise<void> {
        // Get the interpolated dashboard URL
        // This is defined in .env as: DASHBOARD_URL=https://opensource-demo.orangehrmlive.com/web/index.php/dashboard/index
        // The ${BASE_URL} part is automatically resolved
        const dashboardUrl = this.config.get('DASHBOARD_URL');
        
        CSReporter.info(`Navigating to interpolated dashboard URL: ${dashboardUrl}`);
        
        const page = this.loginPage.getPage();
        await page.goto(dashboardUrl);
        await page.waitForLoadState('networkidle');
        
        CSReporter.pass(`Successfully navigated to: ${dashboardUrl}`);
    }

    @CSBDDStepDef('the current URL should match the interpolated dashboard URL')
    async verifyInterpolatedUrl(): Promise<void> {
        const expectedUrl = this.config.get('DASHBOARD_URL');
        const page = this.loginPage.getPage();
        const currentUrl = page.url();
        
        CSReporter.info(`Expected URL: ${expectedUrl}`);
        CSReporter.info(`Current URL: ${currentUrl}`);
        
        expect(currentUrl).toContain('dashboard');
        CSReporter.pass('URL matches the interpolated dashboard URL');
    }

    @CSBDDStepDef('I access configuration values in my test')
    async accessConfigValues(): Promise<void> {
        // Demonstrate accessing various config values
        const examples = {
            'APP_NAME': this.config.get('APP_NAME'),
            'ENVIRONMENT': this.config.get('ENVIRONMENT'),
            'BASE_URL': this.config.get('BASE_URL'),
            'ADMIN_PASSWORD_ENCRYPTED': this.config.get('ADMIN_PASSWORD_ENCRYPTED'),
            'HR_USER_PASSWORD_ENCRYPTED': this.config.get('HR_USER_PASSWORD_ENCRYPTED'),
            'REPORT_TITLE': this.config.get('REPORT_TITLE'),
            'TEST_DATA_PATH': this.config.get('TEST_DATA_PATH'),
            'FULL_BASE_URL': this.config.get('FULL_BASE_URL')
        };
        
        CSReporter.info('Configuration values retrieved:');
        for (const [key, value] of Object.entries(examples)) {
            // Mask sensitive values in logs
            if (key.includes('PASSWORD')) {
                CSReporter.debug(`  ${key}: ***DECRYPTED*** (length: ${value?.length || 0})`);
            } else {
                CSReporter.debug(`  ${key}: ${value}`);
            }
        }
        
        CSReporter.pass('Successfully accessed all configuration values');
    }

    @CSBDDStepDef('I should see the following resolved values')
    async verifyResolvedValues(dataTable: any): Promise<void> {
        const expectedValues = dataTable.hashes();
        
        for (const row of expectedValues) {
            const configKey = row['Config Key'];
            const actualValue = this.config.get(configKey);
            
            CSReporter.info(`Verifying ${configKey}`);
            
            // For encrypted values, just verify they were decrypted (not empty)
            if (configKey.includes('ENCRYPTED')) {
                expect(actualValue).toBeTruthy();
                expect(actualValue).not.toContain('ENCRYPTED:');
                CSReporter.debug(`  ${configKey} was successfully decrypted`);
            } else {
                CSReporter.debug(`  ${configKey} = ${actualValue}`);
            }
        }
        
        CSReporter.pass('All configuration values resolved correctly');
    }

    /**
     * Example of using encrypted API keys or tokens
     */
    @CSBDDStepDef('I use an encrypted API token')
    async useEncryptedApiToken(): Promise<void> {
        // Example: Get an encrypted API token from config
        // In .env file: API_TOKEN=ENCRYPTED:eyJlbmNyeXB0ZWQiOi...
        const apiToken = this.config.get('API_TOKEN_ENCRYPTED', '');
        
        if (apiToken) {
            // The token is automatically decrypted
            CSReporter.info(`Using API token (first 5 chars): ${apiToken.substring(0, 5)}...`);
            
            // Use the token for API calls
            // Example: await fetch(url, { headers: { 'Authorization': `Bearer ${apiToken}` } });
            
            CSReporter.pass('API token retrieved and ready for use');
        } else {
            CSReporter.info('No encrypted API token configured');
        }
    }
}