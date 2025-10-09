/**
 * Pattern Matcher - Recognizes common UI patterns
 * Provides pattern-based element identification for login forms, buttons, navigation, modals, etc.
 */

import { Page, ElementHandle } from 'playwright';
import { CSReporter } from '../../reporter/CSReporter';
import { UIPattern, PatternMatch, ElementFeatures } from '../types/AITypes';
import { CSFeatureExtractor } from '../features/CSFeatureExtractor';
import { CSDOMIntelligence } from '../analysis/CSDOMIntelligence';

export class CSPatternMatcher {
    private static instance: CSPatternMatcher;
    private patterns: Map<string, UIPattern> = new Map();
    private featureExtractor: CSFeatureExtractor;
    private domIntelligence: CSDOMIntelligence;

    private constructor() {
        this.featureExtractor = CSFeatureExtractor.getInstance();
        this.domIntelligence = CSDOMIntelligence.getInstance();
        this.initializePatterns();
        CSReporter.debug('[CSPatternMatcher] Initialized with built-in patterns');
    }

    public static getInstance(): CSPatternMatcher {
        if (!CSPatternMatcher.instance) {
            CSPatternMatcher.instance = new CSPatternMatcher();
        }
        return CSPatternMatcher.instance;
    }

    /**
     * Initialize built-in UI patterns
     */
    private initializePatterns(): void {
        // Login Form Pattern
        this.patterns.set('login_form', {
            name: 'Login Form',
            description: 'Standard login form with username and password fields',
            selectors: [
                'form[name*="login"]',
                'form[id*="login"]',
                'form[class*="login"]',
                '[role="form"][aria-label*="login"]'
            ],
            attributes: {
                type: 'form',
                purpose: 'authentication'
            },
            tags: ['form', 'login', 'authentication'],
            structure: {
                children: ['input[type="text"]', 'input[type="password"]', 'button[type="submit"]']
            },
            confidence: 0.9,
            weight: 1.0
        });

        // Submit Button Pattern
        this.patterns.set('submit_button', {
            name: 'Submit Button',
            description: 'Button that submits a form',
            selectors: [
                'button[type="submit"]',
                'input[type="submit"]',
                'button:has-text("Submit")',
                'button:has-text("Sign In")',
                'button:has-text("Login")'
            ],
            attributes: {
                type: 'button',
                action: 'submit'
            },
            tags: ['button', 'submit', 'action'],
            confidence: 0.85,
            weight: 1.0
        });

        // Search Input Pattern
        this.patterns.set('search_input', {
            name: 'Search Input',
            description: 'Search input field',
            selectors: [
                'input[type="search"]',
                'input[name*="search"]',
                'input[placeholder*="search"]',
                'input[aria-label*="search"]',
                '[role="searchbox"]'
            ],
            attributes: {
                type: 'input',
                purpose: 'search'
            },
            tags: ['input', 'search', 'query'],
            confidence: 0.9,
            weight: 1.0
        });

        // Modal/Dialog Pattern
        this.patterns.set('modal_dialog', {
            name: 'Modal Dialog',
            description: 'Modal dialog or popup overlay',
            selectors: [
                '[role="dialog"]',
                '[role="alertdialog"]',
                '.modal',
                '.dialog',
                '[aria-modal="true"]'
            ],
            attributes: {
                type: 'modal',
                overlay: 'true'
            },
            tags: ['modal', 'dialog', 'popup', 'overlay'],
            confidence: 0.95,
            weight: 1.0
        });

        // Close Button Pattern
        this.patterns.set('close_button', {
            name: 'Close Button',
            description: 'Button to close modal or dismiss dialog',
            selectors: [
                'button[aria-label*="close"]',
                'button:has-text("×")',
                'button:has-text("Close")',
                'button.close',
                '[role="button"][aria-label*="dismiss"]'
            ],
            attributes: {
                type: 'button',
                action: 'close'
            },
            tags: ['button', 'close', 'dismiss'],
            confidence: 0.85,
            weight: 1.0
        });

        // Navigation Menu Pattern
        this.patterns.set('navigation_menu', {
            name: 'Navigation Menu',
            description: 'Main navigation menu',
            selectors: [
                'nav',
                '[role="navigation"]',
                '[role="menubar"]',
                '.navbar',
                '.navigation'
            ],
            attributes: {
                type: 'navigation',
                purpose: 'menu'
            },
            tags: ['nav', 'navigation', 'menu'],
            structure: {
                children: ['a', 'button', '[role="menuitem"]']
            },
            confidence: 0.9,
            weight: 1.0
        });

        // Dropdown Select Pattern
        this.patterns.set('dropdown_select', {
            name: 'Dropdown Select',
            description: 'Dropdown selection element',
            selectors: [
                'select',
                '[role="combobox"]',
                '[role="listbox"]',
                '.dropdown',
                '[aria-haspopup="listbox"]'
            ],
            attributes: {
                type: 'select',
                expandable: 'true'
            },
            tags: ['select', 'dropdown', 'combobox'],
            confidence: 0.9,
            weight: 1.0
        });

        // Checkbox Pattern
        this.patterns.set('checkbox', {
            name: 'Checkbox',
            description: 'Checkbox input element',
            selectors: [
                'input[type="checkbox"]',
                '[role="checkbox"]'
            ],
            attributes: {
                type: 'checkbox',
                checkable: 'true'
            },
            tags: ['checkbox', 'input', 'toggle'],
            confidence: 0.95,
            weight: 1.0
        });

        // Radio Button Pattern
        this.patterns.set('radio_button', {
            name: 'Radio Button',
            description: 'Radio button input element',
            selectors: [
                'input[type="radio"]',
                '[role="radio"]'
            ],
            attributes: {
                type: 'radio',
                selectable: 'true'
            },
            tags: ['radio', 'input', 'choice'],
            confidence: 0.95,
            weight: 1.0
        });

        // Primary Action Button Pattern
        this.patterns.set('primary_button', {
            name: 'Primary Action Button',
            description: 'Primary call-to-action button (usually highlighted)',
            selectors: [
                'button.btn-primary',
                'button.primary',
                'button[class*="primary"]',
                '[role="button"][class*="primary"]'
            ],
            attributes: {
                type: 'button',
                importance: 'primary'
            },
            tags: ['button', 'primary', 'cta'],
            confidence: 0.8,
            weight: 1.0
        });

        // Data Table Pattern
        this.patterns.set('data_table', {
            name: 'Data Table',
            description: 'Table displaying structured data',
            selectors: [
                'table',
                '[role="table"]',
                '[role="grid"]',
                '.table',
                '.data-table'
            ],
            attributes: {
                type: 'table',
                structured: 'true'
            },
            tags: ['table', 'grid', 'data'],
            structure: {
                children: ['thead', 'tbody', 'tr', 'td', 'th']
            },
            confidence: 0.95,
            weight: 1.0
        });

        // Error Message Pattern
        this.patterns.set('error_message', {
            name: 'Error Message',
            description: 'Error or validation message',
            selectors: [
                '[role="alert"]',
                '.error',
                '.error-message',
                '[class*="error"]',
                '[aria-invalid="true"] + *'
            ],
            attributes: {
                type: 'message',
                severity: 'error'
            },
            tags: ['error', 'alert', 'message'],
            confidence: 0.85,
            weight: 1.0
        });

        // Loading Indicator Pattern
        this.patterns.set('loading_indicator', {
            name: 'Loading Indicator',
            description: 'Loading spinner or progress indicator',
            selectors: [
                '[role="progressbar"]',
                '[role="status"]',
                '.loading',
                '.spinner',
                '[class*="loading"]',
                '[class*="spinner"]'
            ],
            attributes: {
                type: 'indicator',
                state: 'loading'
            },
            tags: ['loading', 'spinner', 'progress'],
            confidence: 0.8,
            weight: 1.0
        });

        // Breadcrumb Navigation Pattern
        this.patterns.set('breadcrumb', {
            name: 'Breadcrumb Navigation',
            description: 'Breadcrumb navigation trail',
            selectors: [
                '[role="breadcrumb"]',
                'nav[aria-label*="breadcrumb"]',
                '.breadcrumb',
                'ol.breadcrumb'
            ],
            attributes: {
                type: 'navigation',
                purpose: 'breadcrumb'
            },
            tags: ['breadcrumb', 'navigation', 'trail'],
            confidence: 0.9,
            weight: 1.0
        });

        // Tooltip Pattern
        this.patterns.set('tooltip', {
            name: 'Tooltip',
            description: 'Tooltip or hover hint',
            selectors: [
                '[role="tooltip"]',
                '.tooltip',
                '[class*="tooltip"]'
            ],
            attributes: {
                type: 'hint',
                contextual: 'true'
            },
            tags: ['tooltip', 'hint', 'help'],
            confidence: 0.85,
            weight: 1.0
        });

        CSReporter.debug(`[PatternMatcher] Initialized ${this.patterns.size} built-in patterns`);
    }

