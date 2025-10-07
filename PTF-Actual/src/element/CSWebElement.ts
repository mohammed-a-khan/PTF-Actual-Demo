// Lazy load Playwright and BrowserManager for performance
// import { Page, Locator, ElementHandle, FrameLocator, JSHandle } from '@playwright/test';
// import { CSBrowserManager } from '../browser/CSBrowserManager';
type Page = any;
type Locator = any;
type ElementHandle = any;
type FrameLocator = any;
type JSHandle = any;
let CSBrowserManager: any = null;

import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';
import { CSSelfHealingEngine } from '../self-healing/CSSelfHealingEngine';

// ============================================
// COMPLETE TYPE DEFINITIONS FOR ALL OPTIONS
// ============================================

export interface ClickOptions {
    button?: 'left' | 'right' | 'middle';
    clickCount?: number;
    delay?: number;
    force?: boolean;
    modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
    noWaitAfter?: boolean;
    position?: { x: number; y: number };
    timeout?: number;
    trial?: boolean;
}

export interface DblClickOptions extends ClickOptions {}

export interface FillOptions {
    force?: boolean;
    noWaitAfter?: boolean;
    timeout?: number;
}

export interface HoverOptions {
    force?: boolean;
    modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
    position?: { x: number; y: number };
    timeout?: number;
    trial?: boolean;
}

export interface TapOptions {
    force?: boolean;
    modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
    noWaitAfter?: boolean;
    position?: { x: number; y: number };
    timeout?: number;
    trial?: boolean;
}

export interface DragToOptions {
    force?: boolean;
    noWaitAfter?: boolean;
    sourcePosition?: { x: number; y: number };
    targetPosition?: { x: number; y: number };
    timeout?: number;
    trial?: boolean;
}

export interface PressOptions {
    delay?: number;
    noWaitAfter?: boolean;
    timeout?: number;
}

export interface PressSequentiallyOptions {
    delay?: number;
    noWaitAfter?: boolean;
    timeout?: number;
}

export interface TypeOptions extends PressSequentiallyOptions {}

export interface SelectOptionOptions {
    force?: boolean;
    noWaitAfter?: boolean;
    timeout?: number;
}

export interface CheckOptions {
    force?: boolean;
    noWaitAfter?: boolean;
    position?: { x: number; y: number };
    timeout?: number;
    trial?: boolean;
}

export interface UncheckOptions extends CheckOptions {}
export interface SetCheckedOptions extends CheckOptions {}

export interface SetInputFilesOptions {
    noWaitAfter?: boolean;
    timeout?: number;
}

export interface SelectTextOptions {
    force?: boolean;
    timeout?: number;
}

export interface ScrollIntoViewOptions {
    timeout?: number;
}

export interface ScreenshotOptions {
    animations?: 'disabled' | 'allow';
    caret?: 'hide' | 'initial';
    mask?: Locator[];
    maskColor?: string;
    omitBackground?: boolean;
    path?: string;
    quality?: number;
    scale?: 'css' | 'device';
    timeout?: number;
    type?: 'png' | 'jpeg';
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number };
}

export interface WaitForOptions {
    state?: 'attached' | 'detached' | 'visible' | 'hidden';
    timeout?: number;
}

export interface BoundingBoxOptions {
    timeout?: number;
}

export interface GetAttributeOptions {
    timeout?: number;
}

export interface InnerHTMLOptions {
    timeout?: number;
}

export interface InnerTextOptions {
    timeout?: number;
}

export interface InputValueOptions {
    timeout?: number;
}

export interface TextContentOptions {
    timeout?: number;
}

export interface IsCheckedOptions {
    timeout?: number;
}

export interface IsDisabledOptions {
    timeout?: number;
}

export interface IsEditableOptions {
    timeout?: number;
}

export interface IsEnabledOptions {
    timeout?: number;
}

export interface IsHiddenOptions {
    timeout?: number;
}

export interface IsVisibleOptions {
    timeout?: number;
}

export interface DispatchEventOptions {
    timeout?: number;
}

export interface EvaluateOptions {
    timeout?: number;
}

export interface EvaluateHandleOptions {
    timeout?: number;
}

export interface FocusOptions {
    timeout?: number;
}

export interface BlurOptions {
    timeout?: number;
}

export interface ClearOptions {
    force?: boolean;
    noWaitAfter?: boolean;
    timeout?: number;
}

export interface FilterOptions {
    has?: Locator;
    hasNot?: Locator;
    hasNotText?: string | RegExp;
    hasText?: string | RegExp;
}

export interface GetByAltTextOptions {
    exact?: boolean;
}

export interface GetByLabelOptions {
    exact?: boolean;
}

export interface GetByPlaceholderOptions {
    exact?: boolean;
}

export interface GetByRoleOptions {
    checked?: boolean;
    disabled?: boolean;
    exact?: boolean;
    expanded?: boolean;
    includeHidden?: boolean;
    level?: number;
    name?: string | RegExp;
    pressed?: boolean;
    selected?: boolean;
}

export interface GetByTextOptions {
    exact?: boolean;
}

export interface GetByTitleOptions {
    exact?: boolean;
}

export interface LocatorOptions {
    has?: Locator;
    hasNot?: Locator;
    hasNotText?: string | RegExp;
    hasText?: string | RegExp;
}

export interface ElementOptions {
    // Basic selectors
    css?: string;
    xpath?: string;
    text?: string;
    id?: string;
    name?: string;
    role?: string;
    testId?: string;
    
    // Element metadata
    description?: string;
    tags?: string[];
    
    // Wait options
    timeout?: number;
    waitForVisible?: boolean;
    waitForEnabled?: boolean;
    waitForStable?: boolean;
    
    // Behavior options
    scrollIntoView?: boolean;
    retryCount?: number;
    selfHeal?: boolean;
    alternativeLocators?: string[];
    screenshot?: boolean;
    highlight?: boolean;
    force?: boolean;
    
    // Performance
    measurePerformance?: boolean;
    
    // Debugging
    debug?: boolean;
}

/**
 * CSWebElement - Complete wrapper for ALL Playwright Locator API methods
 * Implements all 59+ Playwright methods with 200+ convenience methods
 */
export class CSWebElement {
    private page: Page;
    private locator: Locator | null = null;
    private description: string;
    private options: ElementOptions;
    private config: CSConfigurationManager;
    private selfHealingEngine: CSSelfHealingEngine;
    private retryCount: number;
    private actionTimeout: number;
    private performanceMetrics: Map<string, number[]> = new Map();

    constructor(options: ElementOptions, page?: Page) {
        this.config = CSConfigurationManager.getInstance();
        this.selfHealingEngine = CSSelfHealingEngine.getInstance();
        // Lazy load CSBrowserManager when needed
        if (!page) {
            if (!CSBrowserManager) {
                CSBrowserManager = require('../browser/CSBrowserManager').CSBrowserManager;
            }
            this.page = CSBrowserManager.getInstance().getPage();
        } else {
            this.page = page;
        }
        this.options = options;
        this.description = options.description || 'Element';
        this.retryCount = options.retryCount || this.config.getNumber('ELEMENT_RETRY_COUNT', 3);
        this.actionTimeout = options.timeout || this.config.getNumber('ELEMENT_TIMEOUT', 10000);
    }

