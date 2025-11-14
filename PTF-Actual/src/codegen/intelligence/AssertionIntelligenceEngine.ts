/**
 * ASSERTION INTELLIGENCE ENGINE
 *
 * Extracts and understands Playwright assertions to:
 * 1. Detect assertion purpose (navigation, data, state, error)
 * 2. Extract expected values
 * 3. Map to CS Framework assertions
 * 4. Generate meaningful Gherkin steps
 */

import { Action } from '../types';
import { CSReporter } from '../../reporter/CSReporter';

export interface ExtractedAssertion {
    assertionType: 'visibility' | 'text' | 'value' | 'state';
    purpose: 'navigation-verification' | 'data-verification' | 'state-verification' | 'feedback-verification';
    element: {
        role?: string;
        name?: string;
        selector?: string;
    };
    expectedValue?: string;
    exact?: boolean;
    context: string;
    gherkinStep: string;
    csFrameworkCode: string;
}

export class AssertionIntelligenceEngine {

    /**
     * Analyze assertion action and extract intelligence
     */
    public analyzeAssertion(action: Action, previousActions: Action[]): ExtractedAssertion | null {
        if (action.type !== 'assertion') return null;

        const expression = action.expression;

        // Extract assertion type
        const assertionType = this.detectAssertionType(expression);

        // Extract element details
        const element = this.extractElementDetails(expression);

        // Extract expected value
        const expectedValue = this.extractExpectedValue(expression);

        // Detect assertion purpose based on context
        const purpose = this.detectAssertionPurpose(element, expectedValue, previousActions);

        // Generate Gherkin step
        const gherkinStep = this.generateGherkinStep(assertionType, purpose, element, expectedValue);

        // Generate CS Framework code
        const csFrameworkCode = this.generateCSFrameworkCode(assertionType, element, expectedValue);

        return {
            assertionType,
            purpose,
            element,
            expectedValue,
            exact: expression.includes('exact: true'),
            context: this.buildContext(previousActions),
            gherkinStep,
            csFrameworkCode
        };
    }

    /**
     * Detect type of assertion
     */
    private detectAssertionType(expression: string): ExtractedAssertion['assertionType'] {
        if (expression.includes('.toBeVisible()') || expression.includes('.toBeHidden()')) {
            return 'visibility';
        }
        if (expression.includes('.toContainText(') || expression.includes('.toHaveText(')) {
            return 'text';
        }
        if (expression.includes('.toHaveValue(') || expression.includes('.inputValue')) {
            return 'value';
        }
        if (expression.includes('.toBeChecked()') || expression.includes('.toBeEnabled()') ||
            expression.includes('.toBeDisabled()')) {
            return 'state';
        }
        return 'visibility'; // Default
    }

