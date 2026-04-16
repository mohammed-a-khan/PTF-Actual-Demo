---
name: browser-navigation-patterns
description: >
  Canonical patterns for browser navigation and lifecycle in the
  target test framework. Covers CSBrowserManager singleton access,
  navigateAndWaitReady, spinner detection, browser launch and
  restart, page and tab management, context isolation, storage
  state save/load, and forbidden raw Playwright navigation calls.
  Load when generating, auditing, or healing any method that
  navigates, launches, or closes a browser resource.
---

# Browser Navigation Patterns

## When this skill applies

Any generated code that navigates to a URL, launches or closes
a browser, manages pages/tabs, or waits for application-level
loading indicators. Typically page object `navigate()` methods
and step definition setup.

## The CSBrowserManager singleton

All browser interaction goes through `CSBrowserManager`. Obtain
the singleton with `getInstance()`:

```
import { CSBrowserManager } from '<framework>/browser';

const browserManager = CSBrowserManager.getInstance();
```

Inside a page object, use the inherited `this.browserManager`
field (declared on `CSBasePage` as `protected`). Never construct
`CSBrowserManager` directly — the singleton owns the Playwright
browser and context lifecycle.

## Navigation

### navigateAndWaitReady — the only correct way to navigate

Always use `navigateAndWaitReady` instead of raw `page.goto`.
It handles:

- DNS and TCP settle time
- Initial `load` and `domcontentloaded` events
- Application-level spinner detection (via an optional selector)
- Post-navigation stability wait

```
await this.browserManager.navigateAndWaitReady(url);
```

With options:

```
await this.browserManager.navigateAndWaitReady(url, {
    waitForSpinner: true,
    spinnerSelector: '.loading-overlay',
    timeout: 30000
});
```

Common options:

- `waitForSpinner` — boolean, whether to wait for a spinner to
  disappear after navigation
- `spinnerSelector` — CSS selector of the application's loading
  indicator
- `timeout` — total navigation timeout in ms
- `waitUntil` — navigation event to wait for (`load`,
  `domcontentloaded`, `networkidle`)

### Page object navigate method

The typical pattern is a `navigate()` method on the page object
that opens that page's URL:

```
public async navigate(): Promise<void> {
    const url = this.config.getString('LOGIN_URL');
    await this.browserManager.navigateAndWaitReady(url, {
        waitForSpinner: true,
        spinnerSelector: '.spinner',
        timeout: this.config.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000)
    });
    await this.waitForPageLoad();
    CSReporter.info(`Navigated to: ${url}`);
}
```

The URL is resolved from config, not hardcoded. The timeout is
resolved from config with a reasonable default.

### Inherited navigation helpers on CSBasePage

`CSBasePage` exposes these inherited methods:

- `navigate(url?)` — navigate to the page's configured URL or
  to an explicit URL
- `refresh()` — reload the current page
- `goBack()` — browser back button
- `goForward()` — browser forward button
- `getTitle()` — current page title
- `getUrl()` — current page URL
- `isAt()` — boolean check for "are we on this page"
- `waitForPageLoad()` — wait for the page to stabilise after
  any navigation
- `executeScript(script, ...args)` — evaluate JavaScript in the
  page context

## Spinner handling

Applications typically show a loading indicator during AJAX
calls or navigation. The framework provides
`waitForSpinnersToDisappear(timeout?)` on `CSBrowserManager`:

```
await this.browserManager.waitForSpinnersToDisappear(30000);
```

This waits for any registered spinner selector to disappear.
The default selector is configured via `SPINNER_SELECTOR` in
config; for pages with a different spinner, pass a custom
selector option to `navigateAndWaitReady`.

### When to wait for spinners

- After clicking a button that triggers a server round-trip
- After navigating to a page that loads data immediately
- After submitting a form
- Before verifying any data-driven element

### When NOT to wait for spinners

- After a pure client-side action (opening a dropdown, toggling
  a tab inside the same page)
- When the spinner is transient and not always shown
- Inside tight loops where the wait would accumulate

Prefer waiting on the outcome element (`waitForVisible` on
the target) rather than the spinner when possible — it's more
specific.

## Browser lifecycle

### Launching

The framework launches the browser automatically when the first
test starts. Manual launch is rarely needed. When it is:

```
await this.browserManager.launch('chromium');
```

The browser type is read from `BROWSER_TYPE` config value by
default. Valid types: `chromium`, `firefox`, `webkit`.

### Switching browsers mid-run

Some scenarios need to open a second browser context for a
different user or a different domain:

```
await this.browserManager.switchBrowser({
    baseUrl: anotherAppUrl,
    reuseProfile: false
});
```

Use this sparingly — cross-browser scenarios are expensive and
fragile. Prefer running separate tests in parallel when
possible.

### Restarting

After a test fails with a browser crash, the next test can
recover by restarting:

```
await this.browserManager.restartBrowser();
```