    /**
     * Match elements against all patterns
     */
    public async matchPatterns(page: Page, patternName?: string): Promise<PatternMatch[]> {
        const startTime = Date.now();
        const matches: PatternMatch[] = [];

        try {
            const patternsToMatch = patternName && this.patterns.has(patternName)
                ? [this.patterns.get(patternName)!]
                : Array.from(this.patterns.values());

            CSReporter.debug(`[PatternMatcher] Matching ${patternsToMatch.length} patterns`);

            for (const pattern of patternsToMatch) {
                const patternMatches = await this.matchPattern(page, pattern);
                matches.push(...patternMatches);
            }

            const duration = Date.now() - startTime;
            CSReporter.debug(`[PatternMatcher] Found ${matches.length} pattern matches in ${duration}ms`);

            return matches;

        } catch (error) {
            CSReporter.debug(`[PatternMatcher] Error matching patterns: ${error}`);
            return matches;
        }
    }

    /**
     * Match a single pattern
     */
    private async matchPattern(page: Page, pattern: UIPattern): Promise<PatternMatch[]> {
        const matches: PatternMatch[] = [];

        try {
            for (const selector of pattern.selectors) {
                try {
                    const elements = await page.locator(selector).elementHandles();

                    for (const element of elements) {
                        const features = await this.featureExtractor.extractFeatures(element, page);
                        const matchedAttributes = this.checkAttributeMatch(features, pattern);
                        const confidence = this.calculatePatternConfidence(features, pattern, matchedAttributes);

                        if (confidence >= 0.5) { // Minimum threshold
                            matches.push({
                                pattern,
                                confidence,
                                element,
                                matchedAttributes
                            });
                        }
                    }
                } catch (selectorError) {
                    // Continue with next selector
                }
            }
        } catch (error) {
            CSReporter.debug(`[PatternMatcher] Error matching pattern ${pattern.name}: ${error}`);
        }

        return matches;
    }

