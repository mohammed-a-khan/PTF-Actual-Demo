// Lazy load Playwright for performance
// import { Page, Locator, ElementHandle } from '@playwright/test';
type Page = any;
type Locator = any;
type ElementHandle = any;

import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
// Lazy load AI Engine to avoid its Playwright imports
// import { CSAIEngine } from '../ai/CSAIEngine';
let CSAIEngine: any = null;

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
    private aiEngine: any; // CSAIEngine - lazy loaded
    private strategies: HealingStrategy[] = [];
    private healingHistory: Map<string, HealingResult> = new Map();
    private elementCache: Map<string, any> = new Map();
    
    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        // Lazy load AI Engine when needed
        this.aiEngine = null;
        this.initializeStrategies();
    }

    private getAIEngine(): any {
        if (!this.aiEngine) {
            if (!CSAIEngine) {
                CSAIEngine = require('../ai/CSAIEngine').CSAIEngine;
            }
            this.aiEngine = CSAIEngine.getInstance();
        }
        return this.aiEngine;
    }
    
    public static getInstance(): CSSelfHealingEngine {
        if (!CSSelfHealingEngine.instance) {
            CSSelfHealingEngine.instance = new CSSelfHealingEngine();
        }
        return CSSelfHealingEngine.instance;
    }
    
    private initializeStrategies(): void {
        // 1. Nearby Elements Strategy
        this.strategies.push({
            name: 'nearby',
            priority: 1,
            heal: async (page, originalLocator, context) => {
                return this.nearbyElementsStrategy(page, originalLocator, context);
            }
        });
        
        // 2. Text-based Strategy
        this.strategies.push({
            name: 'text',
            priority: 2,
            heal: async (page, originalLocator, context) => {
                return this.textBasedStrategy(page, originalLocator, context);
            }
        });
        
        // 3. Visual Similarity Strategy
        this.strategies.push({
            name: 'visual',
            priority: 3,
            heal: async (page, originalLocator, context) => {
                return this.visualSimilarityStrategy(page, originalLocator, context);
            }
        });
        
        // 4. Structure-based Strategy
        this.strategies.push({
            name: 'structure',
            priority: 4,
            heal: async (page, originalLocator, context) => {
                return this.structureBasedStrategy(page, originalLocator, context);
            }
        });
        
        // 5. AI-powered Strategy
        this.strategies.push({
            name: 'ai',
            priority: 5,
            heal: async (page, originalLocator, context) => {
                return this.aiPoweredStrategy(page, originalLocator, context);
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
    
    private async nearbyElementsStrategy(page: Page, originalLocator: string, context: any): Promise<string | null> {
        // Parse the original locator to understand what we're looking for
        const { tag, attributes } = this.parseLocator(originalLocator);
        
        // Look for elements with similar attributes nearby
        const candidates = await page.evaluate((attrs: any) => {
            const elements = document.querySelectorAll('*');
            const results: Array<{ selector: string; score: number }> = [];
            
            elements.forEach(el => {
                let score = 0;
                
                // Check for similar class names
                if (attrs.class && el.className) {
                    const originalClasses = attrs.class.split(' ');
                    const elementClasses = el.className.split(' ');
                    const commonClasses = originalClasses.filter((c: string) => elementClasses.includes(c));
                    score += commonClasses.length * 10;
                }
                
                // Check for similar attributes
                if (attrs.id && el.id && el.id.includes(attrs.id.substring(0, 5))) {
                    score += 20;
                }
                
                // Check for similar text content
                if (attrs.text && el.textContent && el.textContent.includes(attrs.text)) {
                    score += 15;
                }
                
                // Check for same tag name
                if (attrs.tag && el.tagName.toLowerCase() === attrs.tag.toLowerCase()) {
                    score += 5;
                }
                
                if (score > 0) {
                    results.push({
                        selector: el.id ? `#${el.id}` : 
                                 el.className ? `.${el.className.split(' ')[0]}` :
                                 `${el.tagName.toLowerCase()}`,
                        score
                    });
                }
            });
            
            return results.sort((a, b) => b.score - a.score).slice(0, 5);
        }, attributes);
        
        // Return the best candidate
        return candidates.length > 0 ? candidates[0].selector : null;
    }
    
    private async textBasedStrategy(page: Page, originalLocator: string, context: any): Promise<string | null> {
        // Extract text from original locator
        const textMatch = originalLocator.match(/text[=:]["']([^"']+)["']/);
        if (!textMatch) return null;
        
        const searchText = textMatch[1];
        
        // Try different text-based selectors
        const textSelectors = [
            `text="${searchText}"`,
            `text*="${searchText}"`,
            `:has-text("${searchText}")`,
            `xpath=//*[contains(text(), "${searchText}")]`,
            `xpath=//*[contains(., "${searchText}")]`
        ];
        
        for (const selector of textSelectors) {
            try {
                const element = page.locator(selector);
                if (await element.count() > 0) {
                    return selector;
                }
            } catch (error) {
                continue;
            }
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
    
    private async structureBasedStrategy(page: Page, originalLocator: string, context: any): Promise<string | null> {
        // Get cached DOM structure if available
        const cachedStructure = this.elementCache.get(`structure_${originalLocator}`);
        if (!cachedStructure) return null;
        
        // Find elements with similar DOM structure
        const candidates = await page.evaluate((structure: any) => {
            const elements = document.querySelectorAll(structure.tag || '*');
            const results: Array<{ selector: string; score: number }> = [];
            
            elements.forEach(el => {
                let score = 0;
                
                // Check parent similarity
                if (el.parentElement && structure.parent) {
                    if (el.parentElement.tagName === structure.parent.tag) score += 20;
                    if (el.parentElement.className === structure.parent.class) score += 15;
                }
                
                // Check siblings
                const siblings = Array.from(el.parentElement?.children || []);
                const siblingIndex = siblings.indexOf(el);
                if (siblingIndex === structure.siblingIndex) score += 10;
                
                // Check children
                if (el.children.length === structure.childCount) score += 10;
                
                // Check attributes
                if (structure.attributes) {
                    Object.entries(structure.attributes).forEach(([key, value]) => {
                        if (el.getAttribute(key) === value) score += 5;
                    });
                }
                
                if (score > 20) {
                    results.push({
                        selector: el.id ? `#${el.id}` : 
                                 el.className ? `.${el.className.split(' ')[0]}` :
                                 `${el.tagName.toLowerCase()}:nth-child(${siblingIndex + 1})`,
                        score
                    });
                }
            });
            
            return results.sort((a, b) => b.score - a.score).slice(0, 3);
        }, cachedStructure);
        
        return candidates.length > 0 ? candidates[0].selector : null;
    }
    
    private async aiPoweredStrategy(page: Page, originalLocator: string, context: any): Promise<string | null> {
        // Use AI to understand the intent and find the element
        const pageContent = await page.content();
        const screenshot = await page.screenshot();
        
        const prompt = `
            Original locator failed: ${originalLocator}
            Context: ${JSON.stringify(context)}
            
            Analyze the page and suggest an alternative locator that would find the same element.
            Consider the element's purpose, position, and attributes.
        `;
        
        try {
            const suggestion = await this.aiEngine.generateLocator(prompt, {
                html: pageContent,
                screenshot,
                originalLocator
            });
            
            if (suggestion) {
                const element = page.locator(suggestion);
                if (await element.count() > 0) {
                    return suggestion;
                }
            }
        } catch (error) {
            CSReporter.debug(`AI strategy failed: ${error}`);
        }
        
        return null;
    }
    
    private parseLocator(locator: string): { tag?: string; attributes: any } {
        const attributes: any = {};
        
        // Parse CSS selector
        if (locator.startsWith('.')) {
            attributes.class = locator.substring(1);
        } else if (locator.startsWith('#')) {
            attributes.id = locator.substring(1);
        } else if (locator.includes('[')) {
            // Parse attribute selector
            const match = locator.match(/\[([^=]+)=["']([^"']+)["']\]/);
            if (match) {
                attributes[match[1]] = match[2];
            }
        }
        
        // Extract tag name if present
        const tagMatch = locator.match(/^([a-z]+)/i);
        const tag = tagMatch ? tagMatch[1] : undefined;
        
        return { tag, attributes };
    }
    
    private calculateConfidence(strategy: string): number {
        const confidenceMap: Record<string, number> = {
            'alternative': 100,
            'nearby': 85,
            'text': 90,
            'visual': 75,
            'structure': 80,
            'ai': 70
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