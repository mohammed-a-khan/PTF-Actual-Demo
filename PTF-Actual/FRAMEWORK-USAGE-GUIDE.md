# CS Playwright Test Framework - Complete Usage Guide

## Table of Contents

- [Framework Overview](#framework-overview)
  - [Architecture](#architecture)
  - [Module Overview](#module-overview)
- [Installation](#installation)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
  - [Browser Configuration](#browser-configuration)
  - [Media Configuration](#media-configuration)
  - [Smart Wait Configuration](#smart-wait-configuration)
  - [Log Levels](#log-levels)
- [Page Objects](#page-objects)
  - [Generic Element Waits](#generic-element-waits)
- [Iframe Support](#iframe-support)
- [Element Interactions](#element-interactions)
- [Wait Strategies](#wait-strategies)
  - [CSSmartPoller](#cssmartpoller)
- [Browser Management](#browser-management)
- [Spec Format Tests](#spec-format-tests)
  - [Step-by-Step Guide](#step-by-step-guide)
- [BDD/Cucumber Tests](#bddcucumber-tests)
- [Data-Driven Testing](#data-driven-testing)
  - [Environment Interpolation](#environment-interpolation)
- [Test Dependencies](#test-dependencies)
- [API Testing](#api-testing)
  - [Authentication](#authentication)
  - [File Upload/Download](#file-uploaddownload)
- [API Validators](#api-validators)
- [Database Testing](#database-testing)
  - [Database Configuration](#database-configuration)
  - [CSDBUtils](#csdbutils)
- [SOAP Testing](#soap-testing)
- [Parallel Execution](#parallel-execution)
  - [Worker Configuration](#worker-configuration)
- [Suite Execution](#suite-execution)
- [Pipeline & CI/CD](#pipeline--cicd)
- [AI & Self-Healing](#ai--self-healing)
- [Reporting & Evidence](#reporting--evidence)
- [ADO Integration](#ado-integration)
- [Performance Testing](#performance-testing)
- [Visual Testing](#visual-testing)
- [Mobile Testing](#mobile-testing)
- [Variable Interpolation](#variable-interpolation)
- [Secret Masking](#secret-masking)
- [Data Management](#data-management)
- [Authentication](#authentication-1)
- [Page Diagnostics](#page-diagnostics)
- [Utility Classes](#utility-classes)
- [Assertions](#assertions)
- [Network Interception](#network-interception)
- [CLI Commands](#cli-commands)
- [API Reference](#api-reference)
- [Best Practices](#best-practices)

---

## Framework Overview

CS Playwright Test Framework is an enterprise-grade, AI-powered test automation framework built on top of Microsoft Playwright. It provides a comprehensive solution for web, API, and database testing with intelligent self-healing capabilities, multi-format test support, and seamless Azure DevOps integration.

> **Why CS Playwright Test Framework?**
> Built for enterprise teams who need reliable, maintainable, and scalable test automation. The framework eliminates common pain points like flaky tests (via AI self-healing), complex setup (via unified configuration), and limited reporting (via ADO integration and rich HTML reports).

### Core Philosophy

- **Convention over Configuration** - Sensible defaults that work out of the box, with full customization available
- **Test Format Flexibility** - Write tests in Spec format (developers) or BDD/Gherkin (business stakeholders)
- **Self-Healing by Design** - AI-powered element recovery reduces test maintenance by up to 80%
- **Enterprise Integration** - Native Azure DevOps integration for test plans, results, and work items
- **Full Stack Testing** - UI, API, Database, and SOAP testing in a single framework

### Key Capabilities

- **8-Level Configuration Hierarchy** - CLI, Environment, Project, Common, Global levels
- **Smart Wait System** - DOM stability, network idle, spinner, animation detection
- **Page Object Model** - Decorator-based page objects with element self-healing
- **64-Dimension Feature Extraction** - Advanced element matching for healing
- **Natural Language Element Finding** - Describe elements in plain English
- **Performance Testing** - Load, stress, spike tests with Core Web Vitals
- **Visual Testing** - Baseline comparison with pixel-level accuracy

### Architecture

The framework follows a layered architecture with clear separation of concerns:

| Layer | Purpose | Key Components |
|-------|---------|----------------|
| **Test Layer** | Where test code lives - either Spec format or BDD format | CSSpecRunner, CSBDDRunner, describe/test/Given/When/Then |
| **Orchestration** | Manages test execution order, parallelization, and data iteration | CSParallelManager, CSSuiteRunner, CSSpecDataIterator |
| **Fixture Layer** | Provides test fixtures (page objects, API clients, DB connections) | CSBrowserManager, CSAPIClient, CSDatabaseManager |
| **Core Services** | Cross-cutting concerns: config, reporting, evidence collection | CSConfigurationManager, CSReporter, CSEvidenceCollector |
| **Interaction** | Element interactions with smart waiting and navigation | CSElement, CSSmartWait, CSNavigationManager |
| **AI & Intelligence** | Self-healing, feature extraction, and failure prediction | CSSelfHealingEngine, CSFeatureExtractor, CSFailurePredictor |
| **Foundation** | Underlying Playwright browser automation engine | Playwright Browser, Context, Page APIs |

### Module Overview

The framework is organized into focused modules, each handling a specific domain:

#### Core Modules

| Module | Import Path | Purpose |
|--------|-------------|---------|
| **core** | `@framework/core` | Configuration management, context handling, base utilities |
| **spec** | `@framework/spec` | Spec format test runner: describe(), test(), hooks, fixtures |
| **bdd** | `@framework/bdd` | BDD/Cucumber runner: Given/When/Then, feature parsing, step definitions |
| **browser** | `@framework/browser` | Browser lifecycle, context management, page creation |
| **element** | `@framework/element` | Element interactions (click, fill, select), action tracking |

#### Testing Modules

| Module | Import Path | Purpose |
|--------|-------------|---------|
| **api** | `@framework/api` | REST API testing: CSAPIClient, request/response handling, validators |
| **database** | `@framework/database` | Multi-DB support: SQL Server, Oracle, MySQL, PostgreSQL, MongoDB |
| **data** | `@framework/data` | Data providers: CSV, JSON, Excel, XML, API, Database sources |
| **assertions** | `@framework/assertions` | Extended assertions: expect(), custom matchers, soft assertions |

#### Intelligence Modules

| Module | Import Path | Purpose |
|--------|-------------|---------|
| **ai** | `@framework/ai` | AI services: natural language element finding, GPT integration |
| **self-healing** | `@framework/self-healing` | 8-strategy healing engine, feature extraction, healing store |
| **wait** | `@framework/wait` | Smart wait system: DOM stability, network idle, custom conditions |

> **Import Shorthand**: Replace `@framework/` with `@mdakhan.mak/cs-playwright-test-framework/` in actual imports.

---

## Installation

### Prerequisites

- Node.js 20.0.0 or higher
- npm 8.0.0 or higher

### Install the Framework

```bash
# Install from npm registry
npm install @mdakhan.mak/cs-playwright-test-framework

# Install Playwright browsers
npx playwright install
```

### Optional Dependencies

```bash
# For Excel file support
npm install exceljs

# For database testing
npm install mssql mysql2 pg oracledb mongodb redis

# For image processing (visual testing)
npm install sharp
```

---

## Project Structure

```
my-test-project/
├── config/
│   └── myproject/
│       ├── common/
│       │   └── common.env          # Shared configuration
│       └── environments/
│           ├── dev.env             # Development environment
│           ├── qa.env              # QA environment
│           └── prod.env            # Production environment
├── test/
│   └── myproject/
│       ├── pages/                  # Page Objects
│       │   ├── LoginPage.ts
│       │   └── DashboardPage.ts
│       ├── specs/                  # Spec format tests
│       │   ├── login.spec.ts
│       │   └── dashboard.spec.ts
│       ├── features/               # BDD feature files
│       │   └── login.feature
│       ├── steps/                  # Step definitions
│       │   └── login.steps.ts
│       └── data/                   # Test data files
│           ├── users.csv
│           └── users.json
├── reports/                        # Generated reports
└── package.json
```

---

## Configuration

### Configuration Hierarchy

Configuration is loaded with the following priority (highest to lowest):

1. **CLI Arguments** - `--tags=@smoke`
2. **Environment Variables** - `export BROWSER=chrome`
3. **Project Environment** - `config/project/environments/dev.env`
4. **Project Common** - `config/project/common/common.env`
5. **Global Environment** - `config/global/environments/dev.env`
6. **Global Common** - `config/global/common/common.env`

### Browser Configuration

#### Core Browser Options

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `BROWSER` | string | chrome | Browser engine: `chromium`, `chrome`, `firefox`, `webkit`, `safari`, `edge` |
| `HEADLESS` | boolean | false | Run browser in headless mode (no UI) |
| `BROWSER_LAUNCH_TIMEOUT` | number | 30000 | Browser launch timeout in milliseconds |
| `BROWSER_SLOWMO` | number | 0 | Slow down operations by specified milliseconds |
| `BROWSER_DEVTOOLS` | boolean | false | Open browser DevTools automatically |
| `BROWSER_REUSE_ENABLED` | boolean | false | Reuse browser instance across tests |

#### Viewport & Display Options

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `BROWSER_VIEWPORT_WIDTH` | number | 1920 | Browser viewport width in pixels |
| `BROWSER_VIEWPORT_HEIGHT` | number | 1080 | Browser viewport height in pixels |
| `BROWSER_COLOR_SCHEME` | string | light | Color scheme: `light`, `dark`, `no-preference` |
| `BROWSER_LOCALE` | string | en-US | Browser locale |
| `BROWSER_TIMEZONE` | string | America/New_York | Browser timezone ID |

#### Timeout Configuration

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `BROWSER_ACTION_TIMEOUT` | number | 10000 | Default timeout for element actions |
| `BROWSER_NAVIGATION_TIMEOUT` | number | 30000 | Timeout for page navigation operations |
| `DEFAULT_TIMEOUT` | number | 10000 | General default timeout used by elements |

#### Example Configuration

```bash
# Browser setup for CI/CD pipeline
BROWSER=chromium
HEADLESS=true
BROWSER_NO_SANDBOX=true
BROWSER_DISABLE_GPU=true
BROWSER_VIEWPORT_WIDTH=1920
BROWSER_VIEWPORT_HEIGHT=1080

# Timeouts
BROWSER_ACTION_TIMEOUT=15000
BROWSER_NAVIGATION_TIMEOUT=60000

# Proxy for corporate network
BROWSER_PROXY_ENABLED=true
BROWSER_PROXY_SERVER=http://proxy.corp.example.com:8080
BROWSER_PROXY_BYPASS=*.internal.com,localhost

# Locale and timezone
BROWSER_LOCALE=en-GB
BROWSER_TIMEZONE=Europe/London
```

### Media Configuration

#### Video Recording

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `BROWSER_VIDEO` | string | off | Video recording mode: `off`, `never`, `always`, `retain-on-failure` |
| `BROWSER_VIDEO_WIDTH` | number | 1280 | Video capture width in pixels |
| `BROWSER_VIDEO_HEIGHT` | number | 720 | Video capture height in pixels |

#### Trace Recording

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `TRACE_CAPTURE_MODE` | string | never | Trace mode: `never`, `always`, `retain-on-failure` |

#### Screenshot Configuration

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `SCREENSHOT_ON_FAILURE` | boolean | true | Capture screenshot on test failure |
| `SCREENSHOT_ON_PASS` | boolean | false | Capture screenshot on test pass |
| `SCREENSHOT_FULL_PAGE` | boolean | false | Capture full page screenshot |

### Smart Wait Configuration

Smart Wait automatically handles element visibility, stability, spinners, animations, and network activity before interacting with elements.

#### Smart Wait Levels

| Level | Description | Use Case |
|-------|-------------|----------|
| `off` | Disabled | Maximum speed, stable apps |
| `minimal` | Basic waits (Default) | Fast execution with essential stability |
| `standard` | Balanced | Most applications, good balance |
| `strict` | Maximum reliability | Complex SPAs, highly dynamic pages |

#### Environment Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `SMART_WAIT_LEVEL` | string | minimal | Smart wait level |
| `SMART_WAIT_DEFAULT_TIMEOUT` | number | 10000 | Default timeout for smart wait operations (ms) |
| `SMART_WAIT_SPINNER_SELECTORS` | string | .spinner,.loading,.loader | CSS selectors for spinner elements |

### Log Levels

| Level | Outputs | Use Case |
|-------|---------|----------|
| `DEBUG` | DEBUG, INFO, WARN, ERROR, PASS, FAIL | Development and troubleshooting |
| `INFO` | INFO, WARN, ERROR, PASS, FAIL | Normal execution - recommended for CI/CD |
| `WARN` | WARN, ERROR, PASS, FAIL | Only warnings and errors |
| `ERROR` | ERROR, FAIL | Only errors - minimal output |

---

## Page Objects

### Creating a Page Object

```typescript
import { CSBasePage, CSPage, CSGetElement, CSGetElements, CSWebElement } from '@mdakhan.mak/cs-playwright-test-framework';

@CSPage('login')
export class LoginPage extends CSBasePage {

    @CSGetElement({
        css: 'input[name="username"]',
        description: 'Username input field',
        waitForVisible: true,
        selfHeal: true,
        alternativeLocators: [
            'xpath://input[@name="username"]',
            'placeholder:Username',
            'aria-label:Username'
        ]
    })
    public usernameField!: CSWebElement;

    @CSGetElement({
        css: 'input[name="password"]',
        description: 'Password input field',
        waitForVisible: true,
        selfHeal: true
    })
    public passwordField!: CSWebElement;

    @CSGetElement({
        css: 'button[type="submit"]',
        text: 'Login',
        role: 'button',
        selfHeal: true
    })
    public loginButton!: CSWebElement;

    @CSGetElements({
        css: '.error-message',
        description: 'Error messages on the page'
    })
    public errorMessages!: CSWebElement[];

    // Page methods
    public async login(username: string, password: string): Promise<void> {
        await this.usernameField.fill(username);
        await this.passwordField.fill(password);
        await this.loginButton.click();
    }

    public async verifyLoginSuccess(): Promise<void> {
        await this.page.waitForURL('**/dashboard**');
        CSReporter.pass('Login successful');
    }
}
```

### @CSGetElement Options

| Option | Type | Description |
|--------|------|-------------|
| `css` | string | CSS selector |
| `xpath` | string | XPath selector |
| `text` | string | Text content matcher |
| `role` | string | ARIA role (button, textbox, etc.) |
| `testId` | string | data-testid attribute |
| `placeholder` | string | Placeholder text |
| `label` | string | Associated label text |
| `description` | string | Human-readable description |
| `waitForVisible` | boolean | Wait for element visibility |
| `waitForEnabled` | boolean | Wait for element to be enabled |
| `selfHeal` | boolean | Enable AI self-healing |
| `alternativeLocators` | string[] | Fallback locators |
| `timeout` | number | Element-specific timeout (ms) |
| `frame` | string/FrameSelector | Frame selector for elements inside iframes |

### Generic Element Waits

These methods use `CSSmartPoller` internally to poll for element states:

| Method | Description |
|--------|-------------|
| `waitForElementToAppear(element, timeout?)` | Wait for element to become visible |
| `waitForElementToDisappear(element, timeout?)` | Wait for element to be hidden |
| `waitForElementText(element, text, timeout?)` | Wait for element to contain specific text |
| `waitForTableData(tableElement, noDataText?, timeout?)` | Wait for table to show actual data |

```typescript
// Wait for loading complete
test('Wait for loading complete', async ({ dashboardPage }) => {
    await dashboardPage.waitForElementToDisappear(dashboardPage.loadingSpinner);

    const result = await dashboardPage.waitForElementToAppear(dashboardPage.dataTable);
    if (result.success) {
        console.log(`Table appeared after ${result.elapsed}ms`);
    }
});
```

---

## Iframe Support

The framework provides comprehensive support for working with elements inside iframes.

### Option 1: Frame Parameter in @CSGetElement

```typescript
@CSPage('checkout')
export class CheckoutPage extends CSBasePage {

    @CSGetElement({
        xpath: '//input[@name="cardNumber"]',
        frame: '//iframe[@title="Payment Gateway"]',
        description: 'Card number input'
    })
    public cardNumberInput!: CSWebElement;

    @CSGetElement({
        css: '#expiry-date',
        frame: 'iframe#payment-frame',
        description: 'Expiry date input'
    })
    public expiryInput!: CSWebElement;
}
```

### Option 2: CSFramePage Base Class

```typescript
@CSPage('payment-iframe')
export class PaymentIframePage extends CSFramePage {
    protected frame = '//iframe[@title="Payment Gateway"]';

    @CSGetElement({
        xpath: '//input[@name="cardNumber"]',
        description: 'Card number input'
    })
    public cardNumberInput!: CSWebElement;

    @CSGetElement({
        xpath: '//input[@name="expiryDate"]',
        description: 'Expiry date input'
    })
    public expiryInput!: CSWebElement;
}
```

### FrameSelector Options

| Option | Type | Description | Example |
|--------|------|-------------|---------|
| `xpath` | string | XPath selector for iframe | `{ xpath: '//iframe[@title="Editor"]' }` |
| `css` | string | CSS selector for iframe | `{ css: 'iframe.editor-frame' }` |
| `id` | string | Iframe ID attribute | `{ id: 'payment-frame' }` |
| `name` | string | Iframe name attribute | `{ name: 'editorFrame' }` |
| `title` | string | Iframe title attribute | `{ title: 'Document Editor' }` |
| `testId` | string | data-testid attribute | `{ testId: 'editor-iframe' }` |

---

## Element Interactions

CSWebElement wraps Playwright's Locator with 200+ convenience methods.

### Click Operations

| Method | Description |
|--------|-------------|
| `click(options?)` | Standard click with auto-wait and retry |
| `dblclick(options?)` | Double-click the element |
| `tap(options?)` | Tap for touch-enabled devices |
| `hover(options?)` | Hover over the element |
| `clickWithForce()` | Click bypassing actionability checks |
| `clickWithTimeout(timeout)` | Click with custom timeout |
| `clickAndWaitForNavigation()` | Click and wait for page load |
| `clickAndWaitForResponse(urlPattern)` | Click and wait for API response |
| `clickIfVisible()` | Click only if element is visible |

### Input Operations

| Method | Description |
|--------|-------------|
| `fill(value)` | Clear and fill input with value |
| `pressSequentially(text, options?)` | Type text character by character |
| `press(key)` | Press a keyboard key |
| `clear()` | Clear input field content |
| `setInputFiles(files)` | Set files for file input |
| `fillAndTab(value)` | Fill and press Tab key |
| `fillAndEnter(value)` | Fill and press Enter key |

### Selection Operations

| Method | Description |
|--------|-------------|
| `selectOption(values)` | Select option(s) by value, label, or index |
| `selectByValue(value)` | Select option by value attribute |
| `selectByText(text)` | Select option by visible text |
| `selectByIndex(index)` | Select option by zero-based index |
| `check()` | Check a checkbox |
| `uncheck()` | Uncheck a checkbox |
| `setChecked(checked)` | Set checkbox to specific state |

### State & Property Methods

| Method | Return Type | Description |
|--------|-------------|-------------|
| `isVisible()` | boolean | Check if element is visible |
| `isEnabled()` | boolean | Check if element is enabled |
| `isChecked()` | boolean | Check if checkbox/radio is checked |
| `exists()` | boolean | Check if element exists in DOM |
| `textContent()` | string | Get text content |
| `inputValue()` | string | Get input/textarea value |
| `getAttribute(name)` | string/null | Get attribute value |
| `hasClass(className)` | boolean | Check if has CSS class |

### Wait Operations

| Method | Description |
|--------|-------------|
| `waitFor(options?)` | Wait for element state |
| `waitForVisible(timeout?)` | Wait until element becomes visible |
| `waitForHidden(timeout?)` | Wait until element disappears |
| `waitForEnabled(timeout?)` | Wait until element is enabled |
| `waitForText(text, timeout?)` | Wait for element to contain text |

---

## Wait Strategies

### CSSmartWait

The framework includes an intelligent wait system that monitors multiple signals for page stability.

#### Smart Wait Levels

| Level | Description | Use Case |
|-------|-------------|----------|
| `off` | No smart waiting | Maximum speed, stable apps |
| `minimal` | Network idle only | Default - balanced approach |
| `standard` | Network + DOM stability | Dynamic apps with AJAX |
| `strict` | Full detection | Complex SPAs |

#### CSSmartWait Methods

| Method | Description |
|--------|-------------|
| `getInstance(page)` | Get instance for page |
| `setLevel(level)` | Set wait level |
| `waitForPageReady()` | Wait for page to be ready |
| `waitForNetworkIdle(timeout?)` | Wait for network to be idle |
| `waitForDomStable(timeout?)` | Wait for DOM to stop changing |
| `waitForNoSpinners(timeout?)` | Wait for loading spinners to disappear |
| `waitForNoAnimations(timeout?)` | Wait for animations to complete |

### CSSmartPoller

CSSmartPoller provides flexible polling with backoff strategies.

#### Backoff Strategies

| Strategy | Description | Best For |
|----------|-------------|----------|
| `none` | Fixed interval (default) | Fast-changing UI, short waits |
| `linear` | Interval increases linearly | Medium-length waits |
| `exponential` | Interval doubles each attempt | API polling, slow operations |
| `fibonacci` | Interval follows fibonacci sequence | Gradual backoff, long waits |

```typescript
import { CSSmartPoller } from '@mdakhan.mak/cs-playwright-test-framework/wait';

const poller = new CSSmartPoller(page);

const result = await poller.poll({
    condition: async () => {
        const count = await page.locator('.data-row').count();
        return count >= 5;
    },
    timeout: 30000,
    interval: 500,
    backoff: 'exponential',
    maxInterval: 10000,
    message: 'Wait for data rows to load'
});
```

---

## Browser Management

CSBrowserManager provides comprehensive browser lifecycle management.

### Supported Browsers

| Browser | Config Value | Description |
|---------|--------------|-------------|
| Chromium | `chromium` | Default Playwright Chromium |
| Chrome | `chrome` | Google Chrome (installed) |
| Edge | `edge` | Microsoft Edge (installed) |
| Firefox | `firefox` | Mozilla Firefox |
| WebKit | `webkit` | WebKit engine (Safari-like) |

### CSBrowserManager Methods

| Method | Description |
|--------|-------------|
| `getInstance()` | Get singleton instance (worker-aware) |
| `initialize(options?)` | Initialize browser with options |
| `getPage()` | Get current active page |
| `getContext()` | Get current browser context |
| `switchBrowser(browserType)` | Switch to different browser |
| `createNewContext(options?)` | Create new browser context |
| `createNewPage()` | Create new page in current context |
| `clearContextAndReauthenticate()` | Clear cookies/storage for new session |
| `setCookies(cookies)` | Set browser cookies |
| `saveStorageState(path)` | Save storage state to file |
| `setStorageState(path)` | Load storage state from file |
| `setGeolocation(latitude, longitude)` | Set geolocation |
| `setViewport(width, height)` | Set viewport size |

---

## Spec Format Tests

The Spec format provides a Playwright-aligned testing API with automatic fixture injection.

### Step-by-Step Guide

#### Step 1: Project Structure

```
test/
└── myproject/
    ├── pages/                    # Page Objects
    │   ├── LoginPage.ts
    │   └── DashboardPage.ts
    ├── specs/                    # Spec Test Files
    │   └── login.spec.ts
    ├── data/                     # Test Data
    │   └── users.csv
    ├── fixtures.d.ts             # Auto-generated
    └── myproject.env             # Environment config
```

#### Step 2: Create Page Objects

```typescript
// test/myproject/pages/LoginPage.ts
import { CSBasePage, CSPage, CSGetElement } from '@mdakhan.mak/cs-playwright-test-framework/core';
import { CSWebElement } from '@mdakhan.mak/cs-playwright-test-framework/element';

@CSPage('login')  // This creates fixture: loginPage
export class LoginPage extends CSBasePage {

    @CSGetElement({
        css: 'input[name="username"]',
        description: 'Username input',
        waitForVisible: true,
        selfHeal: true
    })
    public usernameInput!: CSWebElement;

    @CSGetElement({
        css: 'input[name="password"]',
        description: 'Password input'
    })
    public passwordInput!: CSWebElement;

    @CSGetElement({
        css: 'button[type="submit"]',
        description: 'Login button'
    })
    public loginButton!: CSWebElement;

    public async login(username: string, password: string): Promise<void> {
        await this.usernameInput.fill(username);
        await this.passwordInput.fill(password);
        await this.loginButton.click();
    }
}
```

#### Step 3: Create Spec Test File

```typescript
// test/myproject/specs/login.spec.ts
import { describe, test, beforeEach } from '@mdakhan.mak/cs-playwright-test-framework/spec';

describe('Login Feature', {
    tags: ['@login', '@smoke', '@TestPlanId:100']
}, () => {

    beforeEach(async ({ navigate, config }) => {
        const baseUrl = config.get('BASE_URL');
        await navigate(baseUrl);
    });

    test('TC001: Valid login with correct credentials', {
        tags: ['@TC001', '@critical', '@TestCaseId:101']
    }, async ({ loginPage, dashboardPage, reporter, config }) => {

        await test.step('Enter username', async () => {
            await loginPage.enterUsername('Admin');
        });

        await test.step('Enter password', async () => {
            const password = config.get('APP_PASSWORD', 'admin123');
            await loginPage.enterPassword(password);
        });

        await test.step('Click login button', async () => {
            await loginPage.clickLoginButton();
        });

        await test.step('Verify dashboard is displayed', async () => {
            await dashboardPage.verifyDashboardLoaded();
        });

        reporter.pass('Login test completed successfully');
    });
});
```

#### Step 4: Generate Typed Fixtures

```bash
npx cs-playwright-test generate-fixtures --project=myproject
```

#### Step 5: Run Tests

```bash
# Run all tests
npx cs-playwright-test --project=myproject --specs=test/myproject/specs/**/*.spec.ts

# Run by tags
npx cs-playwright-test --project=myproject --specs=test/**/*.spec.ts --tags="@smoke"

# Run in parallel
npx cs-playwright-test --project=myproject --specs=test/**/*.spec.ts --parallel --workers=4
```

### Auto-Injected Fixtures

| Fixture | Type | Description |
|---------|------|-------------|
| `page` | Page | Playwright page instance |
| `config` | CSConfigurationManager | Configuration access |
| `reporter` | CSReporter | Test reporting |
| `expect` | CSExpect | Assertions with auto-screenshots |
| `navigate` | function | Navigate to URL |
| `browserManager` | CSBrowserManager | Browser control |
| `ctx` | CSContext | Test context for sharing data |
| `data` | object | Current data row in data-driven tests |
| `iteration` | object | Iteration info: index, current, total |
| `db` | CSDatabaseManager | Database operations |
| `apiClient` | CSAPIClient | API testing client |

### Execution Modes

#### describe.serial() - Sequential Execution

```typescript
describe.serial('Login Flow - Dependent Steps', {
    tags: ['@serial', '@login']
}, () => {

    test('Step 1: Navigate to login', async ({ loginPage, ctx }) => {
        await loginPage.navigate();
        ctx.set('navigated', true);
    });

    test('Step 2: Enter credentials', async ({ loginPage, ctx }) => {
        if (!ctx.get('navigated')) throw new Error('Step 1 failed');
        await loginPage.login('Admin', 'admin123');
    });
});
```

#### describe.parallel() - Parallel Execution

```typescript
describe.parallel('Independent Module Tests', {
    tags: ['@parallel', '@modules']
}, () => {

    test('Navigate to Admin module', async ({ loginPage, dashboardPage }) => {
        await loginPage.login('Admin', 'admin123');
        await dashboardPage.clickMenuItem('Admin');
    });

    test('Navigate to PIM module', async ({ loginPage, dashboardPage }) => {
        await loginPage.login('Admin', 'admin123');
        await dashboardPage.clickMenuItem('PIM');
    });
});
```

### Test Annotations

| Annotation | Description | Effect |
|------------|-------------|--------|
| `test.skip(title, reason, fn)` | Skip test with reason | Test skipped |
| `test.fixme(title, reason, fn)` | Mark as broken | Test skipped, flagged |
| `test.fail(title, reason, fn)` | Expected to fail | Failure = pass |
| `test.slow(title, fn)` | Slow test | 3x timeout |

---

## BDD/Cucumber Tests

### Feature File

```gherkin
@login @smoke
Feature: User Authentication
  As a user I want to login to the application

  Background:
    Given I navigate to the login page

  @TC001 @critical
  Scenario: Successful login with valid credentials
    When I enter username "Admin"
    And I enter password "{config:PASSWORD}"
    And I click the login button
    Then I should see the dashboard
    And the welcome message should contain "Admin"

  @TC003 @data-driven
  Scenario Outline: Login with different users
    When I enter username "<username>"
    And I enter password "<password>"
    And I click the login button
    Then I should see the "<expected>" result

    Examples:
      | username | password  | expected  |
      | Admin    | admin123  | success   |
      | User1    | user123   | success   |
      | Invalid  | wrong     | error     |
```

### Step Definitions

```typescript
import { CSBDDStepDef, Page, StepDefinitions } from '@mdakhan.mak/cs-playwright-test-framework/bdd';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';

@StepDefinitions
export class LoginSteps {

    @Page('login')
    private loginPage!: LoginPage;

    @CSBDDStepDef('I navigate to the login page')
    async navigateToLogin() {
        await this.loginPage.navigate();
        CSReporter.pass('Navigated to login page');
    }

    @CSBDDStepDef('I enter username {string}')
    async enterUsername(username: string) {
        await this.loginPage.enterUsername(username);
    }

    @CSBDDStepDef('I enter password {string}')
    async enterPassword(password: string) {
        await this.loginPage.enterPassword(password);
    }

    @CSBDDStepDef('I click the login button')
    async clickLogin() {
        await this.loginPage.clickLoginButton();
    }

    @CSBDDStepDef('I should see the dashboard')
    async verifyDashboard() {
        await this.dashboardPage.verifyLoaded();
        CSReporter.pass('Dashboard is visible');
    }
}
```

### BDD External Data Sources

Use the `@DataProvider` tag on a Scenario Outline:

```gherkin
# CSV Data Source
@DataProvider(source="test/data/users.csv", type="csv")
Scenario Outline: Login with CSV data
  Given I am on the login page
  When I enter username "<username>" and password "<password>"
  Then I should see "<expected>" result

  Examples:
    | username | password | expected |

# Excel Data Source with specific sheet
@DataProvider(source="test/data/users.xlsx", type="excel", sheet="LoginData")
Scenario Outline: Login with Excel data
  ...

# JSON Data Source with JSONPath
@DataProvider(source="test/data/users.json", type="json", path="$.testcases[*]")
Scenario Outline: Login with JSON data
  ...
```

---

## Data-Driven Testing

### Data Source Types

| Type | Description | Options |
|------|-------------|---------|
| `inline` | Array of objects defined in code | `data`: Array of row objects |
| `csv` | CSV file | `source`: File path |
| `json` | JSON file with JSONPath selector | `source`, `path`: JSONPath expression |
| `excel` | Excel file (.xlsx) | `source`, `sheet`: Sheet name |
| `xml` | XML file with XPath selector | `source`, `xpath`: XPath expression |
| `database` | Database query | `connection`, `query`: SQL query |
| `api` | API endpoint | `url`, `method`, `path`: JSONPath |

### Inline Data Array

```typescript
describe('Login with inline data', {
    tags: ['@inline-data'],
    dataSource: {
        type: 'inline',
        data: [
            { username: 'Admin', password: 'admin123', expectedResult: 'success' },
            { username: 'Invalid', password: 'wrong', expectedResult: 'failure' }
        ]
    }
}, () => {
    test('Login with {username}', async ({ loginPage, data }) => {
        await loginPage.login(data.username, data.password);
    });
});
```

### CSV Data Source

```typescript
describe('Login with CSV data', {
    dataSource: {
        type: 'csv',
        source: 'test/myproject/data/users.csv'
    }
}, () => {
    test('Login with CSV row', async ({ loginPage, data, iteration }) => {
        console.log(`Iteration ${iteration.current}/${iteration.total}`);
        await loginPage.login(data.username, data.password);
    });
});
```

### Environment Interpolation

The framework supports `{env}` placeholder interpolation in data source file paths:

```typescript
describe('Login with environment-specific data', {
    dataSource: {
        type: 'json',
        source: 'test/myproject/data/{env}/users.json',
        path: '$.users[*]'
    }
}, () => {
    test('Login with environment data', async ({ loginPage, data }) => {
        await loginPage.login(data.username, data.password);
    });
});
```

Run with different environments:

```bash
ENVIRONMENT=sit npm run test
ENVIRONMENT=uat npm run test
```

### Data Filtering

| Operator | Name | Syntax | Example |
|----------|------|--------|---------|
| `=` | Equals | `field=value` | `status=active` |
| `!=` | Not Equals | `field!=value` | `status!=disabled` |
| `>` | Greater Than | `field>value` | `priority>2` |
| `<` | Less Than | `field<value` | `priority<5` |
| `>=` | Greater or Equal | `field>=value` | `priority>=3` |
| `<=` | Less or Equal | `field<=value` | `priority<=2` |
| `~` | Contains | `field~value` | `tags~smoke` |
| `:` | In List | `field:val1,val2` | `role:Admin,Manager` |
| `&` | AND | `filter1&filter2` | `active=true&priority<=2` |
| `|` | OR | `filter1|filter2` | `role=Admin|role=Manager` |

```typescript
describe('Filtered data tests', {
    dataSource: {
        type: 'csv',
        source: 'test/data/tests.csv',
        filter: 'executeTest=true&priority<=2&status!=skipped'
    }
}, () => {
    // Only matching rows will be used
});
```

---

## Test Dependencies

### Using dependsOn Option

```typescript
describe('Workflow with dependencies', {
    mode: 'serial'
}, () => {
    test('Setup: Create user', {
        tags: ['@setup']
    }, async ({ ctx }) => {
        ctx.set('userId', 'user-123');
    });

    test('Verify: User exists', {
        tags: ['@verify'],
        dependsOn: '@setup'
    }, async ({ ctx }) => {
        const userId = ctx.get('userId');
        // verify user...
    });

    test('Update: Modify user', {
        dependsOn: ['@setup', '@verify']
    }, async ({ ctx }) => {
        // update user...
    });
});
```

---

## API Testing

CSAPIClient provides comprehensive HTTP client capabilities for REST API testing.

### CSAPIClient Methods

| Method | Description |
|--------|-------------|
| `getInstance()` | Get singleton instance |
| `get(url, options?)` | HTTP GET request |
| `post(url, body?, options?)` | HTTP POST request |
| `put(url, body?, options?)` | HTTP PUT request |
| `patch(url, body?, options?)` | HTTP PATCH request |
| `delete(url, options?)` | HTTP DELETE request |
| `setBaseUrl(url)` | Set base URL for all requests |
| `setAuth(config)` | Set authentication |
| `setDefaultHeaders(headers)` | Set default headers |
| `builder(url)` | Create request builder for fluent API |
| `uploadFile(url, file, fieldName, data?)` | Upload file with multipart form |
| `downloadFile(url, savePath)` | Download file to path |

### Basic Requests

```typescript
import { CSAPIClient } from '@mdakhan.mak/cs-playwright-test-framework/api';

test('API operations', async ({ reporter }) => {
    const api = CSAPIClient.getInstance();
    api.setBaseUrl('https://api.example.com');
    api.setAuth({ type: 'bearer', credentials: { token: 'abc123' } });

    // GET request
    const users = await api.get('/users');

    // GET with query params
    const filtered = await api.get('/users', {
        params: { status: 'active', page: 1, limit: 10 }
    });

    // POST request
    const newUser = await api.post('/users', {
        name: 'John Doe',
        email: 'john@example.com'
    });
});
```

### Authentication

| Type | Description | Credentials Required |
|------|-------------|---------------------|
| `basic` | HTTP Basic Authentication | `username`, `password` |
| `bearer` | Bearer Token Authentication | `token` |
| `apikey` | API Key in header or query param | `apiKey` + `headerName` or `parameterName` |
| `oauth2` | OAuth 2.0 Authentication | `clientId`, `clientSecret`, `tokenUrl` |
| `digest` | HTTP Digest Authentication | `username`, `password` |
| `jwt` | JSON Web Token | `token` or generation params |
| `aws` | AWS Signature (v2 or v4) | `accessKey`, `secretKey`, `region`, `service` |
| `ntlm` | Windows NTLM Authentication | `username`, `password`, `domain` |
| `certificate` | Client Certificate (mTLS) | `certificate`, `privateKey`, `passphrase` |

```typescript
// Basic Authentication
api.setAuth({
    type: 'basic',
    credentials: { username: 'admin', password: 'secret123' }
});

// Bearer Token
api.setAuth({
    type: 'bearer',
    credentials: { token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' }
});

// OAuth2 - Client Credentials
api.setAuth({
    type: 'oauth2',
    credentials: {
        clientId: 'your-client-id',
        clientSecret: 'your-client-secret'
    },
    options: {
        tokenUrl: 'https://auth.example.com/oauth/token',
        grantType: 'client_credentials',
        scope: 'read write'
    }
});
```

### File Upload/Download

```typescript
// Simple file upload
const response = await api.uploadFile(
    '/api/upload',
    '/path/to/file.pdf',
    'document',
    { description: 'My document' }
);

// Download file to disk
await api.downloadFile('/api/files/123', '/path/to/save/report.pdf');

// Browser-based file upload
test('Upload file via browser', async ({ page }) => {
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles('/path/to/document.pdf');
});
```

---

## API Validators

### CSSchemaValidator

Validates API responses against JSON Schema specifications.

```typescript
import { CSSchemaValidator } from '@mdakhan.mak/cs-playwright-test-framework/api';

const schemaValidator = new CSSchemaValidator();
const result = schemaValidator.validate(response, {
    schema: {
        type: 'object',
        required: ['id', 'name', 'email'],
        properties: {
            id: { type: 'integer' },
            name: { type: 'string', minLength: 1 },
            email: { type: 'string', format: 'email' }
        }
    },
    strict: true,
    validateFormats: true
});
```

### CSJSONPathValidator

Validates specific paths in JSON responses using JSONPath expressions.

```typescript
import { CSJSONPathValidator } from '@mdakhan.mak/cs-playwright-test-framework/api';

const pathValidator = new CSJSONPathValidator();
const result = pathValidator.validate(response, {
    multiple: [
        { path: '$.data', type: 'array' },
        { path: '$.data[0].id', type: 'number' },
        { path: '$.data[*].email', pattern: /@.*\.com$/ },
        { path: '$.data', length: { min: 1, max: 100 } }
    ]
});
```

### CSStatusCodeValidator

```typescript
import { CSStatusCodeValidator } from '@mdakhan.mak/cs-playwright-test-framework/api';

const statusValidator = new CSStatusCodeValidator();
const result = statusValidator.validate(response, {
    category: 'success',
    not: [204]
});
```

### CSHeaderValidator

```typescript
import { CSHeaderValidator } from '@mdakhan.mak/cs-playwright-test-framework/api';

const headerValidator = new CSHeaderValidator();
const result = headerValidator.validate(response, {
    security: {
        contentSecurityPolicy: true,
        strictTransportSecurity: { maxAge: 31536000 },
        xContentTypeOptions: true,
        xFrameOptions: 'DENY'
    }
});
```

---

## Database Testing

CSDatabase provides unified database access for multiple database types.

### Supported Databases

| Database | Type Value | Default Port | Required Package |
|----------|-----------|--------------|------------------|
| SQL Server | `sqlserver` | 1433 | mssql (included) |
| MySQL | `mysql` | 3306 | mysql2 (optional) |
| PostgreSQL | `postgresql` | 5432 | pg (optional) |
| Oracle | `oracle` | 1521 | oracledb (optional) |
| MongoDB | `mongodb` | 27017 | mongodb (optional) |
| Redis | `redis` | 6379 | redis (optional) |

### CSDatabase Methods

| Method | Description |
|--------|-------------|
| `getInstance(alias?)` | Get database instance by alias |
| `create(config, alias)` | Create new database connection |
| `connect()` | Establish database connection |
| `disconnect()` | Close database connection |
| `query(sql, params?, options?)` | Execute SQL query with parameters |
| `execute(sql, params?)` | Execute SQL statement |
| `executeStoredProcedure(name, params?)` | Call stored procedure |
| `bulkInsert(table, data, options?)` | Bulk insert records |
| `beginTransaction(options?)` | Start transaction |
| `commitTransaction()` | Commit transaction |
| `rollbackTransaction(savepoint?)` | Rollback transaction |
| `exportResult(result, format, path)` | Export result to file |

### Database Configuration

All database configuration uses the pattern `DB_{ALIAS}_{OPTION}`:

| Variable Pattern | Type | Description |
|-----------------|------|-------------|
| `DB_{ALIAS}_TYPE` | string | Database type |
| `DB_{ALIAS}_HOST` | string | Database server hostname |
| `DB_{ALIAS}_PORT` | number | Database port |
| `DB_{ALIAS}_DATABASE` | string | Database name |
| `DB_{ALIAS}_USERNAME` | string | Database username |
| `DB_{ALIAS}_PASSWORD` | string | Database password |

### Basic Usage

```typescript
import { CSDatabase } from '@mdakhan.mak/cs-playwright-test-framework/database';

test('Database operations', async ({ reporter }) => {
    const db = await CSDatabase.getInstance('MYDB');

    // Simple query
    const users = await db.query('SELECT * FROM users WHERE active = @active', {
        active: true
    });

    // Insert with transaction
    await db.beginTransaction();
    try {
        await db.execute('INSERT INTO users (name, email) VALUES (@name, @email)', {
            name: 'John',
            email: 'john@example.com'
        });
        await db.commitTransaction();
    } catch (error) {
        await db.rollbackTransaction();
        throw error;
    }

    await db.disconnect();
});
```

---

## SOAP Testing

```typescript
import { CSSoapClient } from '@mdakhan.mak/cs-playwright-test-framework/api';

const soapClient = new CSSoapClient({
    wsdlUrl: 'https://example.com/service?wsdl',
    endpoint: 'https://example.com/service'
});

// Initialize client
await soapClient.initialize();

// Make SOAP request
const response = await soapClient.call('GetUser', {
    userId: '123'
});

console.log('Response:', response.result);
```

---

## Parallel Execution

### Worker Configuration

```yaml
# suite.yaml
execution:
  parallel: true
  workers: 4
  workerStrategy: round-robin  # or 'least-busy'
  isolationLevel: context      # 'browser', 'context', or 'page'
```

Environment variables:

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PARALLEL_WORKERS` | number | 4 | Number of parallel workers |
| `PARALLEL_ENABLED` | boolean | false | Enable parallel execution |
| `WORKER_STRATEGY` | string | round-robin | Worker assignment strategy |

---

## Suite Execution

### Suite YAML Configuration

```yaml
# suite.yaml
name: "Smoke Test Suite"
description: "Critical path verification"
version: "1.0.0"

defaults:
  browser: chromium
  headless: true
  timeout: 30000
  retries: 1
  tags: ["@smoke"]

projects:
  - name: myproject
    environment: qa
    specs:
      - "test/myproject/specs/**/*.spec.ts"
    tags: ["@smoke", "@critical"]

execution:
  parallel: true
  workers: 4
  stopOnFailure: false

reports:
  html: true
  excel: true
  json: true
```

### Running Suites

```bash
npx cs-playwright-test suite --file=suites/smoke.yaml
npx cs-playwright-test suite --file=suites/regression.yaml --workers=8
```

---

## Pipeline & CI/CD

### Azure DevOps Pipeline

```yaml
trigger:
  - main
  - develop

pool:
  vmImage: 'ubuntu-latest'

steps:
  - task: NodeTool@0
    inputs:
      versionSpec: '20.x'

  - script: npm ci
    displayName: 'Install dependencies'

  - script: npx playwright install --with-deps
    displayName: 'Install Playwright browsers'

  - script: npx cs-playwright-test --project=myproject --specs=test/**/*.spec.ts --parallel
    displayName: 'Run tests'
    env:
      ENVIRONMENT: $(Environment)
      ADO_ENABLED: true
      ADO_PAT: $(ADO_PAT)

  - task: PublishTestResults@2
    inputs:
      testResultsFormat: 'JUnit'
      testResultsFiles: 'reports/**/junit-report.xml'
```

### GitHub Actions

```yaml
name: E2E Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps

      - name: Run tests
        run: npx cs-playwright-test --project=myproject --specs=test/**/*.spec.ts
        env:
          ENVIRONMENT: qa

      - name: Upload test results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-results
          path: reports/
```

---

## AI & Self-Healing

### Self-Healing Engine

The framework includes an 8-strategy self-healing engine:

1. **Text Content** - Match by visible text
2. **Attribute Match** - Match by attributes
3. **Structural Position** - Match by DOM position
4. **Parent/Child** - Match by relationships
5. **CSS Relaxation** - Relax CSS selectors
6. **XPath Axis** - Use XPath axes
7. **Visual Features** - Match by visual properties
8. **AI/ML Score** - ML-based similarity scoring

### Configuration

```bash
SELF_HEALING_ENABLED=true
SELF_HEALING_THRESHOLD=0.85
SELF_HEALING_STORE_PATH=./healing-store.json
```

### Usage

```typescript
@CSGetElement({
    css: 'button.submit',
    selfHeal: true,
    alternativeLocators: [
        'xpath://button[@type="submit"]',
        'text:Submit'
    ]
})
public submitButton!: CSWebElement;
```

---

## Reporting & Evidence

### CSReporter

```typescript
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';

CSReporter.pass('Login successful');
CSReporter.fail('Login failed', error);
CSReporter.info('Processing data...');
CSReporter.warn('Slow response detected');
CSReporter.debug('Element found at selector...');
```

### Evidence Collection

```typescript
// Capture screenshot
await reporter.captureScreenshot('dashboard-state');

// Capture full page screenshot
await reporter.captureFullPageScreenshot('full-page');

// Add custom evidence
reporter.addEvidence('API Response', responseData);
```

### Report Formats

- **HTML Report** - Interactive dashboard with charts
- **Excel Report** - Spreadsheet with multiple worksheets
- **PDF Report** - Printable PDF format
- **JSON Report** - Machine-readable format
- **JUnit XML** - CI/CD integration

---

## ADO Integration

### Configuration

```bash
ADO_ENABLED=true
ADO_ORGANIZATION=myorg
ADO_PROJECT=myproject
ADO_PAT=your-personal-access-token
ADO_TEST_PLAN_ID=100
ADO_PUBLISH_RESULTS=true
ADO_CREATE_DEFECTS=true
```

### Test Case Mapping

```typescript
describe('Login Feature', {
    tags: ['@TestPlanId:417', '@TestSuiteId:418']
}, () => {

    test('Login test', {
        tags: ['@TestCaseId:419', '@smoke']
    }, async ({ loginPage }) => {
        // Maps to ADO Test Case 419
    });

    test('Multiple test cases', {
        tags: ['@TestCaseId:{420,421,422}']
    }, async ({ dashboardPage }) => {
        // Maps to ADO Test Cases 420, 421, 422
    });
});
```

---

## Performance Testing

### CSPerformanceTestRunner

```typescript
import { CSPerformanceTestRunner } from '@mdakhan.mak/cs-playwright-test-framework/performance';

const runner = new CSPerformanceTestRunner();

// Load test
const results = await runner.loadTest({
    scenario: async (page) => {
        await page.goto('/dashboard');
        await page.click('.submit');
    },
    users: 10,
    duration: 60000,
    rampUp: 10000
});

console.log('Avg response time:', results.avgResponseTime);
console.log('Requests per second:', results.rps);
```

### Core Web Vitals

```typescript
import { CSPerformanceMonitor } from '@mdakhan.mak/cs-playwright-test-framework/performance';

const monitor = new CSPerformanceMonitor(page);
const metrics = await monitor.collectWebVitals();

console.log('LCP:', metrics.lcp);  // Largest Contentful Paint
console.log('FID:', metrics.fid);  // First Input Delay
console.log('CLS:', metrics.cls);  // Cumulative Layout Shift
console.log('TTFB:', metrics.ttfb); // Time to First Byte
```

---

## Visual Testing

### CSVisualTesting

```typescript
import { CSVisualTesting } from '@mdakhan.mak/cs-playwright-test-framework/visual';

const visual = new CSVisualTesting(page);

// Full page comparison
await visual.compareFullPage('homepage', {
    threshold: 0.1,
    updateBaseline: false
});

// Element comparison
await visual.compareElement(dashboardPage.chartWidget, 'chart-widget', {
    threshold: 0.05
});
```

---

## Mobile Testing

### Device Emulation

```typescript
import { CSMobileTesting } from '@mdakhan.mak/cs-playwright-test-framework/mobile';

const mobile = new CSMobileTesting();

// Emulate iPhone 12
await mobile.emulateDevice('iPhone 12');

// Custom device
await mobile.emulateDevice({
    viewport: { width: 375, height: 812 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0...',
    hasTouch: true,
    isMobile: true
});
```

---

## Variable Interpolation

### CSValueResolver

```typescript
import { CSValueResolver } from '@mdakhan.mak/cs-playwright-test-framework/utils';

const resolver = CSValueResolver.getInstance();

// Resolve config variables
const url = resolver.resolve('{config:BASE_URL}/login');

// Resolve environment variables
const env = resolver.resolve('{env:NODE_ENV}');

// Generate random values
const email = resolver.resolve('{generate:email}');
const uuid = resolver.resolve('{uuid}');
const timestamp = resolver.resolve('{timestamp}');

// Resolve scenario context
const userId = resolver.resolve('{scenario:userId}');
```

---

## Secret Masking

### CSSecretMasker

```typescript
import { CSSecretMasker } from '@mdakhan.mak/cs-playwright-test-framework/utils';

const masker = CSSecretMasker.getInstance();

// Register secrets to mask
masker.registerSecret('password123');
masker.registerSecret('api-key-12345');

// Mask secrets in output
const safeOutput = masker.mask('Password is password123');
// Output: "Password is ********"
```

---

## Data Management

### CSDataProvider

```typescript
import { CSDataProvider } from '@mdakhan.mak/cs-playwright-test-framework/data';

const provider = new CSDataProvider();

// Load CSV
const csvData = await provider.loadCSV('test/data/users.csv');

// Load JSON with JSONPath
const jsonData = await provider.loadJSON('test/data/users.json', '$.users[*]');

// Load Excel
const excelData = await provider.loadExcel('test/data/users.xlsx', 'Sheet1');

// Load with filter
const filtered = await provider.loadCSV('test/data/users.csv', {
    filter: 'status=active&role:Admin,Manager'
});
```

### CSDataGenerator

```typescript
import { CSDataGenerator } from '@mdakhan.mak/cs-playwright-test-framework/data';

const generator = new CSDataGenerator();

// Generate test data
const email = generator.email();           // test_123@example.com
const phone = generator.phone();           // +1-555-123-4567
const name = generator.fullName();         // John Smith
const uuid = generator.uuid();             // 550e8400-e29b-41d4-a716-446655440000
const date = generator.date('YYYY-MM-DD'); // 2025-01-19
const number = generator.number(1, 100);   // 42
```

---

## Utility Classes

### CSStringUtility

```typescript
import { CSStringUtility } from '@mdakhan.mak/cs-playwright-test-framework/utilities';

CSStringUtility.capitalize('hello');           // 'Hello'
CSStringUtility.truncate('Long text...', 10);  // 'Long te...'
CSStringUtility.slugify('Hello World');        // 'hello-world'
CSStringUtility.template('Hello {name}', { name: 'World' }); // 'Hello World'
```

### CSDateTimeUtility

```typescript
import { CSDateTimeUtility } from '@mdakhan.mak/cs-playwright-test-framework/utilities';

CSDateTimeUtility.format(new Date(), 'YYYY-MM-DD');
CSDateTimeUtility.addDays(new Date(), 7);
CSDateTimeUtility.daysBetween(date1, date2);
CSDateTimeUtility.toISO(new Date());
```

### CSExcelUtility

```typescript
import { CSExcelUtility } from '@mdakhan.mak/cs-playwright-test-framework/utilities';

// Read Excel
const data = CSExcelUtility.readAsJSON('data.xlsx', 'Sheet1');

// Write Excel
CSExcelUtility.writeFromJSON(data, 'output.xlsx', { sheet: 'Results' });

// Compare Excel files
const diff = CSExcelUtility.compareFiles('expected.xlsx', 'actual.xlsx');
```

---

## Assertions

### CSExpect

```typescript
import { CSExpect } from '@mdakhan.mak/cs-playwright-test-framework/assertions';

const expect = new CSExpect();

// Basic assertions
expect.toBe(actual, expected);
expect.toEqual(actual, expected);
expect.toContain(array, item);
expect.toBeTruthy(value);
expect.toBeFalsy(value);

// Numeric assertions
expect.toBeGreaterThan(actual, expected);
expect.toBeLessThan(actual, expected);
expect.toBeCloseTo(actual, expected, precision);

// String assertions
expect.toMatch(actual, /pattern/);
expect.toStartWith(actual, prefix);
expect.toEndWith(actual, suffix);

// Element assertions
await expect.toBeVisible(element);
await expect.toBeHidden(element);
await expect.toHaveText(element, text);
await expect.toHaveValue(element, value);
```

---

## Network Interception

### CSNetworkInterceptor

```typescript
import { CSNetworkInterceptor } from '@mdakhan.mak/cs-playwright-test-framework/network';

const interceptor = new CSNetworkInterceptor(page);

// Mock API response
await interceptor.mockResponse('**/api/users', {
    status: 200,
    body: JSON.stringify([{ id: 1, name: 'Mock User' }])
});

// Block requests
await interceptor.blockRequest('**/analytics/**');

// Capture requests
interceptor.captureRequests('**/api/**');
const requests = interceptor.getCapturedRequests();
```

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `npx cs-playwright-test --project=<name> --specs=<path>` | Run spec tests |
| `npx cs-playwright-test --project=<name> --features=<path>` | Run BDD tests |
| `npx cs-playwright-test suite --file=<path>` | Run suite file |
| `npx cs-playwright-test generate-fixtures --project=<name>` | Generate typed fixtures |
| `npx cs-playwright-test codegen <url>` | Launch codegen tool |

### CLI Options

| Option | Description |
|--------|-------------|
| `--project <name>` | Project name (required) |
| `--specs <path>` | Path to spec files (glob pattern) |
| `--features <path>` | Path to feature files |
| `--test <name>` | Run specific test(s) by name |
| `--tags <tags>` | Filter by tags |
| `--parallel` | Enable parallel execution |
| `--workers <n>` | Number of parallel workers |
| `--headless` | Run in headless mode |
| `--headed` | Run with visible browser |
| `--browser <type>` | Browser: chromium, firefox, webkit |
| `--retries <n>` | Retry failed tests |
| `--timeout <ms>` | Test timeout in milliseconds |
| `--debug` | Enable debug mode |

---

## Best Practices

### Page Object Design

1. Use descriptive element descriptions
2. Enable self-healing for critical elements
3. Provide alternative locators
4. Keep page methods focused and reusable
5. Use CSReporter for logging

### Test Organization

1. Use meaningful test names
2. Add appropriate tags for filtering
3. Use `describe.serial()` for dependent tests
4. Use `describe.parallel()` for independent tests
5. Leverage data-driven testing for repetitive scenarios

### Configuration Management

1. Use environment-specific config files
2. Keep secrets in encrypted format
3. Use variable interpolation for dynamic values
4. Configure appropriate timeouts per environment

### Error Handling

1. Use try-catch for expected failures
2. Leverage soft assertions when appropriate
3. Capture screenshots on failure
4. Add meaningful error messages

### Performance

1. Use `minimal` smart wait level by default
2. Reuse browser contexts when possible
3. Parallelize independent tests
4. Filter data at source level

---

## Report Generators

### CSHtmlReportGenerator

Generates enterprise-grade HTML reports with multiple interactive views.

```typescript
import { CSHtmlReportGenerator } from '@mdakhan.mak/cs-playwright-test-framework/reporting';

const generator = new CSHtmlReportGenerator();
await generator.generateReport(testSuite, './reports');
```

### CSExcelReportGenerator

```typescript
import { CSExcelReportGenerator } from '@mdakhan.mak/cs-playwright-test-framework/reporting';

const excelGenerator = new CSExcelReportGenerator();
await excelGenerator.generateReport(testSuite, './reports');
```

### CSPdfReportGenerator

```typescript
import { CSPdfReportGenerator } from '@mdakhan.mak/cs-playwright-test-framework/reporting';

const pdfGenerator = new CSPdfReportGenerator();
await pdfGenerator.generateReport('./reports/index.html', './reports');
```

---

*CS Playwright Test Framework Documentation*
*Generated with comprehensive module analysis*
