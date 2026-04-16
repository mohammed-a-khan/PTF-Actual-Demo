---
name: page-object-patterns
description: >
  Canonical patterns for generating page object classes in the target
  TypeScript test framework. Covers file placement, class structure,
  the CSGetElement decorator and all element options, business-action
  methods, the full CSBasePage inherited wrapper surface (navigation,
  keyboard, mouse, scroll, viewport, dialogs, frames, multi-tab, waits,
  screenshots), download/upload handling, dynamic elements, and
  forbidden patterns. Load when generating, auditing, or healing any
  page object file.
---

# Page Object Patterns

## When this skill applies

Any generated or modified file that represents a page object in the
target test framework. Typically filenames ending in `Page.ts` and
located under `test/<project>/pages/`.

## File placement and naming

- Directory: `test/<project>/pages/`, or nested by module for larger
  projects (e.g., `test/<project>/pages/orders/`).
- Filename: `<PascalCaseModuleName>Page.ts`. The class name inside
  matches the filename without the `.ts` extension.
- One class per file. Never two page object classes in one file.
- Never create `index.ts` barrel files in the `pages/` folder. Each
  page is imported directly by its file path.

## Imports

Group imports in this exact order, one blank line between groups:

1. Framework core (base class, page decorator, element-getter decorator)
2. Framework element types (web element class, element factory)
3. Framework reporter (static reporter class)
4. Framework utilities (only what the page actually uses)
5. Local helper imports (if any)

Use module-specific submodule paths, never the framework's root
package. Typical imports for a page object file:

```
import { CSBasePage, CSPage, CSGetElement } from '<framework>/core';
import { CSWebElement, CSElementFactory } from '<framework>/element';
import { CSReporter } from '<framework>/reporter';
```

`<framework>` is the framework's package name; the install script
substitutes the real name when the template is deployed.

## Class shape

- Extends `CSBasePage`
- Annotated with `@CSPage('<identifier>')` — the identifier is a
  unique short string used by the `@Page` injection decorator in
  step definition files
- Elements are declared as `public` fields decorated with
  `@CSGetElement({ ... })`
- Implements the mandatory `initializeElements(): void` method. The
  body is typically a single `CSReporter.debug(...)` line. Omitting
  this method is a compile error — the base class declares it
  abstract.
- NEVER redeclares inherited protected properties: `page`,
  `browserManager`, `config`, `url`, `elements`. These are
  inherited from `CSBasePage` and shadowing them breaks the
  framework's internals.

Minimal shape:

```
@CSPage('login-page')
export class LoginPage extends CSBasePage {

    @CSGetElement({ xpath: "//input[@id='userId']",
        description: 'User ID text box' })
    public textBoxUserId!: CSWebElement;

    @CSGetElement({ xpath: "//input[@id='password']",
        description: 'Password text box' })
    public textBoxPassword!: CSWebElement;

    @CSGetElement({ xpath: "//button[@id='loginBtn']",
        description: 'Login button' })
    public buttonLogin!: CSWebElement;

    protected initializeElements(): void {
        CSReporter.debug('LoginPage elements initialized');
    }

    public async loginAs(user: string, password: string): Promise<void> {
        await this.textBoxUserId.fill(user);
        await this.textBoxPassword.fill(password);
        await this.buttonLogin.click();
        await this.waitForPageLoad();
        CSReporter.info(`Logged in as ${user}`);
    }
}
```

The `!:` non-null assertion is required because the framework
initialises decorated fields via reflection and TypeScript's strict
null checks don't see that initialisation.

## CSGetElement options

The `@CSGetElement` decorator takes an options object. All fields
are optional; the decorator uses the first-recognised locator and
falls back through any `alternativeLocators` array.

| Option | Type | Purpose |
|---|---|---|
| `xpath` | string | XPath locator |
| `css` | string | CSS selector |
| `text` | string | Match by visible text |
| `id` | string | Match by DOM id |
| `name` | string | Match by name attribute |
| `role` | string | Match by ARIA role + name |
| `testId` | string | Match by test-id attribute |
| `description` | string | Human-readable, used in reports (required) |
| `timeout` | number | Per-element default timeout (ms) |
| `waitForVisible` | boolean | Wait for visibility before each interaction |
| `waitForEnabled` | boolean | Wait for enabled state |
| `waitForStable` | boolean | Wait for layout stability |
| `scrollIntoView` | boolean | Auto-scroll before interacting |
| `retryCount` | number | Retry attempts on transient failure |
| `selfHeal` | boolean | Enable AI-assisted self-healing |
| `alternativeLocators` | string[] | Fallback locators with type prefix (`css:`, `xpath:`, `text:`) |
| `screenshot` | boolean | Capture a screenshot on interaction |
| `highlight` | boolean | Highlight the element in the browser during interaction |
| `force` | boolean | Bypass actionability checks |
| `frame` | string | Scope this element to a frame by selector |
| `tags` | string[] | Logical tags used for filtering and reporting |
| `debug` | boolean | Emit verbose debug logs for this element |