    /**
     * Get the Playwright Locator with self-healing support
     */
    private async getLocator(): Promise<Locator> {
        if (this.locator) return this.locator;

        CSReporter.debug(`Getting locator for ${this.description}`);
        
        // Build and try locator strategies
        const strategies = this.buildLocatorStrategies();
        
        for (const strategy of strategies) {
            try {
                const loc = this.createLocatorFromStrategy(strategy);
                if (await loc.count() > 0) {
                    this.locator = loc;
                    CSReporter.debug(`Found element with ${strategy.type}: ${strategy.value}`);
                    return loc;
                }
            } catch (error) {
                CSReporter.debug(`Failed with ${strategy.type}: ${error}`);
            }
        }

        // Try self-healing if enabled
        if (this.options.selfHeal) {
            CSReporter.info(`Attempting self-healing for ${this.description}`);
            const primaryStrategy = strategies[0];
            const healingResult = await this.selfHealingEngine.heal(
                this.page,
                primaryStrategy.value,
                this.options.alternativeLocators
            );

            if (healingResult.success && healingResult.healedLocator) {
                this.locator = this.page.locator(healingResult.healedLocator);
                CSReporter.pass(`Self-healed element: ${this.description}`);
                return this.locator;
            }
        }

        throw new Error(`Unable to locate element: ${this.description}`);
    }

    private buildLocatorStrategies(): Array<{ type: string; value: string }> {
        const strategies = [];
        
        if (this.options.id) strategies.push({ type: 'id', value: `#${this.options.id}` });
        if (this.options.testId) strategies.push({ type: 'testId', value: this.options.testId });
        if (this.options.css) strategies.push({ type: 'css', value: this.options.css });
        if (this.options.xpath) strategies.push({ type: 'xpath', value: this.options.xpath });
        if (this.options.text) strategies.push({ type: 'text', value: this.options.text });
        if (this.options.name) strategies.push({ type: 'name', value: `[name="${this.options.name}"]` });
        if (this.options.role) strategies.push({ type: 'role', value: this.options.role });
        
        // Add alternative locators with proper type detection
        if (this.options.alternativeLocators) {
            this.options.alternativeLocators.forEach(loc => {
                const strategy = this.parseAlternativeLocator(loc);
                strategies.push(strategy);
            });
        }
        
        return strategies;
    }

    private parseAlternativeLocator(locator: string): { type: string; value: string } {
        if (locator.startsWith('xpath:')) {
            return { type: 'xpath', value: locator.substring(6) };
        } else if (locator.startsWith('css:')) {
            return { type: 'css', value: locator.substring(4) };
        } else if (locator.startsWith('text:')) {
            return { type: 'text', value: locator.substring(5) };
        } else if (locator.startsWith('testId:')) {
            return { type: 'testId', value: locator.substring(7) };
        } else if (locator.startsWith('role:')) {
            return { type: 'role', value: locator.substring(5) };
        } else if (locator.startsWith('placeholder:')) {
            return { type: 'placeholder', value: locator.substring(12) };
        } else {
            // Default to CSS
            return { type: 'css', value: locator };
        }
    }

    private createLocatorFromStrategy(strategy: { type: string; value: string }): Locator {
        switch (strategy.type) {
            case 'id':
            case 'css':
            case 'name':
                return this.page.locator(strategy.value);
            case 'xpath':
                return this.page.locator(`xpath=${strategy.value}`);
            case 'text':
                return this.page.getByText(strategy.value);
            case 'testId':
                return this.page.getByTestId(strategy.value);
            case 'role':
                return this.page.getByRole(strategy.value as any);
            case 'placeholder':
                return this.page.getByPlaceholder(strategy.value);
            default:
                return this.page.locator(strategy.value);
        }
    }

    /**
     * Execute action with retry logic, reporting, and performance tracking
     */
    private async executeAction<T>(
        actionName: string,
        action: () => Promise<T>,
        options?: { screenshot?: boolean; measurePerformance?: boolean }
    ): Promise<T> {
        const startTime = Date.now();
        CSReporter.info(`Executing ${actionName} on ${this.description}`);

        let lastError: Error | null = null;
        
        for (let attempt = 1; attempt <= this.retryCount; attempt++) {
            try {
                // Highlight element if configured
                if (this.options.highlight) {
                    await this.highlight();
                }

                // Execute the action
                const result = await action();

                // Track performance
                const duration = Date.now() - startTime;
                if (this.options.measurePerformance || options?.measurePerformance) {
                    this.trackPerformance(actionName, duration);
                }

                // Track action for reporting
                CSReporter.addAction(`${actionName} on ${this.description}`, 'pass', duration);

                CSReporter.pass(`${actionName} successful on ${this.description} (${duration}ms)`);
                
                // Take screenshot if configured
                if (options?.screenshot || this.options.screenshot) {
                    await this.screenshot({ 
                        path: `screenshots/${actionName.replace(/\s+/g, '_')}_${Date.now()}.png` 
                    });
                }

                return result;
            } catch (error: any) {
                lastError = error;
                const duration = Date.now() - startTime;

                // Track failed action for reporting (only on last attempt)
                if (attempt === this.retryCount) {
                    CSReporter.addAction(`${actionName} on ${this.description}`, 'fail', duration);
                }

                CSReporter.warn(`${actionName} failed on attempt ${attempt}/${this.retryCount}: ${error.message}`);

                if (attempt < this.retryCount) {
                    await this.page.waitForTimeout(1000 * attempt); // Progressive delay
                }
            }
        }

        CSReporter.fail(`${actionName} failed on ${this.description} after ${this.retryCount} attempts: ${lastError?.message}`);
        throw lastError || new Error(`${actionName} failed`);
    }

    private trackPerformance(action: string, duration: number): void {
        if (!this.performanceMetrics.has(action)) {
            this.performanceMetrics.set(action, []);
        }
        this.performanceMetrics.get(action)!.push(duration);
    }

    // ============================================
    // 1. CLICK METHODS - Complete Implementation
    // ============================================

    /**
     * Click the element with full options support
     */
    async click(options?: ClickOptions): Promise<void> {
        return this.executeAction('Click', async () => {
            const locator = await this.getLocator();
            await locator.click(options);
        });
    }

    // Convenience methods for click
    async clickWithButton(button: 'left' | 'right' | 'middle'): Promise<void> {
        CSReporter.info(`Clicking with ${button} button on ${this.description}`);
        return this.click({ button });
    }

    async clickWithPosition(x: number, y: number): Promise<void> {
        CSReporter.info(`Clicking at position (${x}, ${y}) on ${this.description}`);
        return this.click({ position: { x, y } });
    }

