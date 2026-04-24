---
name: po-simple-element
description: Use when declaring a passive (non-interactive) element on a page object — labels, headers, read-only fields. Covers @CSGetElement with xpath primary + description + waitForVisible.
---

# Pattern: simple passive element on a page object

## When to use

Any read-only element: page title, section heading, displayed status label, badge, static text. No click, no fill, no type — the test only reads its text or verifies its visibility.

## Example

```typescript
import { CSBasePage, CSPage, CSGetElement } from '@mdakhan.mak/cs-playwright-test-framework/core';
import { CSWebElement } from '@mdakhan.mak/cs-playwright-test-framework/element';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';

@CSPage('order-confirmation')
export class OrderConfirmationPage extends CSBasePage {

    @CSGetElement({
        xpath: '//h1[@id="order-title"]',
        description: 'Order confirmation page title',
        waitForVisible: true,
    })
    public pageTitle!: CSWebElement;

    @CSGetElement({
        xpath: '//span[@data-testid="order-status"]',
        description: 'Order status badge',
    })
    public orderStatus!: CSWebElement;

    protected initializeElements(): void {
        CSReporter.debug('OrderConfirmationPage elements initialized');
    }

    public async verifyTitle(expected: string): Promise<void> {
        await this.pageTitle.waitForVisible(15000);
        const actual = (await this.pageTitle.textContentWithTimeout(5000)) ?? '';
        if (actual.trim() !== expected) {
            const msg = `Title mismatch: expected "${expected}", got "${actual.trim()}"`;
            CSReporter.fail(msg);
            throw new Error(msg);
        }
        CSReporter.pass(`Page title is "${expected}"`);
    }
}
```

## Rules

- `xpath` is always the primary locator
- `description` is required (human-readable, appears in logs)
- `waitForVisible: true` on elements that must be present when the page is considered loaded
- `selfHeal` is NOT needed for passive elements — save it for interactive ones
- Use `*WithTimeout` variants of CSWebElement methods, never bare versions
- Plain numeric literals — `15000` not `15_000`
