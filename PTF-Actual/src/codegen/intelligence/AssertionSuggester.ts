/**
 * AssertionSuggester - Intelligent Assertion Suggestions
 *
 * Suggests appropriate assertions based on action context.
 * Identifies verification points in the test flow.
 */

import { Action } from '../types';

export interface SuggestedAssertion {
    type: AssertionType;
    target: string;
    expectedBehavior: string;
    gherkinStep: string;
    implementation: string;
    confidence: number;
    reason: string;
}

export interface VerificationPoint {
    afterActionIndex: number;
    action: Action;
    suggestions: SuggestedAssertion[];
}

export type AssertionType =
    | 'visibility'
    | 'text-contains'
    | 'text-equals'
    | 'url-contains'
    | 'url-equals'
    | 'element-enabled'
    | 'element-disabled'
    | 'checkbox-checked'
    | 'checkbox-unchecked'
    | 'value-equals'
    | 'count-equals'
    | 'element-absent';

export class AssertionSuggester {
    // Actions that typically need verification after them
    private static readonly ACTIONS_NEEDING_VERIFICATION = [
        'click:submit',
        'click:save',
        'click:delete',
        'click:login',
        'click:logout',
        'click:search',
        'click:confirm',
        'click:ok',
        'click:cancel',
        'fill:search',
        'selectOption',
        'navigation',
    ];

    // Element patterns and their expected assertions
    private static readonly ASSERTION_PATTERNS: Array<{
        trigger: RegExp;
        assertions: Array<{
            type: AssertionType;
            target: string;
            behavior: string;
            confidence: number;
        }>;
    }> = [
        {
            trigger: /login|sign.?in/i,
            assertions: [
                { type: 'url-contains', target: 'dashboard|home', behavior: 'should redirect to dashboard', confidence: 0.9 },
                { type: 'visibility', target: 'welcome|logout|user', behavior: 'should show user is logged in', confidence: 0.85 },
                { type: 'element-absent', target: 'login|sign.?in', behavior: 'should hide login form', confidence: 0.8 },
            ],
        },
        {
            trigger: /logout|sign.?out/i,
            assertions: [
                { type: 'url-contains', target: 'login', behavior: 'should redirect to login', confidence: 0.9 },
                { type: 'visibility', target: 'login|sign.?in', behavior: 'should show login form', confidence: 0.85 },
            ],
        },
        {
            trigger: /search/i,
            assertions: [
                { type: 'visibility', target: 'result|list|table', behavior: 'should show search results', confidence: 0.85 },
                { type: 'text-contains', target: 'result', behavior: 'should contain search term', confidence: 0.7 },
            ],
        },
        {
            trigger: /save|submit|create|add/i,
            assertions: [
                { type: 'visibility', target: 'success|saved|created', behavior: 'should show success message', confidence: 0.85 },
                { type: 'element-absent', target: 'error', behavior: 'should not show error', confidence: 0.7 },
            ],
        },
        {
            trigger: /delete|remove/i,
            assertions: [
                { type: 'visibility', target: 'deleted|removed|confirm', behavior: 'should confirm deletion', confidence: 0.8 },
                { type: 'element-absent', target: 'deleted-item', behavior: 'deleted item should not be visible', confidence: 0.85 },
            ],
        },
        {
            trigger: /upload/i,
            assertions: [
                { type: 'visibility', target: 'uploaded|success|file', behavior: 'should show file uploaded', confidence: 0.85 },
                { type: 'text-contains', target: 'filename', behavior: 'should show filename', confidence: 0.7 },
            ],
        },
    ];

    /**
     * Suggest assertions for action sequence
     */
    public static suggestAssertions(actions: Action[]): VerificationPoint[] {
        const verificationPoints: VerificationPoint[] = [];

        for (let i = 0; i < actions.length; i++) {
            const action = actions[i];
            const suggestions = this.suggestForAction(action, actions, i);

            if (suggestions.length > 0) {
                verificationPoints.push({
                    afterActionIndex: i,
                    action,
                    suggestions,
                });
            }
        }

        return verificationPoints;
    }