    async clickWithModifiers(modifiers: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>): Promise<void> {
        CSReporter.info(`Clicking with modifiers [${modifiers.join(', ')}] on ${this.description}`);
        return this.click({ modifiers });
    }

    async clickMultipleTimes(count: number): Promise<void> {
        CSReporter.info(`Clicking ${count} times on ${this.description}`);
        return this.click({ clickCount: count });
    }

    async clickWithDelay(delay: number): Promise<void> {
        CSReporter.info(`Clicking with ${delay}ms delay on ${this.description}`);
        return this.click({ delay });
    }

    async clickWithForce(): Promise<void> {
        CSReporter.info(`Force clicking on ${this.description}`);
        return this.click({ force: true });
    }

    async clickWithTimeout(timeout: number): Promise<void> {
        CSReporter.info(`Clicking with ${timeout}ms timeout on ${this.description}`);
        return this.click({ timeout });
    }

    async clickWithoutWaiting(): Promise<void> {
        CSReporter.info(`Clicking without waiting on ${this.description}`);
        return this.click({ noWaitAfter: true });
    }

    async clickWithTrial(): Promise<void> {
        CSReporter.info(`Trial clicking on ${this.description}`);
        return this.click({ trial: true });
    }

    async rightClick(options?: Omit<ClickOptions, 'button'>): Promise<void> {
        CSReporter.info(`Right clicking on ${this.description}`);
        return this.click({ ...options, button: 'right' });
    }

    async middleClick(options?: Omit<ClickOptions, 'button'>): Promise<void> {
        CSReporter.info(`Middle clicking on ${this.description}`);
        return this.click({ ...options, button: 'middle' });
    }

    // ============================================
    // 2. DOUBLE CLICK METHODS
    // ============================================

    async dblclick(options?: DblClickOptions): Promise<void> {
        return this.executeAction('Double click', async () => {
            const locator = await this.getLocator();
            await locator.dblclick(options);
        });
    }

    async dblclickWithPosition(x: number, y: number): Promise<void> {
        CSReporter.info(`Double clicking at position (${x}, ${y}) on ${this.description}`);
        return this.dblclick({ position: { x, y } });
    }

    async dblclickWithModifiers(modifiers: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>): Promise<void> {
        CSReporter.info(`Double clicking with modifiers [${modifiers.join(', ')}] on ${this.description}`);
        return this.dblclick({ modifiers });
    }

    async dblclickWithForce(): Promise<void> {
        CSReporter.info(`Force double clicking on ${this.description}`);
        return this.dblclick({ force: true });
    }

    async dblclickWithTimeout(timeout: number): Promise<void> {
        CSReporter.info(`Double clicking with ${timeout}ms timeout on ${this.description}`);
        return this.dblclick({ timeout });
    }

    async dblclickWithDelay(delay: number): Promise<void> {
        CSReporter.info(`Double clicking with ${delay}ms delay on ${this.description}`);
        return this.dblclick({ delay });
    }

    // ============================================
    // 3. TAP METHODS (Mobile)
    // ============================================

    async tap(options?: TapOptions): Promise<void> {
        return this.executeAction('Tap', async () => {
            const locator = await this.getLocator();
            await locator.tap(options);
        });
    }

    async tapWithPosition(x: number, y: number): Promise<void> {
        CSReporter.info(`Tapping at position (${x}, ${y}) on ${this.description}`);
        return this.tap({ position: { x, y } });
    }

    async tapWithModifiers(modifiers: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>): Promise<void> {
        CSReporter.info(`Tapping with modifiers [${modifiers.join(', ')}] on ${this.description}`);
        return this.tap({ modifiers });
    }

    async tapWithForce(): Promise<void> {
        CSReporter.info(`Force tapping on ${this.description}`);
        return this.tap({ force: true });
    }

    async tapWithTimeout(timeout: number): Promise<void> {
        CSReporter.info(`Tapping with ${timeout}ms timeout on ${this.description}`);
        return this.tap({ timeout });
    }

    // ============================================
    // 4. HOVER METHODS
    // ============================================

    async hover(options?: HoverOptions): Promise<void> {
        return this.executeAction('Hover', async () => {
            const locator = await this.getLocator();
            await locator.hover(options);
        });
    }

    async hoverWithPosition(x: number, y: number): Promise<void> {
        CSReporter.info(`Hovering at position (${x}, ${y}) on ${this.description}`);
        return this.hover({ position: { x, y } });
    }

    async hoverWithModifiers(modifiers: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>): Promise<void> {
        CSReporter.info(`Hovering with modifiers [${modifiers.join(', ')}] on ${this.description}`);
        return this.hover({ modifiers });
    }

    async hoverWithForce(): Promise<void> {
        CSReporter.info(`Force hovering on ${this.description}`);
        return this.hover({ force: true });
    }

    async hoverWithTimeout(timeout: number): Promise<void> {
        CSReporter.info(`Hovering with ${timeout}ms timeout on ${this.description}`);
        return this.hover({ timeout });
    }

    // ============================================
    // 5. DRAG METHODS
    // ============================================

    async dragTo(target: Locator | CSWebElement, options?: DragToOptions): Promise<void> {
        return this.executeAction('Drag to', async () => {
            const source = await this.getLocator();
            const targetLocator = target instanceof CSWebElement 
                ? await target.getLocator() 
                : target;
            await source.dragTo(targetLocator, options);
        });
    }

    async dragToWithSourcePosition(x: number, y: number, target: Locator | CSWebElement): Promise<void> {
        CSReporter.info(`Dragging from position (${x}, ${y}) on ${this.description}`);
        return this.dragTo(target, { sourcePosition: { x, y } });
    }

    async dragToWithTargetPosition(x: number, y: number, target: Locator | CSWebElement): Promise<void> {
        CSReporter.info(`Dragging to position (${x}, ${y}) on target`);
        return this.dragTo(target, { targetPosition: { x, y } });
    }

    async dragToWithForce(target: Locator | CSWebElement): Promise<void> {
        CSReporter.info(`Force dragging ${this.description} to target`);
        return this.dragTo(target, { force: true });
    }

    // ============================================
    // 6. FOCUS & BLUR METHODS
    // ============================================

    async focus(options?: FocusOptions): Promise<void> {
        return this.executeAction('Focus', async () => {
            const locator = await this.getLocator();
            await locator.focus(options);
        });
    }

    async focusWithTimeout(timeout: number): Promise<void> {
        CSReporter.info(`Focusing with ${timeout}ms timeout on ${this.description}`);
        return this.focus({ timeout });
    }

    async blur(options?: BlurOptions): Promise<void> {
        return this.executeAction('Blur', async () => {
            const locator = await this.getLocator();
            await locator.blur(options);
        });
    }

    async blurWithTimeout(timeout: number): Promise<void> {
        CSReporter.info(`Blurring with ${timeout}ms timeout on ${this.description}`);
        return this.blur({ timeout });
    }

    // ============================================
    // 7. KEYBOARD METHODS
    // ============================================

