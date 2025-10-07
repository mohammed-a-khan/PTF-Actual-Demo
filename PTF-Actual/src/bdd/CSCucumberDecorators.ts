/**
 * CS Cucumber-Compatible Decorators
 *
 * Dual-purpose step definition decorators that:
 * 1. Register steps with CS Framework's custom execution engine (CSStepRegistry)
 * 2. Register with Cucumber for IDE plugin recognition (autocomplete, Ctrl+Click navigation)
 *
 * This enables full IDE support while maintaining all CS Framework features:
 * - Page injection (@Page decorator)
 * - Custom retry logic
 * - Step class state management
 * - Context injection
 * - All existing framework functionality
 *
 * @remarks
 * These decorators are 100% backward compatible with existing @CSBDDStepDef usage.
 * Users can mix and match both decorator styles in the same project.
 *
 * @example
 * ```typescript
 * // Option 1: Framework-specific (existing)
 * import { CSBDDStepDef } from 'cs-test-automation-framework';
 * @CSBDDStepDef('I click on {string}')
 *
 * // Option 2: Cucumber-compatible (NEW - enables IDE support)
 * import { Given, When, Then, And, But } from 'cs-test-automation-framework';
 * @Given('I navigate to {string}')
 * @When('I click on {string}')
 * @Then('I should see {string}')
 * @And('I verify {string}')
 * @But('I should not see {string}')
 * ```
 */

import { CSBDDStepDef } from './CSStepRegistry';
import { CSReporter } from '../reporter/CSReporter';

// Import Cucumber decorators for IDE plugin recognition
// These will NOT be used for execution - only for IDE integration
let CucumberGiven: any;
let CucumberWhen: any;
let CucumberThen: any;

