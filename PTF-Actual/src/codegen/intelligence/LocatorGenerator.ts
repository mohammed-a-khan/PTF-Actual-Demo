/**
 * LocatorGenerator - Multi-Locator Generation with Stability Scoring
 *
 * Generates multiple locator strategies for each element with stability scores.
 * Provides primary + alternative locators for maximum self-healing capability.
 */

import { Action, LocatorInfo } from '../types';

export interface GeneratedLocators {
    primary: LocatorStrategy;
    alternatives: LocatorStrategy[];
    stabilityScore: number; // 0-100
}

export interface LocatorStrategy {
    type: 'xpath' | 'css' | 'testId' | 'text' | 'role' | 'placeholder' | 'label';
    value: string;
    stability: number; // 0-100
    description: string;
}

export class LocatorGenerator {
    // Stability scores for different locator types
    private static readonly STABILITY_SCORES: Record<string, number> = {
        'testId': 100,      // data-testid - most stable, explicitly for testing
        'id': 95,           // ID - usually stable
        'role+name': 90,    // Role with accessible name - semantic, stable
        'placeholder': 85,  // Placeholder text - fairly stable
        'label': 85,        // Label text - fairly stable
        'aria-label': 85,   // Aria label - semantic, stable
        'name': 80,         // Name attribute - fairly stable
        'text-exact': 75,   // Exact text match - can change with i18n
        'text-contains': 70, // Contains text - more flexible
        'css-class': 50,    // CSS class - can change with styling
        'css-attribute': 60, // CSS with attribute - fairly stable
        'xpath-text': 65,   // XPath with text - flexible
        'xpath-index': 20,  // XPath with index - very fragile
        'css-nth': 25,      // CSS nth-child - fragile
    };

    /**
     * Generate multiple locator strategies for an action
     */
    public static generate(action: Action): GeneratedLocators {
        const strategies: LocatorStrategy[] = [];

        // Extract info from action
        const target = action.target;
        if (!target) {
            return {
                primary: { type: 'xpath', value: '//*', stability: 0, description: 'No target' },
                alternatives: [],
                stabilityScore: 0,
            };
        }

        // Generate all possible locators based on available info
        const generatedStrategies = this.generateAllStrategies(action);
        strategies.push(...generatedStrategies);

        // Sort by stability (highest first)
        strategies.sort((a, b) => b.stability - a.stability);

        // Remove duplicates (same type and value)
        const unique = this.deduplicateStrategies(strategies);

        if (unique.length === 0) {
            return {
                primary: { type: 'xpath', value: '//*', stability: 0, description: 'No locator found' },
                alternatives: [],
                stabilityScore: 0,
            };
        }

        const primary = unique[0];
        const alternatives = unique.slice(1, 5); // Max 4 alternatives

        return {
            primary,
            alternatives,
            stabilityScore: primary.stability,
        };
    }

