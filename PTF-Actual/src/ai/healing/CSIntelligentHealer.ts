/**
 * Intelligent Healer - Diagnostic-driven self-healing engine
 * Attempts to heal failed element interactions using multiple strategies
 */

import { Page } from 'playwright';
import { CSReporter } from '../../reporter/CSReporter';
import { CSPageDiagnostics } from '../../diagnostics/CSPageDiagnostics';
import { CSIntelligentAI } from '../CSIntelligentAI';
import { CSPatternMatcher } from '../patterns/CSPatternMatcher';
import { CSFeatureExtractor } from '../features/CSFeatureExtractor';
import {
    IntelligentHealingResult,
    HealingStrategy,
    HealingContext,
    HealingAttemptResult,
    FailureAnalysis
} from '../types/AITypes';

// Zero-step engine modules (lazy loaded)
let zeroStepA11yMatcher: any = null;
let zeroStepFingerprint: any = null;

export class CSIntelligentHealer {
    private static instance: CSIntelligentHealer;
    private strategies: HealingStrategy[] = [];
    private intelligentAI: CSIntelligentAI;
    private patternMatcher: CSPatternMatcher;
    private featureExtractor: CSFeatureExtractor;
    private healingHistory: Map<string, IntelligentHealingResult[]> = new Map();

    private constructor() {
        this.intelligentAI = CSIntelligentAI.getInstance();
        this.patternMatcher = CSPatternMatcher.getInstance();
        this.featureExtractor = CSFeatureExtractor.getInstance();
        this.initializeStrategies();
        CSReporter.debug('[CSIntelligentHealer] Initialized with healing strategies');
    }

    public static getInstance(): CSIntelligentHealer {
        if (!CSIntelligentHealer.instance) {
            CSIntelligentHealer.instance = new CSIntelligentHealer();
        }
        return CSIntelligentHealer.instance;
    }

