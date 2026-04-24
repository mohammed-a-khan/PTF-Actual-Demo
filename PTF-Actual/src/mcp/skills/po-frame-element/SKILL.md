---
name: po-frame-element
description: Use when the page content lives inside one or more nested iframes. Covers CSFramePage with single-frame string and nested-frame array forms.
---

# Pattern: elements inside iframes

## When to use

The target screen's content is rendered inside an `<iframe>` — e.g., an embedded third-party widget, a rich-text editor iframe, or a legacy webform embedded in a host app. Any `@CSGetElement` on the page needs the frame context applied.

## Example — single iframe

```typescript
import { CSFramePage, CSPage, CSGetElement } from '@mdakhan.mak/cs-playwright-test-framework/core';
import { CSWebElement } from '@mdakhan.mak/cs-playwright-test-framework/element';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';

@CSPage('payment-widget')
export class PaymentWidgetPage extends CSFramePage {

    // All elements declared below inherit this frame context
    protected frame = { title: 'Payment Gateway' };

    @CSGetElement({
        xpath: '//input[@name="cardNumber"]',
        description: 'Card Number input',
        waitForVisible: true,
        selfHeal: true,
        alternativeLocators: ['css:input[name="cardNumber"]'],
    })
    public cardNumberInput!: CSWebElement;

    @CSGetElement({
        xpath: '//button[@type="submit"]',
        description: 'Submit payment',
        waitForVisible: true,
        selfHeal: true,
        alternativeLocators: ['text:Pay'],
    })
    public submitButton!: CSWebElement;

    public async pay(cardNumber: string): Promise<void> {
        await this.waitForFrameReady();
        await this.cardNumberInput.fillWithTimeout(cardNumber, 5000);
        await this.submitButton.clickWithTimeout(30000);
        CSReporter.pass('Payment submitted');
    }
}
```

## Example — nested iframes

```typescript
@CSPage('deep-editor')
export class DeepEditorPage extends CSFramePage {

    // Frame chain: outermost -> innermost. Strategies may be freely mixed.
    protected frame = [
        { id: 'appShell' },
        { name: 'workspaceFrame' },
        { title: 'Document Editor' },
    ];

    @CSGetElement({
        xpath: '//textarea[@id="body"]',
        description: 'Document body textarea',
        waitForVisible: true,
        selfHeal: true,
    })
    public bodyArea!: CSWebElement;
}
```

## Frame selector options

The `frame` property accepts either a single descriptor or an array of descriptors (outer to inner):

- String: `'//iframe[@title="Editor"]'` (xpath auto-detected), `'#frameId'` (css)
- Object with one of: `{ xpath, css, id, name, title, testId, src, index }`

## Rules

- Extend `CSFramePage` (NOT `CSBasePage`) when any element on the page lives inside an iframe
- `frame` is a `protected` class field, not a decorator option
- For nested frames, order the array outermost-first
- Call `this.waitForFrameReady()` before the first interaction
- All other page-object rules apply (xpath primary, selfHeal on interactive, descriptions, *WithTimeout methods)