    /**
     * Suggest assertions for a single action
     */
    private static suggestForAction(action: Action, allActions: Action[], index: number): SuggestedAssertion[] {
        const suggestions: SuggestedAssertion[] = [];

        // Check if action needs verification
        if (!this.needsVerification(action)) {
            return suggestions;
        }

        // Get action context
        const actionTarget = this.getActionTarget(action);

        // Match against assertion patterns
        for (const pattern of this.ASSERTION_PATTERNS) {
            if (pattern.trigger.test(actionTarget)) {
                for (const assertion of pattern.assertions) {
                    suggestions.push(this.createSuggestion(action, assertion));
                }
            }
        }

        // Add context-specific suggestions
        const contextSuggestions = this.getContextSuggestions(action, allActions, index);
        suggestions.push(...contextSuggestions);

        // Sort by confidence
        suggestions.sort((a, b) => b.confidence - a.confidence);

        // Return top suggestions
        return suggestions.slice(0, 5);
    }

    /**
     * Check if action needs verification
     */
    private static needsVerification(action: Action): boolean {
        const actionKey = `${action.method}:${this.getActionTarget(action)}`;

        for (const pattern of this.ACTIONS_NEEDING_VERIFICATION) {
            if (actionKey.toLowerCase().includes(pattern.toLowerCase())) {
                return true;
            }
        }

        // Navigation always needs verification
        if (action.type === 'navigation') {
            return true;
        }

        // Form submission
        if (action.method === 'click') {
            const target = this.getActionTarget(action).toLowerCase();
            if (target.includes('submit') || target.includes('save') || target.includes('confirm')) {
                return true;
            }
        }

        return false;
    }

    /**
     * Get action target for matching
     */
    private static getActionTarget(action: Action): string {
        if (action.target?.options?.name) {
            return action.target.options.name;
        }
        if (action.target?.selector) {
            return action.target.selector;
        }
        if (action.method === 'goto' && action.args?.[0]) {
            return action.args[0] as string;
        }
        return action.method;
    }

    /**
     * Create suggestion from pattern match
     */
    private static createSuggestion(
        action: Action,
        assertion: { type: AssertionType; target: string; behavior: string; confidence: number }
    ): SuggestedAssertion {
        const gherkinStep = this.generateGherkinStep(assertion.type, assertion.target, assertion.behavior);
        const implementation = this.generateImplementation(assertion.type, assertion.target);

        return {
            type: assertion.type,
            target: assertion.target,
            expectedBehavior: assertion.behavior,
            gherkinStep,
            implementation,
            confidence: assertion.confidence,
            reason: `After ${action.method} on ${this.getActionTarget(action)}`,
        };
    }

    /**
     * Get context-specific suggestions
     */
    private static getContextSuggestions(action: Action, allActions: Action[], index: number): SuggestedAssertion[] {
        const suggestions: SuggestedAssertion[] = [];

        // After navigation, verify page loaded
        if (action.type === 'navigation') {
            suggestions.push({
                type: 'visibility',
                target: 'main-content',
                expectedBehavior: 'Page should load completely',
                gherkinStep: 'Then the page should load successfully',
                implementation: `await this.waitForPageLoad();\nconst isLoaded = await this.mainContent.isVisibleWithTimeout(10000);\nexpect(isLoaded).toBeTruthy();`,
                confidence: 0.9,
                reason: 'Navigation requires page load verification',
            });
        }

        // After form fill, check if next button is enabled
        if (action.method === 'fill') {
            // Look ahead for a submit button
            const hasSubmitAhead = allActions.slice(index + 1).some(a =>
                a.method === 'click' && this.getActionTarget(a).toLowerCase().includes('submit')
            );

            if (!hasSubmitAhead) {
                suggestions.push({
                    type: 'element-enabled',
                    target: 'submit-button',
                    expectedBehavior: 'Submit button should be enabled',
                    gherkinStep: 'Then the submit button should be enabled',
                    implementation: `const isEnabled = await this.submitButton.isEnabled();\nexpect(isEnabled).toBeTruthy();`,
                    confidence: 0.6,
                    reason: 'Form input may enable submit button',
                });
            }
        }

        // After clicking a link, verify navigation
        if (action.method === 'click' && action.target?.type === 'getByRole' && action.target?.selector === 'link') {
            const linkName = action.target.options?.name || 'page';
            suggestions.push({
                type: 'visibility',
                target: linkName,
                expectedBehavior: `Should navigate to ${linkName} page`,
                gherkinStep: `Then user should see ${linkName} page`,
                implementation: `await this.waitForPageLoad();\nconst header = await this.pageHeader.textContentWithTimeout(5000);\nexpect(header).toContain('${linkName}');`,
                confidence: 0.75,
                reason: 'Link click typically navigates to new page',
            });
        }

        return suggestions;
    }