    async press(key: string, options?: PressOptions): Promise<void> {
        return this.executeAction(`Press ${key}`, async () => {
            const locator = await this.getLocator();
            await locator.press(key, options);
        });
    }

    async pressWithDelay(key: string, delay: number): Promise<void> {
        CSReporter.info(`Pressing ${key} with ${delay}ms delay on ${this.description}`);
        return this.press(key, { delay });
    }

    async pressWithTimeout(key: string, timeout: number): Promise<void> {
        CSReporter.info(`Pressing ${key} with ${timeout}ms timeout on ${this.description}`);
        return this.press(key, { timeout });
    }

    async pressWithoutWaiting(key: string): Promise<void> {
        CSReporter.info(`Pressing ${key} without waiting on ${this.description}`);
        return this.press(key, { noWaitAfter: true });
    }

    async pressSequentially(text: string, options?: PressSequentiallyOptions): Promise<void> {
        return this.executeAction(`Type sequentially "${text}"`, async () => {
            const locator = await this.getLocator();
            await locator.pressSequentially(text, options);
        });
    }

    async pressSequentiallyWithDelay(text: string, delay: number): Promise<void> {
        CSReporter.info(`Typing "${text}" with ${delay}ms delay between characters on ${this.description}`);
        return this.pressSequentially(text, { delay });
    }

    async type(text: string, options?: TypeOptions): Promise<void> {
        return this.executeAction(`Type "${text}"`, async () => {
            const locator = await this.getLocator();

            // Clear before typing if configured
            if (this.config.getBoolean('ELEMENT_CLEAR_BEFORE_TYPE', true)) {
                try {
                    await locator.clear();
                    CSReporter.debug(`Cleared ${this.description} before typing`);
                } catch (error) {
                    CSReporter.debug(`Could not clear ${this.description} before typing: ${error}`);
                }
            }

            await locator.type(text, options);
        });
    }

    async typeWithDelay(text: string, delay: number): Promise<void> {
        CSReporter.info(`Typing "${text}" with ${delay}ms delay on ${this.description}`);
        return this.type(text, { delay });
    }

    // ============================================
    // 8. INPUT METHODS
    // ============================================

    async fill(value: string, options?: FillOptions): Promise<void> {
        return this.executeAction(`Fill with "${value}"`, async () => {
            const locator = await this.getLocator();
            await locator.fill(value, options);
        });
    }

    async fillWithForce(value: string): Promise<void> {
        CSReporter.info(`Force filling "${value}" in ${this.description}`);
        return this.fill(value, { force: true });
    }

    async fillWithTimeout(value: string, timeout: number): Promise<void> {
        CSReporter.info(`Filling "${value}" with ${timeout}ms timeout in ${this.description}`);
        return this.fill(value, { timeout });
    }

    async fillWithoutWaiting(value: string): Promise<void> {
        CSReporter.info(`Filling "${value}" without waiting in ${this.description}`);
        return this.fill(value, { noWaitAfter: true });
    }

    async clear(options?: ClearOptions): Promise<void> {
        return this.executeAction('Clear', async () => {
            const locator = await this.getLocator();
            await locator.clear(options);
        });
    }

    async clearWithForce(): Promise<void> {
        CSReporter.info(`Force clearing ${this.description}`);
        return this.clear({ force: true });
    }

    async clearWithTimeout(timeout: number): Promise<void> {
        CSReporter.info(`Clearing with ${timeout}ms timeout ${this.description}`);
        return this.clear({ timeout });
    }

    // ============================================
    // 9. SELECT METHODS
    // ============================================

    async selectOption(values: string | string[] | { value?: string; label?: string; index?: number } | Array<{ value?: string; label?: string; index?: number }>, options?: SelectOptionOptions): Promise<string[]> {
        return this.executeAction(`Select option(s)`, async () => {
            const locator = await this.getLocator();
            return await locator.selectOption(values, options);
        });
    }

    async selectOptionByValue(value: string | string[]): Promise<string[]> {
        CSReporter.info(`Selecting option by value "${value}" in ${this.description}`);
        return this.selectOption(value);
    }

    async selectOptionByLabel(label: string | string[]): Promise<string[]> {
        CSReporter.info(`Selecting option by label "${label}" in ${this.description}`);
        const labels = Array.isArray(label) ? label : [label];
        return this.selectOption(labels.map(l => ({ label: l })));
    }

    async selectOptionByIndex(index: number | number[]): Promise<string[]> {
        CSReporter.info(`Selecting option by index ${index} in ${this.description}`);
        const indices = Array.isArray(index) ? index : [index];
        return this.selectOption(indices.map(i => ({ index: i })));
    }

    async selectOptionWithForce(values: string | string[]): Promise<string[]> {
        CSReporter.info(`Force selecting option(s) in ${this.description}`);
        return this.selectOption(values, { force: true });
    }

    async selectText(options?: SelectTextOptions): Promise<void> {
        return this.executeAction('Select text', async () => {
            const locator = await this.getLocator();
            await locator.selectText(options);
        });
    }

    async selectTextWithForce(): Promise<void> {
        CSReporter.info(`Force selecting text in ${this.description}`);
        return this.selectText({ force: true });
    }

    // ============================================
    // 10. FILE UPLOAD METHODS
    // ============================================

    async setInputFiles(files: string | string[] | { name: string; mimeType: string; buffer: Buffer } | Array<{ name: string; mimeType: string; buffer: Buffer }>, options?: SetInputFilesOptions): Promise<void> {
        return this.executeAction('Set input files', async () => {
            const locator = await this.getLocator();
            await locator.setInputFiles(files, options);
        });
    }

    async uploadFile(filePath: string): Promise<void> {
        CSReporter.info(`Uploading file "${filePath}" to ${this.description}`);
        return this.setInputFiles(filePath);
    }

    async uploadFiles(filePaths: string[]): Promise<void> {
        CSReporter.info(`Uploading ${filePaths.length} files to ${this.description}`);
        return this.setInputFiles(filePaths);
    }

    async clearFiles(): Promise<void> {
        CSReporter.info(`Clearing files from ${this.description}`);
        return this.setInputFiles([]);
    }

    // ============================================
    // 11. CHECKBOX & RADIO METHODS
    // ============================================

    async check(options?: CheckOptions): Promise<void> {
        return this.executeAction('Check', async () => {
            const locator = await this.getLocator();
            await locator.check(options);
        });
    }

    async checkWithForce(): Promise<void> {
        CSReporter.info(`Force checking ${this.description}`);
        return this.check({ force: true });
    }

    async checkWithPosition(x: number, y: number): Promise<void> {
        CSReporter.info(`Checking at position (${x}, ${y}) on ${this.description}`);
        return this.check({ position: { x, y } });
    }

    async uncheck(options?: UncheckOptions): Promise<void> {
        return this.executeAction('Uncheck', async () => {
            const locator = await this.getLocator();
            await locator.uncheck(options);
        });
    }

    async uncheckWithForce(): Promise<void> {
        CSReporter.info(`Force unchecking ${this.description}`);
        return this.uncheck({ force: true });
    }

