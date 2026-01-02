// Lazy load Playwright and BrowserManager for performance
// import { Page } from '@playwright/test';
// import { CSBrowserManager } from '../browser/CSBrowserManager';
type Page = any;
let CSBrowserManager: any = null;
import { CSConfigurationManager } from './CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';
import { CSWebElement } from '../element/CSWebElement';
import { CSCrossDomainNavigationHandler } from '../navigation/CSCrossDomainNavigationHandler';
import { CSSmartPoller, PollResult } from '../wait/CSSmartPoller';

export abstract class CSBasePage {
    protected config: CSConfigurationManager;
    protected browserManager: any; // CSBrowserManager - lazy loaded
    protected url: string = '';
    protected elements: Map<string, CSWebElement> = new Map();
    private static crossDomainHandlers: Map<any, CSCrossDomainNavigationHandler> = new Map();

    // Dynamic page getter - always returns current page from browserManager
    // This ensures page objects always use the current page after browser switch
    protected get page(): any {
        return this.browserManager.getPage();
    }

    constructor() {
        this.config = CSConfigurationManager.getInstance();
        // Lazy load CSBrowserManager
        if (!CSBrowserManager) {
            CSBrowserManager = require('../browser/CSBrowserManager').CSBrowserManager;
        }
        this.browserManager = CSBrowserManager.getInstance();
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
            // Reset handler state before new navigation to ensure clean state between scenarios
            crossDomainHandler.reset();
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
    /**
     * @deprecated No longer needed - page is now dynamically fetched from browserManager
     * Kept for backward compatibility, but does nothing since page is a getter
     */
    public updatePageReference(newPage: Page): void {
        // No-op: page is now a getter that always returns current page from browserManager
        // Cross-domain handlers are updated when the page is accessed
        CSReporter.debug(`[${this.constructor.name}] updatePageReference called (no-op, using dynamic page getter)`);
    }

    // =========================================================================
    // KEYBOARD METHODS - Press keys globally on the page
    // =========================================================================

    /**
     * Press Escape key to close dropdowns, modals, or cancel operations
     */
    public async pressEscapeKey(): Promise<void> {
        await this.page.keyboard.press('Escape');
        CSReporter.debug('Pressed Escape key');
    }

    /**
     * Press Enter key to submit forms or confirm actions
     */
    public async pressEnterKey(): Promise<void> {
        await this.page.keyboard.press('Enter');
        CSReporter.debug('Pressed Enter key');
    }

    /**
     * Press Tab key to move focus to next element
     */
    public async pressTabKey(): Promise<void> {
        await this.page.keyboard.press('Tab');
        CSReporter.debug('Pressed Tab key');
    }

    /**
     * Press Shift+Tab to move focus to previous element
     */
    public async pressShiftTabKey(): Promise<void> {
        await this.page.keyboard.press('Shift+Tab');
        CSReporter.debug('Pressed Shift+Tab key');
    }

    /**
     * Press Backspace key to delete character before cursor
     */
    public async pressBackspaceKey(): Promise<void> {
        await this.page.keyboard.press('Backspace');
        CSReporter.debug('Pressed Backspace key');
    }

    /**
     * Press Delete key to delete character after cursor
     */
    public async pressDeleteKey(): Promise<void> {
        await this.page.keyboard.press('Delete');
        CSReporter.debug('Pressed Delete key');
    }

    /**
     * Press Space key
     */
    public async pressSpaceKey(): Promise<void> {
        await this.page.keyboard.press('Space');
        CSReporter.debug('Pressed Space key');
    }

    /**
     * Press Arrow Down key for dropdown navigation
     */
    public async pressArrowDownKey(): Promise<void> {
        await this.page.keyboard.press('ArrowDown');
        CSReporter.debug('Pressed Arrow Down key');
    }

    /**
     * Press Arrow Up key for dropdown navigation
     */
    public async pressArrowUpKey(): Promise<void> {
        await this.page.keyboard.press('ArrowUp');
        CSReporter.debug('Pressed Arrow Up key');
    }

    /**
     * Press Arrow Left key
     */
    public async pressArrowLeftKey(): Promise<void> {
        await this.page.keyboard.press('ArrowLeft');
        CSReporter.debug('Pressed Arrow Left key');
    }

    /**
     * Press Arrow Right key
     */
    public async pressArrowRightKey(): Promise<void> {
        await this.page.keyboard.press('ArrowRight');
        CSReporter.debug('Pressed Arrow Right key');
    }

    /**
     * Press Home key to go to beginning
     */
    public async pressHomeKey(): Promise<void> {
        await this.page.keyboard.press('Home');
        CSReporter.debug('Pressed Home key');
    }

    /**
     * Press End key to go to end
     */
    public async pressEndKey(): Promise<void> {
        await this.page.keyboard.press('End');
        CSReporter.debug('Pressed End key');
    }

    /**
     * Press Page Up key
     */
    public async pressPageUpKey(): Promise<void> {
        await this.page.keyboard.press('PageUp');
        CSReporter.debug('Pressed Page Up key');
    }

    /**
     * Press Page Down key
     */
    public async pressPageDownKey(): Promise<void> {
        await this.page.keyboard.press('PageDown');
        CSReporter.debug('Pressed Page Down key');
    }

    /**
     * Press any key by name (e.g., 'F1', 'a', 'Control+c')
     */
    public async pressKey(key: string): Promise<void> {
        await this.page.keyboard.press(key);
        CSReporter.debug(`Pressed key: ${key}`);
    }

    /**
     * Type text character by character (simulates real typing)
     */
    public async typeText(text: string): Promise<void> {
        await this.page.keyboard.type(text);
        CSReporter.debug(`Typed text: ${text}`);
    }

    /**
     * Type text with delay between keystrokes (simulates slow typing)
     * @param text Text to type
     * @param delayMs Delay between keystrokes in milliseconds
     */
    public async typeTextSlowly(text: string, delayMs: number = 100): Promise<void> {
        await this.page.keyboard.type(text, { delay: delayMs });
        CSReporter.debug(`Typed text slowly: ${text}`);
    }

    /**
     * Insert text instantly (faster than typing, no key events)
     */
    public async insertText(text: string): Promise<void> {
        await this.page.keyboard.insertText(text);
        CSReporter.debug(`Inserted text: ${text}`);
    }

    /**
     * Hold down a key (use with releaseKey)
     */
    public async holdKey(key: string): Promise<void> {
        await this.page.keyboard.down(key);
        CSReporter.debug(`Holding key: ${key}`);
    }

    /**
     * Release a held key
     */
    public async releaseKey(key: string): Promise<void> {
        await this.page.keyboard.up(key);
        CSReporter.debug(`Released key: ${key}`);
    }

    // Keyboard Shortcuts - Common combinations

    /**
     * Press Ctrl+A to select all
     */
    public async pressSelectAll(): Promise<void> {
        await this.page.keyboard.press('Control+a');
        CSReporter.debug('Pressed Ctrl+A (Select All)');
    }

    /**
     * Press Ctrl+C to copy
     */
    public async pressCopy(): Promise<void> {
        await this.page.keyboard.press('Control+c');
        CSReporter.debug('Pressed Ctrl+C (Copy)');
    }

    /**
     * Press Ctrl+V to paste
     */
    public async pressPaste(): Promise<void> {
        await this.page.keyboard.press('Control+v');
        CSReporter.debug('Pressed Ctrl+V (Paste)');
    }

    /**
     * Press Ctrl+X to cut
     */
    public async pressCut(): Promise<void> {
        await this.page.keyboard.press('Control+x');
        CSReporter.debug('Pressed Ctrl+X (Cut)');
    }

    /**
     * Press Ctrl+Z to undo
     */
    public async pressUndo(): Promise<void> {
        await this.page.keyboard.press('Control+z');
        CSReporter.debug('Pressed Ctrl+Z (Undo)');
    }

    /**
     * Press Ctrl+Y to redo
     */
    public async pressRedo(): Promise<void> {
        await this.page.keyboard.press('Control+y');
        CSReporter.debug('Pressed Ctrl+Y (Redo)');
    }

    /**
     * Press Ctrl+S to save
     */
    public async pressSave(): Promise<void> {
        await this.page.keyboard.press('Control+s');
        CSReporter.debug('Pressed Ctrl+S (Save)');
    }

    /**
     * Press Ctrl+F to find/search
     */
    public async pressFind(): Promise<void> {
        await this.page.keyboard.press('Control+f');
        CSReporter.debug('Pressed Ctrl+F (Find)');
    }

    /**
     * Press F5 to refresh
     */
    public async pressF5Refresh(): Promise<void> {
        await this.page.keyboard.press('F5');
        CSReporter.debug('Pressed F5 (Refresh)');
    }

    /**
     * Press F11 to toggle fullscreen
     */
    public async pressF11Fullscreen(): Promise<void> {
        await this.page.keyboard.press('F11');
        CSReporter.debug('Pressed F11 (Fullscreen)');
    }

    // =========================================================================
    // MOUSE METHODS - Perform mouse actions at specific coordinates
    // =========================================================================

    /**
     * Move mouse to specific coordinates
     */
    public async mouseMoveTo(x: number, y: number): Promise<void> {
        await this.page.mouse.move(x, y);
        CSReporter.debug(`Mouse moved to (${x}, ${y})`);
    }

    /**
     * Click at specific coordinates
     */
    public async mouseClickAt(x: number, y: number): Promise<void> {
        await this.page.mouse.click(x, y);
        CSReporter.debug(`Mouse clicked at (${x}, ${y})`);
    }

    /**
     * Double click at specific coordinates
     */
    public async mouseDoubleClickAt(x: number, y: number): Promise<void> {
        await this.page.mouse.dblclick(x, y);
        CSReporter.debug(`Mouse double-clicked at (${x}, ${y})`);
    }

    /**
     * Right click at specific coordinates
     */
    public async mouseRightClickAt(x: number, y: number): Promise<void> {
        await this.page.mouse.click(x, y, { button: 'right' });
        CSReporter.debug(`Mouse right-clicked at (${x}, ${y})`);
    }

    /**
     * Press mouse button down (use with mouseUp for drag operations)
     */
    public async mouseDown(): Promise<void> {
        await this.page.mouse.down();
        CSReporter.debug('Mouse button pressed down');
    }

    /**
     * Release mouse button
     */
    public async mouseUp(): Promise<void> {
        await this.page.mouse.up();
        CSReporter.debug('Mouse button released');
    }

    /**
     * Scroll mouse wheel vertically
     * @param deltaY Positive = scroll down, Negative = scroll up
     */
    public async mouseScrollVertical(deltaY: number): Promise<void> {
        await this.page.mouse.wheel(0, deltaY);
        CSReporter.debug(`Mouse scrolled vertically: ${deltaY}`);
    }

    /**
     * Scroll mouse wheel horizontally
     * @param deltaX Positive = scroll right, Negative = scroll left
     */
    public async mouseScrollHorizontal(deltaX: number): Promise<void> {
        await this.page.mouse.wheel(deltaX, 0);
        CSReporter.debug(`Mouse scrolled horizontally: ${deltaX}`);
    }

    /**
     * Scroll down the page
     */
    public async scrollDown(pixels: number = 300): Promise<void> {
        await this.page.mouse.wheel(0, pixels);
        CSReporter.debug(`Scrolled down ${pixels}px`);
    }

    /**
     * Scroll up the page
     */
    public async scrollUp(pixels: number = 300): Promise<void> {
        await this.page.mouse.wheel(0, -pixels);
        CSReporter.debug(`Scrolled up ${pixels}px`);
    }

    /**
     * Scroll to top of page
     */
    public async scrollToTop(): Promise<void> {
        await this.page.evaluate(() => window.scrollTo(0, 0));
        CSReporter.debug('Scrolled to top of page');
    }

    /**
     * Scroll to bottom of page
     */
    public async scrollToBottom(): Promise<void> {
        await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        CSReporter.debug('Scrolled to bottom of page');
    }

    /**
     * Drag from one position to another
     */
    public async dragFromTo(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
        await this.page.mouse.move(fromX, fromY);
        await this.page.mouse.down();
        await this.page.mouse.move(toX, toY);
        await this.page.mouse.up();
        CSReporter.debug(`Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY})`);
    }

    // =========================================================================
    // WAIT METHODS - Wait for various conditions
    // =========================================================================

    /**
     * Wait for specified milliseconds
     */
    public async wait(milliseconds: number): Promise<void> {
        await this.page.waitForTimeout(milliseconds);
        CSReporter.debug(`Waited for ${milliseconds}ms`);
    }

    /**
     * Wait for 1 second
     */
    public async waitOneSecond(): Promise<void> {
        await this.page.waitForTimeout(1000);
        CSReporter.debug('Waited 1 second');
    }

    /**
     * Wait for 2 seconds
     */
    public async waitTwoSeconds(): Promise<void> {
        await this.page.waitForTimeout(2000);
        CSReporter.debug('Waited 2 seconds');
    }

    /**
     * Wait for 3 seconds
     */
    public async waitThreeSeconds(): Promise<void> {
        await this.page.waitForTimeout(3000);
        CSReporter.debug('Waited 3 seconds');
    }

    /**
     * Wait for 5 seconds
     */
    public async waitFiveSeconds(): Promise<void> {
        await this.page.waitForTimeout(5000);
        CSReporter.debug('Waited 5 seconds');
    }

    /**
     * Wait for URL to contain specific text
     */
    public async waitForUrlContains(urlPart: string, timeout?: number): Promise<void> {
        const waitTimeout = timeout || this.config.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000);
        await this.page.waitForURL(`**/*${urlPart}*`, { timeout: waitTimeout });
        CSReporter.debug(`URL now contains: ${urlPart}`);
    }

