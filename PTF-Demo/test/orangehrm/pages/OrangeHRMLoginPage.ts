import { CSBasePage, CSWebElement, CSReporter } from 'cs-playwright-test-framework';
import { CSPage, CSGetElement } from 'cs-playwright-test-framework';

@CSPage('orangehrm-login')
export class OrangeHRMLoginPage extends CSBasePage {
    
    // Username field with CS Framework @CSGetElement decorator
    @CSGetElement({
        css: 'input[name="useame"]',
        description: 'Username input field',
        waitForVisible: true,
        selfHeal: true,
        alternativeLocators: [
            'xpath://input[@name="username"]',
            'placeholder:Username'
        ]
    })
    public usernameField!: CSWebElement;
    
    // Password field
    @CSGetElement({
        css: 'input[name="password"]',
        description: 'Password input field',
        waitForVisible: true,
        selfHeal: true,
        alternativeLocators: [
            'xpath://input[@type="password"]',
            'placeholder:Password'
        ]
    })
    public passwordField!: CSWebElement;
    
    // Login button
    @CSGetElement({
        css: 'button[type="submit"]',
        description: 'Login button',
        waitForVisible: true,
        waitForEnabled: true,
        selfHeal: true,
        alternativeLocators: [
            'xpath://button[@type="submit"]',
            'text:Login',
            'role:button[name="submit"]'
        ]
    })
    public loginButton!: CSWebElement;
    
    // Error message element
    @CSGetElement({
        css: '.oxd-alert-content-text',
        description: 'Error message',
        alternativeLocators: [
            'xpath://div[contains(@class,"oxd-alert-content-text")]'
        ]
    })
    public errorMessage!: CSWebElement;
    
    // Dashboard header
    @CSGetElement({
        text: 'Dashboard',
        description: 'Dashboard header',
        waitForVisible: true,
        alternativeLocators: [
            'css:h6.oxd-text',
            'xpath://h6[text()="Dashboard"]'
        ]
    })
    public dashboardHeader!: CSWebElement;
    
    // Navigation menu
    @CSGetElement({
        css: '.oxd-main-menu',
        description: 'Navigation menu',
        waitForVisible: true
    })
    public navigationMenu!: CSWebElement;

    protected initializeElements(): void {
        // Elements are automatically initialized by @CSElement decorators
        CSReporter.debug('OrangeHRMLoginPage elements initialized');
    }

    // Page methods - no decorators needed
    public async enterUsername(username: string): Promise<void> {
        await this.usernameField.click();
        await this.usernameField.fill(username);
        CSReporter.info(`Username entered: ${username}`);
    }

    public async enterPassword(password: string): Promise<void> {
        await this.passwordField.click();
        await this.passwordField.fill(password);
        CSReporter.info('Password entered successfully');
    }

    public async clickLoginButton(): Promise<void> {
        await this.loginButton.click();
        CSReporter.info('Login button clicked');
    }

    public async login(username: string, password: string): Promise<void> {
        await this.enterUsername(username);
        await this.enterPassword(password);
        await this.clickLoginButton();
        CSReporter.pass(`Login completed for user: ${username}`);
    }

    public async verifyLoginSuccess(): Promise<void> {
        // Wait for dashboard header to be visible
        await this.dashboardHeader.waitFor({ state: 'visible' });
        
        const isVisible = await this.dashboardHeader.isVisible();
        if (isVisible) {
            CSReporter.pass('Login successful - Dashboard header is visible');
        } else {
            CSReporter.fail('Login failed - Dashboard header not found');
            throw new Error('Login verification failed - Dashboard not visible');
        }
    }

    public async verifyNavigationMenu(): Promise<void> {
        await this.navigationMenu.waitFor({ state: 'visible' });
        
        const isVisible = await this.navigationMenu.isVisible();
        if (isVisible) {
            CSReporter.pass('Navigation menu is visible');
        } else {
            CSReporter.fail('Navigation menu is not visible');
            throw new Error('Navigation menu verification failed');
        }
    }

    public async verifyErrorMessage(expectedMessage: string): Promise<void> {
        await this.errorMessage.waitFor({ state: 'visible', timeout: 5000 });
        
        const actualMessage = await this.errorMessage.textContent();
        if (actualMessage && actualMessage.includes(expectedMessage)) {
            CSReporter.pass(`Error message verified: ${expectedMessage}`);
        } else {
            CSReporter.fail(`Expected error message: ${expectedMessage}, but got: ${actualMessage}`);
            throw new Error(`Error message verification failed. Expected: ${expectedMessage}, Actual: ${actualMessage}`);
        }
    }

    public async verifyStillOnLoginPage(): Promise<void> {
        const currentUrl = this.page.url();
        const loginUrlPattern = this.config.get('LOGIN_URL_PATTERN', 'auth/login');
        
        if (currentUrl.includes(loginUrlPattern)) {
            CSReporter.pass('User remained on login page as expected');
        } else {
            CSReporter.fail(`Expected to remain on login page, but URL is: ${currentUrl}`);
            throw new Error('Login page verification failed');
        }
    }

    // Override navigate method for specific Orange HRM login page
    public async navigate(): Promise<void> {
        const baseUrl = this.config.get('BASE_URL');
        CSReporter.info(`Navigating to Orange HRM login page: ${baseUrl}`);
        
        await this.page.goto(baseUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });
        await this.waitForPageLoad();
        
        // Verify we're on the login page
        await this.page.waitForSelector('input[name="username"]', { timeout: 10000 });
        CSReporter.pass('Successfully navigated to Orange HRM login page');
    }

    // Override waitForPageLoad for Orange HRM specific behavior
    public async waitForPageLoad(): Promise<void> {
        await this.page.waitForLoadState('networkidle', { timeout: 30000 });

        // Wait for login form to be ready
        try {
            await this.page.waitForSelector('input[name="username"]', { timeout: 10000 });
            await this.page.waitForSelector('input[name="password"]', { timeout: 5000 });
            await this.page.waitForSelector('button[type="submit"]', { timeout: 5000 });
            CSReporter.debug('Orange HRM login page fully loaded');
        } catch (error) {
            CSReporter.warn('Login form elements not found within timeout');
        }
    }

    // Override isAt method for page verification
    public async isAt(): Promise<boolean> {
        try {
            const currentUrl = this.page.url();
            const hasLoginForm = await this.usernameField.isVisible();
            const urlContainsLogin = currentUrl.includes('auth/login');
            
            return hasLoginForm && urlContainsLogin;
        } catch (error) {
            return false;
        }
    }
}