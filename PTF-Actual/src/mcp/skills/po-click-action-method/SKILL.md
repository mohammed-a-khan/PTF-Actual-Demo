---
name: po-click-action-method
description: Use when authoring a click action on a page object. Covers clickWithTimeout with the correct long-timeout convention for navigation-triggering clicks.
---

# Pattern: click action method

## When to use

Any method on a page object that performs a click — navigation link, submit button, row link, tab switch. Separate waits + assertions into their own methods.

## Example

```typescript
public async clickSignIn(): Promise<void> {
    await this.signInButton.waitForVisible(10000);
    await this.signInButton.clickWithTimeout(30000);   // nav click — long budget
    CSReporter.info('Clicked Sign In');
}

public async clickRowByIndex(index: number): Promise<void> {
    await this.resultsRows.waitForVisible(10000);
    const cells = await this.resultsRows.locator(`xpath=//tbody/tr[${index + 1}]`);
    await cells.click();
    CSReporter.info(`Clicked row ${index}`);
}
```

## Rules

- Use `clickWithTimeout(30000)` or higher for clicks that trigger page load or server round-trip. Short timeouts (5000) are only safe for purely-client-side controls
- Always `waitForVisible` before the click — eliminates a class of timing flakes
- Call `CSReporter.info(...)` so the click appears in the test report
- Never use bare `click()` — always the `*WithTimeout` variant
- Never call `this.page.click(...)` directly