The framework typically triggers this automatically on crash
detection; manual restart is only for unusual recovery flows.

### Closing

The framework handles cleanup automatically at the end of the
suite. Manual close is only needed if a specific scenario
must release resources early:

- `closePage()` — close the current page
- `closeContext(testStatus?, skipTraceSave?)` — close the
  current browser context and save trace/video if configured
- `closeBrowser()` — close the browser process
- `close(testStatus?)` — close everything for the current test
- `closeAll(finalStatus?)` — close everything for the suite

Never call `closeBrowser()` in a step definition unless the
scenario explicitly requires a fresh browser for the next
step.

## Context isolation

Each test scenario runs in its own browser context (isolated
cookies, storage, permissions). The framework handles context
creation and teardown automatically.

Access the underlying context when needed:

```
const context = this.browserManager.getContext();
```

Common uses:
- `context.cookies()` / `context.addCookies(...)` for cookie
  manipulation
- `context.storageState()` to capture session state
- `context.waitForEvent('page', ...)` for multi-tab scenarios
- `context.on('request', ...)` for network listeners (prefer
  `CSNetworkInterceptor` for this)

## Storage state (session reuse)

For scenarios that would otherwise re-login every time, save
the storage state after a successful login and reuse it in
subsequent tests:

```
// After login in a @CSBefore hook
await this.loginPage.loginWithCredentials(user, pass);
const statePath = await this.browserManager.saveStorageState();

// Before subsequent tests
await this.browserManager.loadStorageState(statePath);
```

The storage state includes cookies, local storage, session
storage, and IndexedDB snapshots. Save it once per session per
user role, reuse many times.

See `authentication-session-patterns` for the full session
reuse pattern.

## Current page access

When you need the raw Playwright `Page` object (e.g., to work
with a Playwright API not exposed by the framework), get it
from the browser manager:

```
const page = this.browserManager.getPage();
```

Inside a page object, prefer the inherited `this.page` getter
— it always returns the current page from the browser manager.

Use the raw page sparingly. Every time you reach for it, first
ask whether the framework exposes a wrapper for what you need.
Raw page calls bypass logging, screenshots, self-healing, and
retries.

## Multi-tab navigation

When an action opens a new tab, use the `waitForNewPage` helper
from `CSBasePage` (see `multi-tab-window-patterns` for full
coverage):

```
await this.waitForNewPage(async () => {
    await this.linkOpenInNewTab.click();
});
// Now on the new tab
```

The framework auto-switches to the new page when it opens.
Never click a new-tab trigger without wrapping it in
`waitForNewPage` — there's a race condition otherwise.

## Viewport management

For responsive testing, switch viewports via inherited helpers
on `CSBasePage`:

- `setDesktopViewport()` (1920x1080)
- `setLaptopViewport()` (1366x768)
- `setTabletViewport()` (768x1024)
- `setMobileViewport()` (375x667)
- `setViewportSize(width, height)` for custom sizes

Viewport changes do NOT re-navigate — the current page stays
loaded. Some applications need a reload after a viewport
change to pick up responsive layout; call `refresh()` if so.

## Forbidden patterns

Never do any of these in browser-related code:

- Call `page.goto(url)` directly — use
  `browserManager.navigateAndWaitReady(url)`
- Call `page.waitForSelector(...)` for spinners — use
  `waitForSpinnersToDisappear`
- Call `page.reload()` — use `refresh()` on `CSBasePage`
- Call `context.close()` or `browser.close()` in a step
  definition — let the framework handle lifecycle
- Hardcode URLs — always resolve from config
- Hardcode navigation timeouts — resolve from
  `BROWSER_NAVIGATION_TIMEOUT` config
- Use `setTimeout`/`setInterval` for wait loops — use the
  framework's `waitForCondition` or element-specific waits
- Construct `CSBrowserManager` directly — always use
  `getInstance()`
- Call `page.goto('about:blank')` to "clear" state — use
  context isolation or `clearContextAndReauthenticate`

## Self-check before returning navigation code

- [ ] Every navigation uses `navigateAndWaitReady`, never
      `page.goto`
- [ ] URLs are resolved from config, not hardcoded
- [ ] Timeouts are resolved from config with sensible defaults
- [ ] Spinner waits use `waitForSpinnersToDisappear`
- [ ] Page reload uses `refresh()` from `CSBasePage`
- [ ] Browser lifecycle calls (`close`, `restartBrowser`) are
      justified and commented
- [ ] Storage state save/load used for session reuse
- [ ] Multi-tab actions use `waitForNewPage` / `waitForPopup`
- [ ] Viewport changes use the inherited helper methods
- [ ] No raw Playwright `page.*` calls for navigation
- [ ] `CSBrowserManager` obtained via `getInstance()` or
      inherited `this.browserManager`

If any item fails, fix it before returning. The audit checklist
tool enforces most of these rules.