Prefer the most durable locator available: role + name (via `role`)
when the app exposes accessibility attributes, then `testId`, then
`id`, then a stable CSS class path, then XPath, then text. Always
provide `description`.

## Locator preferences

In order, most durable first:

1. Accessible role + name (via `role` option)
2. Test ID (via `testId` option)
3. Stable DOM id (via `id` option)
4. CSS class + structural context (via `css`)
5. Text content (via `text`)
6. XPath — last resort

When the live application is reachable, the analyzer and healer
agents query the accessibility tree via Playwright MCP and prefer
role-based locators for reconciled spec output.

## Element naming conventions

Prefix field names by element type. The convention is consistent
across all pages in the project:

- Text inputs: `textBox<Name>` — e.g., `textBoxUserId`
- Text areas: `textArea<Name>`
- Buttons: `button<Name>`
- Dropdowns: `dropDown<Name>` or `dropDownList<Name>` (pick one
  project-wide)
- Checkboxes: `checkBox<Name>`
- Radio buttons: `radioButton<Name>`
- Links: `link<Name>`
- Labels: `label<Name>`
- Values (read-only): `value<Name>`
- Headers: `header<Name>`
- Grids and tables: `grid<Name>` or `table<Name>`
- Icons: `icon<Name>`
- File inputs: `fileInput<Name>`
- Iframes: `iframe<Name>`

`<Name>` is PascalCase and describes the field's business role, not
its appearance. Prefer `buttonSubmitOrder` over `buttonBlueTopRight`.

## Dynamic elements

For elements whose locators depend on runtime values (a row in a
grid identified by a specific cell value, a button with a dynamic
label), use `CSElementFactory` inside the method. Do NOT store
dynamic elements as class fields.

