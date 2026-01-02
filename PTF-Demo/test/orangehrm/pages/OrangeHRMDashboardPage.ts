import { CSBasePage, CSPage, CSGetElement, CSGetElements } from '@mdakhan.mak/cs-playwright-test-framework/core';
import { CSWebElement, CSElementFactory } from '@mdakhan.mak/cs-playwright-test-framework/element';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';

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
    
    // Admin menu - use specific selector to avoid matching "Administration" text
    @CSGetElement({
        xpath: '//span[@class="oxd-text oxd-text--span oxd-main-menu-item--name" and text()="Admin"]',
        description: 'Admin menu',
        alternativeLocators: [
            'css:a.oxd-main-menu-item span.oxd-main-menu-item--name:has-text("Admin")',
            'xpath://a[contains(@class,"oxd-main-menu-item")]//span[text()="Admin"]'
        ]
    })
    public adminMenuItem!: CSWebElement;
    
    // PIM menu - use specific selector for main menu item
    @CSGetElement({
        xpath: '//a[contains(@class,"oxd-main-menu-item")]//span[text()="PIM"]',
        description: 'PIM menu',
        alternativeLocators: [
            'css:a.oxd-main-menu-item span.oxd-main-menu-item--name:has-text("PIM")',
            'xpath://span[@class="oxd-text oxd-text--span oxd-main-menu-item--name" and text()="PIM"]'
        ]
    })
    public pimMenuItem!: CSWebElement;
    
    // Leave menu - use specific selector to avoid matching leave-related texts
    @CSGetElement({
        xpath: '//a[contains(@class,"oxd-main-menu-item")]//span[text()="Leave"]',
        description: 'Leave menu',
        alternativeLocators: [
            'css:a.oxd-main-menu-item span.oxd-main-menu-item--name:has-text("Leave")',
            'xpath://span[@class="oxd-text oxd-text--span oxd-main-menu-item--name" and text()="Leave"]'
        ]
    })
    public leaveMenuItem!: CSWebElement;
    
    // Time menu - specific selector for main menu
    @CSGetElement({
        xpath: '//a[contains(@class,"oxd-main-menu-item")]//span[text()="Time"]',
        description: 'Time menu item',
        waitForVisible: true,
        alternativeLocators: [
            'css:a.oxd-main-menu-item span.oxd-main-menu-item--name:has-text("Time")',
            'xpath://span[@class="oxd-text oxd-text--span oxd-main-menu-item--name" and text()="Time"]'
        ]
    })
    public timeMenuItem!: CSWebElement;

    // Recruitment menu - specific selector
    @CSGetElement({
        xpath: '//a[contains(@class,"oxd-main-menu-item")]//span[text()="Recruitment"]',
        description: 'Recruitment menu item',
        waitForVisible: true,
        alternativeLocators: [
            'css:a.oxd-main-menu-item span.oxd-main-menu-item--name:has-text("Recruitment")',
            'xpath://span[@class="oxd-text oxd-text--span oxd-main-menu-item--name" and text()="Recruitment"]'
        ]
    })
    public recruitmentMenuItem!: CSWebElement;

    // My Info menu - specific selector
    @CSGetElement({
        xpath: '//a[contains(@class,"oxd-main-menu-item")]//span[text()="My Info"]',
        description: 'My Info menu item',
        waitForVisible: true,
        alternativeLocators: [
            'css:a.oxd-main-menu-item span.oxd-main-menu-item--name:has-text("My Info")',
            'xpath://span[@class="oxd-text oxd-text--span oxd-main-menu-item--name" and text()="My Info"]'
        ]
    })
    public myInfoMenuItem!: CSWebElement;

    // Performance menu - specific selector
    @CSGetElement({
        xpath: '//a[contains(@class,"oxd-main-menu-item")]//span[text()="Performance"]',
        description: 'Performance menu item',
        waitForVisible: true,
        alternativeLocators: [
            'css:a.oxd-main-menu-item span.oxd-main-menu-item--name:has-text("Performance")',
            'xpath://span[@class="oxd-text oxd-text--span oxd-main-menu-item--name" and text()="Performance"]'
        ]
    })
    public performanceMenuItem!: CSWebElement;

    // Directory menu - specific selector
    @CSGetElement({
        xpath: '//a[contains(@class,"oxd-main-menu-item")]//span[text()="Directory"]',
        description: 'Directory menu item',
        waitForVisible: true,
        alternativeLocators: [
            'css:a.oxd-main-menu-item span.oxd-main-menu-item--name:has-text("Directory")',
            'xpath://span[@class="oxd-text oxd-text--span oxd-main-menu-item--name" and text()="Directory"]'
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
            CSReporter.info(`Retrieving menu items from navigationMenuItems`);
            const menuElements = this.navigationMenuItems;
            const menuTexts: string[] = [];

            for (const element of menuElements) {
                const text = await element.textContent();
                if (text) {
                    menuTexts.push(text.trim());
                }
            }
            CSReporter.info(`Menu items retrieved: ${menuTexts.join(', ')}`);
            return menuTexts;
        } catch (error) {
            CSReporter.debug(`Failed to get menu items: ${(error as Error).message}`);
            return [];
        }
    }
}