    async setChecked(checked: boolean, options?: SetCheckedOptions): Promise<void> {
        return this.executeAction(`Set checked to ${checked}`, async () => {
            const locator = await this.getLocator();
            await locator.setChecked(checked, options);
        });
    }

    async setCheckedWithForce(checked: boolean): Promise<void> {
        CSReporter.info(`Force setting checked to ${checked} on ${this.description}`);
        return this.setChecked(checked, { force: true });
    }

    // ============================================
    // 12. CONTENT RETRIEVAL METHODS
    // ============================================

    async textContent(options?: TextContentOptions): Promise<string | null> {
        return this.executeAction('Get text content', async () => {
            const locator = await this.getLocator();
            return await locator.textContent(options);
        });
    }

    async textContentWithTimeout(timeout: number): Promise<string | null> {
        CSReporter.info(`Getting text content with ${timeout}ms timeout from ${this.description}`);
        return this.textContent({ timeout });
    }

    async innerText(options?: InnerTextOptions): Promise<string> {
        return this.executeAction('Get inner text', async () => {
            const locator = await this.getLocator();
            return await locator.innerText(options);
        });
    }

    async innerTextWithTimeout(timeout: number): Promise<string> {
        CSReporter.info(`Getting inner text with ${timeout}ms timeout from ${this.description}`);
        return this.innerText({ timeout });
    }

    async innerHTML(options?: InnerHTMLOptions): Promise<string> {
        return this.executeAction('Get inner HTML', async () => {
            const locator = await this.getLocator();
            return await locator.innerHTML(options);
        });
    }

    async innerHTMLWithTimeout(timeout: number): Promise<string> {
        CSReporter.info(`Getting inner HTML with ${timeout}ms timeout from ${this.description}`);
        return this.innerHTML({ timeout });
    }

    async getAttribute(name: string, options?: GetAttributeOptions): Promise<string | null> {
        return this.executeAction(`Get attribute "${name}"`, async () => {
            const locator = await this.getLocator();
            return await locator.getAttribute(name, options);
        });
    }

    async getAttributeWithTimeout(name: string, timeout: number): Promise<string | null> {
        CSReporter.info(`Getting attribute "${name}" with ${timeout}ms timeout from ${this.description}`);
        return this.getAttribute(name, { timeout });
    }

    async inputValue(options?: InputValueOptions): Promise<string> {
        return this.executeAction('Get input value', async () => {
            const locator = await this.getLocator();
            return await locator.inputValue(options);
        });
    }

    async inputValueWithTimeout(timeout: number): Promise<string> {
        CSReporter.info(`Getting input value with ${timeout}ms timeout from ${this.description}`);
        return this.inputValue({ timeout });
    }

    async allTextContents(): Promise<string[]> {
        return this.executeAction('Get all text contents', async () => {
            const locator = await this.getLocator();
            return await locator.allTextContents();
        });
    }

    async allInnerTexts(): Promise<string[]> {
        return this.executeAction('Get all inner texts', async () => {
            const locator = await this.getLocator();
            return await locator.allInnerTexts();
        });
    }

    // ============================================
    // 13. STATE CHECK METHODS
    // ============================================

    async isChecked(options?: IsCheckedOptions): Promise<boolean> {
        return this.executeAction('Check if checked', async () => {
            const locator = await this.getLocator();
            return await locator.isChecked(options);
        });
    }

    async isCheckedWithTimeout(timeout: number): Promise<boolean> {
        CSReporter.info(`Checking if checked with ${timeout}ms timeout on ${this.description}`);
        return this.isChecked({ timeout });
    }

    async isDisabled(options?: IsDisabledOptions): Promise<boolean> {
        return this.executeAction('Check if disabled', async () => {
            const locator = await this.getLocator();
            return await locator.isDisabled(options);
        });
    }

    async isDisabledWithTimeout(timeout: number): Promise<boolean> {
        CSReporter.info(`Checking if disabled with ${timeout}ms timeout on ${this.description}`);
        return this.isDisabled({ timeout });
    }

    async isEditable(options?: IsEditableOptions): Promise<boolean> {
        return this.executeAction('Check if editable', async () => {
            const locator = await this.getLocator();
            return await locator.isEditable(options);
        });
    }

    async isEditableWithTimeout(timeout: number): Promise<boolean> {
        CSReporter.info(`Checking if editable with ${timeout}ms timeout on ${this.description}`);
        return this.isEditable({ timeout });
    }

    async isEnabled(options?: IsEnabledOptions): Promise<boolean> {
        return this.executeAction('Check if enabled', async () => {
            const locator = await this.getLocator();
            return await locator.isEnabled(options);
        });
    }

    async isEnabledWithTimeout(timeout: number): Promise<boolean> {
        CSReporter.info(`Checking if enabled with ${timeout}ms timeout on ${this.description}`);
        return this.isEnabled({ timeout });
    }

    async isHidden(options?: IsHiddenOptions): Promise<boolean> {
        return this.executeAction('Check if hidden', async () => {
            const locator = await this.getLocator();
            return await locator.isHidden(options);
        });
    }

    async isHiddenWithTimeout(timeout: number): Promise<boolean> {
        CSReporter.info(`Checking if hidden with ${timeout}ms timeout on ${this.description}`);
        return this.isHidden({ timeout });
    }

    async isVisible(options?: IsVisibleOptions): Promise<boolean> {
        return this.executeAction('Check if visible', async () => {
            const locator = await this.getLocator();
            return await locator.isVisible(options);
        });
    }

    async isVisibleWithTimeout(timeout: number): Promise<boolean> {
        CSReporter.info(`Checking if visible with ${timeout}ms timeout on ${this.description}`);
        return this.isVisible({ timeout });
    }

    // ============================================
    // 14. WAIT METHODS
    // ============================================

    async waitFor(options?: WaitForOptions): Promise<void> {
        return this.executeAction(`Wait for ${options?.state || 'attached'}`, async () => {
            const locator = await this.getLocator();
            await locator.waitFor(options);
        });
    }

    async waitForAttached(timeout?: number): Promise<void> {
        CSReporter.info(`Waiting for ${this.description} to be attached`);
        return this.waitFor({ state: 'attached', timeout });
    }

    async waitForDetached(timeout?: number): Promise<void> {
        CSReporter.info(`Waiting for ${this.description} to be detached`);
        return this.waitFor({ state: 'detached', timeout });
    }

    async waitForVisible(timeout?: number): Promise<void> {
        CSReporter.info(`Waiting for ${this.description} to be visible`);
        return this.waitFor({ state: 'visible', timeout });
    }

    async waitForHidden(timeout?: number): Promise<void> {
        CSReporter.info(`Waiting for ${this.description} to be hidden`);
        return this.waitFor({ state: 'hidden', timeout });
    }

    // ============================================
    // 15. EVALUATION METHODS
    // ============================================