    /**
     * Initialize healing strategies
     */
    private initializeStrategies(): void {
        // Strategy 1: Alternative Locators (Highest Priority)
        this.strategies.push({
            name: 'alternative_locators',
            priority: 10,
            apply: async (context: HealingContext): Promise<HealingAttemptResult> => {
                const startTime = Date.now();
                try {
                    CSReporter.debug('[Healer] Trying alternative locators strategy');

                    // Extract features from failed element or description
                    let targetFeatures = context.features;

                    // Try multiple alternative locator strategies
                    const alternatives = [
                        // Try by text content
                        async () => {
                            if (targetFeatures?.text.visibleText) {
                                return `text="${targetFeatures.text.visibleText}"`;
                            }
                            return null;
                        },
                        // Try by ARIA label
                        async () => {
                            if (targetFeatures?.text.ariaLabel) {
                                return `[aria-label="${targetFeatures.text.ariaLabel}"]`;
                            }
                            return null;
                        },
                        // Try by role
                        async () => {
                            if (targetFeatures?.semantic.role) {
                                return `[role="${targetFeatures.semantic.role}"]`;
                            }
                            return null;
                        },
                        // Try by test ID
                        async () => {
                            if (targetFeatures?.structural.attributes['data-testid']) {
                                return `[data-testid="${targetFeatures.structural.attributes['data-testid']}"]`;
                            }
                            return null;
                        }
                    ];

                    for (const altStrategy of alternatives) {
                        const locator = await altStrategy();
                        if (locator) {
                            try {
                                const element = context.page.locator(locator).first();
                                const count = await element.count();
                                if (count > 0) {
                                    return {
                                        success: true,
                                        locator,
                                        confidence: 0.8,
                                        duration: Date.now() - startTime
                                    };
                                }
                            } catch {
                                continue;
                            }
                        }
                    }

                    return {
                        success: false,
                        confidence: 0,
                        duration: Date.now() - startTime
                    };
                } catch (error) {
                    return {
                        success: false,
                        confidence: 0,
                        duration: Date.now() - startTime
                    };
                }
            }
        });

        // Strategy 2: Zero-Step Accessibility Tree Search
        this.strategies.push({
            name: 'zero_step_a11y',
            priority: 9.5,
            apply: async (context: HealingContext): Promise<HealingAttemptResult> => {
                const startTime = Date.now();
                try {
                    CSReporter.debug('[Healer] Trying zero-step accessibility tree strategy');

                    // Lazy load zero-step matcher
                    if (!zeroStepA11yMatcher) {
                        const mod = require('../step-engine/CSAccessibilityTreeMatcher');
                        zeroStepA11yMatcher = mod.CSAccessibilityTreeMatcher.getInstance();
                    }

                    // Extract descriptor from the original locator
                    const descriptor = this.extractDescriptorFromLocator(context.originalLocator);
                    if (!descriptor) {
                        return { success: false, confidence: 0, duration: Date.now() - startTime };
                    }

                    const target = {
                        descriptor,
                        elementType: undefined,
                        ordinal: undefined,
                        position: undefined,
                        relationship: undefined
                    };

                    const match = await zeroStepA11yMatcher.findElement(context.page, target);

                    if (match && match.locator) {
                        // Convert locator to selector string
                        const selector = await this.generateSelector(match.locator);
                        return {
                            success: true,
                            locator: selector,
                            confidence: match.confidence * 0.9,
                            duration: Date.now() - startTime
                        };
                    }

                    return { success: false, confidence: 0, duration: Date.now() - startTime };
                } catch (error) {
                    return { success: false, confidence: 0, duration: Date.now() - startTime };
                }
            }
        });

        // Strategy 2b: Zero-Step Fingerprint Self-Heal
        this.strategies.push({
            name: 'zero_step_fingerprint',
            priority: 9.2,
            apply: async (context: HealingContext): Promise<HealingAttemptResult> => {
                const startTime = Date.now();
                try {
                    CSReporter.debug('[Healer] Trying zero-step fingerprint strategy');

                    // Lazy load fingerprint module
                    if (!zeroStepFingerprint) {
                        const mod = require('../step-engine/CSElementFingerprint');
                        zeroStepFingerprint = mod.CSElementFingerprint.getInstance();
                    }

                    // Try to get cached fingerprint
                    let cachedMod: any;
                    try {
                        cachedMod = require('../step-engine/CSElementCache');
                    } catch {
                        return { success: false, confidence: 0, duration: Date.now() - startTime };
                    }

                    const cache = cachedMod.CSElementCache.getInstance();
                    const pageUrl = await context.page.url();
                    const key = zeroStepFingerprint.generateKey(pageUrl, context.originalLocator);
                    const cached = cache.get(key);

                    if (cached && cached.fingerprint) {
                        const match = await zeroStepFingerprint.selfHeal(context.page, cached.fingerprint);
                        if (match && match.locator) {
                            const selector = await this.generateSelector(match.locator);
                            return {
                                success: true,
                                locator: selector,
                                confidence: match.confidence,
                                duration: Date.now() - startTime
                            };
                        }
                    }

                    return { success: false, confidence: 0, duration: Date.now() - startTime };
                } catch (error) {
                    return { success: false, confidence: 0, duration: Date.now() - startTime };
                }
            }
        });

        // Strategy 3: Scroll Into View
        this.strategies.push({
            name: 'scroll_into_view',
            priority: 9,
            apply: async (context: HealingContext): Promise<HealingAttemptResult> => {
                const startTime = Date.now();
                try {
                    CSReporter.debug('[Healer] Trying scroll into view strategy');

                    const locator = context.page.locator(context.originalLocator);
                    await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
                    await context.page.waitForTimeout(500); // Wait for scroll animation

                    const isVisible = await locator.isVisible();
                    if (isVisible) {
                        return {
                            success: true,
                            locator: context.originalLocator,
                            confidence: 0.85,
                            duration: Date.now() - startTime
                        };
                    }

                    return {
                        success: false,
                        confidence: 0,
                        duration: Date.now() - startTime
                    };
                } catch (error) {
                    return {
                        success: false,
                        confidence: 0,
                        duration: Date.now() - startTime
                    };
                }
            }
        });

        // Strategy 3: Wait for Element
        this.strategies.push({
            name: 'wait_for_visible',
            priority: 8,
            apply: async (context: HealingContext): Promise<HealingAttemptResult> => {
                const startTime = Date.now();
                try {
                    CSReporter.debug('[Healer] Trying wait for visible strategy');

                    const locator = context.page.locator(context.originalLocator);
                    await locator.waitFor({ state: 'visible', timeout: 10000 });

                    return {
                        success: true,
                        locator: context.originalLocator,
                        confidence: 0.75,
                        duration: Date.now() - startTime
                    };
                } catch (error) {
                    return {
                        success: false,
                        confidence: 0,
                        duration: Date.now() - startTime
                    };
                }
            }
        });

        // Strategy 4: Handle Overlays
        this.strategies.push({
            name: 'remove_overlays',
            priority: 7,
            apply: async (context: HealingContext): Promise<HealingAttemptResult> => {
                const startTime = Date.now();
                try {
                    CSReporter.debug('[Healer] Trying remove overlays strategy');

                    // Try to close overlays by pressing ESC and clicking body
                    const attempts = 2;
                    for (let i = 0; i < attempts; i++) {
                        try {
                            // Try clicking outside overlay to close
                            await context.page.click('body', { position: { x: 0, y: 0 }, timeout: 1000 });
                            await context.page.waitForTimeout(300);
                        } catch {
                            // Continue if click fails
                        }

                        // Try ESC key
                        try {
                            await context.page.keyboard.press('Escape');
                            await context.page.waitForTimeout(300);
                        } catch {
                            // Continue if ESC fails
                        }
                    }

                    // Check if original element is now accessible
                    const locator = context.page.locator(context.originalLocator);
                    const isVisible = await locator.isVisible();

                    if (isVisible) {
                        return {
                            success: true,
                            locator: context.originalLocator,
                            confidence: 0.7,
                            duration: Date.now() - startTime
                        };
                    }

                    return {
                        success: false,
                        confidence: 0,
                        duration: Date.now() - startTime
                    };
                } catch (error) {
                    return {
                        success: false,
                        confidence: 0,
                        duration: Date.now() - startTime
                    };
                }
            }
        });

        // Strategy 5: Handle Modals
        this.strategies.push({
            name: 'close_modal',
            priority: 7,
            apply: async (context: HealingContext): Promise<HealingAttemptResult> => {
                const startTime = Date.now();
                try {
                    CSReporter.debug('[Healer] Trying close modal strategy');

                    // Find and click close button using pattern matcher
                    const closeButtons = await this.patternMatcher.findByPattern(context.page, 'close_button');

                    for (const closeBtn of closeButtons) {
                        try {
                            await closeBtn.click({ timeout: 2000 });
                            await context.page.waitForTimeout(500);

                            // Check if modal is closed
                            const modalsAfter = await context.page.locator('[role="dialog"]').count();
                            if (modalsAfter === 0) {
                                return {
                                    success: true,
                                    locator: context.originalLocator,
                                    confidence: 0.8,
                                    duration: Date.now() - startTime
                                };
                            }
                        } catch {
                            continue;
                        }
                    }

                    return {
                        success: false,
                        confidence: 0,
                        duration: Date.now() - startTime
                    };
                } catch (error) {
                    return {
                        success: false,
                        confidence: 0,
                        duration: Date.now() - startTime
                    };
                }
            }
        });

        // Strategy 6: Pattern-Based Healing
        this.strategies.push({
            name: 'pattern_based_search',
            priority: 6,
            apply: async (context: HealingContext): Promise<HealingAttemptResult> => {
                const startTime = Date.now();
                try {
                    CSReporter.debug('[Healer] Trying pattern-based search strategy');

                    // Determine pattern type from features
                    let patternName: string | undefined;

                    if (context.features) {
                        if (context.features.structural.tagName === 'button') {
                            patternName = 'submit_button';
                        } else if (context.features.structural.inputType === 'search') {
                            patternName = 'search_input';
                        } else if (context.features.semantic.role === 'checkbox') {
                            patternName = 'checkbox';
                        }
                    }

                    if (!patternName) {
                        return {
                            success: false,
                            confidence: 0,
                            duration: Date.now() - startTime
                        };
                    }

                    const bestMatch = await this.patternMatcher.getBestMatch(context.page, patternName);

                    if (bestMatch && bestMatch.confidence > 0.6) {
                        // Generate selector for matched element
                        const selector = await this.generateSelector(bestMatch.element);

                        return {
                            success: true,
                            locator: selector,
                            confidence: bestMatch.confidence,
                            duration: Date.now() - startTime
                        };
                    }

                    return {
                        success: false,
                        confidence: 0,
                        duration: Date.now() - startTime
                    };
                } catch (error) {
                    return {
                        success: false,
                        confidence: 0,
                        duration: Date.now() - startTime
                    };
                }
            }
        });

        // Strategy 7: Visual Similarity
        this.strategies.push({
            name: 'visual_similarity',
            priority: 5,
            apply: async (context: HealingContext): Promise<HealingAttemptResult> => {
                const startTime = Date.now();
                try {
                    CSReporter.debug('[Healer] Trying visual similarity strategy');

                    if (!context.features) {
                        return {
                            success: false,
                            confidence: 0,
                            duration: Date.now() - startTime
                        };
                    }

                    // Find all elements of same type
                    const tagName = context.features.structural.tagName;
                    const candidates = await context.page.locator(tagName).elementHandles();

                    let bestMatch: any = null;
                    let bestScore = 0;

                    for (const candidate of candidates) {
                        try {
                            const candidateFeatures = await this.featureExtractor.extractFeatures(candidate, context.page);
                            const score = this.featureExtractor.calculateSimilarity(context.features, candidateFeatures);

                            if (score > bestScore && score > 0.7) {
                                bestScore = score;
                                bestMatch = candidate;
                            }
                        } catch {
                            continue;
                        }
                    }

                    if (bestMatch) {
                        const selector = await this.generateSelector(bestMatch);
                        return {
                            success: true,
                            locator: selector,
                            confidence: bestScore,
                            duration: Date.now() - startTime
                        };
                    }

                    return {
                        success: false,
                        confidence: 0,
                        duration: Date.now() - startTime
                    };
                } catch (error) {
                    return {
                        success: false,
                        confidence: 0,
                        duration: Date.now() - startTime
                    };
                }
            }
        });

        // Strategy 8: Force Click (Last Resort)
        this.strategies.push({
            name: 'force_click',
            priority: 1,
            apply: async (context: HealingContext): Promise<HealingAttemptResult> => {
                const startTime = Date.now();
                try {
                    CSReporter.debug('[Healer] Trying force click strategy');

                    const locator = context.page.locator(context.originalLocator);
                    await locator.click({ force: true, timeout: 5000 });

                    return {
                        success: true,
                        locator: context.originalLocator,
                        confidence: 0.5,
                        duration: Date.now() - startTime
                    };
                } catch (error) {
                    return {
                        success: false,
                        confidence: 0,
                        duration: Date.now() - startTime
                    };
                }
            }
        });

        // Sort strategies by priority (highest first)
        this.strategies.sort((a, b) => b.priority - a.priority);

        CSReporter.debug(`[IntelligentHealer] Initialized ${this.strategies.length} healing strategies`);
    }

