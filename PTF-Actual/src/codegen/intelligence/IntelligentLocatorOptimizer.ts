/**
 * Intelligent Locator Optimizer
 *
 * This component ensures users never have to worry about locator quality.
 * It automatically:
 * - Analyzes locator stability
 * - Suggests optimal locator strategies
 * - Transforms brittle locators to stable ones
 * - Generates self-healing locators
 * - Provides fallback strategies
 */

import {
    Action,
    LocatorInfo,
    CSCapability
} from '../types';

export interface LocatorAnalysis {
    original: string;
    stability: 'excellent' | 'good' | 'fair' | 'poor';
    stabilityScore: number;
    issues: LocatorIssue[];
    suggestions: LocatorSuggestion[];
    optimized: string;
    fallbacks: string[];
    reasoning: string[];
}

export interface LocatorIssue {
    type: 'brittleness' | 'specificity' | 'performance' | 'maintainability';
    severity: 'low' | 'medium' | 'high';
    description: string;
    impact: string;
}

export interface LocatorSuggestion {
    strategy: 'role' | 'label' | 'placeholder' | 'testid' | 'text' | 'css' | 'composite';
    locator: string;
    score: number;
    benefits: string[];
    tradeoffs: string[];
}

export class IntelligentLocatorOptimizer {
    /**
     * Optimize a locator to ensure maximum stability and maintainability
     */
    public optimizeLocator(action: Action): LocatorAnalysis {
        const original = this.buildOriginalLocator(action);

        // Analyze stability
        const stability = this.analyzeStability(action);

        // Find issues
        const issues = this.findIssues(action);

        // Generate suggestions
        const suggestions = this.generateSuggestions(action);

        // Select best locator
        const optimized = this.selectOptimalLocator(suggestions, action);

        // Generate fallbacks
        const fallbacks = this.generateFallbacks(action, optimized);

        // Explain reasoning
        const reasoning = this.explainOptimization(original, optimized, suggestions);

        return {
            original,
            stability: this.getStabilityLevel(stability),
            stabilityScore: stability,
            issues,
            suggestions,
            optimized,
            fallbacks,
            reasoning
        };
    }

    /**
     * Build original locator string from action
     */
    private buildOriginalLocator(action: Action): string {
        if (!action.target) return '';

        const { type, selector, options } = action.target;

        if (type === 'getByRole') {
            if (options?.name) {
                return `role=${selector}[name="${options.name}"]`;
            }
            return `role=${selector}`;
        }

        if (type === 'getByPlaceholder') {
            return `[placeholder="${selector}"]`;
        }

        if (type === 'getByLabel') {
            return `[label="${selector}"]`;
        }

        if (type === 'getByText') {
            return `text=${selector}`;
        }

        if (type === 'getByTestId') {
            return `[data-testid="${selector}"]`;
        }

        return selector;
    }

    /**
     * Analyze locator stability (0-1 score)
     */
    private analyzeStability(action: Action): number {
        if (!action.target) return 0;

        let score = 0.5; // Base score

        const { type, selector } = action.target;

        // Semantic locators are most stable
        if (type === 'getByRole') {
            score += 0.4; // Excellent: based on accessibility tree
        } else if (type === 'getByLabel' || type === 'getByPlaceholder') {
            score += 0.35; // Excellent: based on form semantics
        } else if (type === 'getByTestId') {
            score += 0.3; // Good: dedicated test attribute
        } else if (type === 'getByText') {
            score += 0.2; // Fair: depends on content stability
        } else if (type === 'locator') {
            // Analyze CSS selector
            if (selector.startsWith('#')) {
                score -= 0.2; // IDs can be fragile
            } else if (selector.includes('[data-')) {
                score += 0.25; // Data attributes are good
            } else if (selector.split(' ').length > 3) {
                score -= 0.15; // Deep selectors are brittle
            }
        }

        // Check for dynamic patterns
        if (/\d{5,}|uuid|guid|temp|generated/i.test(selector)) {
            score -= 0.3; // Generated IDs are very brittle
        }

        // Check if selector is too specific
        if (selector.includes('>') || selector.split('.').length > 4) {
            score -= 0.1; // Over-specification is brittle
        }

        return Math.max(0, Math.min(1, score));
    }