    /**
     * Generate all possible locator strategies
     */
    private static generateAllStrategies(action: Action): LocatorStrategy[] {
        const strategies: LocatorStrategy[] = [];
        const target = action.target!;

        // From getByRole with name
        if (target.type === 'getByRole' && target.options?.name) {
            strategies.push({
                type: 'role',
                value: `${target.selector}:${target.options.name}`,
                stability: this.STABILITY_SCORES['role+name'],
                description: `Role "${target.selector}" with name "${target.options.name}"`,
            });

            // XPath version
            strategies.push({
                type: 'xpath',
                value: `//*[@role="${target.selector}" and @aria-label="${this.escapeXPath(target.options.name)}"]`,
                stability: this.STABILITY_SCORES['role+name'] - 5,
                description: `XPath role+aria-label`,
            });

            // XPath with contains for flexibility
            strategies.push({
                type: 'xpath',
                value: `//*[@role="${target.selector}"][contains(., "${this.escapeXPath(target.options.name)}")]`,
                stability: this.STABILITY_SCORES['xpath-text'],
                description: `XPath role with text contains`,
            });
        }

        // From getByRole without name
        if (target.type === 'getByRole' && !target.options?.name) {
            strategies.push({
                type: 'css',
                value: `[role="${target.selector}"]`,
                stability: this.STABILITY_SCORES['css-attribute'],
                description: `CSS role attribute`,
            });
        }

        // From getByPlaceholder
        if (target.type === 'getByPlaceholder') {
            strategies.push({
                type: 'placeholder',
                value: target.selector,
                stability: this.STABILITY_SCORES['placeholder'],
                description: `Placeholder text "${target.selector}"`,
            });

            // CSS version
            strategies.push({
                type: 'css',
                value: `[placeholder="${this.escapeCSS(target.selector)}"]`,
                stability: this.STABILITY_SCORES['placeholder'] - 5,
                description: `CSS placeholder attribute`,
            });

            // XPath version
            strategies.push({
                type: 'xpath',
                value: `//*[@placeholder="${this.escapeXPath(target.selector)}"]`,
                stability: this.STABILITY_SCORES['placeholder'] - 10,
                description: `XPath placeholder attribute`,
            });
        }

        // From getByText
        if (target.type === 'getByText') {
            strategies.push({
                type: 'text',
                value: target.selector,
                stability: this.STABILITY_SCORES['text-exact'],
                description: `Text "${target.selector}"`,
            });

            // XPath exact
            strategies.push({
                type: 'xpath',
                value: `//*[text()="${this.escapeXPath(target.selector)}"]`,
                stability: this.STABILITY_SCORES['text-exact'] - 5,
                description: `XPath exact text`,
            });

            // XPath contains
            strategies.push({
                type: 'xpath',
                value: `//*[contains(text(), "${this.escapeXPath(target.selector)}")]`,
                stability: this.STABILITY_SCORES['text-contains'],
                description: `XPath contains text`,
            });
        }

        // From getByLabel
        if (target.type === 'getByLabel') {
            strategies.push({
                type: 'label',
                value: target.selector,
                stability: this.STABILITY_SCORES['label'],
                description: `Label "${target.selector}"`,
            });

            // XPath for label
            strategies.push({
                type: 'xpath',
                value: `//label[contains(., "${this.escapeXPath(target.selector)}")]/following::input[1]`,
                stability: this.STABILITY_SCORES['label'] - 10,
                description: `XPath label to input`,
            });
        }

        // From getByTestId
        if (target.type === 'getByTestId') {
            strategies.push({
                type: 'testId',
                value: target.selector,
                stability: this.STABILITY_SCORES['testId'],
                description: `Test ID "${target.selector}"`,
            });

            // CSS version
            strategies.push({
                type: 'css',
                value: `[data-testid="${target.selector}"]`,
                stability: this.STABILITY_SCORES['testId'] - 5,
                description: `CSS data-testid`,
            });
        }

        // From raw locator (CSS/XPath)
        if (target.type === 'locator') {
            const selector = target.selector;

            // Add the original selector
            const isXPath = selector.startsWith('/') || selector.startsWith('(');
            strategies.push({
                type: isXPath ? 'xpath' : 'css',
                value: selector,
                stability: this.calculateSelectorStability(selector),
                description: `Original ${isXPath ? 'XPath' : 'CSS'} selector`,
            });

            // Try to generate alternatives from CSS
            if (!isXPath) {
                const alternativeStrategies = this.generateAlternativesFromCSS(selector);
                strategies.push(...alternativeStrategies);
            }
        }

        return strategies;
    }

    /**
     * Calculate stability score for a selector
     */
    private static calculateSelectorStability(selector: string): number {
        let score = 50; // Base score

        // Positive factors
        if (selector.includes('[data-testid=')) score = Math.max(score, 95);
        if (selector.includes('#') && !selector.includes(' ')) score = Math.max(score, 90); // ID only
        if (selector.includes('[aria-label=')) score = Math.max(score, 85);
        if (selector.includes('[name=')) score = Math.max(score, 80);
        if (selector.includes('[placeholder=')) score = Math.max(score, 80);
        if (selector.includes('[role=')) score = Math.max(score, 75);

        // Negative factors
        if (selector.includes(':nth-child') || selector.includes(':nth-of-type')) score -= 30;
        if (selector.match(/\[\d+\]/)) score -= 25; // XPath index like [1]
        if (selector.split(' ').length > 3) score -= 10; // Long chain
        if (selector.includes('.css-') || selector.includes('.oxd-')) score -= 15; // Framework classes

        return Math.max(0, Math.min(100, score));
    }