    /**
     * Wait for URL to match exactly
     */
    public async waitForUrlEquals(url: string, timeout?: number): Promise<void> {
        const waitTimeout = timeout || this.config.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000);
        await this.page.waitForURL(url, { timeout: waitTimeout });
        CSReporter.debug(`URL is now: ${url}`);
    }

    /**
     * Wait for element to appear on page by selector
     */
    public async waitForSelector(selector: string, timeout?: number): Promise<void> {
        const waitTimeout = timeout || this.config.getNumber('ELEMENT_WAIT_TIMEOUT', 10000);
        await this.page.waitForSelector(selector, { timeout: waitTimeout });
        CSReporter.debug(`Element appeared: ${selector}`);
    }

    /**
     * Wait for element to disappear from page by selector
     */
    public async waitForSelectorToDisappear(selector: string, timeout?: number): Promise<void> {
        const waitTimeout = timeout || this.config.getNumber('ELEMENT_WAIT_TIMEOUT', 10000);
        await this.page.waitForSelector(selector, { state: 'hidden', timeout: waitTimeout });
        CSReporter.debug(`Element disappeared: ${selector}`);
    }

    /**
     * Wait for network to be idle (no requests for 500ms)
     */
    public async waitForNetworkIdle(): Promise<void> {
        await this.page.waitForLoadState('networkidle');
        CSReporter.debug('Network is idle');
    }

    /**
     * Wait for DOM content to be loaded
     */
    public async waitForDomContentLoaded(): Promise<void> {
        await this.page.waitForLoadState('domcontentloaded');
        CSReporter.debug('DOM content loaded');
    }

    /**
     * Wait for a JavaScript function to return true
     */
    public async waitForCondition(condition: () => boolean | Promise<boolean>, timeout?: number): Promise<void> {
        const waitTimeout = timeout || this.config.getNumber('ELEMENT_WAIT_TIMEOUT', 10000);
        await this.page.waitForFunction(condition, { timeout: waitTimeout });
        CSReporter.debug('Condition met');
    }

    // =========================================================================
    // GENERIC ELEMENT WAIT METHODS - Wait for element states with polling
    // =========================================================================

    /**
     * Wait for element to appear (become visible)
     * @param element - CSWebElement to wait for
     * @param timeout - Maximum wait time in milliseconds (default: 15000)
     * @returns PollResult with success status and timing info
     */
    public async waitForElementToAppear(element: CSWebElement, timeout: number = 15000): Promise<PollResult> {
        const poller = new CSSmartPoller(this.page);
        const description = (element as any).description || 'element';

        CSReporter.debug(`Waiting for ${description} to appear...`);

        const result = await poller.poll({
            condition: async () => await element.isVisibleWithTimeout(500),
            timeout,
            interval: 300,
            backoff: 'none',
            message: `Wait for ${description} to appear`,
            throwOnTimeout: false
        });

        if (result.success) {
            CSReporter.debug(`${description} appeared after ${result.elapsed}ms`);
        } else {
            CSReporter.warn(`${description} did not appear within ${timeout}ms`);
        }

        return result;
    }

    /**
     * Wait for element to disappear (become hidden)
     * @param element - CSWebElement to wait for
     * @param timeout - Maximum wait time in milliseconds (default: 15000)
     * @returns PollResult with success status and timing info
     */
    public async waitForElementToDisappear(element: CSWebElement, timeout: number = 15000): Promise<PollResult> {
        const poller = new CSSmartPoller(this.page);
        const description = (element as any).description || 'element';

        CSReporter.debug(`Waiting for ${description} to disappear...`);

        const result = await poller.poll({
            condition: async () => !(await element.isVisibleWithTimeout(500)),
            timeout,
            interval: 300,
            backoff: 'none',
            message: `Wait for ${description} to disappear`,
            throwOnTimeout: false
        });

        if (result.success) {
            CSReporter.debug(`${description} disappeared after ${result.elapsed}ms`);
        } else {
            CSReporter.warn(`${description} did not disappear within ${timeout}ms`);
        }

        return result;
    }

    /**
     * Wait for element to contain specific text
     * @param element - CSWebElement to check
     * @param text - Text to wait for (case-insensitive partial match)
     * @param timeout - Maximum wait time in milliseconds (default: 15000)
     * @returns PollResult with success status and timing info
     */
    public async waitForElementText(element: CSWebElement, text: string, timeout: number = 15000): Promise<PollResult> {
        const poller = new CSSmartPoller(this.page);
        const description = (element as any).description || 'element';

        CSReporter.debug(`Waiting for ${description} to contain text: "${text}"...`);

        const result = await poller.poll({
            condition: async () => {
                try {
                    const content = await element.textContentWithTimeout(1000);
                    return content?.toLowerCase().includes(text.toLowerCase()) || false;
                } catch {
                    return false;
                }
            },
            timeout,
            interval: 300,
            backoff: 'none',
            message: `Wait for ${description} to contain "${text}"`,
            throwOnTimeout: false
        });

        if (result.success) {
            CSReporter.debug(`${description} contains "${text}" after ${result.elapsed}ms`);
        } else {
            CSReporter.warn(`${description} did not contain "${text}" within ${timeout}ms`);
        }

        return result;
    }

    /**
     * Wait for element to NOT contain specific text (useful for loading placeholders)
     * @param element - CSWebElement to check
     * @param text - Text that should disappear (case-insensitive partial match)
     * @param timeout - Maximum wait time in milliseconds (default: 15000)
     * @returns PollResult with success status and timing info
     */
    public async waitForElementTextToDisappear(element: CSWebElement, text: string, timeout: number = 15000): Promise<PollResult> {
        const poller = new CSSmartPoller(this.page);
        const description = (element as any).description || 'element';

        CSReporter.debug(`Waiting for "${text}" to disappear from ${description}...`);

        const result = await poller.poll({
            condition: async () => {
                try {
                    const content = await element.textContentWithTimeout(1000);
                    // Return true when text is NOT found
                    return !content?.toLowerCase().includes(text.toLowerCase());
                } catch {
                    return true; // Element not accessible = text gone
                }
            },
            timeout,
            interval: 300,
            backoff: 'none',
            message: `Wait for "${text}" to disappear from ${description}`,
            throwOnTimeout: false
        });

        if (result.success) {
            CSReporter.debug(`"${text}" disappeared from ${description} after ${result.elapsed}ms`);
        } else {
            CSReporter.warn(`"${text}" still present in ${description} after ${timeout}ms`);
        }

        return result;
    }

    /**
     * Wait for table to have data (not show "No data" placeholder)
     * Generic method for any table with a loading/empty placeholder
     * @param tableElement - Table CSWebElement
     * @param noDataText - Placeholder text to wait to disappear (default: "No data available")
     * @param timeout - Maximum wait time in milliseconds (default: 15000)
     * @returns PollResult with success status and timing info
     */
    public async waitForTableData(tableElement: CSWebElement, noDataText: string = 'No data available', timeout: number = 15000): Promise<PollResult> {
        const poller = new CSSmartPoller(this.page);
        const description = (tableElement as any).description || 'table';

        CSReporter.debug(`Waiting for ${description} to load data...`);

        const result = await poller.poll({
            condition: async () => {
                try {
                    const content = await tableElement.textContentWithTimeout(1000);
                    // Return true when "No data" text is NOT found
                    return !content?.toLowerCase().includes(noDataText.toLowerCase());
                } catch {
                    return false;
                }
            },
            timeout,
            interval: 500,
            backoff: 'none',
            message: `Wait for ${description} to load data`,
            throwOnTimeout: false
        });

        if (result.success) {
            CSReporter.debug(`${description} loaded data after ${result.elapsed}ms`);
        } else {
            CSReporter.warn(`${description} still showing "${noDataText}" after ${timeout}ms`);
        }

        return result;
    }

    // =========================================================================
    // DIALOG/ALERT METHODS - Handle browser dialogs
    // =========================================================================

    /**
     * Accept the next dialog (alert, confirm, prompt) that appears
     */
    public async acceptNextDialog(): Promise<void> {
        this.page.once('dialog', async (dialog: any) => {
            CSReporter.debug(`Accepting dialog: ${dialog.message()}`);
            await dialog.accept();
        });
        CSReporter.debug('Set up to accept next dialog');
    }

    /**
     * Dismiss the next dialog (alert, confirm, prompt) that appears
     */
    public async dismissNextDialog(): Promise<void> {
        this.page.once('dialog', async (dialog: any) => {
            CSReporter.debug(`Dismissing dialog: ${dialog.message()}`);
            await dialog.dismiss();
        });
        CSReporter.debug('Set up to dismiss next dialog');
    }

    /**
     * Accept the next dialog with input text (for prompt dialogs)
     */
    public async acceptNextDialogWithText(text: string): Promise<void> {
        this.page.once('dialog', async (dialog: any) => {
            CSReporter.debug(`Accepting dialog with text: ${text}`);
            await dialog.accept(text);
        });
        CSReporter.debug('Set up to accept next dialog with text');
    }

    /**
     * Set up persistent dialog handler to always accept
     */
    public async alwaysAcceptDialogs(): Promise<void> {
        this.page.on('dialog', async (dialog: any) => {
            CSReporter.debug(`Auto-accepting dialog: ${dialog.message()}`);
            await dialog.accept();
        });
        CSReporter.debug('Set up to always accept dialogs');
    }

    /**
     * Set up persistent dialog handler to always dismiss
     */
    public async alwaysDismissDialogs(): Promise<void> {
        this.page.on('dialog', async (dialog: any) => {
            CSReporter.debug(`Auto-dismissing dialog: ${dialog.message()}`);
            await dialog.dismiss();
        });
        CSReporter.debug('Set up to always dismiss dialogs');
    }

    // =========================================================================
    // VIEWPORT/WINDOW METHODS - Control browser window
    // =========================================================================

    /**
     * Set viewport size
     */
    public async setViewportSize(width: number, height: number): Promise<void> {
        await this.page.setViewportSize({ width, height });
        CSReporter.debug(`Viewport set to ${width}x${height}`);
    }

    /**
     * Set viewport to desktop size (1920x1080)
     */
    public async setDesktopViewport(): Promise<void> {
        await this.page.setViewportSize({ width: 1920, height: 1080 });
        CSReporter.debug('Viewport set to desktop (1920x1080)');
    }

    /**
     * Set viewport to laptop size (1366x768)
     */
    public async setLaptopViewport(): Promise<void> {
        await this.page.setViewportSize({ width: 1366, height: 768 });
        CSReporter.debug('Viewport set to laptop (1366x768)');
    }

    /**
     * Set viewport to tablet size (768x1024)
     */
    public async setTabletViewport(): Promise<void> {
        await this.page.setViewportSize({ width: 768, height: 1024 });
        CSReporter.debug('Viewport set to tablet (768x1024)');
    }

    /**
     * Set viewport to mobile size (375x667)
     */
    public async setMobileViewport(): Promise<void> {
        await this.page.setViewportSize({ width: 375, height: 667 });
        CSReporter.debug('Viewport set to mobile (375x667)');
    }

    /**
     * Get current viewport size
     */
    public async getViewportSize(): Promise<{ width: number; height: number }> {
        return this.page.viewportSize();
    }

    /**
     * Bring browser window to front
     */
    public async bringToFront(): Promise<void> {
        await this.page.bringToFront();
        CSReporter.debug('Brought page to front');
    }

    // =========================================================================
    // FRAME METHODS - Work with iframes
    // =========================================================================

    /**
     * Switch to iframe by selector
     */
    public async switchToFrame(selector: string): Promise<any> {
        const frameLocator = this.page.frameLocator(selector);
        CSReporter.debug(`Switched to frame: ${selector}`);
        return frameLocator;
    }

    /**
     * Switch to iframe by name or id
     */
    public async switchToFrameByName(nameOrId: string): Promise<any> {
        const frame = this.page.frame({ name: nameOrId });
        if (!frame) {
            throw new Error(`Frame with name/id '${nameOrId}' not found`);
        }
        CSReporter.debug(`Switched to frame: ${nameOrId}`);
        return frame;
    }

    /**
     * Get main frame (exit from iframe)
     */
    public async switchToMainFrame(): Promise<any> {
        const mainFrame = this.page.mainFrame();
        CSReporter.debug('Switched to main frame');
        return mainFrame;
    }

    /**
     * Get all frames on the page
     */
    public async getAllFrames(): Promise<any[]> {
        return this.page.frames();
    }

    // =========================================================================
    // CONTENT METHODS - Get/Set page content
    // =========================================================================

    /**
     * Get full HTML content of the page
     */
    public async getPageContent(): Promise<string> {
        return await this.page.content();
    }

    /**
     * Set HTML content of the page
     */
    public async setPageContent(html: string): Promise<void> {
        await this.page.setContent(html);
        CSReporter.debug('Page content set');
    }

    /**
     * Get text content of the entire page body
     */
    public async getPageText(): Promise<string> {
        return await this.page.innerText('body');
    }

    // =========================================================================
    // PDF/PRINT METHODS - Generate PDF
    // =========================================================================

    /**
     * Generate PDF of the page
     */
    public async generatePdf(path: string): Promise<void> {
        await this.page.pdf({ path, format: 'A4' });
        CSReporter.debug(`PDF generated: ${path}`);
    }

    /**
     * Generate PDF with custom options
     */
    public async generatePdfWithOptions(path: string, options: {
        format?: 'Letter' | 'Legal' | 'Tabloid' | 'Ledger' | 'A0' | 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6';
        landscape?: boolean;
        printBackground?: boolean;
    }): Promise<void> {
        await this.page.pdf({ path, ...options });
        CSReporter.debug(`PDF generated with options: ${path}`);
    }

    // =========================================================================
    // BROWSER CONTEXT METHODS - Cookies, Storage, Permissions
    // =========================================================================

    /**
     * Clear all cookies
     */
    public async clearCookies(): Promise<void> {
        await this.page.context().clearCookies();
        CSReporter.debug('Cookies cleared');
    }

    /**
     * Clear browser permissions
     */
    public async clearPermissions(): Promise<void> {
        await this.page.context().clearPermissions();
        CSReporter.debug('Permissions cleared');
    }

    /**
     * Get all cookies
     */
    public async getCookies(): Promise<any[]> {
        return await this.page.context().cookies();
    }

    /**
     * Add cookies
     */
    public async addCookies(cookies: any[]): Promise<void> {
        await this.page.context().addCookies(cookies);
        CSReporter.debug(`Added ${cookies.length} cookies`);
    }

    /**
     * Clear local storage
     */
    public async clearLocalStorage(): Promise<void> {
        await this.page.evaluate(() => localStorage.clear());
        CSReporter.debug('Local storage cleared');
    }

    /**
     * Clear session storage
     */
    public async clearSessionStorage(): Promise<void> {
        await this.page.evaluate(() => sessionStorage.clear());
        CSReporter.debug('Session storage cleared');
    }

    /**
     * Set local storage item
     */
    public async setLocalStorageItem(key: string, value: string): Promise<void> {
        await this.page.evaluate(([k, v]: [string, string]) => localStorage.setItem(k, v), [key, value]);
        CSReporter.debug(`Local storage set: ${key}`);
    }

    /**
     * Get local storage item
     */
    public async getLocalStorageItem(key: string): Promise<string | null> {
        return await this.page.evaluate((k: string) => localStorage.getItem(k), key);
    }

    /**
     * Set session storage item
     */
    public async setSessionStorageItem(key: string, value: string): Promise<void> {
        await this.page.evaluate(([k, v]: [string, string]) => sessionStorage.setItem(k, v), [key, value]);
        CSReporter.debug(`Session storage set: ${key}`);
    }

    /**
     * Get session storage item
     */
    public async getSessionStorageItem(key: string): Promise<string | null> {
        return await this.page.evaluate((k: string) => sessionStorage.getItem(k), key);
    }

    // =========================================================================
    // FOCUS METHODS - Manage element focus
    // =========================================================================

    /**
     * Focus on element by selector
     */
    public async focusOnSelector(selector: string): Promise<void> {
        await this.page.focus(selector);
        CSReporter.debug(`Focused on: ${selector}`);
    }

    /**
     * Blur (remove focus from) currently focused element
     */
    public async blurActiveElement(): Promise<void> {
        await this.page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
        CSReporter.debug('Blurred active element');
    }

    // =========================================================================
    // MISCELLANEOUS METHODS
    // =========================================================================

    /**
     * Pause execution for debugging (opens Playwright Inspector)
     */
    public async pause(): Promise<void> {
        await this.page.pause();
    }

    /**
     * Close the current page/tab
     */
    public async closePage(): Promise<void> {
        await this.page.close();
        CSReporter.debug('Page closed');
    }

    /**
     * Check if page is closed
     */
    public isClosed(): boolean {
        return this.page.isClosed();
    }

    /**
     * Get the video recording of the page (if enabled)
     */
    public async getVideoPath(): Promise<string | null> {
        const video = this.page.video();
        if (video) {
            return await video.path();
        }
        return null;
    }

    /**
     * Emulate media type (screen or print)
     */
    public async emulateMediaScreen(): Promise<void> {
        await this.page.emulateMedia({ media: 'screen' });
        CSReporter.debug('Emulated screen media');
    }

    /**
     * Emulate print media type
     */
    public async emulateMediaPrint(): Promise<void> {
        await this.page.emulateMedia({ media: 'print' });
        CSReporter.debug('Emulated print media');
    }

    /**
     * Emulate dark color scheme
     */
    public async emulateDarkMode(): Promise<void> {
        await this.page.emulateMedia({ colorScheme: 'dark' });
        CSReporter.debug('Emulated dark mode');
    }

    /**
     * Emulate light color scheme
     */
    public async emulateLightMode(): Promise<void> {
        await this.page.emulateMedia({ colorScheme: 'light' });
        CSReporter.debug('Emulated light mode');
    }

    // =========================================================================
    // FILE CHOOSER METHODS - Handle native file picker dialogs
    // =========================================================================

    /**
     * Upload file via file chooser dialog
     * Use this when clicking a button triggers a native file picker dialog
     * @param triggerElement The element to click that triggers the file chooser (e.g., "Add files" button)
     * @param filePath Full path to the file to upload
     * @param timeout Timeout in milliseconds (default 30000)
     */
    public async uploadFileViaChooser(triggerElement: CSWebElement, filePath: string, timeout: number = 30000): Promise<void> {
        CSReporter.info(`Uploading file via file chooser: ${filePath}`);

        // Set up file chooser listener before clicking the trigger element
        const fileChooserPromise = this.page.waitForEvent('filechooser', { timeout });

        // Click the element that triggers the file chooser
        await triggerElement.clickWithTimeout(timeout);

        // Handle the file chooser
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(filePath);

        await this.waitForPageLoad();
        CSReporter.pass(`File uploaded via chooser: ${filePath}`);
    }

    /**
     * Upload multiple files via file chooser dialog
     * Use this when clicking a button triggers a native file picker dialog
     * @param triggerElement The element to click that triggers the file chooser
     * @param filePaths Array of full paths to files to upload
     * @param timeout Timeout in milliseconds (default 30000)
     */
    public async uploadMultipleFilesViaChooser(triggerElement: CSWebElement, filePaths: string[], timeout: number = 30000): Promise<void> {
        CSReporter.info(`Uploading ${filePaths.length} files via file chooser`);

        for (const filePath of filePaths) {
            // Set up file chooser listener before clicking the trigger element
            const fileChooserPromise = this.page.waitForEvent('filechooser', { timeout });

            // Click the element that triggers the file chooser
            await triggerElement.clickWithTimeout(timeout);

            // Handle the file chooser
            const fileChooser = await fileChooserPromise;
            await fileChooser.setFiles(filePath);

            await this.waitForPageLoad();
            CSReporter.debug(`File added via chooser: ${filePath}`);
        }

        CSReporter.pass(`${filePaths.length} files uploaded via chooser`);
    }

    /**
     * Upload multiple files at once via file chooser dialog (ALL FILES IN SINGLE DIALOG)
     * Use this when the application requires all files to be selected at once in a single file dialog
     * This is useful when the trigger element (e.g., Add files button) gets disabled after first file selection
     * @param triggerElement The element to click that triggers the file chooser
     * @param filePaths Array of full paths to files to upload
     * @param timeout Timeout in milliseconds (default 30000)
     */
    public async uploadMultipleFilesAtOnceViaChooser(triggerElement: CSWebElement, filePaths: string[], timeout: number = 30000): Promise<void> {
        CSReporter.info(`Uploading ${filePaths.length} files at once via file chooser`);

        // Set up file chooser listener before clicking the trigger element
        const fileChooserPromise = this.page.waitForEvent('filechooser', { timeout });

        // Click the element that triggers the file chooser
        await triggerElement.clickWithTimeout(timeout);

        // Handle the file chooser - set ALL files at once
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(filePaths);

        await this.waitForPageLoad();
        CSReporter.pass(`${filePaths.length} files selected at once via chooser`);
    }

    /**
     * Upload file via file chooser with custom action before choosing file
     * Use this when you need to perform custom actions after file chooser opens
     * @param triggerAction Function that triggers the file chooser
     * @param filePath Full path to the file to upload
     * @param timeout Timeout in milliseconds (default 30000)
     */
    public async uploadFileViaChooserWithAction(triggerAction: () => Promise<void>, filePath: string, timeout: number = 30000): Promise<void> {
        CSReporter.info(`Uploading file via file chooser with custom action: ${filePath}`);

        // Set up file chooser listener before executing the trigger action
        const fileChooserPromise = this.page.waitForEvent('filechooser', { timeout });

        // Execute the trigger action
        await triggerAction();

        // Handle the file chooser
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(filePath);

        await this.waitForPageLoad();
        CSReporter.pass(`File uploaded via chooser with custom action: ${filePath}`);
    }

    /**
     * Get element count by XPath selector
     * Uses Playwright locator to count elements matching the XPath
     * @param xpath XPath selector
     * @returns Number of elements matching the XPath
     */
    public async getElementCountByXPath(xpath: string): Promise<number> {
        const count = await this.page.locator(`xpath=${xpath}`).count();
        CSReporter.debug(`Element count for XPath "${xpath}": ${count}`);
        return count;
    }

    /**
     * Get element count by CSS selector
     * Uses Playwright locator to count elements matching the CSS selector
     * @param cssSelector CSS selector
     * @returns Number of elements matching the selector
     */
    public async getElementCountByCSS(cssSelector: string): Promise<number> {
        const count = await this.page.locator(cssSelector).count();
        CSReporter.debug(`Element count for CSS "${cssSelector}": ${count}`);
        return count;
    }

    /**
     * Set default timeout for all operations
     */
    public setDefaultTimeout(timeout: number): void {
        this.page.setDefaultTimeout(timeout);
        CSReporter.debug(`Default timeout set to ${timeout}ms`);
    }

    /**
     * Set default navigation timeout
     */
    public setDefaultNavigationTimeout(timeout: number): void {
        this.page.setDefaultNavigationTimeout(timeout);
        CSReporter.debug(`Default navigation timeout set to ${timeout}ms`);
    }
}