    /**
     * Attempt to heal a failed interaction
     */
    public async heal(
        error: Error,
        context: {
            element: any;
            page: Page;
            locator: string;
            step: string;
            url: string;
        }
    ): Promise<IntelligentHealingResult> {
        const startTime = Date.now();
        const attemptedStrategies = new Set<string>();

        try {
            CSReporter.debug(`[IntelligentHealer] Starting healing process for: ${context.step}`);

            // Step 1: Analyze failure
            const analysis: FailureAnalysis = await this.intelligentAI.analyzeFailure(error, context);

            CSReporter.debug(`[IntelligentHealer] Failure analysis: ${analysis.failureType}, Healable: ${analysis.healable}`);

            if (!analysis.healable) {
                return {
                    success: false,
                    strategy: 'none',
                    confidence: 0,
                    originalLocator: context.locator,
                    attempts: 0,
                    duration: Date.now() - startTime,
                    diagnosticContext: analysis.context.diagnostics
                };
            }

            // Step 2: Get healing context
            const healingContext: HealingContext = {
                element: context.element,
                page: context.page,
                originalLocator: context.locator,
                features: context.element?.features,
                diagnostics: analysis.context.diagnostics,
                failureReason: analysis.failureType,
                attemptedStrategies
            };

            // Step 3: Try strategies in order of priority
            const strategiesToTry = this.selectStrategies(analysis);
            let attempts = 0;

            for (const strategy of strategiesToTry) {
                if (attemptedStrategies.has(strategy.name)) {
                    continue;
                }

                attempts++;
                attemptedStrategies.add(strategy.name);

                CSReporter.debug(`[IntelligentHealer] Attempting strategy: ${strategy.name} (Priority: ${strategy.priority})`);

                try {
                    const result = await strategy.apply(healingContext);

                    if (result.success) {
                        const totalDuration = Date.now() - startTime;
                        const healingResult: IntelligentHealingResult = {
                            success: true,
                            strategy: strategy.name,
                            confidence: result.confidence,
                            healedLocator: result.locator,
                            originalLocator: context.locator,
                            attempts,
                            duration: totalDuration,
                            diagnosticContext: analysis.context.diagnostics
                        };

                        // Record in history
                        this.recordHealing(context.locator, healingResult);

                        CSReporter.debug(`[IntelligentHealer] Healing successful with strategy: ${strategy.name}, Confidence: ${result.confidence.toFixed(2)}`);
                        return healingResult;
                    }
                } catch (strategyError) {
                    CSReporter.debug(`[IntelligentHealer] Strategy ${strategy.name} failed: ${strategyError}`);
                    continue;
                }
            }

            // All strategies failed
            const totalDuration = Date.now() - startTime;
            CSReporter.debug(`[IntelligentHealer] All healing strategies exhausted. Attempts: ${attempts}`);

            return {
                success: false,
                strategy: 'all_failed',
                confidence: 0,
                originalLocator: context.locator,
                attempts,
                duration: totalDuration,
                diagnosticContext: analysis.context.diagnostics
            };

        } catch (healingError) {
            CSReporter.debug(`[IntelligentHealer] Healing process error: ${healingError}`);
            return {
                success: false,
                strategy: 'error',
                confidence: 0,
                originalLocator: context.locator,
                attempts: attemptedStrategies.size,
                duration: Date.now() - startTime
            };
        }
    }

