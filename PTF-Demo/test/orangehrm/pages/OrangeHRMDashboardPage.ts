import { CSBasePage, CSWebElement, CSReporter } from 'cs-playwright-test-framework';
import { CSPage, CSGetElement, CSGetElements } from 'cs-playwright-test-framework';

@CSPage('orangehrm-dashboard')
export class OrangeHRMDashboardPage extends CSBasePage {
    
    // Dashboard header
    @CSGetElement({
        css: 'h6.oxd-topbar-header-breadcrumb-module',
        description: 'Dashboard page header',
        waitForVisible: true,
        alternativeLocators: [
            'xpath://h6[contains(@class,"oxd-topbar-header-breadcrumb-module")]',
            'css:h6:has-text("Dashboard")'
        ]
    })
    public dashboardHeader!: CSWebElement;
    
    // Main navigation menu items collection
    @CSGetElements({
        css: '.oxd-main-menu-item',
        description: 'Navigation menu items',
        waitForVisible: true
    })
    public navigationMenuItems!: CSWebElement[];
    
    // User profile dropdown
    @CSGetElement({
        css: '.oxd-userdropdown-tab',
        description: 'User profile dropdown',
        waitForVisible: true
    })
    public userProfileDropdown!: CSWebElement;
    
    // Logout option
    @CSGetElement({
        text: 'Logout',
        description: 'Logout option',
        alternativeLocators: [
            'css:a[href*="logout"]',
            'xpath://a[contains(@href,"logout")]'
        ]
    })
    public logoutOption!: CSWebElement;
    
    // Admin menu
    @CSGetElement({
        text: 'Admin',
        description: 'Admin menu',
        alternativeLocators: [
            'css:span.oxd-main-menu-item--name',
            'xpath://span[text()="Admin"]'
        ]
    })
    public adminMenuItem!: CSWebElement;
    
    @CSGetElement({
        text: 'PIM',
        description: 'PIM menu',
        alternativeLocators: [
            'xpath://span[text()="PIM"]'
        ]
    })
    public pimMenuItem!: CSWebElement;
    
    @CSGetElement({
        text: 'Leave',
        description: 'Leave menu',
        alternativeLocators: [
            'xpath://span[text()="Leave"]'
        ]
    })
    public leaveMenuItem!: CSWebElement;
    
    @CSGetElement({
        xpath: '//span[text()="Time"]',
        description: 'Time menu item',
        waitForVisible: true,
        alternativeLocators: [
            'text:Time'
        ]
    })
    public timeMenuItem!: CSWebElement;
    
    @CSGetElement({
        xpath: '//span[text()="Recruitment"]',
        description: 'Recruitment menu item',
        waitForVisible: true,
        alternativeLocators: [
            'text:Recruitment'
        ]
    })
    public recruitmentMenuItem!: CSWebElement;
    
    @CSGetElement({
        xpath: '//span[text()="My Info"]',
        description: 'My Info menu item',
        waitForVisible: true,
        alternativeLocators: [
            'text:My Info'
        ]
    })
    public myInfoMenuItem!: CSWebElement;
    
    @CSGetElement({
        xpath: '//span[text()="Performance"]',
        description: 'Performance menu item',
        waitForVisible: true,
        alternativeLocators: [
            'text:Performance'
        ]
    })
    public performanceMenuItem!: CSWebElement;
    
    @CSGetElement({
        xpath: '//span[text()="Directory"]',
        description: 'Directory menu item',
        waitForVisible: true,
        alternativeLocators: [
            'text:Directory'
        ]
    })
    public directoryMenuItem!: CSWebElement;
    
    // Dynamic page header for navigation verification
    @CSGetElement({
        css: '.oxd-topbar-header-breadcrumb-module',
        xpath: '//h6[contains(@class,"oxd-topbar-header-breadcrumb-module")]',
        description: 'Current page header for navigation verification',
        waitForVisible: true,
        timeout: 10000
    })
    public pageHeader!: CSWebElement;

