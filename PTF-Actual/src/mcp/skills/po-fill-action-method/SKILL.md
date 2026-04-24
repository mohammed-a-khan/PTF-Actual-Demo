---
name: po-fill-action-method
description: Use when authoring a fill / type action on a page object. Covers clear + fillWithTimeout sequence.
---

# Pattern: fill action method

## When to use

Any method that types into an input. The standard sequence is wait → clear → fill → optional reporter line.

## Example

```typescript
public async enterUserName(userName: string): Promise<void> {
    await this.userIdField.waitForVisible(10000);
    await this.userIdField.clearWithTimeout(5000);
    await this.userIdField.fillWithTimeout(userName, 5000);
    CSReporter.info(`Entered user id: ${userName}`);
}

public async enterCredentials(userName: string, password: string): Promise<void> {
    await this.enterUserName(userName);
    await this.passwordField.clearWithTimeout(5000);
    await this.passwordField.fillWithTimeout(password, 5000);
    CSReporter.info('Credentials entered');
}
```

## Rules

- Always clear before fill — prevents residue from prior values
- Use `fillWithTimeout`, not bare `fill()`
- Never log the raw password value; log a redacted marker if needed (`CSReporter.info('Password entered (redacted)')`)
- Short timeouts (5000) are fine — fill is purely client-side
