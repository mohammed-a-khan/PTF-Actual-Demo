---
name: po-dynamic-element
description: Use when an element must be located at runtime (loop index, row number, dynamic label). Covers CSElementFactory for runtime element construction.
---

# Pattern: runtime-built element via CSElementFactory

## When to use

The locator depends on test-time data — e.g., "the row whose first cell contains `<userName>`", "the Nth result", "the button labelled `<scenario.action>`". Static `@CSGetElement` decorators can't express this. Use `CSElementFactory.createByXPath` in an action method.

## Example

```typescript
import { CSBasePage, CSPage, CSGetElement } from '@mdakhan.mak/cs-playwright-test-framework/core';
import { CSWebElement, CSElementFactory } from '@mdakhan.mak/cs-playwright-test-framework/element';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';

@CSPage('results-grid')
export class ResultsGridPage extends CSBasePage {

    @CSGetElement({
        xpath: '//table[@id="results"]',
        description: 'Results grid',
        waitForVisible: true,
    })
    public grid!: CSWebElement;

    public async clickRowByLabel(label: string): Promise<void> {
        const escaped = label.replace(/'/g, "\\'");
        const row = CSElementFactory.createByXPath(
            `//table[@id="results"]//tr[td[normalize-space(text())='${escaped}']]//a[1]`,
            `Results row: ${label}`,
            this.page
        );
        await row.clickWithTimeout(30000);
        CSReporter.info(`Clicked row labelled: ${label}`);
    }
}
```

## Rules

- `CSElementFactory.createByXPath(xpath, description, this.page)` — description is required, shows in logs
- Always escape user-supplied strings in xpath (`'` → `\\'`)
- Prefer static `@CSGetElement` when possible — reserve factory for genuinely dynamic cases
- The returned element has the same `*WithTimeout` surface as decorated elements
- For navigation clicks, still use 30000+ timeout