    /**
     * Find issues with the current locator
     */
    private findIssues(action: Action): LocatorIssue[] {
        const issues: LocatorIssue[] = [];

        if (!action.target) return issues;

        const { type, selector } = action.target;

        // Check for brittle patterns
        if (/\d{5,}|uuid|guid|temp|generated/i.test(selector)) {
            issues.push({
                type: 'brittleness',
                severity: 'high',
                description: 'Locator contains generated/dynamic ID',
                impact: 'Test will break when IDs change'
            });
        }

        // Check for XPath
        if (selector.startsWith('/') || selector.startsWith('./')) {
            issues.push({
                type: 'brittleness',
                severity: 'high',
                description: 'XPath locators are fragile',
                impact: 'Breaks easily with DOM changes'
            });
        }

        // Check for overly specific selectors
        if (selector.split('>').length > 3 || selector.split(' ').length > 4) {
            issues.push({
                type: 'brittleness',
                severity: 'medium',
                description: 'Overly specific selector',
                impact: 'Small DOM changes will break this'
            });
        }

        // Check for performance issues
        if (selector.includes('*') || selector.match(/\.\w+/g)?.length || 0 > 5) {
            issues.push({
                type: 'performance',
                severity: 'medium',
                description: 'Inefficient selector',
                impact: 'Slower element lookup'
            });
        }

        // Check for maintainability issues
        if (selector.length > 80) {
            issues.push({
                type: 'maintainability',
                severity: 'low',
                description: 'Locator is too long',
                impact: 'Harder to read and maintain'
            });
        }

        return issues;
    }

    /**
     * Generate alternative locator suggestions
     */
    private generateSuggestions(action: Action): LocatorSuggestion[] {
        const suggestions: LocatorSuggestion[] = [];

        if (!action.target) return suggestions;

        const expr = action.expression;
        const { type, selector, options } = action.target;

        // Try role-based locator
        if (type !== 'getByRole') {
            const role = this.inferRole(action);
            if (role) {
                const roleName = options?.name || this.extractName(expr);
                const roleLocator = roleName ? `role=${role}[name="${roleName}"]` : `role=${role}`;

                suggestions.push({
                    strategy: 'role',
                    locator: roleLocator,
                    score: 0.95,
                    benefits: [
                        'Based on accessibility tree',
                        'Stable across refactoring',
                        'Improves accessibility',
                        'Recommended by testing-library'
                    ],
                    tradeoffs: ['Requires proper ARIA roles']
                });
            }
        }

        // Try label-based locator
        if (type !== 'getByLabel' && this.isFormField(action)) {
            const label = this.inferLabel(expr);
            if (label) {
                suggestions.push({
                    strategy: 'label',
                    locator: `[label="${label}"]`,
                    score: 0.90,
                    benefits: [
                        'Semantic and stable',
                        'Tied to visible label',
                        'Good for forms'
                    ],
                    tradeoffs: ['Requires associated label']
                });
            }
        }

        // Try placeholder-based locator
        if (type !== 'getByPlaceholder' && this.isFormField(action)) {
            const placeholder = this.extractPlaceholder(expr);
            if (placeholder) {
                suggestions.push({
                    strategy: 'placeholder',
                    locator: `[placeholder="${placeholder}"]`,
                    score: 0.85,
                    benefits: [
                        'Stable for input fields',
                        'Visible to users',
                        'Common pattern'
                    ],
                    tradeoffs: ['Only works for inputs', 'Placeholders may change']
                });
            }
        }

        // Try test-id locator
        suggestions.push({
            strategy: 'testid',
            locator: `[data-testid="${this.generateTestId(action)}"]`,
            score: 0.80,
            benefits: [
                'Dedicated test attribute',
                'Stable and explicit',
                'Independent of content'
            ],
            tradeoffs: ['Requires adding data-testid to DOM', 'Not semantic']
        });

        // Try text-based locator
        if (type !== 'getByText') {
            const text = this.extractText(expr);
            if (text && text.length < 50) {
                suggestions.push({
                    strategy: 'text',
                    locator: `text=${text}`,
                    score: 0.70,
                    benefits: [
                        'Simple and readable',
                        'No DOM knowledge needed',
                        'Matches user perception'
                    ],
                    tradeoffs: ['Breaks when text changes', 'Issues with i18n']
                });
            }
        }

        // CSS selector with data attributes
        const dataAttrLocator = this.generateDataAttributeLocator(action);
        if (dataAttrLocator && dataAttrLocator !== selector) {
            suggestions.push({
                strategy: 'css',
                locator: dataAttrLocator,
                score: 0.75,
                benefits: [
                    'Stable data attributes',
                    'Good performance',
                    'Flexible'
                ],
                tradeoffs: ['Requires proper data attributes']
            });
        }

        // Composite strategy (multiple fallbacks)
        const composite = this.generateCompositeLocator(action);
        if (composite) {
            suggestions.push({
                strategy: 'composite',
                locator: composite,
                score: 0.88,
                benefits: [
                    'Multiple fallback strategies',
                    'Self-healing capability',
                    'Maximum stability'
                ],
                tradeoffs: ['More complex', 'Requires framework support']
            });
        }

        return suggestions.sort((a, b) => b.score - a.score);
    }