    /**
     * Check if element matches pattern attributes
     */
    private checkAttributeMatch(features: ElementFeatures, pattern: UIPattern): string[] {
        const matched: string[] = [];

        // Check tag name
        if (pattern.attributes.type) {
            const expectedTag = pattern.attributes.type;
            if (features.structural.tagName === expectedTag ||
                features.semantic.role === expectedTag) {
                matched.push('type');
            }
        }

        // Check role
        if (features.semantic.role) {
            const roleInTags = pattern.tags.includes(features.semantic.role);
            if (roleInTags) {
                matched.push('role');
            }
        }

        // Check interactivity
        if (pattern.attributes.action || pattern.attributes.purpose) {
            if (features.structural.isInteractive) {
                matched.push('interactive');
            }
        }

        // Check form element
        if (pattern.attributes.type === 'form' || pattern.attributes.type === 'input') {
            if (features.structural.formElement) {
                matched.push('form_element');
            }
        }

        return matched;
    }

    /**
     * Calculate pattern match confidence
     */
    private calculatePatternConfidence(
        features: ElementFeatures,
        pattern: UIPattern,
        matchedAttributes: string[]
    ): number {
        let score = 0;

        // Base pattern confidence (40%)
        score += pattern.confidence * 0.4;

        // Attribute matches (30%)
        if (matchedAttributes.length > 0) {
            const attributeScore = Math.min(matchedAttributes.length / 3, 1);
            score += attributeScore * 0.3;
        }

        // Tag match (15%)
        const tagMatch = pattern.tags.some(tag =>
            features.structural.tagName === tag ||
            features.semantic.role === tag ||
            features.structural.classList.some(c => c.includes(tag))
        );
        if (tagMatch) {
            score += 0.15;
        }

        // Visibility (10%)
        if (features.visual.isVisible) {
            score += 0.1;
        }

        // Semantic correctness (5%)
        if (features.semantic.role && pattern.attributes.type === features.semantic.role) {
            score += 0.05;
        }

        return Math.min(score * pattern.weight, 1.0);
    }

