---
name: po-self-healing-element
description: Use when declaring an interactive element (input, button, link, submit, checkbox, combobox) on a page object. Adds selfHeal + alternativeLocators for resilient locator fallback.
---

# Pattern: self-healing interactive element

## When to use

Any element the user clicks, types into, or selects. Buttons, inputs, submit controls, links, checkboxes, select dropdowns. Not needed for purely read labels or headers.

## Example

```typescript
import { CSBasePage, CSPage, CSGetElement } from '@mdakhan.mak/cs-playwright-test-framework/core';
import { CSWebElement } from '@mdakhan.mak/cs-playwright-test-framework/element';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';

@CSPage('login-form')
export class LoginFormPage extends CSBasePage {

    @CSGetElement({
        xpath: '//input[@id="userId"]',
        description: 'User Id input',
        waitForVisible: true,
        selfHeal: true,
        alternativeLocators: [
            'css:input#userId',
            'css:input[name="userId"]',
        ],
    })
    public userIdField!: CSWebElement;

    @CSGetElement({
        xpath: '//input[@id="password"]',
        description: 'Password input',
        waitForVisible: true,
        selfHeal: true,
        alternativeLocators: ['css:input#password', 'css:input[type="password"]'],
    })
    public passwordField!: CSWebElement;

    @CSGetElement({
        xpath: '//button[@id="signin-btn"]',
        description: 'Sign In submit button',
        waitForVisible: true,
        selfHeal: true,
        alternativeLocators: ['css:button#signin-btn', 'text:Sign In'],
    })
    public signInButton!: CSWebElement;

    protected initializeElements(): void {
        CSReporter.debug('LoginFormPage elements initialized');
    }

    public async login(userName: string, password: string): Promise<void> {
        await this.userIdField.waitForVisible(10000);
        await this.userIdField.clearWithTimeout(5000);
        await this.userIdField.fillWithTimeout(userName, 5000);
        await this.passwordField.clearWithTimeout(5000);
        await this.passwordField.fillWithTimeout(password, 5000);
        await this.signInButton.clickWithTimeout(30000);
        CSReporter.pass(`Login submitted for ${userName}`);
    }
}
```

## Rules

- `xpath` is primary; css/text variants go in `alternativeLocators`
- `selfHeal: true` on every interactive element
- `description` required
- For navigation-triggering clicks, use `clickWithTimeout(30000)` or higher — short timeouts time out on server-round-trip clicks
- Action methods call `*WithTimeout` variants, never bare `click()` / `fill()`
- On success call `CSReporter.pass(msg)`; on failure call `CSReporter.fail(msg)` then `throw new Error(msg)`
- Plain numeric literals — `30000` not `30_000`
- No `this.page.click(...)` or `this.page.locator(...)` — everything goes through the decorated element
