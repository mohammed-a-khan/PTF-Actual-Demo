// Lazy load Playwright and BrowserManager for performance
// import { Page } from '@playwright/test';
// import { CSBrowserManager } from '../browser/CSBrowserManager';
type Page = any;
let CSBrowserManager: any = null;
import { CSConfigurationManager } from './CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';
import { CSWebElement } from '../element/CSWebElement';
import { CSCrossDomainNavigationHandler } from '../navigation/CSCrossDomainNavigationHandler';

export abstract class CSBasePage {
    protected page: any; // Page type from Playwright
    protected config: CSConfigurationManager;
    protected browserManager: any; // CSBrowserManager - lazy loaded
    protected url: string = '';
    protected elements: Map<string, CSWebElement> = new Map();
    private static crossDomainHandlers: Map<any, CSCrossDomainNavigationHandler> = new Map();

    constructor() {
        this.config = CSConfigurationManager.getInstance();
        // Lazy load CSBrowserManager
        if (!CSBrowserManager) {
            CSBrowserManager = require('../browser/CSBrowserManager').CSBrowserManager;
        }
        this.browserManager = CSBrowserManager.getInstance();
        this.page = this.browserManager.getPage();
        this.initializeElements();
        this.initializeCrossDomainHandler();
    }
    
    // Public getter for page access
    public getPage(): any {
        return this.page;
    }
    
    // Abstract method to be implemented by page classes
    protected abstract initializeElements(): void;

    /**
     * Initialize cross-domain navigation handler if enabled (reuse existing for same page)
     */
    private initializeCrossDomainHandler(): void {
        if (this.config.getBoolean('CROSS_DOMAIN_NAVIGATION_ENABLED', true)) {
            // Reuse existing handler for the same page instance
            if (!CSBasePage.crossDomainHandlers.has(this.page)) {
                const handler = new CSCrossDomainNavigationHandler(this.page);
                CSBasePage.crossDomainHandlers.set(this.page, handler);
                CSReporter.debug('Cross-domain navigation handler initialized');
            }
        }
    }

    /**
     * Get the cross-domain handler for current page
     */
    private getCrossDomainHandler(): CSCrossDomainNavigationHandler | undefined {
        if (this.config.getBoolean('CROSS_DOMAIN_NAVIGATION_ENABLED', true)) {
            return CSBasePage.crossDomainHandlers.get(this.page);
        }
        return undefined;
    }
    
    public async navigate(url?: string): Promise<void> {
        const targetUrl = url || this.url || this.config.get('BASE_URL');
        CSReporter.info(`Navigating to: ${targetUrl}`);

        const crossDomainHandler = this.getCrossDomainHandler();

        // Set up cross-domain handler if enabled
        if (crossDomainHandler) {
            crossDomainHandler.setTargetDomain(targetUrl);
            crossDomainHandler.setOriginalDomain(targetUrl);
        }

        // Navigate to the URL
        await this.page.goto(targetUrl, {
            waitUntil: 'domcontentloaded', // Use domcontentloaded for faster initial navigation
            timeout: this.config.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000)
        });

        // Handle potential authentication redirect
        if (crossDomainHandler) {
            // Check if we're being redirected to authentication
            await crossDomainHandler.handleInitialAuthRedirect(targetUrl);

            // If we're in cross-domain navigation, wait for it to complete
            if (crossDomainHandler.isInCrossDomainNavigation()) {
                CSReporter.info('Detected cross-domain authentication redirect, waiting for completion...');
                await crossDomainHandler.forceWaitForNavigation();
            }
        } else {
            // Fallback to regular wait for load
            await this.page.waitForLoadState('load', {
                timeout: this.config.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000)
            });
        }

        CSReporter.debug('Navigation complete');
    }

    public async waitForPageLoad(): Promise<void> {
        // Use a reasonable timeout from config or default to 30 seconds
        const timeout = this.config.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000);
        // Use 'load' instead of 'networkidle' as recommended by Playwright documentation
        // networkidle is discouraged and can cause unnecessary timeouts
        await this.page.waitForLoadState('load', { timeout });
        CSReporter.debug('Page loaded');
    }
    
    public async isAt(): Promise<boolean> {
        // Override in page classes for specific validation
        return true;
    }
    
    public async takeScreenshot(name?: string): Promise<void> {
        const screenshotName = name || `${this.constructor.name}_${Date.now()}`;
        await this.page.screenshot({ 
            path: `./screenshots/${screenshotName}.png`,
            fullPage: true 
        });
        CSReporter.debug(`Screenshot taken: ${screenshotName}`);
    }
    
    protected registerElement(name: string, element: CSWebElement): void {
        this.elements.set(name, element);
    }
    
    protected getElement(name: string): CSWebElement {
        const element = this.elements.get(name);
        if (!element) {
            throw new Error(`Element '${name}' not found in ${this.constructor.name}`);
        }
        return element;
    }
    
    public async waitForElement(elementName: string, timeout?: number): Promise<void> {
        const element = this.getElement(elementName);
        await element.waitForVisible(timeout);
    }
    
    public async executeScript(script: string, ...args: any[]): Promise<any> {
        return await this.page.evaluate(script, ...args);
    }
    
    public async getTitle(): Promise<string> {
        return await this.page.title();
    }
    
    public async getUrl(): Promise<string> {
        return this.page.url();
    }
    
    public async refresh(): Promise<void> {
        await this.page.reload();
        await this.waitForPageLoad();
    }
    
    public async goBack(): Promise<void> {
        await this.page.goBack();
        await this.waitForPageLoad();
    }
    
    public async goForward(): Promise<void> {
        await this.page.goForward();
        await this.waitForPageLoad();
    }

    /**
     * Wait for any ongoing cross-domain navigation to complete
     */
    public async waitForCrossDomainNavigation(): Promise<void> {
        const crossDomainHandler = this.getCrossDomainHandler();
        if (crossDomainHandler && crossDomainHandler.isInCrossDomainNavigation()) {
            CSReporter.info('Waiting for cross-domain navigation to complete...');
            await crossDomainHandler.handleCrossDomainNavigation();
        }
    }

    /**
     * Get cross-domain navigation state
     */
    public getCrossDomainNavigationState(): any {
        const crossDomainHandler = this.getCrossDomainHandler();
        if (crossDomainHandler) {
            return crossDomainHandler.getNavigationState();
        }
        return null;
    }

    /**
     * Reset cross-domain handler (useful when switching between tests)
     */
    public resetCrossDomainHandler(): void {
        const crossDomainHandler = this.getCrossDomainHandler();
        if (crossDomainHandler) {
            crossDomainHandler.reset();
        }
    }

    /**
     * Update page reference (useful after browser restart or context switch)
     */
    public updatePageReference(newPage: Page): void {
        const oldPage = this.page;
        this.page = newPage;
        // Remove old handler and create new one for new page
        if (this.config.getBoolean('CROSS_DOMAIN_NAVIGATION_ENABLED', true)) {
            CSBasePage.crossDomainHandlers.delete(oldPage);
            const handler = new CSCrossDomainNavigationHandler(this.page);
            CSBasePage.crossDomainHandlers.set(this.page, handler);
            CSReporter.debug('Cross-domain handler reinitialized with new page');
        }
    }
}