    /**
     * Generate Gherkin step for assertion
     */
    private static generateGherkinStep(type: AssertionType, target: string, behavior: string): string {
        switch (type) {
            case 'visibility':
                return `Then ${target.replace(/[|]/g, ' or ')} should be visible`;
            case 'text-contains':
                return `Then ${target} should contain {string}`;
            case 'text-equals':
                return `Then ${target} should equal {string}`;
            case 'url-contains':
                return `Then URL should contain "${target.replace(/[|]/g, '/')}"`;
            case 'url-equals':
                return `Then URL should be {string}`;
            case 'element-enabled':
                return `Then ${target} should be enabled`;
            case 'element-disabled':
                return `Then ${target} should be disabled`;
            case 'checkbox-checked':
                return `Then ${target} should be checked`;
            case 'checkbox-unchecked':
                return `Then ${target} should be unchecked`;
            case 'value-equals':
                return `Then ${target} should have value {string}`;
            case 'count-equals':
                return `Then ${target} count should be {int}`;
            case 'element-absent':
                return `Then ${target} should not be visible`;
            default:
                return `Then ${behavior}`;
        }
    }

    /**
     * Generate implementation for assertion
     */
    private static generateImplementation(type: AssertionType, target: string): string {
        const element = this.toCamelCase(target.split(/[|]/)[0]);

        switch (type) {
            case 'visibility':
                return `const isVisible = await this.${element}.isVisibleWithTimeout(10000);\nif (!isVisible) throw new Error('${target} not visible');`;
            case 'text-contains':
                return `const text = await this.${element}.textContentWithTimeout(5000);\nif (!text?.includes(expectedText)) throw new Error('Text not found');`;
            case 'text-equals':
                return `const text = await this.${element}.textContentWithTimeout(5000);\nif (text?.trim() !== expectedText) throw new Error('Text mismatch');`;
            case 'url-contains':
                return `const url = await this.getUrl();\nif (!url.includes('${target}')) throw new Error('URL mismatch');`;
            case 'element-enabled':
                return `const isEnabled = await this.${element}.isEnabled();\nif (!isEnabled) throw new Error('Element not enabled');`;
            case 'element-disabled':
                return `const isDisabled = await this.${element}.isDisabled();\nif (!isDisabled) throw new Error('Element not disabled');`;
            case 'element-absent':
                return `const isVisible = await this.${element}.isVisibleWithTimeout(3000);\nif (isVisible) throw new Error('Element should not be visible');`;
            default:
                return `// TODO: Implement ${type} assertion for ${target}`;
        }
    }

    /**
     * Convert to camelCase
     */
    private static toCamelCase(str: string): string {
        return str
            .replace(/[^a-zA-Z0-9]+/g, ' ')
            .trim()
            .split(' ')
            .map((word, index) => {
                if (index === 0) return word.toLowerCase();
                return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
            })
            .join('');
    }
}

export default AssertionSuggester;
