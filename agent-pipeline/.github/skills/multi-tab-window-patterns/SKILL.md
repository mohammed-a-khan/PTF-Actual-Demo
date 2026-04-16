---
name: multi-tab-window-patterns
description: >
  Canonical patterns for multi-tab, multi-window, and popup
  handling in the target test framework. Covers switchToPage,
  switchToLatestPage, switchToMainPage, waitForNewPage,
  waitForPopup, closeCurrentPageAndSwitchTo, tab index
  tracking, race condition avoidance, and forbidden patterns.
  Load when generating, auditing, or healing any code that
  deals with more than one browser page at once.
---

# Multi-Tab and Window Patterns

## When this skill applies

Any generated code where the application opens a new browser
tab, a popup window, or a separate browser window during the
test flow. Typical triggers: links with `target="_blank"`,
`window.open()` calls, or export flows that open a report
viewer.

## The core principle

New pages have a race condition between the triggering action
and the `page` event. The framework's `waitForNewPage` and
`waitForPopup` helpers wrap the race safely. Never click a
new-tab trigger without wrapping it — bare clicks miss the
event and leave the test on the wrong page.

## Opening a new tab

Use `waitForNewPage` from `CSBasePage`:

```
public async openReportInNewTab(reportId: string): Promise<void> {
    await this.waitForNewPage(async () => {
        await this.linkOpenReport.click();
    });
    await this.waitForPageLoad();
    CSReporter.info(`Opened report ${reportId} in new tab`);
}
```

How it works:
1. The framework subscribes to the `page` event on the browser
   context BEFORE calling your action
2. Your action runs inside the callback
3. When the new page event fires, the framework auto-switches
   the "current page" pointer to the new tab
4. After your callback resolves, all subsequent page object
   calls operate on the new tab

The callback can do anything — click a link, submit a form,
call an API that triggers a popup. The framework catches the
new page regardless of the trigger.

## Opening a popup window

For `window.open()`-style popups, use `waitForPopup`:

```
public async openHelpPopup(): Promise<void> {
    await this.waitForPopup(async () => {
        await this.buttonHelp.click();
    });
    await this.waitForPageLoad();
    CSReporter.info('Opened help popup');
}
```

The difference: `waitForNewPage` listens on the browser
context's `page` event (catches both new tabs and popups),
while `waitForPopup` listens on the current page's `popup`
event (catches only `window.open` popups).

Use `waitForPopup` when you know the trigger calls
`window.open`. Use `waitForNewPage` for everything else
(`target="_blank"` links, form submissions, etc.).

## Switching between existing tabs

Once multiple tabs are open, switch between them explicitly:

```
// Switch by index (0 = first tab)
await this.switchToPage(0);

// Switch to the most recently opened tab
await this.switchToLatestPage();

// Switch back to the main (first) tab
await this.switchToMainPage();
```

Methods inherited from `CSBasePage`:
- `switchToPage(index)` — switch by zero-based index
- `switchToLatestPage()` — switch to last in `getPages()` array
- `switchToMainPage()` — switch to index 0
- `getCurrentPageIndex()` — returns current tab's index
- `getPages()` — returns array of all open pages
- `getPageCount()` — returns the number of open pages

## Tab index tracking

For scenarios where tab order matters, track indices in the
BDD context:

```
@When('I open the invoice in a new tab')
async openInvoiceInNewTab(): Promise<void> {
    const originalIndex = this.orderPage.getCurrentPageIndex();
    this.context.set('originalTabIndex', originalIndex);

    await this.orderPage.openInvoiceInNewTab();

    const newIndex = this.orderPage.getCurrentPageIndex();
    this.context.set('invoiceTabIndex', newIndex);
    CSReporter.info(`Opened invoice tab at index ${newIndex}`);
}

@When('I return to the order tab')
async returnToOrderTab(): Promise<void> {
    const originalIndex = this.context.get<number>('originalTabIndex')!;
    await this.orderPage.switchToPage(originalIndex);
    CSReporter.info(`Switched back to order tab at index ${originalIndex}`);
}
```

Track indices when:
- Flow alternates between tabs
- A later step needs to return to an earlier tab
- Cleanup needs to close a specific tab without losing
  position

Do NOT track indices when the flow is linear (open → verify →
close) — `switchToLatestPage` and `switchToMainPage` cover
most cases.

## Closing a tab

After finishing with a new tab, close it and switch back:

```
public async closeCurrentTabAndReturn(): Promise<void> {
    await this.closeCurrentPageAndSwitchTo(0);
    CSReporter.info('Closed current tab, switched to main');
}
```

