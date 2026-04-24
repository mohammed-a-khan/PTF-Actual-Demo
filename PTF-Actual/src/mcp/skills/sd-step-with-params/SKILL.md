---
name: sd-step-with-params
description: Use when a step captures parameters from the scenario — {string}, {int}, {float}.
---

# Pattern: step definition with parameters

## When to use

Any step whose feature-file text contains `<placeholders>` (Scenario Outline) or quoted values that the step body must receive.

## Example

```gherkin
When I login as "<userName>" with password "<password>"
Then I should see a welcome message for "<userName>"
```

```typescript
@CSBDDStepDef('I login as {string} with password {string}')
async login(userName: string, password: string): Promise<void> {
    await this.loginPage.login(userName, password);
}

@CSBDDStepDef('I should see a welcome message for {string}')
async verifyWelcome(userName: string): Promise<void> {
    await this.dashboardPage.verifyWelcomeFor(userName);
}
```

## Supported parameter types

- `{string}` — matches `"..."` or `'...'` in the step text
- `{int}` — matches `\d+`, delivered as `number`
- `{float}` — matches `\d+\.\d+`, delivered as `number`
- `{word}` — matches a single word (no spaces)

## Rules

- The parameter order in the method signature matches the `{...}` order in the step text
- Every parameter has a TypeScript type — never `any`
- Do NOT embed values directly in the decorator string — always use parameters
- Feature-file values map to these via Cucumber expression rules — no custom regex required