    /**
     * Generate alternative locators from CSS selector
     */
    private static generateAlternativesFromCSS(css: string): LocatorStrategy[] {
        const alternatives: LocatorStrategy[] = [];

        // Extract ID
        const idMatch = css.match(/#([a-zA-Z][\w-]*)/);
        if (idMatch) {
            alternatives.push({
                type: 'css',
                value: `#${idMatch[1]}`,
                stability: this.STABILITY_SCORES['id'],
                description: `ID selector`,
            });
            alternatives.push({
                type: 'xpath',
                value: `//*[@id="${idMatch[1]}"]`,
                stability: this.STABILITY_SCORES['id'] - 5,
                description: `XPath ID`,
            });
        }

        // Extract aria-label
        const ariaMatch = css.match(/\[aria-label=["']([^"']+)["']\]/);
        if (ariaMatch) {
            alternatives.push({
                type: 'xpath',
                value: `//*[@aria-label="${this.escapeXPath(ariaMatch[1])}"]`,
                stability: this.STABILITY_SCORES['aria-label'],
                description: `XPath aria-label`,
            });
        }

        // Extract name attribute
        const nameMatch = css.match(/\[name=["']([^"']+)["']\]/);
        if (nameMatch) {
            alternatives.push({
                type: 'css',
                value: `[name="${nameMatch[1]}"]`,
                stability: this.STABILITY_SCORES['name'],
                description: `CSS name attribute`,
            });
        }

        return alternatives;
    }

    /**
     * Deduplicate locator strategies
     */
    private static deduplicateStrategies(strategies: LocatorStrategy[]): LocatorStrategy[] {
        const seen = new Set<string>();
        const unique: LocatorStrategy[] = [];

        for (const strategy of strategies) {
            const key = `${strategy.type}:${strategy.value}`;
            if (!seen.has(key)) {
                seen.add(key);
                unique.push(strategy);
            }
        }

        return unique;
    }

    /**
     * Escape string for XPath
     */
    private static escapeXPath(str: string): string {
        if (!str.includes("'")) {
            return str;
        }
        if (!str.includes('"')) {
            return str;
        }
        // Contains both - use concat
        return str.replace(/'/g, "\\'");
    }

    /**
     * Escape string for CSS attribute selector
     */
    private static escapeCSS(str: string): string {
        return str.replace(/"/g, '\\"');
    }

    /**
     * Format locator for CSGetElement decorator
     */
    public static formatForDecorator(locators: GeneratedLocators): {
        primary: { type: string; value: string };
        alternatives: string[];
    } {
        const primary = locators.primary;
        let primaryType = 'css';
        let primaryValue = primary.value;

        // Determine decorator property type
        if (primary.type === 'xpath' || primary.value.startsWith('/')) {
            primaryType = 'xpath';
        } else if (primary.type === 'testId') {
            primaryType = 'testId';
            primaryValue = primary.value;
        } else if (primary.type === 'role') {
            // Role with name needs special handling
            primaryType = 'xpath';
            const [role, name] = primary.value.split(':');
            primaryValue = `//*[@role="${role}"][@aria-label="${name}" or contains(., "${name}")]`;
        } else if (primary.type === 'text') {
            // Text locators must be converted to XPath (NOT valid as CSS!)
            primaryType = 'xpath';
            primaryValue = `//*[text()="${this.escapeXPath(primary.value)}" or contains(text(), "${this.escapeXPath(primary.value)}")]`;
        } else if (primary.type === 'css') {
            // Validate CSS selector - if it looks like plain text, convert to XPath
            if (this.isLikelyTextNotCSS(primary.value)) {
                primaryType = 'xpath';
                primaryValue = `//*[text()="${this.escapeXPath(primary.value)}" or contains(text(), "${this.escapeXPath(primary.value)}")]`;
            }
        }

        // Format alternatives with prefix
        const alternatives = locators.alternatives.map(alt => {
            if (alt.type === 'xpath' || alt.value.startsWith('/')) {
                return `xpath:${alt.value}`;
            } else if (alt.type === 'text') {
                // Text alternatives should be XPath too
                return `xpath://*[text()="${this.escapeXPath(alt.value)}"]`;
            } else if (alt.type === 'testId') {
                return `testId:${alt.value}`;
            } else {
                return `css:${alt.value}`;
            }
        });

        return {
            primary: { type: primaryType, value: primaryValue },
            alternatives,
        };
    }

    /**
     * Check if a value looks like plain text rather than a valid CSS selector
     * This catches cases where text is incorrectly marked as CSS
     */
    private static isLikelyTextNotCSS(value: string): boolean {
        // If it contains ANY CSS special characters, it's likely a CSS selector
        // CSS special chars: . # [ ] > + ~ : ( ) * = ^ $ |
        if (value.match(/[.#\[\]>+~:()*=^$|]/)) {
            return false; // Definitely CSS, not text
        }

        // If it contains spaces but no CSS syntax, it's likely text
        // e.g., "No Records Found" or "Click here"
        if (value.includes(' ')) {
            return true;
        }

        // If it starts with capital letter and contains lowercase (sentence-like)
        // e.g., "Disabled", "Enabled", "Info"
        if (value.match(/^[A-Z][a-z]+$/)) {
            return true;
        }

        // If it's a simple capitalized phrase
        if (value.match(/^[A-Z][A-Za-z0-9]*$/)) {
            return true;
        }

        return false;
    }
}

export default LocatorGenerator;
