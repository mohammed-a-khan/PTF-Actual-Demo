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
    /** @since Playwright 1.57 - Number of intermediate mousemove events during click */
    steps?: number;
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
    delay?: number;
    noWaitAfter?: boolean;
}

export interface TapOptions {
    force?: boolean;
    modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
    noWaitAfter?: boolean;
    position?: { x: number; y: number };
    timeout?: number;
    trial?: boolean;
    delay?: number;
    clickCount?: number;
}

export interface DragToOptions {
    force?: boolean;
    noWaitAfter?: boolean;
    sourcePosition?: { x: number; y: number };
    targetPosition?: { x: number; y: number };
    timeout?: number;
    trial?: boolean;
    /** @since Playwright 1.57 - Number of intermediate mousemove events during drag */
    steps?: number;
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
        const startTime = Date.now();
        const primaryStrategy = strategies[0];
        let strategyIndex = 0;

        for (const strategy of strategies) {
            try {
                const loc = this.createLocatorFromStrategy(strategy);
                if (await loc.count() > 0) {
                    this.locator = loc;

                    // Check if this is self-healing (alternative locator used instead of primary)
                    if (strategyIndex > 0 && this.options.selfHeal && this.options.alternativeLocators &&
                        this.options.alternativeLocators.length > 0) {
                        // This is self-healing via alternative locator
                        const healingDuration = Date.now() - startTime;
                        CSReporter.pass(`🔧 Self-healed element "${this.description}" using ${strategy.type}: ${strategy.value}`);

                        // Record AI healing data for HTML report
                        CSReporter.recordAIHealing({
                            attempted: true,
                            success: true,
                            strategy: 'alternative',
                            confidence: 1.0, // 0.0-1.0 scale (1.0 = 100%)
                            duration: healingDuration,
                            originalLocator: primaryStrategy.value,
                            healedLocator: `${strategy.type}:${strategy.value}`,
                            attempts: strategyIndex + 1
                        });
                    } else {
                        CSReporter.debug(`Found element with ${strategy.type}: ${strategy.value}`);
                    }

                    return loc;
                }
            } catch (error) {
                CSReporter.debug(`Failed with ${strategy.type}: ${error}`);
            }
            strategyIndex++;
        }

