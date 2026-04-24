---
name: sd-simple-step
description: Use when authoring a basic step definition with a single page injection and a single action.
---

# Pattern: simple step definition

## When to use

A step that calls one method on one page object. No parameter interpolation, no context variables, no DB lookups.

## Example

```gherkin
When I click the Sign In button
```

```typescript
import { CSBDDStepDef, Page, StepDefinitions } from '@mdakhan.mak/cs-playwright-test-framework/bdd';
import { LoginFormPage } from '../../pages/login/LoginFormPage';

@StepDefinitions
export class LoginSteps {

    @Page('login-form')
    private loginPage!: LoginFormPage;

    @CSBDDStepDef('I click the Sign In button')
    async clickSignIn(): Promise<void> {
        await this.loginPage.clickSignIn();
    }
}
```

## Rules

- Class decorated `@StepDefinitions`
- Page injection via `@Page('<kebab-key>')` — match the `@CSPage('...')` key on the page object
- Step text in the decorator matches the `.feature` text **exactly** (case, whitespace, punctuation)
- The step body delegates to a page-object method; it does not manipulate elements directly
- The page method already calls `CSReporter.pass`/`fail` — no duplicate logging in the step