    /**
     * Select the optimal locator from suggestions
     */
    private selectOptimalLocator(suggestions: LocatorSuggestion[], action: Action): string {
        if (suggestions.length === 0) {
            return this.buildOriginalLocator(action);
        }

        // Prefer role-based locators for accessibility
        const roleStrategy = suggestions.find(s => s.strategy === 'role');
        if (roleStrategy && roleStrategy.score >= 0.9) {
            return roleStrategy.locator;
        }

        // Use the highest scoring suggestion
        return suggestions[0].locator;
    }

    /**
     * Generate fallback locators for self-healing
     */
    private generateFallbacks(action: Action, primary: string): string[] {
        const fallbacks: string[] = [];

        if (!action.target) return fallbacks;

        // Add original as fallback if different
        const original = this.buildOriginalLocator(action);
        if (original !== primary) {
            fallbacks.push(original);
        }

        // Add role-based fallback
        const role = this.inferRole(action);
        if (role) {
            const roleLocator = `role=${role}`;
            if (roleLocator !== primary && !fallbacks.includes(roleLocator)) {
                fallbacks.push(roleLocator);
            }
        }

        // Add text-based fallback
        const text = this.extractText(action.expression);
        if (text) {
            const textLocator = `text=${text}`;
            if (textLocator !== primary && !fallbacks.includes(textLocator)) {
                fallbacks.push(textLocator);
            }
        }

        // Add CSS fallback
        const cssLocator = this.generateSimpleCSS(action);
        if (cssLocator && cssLocator !== primary && !fallbacks.includes(cssLocator)) {
            fallbacks.push(cssLocator);
        }

        return fallbacks.slice(0, 3); // Max 3 fallbacks
    }

    /**
     * Explain why a locator was optimized
     */
    private explainOptimization(original: string, optimized: string, suggestions: LocatorSuggestion[]): string[] {
        const reasoning: string[] = [];

        if (original === optimized) {
            reasoning.push('Original locator is already optimal');
            return reasoning;
        }

        const selected = suggestions.find(s => s.locator === optimized);
        if (selected) {
            reasoning.push(`Selected ${selected.strategy} strategy (score: ${Math.round(selected.score * 100)}%)`);
            reasoning.push(...selected.benefits.map(b => `✓ ${b}`));

            if (selected.tradeoffs.length > 0) {
                reasoning.push('Tradeoffs:');
                reasoning.push(...selected.tradeoffs.map(t => `⚠ ${t}`));
            }
        }

        return reasoning;
    }