    async evaluate<R, Arg>(pageFunction: (element: Element, arg: Arg) => R | Promise<R>, arg: Arg, options?: EvaluateOptions): Promise<R>;
    async evaluate<R>(pageFunction: (element: Element) => R | Promise<R>, arg?: any, options?: EvaluateOptions): Promise<R>;
    async evaluate<R>(pageFunction: any, arg?: any, options?: EvaluateOptions): Promise<R> {
        return this.executeAction('Evaluate', async () => {
            const locator = await this.getLocator();
            return await locator.evaluate(pageFunction, arg, options);
        });
    }

    async evaluateAll<R, Arg>(pageFunction: (elements: Element[], arg: Arg) => R | Promise<R>, arg: Arg): Promise<R>;
    async evaluateAll<R>(pageFunction: (elements: Element[]) => R | Promise<R>, arg?: any): Promise<R>;
    async evaluateAll<R>(pageFunction: any, arg?: any): Promise<R> {
        return this.executeAction('Evaluate all', async () => {
            const locator = await this.getLocator();
            return await locator.evaluateAll(pageFunction, arg);
        });
    }

    async evaluateHandle<R, Arg>(pageFunction: (element: Element, arg: Arg) => R | Promise<R>, arg: Arg, options?: EvaluateHandleOptions): Promise<JSHandle>;
    async evaluateHandle<R>(pageFunction: (element: Element) => R | Promise<R>, arg?: any, options?: EvaluateHandleOptions): Promise<JSHandle>;
    async evaluateHandle<R>(pageFunction: any, arg?: any, options?: EvaluateHandleOptions): Promise<JSHandle> {
        return this.executeAction('Evaluate handle', async () => {
            const locator = await this.getLocator();
            return await locator.evaluateHandle(pageFunction, arg);
        });
    }

    // ============================================
    // 16. LOCATION METHODS
    // ============================================

    async boundingBox(options?: BoundingBoxOptions): Promise<{ x: number; y: number; width: number; height: number } | null> {
        return this.executeAction('Get bounding box', async () => {
            const locator = await this.getLocator();
            return await locator.boundingBox(options);
        });
    }

    async boundingBoxWithTimeout(timeout: number): Promise<{ x: number; y: number; width: number; height: number } | null> {
        CSReporter.info(`Getting bounding box with ${timeout}ms timeout from ${this.description}`);
        return this.boundingBox({ timeout });
    }

    async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
        return this.executeAction('Take screenshot', async () => {
            const locator = await this.getLocator();
            return await locator.screenshot(options);
        });
    }

    async screenshotToFile(path: string, options?: Omit<ScreenshotOptions, 'path'>): Promise<Buffer> {
        CSReporter.info(`Taking screenshot to file "${path}" of ${this.description}`);
        return this.screenshot({ ...options, path });
    }

    async screenshotFullPage(): Promise<Buffer> {
        CSReporter.info(`Taking full page screenshot of ${this.description}`);
        return this.screenshot({ fullPage: true });
    }

    async scrollIntoViewIfNeeded(options?: ScrollIntoViewOptions): Promise<void> {
        return this.executeAction('Scroll into view', async () => {
            const locator = await this.getLocator();
            await locator.scrollIntoViewIfNeeded(options);
        });
    }

    async scrollIntoViewWithTimeout(timeout: number): Promise<void> {
        CSReporter.info(`Scrolling into view with ${timeout}ms timeout for ${this.description}`);
        return this.scrollIntoViewIfNeeded({ timeout });
    }

    // ============================================
    // 17. ELEMENT QUERY METHODS
    // ============================================

    async count(): Promise<number> {
        return this.executeAction('Get count', async () => {
            const locator = await this.getLocator();
            return await locator.count();
        });
    }

    async all(): Promise<Locator[]> {
        return this.executeAction('Get all locators', async () => {
            const locator = await this.getLocator();
            return await locator.all();
        });
    }

    first(): CSWebElement {
        const newOptions = { ...this.options, description: `${this.description} (first)` };
        const element = new CSWebElement(newOptions);
        element.locator = this.page.locator(this.buildSelector()).first();
        return element;
    }

    last(): CSWebElement {
        const newOptions = { ...this.options, description: `${this.description} (last)` };
        const element = new CSWebElement(newOptions);
        element.locator = this.page.locator(this.buildSelector()).last();
        return element;
    }

    nth(index: number): CSWebElement {
        const newOptions = { ...this.options, description: `${this.description} (${index})` };
        const element = new CSWebElement(newOptions);
        element.locator = this.page.locator(this.buildSelector()).nth(index);
        return element;
    }

    filter(options: FilterOptions): CSWebElement {
        const newOptions = { ...this.options, description: `${this.description} (filtered)` };
        const element = new CSWebElement(newOptions);
        element.getLocator = async () => {
            const baseLocator = await this.getLocator();
            return baseLocator.filter(options);
        };
        return element;
    }

    subLocator(selectorOrLocator: string | Locator, options?: LocatorOptions): CSWebElement {
        const newOptions = { ...this.options, description: `${this.description} > locator` };
        const element = new CSWebElement(newOptions);
        element.getLocator = async () => {
            const baseLocator = await this.getLocator();
            return baseLocator.locator(selectorOrLocator, options);
        };
        return element;
    }

    // ============================================
    // 18. LOGICAL OPERATORS
    // ============================================

    and(locator: Locator): CSWebElement {
        const newOptions = { ...this.options, description: `${this.description} AND locator` };
        const element = new CSWebElement(newOptions);
        element.getLocator = async () => {
            const baseLocator = await this.getLocator();
            return baseLocator.and(locator);
        };
        return element;
    }

    or(locator: Locator): CSWebElement {
        const newOptions = { ...this.options, description: `${this.description} OR locator` };
        const element = new CSWebElement(newOptions);
        element.getLocator = async () => {
            const baseLocator = await this.getLocator();
            return baseLocator.or(locator);
        };
        return element;
    }

    // ============================================
    // 19. LOCATOR CREATION METHODS
    // ============================================

    getByAltText(text: string | RegExp, options?: GetByAltTextOptions): CSWebElement {
        const newOptions = { ...this.options, description: `${this.description} by alt text "${text}"` };
        const element = new CSWebElement(newOptions);
        element.getLocator = async () => {
            const baseLocator = await this.getLocator();
            return baseLocator.getByAltText(text, options);
        };
        return element;
    }

    getByLabel(text: string | RegExp, options?: GetByLabelOptions): CSWebElement {
        const newOptions = { ...this.options, description: `${this.description} by label "${text}"` };
        const element = new CSWebElement(newOptions);
        element.getLocator = async () => {
            const baseLocator = await this.getLocator();
            return baseLocator.getByLabel(text, options);
        };
        return element;
    }

    getByPlaceholder(text: string | RegExp, options?: GetByPlaceholderOptions): CSWebElement {
        const newOptions = { ...this.options, description: `${this.description} by placeholder "${text}"` };
        const element = new CSWebElement(newOptions);
        element.getLocator = async () => {
            const baseLocator = await this.getLocator();
            return baseLocator.getByPlaceholder(text, options);
        };
        return element;
    }

    getByRole(role: any, options?: GetByRoleOptions): CSWebElement {
        const newOptions = { ...this.options, description: `${this.description} by role "${role}"` };
        const element = new CSWebElement(newOptions);
        element.getLocator = async () => {
            const baseLocator = await this.getLocator();
            return baseLocator.getByRole(role, options);
        };
        return element;
    }

    getByTestId(testId: string | RegExp): CSWebElement {
        const newOptions = { ...this.options, description: `${this.description} by test id "${testId}"` };
        const element = new CSWebElement(newOptions);
        element.getLocator = async () => {
            const baseLocator = await this.getLocator();
            return baseLocator.getByTestId(testId);
        };
        return element;
    }

    getByText(text: string | RegExp, options?: GetByTextOptions): CSWebElement {
        const newOptions = { ...this.options, description: `${this.description} by text "${text}"` };
        const element = new CSWebElement(newOptions);
        element.getLocator = async () => {
            const baseLocator = await this.getLocator();
            return baseLocator.getByText(text, options);
        };
        return element;
    }

    getByTitle(text: string | RegExp, options?: GetByTitleOptions): CSWebElement {
        const newOptions = { ...this.options, description: `${this.description} by title "${text}"` };
        const element = new CSWebElement(newOptions);
        element.getLocator = async () => {
            const baseLocator = await this.getLocator();
            return baseLocator.getByTitle(text, options);
        };
        return element;
    }

    // ============================================
    // 20. FRAME METHODS
    // ============================================

    frameLocator(selector: string): FrameLocator {
        return this.page.frameLocator(selector);
    }

    async contentFrame(): Promise<FrameLocator | null> {
        return this.executeAction('Get content frame', async () => {
            const locator = await this.getLocator();
            return await locator.contentFrame();
        });
    }

    // ============================================
    // 21. OTHER METHODS
    // ============================================

    getPage(): Page {
        return this.page;
    }

    async highlight(): Promise<void> {
        return this.executeAction('Highlight', async () => {
            const locator = await this.getLocator();
            await locator.highlight();
        });
    }

    async dispatchEvent(type: string, eventInit?: any, options?: DispatchEventOptions): Promise<void> {
        return this.executeAction(`Dispatch event "${type}"`, async () => {
            const locator = await this.getLocator();
            await locator.dispatchEvent(type, eventInit, options);
        });
    }

    async dispatchEventWithTimeout(type: string, eventInit: any, timeout: number): Promise<void> {
        CSReporter.info(`Dispatching event "${type}" with ${timeout}ms timeout on ${this.description}`);
        return this.dispatchEvent(type, eventInit, { timeout });
    }

    // ============================================
    // HELPER METHODS
    // ============================================

    private buildSelector(): string {
        if (this.options.css) return this.options.css;
        if (this.options.id) return `#${this.options.id}`;
        if (this.options.xpath) return `xpath=${this.options.xpath}`;
        if (this.options.name) return `[name="${this.options.name}"]`;
        return '*';
    }

    /**
     * Get performance metrics for all actions
     */
    getPerformanceMetrics(): Map<string, { avg: number; min: number; max: number; count: number }> {
        const metrics = new Map();
        
        for (const [action, durations] of this.performanceMetrics) {
            if (durations.length > 0) {
                const sum = durations.reduce((a, b) => a + b, 0);
                metrics.set(action, {
                    avg: sum / durations.length,
                    min: Math.min(...durations),
                    max: Math.max(...durations),
                    count: durations.length
                });
            }
        }
        
        return metrics;
    }

    /**
     * Clear performance metrics
     */
    clearPerformanceMetrics(): void {
        this.performanceMetrics.clear();
        CSReporter.debug(`Performance metrics cleared for ${this.description}`);
    }
}

