import { Page, Locator } from '@playwright/test';
import { CSBrowserManager } from '../browser/CSBrowserManager';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';
import { CSAIEngine } from '../ai/CSAIEngine';
import { CSWebElement, ElementOptions } from './CSWebElement';

export interface ResolverOptions {
    page?: Page;
    timeout?: number;
    strict?: boolean;
    aiEnabled?: boolean;
    selfHeal?: boolean;
    cacheElements?: boolean;
}

export interface ElementPattern {
    pattern: string | RegExp;
    selector: string;
    priority?: number;
}

export interface DynamicElement {
    basePath: string;
    attributes: Map<string, string>;
    parameters: Map<string, any>;
}

export class CSElementResolver {
    private static instance: CSElementResolver;
    private config: CSConfigurationManager;
    private aiEngine: CSAIEngine;
    private page: Page;
    private elementCache: Map<string, CSWebElement> = new Map();
    private selectorPatterns: Map<string, ElementPattern[]> = new Map();
    private healingHistory: Map<string, string[]> = new Map();
    private dynamicElements: Map<string, DynamicElement> = new Map();

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.aiEngine = CSAIEngine.getInstance();
        this.page = CSBrowserManager.getInstance().getPage();
        this.initializePatterns();
    }

    public static getInstance(): CSElementResolver {
        if (!CSElementResolver.instance) {
            CSElementResolver.instance = new CSElementResolver();
        }
        return CSElementResolver.instance;
    }

    private initializePatterns(): void {
        // Common UI patterns for element resolution
        this.registerPattern('button', [
            { pattern: /^(.*)\s+button$/i, selector: 'button:has-text("{0}")', priority: 1 },
            { pattern: /^click\s+(.*)$/i, selector: '[role="button"]:has-text("{0}")', priority: 2 },
            { pattern: /^press\s+(.*)$/i, selector: 'button:has-text("{0}")', priority: 3 }
        ]);

        this.registerPattern('input', [
            { pattern: /^(.*)\s+field$/i, selector: 'input[placeholder*="{0}"]', priority: 1 },
            { pattern: /^(.*)\s+input$/i, selector: 'input[name*="{0}"]', priority: 2 },
            { pattern: /^enter\s+(.*)$/i, selector: 'input[aria-label*="{0}"]', priority: 3 }
        ]);

        this.registerPattern('link', [
            { pattern: /^(.*)\s+link$/i, selector: 'a:has-text("{0}")', priority: 1 },
            { pattern: /^go\s+to\s+(.*)$/i, selector: 'a[href*="{0}"]', priority: 2 }
        ]);

        this.registerPattern('dropdown', [
            { pattern: /^(.*)\s+dropdown$/i, selector: 'select[name*="{0}"]', priority: 1 },
            { pattern: /^select\s+(.*)$/i, selector: 'select:has(option:has-text("{0}"))', priority: 2 }
        ]);

        CSReporter.debug('Element resolver patterns initialized');
    }

    public registerPattern(category: string, patterns: ElementPattern[]): void {
        if (!this.selectorPatterns.has(category)) {
            this.selectorPatterns.set(category, []);
        }
        
        const existing = this.selectorPatterns.get(category)!;
        existing.push(...patterns);
        
        // Sort by priority
        existing.sort((a, b) => (a.priority || 999) - (b.priority || 999));
        
        CSReporter.debug(`Registered ${patterns.length} patterns for category: ${category}`);
    }

    // Resolve element by natural language description
    public async resolveByDescription(description: string, options?: ResolverOptions): Promise<CSWebElement> {
        const startTime = Date.now();
        CSReporter.info(`Resolving element by description: "${description}"`);

        // Check cache first
        if (options?.cacheElements !== false && this.elementCache.has(description)) {
            CSReporter.debug('Element found in cache');
            return this.elementCache.get(description)!;
        }

        let element: CSWebElement | null = null;

        // Try pattern-based resolution
        element = await this.resolveByPatterns(description, options);

        // Try AI-based resolution if enabled
        if (!element && options?.aiEnabled !== false) {
            element = await this.resolveByAI(description, options);
        }

        // Try self-healing if enabled
        if (!element && options?.selfHeal !== false) {
            element = await this.resolveBySelfHealing(description, options);
        }

        if (!element) {
            throw new Error(`Could not resolve element: ${description}`);
        }

        // Cache the resolved element
        if (options?.cacheElements !== false) {
            this.elementCache.set(description, element);
        }

        const duration = Date.now() - startTime;
        CSReporter.pass(`Element resolved in ${duration}ms`);

        return element;
    }

    private async resolveByPatterns(description: string, options?: ResolverOptions): Promise<CSWebElement | null> {
        // Try each category of patterns
        for (const [category, patterns] of this.selectorPatterns) {
            for (const pattern of patterns) {
                const match = description.match(pattern.pattern);
                
                if (match) {
                    // Extract captured groups and build selector
                    const selector = this.buildSelector(pattern.selector, match);
                    
                    try {
                        const element = new CSWebElement({
                            css: selector,
                            description: description,
                            timeout: options?.timeout || 5000
                        });

                        // Verify element exists
                        if (await element.count() > 0) {
                            CSReporter.debug(`Resolved by pattern in category: ${category}`);
                            return element;
                        }
                    } catch (error) {
                        // Continue to next pattern
                    }
                }
            }
        }

        return null;
    }

    private buildSelector(template: string, match: RegExpMatchArray): string {
        let selector = template;
        
        // Replace placeholders with captured groups
        for (let i = 0; i < match.length; i++) {
            selector = selector.replace(`{${i}}`, match[i] || '');
        }
        
        return selector;
    }

    private async resolveByAI(description: string, options?: ResolverOptions): Promise<CSWebElement | null> {
        CSReporter.debug('Attempting AI-based element resolution');

        try {
            const element = await this.aiEngine.findByVisualDescription(this.page, description);
            
            if (element) {
                if (await element.count() > 0) {
                    CSReporter.debug('Element resolved by AI');
                    
                    // Store for self-healing - use element's selector if available
                    this.updateHealingHistory(description, 'ai-generated');
                    
                    return element;
                }
            }
        } catch (error: any) {
            CSReporter.warn(`AI resolution failed: ${error.message}`);
        }

        return null;
    }

    private async resolveBySelfHealing(description: string, options?: ResolverOptions): Promise<CSWebElement | null> {
        CSReporter.debug('Attempting self-healing resolution');

        // Check healing history
        if (this.healingHistory.has(description)) {
            const previousSelectors = this.healingHistory.get(description)!;
            
            for (const selector of previousSelectors) {
                try {
                    const element = new CSWebElement({
                        css: selector,
                        description: description,
                        timeout: options?.timeout || 5000
                    });

                    if (await element.count() > 0) {
                        CSReporter.debug('Element resolved by self-healing');
                        return element;
                    }
                } catch (error) {
                    // Continue to next selector
                }
            }
        }

        return null;
    }

    private updateHealingHistory(description: string, selector: string): void {
        if (!this.healingHistory.has(description)) {
            this.healingHistory.set(description, []);
        }

        const history = this.healingHistory.get(description)!;
        
        // Add to history if not already present
        if (!history.includes(selector)) {
            history.unshift(selector);
            
            // Keep only last 5 selectors
            if (history.length > 5) {
                history.pop();
            }
        }
    }

    // Create dynamic element with parameters
    public createDynamicElement(template: string, params: Record<string, any>): CSWebElement {
        CSReporter.debug(`Creating dynamic element with template: ${template}`);

        // Replace parameters in template
        let selector = template;
        for (const [key, value] of Object.entries(params)) {
            selector = selector.replace(`{{${key}}}`, value.toString());
            selector = selector.replace(`{${key}}`, value.toString());
        }

        const description = `Dynamic element: ${template} with params: ${JSON.stringify(params)}`;

        return new CSWebElement({
            css: selector,
            description: description,
            timeout: this.config.getNumber('DEFAULT_TIMEOUT', 10000)
        });
    }

    // Create element by role
    public createByRole(role: string, options?: { name?: string; exact?: boolean }): CSWebElement {
        let selector = `[role="${role}"]`;
        
        if (options?.name) {
            if (options.exact) {
                selector += `[aria-label="${options.name}"]`;
            } else {
                selector += `[aria-label*="${options.name}"]`;
            }
        }

        return new CSWebElement({
            css: selector,
            description: `Element with role: ${role}${options?.name ? ` and name: ${options.name}` : ''}`,
            timeout: this.config.getNumber('DEFAULT_TIMEOUT', 10000)
        });
    }

    // Create element by test ID
    public createByTestId(testId: string): CSWebElement {
        return new CSWebElement({
            testId: testId,
            description: `Element with test ID: ${testId}`,
            timeout: this.config.getNumber('DEFAULT_TIMEOUT', 10000)
        });
    }

    // Create element within container
    public createWithinContainer(containerSelector: string, elementSelector: string): CSWebElement {
        const combinedSelector = `${containerSelector} ${elementSelector}`;
        
        return new CSWebElement({
            css: combinedSelector,
            description: `Element ${elementSelector} within ${containerSelector}`,
            timeout: this.config.getNumber('DEFAULT_TIMEOUT', 10000)
        });
    }

    // Create nth element from collection
    public createNthElement(selector: string, index: number): CSWebElement {
        const nthSelector = `${selector}:nth-of-type(${index + 1})`;
        
        return new CSWebElement({
            css: nthSelector,
            description: `Element ${index} of ${selector}`,
            timeout: this.config.getNumber('DEFAULT_TIMEOUT', 10000)
        });
    }

    // Create element with text content
    public createByText(text: string, options?: { exact?: boolean; selector?: string }): CSWebElement {
        let selector = options?.selector || '*';
        
        if (options?.exact) {
            selector = `${selector}:text-is("${text}")`;
        } else {
            selector = `${selector}:has-text("${text}")`;
        }

        return new CSWebElement({
            css: selector,
            text: text,
            description: `Element with text: ${text}`,
            timeout: this.config.getNumber('DEFAULT_TIMEOUT', 10000)
        });
    }

    // Create element by attribute
    public createByAttribute(attribute: string, value: string, options?: { exact?: boolean }): CSWebElement {
        let selector: string;
        
        if (options?.exact) {
            selector = `[${attribute}="${value}"]`;
        } else {
            selector = `[${attribute}*="${value}"]`;
        }

        return new CSWebElement({
            css: selector,
            description: `Element with ${attribute}="${value}"`,
            timeout: this.config.getNumber('DEFAULT_TIMEOUT', 10000)
        });
    }

    // Create form element by label
    public createByLabel(labelText: string): CSWebElement {
        // Multiple strategies to find form element by label
        const selectors = [
            `input[aria-label="${labelText}"]`,
            `select[aria-label="${labelText}"]`,
            `textarea[aria-label="${labelText}"]`,
            `//label[contains(text(), "${labelText}")]//following-sibling::input[1]`,
            `//label[contains(text(), "${labelText}")]//following-sibling::select[1]`,
            `//label[contains(text(), "${labelText}")]//following-sibling::textarea[1]`
        ];

        return new CSWebElement({
            css: selectors[0],
            xpath: selectors[3],
            description: `Form element with label: ${labelText}`,
            timeout: this.config.getNumber('DEFAULT_TIMEOUT', 10000),
            selfHeal: true
        });
    }

    // Create element relative to another
    public createRelativeElement(anchorSelector: string, position: 'above' | 'below' | 'left' | 'right', targetSelector?: string): CSWebElement {
        // This would use Playwright's relative locators in actual implementation
        const description = `Element ${position} ${anchorSelector}`;
        
        return new CSWebElement({
            css: targetSelector || '*',
            description: description,
            timeout: this.config.getNumber('DEFAULT_TIMEOUT', 10000)
        });
    }

    // Clear cache
    public clearCache(): void {
        this.elementCache.clear();
        CSReporter.debug('Element cache cleared');
    }

    // Get cache statistics
    public getCacheStats(): { size: number; entries: string[] } {
        return {
            size: this.elementCache.size,
            entries: Array.from(this.elementCache.keys())
        };
    }

    // Export healing history for persistence
    public exportHealingHistory(): Record<string, string[]> {
        const history: Record<string, string[]> = {};
        
        for (const [key, value] of this.healingHistory) {
            history[key] = value;
        }
        
        return history;
    }

    // Import healing history
    public importHealingHistory(history: Record<string, string[]>): void {
        for (const [key, value] of Object.entries(history)) {
            this.healingHistory.set(key, value);
        }
        
        CSReporter.debug(`Imported ${Object.keys(history).length} healing history entries`);
    }
}