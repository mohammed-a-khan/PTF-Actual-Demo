---
name: iframe-nested
description: Use when a page object element lives inside an iframe (or nested iframes). Pass the frame chain to @CSGetElement via the `frame` option — the framework resolves the chain at runtime. Never use page.frame() or frameLocator() directly.
---

# Pattern: iframe / nested iframe element

## When to use

The element is inside an `<iframe>`. Common in:
- Embedded payment widgets (Stripe, Adyen)
- Third-party reporting dashboards
- Legacy app shells where the app is wrapped in a portal frame
- Nested frames (admin portal containing a frame containing the form)

The framework's `@CSGetElement` decorator accepts a `frame` option
that takes either a single selector or an array of selectors (for
nested iframes). The `CSFrameResolver` walks the chain at runtime,
re-resolving frames if they re-render.

## Working example — single iframe

```typescript
import { CSBasePage, CSElement, CSGetElement, CSPage, CSReporter } from '@mdakhan.mak/cs-playwright-test-framework';

@CSPage('checkout')
export class CheckoutPage extends CSBasePage {
    /**
     * Card number field lives inside the Stripe iframe. The `frame`
     * option points at the iframe; the framework switches into it
     * before every element interaction.
     */
    @CSGetElement({
        xpath: "//input[@name='cardnumber']",
        description: 'Stripe card number input',
        frame: "iframe[name='__privateStripeFrame']",
        selfHeal: true,
    })
    private cardNumberField!: CSElement;

    @CSGetElement({
        xpath: "//input[@name='exp-date']",
        description: 'Stripe card expiry input',
        frame: "iframe[name='__privateStripeFrame']",
        selfHeal: true,
    })
    private expiryField!: CSElement;

    public async fillCardDetails(card: string, expiry: string): Promise<void> {
        await this.cardNumberField.fillWithTimeout(card, 5000);
        await this.expiryField.fillWithTimeout(expiry, 5000);
        CSReporter.info('Filled Stripe card details');
    }
}
```

## Working example — nested iframes

```typescript
@CSPage('legacy-portal')
export class LegacyPortalPage extends CSBasePage {
    /**
     * The legacy admin portal wraps the app in a portal frame which
     * itself wraps the actual form in another frame. Pass an array
     * of frame selectors — the framework resolves them in order.
     */
    @CSGetElement({
        xpath: "//input[@id='userId']",
        description: 'User ID input (inside admin portal → users frame)',
        frame: [
            "iframe[name='portalFrame']",          // outer
            "iframe[id='usersWidgetFrame']",       // inner
        ],
        selfHeal: true,
    })
    private userIdField!: CSElement;

    /** Frame can also be selected by xpath if the iframe lacks a stable id/name. */
    @CSGetElement({
        xpath: "//button[normalize-space()='Save']",
        description: 'Save button (deeply nested)',
        frame: [
            "xpath=//iframe[contains(@src, '/portal/')]",
            "xpath=//iframe[contains(@src, '/users/')]",
        ],
    })
    private saveButton!: CSElement;
}
```

## Programmatic frame switching (CSBasePage helpers)

For step-level frame work that doesn't fit a page-object element:

```typescript
import { CSBDDStepDef, StepDefinitions, Page } from '@mdakhan.mak/cs-playwright-test-framework';

@StepDefinitions
export class PortalSteps {
    constructor(@Page('legacy-portal') private portal: LegacyPortalPage) {}

    @CSBDDStepDef('I switch to the users portal frame')
    async switchToUsersFrame(): Promise<void> {
        // CSBasePage.switchToFrame accepts string OR string[] (nested).
        await this.portal.switchToFrame([
            "iframe[name='portalFrame']",
            "iframe[id='usersWidgetFrame']",
        ]);
    }

    @CSBDDStepDef('I switch back to main frame')
    async switchToMain(): Promise<void> {
        await this.portal.switchToMainFrame();
    }
}
```

## Frame option signature

```typescript
@CSGetElement({
    xpath: '...',
    description: '...',
    frame: 'css-selector-of-iframe',           // single
    // OR
    frame: ['outer-iframe', 'inner-iframe'],   // nested chain
    // OR
    frame: { name: 'frameName' },              // object form (FrameSelector)
    // OR
    frame: [{ name: 'outer' }, { name: 'inner' }],
})
```

Selector forms supported per frame:
- Plain CSS: `"iframe[name='x']"`
- xpath: `"xpath=//iframe[contains(@src, '/admin/')]"`
- Object: `{ name: 'frameName' }`, `{ url: /pattern/ }`, `{ id: 'frameId' }`

## Forbidden patterns (audit rule WRAP100 fails the file)

```typescript
// ❌ NEVER — direct Playwright frame APIs
const frame = this.page.frame('frameName');
await frame.locator('#userId').fill('value');

const frame = this.page.frameLocator('iframe[name="x"]');
await frame.locator('#userId').fill('value');

await this.page.mainFrame().locator('...').click();
```

These bypass the framework's frame chain re-resolution (frames that
re-render mid-test silently fail without it), the self-heal hooks,
and CSReporter integration. Audit `WRAP100` blocks them.

## Common gotchas

1. **Frames re-render** — sometimes the iframe in the DOM is replaced
   between steps. The framework re-resolves the frame chain on every
   element call, so `selfHeal: true` is even more valuable inside
   frames than at top-level.
2. **Frame selector order matters.** Outermost frame first, innermost
   last. Reverse order = element not found.
3. **Cross-origin iframes** — if the iframe is from a different origin,
   browser sandbox rules apply. Some interactions (clipboard, file
   upload) are restricted. Test in a headed browser to debug.
4. **Don't mix `frame:` with manual `switchToFrame()`** — pick one
   approach per page. Manual switch + decorator-frame conflicts
   produce confusing "element not found" errors.