        // Try self-healing if enabled
        if (this.options.selfHeal) {
            CSReporter.info(`Attempting self-healing for ${this.description}`);
            const healingResult = await this.selfHealingEngine.heal(
                this.page,
                primaryStrategy.value,
                this.options.alternativeLocators
            );

            if (healingResult.success && healingResult.healedLocator) {
                this.locator = this.page.locator(healingResult.healedLocator);
                const healingDuration = Date.now() - startTime;

                CSReporter.pass(`🤖 AI-healed element "${this.description}" using ${healingResult.strategy} strategy: ${healingResult.healedLocator}`);

                // Record AI healing data for HTML report
                CSReporter.recordAIHealing({
                    attempted: true,
                    success: true,
                    strategy: healingResult.strategy || 'unknown',
                    confidence: (healingResult.confidence || 70) / 100, // Convert 0-100 to 0.0-1.0
                    duration: healingDuration,
                    originalLocator: primaryStrategy.value,
                    healedLocator: healingResult.healedLocator,
                    attempts: strategies.length + 1
                });

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

    // Convenience methods for click - Individual button methods
    async clickWithLeftButton(): Promise<void> {
        CSReporter.info(`Clicking with left button on ${this.description}`);
        return this.click({ button: 'left' });
    }

    async clickWithRightButton(): Promise<void> {
        CSReporter.info(`Clicking with right button on ${this.description}`);
        return this.click({ button: 'right' });
    }

    async clickWithMiddleButton(): Promise<void> {
        CSReporter.info(`Clicking with middle button on ${this.description}`);
        return this.click({ button: 'middle' });
    }

    async clickWithPosition(x: number, y: number): Promise<void> {
        CSReporter.info(`Clicking at position (${x}, ${y}) on ${this.description}`);
        return this.click({ position: { x, y } });
    }

    // Individual modifier methods for click
    async clickWithAltKey(): Promise<void> {
        CSReporter.info(`Clicking with Alt key on ${this.description}`);
        return this.click({ modifiers: ['Alt'] });
    }

    async clickWithControlKey(): Promise<void> {
        CSReporter.info(`Clicking with Control key on ${this.description}`);
        return this.click({ modifiers: ['Control'] });
    }

    async clickWithMetaKey(): Promise<void> {
        CSReporter.info(`Clicking with Meta key on ${this.description}`);
        return this.click({ modifiers: ['Meta'] });
    }

    async clickWithShiftKey(): Promise<void> {
        CSReporter.info(`Clicking with Shift key on ${this.description}`);
        return this.click({ modifiers: ['Shift'] });
    }

    async clickWithModifiers(modifiers: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>): Promise<void> {
        CSReporter.info(`Clicking with modifiers [${modifiers.join(', ')}] on ${this.description}`);
        return this.click({ modifiers });
    }

    async clickMultipleTimes(count: number): Promise<void> {
        CSReporter.info(`Clicking ${count} times on ${this.description}`);
        return this.click({ clickCount: count });
    }

    async clickTwice(): Promise<void> {
        CSReporter.info(`Double clicking (2 times) on ${this.description}`);
        return this.click({ clickCount: 2 });
    }

    async clickThreeTimes(): Promise<void> {
        CSReporter.info(`Triple clicking (3 times) on ${this.description}`);
        return this.click({ clickCount: 3 });
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

    // Individual button methods for dblclick
    async dblclickWithLeftButton(): Promise<void> {
        CSReporter.info(`Double clicking with left button on ${this.description}`);
        return this.dblclick({ button: 'left' });
    }

    async dblclickWithRightButton(): Promise<void> {
        CSReporter.info(`Double clicking with right button on ${this.description}`);
        return this.dblclick({ button: 'right' });
    }

    async dblclickWithMiddleButton(): Promise<void> {
        CSReporter.info(`Double clicking with middle button on ${this.description}`);
        return this.dblclick({ button: 'middle' });
    }

    // Individual modifier methods for dblclick
    async dblclickWithAltKey(): Promise<void> {
        CSReporter.info(`Double clicking with Alt key on ${this.description}`);
        return this.dblclick({ modifiers: ['Alt'] });
    }

    async dblclickWithControlKey(): Promise<void> {
        CSReporter.info(`Double clicking with Control key on ${this.description}`);
        return this.dblclick({ modifiers: ['Control'] });
    }

    async dblclickWithMetaKey(): Promise<void> {
        CSReporter.info(`Double clicking with Meta key on ${this.description}`);
        return this.dblclick({ modifiers: ['Meta'] });
    }

    async dblclickWithShiftKey(): Promise<void> {
        CSReporter.info(`Double clicking with Shift key on ${this.description}`);
        return this.dblclick({ modifiers: ['Shift'] });
    }

    async dblclickMultipleTimes(count: number): Promise<void> {
        CSReporter.info(`Double clicking ${count} times on ${this.description}`);
        return this.dblclick({ clickCount: count });
    }

    async dblclickWithTrial(): Promise<void> {
        CSReporter.info(`Trial double clicking on ${this.description}`);
        return this.dblclick({ trial: true });
    }

    async dblclickWithoutWaiting(): Promise<void> {
        CSReporter.info(`Double clicking without waiting on ${this.description}`);
        return this.dblclick({ noWaitAfter: true });
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

    async tapWithDelay(delay: number): Promise<void> {
        CSReporter.info(`Tapping with ${delay}ms delay on ${this.description}`);
        return this.tap({ delay });
    }

    async tapWithTrial(): Promise<void> {
        CSReporter.info(`Trial tapping on ${this.description}`);
        return this.tap({ trial: true });
    }

    async tapWithoutWaiting(): Promise<void> {
        CSReporter.info(`Tapping without waiting on ${this.description}`);
        return this.tap({ noWaitAfter: true });
    }

    async tapMultipleTimes(count: number): Promise<void> {
        CSReporter.info(`Tapping ${count} times on ${this.description}`);
        return this.tap({ clickCount: count });
    }

    // Individual modifier methods for tap
    async tapWithAltKey(): Promise<void> {
        CSReporter.info(`Tapping with Alt key on ${this.description}`);
        return this.tap({ modifiers: ['Alt'] });
    }

    async tapWithControlKey(): Promise<void> {
        CSReporter.info(`Tapping with Control key on ${this.description}`);
        return this.tap({ modifiers: ['Control'] });
    }

    async tapWithMetaKey(): Promise<void> {
        CSReporter.info(`Tapping with Meta key on ${this.description}`);
        return this.tap({ modifiers: ['Meta'] });
    }

    async tapWithShiftKey(): Promise<void> {
        CSReporter.info(`Tapping with Shift key on ${this.description}`);
        return this.tap({ modifiers: ['Shift'] });
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

    async hoverWithDelay(delay: number): Promise<void> {
        CSReporter.info(`Hovering with ${delay}ms delay on ${this.description}`);
        return this.hover({ delay });
    }

    async hoverWithTrial(): Promise<void> {
        CSReporter.info(`Trial hovering on ${this.description}`);
        return this.hover({ trial: true });
    }

    async hoverWithoutWaiting(): Promise<void> {
        CSReporter.info(`Hovering without waiting on ${this.description}`);
        return this.hover({ noWaitAfter: true });
    }

    // Individual modifier methods for hover
    async hoverWithAltKey(): Promise<void> {
        CSReporter.info(`Hovering with Alt key on ${this.description}`);
        return this.hover({ modifiers: ['Alt'] });
    }

    async hoverWithControlKey(): Promise<void> {
        CSReporter.info(`Hovering with Control key on ${this.description}`);
        return this.hover({ modifiers: ['Control'] });
    }

    async hoverWithMetaKey(): Promise<void> {
        CSReporter.info(`Hovering with Meta key on ${this.description}`);
        return this.hover({ modifiers: ['Meta'] });
    }

    async hoverWithShiftKey(): Promise<void> {
        CSReporter.info(`Hovering with Shift key on ${this.description}`);
        return this.hover({ modifiers: ['Shift'] });
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

    async dragToWithTimeout(target: Locator | CSWebElement, timeout: number): Promise<void> {
        CSReporter.info(`Dragging with ${timeout}ms timeout to target`);
        return this.dragTo(target, { timeout });
    }

    async dragToWithTrial(target: Locator | CSWebElement): Promise<void> {
        CSReporter.info(`Trial dragging to target`);
        return this.dragTo(target, { trial: true });
    }

    async dragToWithoutWaiting(target: Locator | CSWebElement): Promise<void> {
        CSReporter.info(`Dragging without waiting to target`);
        return this.dragTo(target, { noWaitAfter: true });
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

    async pressSequentiallyWithTimeout(text: string, timeout: number): Promise<void> {
        CSReporter.info(`Typing "${text}" sequentially with ${timeout}ms timeout on ${this.description}`);
        return this.pressSequentially(text, { timeout });
    }

    async pressSequentiallyWithoutWaiting(text: string): Promise<void> {
        CSReporter.info(`Typing "${text}" sequentially without waiting on ${this.description}`);
        return this.pressSequentially(text, { noWaitAfter: true });
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

    async typeWithTimeout(text: string, timeout: number): Promise<void> {
        CSReporter.info(`Typing "${text}" with ${timeout}ms timeout on ${this.description}`);
        return this.type(text, { timeout });
    }

    async typeWithoutWaiting(text: string): Promise<void> {
        CSReporter.info(`Typing "${text}" without waiting on ${this.description}`);
        return this.type(text, { noWaitAfter: true });
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

    async clearWithoutWaiting(): Promise<void> {
        CSReporter.info(`Clearing without waiting on ${this.description}`);
        return this.clear({ noWaitAfter: true });
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

    async selectOptionWithTimeout(values: string | string[], timeout: number): Promise<string[]> {
        CSReporter.info(`Selecting option(s) with ${timeout}ms timeout in ${this.description}`);
        return this.selectOption(values, { timeout });
    }

    async selectOptionWithoutWaiting(values: string | string[]): Promise<string[]> {
        CSReporter.info(`Selecting option(s) without waiting in ${this.description}`);
        return this.selectOption(values, { noWaitAfter: true });
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

    async selectTextWithTimeout(timeout: number): Promise<void> {
        CSReporter.info(`Selecting text with ${timeout}ms timeout in ${this.description}`);
        return this.selectText({ timeout });
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

    async uploadFileWithTimeout(filePath: string, timeout: number): Promise<void> {
        CSReporter.info(`Uploading file "${filePath}" with ${timeout}ms timeout to ${this.description}`);
        return this.setInputFiles(filePath, { timeout });
    }

    async uploadFileWithoutWaiting(filePath: string): Promise<void> {
        CSReporter.info(`Uploading file "${filePath}" without waiting to ${this.description}`);
        return this.setInputFiles(filePath, { noWaitAfter: true });
    }

    async uploadFilesWithTimeout(filePaths: string[], timeout: number): Promise<void> {
        CSReporter.info(`Uploading ${filePaths.length} files with ${timeout}ms timeout to ${this.description}`);
        return this.setInputFiles(filePaths, { timeout });
    }

    async uploadFilesWithoutWaiting(filePaths: string[]): Promise<void> {
        CSReporter.info(`Uploading ${filePaths.length} files without waiting to ${this.description}`);
        return this.setInputFiles(filePaths, { noWaitAfter: true });
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

    async checkWithTimeout(timeout: number): Promise<void> {
        CSReporter.info(`Checking with ${timeout}ms timeout on ${this.description}`);
        return this.check({ timeout });
    }

    async checkWithTrial(): Promise<void> {
        CSReporter.info(`Trial checking on ${this.description}`);
        return this.check({ trial: true });
    }

    async checkWithoutWaiting(): Promise<void> {
        CSReporter.info(`Checking without waiting on ${this.description}`);
        return this.check({ noWaitAfter: true });
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

    async uncheckWithPosition(x: number, y: number): Promise<void> {
        CSReporter.info(`Unchecking at position (${x}, ${y}) on ${this.description}`);
        return this.uncheck({ position: { x, y } });
    }

    async uncheckWithTimeout(timeout: number): Promise<void> {
        CSReporter.info(`Unchecking with ${timeout}ms timeout on ${this.description}`);
        return this.uncheck({ timeout });
    }

    async uncheckWithTrial(): Promise<void> {
        CSReporter.info(`Trial unchecking on ${this.description}`);
        return this.uncheck({ trial: true });
    }

    async uncheckWithoutWaiting(): Promise<void> {
        CSReporter.info(`Unchecking without waiting on ${this.description}`);
        return this.uncheck({ noWaitAfter: true });
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

    async setCheckedWithPosition(checked: boolean, x: number, y: number): Promise<void> {
        CSReporter.info(`Setting checked to ${checked} at position (${x}, ${y}) on ${this.description}`);
        return this.setChecked(checked, { position: { x, y } });
    }

    async setCheckedWithTimeout(checked: boolean, timeout: number): Promise<void> {
        CSReporter.info(`Setting checked to ${checked} with ${timeout}ms timeout on ${this.description}`);
        return this.setChecked(checked, { timeout });
    }

    async setCheckedWithTrial(checked: boolean): Promise<void> {
        CSReporter.info(`Trial setting checked to ${checked} on ${this.description}`);
        return this.setChecked(checked, { trial: true });
    }

    async setCheckedWithoutWaiting(checked: boolean): Promise<void> {
        CSReporter.info(`Setting checked to ${checked} without waiting on ${this.description}`);
        return this.setChecked(checked, { noWaitAfter: true });
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

    /**
     * Check if element is checked (for checkboxes/radio buttons)
     * Returns false if element is not found (does not throw error)
     */
    async isChecked(options?: IsCheckedOptions): Promise<boolean> {
        try {
            const locator = await this.getLocator();
            const result = await locator.isChecked(options);
            CSReporter.debug(`isChecked on ${this.description}: ${result}`);
            return result;
        } catch (error: any) {
            CSReporter.debug(`isChecked returned false for ${this.description}: Element not found - ${error.message}`);
            return false;
        }
    }

    /**
     * Check if element is checked with timeout
     * Returns false if element is not found (does not throw error)
     */
    async isCheckedWithTimeout(timeout: number): Promise<boolean> {
        CSReporter.info(`Checking if checked with ${timeout}ms timeout on ${this.description}`);
        return this.isChecked({ timeout });
    }

    /**
     * Check if element is disabled
     * Returns false if element is not found (does not throw error)
     */
    async isDisabled(options?: IsDisabledOptions): Promise<boolean> {
        try {
            const locator = await this.getLocator();
            const result = await locator.isDisabled(options);
            CSReporter.debug(`isDisabled on ${this.description}: ${result}`);
            return result;
        } catch (error: any) {
            CSReporter.debug(`isDisabled returned false for ${this.description}: Element not found - ${error.message}`);
            return false;
        }
    }

    /**
     * Check if element is disabled with timeout
     * Returns false if element is not found (does not throw error)
     */
    async isDisabledWithTimeout(timeout: number): Promise<boolean> {
        CSReporter.info(`Checking if disabled with ${timeout}ms timeout on ${this.description}`);
        return this.isDisabled({ timeout });
    }

    /**
     * Check if element is editable
     * Returns false if element is not found (does not throw error)
     */
    async isEditable(options?: IsEditableOptions): Promise<boolean> {
        try {
            const locator = await this.getLocator();
            const result = await locator.isEditable(options);
            CSReporter.debug(`isEditable on ${this.description}: ${result}`);
            return result;
        } catch (error: any) {
            CSReporter.debug(`isEditable returned false for ${this.description}: Element not found - ${error.message}`);
            return false;
        }
    }

    /**
     * Check if element is editable with timeout
     * Returns false if element is not found (does not throw error)
     */
    async isEditableWithTimeout(timeout: number): Promise<boolean> {
        CSReporter.info(`Checking if editable with ${timeout}ms timeout on ${this.description}`);
        return this.isEditable({ timeout });
    }

    /**
     * Check if element is enabled
     * Returns false if element is not found (does not throw error)
     */
    async isEnabled(options?: IsEnabledOptions): Promise<boolean> {
        try {
            const locator = await this.getLocator();
            const result = await locator.isEnabled(options);
            CSReporter.debug(`isEnabled on ${this.description}: ${result}`);
            return result;
        } catch (error: any) {
            CSReporter.debug(`isEnabled returned false for ${this.description}: Element not found - ${error.message}`);
            return false;
        }
    }

    /**
     * Check if element is enabled with timeout
     * Returns false if element is not found (does not throw error)
     */
    async isEnabledWithTimeout(timeout: number): Promise<boolean> {
        CSReporter.info(`Checking if enabled with ${timeout}ms timeout on ${this.description}`);
        return this.isEnabled({ timeout });
    }

    /**
     * Check if element is hidden
     * Returns true if element is not found (element not found = hidden)
     */
    async isHidden(options?: IsHiddenOptions): Promise<boolean> {
        try {
            const locator = await this.getLocator();
            const result = await locator.isHidden(options);
            CSReporter.debug(`isHidden on ${this.description}: ${result}`);
            return result;
        } catch (error: any) {
            // Element not found = hidden (return true)
            CSReporter.debug(`isHidden returned true for ${this.description}: Element not found - ${error.message}`);
            return true;
        }
    }

    /**
     * Check if element is hidden with timeout
     * Returns true if element is not found (element not found = hidden)
     */
    async isHiddenWithTimeout(timeout: number): Promise<boolean> {
        CSReporter.info(`Checking if hidden with ${timeout}ms timeout on ${this.description}`);
        return this.isHidden({ timeout });
    }

    /**
     * Check if element is visible
     * Returns false if element is not found (does not throw error)
     */
    async isVisible(options?: IsVisibleOptions): Promise<boolean> {
        try {
            const locator = await this.getLocator();
            const result = await locator.isVisible(options);
            CSReporter.debug(`isVisible on ${this.description}: ${result}`);
            return result;
        } catch (error: any) {
            CSReporter.debug(`isVisible returned false for ${this.description}: Element not found - ${error.message}`);
            return false;
        }
    }

    /**
     * Check if element is visible with timeout
     * Returns false if element is not found (does not throw error)
     */
    async isVisibleWithTimeout(timeout: number): Promise<boolean> {
        CSReporter.info(`Checking if visible with ${timeout}ms timeout on ${this.description}`);
        return this.isVisible({ timeout });
    }

    /**
     * Check if element is present in the DOM (exists)
     * Returns true if element exists, false otherwise (does not throw error)
     */
    async isPresent(): Promise<boolean> {
        try {
            const locator = await this.getLocator();
            const count = await locator.count();
            const result = count > 0;
            CSReporter.debug(`isPresent on ${this.description}: ${result}`);
            return result;
        } catch (error: any) {
            CSReporter.debug(`isPresent returned false for ${this.description}: ${error.message}`);
            return false;
        }
    }

    /**
     * Check if element is present in the DOM with timeout
     * Returns true if element exists, false otherwise (does not throw error)
     */
    async isPresentWithTimeout(timeout: number): Promise<boolean> {
        CSReporter.info(`Checking if present with ${timeout}ms timeout on ${this.description}`);
        try {
            const locator = await this.getLocator();
            await locator.waitFor({ state: 'attached', timeout });
            return true;
        } catch (error: any) {
            CSReporter.debug(`isPresentWithTimeout returned false for ${this.description}: ${error.message}`);
            return false;
        }
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

    // Individual animation methods
    async screenshotWithAnimationsDisabled(): Promise<Buffer> {
        CSReporter.info(`Taking screenshot with animations disabled of ${this.description}`);
        return this.screenshot({ animations: 'disabled' });
    }

    async screenshotWithAnimationsAllowed(): Promise<Buffer> {
        CSReporter.info(`Taking screenshot with animations allowed of ${this.description}`);
        return this.screenshot({ animations: 'allow' });
    }

    // Individual caret methods
    async screenshotWithCaretHidden(): Promise<Buffer> {
        CSReporter.info(`Taking screenshot with caret hidden of ${this.description}`);
        return this.screenshot({ caret: 'hide' });
    }

    async screenshotWithCaretInitial(): Promise<Buffer> {
        CSReporter.info(`Taking screenshot with initial caret of ${this.description}`);
        return this.screenshot({ caret: 'initial' });
    }

    // Individual type methods
    async screenshotAsPng(): Promise<Buffer> {
        CSReporter.info(`Taking PNG screenshot of ${this.description}`);
        return this.screenshot({ type: 'png' });
    }

    async screenshotAsJpeg(quality?: number): Promise<Buffer> {
        CSReporter.info(`Taking JPEG screenshot of ${this.description}`);
        return this.screenshot({ type: 'jpeg', quality });
    }

    // Individual scale methods
    async screenshotWithCssScale(): Promise<Buffer> {
        CSReporter.info(`Taking CSS-scaled screenshot of ${this.description}`);
        return this.screenshot({ scale: 'css' });
    }

    async screenshotWithDeviceScale(): Promise<Buffer> {
        CSReporter.info(`Taking device-scaled screenshot of ${this.description}`);
        return this.screenshot({ scale: 'device' });
    }

    // Other screenshot methods
    async screenshotWithTimeout(timeout: number): Promise<Buffer> {
        CSReporter.info(`Taking screenshot with ${timeout}ms timeout of ${this.description}`);
        return this.screenshot({ timeout });
    }

    async screenshotWithMask(masks: Locator[]): Promise<Buffer> {
        CSReporter.info(`Taking screenshot with ${masks.length} masks of ${this.description}`);
        return this.screenshot({ mask: masks });
    }

    async screenshotWithOmitBackground(): Promise<Buffer> {
        CSReporter.info(`Taking screenshot with transparent background of ${this.description}`);
        return this.screenshot({ omitBackground: true });
    }

    async screenshotWithClip(x: number, y: number, width: number, height: number): Promise<Buffer> {
        CSReporter.info(`Taking clipped screenshot at (${x}, ${y}) ${width}x${height} of ${this.description}`);
        return this.screenshot({ clip: { x, y, width, height } });
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

    // ============================================
    // LOCATOR INFORMATION METHODS (Playwright 1.57+)
    // ============================================

    /**
     * Get the element's description (user-defined description)
     * @returns The description string for this element
     */
    getElementDescription(): string {
        return this.description;
    }

    /**
     * Get the Playwright locator's internal description
     * Uses Playwright 1.57+ locator.description() API
     * @returns The Playwright locator description string or null if not available
     * @since Playwright 1.57
     */
    async getLocatorDescription(): Promise<string | null> {
        try {
            const locator = await this.getLocator();
            // Check if description() method exists (Playwright 1.57+)
            if (typeof (locator as any).description === 'function') {
                return await (locator as any).description();
            }
            // Fallback for older Playwright versions
            return this.description;
        } catch (error) {
            CSReporter.debug(`Failed to get locator description: ${error}`);
            return this.description;
        }
    }

    /**
     * Get comprehensive locator information for debugging and healing
     * Combines user description with Playwright's internal locator description
     * @since Playwright 1.57
     */
    async getLocatorInfo(): Promise<{
        userDescription: string;
        locatorDescription: string | null;
        selectorType: string;
        selectorValue: string;
    }> {
        const locatorDesc = await this.getLocatorDescription();
        const strategies = this.buildLocatorStrategies();
        const primaryStrategy = strategies[0];

        return {
            userDescription: this.description,
            locatorDescription: locatorDesc,
            selectorType: primaryStrategy?.type || 'unknown',
            selectorValue: primaryStrategy?.value || 'unknown'
        };
    }
}

/**
 * CSElementFactory - Factory class for creating CSWebElement instances dynamically
 * Provides static helper methods for creating elements without decorators
 */
export class CSElementFactory {
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
     * Detect selector type from a selector string
     * @param selector Selector string to analyze
     * @returns Object with selector type and properly formatted value
     */
    private static detectSelectorType(selector: string): { type: string; value: string; option: Partial<ElementOptions> } {
        // Check for explicit type prefix
        if (selector.startsWith('xpath:')) {
            return { type: 'xpath', value: selector.substring(6), option: { xpath: selector.substring(6) } };
        }
        if (selector.startsWith('css:')) {
            return { type: 'css', value: selector.substring(4), option: { css: selector.substring(4) } };
        }
        if (selector.startsWith('text:')) {
            return { type: 'text', value: selector.substring(5), option: { text: selector.substring(5) } };
        }
        if (selector.startsWith('testId:')) {
            return { type: 'testId', value: selector.substring(7), option: { testId: selector.substring(7) } };
        }
        if (selector.startsWith('role:')) {
            return { type: 'role', value: selector.substring(5), option: { role: selector.substring(5) } };
        }

        // Auto-detect based on selector patterns

        // XPath patterns: starts with / or ( or contains [contains( or [text()
        if (
            selector.startsWith('//') ||
            selector.startsWith('/') ||
            selector.startsWith('(//') ||
            selector.includes('[contains(') ||
            selector.includes('[text()') ||
            selector.match(/\/\/[a-z]/i)
        ) {
            return { type: 'xpath', value: selector, option: { xpath: selector } };
        }

        // ID selector: starts with #
        if (selector.startsWith('#') && !selector.includes(' ')) {
            return { type: 'id', value: selector.substring(1), option: { id: selector.substring(1) } };
        }

        // Default to CSS
        return { type: 'css', value: selector, option: { css: selector } };
    }

    /**
     * Create a CSWebElement dynamically with interpolated selector
     * Supports both CSS and XPath templates with automatic type detection
     * @param template Selector template with placeholders (CSS or XPath)
     * @param values Values to interpolate
     * @param description Optional description for logging
     * @param page Optional page instance
     * @example CSWebElement.createWithTemplate('button[data-id="{id}"]', {id: '123'}) // CSS
     * @example CSWebElement.createWithTemplate('//button[@data-id="{id}"]', {id: '123'}) // XPath
     */
    public static createWithTemplate(template: string, values: Record<string, string>, description?: string, page?: Page): CSWebElement {
        let selector = template;
        for (const [key, value] of Object.entries(values)) {
            selector = selector.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
        }

        // Detect selector type and create appropriate element
        const detected = this.detectSelectorType(selector);

        CSReporter.debug(`createWithTemplate: Detected ${detected.type} selector from template: ${template} => ${selector}`);

        return new CSWebElement({
            ...detected.option,
            description: description || `Dynamic templated element (${detected.type}): ${selector}`
        }, page);
    }

    /**
     * Create multiple CSWebElements dynamically matching a pattern
     * Supports both CSS and XPath selectors with automatic type detection
     * @param selector Selector that matches multiple elements (CSS or XPath)
     * @param description Optional description for logging
     * @param page Optional page instance
     * @returns Array of CSWebElement instances
     * @example createMultiple('div.item') // CSS
     * @example createMultiple('//div[@class="item"]') // XPath
     */
    public static async createMultiple(selector: string, description?: string, page?: Page): Promise<CSWebElement[]> {
        if (!CSBrowserManager) {
            CSBrowserManager = require('../browser/CSBrowserManager').CSBrowserManager;
        }
        const pageInstance = page || CSBrowserManager.getInstance().getPage();

        // Detect selector type
        const detected = this.detectSelectorType(selector);
        CSReporter.debug(`createMultiple: Detected ${detected.type} selector: ${selector}`);

        // Get count using proper locator syntax
        let locatorString = selector;
        if (detected.type === 'xpath') {
            locatorString = `xpath=${detected.value}`;
        }

        const count = await pageInstance.locator(locatorString).count();
        const elements: CSWebElement[] = [];

        // Create elements using native Playwright nth() for proper indexing
        for (let i = 0; i < count; i++) {
            const element = new CSWebElement({
                ...detected.option,
                description: `${description || 'Dynamic element'} [${i + 1}]`
            }, page);

            // Set the locator to use nth() instead of CSS pseudo-selectors
            (element as any).locator = pageInstance.locator(locatorString).nth(i);

            elements.push(element);
        }

        CSReporter.info(`createMultiple: Found ${count} elements matching ${detected.type} selector`);
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
     * Supports both CSS and XPath selectors with automatic type detection
     * @param selector Selector (CSS or XPath)
     * @param index Index of the element (0-based)
     * @param description Optional description for logging
     * @param page Optional page instance
     * @example createNth('button.submit', 2) // CSS - 3rd submit button
     * @example createNth('//button[@type="submit"]', 1) // XPath - 2nd submit button
     */
    public static createNth(selector: string, index: number, description?: string, page?: Page): CSWebElement {
        if (!CSBrowserManager) {
            CSBrowserManager = require('../browser/CSBrowserManager').CSBrowserManager;
        }
        const pageInstance = page || CSBrowserManager.getInstance().getPage();

        // Detect selector type
        const detected = this.detectSelectorType(selector);
        CSReporter.debug(`createNth: Detected ${detected.type} selector for index ${index}: ${selector}`);

        // Get proper locator string
        let locatorString = selector;
        if (detected.type === 'xpath') {
            locatorString = `xpath=${detected.value}`;
        }

        // Create element with nth() locator
        const element = new CSWebElement({
            ...detected.option,
            description: description || `${selector} [index: ${index}]`
        }, page);

        // Set the locator to use nth() instead of relying on CSS pseudo-selectors
        (element as any).locator = pageInstance.locator(locatorString).nth(index);

        return element;
    }
}