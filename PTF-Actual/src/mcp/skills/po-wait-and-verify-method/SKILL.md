---
name: po-wait-and-verify-method
description: Use when authoring a verification / assertion method on a page object. Covers waitForVisible + textContent + strict pass/fail pattern.
---

# Pattern: wait + verify method

## When to use

Any page-object method whose purpose is to assert the UI has reached an expected state — title correct, value displayed, item present.

## Example

```typescript
public async verifyTitle(expected: string): Promise<void> {
    await this.pageTitle.waitForVisible(15000);
    const actual = (await this.pageTitle.textContentWithTimeout(5000)) ?? '';
    const normalised = actual.replace(/\s+/g, ' ').trim();
    if (normalised !== expected) {
        const msg = `Title mismatch: expected "${expected}", got "${normalised}"`;
        CSReporter.fail(msg);
        throw new Error(msg);
    }
    CSReporter.pass(`Title is "${expected}"`);
}

public async verifyElementVisible(description: string, element: CSWebElement): Promise<void> {
    const visible = await element.isVisibleWithTimeout(10000);
    if (!visible) {
        const msg = `${description} not visible after 10s`;
        CSReporter.fail(msg);
        throw new Error(msg);
    }
    CSReporter.pass(`${description} is visible`);
}
```

## Rules

- `waitForVisible` BEFORE reading text — avoids reading from an element still rendering
- Normalise whitespace with `replace(/\s+/g, ' ').trim()` to avoid false negatives from stray newlines
- On failure: `CSReporter.fail(msg)` then `throw new Error(msg)` — same message string
- On success: `CSReporter.pass(msg)` — report reflects the verified state
- Never use bare `expect(...)` from `@playwright/test`