    /**
     * Find elements by pattern name
     */
    public async findByPattern(page: Page, patternName: string): Promise<ElementHandle[]> {
        const pattern = this.patterns.get(patternName);

        if (!pattern) {
            CSReporter.debug(`[PatternMatcher] Pattern not found: ${patternName}`);
            return [];
        }

        const matches = await this.matchPattern(page, pattern);
        const elements = matches
            .sort((a, b) => b.confidence - a.confidence)
            .map(m => m.element);

        CSReporter.debug(`[PatternMatcher] Found ${elements.length} elements for pattern: ${patternName}`);
        return elements;
    }

    /**
     * Get best match for pattern
     */
    public async getBestMatch(page: Page, patternName: string): Promise<PatternMatch | null> {
        const pattern = this.patterns.get(patternName);

        if (!pattern) {
            CSReporter.debug(`[PatternMatcher] Pattern not found: ${patternName}`);
            return null;
        }

        const matches = await this.matchPattern(page, pattern);

        if (matches.length === 0) {
            return null;
        }

        // Sort by confidence and return best
        matches.sort((a, b) => b.confidence - a.confidence);
        return matches[0];
    }

    /**
     * Register custom pattern
     */
    public registerPattern(pattern: UIPattern): void {
        const key = pattern.name.toLowerCase().replace(/\s+/g, '_');
        this.patterns.set(key, pattern);
        CSReporter.debug(`[PatternMatcher] Registered custom pattern: ${pattern.name}`);
    }

    /**
     * Remove pattern
     */
    public removePattern(patternName: string): boolean {
        const deleted = this.patterns.delete(patternName);
        if (deleted) {
            CSReporter.debug(`[PatternMatcher] Removed pattern: ${patternName}`);
        }
        return deleted;
    }

    /**
     * Get all pattern names
     */
    public getPatternNames(): string[] {
        return Array.from(this.patterns.keys());
    }

    /**
     * Get pattern by name
     */
    public getPattern(name: string): UIPattern | undefined {
        return this.patterns.get(name);
    }

    /**
     * Detect patterns on current page
     */
    public async detectPatterns(page: Page): Promise<Map<string, number>> {
        const detected = new Map<string, number>();

        try {
            const allMatches = await this.matchPatterns(page);

            // Group by pattern name
            allMatches.forEach(match => {
                const name = match.pattern.name;
                detected.set(name, (detected.get(name) || 0) + 1);
            });

            CSReporter.debug(`[PatternMatcher] Detected ${detected.size} different patterns on page`);
            return detected;

        } catch (error) {
            CSReporter.debug(`[PatternMatcher] Error detecting patterns: ${error}`);
            return detected;
        }
    }

    /**
     * Check if page contains pattern
     */
    public async hasPattern(page: Page, patternName: string): Promise<boolean> {
        const elements = await this.findByPattern(page, patternName);
        return elements.length > 0;
    }

    /**
     * Get pattern statistics
     */
    public getStatistics(): {
        totalPatterns: number;
        patternsByCategory: Record<string, number>;
        averageConfidence: number;
    } {
        const patterns = Array.from(this.patterns.values());
        const patternsByCategory: Record<string, number> = {};

        patterns.forEach(pattern => {
            const category = pattern.tags[0] || 'other';
            patternsByCategory[category] = (patternsByCategory[category] || 0) + 1;
        });

        const averageConfidence = patterns.reduce((sum, p) => sum + p.confidence, 0) / patterns.length;

        return {
            totalPatterns: patterns.length,
            patternsByCategory,
            averageConfidence
        };
    }
}