```
public async openResultRow(value: string): Promise<void> {
    const row = CSElementFactory.createByXPath(
        `//table[@id='results']//tr[td[text()='${value}']]`,
        `Result row: ${value}`
    );
    await row.waitForVisible(15000);
    await row.click();
    CSReporter.info(`Opened result row: ${value}`);
}
```

`CSElementFactory` also exposes typed factories:
`createByCSS`, `createById`, `createByXPath`, `createByTestId`,
`createByRole`, `createByText`, `createByLabel`, `createByName`,
`createWithFilter`, `createWithTemplate`, `createNth`,
`createTableCell`, `createChained`, `createMultiple`,
`fromLocator`. Use the most specific factory for the pattern at hand.

## CSWebElement action methods

Core actions on a decorated element. All are async:

- `click(options?)`, `dblclick(options?)`, `rightClick(options?)`,
  `middleClick(options?)`, `tap(options?)`
- `hover(options?)`
- `press(key, options?)` — single-key press
- `pressSequentially(text, options?)` — keystroke-by-keystroke
- `type(text, options?)` — fast typing
- `fill(value, options?)` — clear-then-type
- `clear(options?)`
- `selectOption(values, options?)` — for `<select>` elements,
  accepts string, string array, `{ label }`, `{ value }`, `{ index }`
- `selectText(options?)`
- `check(options?)`, `uncheck(options?)`, `setChecked(checked, options?)`
- `setInputFiles(files, options?)`, `clearFiles()`
- `focus(options?)`, `blur(options?)`
- `dragTo(target, options?)`

Timeout-bearing variants are available on actions that need explicit
timeouts (`clickWithTimeout`, `fillWithTimeout`, `clearWithTimeout`).
Prefer the timeout variants in page object methods so every action
has a bounded wait.

## CSWebElement state methods

Boolean queries. All are async:

- `isVisible(options?)`, `isHidden(options?)`
- `isEnabled(options?)`, `isDisabled(options?)`
- `isEditable(options?)`
- `isChecked(options?)`

Use these in verification methods on the page object, not for
control flow that branches between two equally valid paths.

## CSWebElement data reader methods

- `getTextContent(options?)` — visible text content
- `getInnerText(options?)` — rendered text
- `getInnerHTML(options?)` — raw HTML
- `getAttribute(name, options?)`
- `getInputValue(options?)` — current value of an input
- `count()` — number of DOM elements matching the locator
- `getBoundingBox(options?)`

## CSWebElement wait methods

- `waitForVisible(timeout?)`
- `waitForHidden(timeout?)`
- `waitForEnabled(timeout?)`
- `waitForDisabled(timeout?)`
- `waitForEditable(timeout?)`
- `waitFor(options?)` — generic wait with a state option

Wait on the element (not a page-level wait-for-selector) whenever
possible — it respects the element's own locator resolution and
self-healing configuration.

## CSWebElement screenshot methods

- `screenshot(options?)` — returns a `Buffer`
- `screenshotToFile(path, options?)` — saves to disk and returns `Buffer`
- `screenshotFullPage()`

Use `takeScreenshot(name?)` from `CSBasePage` when you want the
full page. Use element screenshots when verifying a specific widget.

## CSWebElement frame methods

- `frameLocator(selector)` — returns a Playwright `FrameLocator`
  for chaining inside an iframe
- `contentFrame()` — returns the frame this element lives in

Prefer declaring frame-scoped elements with the `frame` option in
`@CSGetElement` instead of manually navigating through
`frameLocator` — the framework handles frame resolution and
self-healing for decorated elements.

## Inherited wrappers from CSBasePage

Every page object class inherits the full `CSBasePage` wrapper
surface. Use these methods instead of reaching for the raw
Playwright `Page` object. Calling the inherited wrapper is what
keeps logging, screenshots, reporting, and self-healing integrated.

### Navigation

- `navigate(url?)` — navigate to the page's url (set via
  `@CSPage` / config) or to an explicit url
- `waitForPageLoad()` — wait for the page to stabilise
- `isAt()` — boolean check for "are we on this page"
- `getTitle()`, `getUrl()`
- `refresh()`, `goBack()`, `goForward()`
- `takeScreenshot(name?)` — full-page screenshot with reporter attach
- `executeScript(script, ...args)` — evaluate in page context

### Cross-domain

- `waitForCrossDomainNavigation()`
- `getCrossDomainNavigationState()`
- `resetCrossDomainHandler()`
- `updatePageReference(newPage)`

### Keyboard

One method per common key plus generic `pressKey(key)`:

- `pressEscapeKey()`, `pressEnterKey()`, `pressTabKey()`,
  `pressShiftTabKey()`
- `pressBackspaceKey()`, `pressDeleteKey()`, `pressSpaceKey()`
- `pressArrowUpKey()`, `pressArrowDownKey()`,
  `pressArrowLeftKey()`, `pressArrowRightKey()`
- `pressHomeKey()`, `pressEndKey()`, `pressPageUpKey()`,
  `pressPageDownKey()`
- `pressKey(key)` — any key by name

Typing:

- `typeText(text)` — standard typing
- `typeTextSlowly(text, delayMs)` — throttled for fragile inputs
- `insertText(text)` — insert without per-key events

Modifier-and-hold:

- `holdKey(key)` — press-and-hold
- `releaseKey(key)` — release

Keyboard shortcuts (cross-platform, framework picks the right
modifier):

- `pressSelectAll()`, `pressCopy()`, `pressPaste()`, `pressCut()`
- `pressUndo()`, `pressRedo()`, `pressSave()`, `pressFind()`
- `pressF5Refresh()`, `pressF11Fullscreen()`

### Mouse

- `mouseMoveTo(x, y)`
- `mouseClickAt(x, y)`, `mouseDoubleClickAt(x, y)`,
  `mouseRightClickAt(x, y)`
- `mouseDown()`, `mouseUp()` — low-level press/release
- `mouseScrollVertical(deltaY)`, `mouseScrollHorizontal(deltaX)`
- `dragFromTo(fromX, fromY, toX, toY)`

For element-to-element drag, use the element-level
`dragTo(targetElement)` instead.

### Scroll

- `scrollDown(pixels?)`, `scrollUp(pixels?)` — default 300 px
- `scrollToTop()`, `scrollToBottom()`
- Per element: `element.scrollIntoView()` or the `scrollIntoView`
  option in `@CSGetElement`

### Viewport and window

- `setViewportSize(width, height)`
- `setDesktopViewport()` (1920x1080)
- `setLaptopViewport()` (1366x768)
- `setTabletViewport()` (768x1024)
- `setMobileViewport()` (375x667)
- `getViewportSize()`
- `bringToFront()`

### Dialogs (alert / confirm / prompt / beforeunload)

Dialog handling is built into `CSBasePage`. The pattern is:

1. Call `clearLastDialog()` before the action
2. Register a handler: `acceptNextDialog()`, `dismissNextDialog()`,
   or `acceptNextDialogWithText(text)`
3. Perform the action that triggers the dialog
4. Read the captured message via `getLastDialogMessage()` and the
   type via `getLastDialogType()` ('alert' / 'confirm' / 'prompt' /
   'beforeunload')

```
public async confirmDelete(): Promise<string | null> {
    this.clearLastDialog();
    await this.acceptNextDialog();
    await this.buttonDelete.click();
    const message = this.getLastDialogMessage();
    CSReporter.info(`Delete dialog message: ${message}`);
    return message;
}
```

For persistent handlers across many interactions, use
`alwaysAcceptDialogs()` or `alwaysDismissDialogs()` in a setup
method. Remember the handler stays registered on the current page
until the page navigates or closes.

### Multi-tab / window

Use when an action opens a new tab, popup, or window:

- `switchToPage(index)` — switch by index (0 = main)
- `switchToLatestPage()` — switch to the most recently opened tab
- `switchToMainPage()` — back to the first tab
- `getPages()`, `getPageCount()`, `getCurrentPageIndex()`
- `waitForNewPage(async () => { ... }, timeout?)` — run the action
  inside the callback, framework auto-switches when the new page
  opens, returns the new `Page`
- `waitForPopup(async () => { ... }, timeout?)` — same pattern for
  `window.open` popups
- `closeCurrentPageAndSwitchTo(switchToIndex?)` — close current tab
  and switch to another

Prefer `waitForNewPage` / `waitForPopup` over manual switch+wait
sequences. They handle the race condition between click and page
event automatically.

```
public async openLinkInNewTab(): Promise<void> {
    await this.waitForNewPage(async () => {
        await this.linkOpenInNewTab.click();
    });
    await this.waitForPageLoad();
    CSReporter.info('Switched to new tab');
}
```

### Frames / iframes

Three ways to work with frames:

**1. Frame-scoped element declaration** (preferred):

```
@CSGetElement({
    xpath: "//input[@id='cc-number']",
    description: 'Credit card number (in payment iframe)',
    frame: "iframe[title='Payment']"
})
public textBoxCardNumber!: CSWebElement;
```

The framework resolves the frame lazily and caches the
`FrameLocator`. Self-healing and retry still work.

**2. Manual frame switching** (when dynamic):

- `switchToFrame(selector)` — returns a `FrameLocator`
- `switchToFrameByName(nameOrId)` — returns a `Frame`
- `switchToMainFrame()` — exit frame context

**3. CSFramePage base class** — for page objects whose entire
content lives inside a single iframe. Extend `CSFramePage` instead
of `CSBasePage` and declare the frame selector in the class
header. All elements declared on the class are automatically
frame-scoped. Use this for heavy frame-based pages.

### Page-level waits

Beyond element waits, `CSBasePage` exposes page-level wait helpers:

- `wait(ms)` — simple milliseconds wait (use sparingly — prefer
  condition-based waits)
- `waitOneSecond()`, `waitTwoSeconds()`, `waitThreeSeconds()`,
  `waitFiveSeconds()` — semantic shortcuts
- `waitForUrlContains(urlPart, timeout?)`
- `waitForUrlEquals(url, timeout?)`
- `waitForSelector(selector, timeout?)`
- `waitForSelectorToDisappear(selector, timeout?)`
- `waitForNetworkIdle()`
- `waitForDomContentLoaded()`
- `waitForCondition(condition, timeout?)` — custom polling
- `waitForElementToAppear(element, timeout?)` — poll an element
- `waitForElementToDisappear(element, timeout?)`
- `waitForElementText(element, text, timeout?)`
- `waitForElementTextToDisappear(element, text, timeout?)`
- `waitForTableData(tableElement, noDataText?, timeout?)` —
  waits for a table to populate past its empty-state placeholder

Also on `CSBrowserManager`: `waitForSpinnersToDisappear(timeout?)`
for application-level loading indicators.

## Business-action method conventions

- Methods are `public async` and named by intent, not by element:
  - `loginAs(user, pass)` not `clickLoginButton()`
  - `exportReport()` not `clickExportAndWaitForDownload()`
  - `openOrderByNumber(number)` not `clickLinkWithText()`
- Method bodies use decorated elements or `CSElementFactory` and
  the inherited wrappers from `CSBasePage`.
- After any navigation inside a method, call `waitForPageLoad()`.
- Log each logical action via `CSReporter.info(...)` once per step.
- Return typed values when the method produces state (a new id, a
  downloaded file path, a row count). Return `Promise<void>` for
  pure side effects.

## Download handling

Use the `CSBrowserManager` download helper. The typical pattern:

```
public async exportToExcel(): Promise<string> {
    const download = await this.browserManager.captureDownload(async () => {
        await this.buttonExport.click();
    });
    const savedPath = download.savedPath;
    CSReporter.info(`Downloaded file saved to: ${savedPath}`);
    return savedPath;
}
```

Verify the filename pattern with a regex (downloads often contain
timestamps), and read content via `CSCsvUtility`, `CSExcelUtility`,
or framework file utilities when the test asserts on content.
Cleanup of downloaded files belongs in the test's `@CSAfter` hook,
not in the page object method.

## Upload handling

Use `setInputFiles` on the declared file input element:

```
public async uploadDocument(absolutePath: string): Promise<void> {
    await this.fileInputDocument.setInputFiles(absolutePath);
    await this.browserManager.waitForSpinnersToDisappear(30000);
    CSReporter.info(`Uploaded file: ${absolutePath}`);
}
```

For drag-and-drop uploads, use the framework's drag helpers (check
`file-download-upload-patterns` skill for full patterns). For
multi-file upload, pass an array of paths to `setInputFiles`.

## Verification methods

Page-level verifications live on the page object. Cross-page
verifications belong in step definitions.

```
public async verifyHeaderText(expected: string): Promise<void> {
    const actual = await this.headerPageTitle.getTextContent();
    await CSAssert.getInstance().assertEqual(
        (actual ?? '').trim(),
        expected,
        `Page header should be "${expected}"`
    );
}

