// Lazy load Playwright for performance
// import { Page, Locator, ElementHandle } from '@playwright/test';
type Page = any;
type Locator = any;
type ElementHandle = any;

import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';

// Zero-step engine modules (lazy loaded)
let accessibilityTreeMatcher: any = null;
let elementFingerprint: any = null;
let elementCache: any = null;
let fuzzyMatcher: any = null;

export interface HealingStrategy {
    name: string;
    priority: number;
    heal(page: Page, originalLocator: string, context?: any): Promise<string | null>;
}

export interface HealingResult {
    success: boolean;
    originalLocator: string;
    healedLocator?: string;
    strategy?: string;
    confidence?: number;
    duration: number;
}

export class CSSelfHealingEngine {
    private static instance: CSSelfHealingEngine;
    private config: CSConfigurationManager;
    private strategies: HealingStrategy[] = [];
    private healingHistory: Map<string, HealingResult> = new Map();
    private elementCache: Map<string, any> = new Map();

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.initializeStrategies();
    }

    /**
     * Lazy-load zero-step engine modules to avoid circular dependencies
     */
    private getAccessibilityTreeMatcher(): any {
        if (!accessibilityTreeMatcher) {
            const mod = require('../ai/step-engine/CSAccessibilityTreeMatcher');
            accessibilityTreeMatcher = mod.CSAccessibilityTreeMatcher.getInstance();
        }
        return accessibilityTreeMatcher;
    }

    private getElementFingerprint(): any {
        if (!elementFingerprint) {
            const mod = require('../ai/step-engine/CSElementFingerprint');
            elementFingerprint = mod.CSElementFingerprint.getInstance();
        }
        return elementFingerprint;
    }

    private getElementCache(): any {
        if (!elementCache) {
            const mod = require('../ai/step-engine/CSElementCache');
            elementCache = mod.CSElementCache.getInstance();
        }
        return elementCache;
    }

    private getFuzzyMatcher(): any {
        if (!fuzzyMatcher) {
            const mod = require('../ai/step-engine/CSFuzzyMatcher');
            fuzzyMatcher = mod.CSFuzzyMatcher.getInstance();
        }
        return fuzzyMatcher;
    }

    public static getInstance(): CSSelfHealingEngine {
        if (!CSSelfHealingEngine.instance) {
            CSSelfHealingEngine.instance = new CSSelfHealingEngine();
        }
        return CSSelfHealingEngine.instance;
    }

    private initializeStrategies(): void {
        // 1. Accessibility Tree Strategy (zero-step powered)
        this.strategies.push({
            name: 'accessibility-tree',
            priority: 1,
            heal: async (page, originalLocator, context) => {
                return this.accessibilityTreeStrategy(page, originalLocator, context);
            }
        });

        // 2. Fingerprint Self-Heal Strategy (zero-step powered)
        this.strategies.push({
            name: 'fingerprint',
            priority: 2,
            heal: async (page, originalLocator, context) => {
                return this.fingerprintStrategy(page, originalLocator, context);
            }
        });

        // 3. Fuzzy Text Search Strategy (zero-step powered)
        this.strategies.push({
            name: 'fuzzy-text',
            priority: 3,
            heal: async (page, originalLocator, context) => {
                return this.fuzzyTextStrategy(page, originalLocator, context);
            }
        });

        // 4. Visual Similarity Strategy (existing — uses cached visual signatures)
        this.strategies.push({
            name: 'visual',
            priority: 4,
            heal: async (page, originalLocator, context) => {
                return this.visualSimilarityStrategy(page, originalLocator, context);
            }
        });

        // Sort by priority
        this.strategies.sort((a, b) => a.priority - b.priority);
    }

    public async heal(page: Page, originalLocator: string, alternativeLocators?: string[]): Promise<HealingResult> {
        const startTime = Date.now();

        // First try the original locator
        try {
            const element = page.locator(originalLocator);
            if (await element.count() > 0) {
                return {
                    success: true,
                    originalLocator,
                    duration: Date.now() - startTime
                };
            }
        } catch (error) {
            CSReporter.debug(`Original locator failed: ${originalLocator}`);
        }

        // Try alternative locators if provided
        if (alternativeLocators && alternativeLocators.length > 0) {
            for (const altLocator of alternativeLocators) {
                try {
                    const element = page.locator(altLocator);
                    if (await element.count() > 0) {
                        CSReporter.info(`Healed using alternative locator: ${altLocator}`);
                        return {
                            success: true,
                            originalLocator,
                            healedLocator: altLocator,
                            strategy: 'alternative',
                            confidence: 100,
                            duration: Date.now() - startTime
                        };
                    }
                } catch (error) {
                    CSReporter.debug(`Alternative locator failed: ${altLocator}`);
                }
            }
        }

        // Check if self-healing is enabled
        if (!this.config.getBoolean('SELF_HEALING_ENABLED', true)) {
            return {
                success: false,
                originalLocator,
                duration: Date.now() - startTime
            };
        }

        // Try each healing strategy
        for (const strategy of this.strategies) {
            try {
                CSReporter.debug(`Attempting ${strategy.name} healing strategy`);
                const healedLocator = await strategy.heal(page, originalLocator, {
                    alternativeLocators,
                    cache: this.elementCache
                });

                if (healedLocator) {
                    const element = page.locator(healedLocator);
                    if (await element.count() > 0) {
                        CSReporter.pass(`Element healed using ${strategy.name} strategy: ${healedLocator}`);

                        const result: HealingResult = {
                            success: true,
                            originalLocator,
                            healedLocator,
                            strategy: strategy.name,
                            confidence: this.calculateConfidence(strategy.name),
                            duration: Date.now() - startTime
                        };

                        // Store in history
                        this.healingHistory.set(originalLocator, result);

                        return result;
                    }
                }
            } catch (error) {
                CSReporter.debug(`${strategy.name} strategy failed: ${error}`);
            }
        }

        // All strategies failed
        return {
            success: false,
            originalLocator,
            duration: Date.now() - startTime
        };
    }

    /**
     * Strategy 1: Use the zero-step accessibility tree matcher to find the element.
     * Extracts text/role/label from the original locator and searches the a11y tree.
     */
    private async accessibilityTreeStrategy(page: Page, originalLocator: string, context: any): Promise<string | null> {
        try {
            const matcher = this.getAccessibilityTreeMatcher();

            // Extract a search descriptor from the original locator
            const descriptor = this.extractDescriptorFromLocator(originalLocator);
            if (!descriptor) return null;

            // Build an ElementTarget compatible with the matcher
            const target = {
                descriptor,
                elementType: undefined,
                ordinal: undefined,
                position: undefined,
                relationship: undefined
            };

            const match = await matcher.findElement(page, target);
            if (match && match.locator) {
                // Convert the matched locator back to a selector string
                const selector = await this.locatorToSelector(page, match.locator);
                if (selector) {
                    CSReporter.debug(`[SelfHeal] Accessibility tree found element: ${selector} (confidence: ${(match.confidence * 100).toFixed(1)}%)`);
                    return selector;
                }
            }
        } catch (error: any) {
            CSReporter.debug(`[SelfHeal] Accessibility tree strategy error: ${error.message}`);
        }
        return null;
    }

    /**
     * Strategy 2: Use fingerprint self-healing with cached fingerprints.
     * Compares 30+ attributes using weighted LCS to find the closest match.
     */
    private async fingerprintStrategy(page: Page, originalLocator: string, context: any): Promise<string | null> {
        try {
            const fp = this.getElementFingerprint();
            const cache = this.getElementCache();

            // Look up cached fingerprint for this locator
            const pageUrl = await page.url();
            const key = fp.generateKey(pageUrl, originalLocator);
            const cached = cache.get(key);

            if (cached && cached.fingerprint) {
                const match = await fp.selfHeal(page, cached.fingerprint);
                if (match && match.locator) {
                    const selector = await this.locatorToSelector(page, match.locator);
                    if (selector) {
                        CSReporter.debug(`[SelfHeal] Fingerprint healed element: ${selector} (score: ${(match.confidence * 100).toFixed(1)}%)`);
                        return selector;
                    }
                }
            }
        } catch (error: any) {
            CSReporter.debug(`[SelfHeal] Fingerprint strategy error: ${error.message}`);
        }
        return null;
    }

    /**
     * Strategy 3: Fuzzy text search using composite scoring.
     * Extracts text from the locator and finds the closest text match on the page.
     */
    private async fuzzyTextStrategy(page: Page, originalLocator: string, context: any): Promise<string | null> {
        try {
            const fm = this.getFuzzyMatcher();

            // Extract meaningful text from the locator
            const searchText = this.extractTextFromLocator(originalLocator);
            if (!searchText || searchText.length < 2) return null;

            // Collect visible text elements from the page
            const candidates = await page.evaluate(() => {
                const elements = document.querySelectorAll(
                    'button, a, input, select, textarea, label, h1, h2, h3, h4, h5, h6, [role], span, div, p, td, th, li'
                );
                const results: Array<{ text: string; selector: string }> = [];

                elements.forEach((el, index) => {
                    const htmlEl = el as HTMLElement;
                    const text = (htmlEl.innerText || htmlEl.textContent || '').trim().substring(0, 100);
                    if (!text || text.length < 2) return;

                    // Build a unique selector
                    let selector = '';
                    if (el.id) {
                        selector = `#${el.id}`;
                    } else {
                        const tag = el.tagName.toLowerCase();
                        const role = el.getAttribute('role');
                        const ariaLabel = el.getAttribute('aria-label');
                        if (ariaLabel) {
                            selector = `${tag}[aria-label="${ariaLabel}"]`;
                        } else if (role) {
                            selector = `${tag}[role="${role}"]`;
                        } else {
                            selector = `${tag}`;
                        }
                    }

                    results.push({ text, selector });
                });

                return results.slice(0, 100); // Cap for performance
            });

            // Find the best fuzzy match
            let bestScore = 0;
            let bestSelector: string | null = null;

            for (const candidate of candidates) {
                const result = fm.compare(searchText.toLowerCase(), candidate.text.toLowerCase());
                if (result.score > bestScore && result.score > 0.6) {
                    bestScore = result.score;
                    bestSelector = candidate.selector;
                }
            }

            if (bestSelector) {
                CSReporter.debug(`[SelfHeal] Fuzzy text matched: "${searchText}" → "${bestSelector}" (score: ${(bestScore * 100).toFixed(1)}%)`);
                return bestSelector;
            }
        } catch (error: any) {
            CSReporter.debug(`[SelfHeal] Fuzzy text strategy error: ${error.message}`);
        }
        return null;
    }

    private async visualSimilarityStrategy(page: Page, originalLocator: string, context: any): Promise<string | null> {
        // Get cached visual signature if available
        const cachedSignature = this.elementCache.get(`visual_${originalLocator}`);
        if (!cachedSignature) return null;

        // Find elements with similar visual properties
        const candidates = await page.evaluate((signature: any) => {
            const elements = document.querySelectorAll('*');
            const results: Array<{ selector: string; similarity: number }> = [];

            elements.forEach(el => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);

                // Calculate visual similarity
                let similarity = 0;

                // Similar size
                if (Math.abs(rect.width - signature.width) < 10) similarity += 20;
                if (Math.abs(rect.height - signature.height) < 10) similarity += 20;

                // Similar position
                if (Math.abs(rect.top - signature.top) < 50) similarity += 10;
                if (Math.abs(rect.left - signature.left) < 50) similarity += 10;

                // Similar style
                if (style.backgroundColor === signature.backgroundColor) similarity += 15;
                if (style.color === signature.color) similarity += 15;
                if (style.fontSize === signature.fontSize) similarity += 10;

                if (similarity > 50) {
                    results.push({
                        selector: el.id ? `#${el.id}` :
                                 el.className ? `.${el.className.split(' ')[0]}` :
                                 `${el.tagName.toLowerCase()}`,
                        similarity
                    });
                }
            });

            return results.sort((a, b) => b.similarity - a.similarity).slice(0, 3);
        }, cachedSignature);

        return candidates.length > 0 ? candidates[0].selector : null;
    }

    /**
     * Extract a human-readable descriptor from a CSS/Playwright locator string.
     * Used by the accessibility tree strategy to search for the element.
     */
    private extractDescriptorFromLocator(locator: string): string | null {
        // Extract from text-based selectors: text="Login", :has-text("Login")
        let match = locator.match(/text[=:]?\s*["']([^"']+)["']/i);
        if (match) return match[1];

        match = locator.match(/:has-text\(["']([^"']+)["']\)/i);
        if (match) return match[1];

        // Extract from aria-label: [aria-label="Search"]
        match = locator.match(/\[aria-label=["']([^"']+)["']\]/i);
        if (match) return match[1];

        // Extract from placeholder: [placeholder="Enter name"]
        match = locator.match(/\[placeholder=["']([^"']+)["']\]/i);
        if (match) return match[1];

        // Extract from title: [title="Submit"]
        match = locator.match(/\[title=["']([^"']+)["']\]/i);
        if (match) return match[1];

        // Extract from name attribute: [name="username"]
        match = locator.match(/\[name=["']([^"']+)["']\]/i);
        if (match) return match[1];

        // Extract from id: #login-button → "login button"
        match = locator.match(/^#([\w-]+)$/);
        if (match) return match[1].replace(/[-_]/g, ' ');

        // Extract from class: .btn-submit → "btn submit"
        match = locator.match(/^\.([\w-]+)$/);
        if (match) return match[1].replace(/[-_]/g, ' ');

        // Extract from data-testid: [data-testid="login-btn"]
        match = locator.match(/\[data-(?:testid|test-id|cy)=["']([^"']+)["']\]/i);
        if (match) return match[1].replace(/[-_]/g, ' ');

        return null;
    }

    /**
     * Extract meaningful text from a locator for fuzzy matching.
     */
    private extractTextFromLocator(locator: string): string | null {
        // Try all the descriptor extraction methods
        const descriptor = this.extractDescriptorFromLocator(locator);
        if (descriptor) return descriptor;

        // For complex selectors, try to extract the last meaningful part
        const parts = locator.split(/\s+/);
        if (parts.length > 0) {
            const lastPart = parts[parts.length - 1];
            const cleaned = lastPart.replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
            if (cleaned.length >= 2) return cleaned;
        }

        return null;
    }

    /**
     * Convert a Playwright Locator back to a selector string for healing result.
     */
    private async locatorToSelector(page: Page, locator: Locator): Promise<string | null> {
        try {
            // Try to get the element's attributes to build a selector
            const info = await locator.evaluate((el: Element) => {
                if (el.id) return { type: 'id', value: el.id };
                const ariaLabel = el.getAttribute('aria-label');
                if (ariaLabel) return { type: 'aria', value: ariaLabel, tag: el.tagName.toLowerCase() };
                const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
                if (testId) return { type: 'testid', value: testId };
                const name = el.getAttribute('name');
                if (name) return { type: 'name', value: name, tag: el.tagName.toLowerCase() };
                const role = el.getAttribute('role');
                const text = (el as HTMLElement).innerText?.trim().substring(0, 50);
                if (role && text) return { type: 'role-text', role, text, tag: el.tagName.toLowerCase() };
                if (text) return { type: 'text', value: text, tag: el.tagName.toLowerCase() };
                return { type: 'tag', value: el.tagName.toLowerCase() };
            });

            switch (info.type) {
                case 'id': return `#${info.value}`;
                case 'aria': return `${info.tag}[aria-label="${info.value}"]`;
                case 'testid': return `[data-testid="${info.value}"]`;
                case 'name': return `${info.tag}[name="${info.value}"]`;
                case 'role-text': return `${info.tag}[role="${info.role}"]:has-text("${info.text}")`;
                case 'text': return `${info.tag}:has-text("${info.value}")`;
                default: return info.value;
            }
        } catch {
            return null;
        }
    }

    private calculateConfidence(strategy: string): number {
        const confidenceMap: Record<string, number> = {
            'alternative': 100,
            'accessibility-tree': 90,
            'fingerprint': 85,
            'fuzzy-text': 80,
            'visual': 75
        };

        return confidenceMap[strategy] || 50;
    }

    public cacheElementSignature(locator: string, element: ElementHandle): void {
        // Cache visual signature
        element.evaluate((el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);

            return {
                width: rect.width,
                height: rect.height,
                top: rect.top,
                left: rect.left,
                backgroundColor: style.backgroundColor,
                color: style.color,
                fontSize: style.fontSize
            };
        }).then((signature: any) => {
            this.elementCache.set(`visual_${locator}`, signature);
        });

        // Cache structure signature
        element.evaluate((el: Element) => {
            const parent = el.parentElement;
            const siblings = parent ? Array.from(parent.children) : [];

            return {
                tag: el.tagName.toLowerCase(),
                parent: parent ? {
                    tag: parent.tagName,
                    class: parent.className
                } : null,
                siblingIndex: siblings.indexOf(el),
                childCount: el.children.length,
                attributes: Object.fromEntries(
                    Array.from(el.attributes).map(attr => [attr.name, attr.value])
                )
            };
        }).then((structure: any) => {
            this.elementCache.set(`structure_${locator}`, structure);
        });
    }

    public getHealingHistory(): Map<string, HealingResult> {
        return this.healingHistory;
    }

    public clearCache(): void {
        this.elementCache.clear();
        CSReporter.debug('Self-healing cache cleared');
    }

    public generateReport(): any {
        const history = Array.from(this.healingHistory.entries());
        const successCount = history.filter(([_, result]) => result.success).length;
        const totalCount = history.length;

        return {
            totalAttempts: totalCount,
            successfulHeals: successCount,
            successRate: totalCount > 0 ? (successCount / totalCount) * 100 : 0,
            strategyUsage: this.getStrategyUsage(),
            averageHealingTime: this.getAverageHealingTime(),
            history: history.map(([locator, result]) => ({
                locator,
                ...result
            }))
        };
    }

    private getStrategyUsage(): Record<string, number> {
        const usage: Record<string, number> = {};

        this.healingHistory.forEach(result => {
            if (result.strategy) {
                usage[result.strategy] = (usage[result.strategy] || 0) + 1;
            }
        });

        return usage;
    }

    private getAverageHealingTime(): number {
        const times = Array.from(this.healingHistory.values()).map(r => r.duration);

        if (times.length === 0) return 0;

        return times.reduce((a, b) => a + b, 0) / times.length;
    }
}