    /**
     * Select appropriate strategies based on failure analysis
     */
    private selectStrategies(analysis: FailureAnalysis): HealingStrategy[] {
        const suggestedNames = new Set(analysis.suggestedStrategies);

        // Filter and prioritize strategies based on suggestions
        const selected = this.strategies.filter(strategy => {
            if (suggestedNames.has(strategy.name)) {
                return true;
            }
            // Always include high-priority strategies
            return strategy.priority >= 7;
        });

        return selected;
    }

    /**
     * Extract a human-readable descriptor from a CSS/Playwright locator string.
     */
    private extractDescriptorFromLocator(locator: string): string | null {
        let match = locator.match(/text[=:]?\s*["']([^"']+)["']/i);
        if (match) return match[1];
        match = locator.match(/:has-text\(["']([^"']+)["']\)/i);
        if (match) return match[1];
        match = locator.match(/\[aria-label=["']([^"']+)["']\]/i);
        if (match) return match[1];
        match = locator.match(/\[placeholder=["']([^"']+)["']\]/i);
        if (match) return match[1];
        match = locator.match(/\[title=["']([^"']+)["']\]/i);
        if (match) return match[1];
        match = locator.match(/\[name=["']([^"']+)["']\]/i);
        if (match) return match[1];
        match = locator.match(/^#([\w-]+)$/);
        if (match) return match[1].replace(/[-_]/g, ' ');
        match = locator.match(/^\.([\w-]+)$/);
        if (match) return match[1].replace(/[-_]/g, ' ');
        match = locator.match(/\[data-(?:testid|test-id|cy)=["']([^"']+)["']\]/i);
        if (match) return match[1].replace(/[-_]/g, ' ');
        return null;
    }

    /**
     * Generate selector for element
     */
    private async generateSelector(element: any): Promise<string> {
        try {
            const selector = await element.evaluate((el: any) => {
                if (el.id) return `#${el.id}`;
                if (el.getAttribute('data-testid')) {
                    return `[data-testid="${el.getAttribute('data-testid')}"]`;
                }
                if (el.className) {
                    const classes = el.className.split(' ').filter((c: string) => c.length > 0);
                    if (classes.length > 0) {
                        return `.${classes.join('.')}`;
                    }
                }
                const tag = el.tagName.toLowerCase();
                const name = el.getAttribute('name');
                if (name) return `${tag}[name="${name}"]`;
                return tag;
            });
            return selector;
        } catch {
            return '*';
        }
    }

    /**
     * Record healing result in history
     */
    private recordHealing(locator: string, result: IntelligentHealingResult): void {
        if (!this.healingHistory.has(locator)) {
            this.healingHistory.set(locator, []);
        }
        this.healingHistory.get(locator)!.push(result);

        // Limit history per locator
        const history = this.healingHistory.get(locator)!;
        if (history.length > 10) {
            history.shift();
        }
    }

    /**
     * Get healing history for locator
     */
    public getHealingHistory(locator: string): IntelligentHealingResult[] {
        return this.healingHistory.get(locator) || [];
    }

    /**
     * Get healing statistics
     */
    public getStatistics(): {
        totalHealings: number;
        successRate: number;
        averageConfidence: number;
        averageAttempts: number;
        strategyEffectiveness: Record<string, { attempts: number; successes: number; successRate: number }>;
    } {
        let totalHealings = 0;
        let successfulHealings = 0;
        let totalConfidence = 0;
        let totalAttempts = 0;
        const strategyStats: Record<string, { attempts: number; successes: number }> = {};

        this.healingHistory.forEach(history => {
            history.forEach(result => {
                totalHealings++;
                if (result.success) {
                    successfulHealings++;
                    totalConfidence += result.confidence;
                }
                totalAttempts += result.attempts;

                if (!strategyStats[result.strategy]) {
                    strategyStats[result.strategy] = { attempts: 0, successes: 0 };
                }
                strategyStats[result.strategy].attempts++;
                if (result.success) {
                    strategyStats[result.strategy].successes++;
                }
            });
        });

        const strategyEffectiveness: Record<string, { attempts: number; successes: number; successRate: number }> = {};
        Object.entries(strategyStats).forEach(([strategy, stats]) => {
            strategyEffectiveness[strategy] = {
                ...stats,
                successRate: stats.attempts > 0 ? stats.successes / stats.attempts : 0
            };
        });

        return {
            totalHealings,
            successRate: totalHealings > 0 ? successfulHealings / totalHealings : 0,
            averageConfidence: successfulHealings > 0 ? totalConfidence / successfulHealings : 0,
            averageAttempts: totalHealings > 0 ? totalAttempts / totalHealings : 0,
            strategyEffectiveness
        };
    }

    /**
     * Clear healing history
     */
    public clearHistory(): void {
        this.healingHistory.clear();
        CSReporter.debug('[IntelligentHealer] Healing history cleared');
    }
}