    /**
     * Helper: Infer ARIA role from action
     */
    private inferRole(action: Action): string | null {
        const expr = action.expression.toLowerCase();

        if (expr.includes('button') || action.type === 'click' && expr.includes('getbyrole')) {
            return 'button';
        }
        if (expr.includes('textbox') || expr.includes('input')) {
            return 'textbox';
        }
        if (expr.includes('combobox') || expr.includes('select')) {
            return 'combobox';
        }
        if (expr.includes('checkbox')) {
            return 'checkbox';
        }
        if (expr.includes('radio')) {
            return 'radio';
        }
        if (expr.includes('link')) {
            return 'link';
        }
        if (expr.includes('heading')) {
            return 'heading';
        }

        return null;
    }

    /**
     * Helper: Check if action is on a form field
     */
    private isFormField(action: Action): boolean {
        return action.type === 'fill' || action.type === 'select';
    }

    /**
     * Helper: Infer label from expression
     */
    private inferLabel(expr: string): string | null {
        const labelMatch = expr.match(/getByLabel\(['"]([^'"]+)['"]/);
        return labelMatch ? labelMatch[1] : null;
    }

    /**
     * Helper: Extract placeholder from expression
     */
    private extractPlaceholder(expr: string): string | null {
        const placeholderMatch = expr.match(/getByPlaceholder\(['"]([^'"]+)['"]/i);
        return placeholderMatch ? placeholderMatch[1] : null;
    }

    /**
     * Helper: Extract name from expression
     */
    private extractName(expr: string): string | null {
        const nameMatch = expr.match(/name:\s*['"]([^'"]+)['"]/);
        return nameMatch ? nameMatch[1] : null;
    }

    /**
     * Helper: Extract text from expression
     */
    private extractText(expr: string): string | null {
        const textMatch = expr.match(/getByText\(['"]([^'"]+)['"]/i);
        if (textMatch) return textMatch[1];

        const nameMatch = this.extractName(expr);
        if (nameMatch) return nameMatch;

        return null;
    }

    /**
     * Helper: Generate test ID
     */
    private generateTestId(action: Action): string {
        const text = this.extractText(action.expression) || action.target?.selector || 'element';
        return text.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    }

    /**
     * Helper: Generate data attribute locator
     */
    private generateDataAttributeLocator(action: Action): string | null {
        const selector = action.target?.selector;
        if (!selector) return null;

        // If already using data attribute, keep it
        if (selector.includes('[data-')) {
            return selector;
        }

        // Generate based on action type
        const testId = this.generateTestId(action);
        return `[data-testid="${testId}"]`;
    }

    /**
     * Helper: Generate composite locator
     */
    private generateCompositeLocator(action: Action): string | null {
        // Composite locators would use framework's self-healing feature
        // Return a special syntax that framework recognizes
        const primary = this.buildOriginalLocator(action);
        const fallback = this.inferRole(action);

        if (fallback) {
            return `${primary}|role=${fallback}`; // Pipe-separated fallbacks
        }

        return null;
    }

    /**
     * Helper: Generate simple CSS selector
     */
    private generateSimpleCSS(action: Action): string | null {
        const role = this.inferRole(action);
        const text = this.extractText(action.expression);

        if (role && text) {
            // Generate a semantic CSS selector
            return `${role}[aria-label*="${text}"]`;
        }

        return null;
    }

    /**
     * Get stability level from score
     */
    private getStabilityLevel(score: number): 'excellent' | 'good' | 'fair' | 'poor' {
        if (score >= 0.9) return 'excellent';
        if (score >= 0.7) return 'good';
        if (score >= 0.5) return 'fair';
        return 'poor';
    }

    /**
     * Get recommended strategy for action type
     */
    public getRecommendedStrategy(action: Action): string {
        if (action.type === 'click') {
            return 'Use getByRole with button/link role and visible name';
        }

        if (action.type === 'fill') {
            return 'Use getByLabel or getByPlaceholder for form fields';
        }

        if (action.type === 'assertion') {
            return 'Use semantic queries (role, text) over CSS selectors';
        }

        return 'Use semantic locators when possible';
    }
}
