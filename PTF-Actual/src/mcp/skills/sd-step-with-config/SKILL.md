---
name: sd-step-with-config
description: Use when a step needs an environment or configuration value — BASE_URL, API_KEY, test user email. CSValueResolver, never process.env.
---

# Pattern: step definition reading config

## When to use

Any step that depends on environment config — URLs, feature flags, shared credentials, service endpoints.

## Example

```typescript
import {
    CSBDDStepDef,
    Page,
    StepDefinitions,
    CSBDDContext,
} from '@mdakhan.mak/cs-playwright-test-framework/bdd';
import { CSValueResolver } from '@mdakhan.mak/cs-playwright-test-framework/utilities';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';
import { LoginFormPage } from '../../pages/login/LoginFormPage';

@StepDefinitions
export class NavigationSteps {

    @Page('login-form')
    private loginPage!: LoginFormPage;

    private context = CSBDDContext.getInstance();

    @CSBDDStepDef('I navigate to the application login page')
    async openLogin(): Promise<void> {
        const baseUrl = CSValueResolver.resolve('{config:BASE_URL}', this.context);
        if (!baseUrl) {
            const msg = 'BASE_URL is not configured for this environment';
            CSReporter.fail(msg);
            throw new Error(msg);
        }
        const loginUrl = `${baseUrl}/login`;
        await this.loginPage.navigate(loginUrl);
        CSReporter.pass(`Opened login at ${loginUrl}`);
    }
}
```

## Rules

- Config access ONLY via `CSValueResolver.resolve('{config:KEY}', context)` — never `process.env.KEY`
- Resolved value might be empty/undefined — ALWAYS check before use; fail loudly if missing
- Config keys map to `config/<project>/environments/<env>.env` entries at runtime
- For encrypted values, the framework decrypts automatically when accessed via `{config:…}`
