import { CSBDDStepDef, Page, StepDefinitions, CSReporter } from 'cs-playwright-test-framework';
import { OrangeHRMLoginPage } from '../pages/OrangeHRMLoginPage';
import { OrangeHRMDashboardPage } from '../pages/OrangeHRMDashboardPage';

@StepDefinitions
export class OrangeHRMLoginSteps {
    
    @Page('orangehrm-login')
    private loginPage!: OrangeHRMLoginPage;
    
    @Page('orangehrm-dashboard') 
    private dashboardPage!: OrangeHRMDashboardPage;
    
    @CSBDDStepDef('I navigate to the Orange HRM application')
    async navigateToOrangeHRM() {
        CSReporter.info('Navigating to Orange HRM application');
        
        // Pages are auto-injected by framework
        await this.loginPage.navigate();
        
        CSReporter.pass('Successfully navigated to Orange HRM application');
    }

    @CSBDDStepDef('I enter username {string} and password {string}')
    async enterCredentials(username: string, password: string) {
        CSReporter.info(`Entering credentials for user: ${username}`);
        
        // Pages are auto-injected by framework
        await this.loginPage.enterUsername(username);
        await this.loginPage.enterPassword(password);
        
        CSReporter.pass('Credentials entered successfully');
    }

    @CSBDDStepDef('I am on the login page')
    async onLoginPage() {
        CSReporter.info('Navigating to login page');
        await this.loginPage.navigate();
        CSReporter.pass('On login page');
    }

    @CSBDDStepDef('I enter username {string}')
    async enterUsername(username: string) {
        CSReporter.info(`Entering username: ${username}`);
        await this.loginPage.enterUsername(username);
        CSReporter.pass('Username entered');
    }

    @CSBDDStepDef('I enter password {string}')
    async enterPassword(password: string) {
        CSReporter.info(`Entering password`);
        await this.loginPage.enterPassword(password);
        CSReporter.pass('Password entered');
    }

    @CSBDDStepDef('I click on the Login button')
    async clickLoginButton() {
        CSReporter.info('Clicking login button');

        // Pages are auto-injected by framework
        await this.loginPage.clickLoginButton();

        CSReporter.pass('Login button clicked');
    }

    @CSBDDStepDef('I should see the dashboard page')
    async shouldSeeDashboard() {
        CSReporter.info('Verifying dashboard page is displayed');
        // This will fail with wrong password
        const isVisible = await this.dashboardPage.isDashboardVisible();
        if (!isVisible) {
            throw new Error('Dashboard page is not visible');
        }
        CSReporter.pass('Dashboard page is displayed');
    }

    @CSBDDStepDef('I should be logged in successfully')
    async verifyLoginSuccess() {
        CSReporter.info('Verifying successful login');
        
        // Pages are auto-injected by framework
        const isVisible = await this.dashboardPage.isDashboardVisible();
        
        if (!isVisible) {
            throw new Error('Login verification failed - Dashboard not visible');
        }
        
        CSReporter.pass('Successfully logged in to Orange HRM');
    }

    @CSBDDStepDef('I should see the Dashboard page')
    async verifyDashboardPage() {
        CSReporter.info('Verifying Dashboard page is displayed');
        
        // Pages are auto-injected by framework
        const isVisible = await this.dashboardPage.isDashboardVisible();
        
        if (!isVisible) {
            throw new Error('Dashboard page is not visible');
        }
        
        CSReporter.pass('Dashboard page is displayed');
    }

    @CSBDDStepDef('I should see the main navigation menu')
    async verifyNavigationMenu() {
        CSReporter.info('Verifying main navigation menu');
        
        // Pages are auto-injected by framework
        const menuItems = await this.dashboardPage.getMenuItems();
        
        if (menuItems.length === 0) {
            throw new Error('No menu items found');
        }
        
        CSReporter.pass(`Navigation menu displayed with ${menuItems.length} items`);
    }

    @CSBDDStepDef('I am logged in to Orange HRM application')
    async loginToOrangeHRM() {
        CSReporter.info('Performing quick login to Orange HRM');
        
        // Pages are auto-injected by framework
        await this.loginPage.navigate();
        await this.loginPage.login('Admin', 'admin123');
        
        // Verify we're on dashboard
        const isVisible = await this.dashboardPage.isDashboardVisible();
        
        if (!isVisible) {
            throw new Error('Quick login failed - Dashboard not visible');
        }
        
        CSReporter.pass('Successfully logged in to Orange HRM');
    }