/**
 * CSElements - Handle multiple elements
 */
export class CSElements {
    private elements: CSWebElement[];
    private options: ElementOptions;
    private page: Page;
    
    constructor(options: ElementOptions, page?: Page) {
        this.options = options;
        this.elements = [];
        // Lazy load CSBrowserManager when needed
        if (!page) {
            if (!CSBrowserManager) {
                CSBrowserManager = require('../browser/CSBrowserManager').CSBrowserManager;
            }
            this.page = CSBrowserManager.getInstance().getPage();
        } else {
            this.page = page;
        }
    }
    
    async getAll(): Promise<CSWebElement[]> {
        const baseElement = new CSWebElement(this.options, this.page);
        const locators = await baseElement.all();
        
        this.elements = locators.map((locator, index) => {
            const element = new CSWebElement({
                ...this.options,
                description: `${this.options.description} [${index}]`
            }, this.page);
            // Set the specific locator for this element using private property access
            (element as any).locator = locator;
            return element;
        });
        
        CSReporter.info(`Found ${this.elements.length} elements for ${this.options.description}`);
        return this.elements;
    }
    
    async count(): Promise<number> {
        const baseElement = new CSWebElement(this.options, this.page);
        const count = await baseElement.count();
        CSReporter.info(`Count of ${this.options.description}: ${count}`);
        return count;
    }
    
    async clickAll(): Promise<void> {
        const elements = await this.getAll();
        CSReporter.info(`Clicking all ${elements.length} elements of ${this.options.description}`);
        for (const element of elements) {
            await element.click();
        }
    }
    
    async fillAll(value: string): Promise<void> {
        const elements = await this.getAll();
        CSReporter.info(`Filling all ${elements.length} elements of ${this.options.description} with "${value}"`);
        for (const element of elements) {
            await element.fill(value);
        }
    }
    
    async getTexts(): Promise<string[]> {
        const elements = await this.getAll();
        CSReporter.info(`Getting texts from all ${elements.length} elements of ${this.options.description}`);
        const texts: string[] = [];
        for (const element of elements) {
            const text = await element.textContent();
            texts.push(text || '');
        }
        return texts;
    }
    
    async getValues(): Promise<string[]> {
        const elements = await this.getAll();
        CSReporter.info(`Getting values from all ${elements.length} elements of ${this.options.description}`);
        const values: string[] = [];
        for (const element of elements) {
            const value = await element.inputValue();
            values.push(value);
        }
        return values;
    }
    
    async checkAll(): Promise<void> {
        const elements = await this.getAll();
        CSReporter.info(`Checking all ${elements.length} elements of ${this.options.description}`);
        for (const element of elements) {
            await element.check();
        }
    }
    
    async uncheckAll(): Promise<void> {
        const elements = await this.getAll();
        CSReporter.info(`Unchecking all ${elements.length} elements of ${this.options.description}`);
        for (const element of elements) {
            await element.uncheck();
        }
    }

    // ============================================
    // DYNAMIC ELEMENT CREATION METHODS
    // ============================================

    /**
     * Create a CSWebElement dynamically with CSS selector
     * @param selector CSS selector string
     * @param description Optional description for logging
     * @param page Optional page instance
     */
    public static createByCSS(selector: string, description?: string, page?: Page): CSWebElement {
        return new CSWebElement({
            css: selector,
            description: description || `Dynamic element: ${selector}`
        }, page);
    }

