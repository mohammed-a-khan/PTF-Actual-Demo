---
name: reporter-pass-on-success
description: Use on every success path. CSReporter.pass with a specific, actionable message that surfaces in the HTML report.
---

# Pattern: report success with `CSReporter.pass`

## When to use

Every page-object method / step-def / helper that reaches its happy-path end state should end with a `CSReporter.pass(msg)` call. The test runner's HTML report is built from these messages.

## Example

```typescript
public async approvePayment(paymentId: string): Promise<void> {
    await this.approveButton.waitForVisible(10000);
    await this.approveButton.clickWithTimeout(30000);
    await this.confirmationBanner.waitForVisible(15000);
    const banner = (await this.confirmationBanner.textContentWithTimeout(5000)) ?? '';
    if (!banner.includes('approved')) {
        const msg = `Expected approval confirmation, got: ${banner}`;
        CSReporter.fail(msg);
        throw new Error(msg);
    }
    CSReporter.pass(`Payment ${paymentId} approved — banner: "${banner.trim()}"`);
}
```

## What makes a good pass message

- **Specific**: include the entity id, the expected outcome, any verified value
- **Past-tense / verified**: "Payment X approved", "Dashboard opened", not "Clicking button"
- **Actionable on failure**: when the test later fails elsewhere, a good pass message in the report tells the debugger what worked
- **Short**: one line, < ~120 chars

## Rules

- Pair every pass with a guarded condition — don't blanket-log pass without verifying
- If you wouldn't be confident telling the user the step succeeded, don't call `pass`
- Never log raw secrets (passwords, tokens) — redact or omit
- Use `CSReporter.info(...)` for mid-flight progress updates (typing, clicking) and reserve `pass` for end-state confirmation