// Lazy load Cucumber to avoid startup performance impact
// Only load if needed for IDE integration
let cucumberLoaded = false;
function loadCucumber() {
    if (cucumberLoaded) return;

    try {
        // Dynamically import Cucumber decorators
        const cucumber = require('@cucumber/cucumber');
        CucumberGiven = cucumber.Given;
        CucumberWhen = cucumber.When;
        CucumberThen = cucumber.Then;
        cucumberLoaded = true;
        CSReporter.debug('Cucumber decorators loaded for IDE integration');
    } catch (error) {
        // Cucumber may not be installed in all environments (e.g., production)
        // This is fine - framework will still work without IDE integration
        CSReporter.debug('Cucumber not available - IDE integration disabled');
    }
}

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
    return function(target: any, propertyKey: string | symbol | any, descriptor?: PropertyDescriptor): any {
        // Load Cucumber decorators if not already loaded
        loadCucumber();

        // Handle both old and new decorator API
        const actualPropertyKey = typeof propertyKey === 'string' ? propertyKey : propertyKey.name;
        const actualDescriptor = descriptor || Object.getOwnPropertyDescriptor(target, actualPropertyKey);

        if (!actualDescriptor) {
            CSReporter.warn(`Cannot apply @Given decorator - descriptor not found for ${actualPropertyKey}`);
            return;
        }

        // 1. Register with CS Framework (for actual execution)
        CSBDDStepDef(pattern, timeout)(target, propertyKey, descriptor);

        // 2. Register with Cucumber (for IDE plugin recognition only)
        if (cucumberLoaded && CucumberGiven) {
            try {
                // Cucumber decorators expect different signature - adapt accordingly
                const cucumberOptions = timeout ? { timeout } : {};
                CucumberGiven(pattern, cucumberOptions, actualDescriptor.value);
            } catch (error) {
                // Ignore Cucumber registration errors - framework will still work
                CSReporter.debug(`Cucumber Given registration skipped: ${error}`);
            }
        }

        return actualDescriptor;
    };
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
    return function(target: any, propertyKey: string | symbol | any, descriptor?: PropertyDescriptor): any {
        loadCucumber();

        const actualPropertyKey = typeof propertyKey === 'string' ? propertyKey : propertyKey.name;
        const actualDescriptor = descriptor || Object.getOwnPropertyDescriptor(target, actualPropertyKey);

        if (!actualDescriptor) {
            CSReporter.warn(`Cannot apply @When decorator - descriptor not found for ${actualPropertyKey}`);
            return;
        }

        // 1. Register with CS Framework
        CSBDDStepDef(pattern, timeout)(target, propertyKey, descriptor);

        // 2. Register with Cucumber for IDE
        if (cucumberLoaded && CucumberWhen) {
            try {
                const cucumberOptions = timeout ? { timeout } : {};
                CucumberWhen(pattern, cucumberOptions, actualDescriptor.value);
            } catch (error) {
                CSReporter.debug(`Cucumber When registration skipped: ${error}`);
            }
        }

        return actualDescriptor;
    };
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
    return function(target: any, propertyKey: string | symbol | any, descriptor?: PropertyDescriptor): any {
        loadCucumber();

        const actualPropertyKey = typeof propertyKey === 'string' ? propertyKey : propertyKey.name;
        const actualDescriptor = descriptor || Object.getOwnPropertyDescriptor(target, actualPropertyKey);

        if (!actualDescriptor) {
            CSReporter.warn(`Cannot apply @Then decorator - descriptor not found for ${actualPropertyKey}`);
            return;
        }

        // 1. Register with CS Framework
        CSBDDStepDef(pattern, timeout)(target, propertyKey, descriptor);

        // 2. Register with Cucumber for IDE
        if (cucumberLoaded && CucumberThen) {
            try {
                const cucumberOptions = timeout ? { timeout } : {};
                CucumberThen(pattern, cucumberOptions, actualDescriptor.value);
            } catch (error) {
                CSReporter.debug(`Cucumber Then registration skipped: ${error}`);
            }
        }

        return actualDescriptor;
    };
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
    return function(target: any, propertyKey: string | symbol | any, descriptor?: PropertyDescriptor): any {
        loadCucumber();

        const actualPropertyKey = typeof propertyKey === 'string' ? propertyKey : propertyKey.name;
        const actualDescriptor = descriptor || Object.getOwnPropertyDescriptor(target, actualPropertyKey);

        if (!actualDescriptor) {
            CSReporter.warn(`Cannot apply @And decorator - descriptor not found for ${actualPropertyKey}`);
            return;
        }

        // Register with CS Framework (works for all step types)
        CSBDDStepDef(pattern, timeout)(target, propertyKey, descriptor);

        // For Cucumber IDE, register as Given (most common usage)
        // The IDE will recognize it regardless of which keyword is used
        if (cucumberLoaded && CucumberGiven) {
            try {
                const cucumberOptions = timeout ? { timeout } : {};
                CucumberGiven(pattern, cucumberOptions, actualDescriptor.value);
            } catch (error) {
                CSReporter.debug(`Cucumber And registration skipped: ${error}`);
            }
        }

        return actualDescriptor;
    };
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
    return function(target: any, propertyKey: string | symbol | any, descriptor?: PropertyDescriptor): any {
        loadCucumber();

        const actualPropertyKey = typeof propertyKey === 'string' ? propertyKey : propertyKey.name;
        const actualDescriptor = descriptor || Object.getOwnPropertyDescriptor(target, actualPropertyKey);

        if (!actualDescriptor) {
            CSReporter.warn(`Cannot apply @But decorator - descriptor not found for ${actualPropertyKey}`);
            return;
        }

        // Register with CS Framework (works for all step types)
        CSBDDStepDef(pattern, timeout)(target, propertyKey, descriptor);

        // For Cucumber IDE, register as Then (most common usage for negation)
        if (cucumberLoaded && CucumberThen) {
            try {
                const cucumberOptions = timeout ? { timeout } : {};
                CucumberThen(pattern, cucumberOptions, actualDescriptor.value);
            } catch (error) {
                CSReporter.debug(`Cucumber But registration skipped: ${error}`);
            }
        }

        return actualDescriptor;
    };
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
    return function(target: any, propertyKey: string | symbol | any, descriptor?: PropertyDescriptor): any {
        loadCucumber();

        const actualPropertyKey = typeof propertyKey === 'string' ? propertyKey : propertyKey.name;
        const actualDescriptor = descriptor || Object.getOwnPropertyDescriptor(target, actualPropertyKey);

        if (!actualDescriptor) {
            CSReporter.warn(`Cannot apply @Step decorator - descriptor not found for ${actualPropertyKey}`);
            return;
        }

        // Register with CS Framework
        CSBDDStepDef(pattern, timeout)(target, propertyKey, descriptor);

        // For Cucumber IDE, register with all keywords for maximum compatibility
        if (cucumberLoaded) {
            try {
                const cucumberOptions = timeout ? { timeout } : {};
                if (CucumberGiven) CucumberGiven(pattern, cucumberOptions, actualDescriptor.value);
            } catch (error) {
                CSReporter.debug(`Cucumber Step registration skipped: ${error}`);
            }
        }

        return actualDescriptor;
    };
}

/**
 * Legacy alias for backward compatibility
 * @deprecated Use @Given, @When, @Then, @And, @But, or @Step instead
 */
export const defineStep = Step;