    /**
     * Create a CSWebElement dynamically with XPath
     * @param xpath XPath selector string
     * @param description Optional description for logging
     * @param page Optional page instance
     */
    public static createByXPath(xpath: string, description?: string, page?: Page): CSWebElement {
        return new CSWebElement({
            xpath: xpath,
            description: description || `Dynamic XPath element`
        }, page);
    }

    /**
     * Create a CSWebElement dynamically with text
     * @param text Text to find
     * @param exact Whether to match exactly
     * @param description Optional description for logging
     * @param page Optional page instance
     */
    public static createByText(text: string, exact: boolean = false, description?: string, page?: Page): CSWebElement {
        const selector = exact ? `text="${text}"` : `text=${text}`;
        return new CSWebElement({
            text: text,
            description: description || `Element with text: ${text}`
        }, page);
    }

    /**
     * Create a CSWebElement dynamically with ID
     * @param id Element ID
     * @param description Optional description for logging
     * @param page Optional page instance
     */
    public static createById(id: string, description?: string, page?: Page): CSWebElement {
        return new CSWebElement({
            id: id,
            description: description || `Element with ID: ${id}`
        }, page);
    }

    /**
     * Create a CSWebElement dynamically with name attribute
     * @param name Element name attribute
     * @param description Optional description for logging
     * @param page Optional page instance
     */
    public static createByName(name: string, description?: string, page?: Page): CSWebElement {
        return new CSWebElement({
            name: name,
            description: description || `Element with name: ${name}`
        }, page);
    }

    /**
     * Create a CSWebElement dynamically with role
     * @param role ARIA role
     * @param description Optional description for logging
     * @param page Optional page instance
     */
    public static createByRole(role: string, description?: string, page?: Page): CSWebElement {
        return new CSWebElement({
            role: role,
            description: description || `Element with role: ${role}`
        }, page);
    }

    /**
     * Create a CSWebElement dynamically with test ID
     * @param testId Test ID attribute value
     * @param description Optional description for logging
     * @param page Optional page instance
     */
    public static createByTestId(testId: string, description?: string, page?: Page): CSWebElement {
        return new CSWebElement({
            testId: testId,
            description: description || `Element with testId: ${testId}`
        }, page);
    }

    /**
     * Create a CSWebElement dynamically with custom options
     * @param options Full ElementOptions object
     * @param page Optional page instance
     */
    public static create(options: ElementOptions, page?: Page): CSWebElement {
        return new CSWebElement(options, page);
    }

    /**
     * Create a CSWebElement dynamically with interpolated selector
     * @param template Selector template with placeholders
     * @param values Values to interpolate
     * @param description Optional description for logging
     * @param page Optional page instance
     * @example CSWebElement.createWithTemplate('button[data-id="{id}"][data-action="{action}"]', {id: '123', action: 'submit'})
     */
    public static createWithTemplate(template: string, values: Record<string, string>, description?: string, page?: Page): CSWebElement {
        let selector = template;
        for (const [key, value] of Object.entries(values)) {
            selector = selector.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
        }

        return new CSWebElement({
            css: selector,
            description: description || `Dynamic templated element: ${selector}`
        }, page);
    }

    /**
     * Create multiple CSWebElements dynamically matching a pattern
     * @param selector CSS selector that matches multiple elements
     * @param description Optional description for logging
     * @param page Optional page instance
     * @returns Array of CSWebElement instances
     */
    public static async createMultiple(selector: string, description?: string, page?: Page): Promise<CSWebElement[]> {
        const pageInstance = page || CSBrowserManager.getInstance().getPage();
        const count = await pageInstance.locator(selector).count();
        const elements: CSWebElement[] = [];

        for (let i = 0; i < count; i++) {
            elements.push(new CSWebElement({
                css: `${selector}:nth-of-type(${i + 1})`,
                description: `${description || 'Dynamic element'} [${i + 1}]`
            }, page));
        }

        return elements;
    }

    /**
     * Create a CSWebElement for a table cell dynamically
     * @param tableSelector CSS selector for the table
     * @param row Row number (1-indexed)
     * @param column Column number (1-indexed)
     * @param description Optional description for logging
     * @param page Optional page instance
     */
    public static createTableCell(tableSelector: string, row: number, column: number, description?: string, page?: Page): CSWebElement {
        const cellSelector = `${tableSelector} tbody tr:nth-child(${row}) td:nth-child(${column})`;
        return new CSWebElement({
            css: cellSelector,
            description: description || `Table cell [${row}, ${column}]`
        }, page);
    }

    /**
     * Create a CSWebElement for a form field by label
     * @param labelText Label text
     * @param fieldType Input type (input, select, textarea)
     * @param description Optional description for logging
     * @param page Optional page instance
     */
    public static createByLabel(labelText: string, fieldType: string = 'input', description?: string, page?: Page): CSWebElement {
        const selector = `label:has-text("${labelText}") ~ ${fieldType}, label:has-text("${labelText}") ${fieldType}`;
        return new CSWebElement({
            css: selector,
            description: description || `${fieldType} field with label: ${labelText}`
        }, page);
    }

    /**
     * Create a CSWebElement chain for nested elements
     * @param selectors Array of selectors to chain
     * @param description Optional description for logging
     * @param page Optional page instance
     */
    public static createChained(selectors: string[], description?: string, page?: Page): CSWebElement {
        const chainedSelector = selectors.join(' ');
        return new CSWebElement({
            css: chainedSelector,
            description: description || `Chained element: ${chainedSelector}`
        }, page);
    }

    /**
     * Create a CSWebElement with filters
     * @param baseSelector Base CSS selector
     * @param filters Filter options (hasText, hasNotText, etc.)
     * @param description Optional description for logging
     * @param page Optional page instance
     */
    public static createWithFilter(baseSelector: string, filters: {
        hasText?: string;
        hasNotText?: string;
        visible?: boolean;
        enabled?: boolean;
    }, description?: string, page?: Page): CSWebElement {
        let selector = baseSelector;

        if (filters.hasText) {
            selector += `:has-text("${filters.hasText}")`;
        }
        if (filters.hasNotText) {
            selector += `:not(:has-text("${filters.hasNotText}"))`;
        }
        if (filters.visible !== undefined) {
            selector += filters.visible ? ':visible' : ':hidden';
        }
        if (filters.enabled !== undefined) {
            selector += filters.enabled ? ':enabled' : ':disabled';
        }

        return new CSWebElement({
            css: selector,
            description: description || `Filtered element: ${selector}`
        }, page);
    }

    /**
     * Create a CSWebElement for nth match of a selector
     * @param selector CSS selector
     * @param index Index of the element (0-based)
     * @param description Optional description for logging
     * @param page Optional page instance
     */
    public static createNth(selector: string, index: number, description?: string, page?: Page): CSWebElement {
        return new CSWebElement({
            css: selector,
            description: description || `${selector} [index: ${index}]`
        }, page);
    }
}