The `closeCurrentPageAndSwitchTo(index)` method:
1. Switches to the target index FIRST
2. Then closes the formerly-current page

This order matters — closing first and then switching can
cause the framework to lose track of the active page.

Rules:
- Never close the main tab (index 0) in a step definition
- Never close all tabs (leaves the framework with no page)
- After closing a tab, always verify you're on the expected
  tab by checking `getCurrentPageIndex()` or verifying a page
  element

## Verification after a tab switch

After any tab switch, verify the expected page is now active.
The simplest verification is a page header check:

```
await this.invoicePage.switchToLatestPage();
await this.invoicePage.verifyHeader();
```

The framework's current-page pointer is updated by
`switchToPage` / `switchToLatestPage` etc., but the DOM on
the new tab may still be loading. Call `waitForPageLoad` or a
specific element wait before interacting.

## Common tab flows

### Open → act → return

```
await this.orderPage.openInvoiceInNewTab();
// Now on invoice tab
await this.invoicePage.verifyHeader();
const amount = await this.invoicePage.getTotalAmount();
// Close invoice tab
await this.invoicePage.closeCurrentPageAndSwitchTo(0);
// Back on order tab
await this.orderPage.verifyHeader();
```

### Open → verify → keep open for later steps

```
await this.orderPage.openAttachmentInNewTab();
this.context.set('attachmentTabIndex',
    this.orderPage.getCurrentPageIndex());
await this.attachmentPage.verifyHeader();

// Return to order tab to continue the main flow
await this.orderPage.switchToMainPage();
await this.orderPage.continueWithOrder();

// Later step switches back to attachment tab
const attachmentIndex = this.context.get<number>('attachmentTabIndex')!;
await this.attachmentPage.switchToPage(attachmentIndex);
```

### Popup with immediate dismiss

```
// Accept a confirmation popup immediately
await this.orderPage.acceptNextDialog();
await this.buttonSaveOrder.click();
// Dialog handled inline, no separate page to switch to
```

Note: browser dialogs (alerts, confirms, prompts) are NOT
separate pages — they're handled via `acceptNextDialog` /
`dismissNextDialog` on `CSBasePage`. See the dialog section
of `page-object-patterns`.

## Multiple windows (not tabs)

Some applications trigger truly separate browser windows via
`window.open('url', '_blank', 'popup')` with window features.
These are still treated as pages by the framework — the same
`waitForNewPage` / `switchToPage` methods apply.

For multi-browser scenarios (two different browsers, not two
tabs of the same browser), use `CSBrowserManager.switchBrowser`
— but those are rare and expensive.

## Cleanup

The framework cleans up all pages automatically at scenario
teardown. Manual tab closing is only needed for:
- Mid-scenario when a tab is genuinely finished
- Memory-sensitive tests where 10+ tabs accumulate
- Tests that verify tab-close behaviour

Do NOT add `closePage()` calls to every tab-opening step. The
framework handles cleanup.

## Forbidden patterns

Never do any of these in multi-tab code:

- Click a new-tab trigger without wrapping in `waitForNewPage`
  or `waitForPopup`
- Use `page.waitForEvent('page', ...)` manually — use the
  wrapper
- Switch tabs by assuming a specific index without checking
  `getPageCount()`
- Close all tabs (including the main tab)
- Assume `switchToLatestPage` points at a specific tab in
  tests with more than two tabs
- Track tab indices in module-level variables — use
  `CSBDDContext`
- Use raw Playwright `context.pages()` — use `getPages()`
  from `CSBasePage`
- Call `page.close()` on the main tab
- Leave a stale tab open at scenario end expecting the next
  scenario to inherit it (context isolation breaks this)

## Self-check before returning multi-tab code

- [ ] Every new-tab trigger is wrapped in `waitForNewPage` or
      `waitForPopup`
- [ ] Tab switches use `switchToPage(index)`,
      `switchToLatestPage()`, or `switchToMainPage()`
- [ ] Tab indices are tracked in `CSBDDContext`, not module
      state
- [ ] Every tab switch is followed by a page verification
- [ ] `closeCurrentPageAndSwitchTo(index)` used instead of
      `closePage()` + manual switch
- [ ] Main tab (index 0) is never closed
- [ ] No raw Playwright `context.pages()` or
      `waitForEvent('page', ...)` calls
- [ ] No assumptions about tab order beyond what
      `getCurrentPageIndex` reveals

If any item fails, fix it before returning. The audit checklist
tool enforces most of these rules.
