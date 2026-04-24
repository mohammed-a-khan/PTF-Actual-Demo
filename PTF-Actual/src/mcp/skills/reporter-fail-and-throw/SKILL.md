---
name: reporter-fail-and-throw
description: Use on any failure path in a step or page-object method. Covers the mandatory CSReporter.fail + throw Error pattern — never silent return, never raw expect.
---

# Pattern: failure path — `CSReporter.fail(msg)` then `throw new Error(msg)`

## When to use

Any place your code detects a condition that means the test has failed. Assertion mismatch, missing value, unexpected state, timeout on a required element. The pattern is always the same.

## Example

```typescript
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';

export class DashboardPage extends CSBasePage {

    @CSGetElement({
        xpath: '//h1[@id="dashboard-title"]',
        description: 'Dashboard title',
        waitForVisible: true,
    })
    public pageTitle!: CSWebElement;

    public async verifyOnDashboard(): Promise<void> {
        const expected = 'Dashboard';
        await this.pageTitle.waitForVisible(15000);
        const actual = (await this.pageTitle.textContentWithTimeout(5000)) ?? '';
        const normalised = actual.trim();
        if (normalised !== expected) {
            const msg = `Dashboard title mismatch: expected "${expected}", got "${normalised}"`;
            CSReporter.fail(msg);
            throw new Error(msg);
        }
        CSReporter.pass(`On Dashboard ("${expected}")`);
    }
}
```

## Success path — always `CSReporter.pass(msg)`

```typescript
// After an action verified to have succeeded
CSReporter.pass('User successfully logged in');
```

## Info / debug — for non-assertion logging

```typescript
// For progress, not a pass/fail judgement
CSReporter.info('Attempting login for user: ' + userName);
CSReporter.debug('Cache hit for LoginForm page elements');
```

## Rules

- **Every assertion path** either ends with `CSReporter.pass(msg)` or `CSReporter.fail(msg); throw new Error(msg);` — no silent return
- Error message passed to `CSReporter.fail()` and to `new Error()` is the **same string** — report reader sees the same text the test runner sees
- `CSReporter.fail()` alone is not enough — you must `throw` too. The `fail` call logs; the throw stops execution
- **No `expect(...)`** from `@playwright/test` — the framework's reporter owns assertions
- **No `console.log`** — use `CSReporter.info()` or `CSReporter.debug()`
- Error messages are actionable: include the expected and actual values, the element description, the scenario id if known
