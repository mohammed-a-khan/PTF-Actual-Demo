---
name: sd-step-with-db-precondition
description: Use when a Given step resolves data from the database before driving UI — "Given a user with role X exists".
---

# Pattern: step definition with DB precondition

## When to use

Self-sufficient scenarios whose setup requires real database state (role lookup, active deal lookup, existing entity resolution). The step queries DB, stores the result on scenario context, then later steps consume it.

## Example

```gherkin
Given an active user with role "ACCOUNT_REP" exists
When I login as the resolved user
Then the account rep dashboard opens
```

```typescript
import {
    CSBDDStepDef,
    Page,
    StepDefinitions,
    CSBDDContext,
} from '@mdakhan.mak/cs-playwright-test-framework/bdd';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';
import { UserDatabaseHelper } from '../../helpers/UserDatabaseHelper';
import { LoginFormPage } from '../../pages/login/LoginFormPage';

@StepDefinitions
export class AuthSetupSteps {

    @Page('login-form')
    private loginPage!: LoginFormPage;

    private context = CSBDDContext.getInstance();

    @CSBDDStepDef('an active user with role {string} exists')
    async resolveActiveUserWithRole(role: string): Promise<void> {
        const user = await UserDatabaseHelper.findFirstActiveUserWithRole(role);
        if (!user) {
            const msg = `No active user with role ${role} in the test database`;
            CSReporter.fail(msg);
            throw new Error(msg);
        }
        this.context.setVariable('resolvedUser', user);
        CSReporter.pass(`Resolved user: ${user.email} (${role})`);
    }

    @CSBDDStepDef('I login as the resolved user')
    async loginAsResolved(): Promise<void> {
        const user = this.context.getVariable('resolvedUser') as { email: string };
        if (!user) {
            const msg = 'resolvedUser not set on scenario context';
            CSReporter.fail(msg);
            throw new Error(msg);
        }
        await this.loginPage.login(user.email, /* password via VDI hook */ '');
    }
}
```

## Rules

- DB access ONLY via a helper method — never inline SQL in the step
- If the expected row isn't found, fail loudly — do NOT create the row with an INSERT (DB writes are out of scope per project policy)
- Store the resolved entity on `CSBDDContext` under a descriptive key (`resolvedUser`, not `u`)
- Downstream steps read the same key and fail if unset