    protected initializeElements(): void {
        // Elements are automatically initialized by @CSGetElement decorators
        CSReporter.debug('OrangeHRMDashboardPage elements initialized');
    }

    
    public async verifyDashboardLoaded(): Promise<void> {
        await this.dashboardHeader.waitFor({ state: 'visible' });
        
        const isVisible = await this.dashboardHeader.isVisible();
        const currentUrl = this.page.url();
        const dashboardUrlPattern = this.config.get('DASHBOARD_URL_PATTERN', 'dashboard');
        
        if (isVisible && currentUrl.includes(dashboardUrlPattern)) {
            CSReporter.pass('Dashboard page loaded successfully');
        } else {
            CSReporter.fail(`Dashboard verification failed. Header visible: ${isVisible}, URL: ${currentUrl}`);
            throw new Error('Dashboard page verification failed');
        }
    }

    
    public async verifyAllMenuItemsVisible(): Promise<void> {
        const menuItems = [
            { element: this.adminMenuItem, name: 'Admin' },
            { element: this.pimMenuItem, name: 'PIM' },
            { element: this.leaveMenuItem, name: 'Leave' },
            { element: this.timeMenuItem, name: 'Time' },
            { element: this.recruitmentMenuItem, name: 'Recruitment' },
            { element: this.myInfoMenuItem, name: 'My Info' },
            { element: this.performanceMenuItem, name: 'Performance' },
            { element: this.directoryMenuItem, name: 'Directory' }
        ];

        CSReporter.info(`Verifying ${menuItems.length} menu items are visible`);
        
        for (const item of menuItems) {
            try {
                await item.element.waitFor({ state: 'visible', timeout: 5000 });
                const isVisible = await item.element.isVisible();
                
                if (isVisible) {
                    CSReporter.pass(`Menu item "${item.name}" is visible`);
                } else {
                    CSReporter.fail(`Menu item "${item.name}" is not visible`);
                    throw new Error(`Menu item "${item.name}" verification failed`);
                }
            } catch (error) {
                CSReporter.fail(`Menu item "${item.name}" not found: ${error}`);
                throw new Error(`Menu item "${item.name}" verification failed`);
            }
        }
        
        CSReporter.pass('All navigation menu items are visible');
    }

    
    public async clickMenuItem(menuItemName: string): Promise<void> {
        let menuElement: CSWebElement;
        
        // Map menu item names to their corresponding elements
        switch (menuItemName.toLowerCase()) {
            case 'admin':
                menuElement = this.adminMenuItem;
                break;
            case 'pim':
                menuElement = this.pimMenuItem;
                break;
            case 'leave':
                menuElement = this.leaveMenuItem;
                break;
            case 'time':
                menuElement = this.timeMenuItem;
                break;
            case 'recruitment':
                menuElement = this.recruitmentMenuItem;
                break;
            case 'my info':
                menuElement = this.myInfoMenuItem;
                break;
            case 'performance':
                menuElement = this.performanceMenuItem;
                break;
            case 'directory':
                menuElement = this.directoryMenuItem;
                break;
            default:
                CSReporter.fail(`Unknown menu item: ${menuItemName}`);
                throw new Error(`Menu item "${menuItemName}" not found`);
        }

        await menuElement.click();
        CSReporter.pass(`Clicked on menu item: ${menuItemName}`);
        
        // Wait for navigation to complete
        await this.page.waitForLoadState('networkidle');
    }

    
    public async verifyPageHeader(expectedHeader: string): Promise<void> {
        await this.pageHeader.waitFor({ state: 'visible' });
        
        const actualHeader = await this.pageHeader.textContent();
        
        if (actualHeader && actualHeader.trim() === expectedHeader) {
            CSReporter.pass(`Page header verified: ${expectedHeader}`);
        } else {
            CSReporter.fail(`Expected header: "${expectedHeader}", but got: "${actualHeader}"`);
            throw new Error(`Page header verification failed. Expected: ${expectedHeader}, Actual: ${actualHeader}`);
        }
    }

    
    public async verifyUrlContains(urlFragment: string): Promise<void> {
        const currentUrl = this.page.url();
        
        if (currentUrl.toLowerCase().includes(urlFragment.toLowerCase())) {
            CSReporter.pass(`URL contains expected fragment: ${urlFragment}`);
        } else {
            CSReporter.fail(`URL does not contain expected fragment: ${urlFragment}. Current URL: ${currentUrl}`);
            throw new Error(`URL verification failed. Expected fragment: ${urlFragment}, Current URL: ${currentUrl}`);
        }
    }

    
    public async clickUserProfileDropdown(): Promise<void> {
        await this.userProfileDropdown.click();
        CSReporter.pass('User profile dropdown clicked');
    }

    
    public async clickLogoutOption(): Promise<void> {
        // First click the dropdown if not already open
        await this.clickUserProfileDropdown();
        
        // Wait for logout option to be visible
        await this.logoutOption.waitFor({ state: 'visible' });
        await this.logoutOption.click();
        
        CSReporter.pass('Logout option clicked');
        
        // Wait for logout to complete
        await this.page.waitForLoadState('networkidle');
    }

    
    public async verifyRedirectToLogin(): Promise<void> {
        const currentUrl = this.page.url();
        const loginUrlPattern = this.config.get('LOGIN_URL_PATTERN', 'auth/login');
        
        if (currentUrl.includes(loginUrlPattern)) {
            CSReporter.pass('Successfully redirected to login page');
        } else {
            CSReporter.fail(`Expected redirect to login page, but URL is: ${currentUrl}`);
            throw new Error('Login page redirect verification failed');
        }
    }

    // Override isAt method for dashboard page verification
    public async isAt(): Promise<boolean> {
        try {
            const headerVisible = await this.dashboardHeader.isVisible();
            const currentUrl = this.page.url();
            const dashboardUrlPattern = this.config.get('DASHBOARD_URL_PATTERN', 'dashboard');
            
            return headerVisible && currentUrl.includes(dashboardUrlPattern);
        } catch (error) {
            return false;
        }
    }
    
    // Check if dashboard is visible
    public async isDashboardVisible(): Promise<boolean> {
        try {
            await this.dashboardHeader.waitFor({ state: 'visible', timeout: 10000 });
            return await this.dashboardHeader.isVisible();
        } catch (error) {
            CSReporter.debug(`Dashboard visibility check failed: ${(error as Error).message}`);
            return false;
        }
    }
    
    // Get menu items for verification
    public async getMenuItems(): Promise<string[]> {
        try {
            // navigationMenuItems is already an array, no need to call getAll()
            const menuElements = this.navigationMenuItems;
            const menuTexts: string[] = [];

            for (const element of menuElements) {
                const text = await element.textContent();
                if (text) {
                    menuTexts.push(text.trim());
                }
            }
            
            return menuTexts;
        } catch (error) {
            CSReporter.debug(`Failed to get menu items: ${(error as Error).message}`);
            return [];
        }
    }
}