---
name: step-definition-patterns
description: >
  Canonical patterns for writing step definition classes in the target
  TypeScript test framework. Covers file placement, the @StepDefinitions
  class decorator, the @CSBDDStepDef / @Given / @When / @Then / @And /
  @But step decorators, page injection via @Page, parameter types,
  CSBDDContext access, CSValueResolver for config references, hook
  decorators (@CSBefore / @CSAfter / @CSBeforeStep / @CSAfterStep),
  step deduplication rules, reporter usage, and forbidden patterns.
  Load when generating, auditing, or healing any .steps.ts file.
---

# Step Definition Patterns

## When this skill applies

Any generated or modified step definitions file — typically
filenames ending in `.steps.ts` under `test/<project>/steps/`.

## File placement and naming

- Directory: `test/<project>/steps/`, or nested by module for
  large projects.
- Filename: kebab-case ending in `.steps.ts` (e.g.,
  `user-login.steps.ts`, `order-management.steps.ts`).
  NEVER PascalCase (`UserLoginSteps.ts` is wrong).
- One step definitions class per file. The class name is
  PascalCase ending in `Steps` (e.g., `UserLoginSteps`).
- Never create `index.ts` barrel files in the `steps/` folder.
- File auto-registration depends on the `.steps.ts` suffix —
  files with a different extension won't be discovered.

## Imports

Standard shape for a step definitions file:

```
import { CSBDDStepDef, Page, StepDefinitions, When, Then, Given, And }
    from '<framework>/bdd';
import { CSBDDContext } from '<framework>/bdd';
import { CSReporter } from '<framework>/reporter';
import { CSValueResolver } from '<framework>/utilities';
import { LoginPage } from '../pages/LoginPage';
import { HomePage } from '../pages/HomePage';
```

Rules:
- Framework imports grouped by submodule path, one blank line
  between framework imports and local imports
- Never import from the framework's root package — always a
  submodule path
- Never import a decorator you don't use
- Local page imports come last

## Class shape

A step definitions file defines a single class annotated with
`@StepDefinitions`. Inside the class:

- Private fields for injected page objects, declared with the
  `@Page('<identifier>')` decorator. The identifier matches the
  `@CSPage('<identifier>')` on the target page object class.
- A private field for the BDD context, initialised from
  `CSBDDContext.getInstance()`, if the step def needs to share
  state across steps within a scenario.
- Step methods — one per decorator call. Each is an async method
  that returns `Promise<void>`.

Minimal shape:

```
@StepDefinitions
export class UserLoginSteps {

    @Page('login-page')
    private loginPage!: LoginPage;

    @Page('home-page')
    private homePage!: HomePage;

    private context = CSBDDContext.getInstance();

    @When('I login as {string}')
    async loginAs(username: string): Promise<void> {
        CSReporter.info(`Logging in as ${username}`);
        const password = CSValueResolver.resolve(
            '{config:APP_PASSWORD}', this.context);
        await this.loginPage.loginWithCredentials(username, password);
        await this.homePage.verifyHeader();
        CSReporter.pass(`Logged in as ${username}`);
    }

    @Then('I should see the home page header')
    async verifyHomeHeader(): Promise<void> {
        await this.homePage.verifyHeader();
    }
}
```

The `!:` non-null assertion on injected page fields is required
because the framework initialises them via decorator reflection.

## Page injection with @Page

- `@Page('<identifier>')` injects a page object instance into a
  private field.
- The `<identifier>` string must match the identifier used in the
  page class's `@CSPage('<identifier>')` decorator. If they don't
  match, the injection fails at runtime with a not-registered
  error.
- Declare one page per field; never share one field across two
  page types.
- Declare pages at the top of the class, before step methods.

## Step decorators

The framework supports two equivalent ways to declare a step:

### Option 1: Generic @CSBDDStepDef

```
@CSBDDStepDef('I enter username {string}')
async enterUsername(username: string): Promise<void> {
    await this.loginPage.textBoxUsername.fill(username);
}
```

