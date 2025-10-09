/**
 * CS Cucumber-Compatible Decorators
 *
 * Step definition decorators that:
 * 1. Register steps with CS Framework's custom execution engine (CSStepRegistry)
 * 2. Provide IDE plugin recognition through decorator naming (autocomplete, Ctrl+Click navigation)
 *
 * This enables full IDE support while maintaining all CS Framework features:
 * - Page injection (@Page decorator)
 * - Custom retry logic
 * - Step class state management
 * - Context injection
 * - All existing framework functionality
 *
 * @remarks
 * **How IDE Support Works:**
 * IDE plugins (like Cucumber plugins for VS Code, IntelliJ) use static analysis to recognize
 * step definitions. They parse the source code looking for decorator names like @Given, @When, @Then.
 * No runtime registration with Cucumber is needed - the decorator names themselves enable IDE features.
 *
 * **Backward Compatibility:**
 * These decorators are 100% backward compatible with existing @CSBDDStepDef usage.
 * Users can mix and match both decorator styles in the same project.
 *
 * @example
 * ```typescript
 * // Option 1: Framework-specific (existing)
 * import { CSBDDStepDef } from 'cs-playwright-test-framework';
 * @CSBDDStepDef('I click on {string}')
 *
 * // Option 2: Cucumber-compatible (NEW - enables IDE support)
 * import { Given, When, Then, And, But } from 'cs-playwright-test-framework';
 * @Given('I navigate to {string}')
 * @When('I click on {string}')
 * @Then('I should see {string}')
 * @And('I verify {string}')
 * @But('I should not see {string}')
 * ```
 */

import { CSBDDStepDef } from './CSStepRegistry';

/**
 * Given decorator - Defines a precondition step
 *
 * @param pattern - Step pattern with optional Cucumber expressions ({string}, {int}, {float}, {word})
 * @param timeout - Optional timeout in milliseconds
 *
 * @example
 * ```typescript
 * @Given('I am on the login page')
 * async onLoginPage() {
 *     await this.loginPage.navigate();
 * }
 *
 * @Given('I am logged in as {string}')
 * async loggedInAs(username: string) {
 *     await this.loginPage.login(username);
 * }
 * ```
 */
export function Given(pattern: string, timeout?: number) {
    // Register with CS Framework - IDE support comes from decorator name (static analysis)
    return CSBDDStepDef(pattern, timeout);
}

/**
 * When decorator - Defines an action step
 *
 * @param pattern - Step pattern with optional Cucumber expressions ({string}, {int}, {float}, {word})
 * @param timeout - Optional timeout in milliseconds
 *
 * @example
 * ```typescript
 * @When('I click on {string}')
 * async clickOn(element: string) {
 *     await this.page.click(element);
 * }
 *
 * @When('I wait for {int} seconds')
 * async waitFor(seconds: number) {
 *     await this.page.waitForTimeout(seconds * 1000);
 * }
 * ```
 */
export function When(pattern: string, timeout?: number) {
    // Register with CS Framework - IDE support comes from decorator name (static analysis)
    return CSBDDStepDef(pattern, timeout);
}

/**
 * Then decorator - Defines an assertion/verification step
 *
 * @param pattern - Step pattern with optional Cucumber expressions ({string}, {int}, {float}, {word})
 * @param timeout - Optional timeout in milliseconds
 *
 * @example
 * ```typescript
 * @Then('I should see {string}')
 * async shouldSee(text: string) {
 *     await expect(this.page).toContainText(text);
 * }
 *
 * @Then('the response status should be {int}')
 * async statusShouldBe(status: number) {
 *     expect(this.response.status).toBe(status);
 * }
 * ```
 */
export function Then(pattern: string, timeout?: number) {
    // Register with CS Framework - IDE support comes from decorator name (static analysis)
    return CSBDDStepDef(pattern, timeout);
}

/**
 * And decorator - Continuation of previous step type
 *
 * In Gherkin, "And" inherits the type of the previous step.
 * For framework purposes, it's registered as a generic step that works with any keyword.
 *
 * @param pattern - Step pattern with optional Cucumber expressions ({string}, {int}, {float}, {word})
 * @param timeout - Optional timeout in milliseconds
 *
 * @example
 * ```typescript
 * @Given('I am on the login page')
 * @And('I see the login form')  // Treated as Given
 *
 * @When('I enter username')
 * @And('I enter password')  // Treated as When
 * ```
 */
export function And(pattern: string, timeout?: number) {
    // Register with CS Framework - IDE support comes from decorator name (static analysis)
    return CSBDDStepDef(pattern, timeout);
}

/**
 * But decorator - Negation continuation of previous step type
 *
 * In Gherkin, "But" inherits the type of the previous step (like "And").
 * For framework purposes, it's registered as a generic step that works with any keyword.
 *
 * @param pattern - Step pattern with optional Cucumber expressions ({string}, {int}, {float}, {word})
 * @param timeout - Optional timeout in milliseconds
 *
 * @example
 * ```typescript
 * @Then('I should see the dashboard')
 * @But('I should not see the login form')  // Treated as Then (negation)
 * ```
 */
export function But(pattern: string, timeout?: number) {
    // Register with CS Framework - IDE support comes from decorator name (static analysis)
    return CSBDDStepDef(pattern, timeout);
}

/**
 * Step decorator - Generic step that matches any Gherkin keyword
 *
 * Use this when a step can be used with any keyword (Given/When/Then/And/But).
 * This is an alias for @CSBDDStepDef but with Cucumber-compatible naming.
 *
 * @param pattern - Step pattern with optional Cucumber expressions ({string}, {int}, {float}, {word})
 * @param timeout - Optional timeout in milliseconds
 *
 * @example
 * ```typescript
 * @Step('the system is ready')
 * async systemReady() {
 *     // Can be used with any keyword:
 *     // Given the system is ready
 *     // When the system is ready
 *     // Then the system is ready
 * }
 * ```
 */
export function Step(pattern: string, timeout?: number) {
    // Register with CS Framework - IDE support comes from decorator name (static analysis)
    return CSBDDStepDef(pattern, timeout);
}

/**
 * Legacy alias for backward compatibility
 * @deprecated Use @Given, @When, @Then, @And, @But, or @Step instead
 */
export const defineStep = Step;