    /**
     * Extract element details from assertion expression
     */
    private extractElementDetails(expression: string): ExtractedAssertion['element'] {
        const element: ExtractedAssertion['element'] = {};

        // Extract role
        const roleMatch = expression.match(/getByRole\(['"]([^'"]+)['"]/);
        if (roleMatch) {
            element.role = roleMatch[1];
        }

        // Extract name
        const nameMatch = expression.match(/name:\s*['"]([^'"]+)['"]/);
        if (nameMatch) {
            element.name = nameMatch[1];
        }

        // Extract selector for locator()
        const locatorMatch = expression.match(/locator\(['"]([^'"]+)['"]/);
        if (locatorMatch) {
            element.selector = locatorMatch[1];
        }

        // Extract from getByText
        const textMatch = expression.match(/getByText\(['"]([^'"]+)['"]/);
        if (textMatch) {
            element.selector = `text=${textMatch[1]}`;
        }

        return element;
    }

    /**
     * Extract expected value from assertion
     */
    private extractExpectedValue(expression: string): string | undefined {
        // From toContainText('value')
        const containsMatch = expression.match(/toContainText\(['"]([^'"]+)['"]\)/);
        if (containsMatch) return containsMatch[1];

        // From toHaveText('value')
        const haveTextMatch = expression.match(/toHaveText\(['"]([^'"]+)['"]\)/);
        if (haveTextMatch) return haveTextMatch[1];

        // From element name (heading, button name)
        const nameMatch = expression.match(/name:\s*['"]([^'"]+)['"]/);
        if (nameMatch) return nameMatch[1];

        // From getByText
        const textMatch = expression.match(/getByText\(['"]([^'"]+)['"]/);
        if (textMatch) return textMatch[1];

        return undefined;
    }

    /**
     * Detect purpose of assertion based on context
     */
    private detectAssertionPurpose(
        element: ExtractedAssertion['element'],
        expectedValue: string | undefined,
        previousActions: Action[]
    ): ExtractedAssertion['purpose'] {
        // Check if previous action was navigation (clicking a link)
        const lastAction = previousActions[previousActions.length - 1];
        if (lastAction && lastAction.type === 'click' &&
            lastAction.target?.type === 'getByRole' &&
            lastAction.target?.selector === 'link') {

            // This assertion verifies navigation success
            if (element.role === 'heading') {
                return 'navigation-verification';
            }
        }

        // Check for error/success notifications
        if (element.selector?.includes('toast') || element.selector?.includes('notification') ||
            element.selector?.includes('alert') || element.selector?.includes('message')) {
            return 'feedback-verification';
        }

        // Check for data verification (table, list content)
        if (element.role === 'table' || element.selector?.includes('table')) {
            return 'data-verification';
        }

        // Check for state verification (checkbox, button)
        if (element.role === 'button' || element.role === 'checkbox') {
            return 'state-verification';
        }

        // Default: data verification
        return 'data-verification';
    }

    /**
     * Generate Gherkin step from assertion
     */
    private generateGherkinStep(
        type: ExtractedAssertion['assertionType'],
        purpose: ExtractedAssertion['purpose'],
        element: ExtractedAssertion['element'],
        expectedValue?: string
    ): string {
        // Navigation verification - implicit in navigation step
        if (purpose === 'navigation-verification' && element.role === 'heading' && expectedValue) {
            return `Then I should be on the ${expectedValue} page`;
        }

        // Data verification in table
        if (purpose === 'data-verification' && element.role === 'table' && expectedValue) {
            return `Then the results should contain "${expectedValue}"`;
        }

        // Feedback verification
        if (purpose === 'feedback-verification') {
            if (expectedValue) {
                return `Then I should see "${expectedValue}" notification`;
            }
            return `Then I should see a notification`;
        }

        // State verification
        if (purpose === 'state-verification' && element.role === 'button' && expectedValue) {
            return `Then the "${expectedValue}" button should be visible`;
        }

        // Generic visibility
        if (type === 'visibility' && expectedValue) {
            return `Then I should see "${expectedValue}"`;
        }

        // Generic text verification
        if (type === 'text' && expectedValue) {
            return `Then I should see "${expectedValue}"`;
        }

        return `Then I should see the expected content`;
    }

    /**
     * Generate CS Framework assertion code
     */
    private generateCSFrameworkCode(
        type: ExtractedAssertion['assertionType'],
        element: ExtractedAssertion['element'],
        expectedValue?: string
    ): string {
        const elementRef = this.generateElementReference(element);

        switch (type) {
            case 'visibility':
                return `await ${elementRef}.waitForVisible();\nawait csAssert.isVisible(${elementRef});`;

            case 'text':
                if (expectedValue) {
                    return `await csExpect(${elementRef}).toContainText('${expectedValue}');`;
                }
                return `await csAssert.isVisible(${elementRef});`;

            case 'value':
                if (expectedValue) {
                    return `await csExpect(${elementRef}).toHaveValue('${expectedValue}');`;
                }
                return `await csAssert.isVisible(${elementRef});`;

            case 'state':
                return `await csAssert.isVisible(${elementRef});\nawait csAssert.isEnabled(${elementRef});`;

            default:
                return `await csAssert.isVisible(${elementRef});`;
        }
    }

    /**
     * Generate element reference for code
     */
    private generateElementReference(element: ExtractedAssertion['element']): string {
        if (element.role === 'heading') {
            return 'this.pageHeading';
        }
        if (element.role === 'table') {
            return 'this.resultsTable';
        }
        if (element.role === 'button') {
            return 'this.button';
        }
        if (element.selector?.includes('toast')) {
            return 'this.notificationToast';
        }
        return 'this.element';
    }

    /**
     * Build context string from previous actions
     */
    private buildContext(previousActions: Action[]): string {
        if (previousActions.length === 0) return 'initial state';

        const lastAction = previousActions[previousActions.length - 1];
        if (lastAction.type === 'click') {
            return `after clicking ${lastAction.target?.options?.name || 'element'}`;
        }
        if (lastAction.type === 'fill') {
            return `after filling form`;
        }
        if (lastAction.type === 'navigation') {
            return `after navigation`;
        }

        return 'in current state';
    }

    /**
     * Check if assertion is implicit in workflow (navigation verification)
     */
    public isImplicitAssertion(assertion: ExtractedAssertion): boolean {
        // Navigation verifications are implicit in "I navigate to X page" steps
        return assertion.purpose === 'navigation-verification' &&
               assertion.element.role === 'heading';
    }

    /**
     * Group assertion with related action (for method generation)
     */
    public shouldGroupWithPreviousAction(
        assertion: ExtractedAssertion,
        previousAction: Action | null
    ): boolean {
        // Group navigation assertions with navigation actions
        if (assertion.purpose === 'navigation-verification' &&
            previousAction?.type === 'click' &&
            previousAction.target?.type === 'getByRole' &&
            previousAction.target.selector === 'link') {
            return true;
        }

        // Group feedback assertions with submit actions
        if (assertion.purpose === 'feedback-verification' &&
            previousAction?.type === 'click' &&
            previousAction.target?.options?.name?.toLowerCase().includes('search')) {
            return true;
        }

        return false;
    }
}