public async verifyGridHasAtLeast(expectedMin: number): Promise<void> {
    const count = await this.gridResults.count();
    await CSAssert.getInstance().assertTrue(
        count >= expectedMin,
        `Grid should have at least ${expectedMin} rows, found ${count}`
    );
}
```

`CSAssert.getInstance()` exposes `assertTrue`, `assertFalse`,
`assertEqual`, `assertNotEqual`, `assertContains`, `assertVisible`,
`assertNotVisible`, `assertText`, `assertUrl`, `assertTitle`, and
`assertWithScreenshot`. Every method is async — always `await`.

## Forbidden patterns

Never do any of these in a page object:

- Raw Playwright API calls: `this.page.click(...)`, `this.page.fill(...)`,
  `this.page.goto(...)`, `this.page.waitForSelector(...)`,
  `this.page.keyboard.press(...)`, `this.page.mouse.click(...)`
- Inline XPath or CSS strings inside methods when a declared
  element would do (exception: truly dynamic elements via
  `CSElementFactory`)
- Hardcoded timer waits (`await new Promise(r => setTimeout(r, 1000))`) —
  use `waitForCondition`, element waits, or the semantic
  `waitOneSecond` helpers
- Database queries — those go in step definitions or helpers
- HTTP calls — those go in API test classes or helpers
- Redeclaring `page`, `browserManager`, `config`, `url`, `elements`
- `console.log`, `console.error` — use `CSReporter`
- Instantiating other page object classes inside methods. A method
  that navigates to another page completes its own flow and lets
  the step definition construct the next page
- Throwing on expected-absence checks (use `isHidden` or
  `isVisible` and return a boolean or assert explicitly)
- Missing `initializeElements()` implementation

## Self-check before returning a page object file

- [ ] Filename matches `<PascalCase>Page.ts`
- [ ] Class extends `CSBasePage` (or `CSFramePage` for frame-scoped
      pages)
- [ ] `@CSPage('<identifier>')` decorator present with unique id
- [ ] `initializeElements(): void` implemented with at least a
      debug log
- [ ] No inherited properties redeclared
- [ ] Every element uses `@CSGetElement` with `description`
- [ ] Element names follow the type-prefix convention
- [ ] Locator preference order respected (role/testId/id preferred
      over xpath/text)
- [ ] Dynamic elements use `CSElementFactory` inside methods
- [ ] Methods are named by business action, not element operation
- [ ] Every method uses inherited wrappers, never raw `this.page.*`
- [ ] Download methods use `browserManager.captureDownload(...)`
- [ ] Upload methods use `setInputFiles`
- [ ] Frame elements use `frame` option in `@CSGetElement` or
      extend `CSFramePage`
- [ ] Dialog handlers follow the clear-register-act-read pattern
- [ ] Multi-tab flows use `waitForNewPage` / `waitForPopup`
- [ ] Each method reports once via `CSReporter.info`
- [ ] No `console.log`, no raw timers, no DB or API calls
- [ ] Imports are module-specific, grouped, and have no unused entries
- [ ] No `index.ts` created alongside this file

If any item fails, fix it before calling `npx tsc --noEmit` via `run_in_terminal`. The
audit checklist enforces most of these rules.