    @CSBDDStepDef('I should see the following menu items')
    async verifyMenuItems(dataTable: any) {
        CSReporter.info('Verifying menu items from data table');
        
        // Pages are auto-injected by framework
        const actualMenuItems = await this.dashboardPage.getMenuItems();
        const expectedMenuItems = dataTable.raw().flat();
        
        for (const expectedItem of expectedMenuItems) {
            const found = actualMenuItems.some(item => 
                item.toLowerCase().includes(expectedItem.toLowerCase())
            );
            
            if (!found) {
                throw new Error(`Menu item "${expectedItem}" not found`);
            }
        }
        
        CSReporter.pass('All expected menu items are visible');
    }

    @CSBDDStepDef('I click on {string} menu item')
    async clickMenuItem(menuItem: string) {
        CSReporter.info(`Clicking on menu item: ${menuItem}`);
        
        // Pages are auto-injected by framework
        await this.dashboardPage.clickMenuItem(menuItem);
        
        CSReporter.pass(`Clicked on ${menuItem} menu item`);
    }

    @CSBDDStepDef('I should see the {string} page header')
    async verifyPageHeader(expectedHeader: string) {
        CSReporter.info(`Verifying page header: ${expectedHeader}`);
        
        // Pages are auto-injected by framework
        await this.dashboardPage.verifyPageHeader(expectedHeader);
        
        CSReporter.pass(`Page header "${expectedHeader}" is displayed`);
    }

    @CSBDDStepDef('the URL should contain {string}')
    async verifyUrlContains(urlFragment: string) {
        CSReporter.info(`Verifying URL contains: ${urlFragment}`);
        
        // Get the current URL from the page via dashboard page instance
        const currentUrl = this.dashboardPage.getPage().url();
        
        if (!currentUrl.includes(urlFragment)) {
            throw new Error(`URL does not contain expected fragment: ${urlFragment}. Current URL: ${currentUrl}`);
        }
        
        CSReporter.pass(`URL contains expected fragment: ${urlFragment}`);
    }

    @CSBDDStepDef('I should see an error message {string}')
    async verifyErrorMessage(expectedMessage: string) {
        CSReporter.info(`Verifying error message: ${expectedMessage}`);
        
        // Pages are auto-injected by framework
        await this.loginPage.verifyErrorMessage(expectedMessage);
        
        CSReporter.pass(`Error message "${expectedMessage}" is displayed`);
    }

    @CSBDDStepDef('I should remain on the login page')
    async verifyStillOnLoginPage() {
        CSReporter.info('Verifying user remains on login page');
        
        // Pages are auto-injected by framework
        const isLoginFormVisible = await this.loginPage.usernameField.isVisible();
        
        if (!isLoginFormVisible) {
            throw new Error('Login form is not visible - user may have navigated away');
        }
        
        CSReporter.pass('User remained on login page');
    }

    @CSBDDStepDef('I click on user profile dropdown')
    async clickUserDropdown() {
        CSReporter.info('Clicking on user profile dropdown');
        
        // Pages are auto-injected by framework
        await this.dashboardPage.clickUserProfileDropdown();
        
        CSReporter.pass('User profile dropdown clicked');
    }

    @CSBDDStepDef('I click on Logout option')
    async clickLogout() {
        CSReporter.info('Clicking on Logout option');
        
        // Pages are auto-injected by framework
        await this.dashboardPage.clickLogoutOption();
        
        CSReporter.pass('Logout option clicked');
    }

    @CSBDDStepDef('I should be redirected to login page')
    async verifyRedirectToLogin() {
        CSReporter.info('Verifying redirect to login page');
        
        // Pages are auto-injected by framework
        await this.dashboardPage.verifyRedirectToLogin();
        
        CSReporter.pass('Successfully redirected to login page');
    }

    @CSBDDStepDef('I should see the login form')
    async verifyLoginForm() {
        CSReporter.info('Verifying login form is displayed');
        
        // Pages are auto-injected by framework
        const isVisible = await this.loginPage.usernameField.isVisible();
        
        if (!isVisible) {
            throw new Error('Login form is not visible');
        }
        
        CSReporter.pass('Login form is displayed');
    }
}

// Export the step definitions class
export default OrangeHRMLoginSteps;