Use `@CSBDDStepDef` when the step phrase doesn't cleanly map to
Given/When/Then (for example, a pure action like "I wait for
results to load" that could be any of the three).

### Option 2: Gherkin-style @Given / @When / @Then / @And / @But

```
@When('I click the Submit button')
async clickSubmit(): Promise<void> {
    await this.orderPage.buttonSubmit.click();
}

@Then('I should see confirmation message {string}')
async verifyConfirmation(expected: string): Promise<void> {
    await this.orderPage.verifyConfirmation(expected);
}
```

Use the Gherkin-style decorators when the step phrase starts with
the corresponding keyword in the feature file. Matching the
decorator to the keyword makes the feature-to-step mapping
transparent to readers.

### Step pattern rules

- The phrase inside the decorator matches the feature file text
  exactly, character for character, minus the leading keyword and
  whitespace.
- Parameters in the phrase use cucumber-expression syntax:
  - `{string}` — matches a quoted string
  - `{int}` — matches an integer
  - `{float}` — matches a floating-point number
  - `{word}` — matches a single word
  - For complex patterns, use a regular expression instead of a
    string pattern: `@When(/^I click the (.+) button$/)`
- Each parameter in the phrase corresponds to one method
  parameter in declaration order.
- The method name is advisory — the framework routes by the
  decorator phrase, not by the method name. Still, make method
  names readable so audit tools and humans can follow.

## Parameter types

Cucumber-expression types available out of the box:

- `{string}` → `string` — matches quoted text
- `{int}` → `number` — integer
- `{float}` → `number` — floating point
- `{word}` → `string` — single word, no quotes
- `{any}` → `any` — anything between whitespace

Rules:
- The TypeScript parameter type must match the cucumber type
  (`{string}` → `username: string`, `{int}` → `count: number`).
- TypeScript doesn't enforce this at compile time for decorator
  strings — the audit tool does.
- Never use a parameter type that the cucumber expression doesn't
  produce.

## CSBDDContext — sharing state within a scenario

`CSBDDContext.getInstance()` returns a singleton scenario-scoped
context. Use it to pass values between steps in the same
scenario without global mutable state.

```
private context = CSBDDContext.getInstance();

@When('I create a new user with email {string}')
async createUser(email: string): Promise<void> {
    const userId = await UserDatabaseHelper.createTestUser(email);
    this.context.set('createdUserId', userId);
    this.context.set('createdUserEmail', email);
}

@Then('the created user should exist in the system')
async verifyCreatedUser(): Promise<void> {
    const userId = this.context.get<string>('createdUserId');
    const user = await UserDatabaseHelper.findUserById(userId);
    await CSAssert.getInstance().assertNotNull(
        user, `User ${userId} should exist`);
}
```

Available methods on `CSBDDContext`:

- `set(key, value)` / `get<T>(key)` / `has(key)` / `delete(key)`
- `getAll()` / `clear()`
- `setVariable(name, value)` / `getVariable<T>(name)` — alternate
  API for config-style variables
- `storeTestData(key, data)` / `getTestData<T>(key)` — alternate
  API for structured test data
- `addAssertion(description, passed, actual?, expected?)` —
  record a custom assertion in the scenario report
- `addStepResult(step, status, duration, screenshot?)` — manual
  step tracking when needed

Context lifetime: one scenario. The framework clears it between
scenarios automatically. Never treat context as cross-scenario
shared state — use a helper class with static storage for that.

## CSValueResolver — resolving config references

Feature file parameters and data file values can reference config
variables via `{config:VAR_NAME}`. The step definition resolves
them using `CSValueResolver.resolve(...)` before passing to the
page object.

```
@When('I login with stored credentials for role {string}')
async loginForRole(role: string): Promise<void> {
    const username = CSValueResolver.resolve(
        `{config:APP_USER_${role.toUpperCase()}}`, this.context);
    const password = CSValueResolver.resolve(
        `{config:APP_PASSWORD_${role.toUpperCase()}}`, this.context);
    await this.loginPage.loginWithCredentials(username, password);
}
```

Resolver syntax:
- `{config:VAR_NAME}` — read from configuration hierarchy
- `{env:VAR_NAME}` — read from environment variable
- `{ctx:key}` — read from the current BDD context
- `{data:field}` — read from the current scenario data row

Resolution happens recursively — a config value containing
another `{config:...}` reference resolves transitively.

## Hook decorators

Hooks live in a step definition class alongside step methods.
They use the framework's hook decorators with a `tags` filter to
scope execution.

Available hooks:

- `@CSBefore(options?)` — runs before each scenario
- `@CSAfter(options?)` — runs after each scenario
- `@CSBeforeStep(options?)` — runs before each step
- `@CSAfterStep(options?)` — runs after each step

Options:

- `tags?: string[]` — array of tag names. The hook runs only for
  scenarios carrying at least one of the listed tags.
- `order?: number` — integer; lower runs earlier. Use to sequence
  multiple hooks that apply to the same tag.

Example:

```
@StepDefinitions
export class TestDataHooks {

    @CSBefore({ tags: ['@needs-test-user'], order: 1 })
    async createTestUser(): Promise<void> {
        CSReporter.info('Creating test user');
        await UserDatabaseHelper.createTestUser('test-user@example.test');
    }

    @CSAfter({ tags: ['@needs-test-user'] })
    async cleanupTestUser(): Promise<void> {
        CSReporter.info('Cleaning up test user');
        await UserDatabaseHelper.deleteTestUsers('test-user');
    }
}
```

Rules:
- Hooks are declared inside a `@StepDefinitions` class, not
  standalone functions
- Hooks return `Promise<void>`
- Failed `@CSBefore` fails the scenario
- Failed `@CSAfter` is logged but does not fail the scenario
- Tag filter with no match means the hook is skipped silently
- Never put business logic in hooks — hooks set up and tear down
  state only

## Step deduplication

Before writing a new step definition, search the entire
`test/<project>/steps/` folder for an existing step with the same
phrase or a phrase that would match the same feature line. The
audit checklist performs this check automatically and rejects
files with duplicate patterns.

Rules:
- Two decorators with the same phrase across different files are
  a build error.
- Two decorators with different phrases that match the same
  feature line are ambiguous — fix the phrase of one to be more
  specific.
- When the new step would be a near-duplicate of an existing one,
  reuse the existing one. Update the feature file to use the
  existing step's phrase instead of creating a new variant.
- When the new step is genuinely distinct, give it a clearly
  different phrase that disambiguates it.

## Step body rules

- Body is `async` and returns `Promise<void>`
- Body calls methods on injected page objects and helpers, never
  raw Playwright APIs
- Body logs at least once via `CSReporter.info` at the start of
  the logical action and once via `CSReporter.pass` on success
- Body throws or calls `CSAssert.getInstance().assert*` for any
  verification — never silently returns on failure
- Body uses `CSValueResolver.resolve` to handle `{config:...}`,
  `{env:...}`, `{ctx:...}`, and `{data:...}` references in
  parameters before passing them on

## Reporter usage

The step definition is the primary layer for scenario-level
reporting. Use these `CSReporter` static methods:

- `CSReporter.info(message)` — informational (start of a step)
- `CSReporter.pass(message)` — success (end of a step)
- `CSReporter.warn(message)` — non-fatal issue
- `CSReporter.debug(message)` — verbose, shown only when debug
  mode is enabled
- `CSReporter.error(message)` — error that continues the run
- `CSReporter.fail(message)` — fatal failure, typically followed
  by a throw

Never use `console.log`, `console.error`, or any other logger.
The framework's reporter integrates with the run log, screenshots,
and the HTML report. Raw console calls bypass all of that.

## Forbidden patterns

Never do any of these in a step definitions file:

- Instantiate a page object with `new` — always use `@Page`
  injection
- Create new `CSBDDContext` instances with `new` — always use
  `getInstance()`
- Import from the framework's root package — always use
  submodule paths
- Declare element locators in the step definition — locators live
  in page objects only
- Import types from `@playwright/test` and call raw Playwright
  API methods — use framework wrappers
- Use `console.log` or any non-framework logger
- Write SQL as a string literal — use a named query via
  `CSDBUtils`
- Build SQL via string interpolation with user input
- Use hardcoded URLs, credentials, or connection strings —
  resolve from config
- Share state between scenarios via module-level variables — use
  helper classes with intentional static state
- Catch errors and return silently without reporting or rethrowing
- Declare two step methods with the same phrase — audit will
  reject the file
- Use `function` keyword for step methods — always arrow-compat
  async methods on the class
- Create helper classes inside the step definitions file — helpers
  belong under `helpers/`

## Self-check before returning a step definitions file

- [ ] Filename is kebab-case ending in `.steps.ts`
- [ ] Class is annotated with `@StepDefinitions`
- [ ] Class name is PascalCase ending in `Steps`
- [ ] Imports are module-specific, grouped, and have no unused
      entries
- [ ] `@Page` decorator is used for every page object, with
      identifiers matching the page class `@CSPage` values
- [ ] Every step method is async and returns `Promise<void>`
- [ ] Parameter types in the method match the cucumber-expression
      types in the decorator phrase
- [ ] `{config:...}` and `{env:...}` values go through
      `CSValueResolver.resolve(...)`
- [ ] `CSBDDContext` is obtained via `getInstance()`, not `new`
- [ ] Hooks use `@CSBefore` / `@CSAfter` / `@CSBeforeStep` /
      `@CSAfterStep` with `tags` scoping
- [ ] `CSReporter.info` at start and `CSReporter.pass` at end of
      each step's logical action
- [ ] No `console.log`, no raw Playwright APIs, no SQL strings
- [ ] No duplicate step phrases anywhere in the project
- [ ] No page object instantiated with `new`
- [ ] No locators in the file — all locators in page classes
- [ ] Every step either delegates to a page method or asserts via
      `CSAssert.getInstance().assert*`

If any item fails, fix it before calling `npx tsc --noEmit` via `run_in_terminal`. The
audit checklist enforces most of these rules.
