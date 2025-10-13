# CS Playwright Test Framework - Complete Documentation

## 🎯 Overview

**CS Playwright Test Framework** is an enterprise-grade, comprehensive test automation platform built on Playwright with TypeScript. It provides a unified solution for UI, API, Database, and SOAP testing with advanced features like AI-powered self-healing, intelligent variable interpolation, parallel execution, and real-time monitoring.

### Key Statistics
- **363+ Built-in Step Definitions** - Ready-to-use Gherkin steps
- **171 TypeScript Modules** - Comprehensive feature coverage
- **Sub-second Startup Time** - Lightning-fast lazy loading architecture
- **7-Level Configuration Hierarchy** - Ultimate flexibility
- **6 Database Adapters** - MySQL, PostgreSQL, SQL Server, Oracle, MongoDB, Redis
- **Zero Hardcoding Philosophy** - Everything is configurable

---

## 📚 Table of Contents

1. [Architecture & Design](#architecture--design)
2. [Installation & Setup](#installation--setup)
3. [Configuration System](#configuration-system)
4. [Module System](#module-system)
5. [Database Testing](#database-testing)
6. [API Testing (REST)](#api-testing-rest)
7. [SOAP Testing](#soap-testing)
8. [UI Testing](#ui-testing)
9. [Data-Driven Testing](#data-driven-testing)
10. [AI & Self-Healing](#ai--self-healing)
11. [Parallel Execution](#parallel-execution)
12. [Reporting & Evidence](#reporting--evidence)
13. [Azure DevOps Integration](#azure-devops-integration)
14. [Advanced Features](#advanced-features)
15. [Built-in Step Definitions](#built-in-step-definitions)
16. [API Reference](#api-reference)

---

## 🏗️ Architecture & Design

### Core Principles

1. **Zero Hardcoding** - Every value, timeout, URL, credential is configurable
2. **Lazy Loading** - Modules load on-demand for sub-second startup
3. **Singleton Pattern** - Shared state across distributed step definitions
4. **Decorator-Based** - Clean, declarative syntax for steps and pages
5. **Worker-Aware** - Parallel execution with isolated instances per worker
6. **Modular Design** - Independent modules for UI, API, Database, SOAP

### Framework Structure

```
src/
├── core/                    # Core framework components
│   ├── CSConfigurationManager.ts   # 7-level configuration system
│   ├── CSBasePage.ts               # Base page class
│   ├── CSPageFactory.ts            # Page object factory
│   ├── CSModuleDetector.ts         # Automatic module detection
│   └── CSStepLoader.ts             # Dynamic step loader
├── bdd/                     # BDD execution engine
│   ├── CSBDDRunner.ts              # Main test runner
│   ├── CSStepRegistry.ts           # Step definition registry
│   ├── CSBDDContext.ts             # Test execution context
│   └── CSIntelligentStepExecutor.ts # AI-powered step execution
├── database/                # Database testing
│   ├── adapters/                   # Database adapters (6 types)
│   ├── client/                     # Connection management
│   └── context/                    # Shared database state
├── api/                     # API testing (REST)
│   ├── client/                     # HTTP client
│   ├── auth/                       # Authentication handlers
│   ├── validators/                 # Response validators
│   ├── templates/                  # Request templates
│   └── context/                    # API context & chaining
├── soap/                    # SOAP/XML testing
│   ├── CSSoapClient.ts             # SOAP client
│   ├── CSXmlParser.ts              # XML parser
│   └── CSSoapSecurityHandler.ts    # WS-Security
├── ai/                      # AI capabilities
│   ├── CSIntelligentAI.ts          # Main AI engine
│   ├── healing/                    # Self-healing strategies
│   ├── nlp/                        # Natural language processing
│   ├── prediction/                 # Predictive healing
│   └── learning/                   # ML-based optimization
├── browser/                 # Browser management
│   ├── CSBrowserManager.ts         # Browser lifecycle
│   └── CSBrowserPool.ts            # Browser pooling
├── element/                 # Element handling
│   ├── CSWebElement.ts             # Enhanced element wrapper
│   ├── CSElementResolver.ts        # Smart element finding
│   └── CSLocatorBuilder.ts         # Dynamic locator building
├── reporter/                # Reporting system
│   ├── CSReporter.ts               # Multi-format reporter
│   ├── CSHTMLReporter.ts           # HTML reports
│   └── CSJUnitReporter.ts          # JUnit XML reports
├── steps/                   # Built-in step definitions
│   ├── database/                   # 100+ database steps
│   ├── api/                        # 150+ API steps
│   ├── soap/                       # 30+ SOAP steps
│   └── common/                     # Shared steps
├── data/                    # Data providers
│   ├── CSDataProvider.ts           # Data source abstraction
│   └── CSDataGenerator.ts          # Test data generation
├── evidence/                # Evidence collection
│   ├── CSEvidenceCollector.ts      # Screenshots, videos, logs
│   └── CSScreenshotManager.ts      # Screenshot management
├── parallel/                # Parallel execution
│   ├── CSWorkerPool.ts             # Worker management
│   └── CSTaskDistributor.ts        # Task distribution
├── ado/                     # Azure DevOps integration
│   ├── CSADOClient.ts              # ADO API client
│   └── CSADOPublisher.ts           # Test result publisher
├── dashboard/               # Real-time monitoring
│   └── CSLiveDashboard.ts          # WebSocket dashboard
├── utils/                   # Utilities
│   ├── CSEncryptionUtil.ts         # Encryption/decryption
│   └── CSDateTimeUtil.ts           # Date/time helpers
└── types/                   # TypeScript types
```

---

## 📦 Installation & Setup

### Prerequisites

```bash
Node.js >= 20.0.0
npm >= 8.0.0 or yarn >= 1.22.0
```

### Installation

```bash
# Install as npm package
npm install cs-playwright-test-framework

# Or clone repository
git clone <your-repo-url>
cd cs-playwright-test-framework
npm install
```

### Project Setup

```bash
# Create project structure
npx cs-playwright-init --project=myproject

# This creates:
config/
  └── myproject/
      ├── common/
      │   └── common.env
      └── environments/
          ├── dev.env
          ├── staging.env
          └── prod.env
test/
  └── myproject/
      ├── features/
      ├── steps/
      ├── pages/
      └── data/
```

### Quick Start

```bash
# Run tests with default configuration
npx cs-playwright-run --project=myproject

# Run with specific environment
npx cs-playwright-run --project=myproject --env=staging

# Run with tags
npx cs-playwright-run --project=myproject --tags="@smoke and @critical"

# Run in parallel
npx cs-playwright-run --project=myproject --parallel --workers=8

# Run with specific modules
npx cs-playwright-run --project=myproject --modules=api,database
```

---
# README ADDITIONS - Missing Features Documentation

## Section to Add After "Quick Start" (After line ~185)

---

## 🎯 Test Execution Options

### Command Line Interface

```bash
# Basic execution
npx cs-playwright-run --project=myproject --features=test/features

# With tags
npx cs-playwright-run --project=myproject --tags="@smoke"
npx cs-playwright-run --project=myproject --tags="@smoke and @critical"
npx cs-playwright-run --project=myproject --tags="@regression and not @skip"

# Specific scenario
npx cs-playwright-run --project=myproject --scenario="User Login"

# Module specification
npx cs-playwright-run --project=myproject --modules=api
npx cs-playwright-run --project=myproject --modules=api,database
npx cs-playwright-run --project=myproject --modules=ui,api,database,soap

# Parallel execution
npx cs-playwright-run --project=myproject --parallel
npx cs-playwright-run --project=myproject --parallel --workers=5
npx cs-playwright-run --project=myproject --workers=3

# Browser options
npx cs-playwright-run --project=myproject --browser=chrome
npx cs-playwright-run --project=myproject --browser=firefox --headless
npx cs-playwright-run --project=myproject --browser=webkit --headless=false

# Environment
npx cs-playwright-run --project=myproject --env=staging
npx cs-playwright-run --project=myproject --environment=production

# Retry failed tests
npx cs-playwright-run --project=myproject --retry=3

# Multiple feature files
npx cs-playwright-run --project=myproject --features=test/features/login,test/features/checkout
```

### CLI Options Reference

| Option | Alias | Description | Example |
|--------|-------|-------------|---------|
| `--project` | | Project name (required) | `--project=myproject` |
| `--features` | `-f` | Path to feature files/directories | `--features=test/features` |
| `--tags` | `-t` | Filter scenarios by tags | `--tags="@smoke and @critical"` |
| `--scenario` | `-s` | Run specific scenario by name | `--scenario="User Login"` |
| `--modules` | `-m` | Modules to load | `--modules=api,database` |
| `--parallel` | | Enable parallel execution | `--parallel` or `--parallel=5` |
| `--workers` | | Number of parallel workers | `--workers=3` |
| `--headless` | | Run browser in headless mode | `--headless` or `--headless=false` |
| `--browser` | | Browser type | `--browser=chrome` |
| `--env` | | Environment | `--env=staging` |
| `--environment` | | Environment (same as --env) | `--environment=production` |
| `--retry` | | Retry failed tests N times | `--retry=3` |
| `--help` | `-h` | Show help | `--help` |
| `--version` | `-v` | Show version | `--version` |

### Tag Filtering

#### Tag Syntax

```bash
# Single tag
--tags="@smoke"

# Multiple tags (AND)
--tags="@smoke and @critical"

# Multiple tags (OR)
--tags="@smoke or @regression"

# Negation (NOT)
--tags="not @skip"

# Complex expressions
--tags="(@smoke or @critical) and not @wip"
--tags="@regression and @database and not @slow"
```

#### Tag Examples in Feature Files

```gherkin
@smoke @critical
Feature: User Authentication

  @login @happy-path
  Scenario: Successful login with valid credentials
    Given user navigates to login page
    When user enters valid credentials
    Then user should be logged in

  @login @negative @security
  Scenario: Login fails with invalid password
    Given user navigates to login page
    When user enters invalid password
    Then user should see error message

  @wip @skip
  Scenario: Work in progress - skip this
    Given this is not ready yet
```

### Feature File Filtering

```bash
# Single feature file
--features=test/features/login.feature

# Multiple files
--features=test/features/login.feature,test/features/checkout.feature

# Directory (all features)
--features=test/features

# Multiple directories
--features=test/features/auth,test/features/payment

# Pattern matching (with wildcards)
--features=test/features/**/*.feature
--features=test/features/user/**/*.feature
```

---

## 📝 Writing Custom Step Definitions

### Step Definition Decorators

The framework provides **two decorator styles** for writing custom step definitions:

#### 1. Framework-Specific: `@CSBDDStepDef`

```typescript
import { CSBDDStepDef } from 'cs-playwright-test-framework';

export class LoginSteps {
    @CSBDDStepDef('user enters username {string}')
    async enterUsername(username: string): Promise<void> {
        await this.page.fill('#username', username);
    }

    @CSBDDStepDef('user enters password {string}')
    async enterPassword(password: string): Promise<void> {
        await this.page.fill('#password', password);
    }

    @CSBDDStepDef('user clicks login button')
    async clickLogin(): Promise<void> {
        await this.page.click('#login-btn');
    }
}
```

#### 2. Cucumber-Compatible: `@Given`, `@When`, `@Then`, `@And`, `@But`

These decorators provide **IDE support** (autocomplete, navigation) while maintaining all framework features:

```typescript
import { Given, When, Then, And, But } from 'cs-playwright-test-framework';

export class LoginSteps {
    @Given('user is on the login page')
    async onLoginPage(): Promise<void> {
        await this.page.goto('/login');
    }

    @When('user enters {string} as username')
    async enterUsername(username: string): Promise<void> {
        await this.page.fill('#username', username);
    }

    @And('user enters {string} as password')
    async enterPassword(password: string): Promise<void> {
        await this.page.fill('#password', password);
    }

    @And('user clicks the login button')
    async clickLogin(): Promise<void> {
        await this.page.click('#login-btn');
    }

    @Then('user should see the dashboard')
    async seeDashboard(): Promise<void> {
        await expect(this.page).toHaveURL(/.*dashboard/);
    }

    @But('user should not see the login form')
    async noLoginForm(): Promise<void> {
        await expect(this.page.locator('#login-form')).not.toBeVisible();
    }
}
```

### Cucumber Expression Syntax

```typescript
// String parameter
@CSBDDStepDef('user enters {string} as username')
async enterUsername(username: string) { }

// Integer parameter
@CSBDDStepDef('user waits for {int} seconds')
async wait(seconds: number) { }

// Float parameter
@CSBDDStepDef('user sets price to {float}')
async setPrice(price: number) { }

// Word parameter
@CSBDDStepDef('user selects {word} option')
async selectOption(option: string) { }

// Multiple parameters
@CSBDDStepDef('user {string} enters {string} in {string} field')
async fillField(user: string, value: string, field: string) { }
```

### Data Tables and Doc Strings

```typescript
// Data Table
@CSBDDStepDef('user fills form with:')
async fillForm(dataTable: DataTable): Promise<void> {
    const data = dataTable.hashes(); // Array of objects
    for (const row of data) {
        await this.page.fill(`#${row.field}`, row.value);
    }
}

// Doc String
@CSBDDStepDef('user submits JSON payload:')
async submitPayload(jsonString: string): Promise<void> {
    const payload = JSON.parse(jsonString);
    await this.apiClient.post('/api/data', payload);
}
```

### Step Definition with Timeout

```typescript
// Custom timeout for slow operations
@CSBDDStepDef('user waits for report to generate', 120000)
async waitForReport(): Promise<void> {
    await this.page.waitForSelector('#report-ready', { timeout: 120000 });
}

// Or with Given/When/Then
@Given('user waits for batch job to complete', 300000)
async waitForBatchJob(): Promise<void> {
    // Custom logic with 5-minute timeout
}
```

### Using Both Styles Together

You can mix and match both decorator styles in the same project:

```typescript
export class CheckoutSteps {
    // Use Given/When/Then for IDE support
    @Given('user has items in cart')
    async hasItemsInCart() { }

    @When('user proceeds to checkout')
    async proceedToCheckout() { }

    // Use @CSBDDStepDef for generic steps
    @CSBDDStepDef('user verifies {string}')
    async verify(item: string) { }
}
```

---

## 🤖 Zero-Code Testing (Intelligent Step Execution)

### Overview

The framework includes **AI-powered intelligent step execution** that allows running feature files **without writing step definitions**. The AI engine understands natural language and automatically:

- Identifies UI elements
- Performs actions (click, type, select)
- Validates content
- Handles waits and assertions

### Enabling Zero-Code Mode

```properties
# config/myproject/common/common.env
INTELLIGENT_STEP_EXECUTION_ENABLED=true
```

### How It Works

When a step definition is not found, the framework:
1. Analyzes the step text using NLP
2. Determines the intent (navigate, click, type, validate, wait)
3. Identifies target elements using AI
4. Executes the action automatically
5. Falls back to error if AI cannot execute

### Example Feature (No Step Definitions Required)

```gherkin
Feature: Product Search

  @zero-code
  Scenario: Search for a product
    Given user navigates to the application
    When user clicks on the search icon
    And user types "laptop" in the search box
    And user clicks the search button
    Then user should see search results
    And user should see "laptop" in results
```

### Supported Intents

| Intent | Natural Language Examples | Action Performed |
|--------|--------------------------|------------------|
| **Navigate** | "navigate to the application"<br>"go to login page"<br>"open the homepage" | Navigates to BASE_URL or extracted URL |
| **Click** | "click on the login button"<br>"user clicks search icon"<br>"tap the submit button" | Finds and clicks element using AI |
| **Type/Fill** | "type 'text' in the search box"<br>"enter 'John' as username"<br>"fill 'email' with 'test@example.com'" | Finds input field and enters text |
| **Select** | "select 'Canada' from country dropdown"<br>"choose 'Monthly' option" | Finds select element and picks option |
| **Validate** | "user should see welcome message"<br>"page contains 'Success'"<br>"verify 'Order Complete' is visible" | Checks if text/element exists |
| **Wait** | "wait for 3 seconds"<br>"user waits for page to load" | Adds explicit wait |

### Configuration Options

```properties
# Enable/disable intelligent execution
INTELLIGENT_STEP_EXECUTION_ENABLED=true

# AI confidence threshold (0.0 to 1.0)
AI_CONFIDENCE_THRESHOLD=0.7

# Enable AI learning from successful executions
AI_LEARNING_ENABLED=true

# AI execution timeout
AI_EXECUTION_TIMEOUT=30000
```

### When to Use Zero-Code

✅ **Best For:**
- Rapid prototyping
- Exploratory testing
- Simple UI flows
- Proof of concepts
- Non-technical team members

❌ **Not Recommended For:**
- Complex business logic
- Precise element targeting
- Performance-critical tests
- Tests requiring exact locators

---

## Section to ADD/EXPAND in Variable Interpolation (Around line 251)

### Complete Variable Interpolation Reference

#### All Syntax Patterns

```properties
# 1. Simple config variable
{VAR}                          # Look up in configuration
{PROJECT}                      # Example: myproject
{BASE_URL}                     # Example: https://example.com

# 2. Environment variable with optional default
${VAR}                         # Environment variable
${VAR:-default}                # With default value
${API_KEY:-fallback_key}       # Example with fallback

# 3. Runtime context variable (from step execution)
{{VAR}}                        # Context variable (shorthand)
{{username}}                   # Example: john.doe
{{orderId}}                    # Example: ORD-12345

# 4. Explicit type prefixes
{env:VAR}                      # Explicit environment variable
{config:KEY}                   # Explicit configuration key
{context:VAR}                  # Explicit context variable

# 5. Conditional (ternary) operation
{ternary:CONDITION?TRUE_VALUE:FALSE_VALUE}
{ternary:FEATURE_ENABLED?yes:no}

# 6. Concatenation
{concat:VAR1+VAR2+VAR3}
{concat:FIRST_NAME+ +LAST_NAME}       # Result: John Doe

# 7. Text transformations
{upper:VAR}                    # Uppercase transformation
{lower:VAR}                    # Lowercase transformation
{upper:email}                  # user@example.com → USER@EXAMPLE.COM
{lower:USERNAME}               # JOHN → john

# 8. Dynamic value generation
<random>                       # Random alphanumeric string
<timestamp>                    # Current Unix timestamp
<uuid>                         # UUID v4 format
<date>                         # Current date (YYYY-MM-DD)
<date:YYYY-MM-DD HH:mm:ss>    # Formatted date
<generate:email>               # test_1234567890@example.com
<generate:phone>               # +11234567890
<generate:username>            # user_abc123
<generate:password>            # Random 12-char password
```

#### Real-World Examples

**Configuration File:**

```properties
# config/myproject/environments/staging.env

# Basic variables
PROJECT=myproject
REGION=us-east-1
ENVIRONMENT=staging

# Composed URLs using interpolation
BASE_URL=https://{PROJECT}-{ENVIRONMENT}.example.com
# Result: https://myproject-staging.example.com

API_URL=https://api-{PROJECT}-{ENVIRONMENT}-{REGION}.example.com
# Result: https://api-myproject-staging-us-east-1.example.com

# Conditional values
FEATURE_NEW_UI=true
LOGIN_URL={ternary:FEATURE_NEW_UI?/v2/login:/login}
# Result: /v2/login

# Concatenation
FIRST_NAME=John
LAST_NAME=Doe
DISPLAY_NAME={concat:FIRST_NAME+ +LAST_NAME}
# Result: John Doe

# Dynamic values
TEST_USER=test_<uuid>@example.com
# Result: test_a1b2c3d4-e5f6-7890-abcd-ef1234567890@example.com

REPORT_FILE=report_<timestamp>.html
# Result: report_1234567890123.html

SESSION_ID=<random>
# Result: x7k9mq

# Transformations
COMPANY_NAME=Example Corporation
COMPANY_CODE={lower:COMPANY_NAME}
# Result: example corporation

EMAIL=user@EXAMPLE.COM
NORMALIZED_EMAIL={lower:EMAIL}
# Result: user@example.com

# Environment variables with fallbacks
LOG_PATH=${HOME}/logs
API_KEY=${API_KEY:-default_test_key}
```

**In Feature Files:**

```gherkin
Feature: User Registration

  Scenario: Register new user
    # Using dynamic generation
    Given user navigates to "{BASE_URL}/register"
    When user enters "<generate:email>" as email
    And user enters "<generate:username>" as username
    And user enters "<generate:password>" as password
    And user clicks register button
    Then user should be registered successfully

  Scenario: Login with saved credentials
    # Using context variables from previous scenario
    Given user navigates to "{BASE_URL}/login"
    When user enters "{{savedEmail}}" as email
    And user enters "{{savedPassword}}" as password
    Then user should be logged in

  Scenario Outline: Test multiple environments
    Given user navigates to "{BASE_URL}/products"
    When user filters by region "{REGION}"
    Then user should see products for "<region>"

    Examples:
    | region |
    | {REGION} |
```

---

## Section to ADD - Data-Driven Testing (Expand existing section)

### @DataProvider Tag

Use `@DataProvider` tag to load test data from external sources:

#### Syntax

```gherkin
@DataProvider(source="file.xlsx", type="excel", sheet="TestData", filter="active=true")
Scenario Outline: Data driven test
  Given user logs in as "<username>"
  Then user role should be "<role>"
```

#### Supported Data Source Types

##### 1. Excel Files

```gherkin
@DataProvider(source="testdata/users.xlsx", type="excel", sheet="Users")
Scenario Outline: Test with Excel data
  Given user "<username>" logs in with "<password>"
  Then user should have "<role>" permissions
```

##### 2. CSV Files

```gherkin
@DataProvider(source="testdata/users.csv", type="csv", delimiter=",")
Scenario Outline: Test with CSV data
  Given user "<username>" exists
  When user logs in
  Then user sees "<homepage>"
```

##### 3. JSON Files

```gherkin
@DataProvider(source="testdata/users.json", type="json", path="$.users[*]")
Scenario Outline: Test with JSON data
  Given user "<username>" exists
  Then user email is "<email>"
```

##### 4. XML Files

```gherkin
@DataProvider(source="testdata/users.xml", type="xml", xpath="//user")
Scenario Outline: Test with XML data
  Given user "<name>" has ID "<id>"
```

##### 5. Database Query

```gherkin
@DataProvider(type="database", connection="testdb", query="SELECT * FROM users WHERE active=1")
Scenario Outline: Test with database data
  Given user "<username>" exists in database
  Then user ID is "<user_id>"
```

##### 6. API Endpoint

```gherkin
@DataProvider(type="api", source="https://api.example.com/users")
Scenario Outline: Test with API data
  Given user "<id>" from API
  Then username is "<username>"
```

##### 7. Generated Data

```gherkin
@DataProvider(type="generate", count="10", template="user")
Scenario Outline: Test with generated users
  Given user "<username>" with email "<email>"
```

### JSON in Examples

You can specify external data sources in the Examples table name using JSON:

```gherkin
Scenario Outline: Login with external data
  Given user navigates to login page
  When user logs in as "<username>" with "<password>"
  Then user should see dashboard

  Examples: {"type": "excel", "source": "testdata/logins.xlsx", "sheet": "ValidUsers"}

# OR

  Examples: {"type": "csv", "source": "testdata/credentials.csv"}

# OR

  Examples: {"type": "database", "connection": "testdb", "query": "SELECT username, password FROM test_users"}

# OR

  Examples: {"type": "api", "source": "https://api.example.com/test-users"}
```

### Feature-Level DataProvider

Apply data provider to all scenarios in a feature:

```gherkin
@DataProvider(source="testdata/global_users.xlsx", sheet="AllUsers")
Feature: User Management

  Scenario Outline: Create user
    Given admin creates user "<username>"
    # Uses data from global_users.xlsx

  Scenario Outline: Delete user
    Given admin deletes user "<username>"
    # Uses data from global_users.xlsx
```

---

## Section to ADD - Browser Management

### Browser Reuse Configuration

#### Enable Browser Reuse

```properties
# config/myproject/common/common.env

# Reuse browser across scenarios (faster execution)
BROWSER_REUSE_ENABLED=true

# Reuse context (maintains state like cookies)
BROWSER_CONTEXT_REUSE_ENABLED=true

# Clear cookies between scenarios
CLEAR_COOKIES_BETWEEN_SCENARIOS=true

# Clear storage between scenarios
CLEAR_STORAGE_BETWEEN_SCENARIOS=true
```

#### Behavior Modes

| Configuration | Browser Lifecycle | Context Lifecycle | Use Case |
|---------------|------------------|-------------------|----------|
| `BROWSER_REUSE_ENABLED=false` | New browser per scenario | New context per scenario | Maximum isolation, slowest |
| `BROWSER_REUSE_ENABLED=true`<br>`CONTEXT_REUSE=false` | Shared browser | New context per scenario | Balanced speed and isolation |
| `BROWSER_REUSE_ENABLED=true`<br>`CONTEXT_REUSE=true` | Shared browser | Shared context | Fastest, maintains state |

### Browser Switching

Switch between different browsers during test execution:

```gherkin
Feature: Cross-Browser Testing

  Scenario: Test in Chrome
    Given user switches to "chrome" browser
    When user navigates to application
    Then application should load correctly

  Scenario: Test in Firefox
    Given user switches to "firefox" browser
    When user navigates to application
    Then application should load correctly

  Scenario: Test in Safari/WebKit
    Given user switches to "webkit" browser
    When user navigates to application
    Then application should load correctly
```

### Browser Context Management

```gherkin
# Clear browser context for fresh login
Given user clears browser context for re-authentication

# Clear and navigate
Given user clears browser context and goes to "/login"

# Clear without navigation (stays on current page)
Given user clears browser context without navigation

# Switch browser and clear state
Given user switches to "firefox" browser and clears state

# Switch without preserving URL (goes to blank page)
Given user switches to "chrome" browser without preserving URL
```

### Multiple Login Scenarios

```gherkin
Feature: Multi-User Workflow

  @user1
  Scenario: Admin creates order
    Given user clears browser context for re-authentication
    When admin logs in as "admin@example.com"
    And admin creates new order
    And admin saves order ID as "orderId"

  @user2
  Scenario: Manager approves order
    Given user clears browser context for re-authentication
    When manager logs in as "manager@example.com"
    And manager opens order "{{orderId}}"
    And manager approves the order

  @user3
  Scenario: User views approved order
    Given user clears browser context for re-authentication
    When user logs in as "user@example.com"
    And user opens order "{{orderId}}"
    Then order status should be "Approved"
```

### Browser Configuration

```properties
# Default browser
BROWSER=chromium

# Browser options
HEADLESS=false
BROWSER_SLOWMO=100

# Browser args
BROWSER_ARGS=--start-maximized,--disable-web-security

# Viewport
VIEWPORT_WIDTH=1920
VIEWPORT_HEIGHT=1080

# Timeouts
BROWSER_LAUNCH_TIMEOUT=30000
PAGE_LOAD_TIMEOUT=60000
NAVIGATION_TIMEOUT=30000

# Device emulation
DEVICE_EMULATION_ENABLED=false
DEVICE_NAME=iPhone 12

# Geolocation
BROWSER_GEOLOCATION_ENABLED=false
BROWSER_GEOLOCATION_LAT=37.7749
BROWSER_GEOLOCATION_LON=-122.4194

# Permissions
BROWSER_PERMISSIONS=geolocation,notifications,camera,microphone

# Video recording
VIDEO_ENABLED=true
VIDEO_SIZE_WIDTH=1280
VIDEO_SIZE_HEIGHT=720

# Screenshots
SCREENSHOT_ON_FAILURE=true
SCREENSHOT_FULL_PAGE=true

# Traces
TRACE_ENABLED=true
TRACE_CAPTURE_MODE=on-failure  # always, on-failure, never

# HAR (HTTP Archive)
HAR_ENABLED=true
HAR_CAPTURE_MODE=on-failure  # always, on-failure, never
```

---

## Section to EXPAND - Reporting & Evidence

### Report Formats

The framework generates multiple report formats automatically:

#### 1. HTML Report (Default)

```properties
# Always enabled
GENERATE_HTML_REPORT=true
```

**Features:**
- Interactive dashboard with charts
- Detailed step-by-step execution
- Screenshots, videos, and HAR files
- Failure analysis with AI insights
- Timeline view
- Category breakdown
- Execution history trends

#### 2. JSON Report

```properties
GENERATE_JSON_REPORT=true
JSON_REPORT_PATH=reports/results.json
```

**Format:**
```json
{
  "summary": {
    "total": 50,
    "passed": 45,
    "failed": 3,
    "skipped": 2,
    "duration": 12345,
    "passRate": 90.0
  },
  "scenarios": [
    {
      "name": "User Login",
      "status": "passed",
      "duration": 2340,
      "steps": [...]
    }
  ]
}
```

#### 3. JUnit XML Report

```properties
GENERATE_JUNIT_REPORT=true
JUNIT_REPORT_PATH=reports/junit.xml
```

**Use Case:** CI/CD integration (Jenkins, Azure DevOps, etc.)

#### 4. Excel Report

```properties
GENERATE_EXCEL_REPORT=true
EXCEL_REPORT_PATH=reports/results.xlsx
```

**Sheets:**
- Summary: Overall statistics
- Scenarios: Detailed scenario results
- Steps: All test steps with status
- Failures: Failed scenarios with errors
- Timeline: Execution timeline

#### 5. PDF Report

```properties
GENERATE_PDF_REPORT=true
PDF_REPORT_PATH=reports/results.pdf
```

**Features:**
- Professional layout
- Executive summary
- Charts and graphs
- Embedded screenshots
- Failure details

### Evidence Collection

#### Screenshots

```properties
# Screenshot settings
SCREENSHOT_ON_FAILURE=true
SCREENSHOT_ON_SUCCESS=false
SCREENSHOT_FULL_PAGE=true
SCREENSHOT_FORMAT=png  # png or jpeg
SCREENSHOT_QUALITY=90

# Capture mode
SCREENSHOT_CAPTURE_MODE=on-failure  # always, on-failure, never
```

**Manual Screenshots in Steps:**

```gherkin
Given user takes screenshot with name "before_login"
When user logs in
Then user takes screenshot with name "after_login"
```

#### Videos

```properties
# Video recording
VIDEO_ENABLED=true
VIDEO_CAPTURE_MODE=on-failure  # always, on-failure, never

# Video settings
VIDEO_SIZE_WIDTH=1280
VIDEO_SIZE_HEIGHT=720
VIDEO_FPS=25

# Retention
VIDEO_RETENTION_DAYS=30
```

#### Traces

```properties
# Playwright traces
TRACE_ENABLED=true
TRACE_CAPTURE_MODE=on-failure  # always, on-failure, never

# Trace options
TRACE_SCREENSHOTS=true
TRACE_SNAPSHOTS=true
TRACE_SOURCES=true
```

**Usage:**
- Open `trace.zip` in https://trace.playwright.dev
- Inspect every action, network request, console log
- Time-travel debugging

#### HAR Files (HTTP Archive)

```properties
# HAR capture
HAR_ENABLED=true
HAR_CAPTURE_MODE=on-failure  # always, on-failure, never

# HAR content
HAR_INCLUDE_CONTENT=true
HAR_INCLUDE_COOKIES=true
```

**Analysis:**
- All network requests/responses
- Headers, timing, size
- Import into Chrome DevTools or HAR analyzers

#### Console Logs

```properties
# Console log capture
CAPTURE_CONSOLE_LOGS=true
CONSOLE_LOG_LEVEL=warn  # log, info, warn, error

# Browser console
CAPTURE_BROWSER_CONSOLE=true
```

### Report Configuration

```properties
# Report directory
REPORT_DIR=reports
REPORT_NAME_PATTERN=test-results-{timestamp}

# Report retention
REPORT_RETENTION_DAYS=90
REPORT_CLEANUP_ENABLED=true

# Report branding
REPORT_TITLE=My Project Test Results
REPORT_COMPANY_NAME=My Company
REPORT_LOGO_PATH=logo.png

# Report features
REPORT_SHOW_PASSED_STEPS=true
REPORT_SHOW_SKIPPED_SCENARIOS=true
REPORT_SHOW_EXECUTION_HISTORY=true
REPORT_SHOW_AI_INSIGHTS=true

# Email reporting
EMAIL_REPORT_ENABLED=false
EMAIL_RECIPIENTS=team@example.com
EMAIL_SEND_ON_FAILURE_ONLY=true
```

---

## 🚀 Parallel Execution (Expand existing)

### Worker Configuration

```properties
# Number of parallel workers
PARALLEL=true
MAX_PARALLEL_WORKERS=5

# Worker timeout
WORKER_TIMEOUT=600000

# Worker retry
WORKER_MAX_RETRIES=3

# Worker isolation
WORKER_ISOLATED_MODULES=true
WORKER_ISOLATED_BROWSER=true
```

### Browser Reuse in Parallel Mode

```properties
# Each worker gets isolated browser instance
BROWSER_REUSE_ENABLED=true
BROWSER_REUSE_PER_WORKER=true

# Context reuse per worker
CONTEXT_REUSE_PER_WORKER=true
```

**Behavior:**
- Each worker has own browser instance
- Browser reused within worker's scenarios
- Complete isolation between workers
- No shared state between workers

---

## 🔍 Advanced Features (Add section)

### Hooks and Lifecycle

```typescript
import { CSBefore, CSAfter, CSBeforeStep, CSAfterStep } from 'cs-playwright-test-framework';

export class Hooks {
    @CSBefore()
    async beforeScenario(): Promise<void> {
        console.log('Before each scenario');
    }

    @CSAfter()
    async afterScenario(): Promise<void> {
        console.log('After each scenario');
    }

    @CSBeforeStep()
    async beforeStep(): Promise<void> {
        console.log('Before each step');
    }

    @CSAfterStep()
    async afterStep(): Promise<void> {
        console.log('After each step');
    }

    // Tag-specific hooks
    @CSBefore({ tags: ['@database'] })
    async beforeDatabaseScenario(): Promise<void> {
        // Runs only for scenarios with @database tag
    }

    @CSAfter({ tags: ['@cleanup'] })
    async afterCleanupScenario(): Promise<void> {
        // Runs only for scenarios with @cleanup tag
    }
}
```

---

This completes the major missing sections. Let me know when you're ready and I'll integrate these into the README!
## 🔌 Module System

### Automatic Module Detection

The framework automatically detects which modules to load based on:
1. Explicit `--modules` parameter
2. Feature file analysis
3. Step definitions in use
4. Configuration settings

### Module Types

- **`ui`** - Browser automation, element handling, page objects
- **`api`** - REST API testing, HTTP client, validators
- **`database`** - Database connections, queries, transactions
- **`soap`** - SOAP/XML services, WS-Security

### Explicit Module Specification

```bash
# Load only API module
npx cs-playwright-run --project=myproject --modules=api

# Load multiple modules
npx cs-playwright-run --project=myproject --modules=api,database

# Load all modules
npx cs-playwright-run --project=myproject --modules=all
```

### Module Configuration

```properties
# config/myproject/common/common.env

# Modules to always load
MODULES=ui,api,database

# Module-specific settings
API_MODULE_TIMEOUT=30000
DATABASE_MODULE_POOL_SIZE=5
UI_MODULE_HEADLESS=true
```

### Lazy Loading Benefits

- **Sub-second startup** - Framework initializes in <1 second
- **Memory efficient** - Only loads what's needed
- **Faster test execution** - No unnecessary module overhead
- **Parallel-friendly** - Each worker loads independently

---

## 🗄️ Database Testing

The framework provides comprehensive database testing capabilities with support for **6 database types** and **100+ built-in step definitions**.

### Supported Databases

| Database | Type | Features |
|----------|------|----------|
| **MySQL** | SQL | Transactions, stored procedures, savepoints |
| **PostgreSQL** | SQL | Full SQL support, JSON operations |
| **SQL Server** | SQL | T-SQL, stored procedures, transactions |
| **Oracle** | SQL | PL/SQL, packages, procedures |
| **MongoDB** | NoSQL | Document operations, aggregations |
| **Redis** | Key-Value | Cache operations, pub/sub |

### Database Configuration

```properties
# config/myproject/common/databases.env

# Connection Configuration Pattern
DB_{NAME}_TYPE=mysql|postgresql|sqlserver|oracle|mongodb|redis
DB_{NAME}_HOST=hostname
DB_{NAME}_PORT=port
DB_{NAME}_DATABASE=database_name
DB_{NAME}_USERNAME=username
DB_{NAME}_PASSWORD=ENCRYPTED:...

# Example: Primary Database
DB_PRIMARY_TYPE=mysql
DB_PRIMARY_HOST=db.example.com
DB_PRIMARY_PORT=3306
DB_PRIMARY_DATABASE=myapp_db
DB_PRIMARY_USERNAME=app_user
DB_PRIMARY_PASSWORD=ENCRYPTED:U2FsdGVkX1+db123...

# Example: Secondary Database (Different Type)
DB_ANALYTICS_TYPE=postgresql
DB_ANALYTICS_HOST=analytics-db.example.com
DB_ANALYTICS_PORT=5432
DB_ANALYTICS_DATABASE=analytics
DB_ANALYTICS_USERNAME=analytics_user
DB_ANALYTICS_PASSWORD=ENCRYPTED:U2FsdGVkX1+analy456...

# Connection Pool Settings
DB_CONNECTION_POOL_SIZE=5
DB_CONNECTION_POOL_TIMEOUT=30000
DB_CONNECTION_TIMEOUT=10000
DB_QUERY_TIMEOUT=60000
```

### Database Features

#### Connection Management

```gherkin
# Connect to database by configuration name
Given user connects to "PRIMARY" database

# Connect with specific options
Given user connects to database with options:
  | host     | db.example.com    |
  | port     | 3306              |
  | database | myapp_db          |
  | username | app_user          |
  | password | {{config:DB_PASS}}|

# Connect with connection string
Given user connects with connection string "mysql://user:pass@host:3306/db"

# Switch between databases
Given user switches to database "ANALYTICS"

# Verify connection
Then user verifies database connection

# Disconnect
Given user disconnects from database
Given user disconnects from "PRIMARY" database
Given user disconnects from all databases
```

#### Query Execution

```gherkin
# Execute simple query
When user executes query "SELECT * FROM users WHERE active = 1"

# Execute with variable interpolation
When user executes query "SELECT * FROM users WHERE id = {{userId}}"

# Execute from file
When user executes query from file "queries/get_user_details.sql"

# Execute with parameters
When user executes parameterized query "SELECT * FROM users WHERE id = ?" with parameters:
  | 1 |

# Execute predefined query (from config)
When user executes predefined query "GET_ACTIVE_USERS"

# Execute with timeout
When user executes query "SELECT * FROM large_table" with timeout 120 seconds

# Execute scalar query (single value)
When user executes scalar query "SELECT COUNT(*) FROM users"

# Execute count query
When user executes count query "SELECT COUNT(*) FROM active_users"

# Execute and fetch first row only
When user executes query "SELECT * FROM users LIMIT 10" and fetches first row

# Execute with result limit
When user executes query "SELECT * FROM users" with limit 100

# Execute batch queries
When user executes batch queries:
  """
  DELETE FROM temp_users;
  INSERT INTO temp_users SELECT * FROM users WHERE active = 1;
  UPDATE temp_users SET processed = true;
  """

# Profile query execution
When user profiles query "SELECT * FROM users JOIN orders"
```

#### Data Validation

```gherkin
# Row count validation
Then the query result should have 5 rows
Then the query result should have at least 10 rows
Then the query result should have at most 100 rows
Then the query result should be empty

# Cell value validation
Then the value in row 1 column "username" should be "john.doe"
Then the value in row 2 column "email" should contain "@example.com"
Then the value in row 1 column "status" should match pattern "^(active|inactive)$"

# Null value validation
Then the value in row 1 column "deleted_at" should be null
Then the value in row 1 column "created_at" should not be null

# Column validation
Then all values in column "email" should be unique
Then all values in column "status" should be "active"
Then column "age" should contain value "25"
Then column "username" should not contain value "admin"

# Aggregation validation
Then the sum of column "amount" should be 15000.50
Then the average of column "rating" should be 4.5
Then the minimum value in column "price" should be "9.99"
Then the maximum value in column "quantity" should be "1000"

# Data type validation
Then column "email" should have data type "VARCHAR"
Then column "age" should have data type "INT"

# Range validation
Then values in column "age" should be between "18" and "65"
Then values in column "price" should be between "0" and "999.99"

# Column structure validation
Then the result should have columns:
  | id       |
  | username |
  | email    |
  | status   |

# Full data matching
Then the result should match:
  | id | username  | email                |
  | 1  | john.doe  | john@example.com     |
  | 2  | jane.smith| jane@example.com     |

# Scalar result validation
Then the scalar result should be "150"
```

#### Transactions

```gherkin
# Begin transaction
Given user begins database transaction

# Begin with isolation level
Given user begins database transaction with isolation level "READ_COMMITTED"
# Levels: READ_UNCOMMITTED, READ_COMMITTED, REPEATABLE_READ, SERIALIZABLE

# Execute queries within transaction
When user executes query "INSERT INTO users (name) VALUES ('Test')" within transaction
When user executes query "UPDATE users SET active = 1" within transaction

# Commit transaction
Then user commits database transaction

# Rollback transaction
Then user rolls back database transaction

# Savepoints
When user creates savepoint "before_delete"
When user executes query "DELETE FROM temp_data" within transaction
When user rolls back to savepoint "before_delete"
When user releases savepoint "before_delete"

# Transaction validation
Then database should have active transaction
Then database should not have active transaction

# Set transaction timeout
When user sets transaction timeout to 60 seconds
```

#### Stored Procedures & Functions

```gherkin
# Execute stored procedure
When user executes stored procedure "sp_GetUserDetails"

# Execute with parameters
When user executes stored procedure "sp_CreateUser" with parameters:
  | name      | value          | type    | direction |
  | firstName | John           | VARCHAR | IN        |
  | lastName  | Doe            | VARCHAR | IN        |
  | userId    |                | INT     | OUT       |

# Execute function
When user calls function "fn_CalculateTotal" and stores result as "total"

# Execute function with parameters
When user calls function "fn_GetDiscount" with parameters:
  | 1000  |
  | VIP   |

# Validate output parameters
Then the output parameter "userId" should be "123"

# Store output parameter
When user stores output parameter "userId" as "newUserId"

# Validate multiple result sets
Then the stored procedure should return 3 result sets

# Select specific result set
When user selects result set 2

# Validate return value
Then the return value should be "0"

# Execute system stored procedure
When user executes system stored procedure "sp_help"

# List available procedures
When user lists available stored procedures
```

#### Database-API Integration

```gherkin
# Execute query and use in API
When I execute query "SELECT * FROM users WHERE id = 1" and store results as "userDetails"
Then I use query result "userDetails" row 0 as variables

# Compare API response with database
Then I validate response path "$.user" against query result "userDetails"
Then I validate response path "$.user" against query result "userDetails" using key "id"
Then I validate response field "username" equals query result "userDetails" field "username"

# Check data existence before API call
When I check if data exists in table "users" where "email = 'test@example.com'"
```

#### Database Utilities

```gherkin
# Table operations
When user analyzes table "users"
When user truncates table "temp_data"
When user drops table "old_data"
When user creates table "new_table" with schema:
  """
  id INT PRIMARY KEY,
  name VARCHAR(100),
  created_at TIMESTAMP
  """

# Bulk operations
When user bulk inserts into table "users" from file "data/users.csv"
When user bulk inserts into table "users" from data:
  | name      | email             |
  | John Doe  | john@example.com  |
  | Jane Smith| jane@example.com  |

# Database backup
When user backs up database to "backups/db_backup.sql"

# Cache operations
When user clears database cache

# Query cancellation
When user cancels running query

# Database information
When user gets database version
When user lists all tables
When user describes table "users"
```

### Database Adapters

Each database adapter provides:
- Connection pooling
- Transaction management
- Prepared statements
- Query timeout handling
- Error translation
- Type conversion

Example adapter usage in code:

```typescript
import { DatabaseContext } from 'cs-playwright-test-framework';

const dbContext = DatabaseContext.getInstance();

// Execute query
const result = await dbContext.executeQuery(
  'SELECT * FROM users WHERE id = ?',
  [userId]
);

// Start transaction
await dbContext.beginTransactionTracking();
await dbContext.executeQuery('INSERT INTO users (name) VALUES (?)', ['John']);
await dbContext.commitTransaction();
```

---

## 🌐 API Testing (REST)

The framework provides **150+ built-in step definitions** for comprehensive REST API testing with support for all HTTP methods, authentication types, and validation scenarios.

### API Configuration

```properties
# config/myproject/common/api.env

# Base URLs
API_BASE_URL=https://api.example.com
API_VERSION=v1
API_ENDPOINT=https://api.example.com/v1

# Authentication
API_KEY=ENCRYPTED:U2FsdGVkX1+api123...
API_SECRET=ENCRYPTED:U2FsdGVkX1+secret456...
OAUTH_CLIENT_ID=client_id_123
OAUTH_CLIENT_SECRET=ENCRYPTED:U2FsdGVkX1+oauth789...
JWT_TOKEN=ENCRYPTED:U2FsdGVkX1+jwt012...

# Timeouts
API_TIMEOUT=30000
API_CONNECT_TIMEOUT=5000

# Retry
API_RETRY_COUNT=3
API_RETRY_DELAY=1000

# Proxy
API_PROXY_ENABLED=false
API_PROXY_HOST=proxy.example.com
API_PROXY_PORT=8080

# Headers
API_DEFAULT_HEADERS=Content-Type:application/json;Accept:application/json
```

### API Features

#### HTTP Methods

```gherkin
# GET Request
When I send a GET request to "/users"
When I send a GET request to "/users/{{userId}}"

# POST Request
When I send a POST request to "/users"
When I send a POST request to "/users" with body:
  """
  {
    "username": "john.doe",
    "email": "john@example.com",
    "password": "{{config:TEST_PASSWORD}}"
  }
  """

# PUT Request
When I send a PUT request to "/users/{{userId}}"

# PATCH Request
When I send a PATCH request to "/users/{{userId}}"

# DELETE Request
When I send a DELETE request to "/users/{{userId}}"

# HEAD Request
When I send a HEAD request to "/users"

# OPTIONS Request
When I send an OPTIONS request to "/users"
```

#### Request Configuration

```gherkin
# Set headers
When I set request header "Content-Type" to "application/json"
When I set request header "Authorization" to "Bearer {{token}}"

# Set multiple headers
When I set request headers:
  | Content-Type    | application/json |
  | Accept-Language | en-US            |
  | X-API-Key       | {{config:API_KEY}}|

# Query parameters
When I set query parameter "page" to "1"
When I set query parameter "limit" to "10"
When I set query parameter "filter" to "active=true"

# Request body
When I set request body to:
  """
  {
    "key": "value"
  }
  """

# Form data
When I set form field "username" to "john"
When I set form fields:
  | username | john      |
  | password | secret123 |

# JSON body
When I set JSON body:
  | name  | John Doe         |
  | email | john@example.com |

# XML body
When I set XML body:
  """
  <user>
    <name>John Doe</name>
    <email>john@example.com</email>
  </user>
  """

# Raw body
When I set raw body to "plain text content"

# Binary body
When I set binary body from "files/document.pdf" file

# Multipart form data
When I set multipart field "description" to "Profile photo"
When I add file "images/profile.jpg" as "photo" to multipart

# GraphQL
When I set GraphQL query:
  """
  query GetUser($id: ID!) {
    user(id: $id) {
      name
      email
    }
  }
  """
When I set GraphQL variables:
  """
  {
    "id": "{{userId}}"
  }
  """

# Timeout
When I set request timeout to 60 seconds

# Clear body
When I clear request body
```

#### Authentication

```gherkin
# Basic Authentication
When I use basic authentication with username "user" and password "pass"

# Bearer Token
When I use bearer token "{{config:API_TOKEN}}"

# API Key
When I use API key "X-API-Key" with value "{{config:API_KEY}}"

# JWT
When I use JWT authentication with token "{{jwt}}"

# OAuth2 - Client Credentials
When I use OAuth2 with client credentials:
  | token_url     | https://auth.example.com/token |
  | client_id     | {{config:CLIENT_ID}}           |
  | client_secret | {{config:CLIENT_SECRET}}       |
  | scope         | read write                     |

# OAuth2 - Password Grant
When I use OAuth2 with password grant:
  | token_url | https://auth.example.com/token |
  | username  | testuser                       |
  | password  | {{config:TEST_PASSWORD}}       |
  | client_id | {{config:CLIENT_ID}}           |

# Digest Authentication
When I use digest authentication with username "user" and password "pass"

# NTLM Authentication
When I use NTLM authentication with domain "COMPANY" username "user" and password "pass"

# AWS Signature (v4)
When I use AWS signature authentication with access key "{{config:AWS_ACCESS_KEY}}" and secret key "{{config:AWS_SECRET_KEY}}"
When I use AWS signature authentication with region "us-east-1" and service "s3"

# Certificate Authentication
When I use certificate authentication with cert "certs/client.crt" and key "certs/client.key"

# Custom Authentication Header
When I add custom authentication header "X-Custom-Auth" with value "{{authToken}}"

# Clear Authentication
When I clear authentication
```

#### Response Validation

```gherkin
# Status Code
Then response status should be 200
Then response status should be in [200, 201, 202]
Then response from "/users" status should be 200

# Response Time
Then response time should be less than 2000 ms

# Headers
Then response header "Content-Type" should be "application/json"
Then response header "Content-Type" should contain "json"
Then response header "X-Rate-Limit" should exist

# Cookies
Then response cookie "session_id" should exist
Then response cookie "user_token" should have value "{{token}}"

# Body
Then response body should be empty
Then response body should not be empty
Then response body should contain "success"
Then response body should match regex "^[a-z0-9]+$"

# JSON Validation
Then response body should be valid JSON
Then response JSON should have properties:
  | id       |
  | username |
  | email    |

# JSON Path
Then response JSON path "$.user.id" should equal "123"
Then response JSON path "$.user.email" should contain "@example.com"
Then response JSON path "$.users" array should have length 10
Then response JSON path "$.user.age" should be of type "number"
Then response JSON path "$.user.active" should exist

# JSON Schema Validation
Then response body should match JSON schema in "schemas/user_schema.json"

# XML Validation
Then response body should be valid XML
Then response XML path "//user/name" should equal "John Doe"
Then response XML element "user.email" should exist

# Hash Validation
Then response body MD5 hash should be "abc123..."
Then response body SHA256 hash should be "def456..."

# Custom Validation
Then I validate the response with custom validation:
  """
  function validate(response) {
    return response.body.users.length > 0;
  }
  """
```

#### Data Extraction & Variables

```gherkin
# Extract from response
When I extract "$.user.id" from response and save as "userId"
When I extract "$.token" from response and save as "authToken"
When I extract response header "Location" and save as "resourceUrl"

# Set variables
When I set variable "baseUrl" to "https://api.example.com"
When I set variable "userId" to "{{config:TEST_USER_ID}}"

# Use variables in requests
When I send a GET request to "{{baseUrl}}/users/{{userId}}"
When I set request header "Authorization" to "Bearer {{authToken}}"

# Save entire response
When API response should be saved as "userResponse"

# Print for debugging
When I print the last response
When I print the current context
```

#### Request Chaining

```gherkin
# Automatic variable extraction and chaining
Scenario: Create and update user
  When I send a POST request to "/users" with body:
    """
    {"username": "john", "email": "john@example.com"}
    """
  Then response status should be 201
  # Automatically extracts: {{lastId}}, {{lastResponse}}

  When I send a GET request to "/users/{{lastId}}"
  Then response status should be 200
  Then response JSON path "$.username" should equal "john"

  When I send a PUT request to "/users/{{lastId}}" with body:
    """
    {"username": "john.doe"}
    """
  Then response status should be 200
  Then response JSON path "$.username" should equal "john.doe"
```

#### File Operations

```gherkin
# Upload file
When I upload file "documents/report.pdf" to "/upload"

# Download file
When I download file from "/files/report.pdf" to "downloads/report.pdf"

# Multi-file upload
When I add file "file1.txt" as "file1" to multipart
When I add file "file2.txt" as "file2" to multipart
When I send a POST request to "/upload-multiple"
```

#### API Context Management

```gherkin
# Switch environments
When I use environment "staging"
When I use environment "production"

# Clear context
When I clear the API context

# Wait/Delay
When I wait for 5 seconds
When I wait for {{delay}} seconds
```

#### Proxy & Network

```properties
# Configuration
HTTP_PROXY=http://proxy.example.com:8080
HTTPS_PROXY=https://proxy.example.com:8443
NO_PROXY=localhost,127.0.0.1,.example.com
```

```gherkin
# Use proxy
When I use proxy "http://proxy.example.com:8080"
When I use SOCKS proxy "socks5://proxy.example.com:1080"

# Disable proxy
When I disable proxy
```

### API Client Usage in Code

```typescript
import { CSAPIClient, CSApiContext } from 'cs-playwright-test-framework';

// Get client instance
const apiClient = CSAPIClient.getInstance();

// Set base URL
apiClient.setBaseURL('https://api.example.com');

// Make requests
const response = await apiClient.get('/users');
const createResponse = await apiClient.post('/users', {
  username: 'john',
  email: 'john@example.com'
});

// Access context
const context = CSApiContextManager.getInstance().getCurrentContext();
const userId = context.getVariable('userId');
```

---

## 🧼 SOAP Testing

The framework provides **30+ built-in step definitions** for SOAP/XML web services testing with support for WS-Security and complex XML operations.

### SOAP Configuration

```properties
# config/myproject/common/soap.env

SOAP_ENDPOINT=https://soap.example.com/service
SOAP_WSDL_URL=https://soap.example.com/service?wsdl
SOAP_NAMESPACE=http://example.com/services
SOAP_VERSION=1.2
SOAP_TIMEOUT=60000

# WS-Security
SOAP_WS_USERNAME=soapuser
SOAP_WS_PASSWORD=ENCRYPTED:U2FsdGVkX1+soap123...
SOAP_WS_PASSWORD_TYPE=PasswordText
```

### SOAP Features

#### Basic Operations

```gherkin
# Load WSDL
When I load WSDL from "https://soap.example.com/service?wsdl"
When I load WSDL from "files/service.wsdl"

# Set endpoint
When I set SOAP endpoint to "https://soap.example.com/service"

# Set namespace
When I set SOAP namespace to "http://example.com/services"

# Set SOAP version
When I set SOAP version to "1.1"
When I set SOAP version to "1.2"

# Set SOAP action
When I set SOAP action to "http://example.com/GetUser"
```

#### Send SOAP Requests

```gherkin
# Simple operation
When I send SOAP request to "https://soap.example.com/service" with operation "GetUser"

# With parameters
When I send SOAP request to "https://soap.example.com/service" with operation "CreateUser" and parameters:
  | firstName | John         |
  | lastName  | Doe          |
  | email     | john@example.com |

# With custom body
When I send SOAP request with body:
  """
  <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
    <soap:Body>
      <GetUser xmlns="http://example.com/services">
        <userId>123</userId>
      </GetUser>
    </soap:Body>
  </soap:Envelope>
  """
```

#### Authentication

```gherkin
# Basic Authentication
When I send SOAP request with Basic Authentication using username "user" and password "pass"

# WS-Security Username Token
When I send SOAP request with WS-Security username "soapuser" password "{{config:SOAP_WS_PASSWORD}}" type "PasswordText"
When I send SOAP request with WS-Security username "soapuser" password "{{config:SOAP_WS_PASSWORD}}" type "PasswordDigest"

# WS-Security Headers
When I add WS-Security UsernameToken with username "soapuser" and password "{{config:SOAP_WS_PASSWORD}}"
When I add WS-Security Timestamp with TTL 300 seconds
```

#### Response Validation

```gherkin
# Status Code
Then the SOAP response status should be 200

# Headers
Then the SOAP response header "Content-Type" should be "text/xml"
Then the SOAP response header "Content-Type" should contain "xml"
Then the SOAP response Content-Type should be "text/xml; charset=utf-8"

# Response Time
Then I validate SOAP response time is less than 3000 ms

# XML Structure
Then the SOAP response should be valid XML

# XPath Validation
Then the SOAP response XPath "//user/name" should equal "John Doe"
Then the SOAP response XPath "//user/email" should contain "@example.com"
Then the SOAP response XPath "//user/age" should match pattern "^[0-9]+$"

# Element Validation
Then the SOAP response element "user.name" should exist
Then the SOAP response element "user.name" should have value "John Doe"
Then the SOAP response element "user.email" should contain "@example.com"

# Element Count
Then the SOAP response should have 10 occurrences of element "user"

# Full XML Matching
Then the SOAP response should match XML:
  """
  <response>
    <user>
      <name>John Doe</name>
      <email>john@example.com</email>
    </user>
  </response>
  """

# XML Matching (Order-Independent)
Then the SOAP response should match XML ignoring order:
  """
  <response>
    <user>
      <email>john@example.com</email>
      <name>John Doe</name>
    </user>
  </response>
  """

# Fault Handling
Then the SOAP response should not contain fault
Then the SOAP response should contain fault with code "Server"
Then the SOAP response should contain fault with message "Invalid user ID"
```

#### Data Extraction

```gherkin
# Extract element value
When I extract SOAP element "//user/id" and save as "userId"
When I query SOAP response with XPath "//user/name" and save as "userName"

# Save entire response
When I save SOAP response to variable "soapResponse"

# Debug
When I print SOAP request
When I print SOAP response
```

---

## 🖥️ UI Testing

### Page Object Model

```typescript
import { CSBasePage, CSElement, CSAction } from 'cs-playwright-test-framework';

@CSPage('login')
export class LoginPage extends CSBasePage {

    @CSElement({
        id: 'username',
        css: 'input[name="username"]',
        xpath: '//input[@id="username"]',
        description: 'Username input field',
        selfHeal: true
    })
    public usernameField!: CSWebElement;

    @CSElement({
        id: 'password',
        css: 'input[type="password"]',
        description: 'Password input field',
        selfHeal: true
    })
    public passwordField!: CSWebElement;

    @CSElement({
        css: 'button[type="submit"]',
        text: 'Login',
        description: 'Login button',
        selfHeal: true
    })
    public loginButton!: CSWebElement;

    @CSAction('Navigate to login page')
    async navigate() {
        await this.page.goto(this.config.get('BASE_URL') + '/login');
    }

    @CSAction('Login with credentials')
    async login(username: string, password: string) {
        await this.usernameField.type(username);
        await this.passwordField.type(password);
        await this.loginButton.click();
    }
}
```

### Element Locator Strategies

```typescript
@CSElement({
    // Multiple locator strategies (fallback order)
    id: 'submit-btn',              // 1. By ID (fastest)
    css: 'button.submit',          // 2. By CSS selector
    xpath: '//button[@type="submit"]', // 3. By XPath
    text: 'Submit',                // 4. By text content
    role: 'button',                // 5. By ARIA role
    testId: 'submit-button',       // 6. By data-testid
    placeholder: 'Enter text',     // 7. By placeholder
    label: 'Submit Button',        // 8. By label
    title: 'Submit Form',          // 9. By title attribute
    alt: 'Submit Icon',            // 10. By alt text (images)

    // Advanced options
    selfHeal: true,                // Enable self-healing
    waitForVisible: true,          // Wait for element to be visible
    timeout: 30000,                // Custom timeout
    description: 'Submit button',  // For logging/reporting

    // Dynamic locator generation
    aiFind: true,                  // Use AI to find element
    visualDescription: 'Blue button at bottom right' // AI visual description
})
public submitButton!: CSWebElement;
```

### Element Interactions

```gherkin
# Click
When user clicks on "{{loginButton}}"
When user double clicks on "{{element}}"
When user right clicks on "{{element}}"

# Type/Fill
When user types "text" into "{{inputField}}"
When user fills "{{inputField}}" with "text"
When user clears "{{inputField}}"

# Select
When user selects "option" from "{{dropdown}}"
When user selects option with value "value" from "{{dropdown}}"
When user selects option at index 2 from "{{dropdown}}"

# Checkbox/Radio
When user checks "{{checkbox}}"
When user unchecks "{{checkbox}}"

# Hover
When user hovers over "{{element}}"

# Drag and Drop
When user drags "{{source}}" to "{{target}}"

# Upload
When user uploads file "path/to/file.txt" to "{{fileInput}}"

# Wait
When user waits for "{{element}}" to be visible
When user waits for "{{element}}" to be hidden
When user waits for "{{element}}" to be enabled
When user waits 5 seconds

# Scroll
When user scrolls to "{{element}}"
When user scrolls to bottom of page
When user scrolls to top of page

# Focus
When user focuses on "{{element}}"
```

### Assertions

```gherkin
# Visibility
Then "{{element}}" should be visible
Then "{{element}}" should not be visible
Then "{{element}}" should be hidden

# Enabled/Disabled
Then "{{element}}" should be enabled
Then "{{element}}" should be disabled

# Checked
Then "{{checkbox}}" should be checked
Then "{{checkbox}}" should not be checked

# Text
Then "{{element}}" should have text "expected text"
Then "{{element}}" should contain text "partial text"
Then "{{element}}" text should match pattern "regex"

# Value
Then "{{input}}" should have value "expected value"
Then "{{input}}" value should contain "partial value"

# Attributes
Then "{{element}}" should have attribute "class" with value "btn"
Then "{{element}}" should have class "active"
Then "{{element}}" should have href "https://example.com"

# Count
Then page should have 10 elements matching "{{selector}}"
Then page should have at least 5 elements matching "{{selector}}"
```

---

## 📊 Data-Driven Testing

### Data Sources

#### Excel Files

```gherkin
@DataProvider(source="users.xlsx", sheet="TestData")
Scenario Outline: Login with multiple users
  When user logs in as "<username>" with "<password>"
  Then user should see "<result>"
```

#### CSV Files

```gherkin
@DataProvider(source="credentials.csv")
Scenario Outline: API authentication
  When I use basic authentication with username "<username>" and password "<password>"
  Then response status should be <expectedStatus>
```

#### JSON Files

```gherkin
@DataProvider(source="test_data.json", path="$.users")
Scenario Outline: User registration
  When I send a POST request to "/register" with body:
    """
    {
      "username": "<username>",
      "email": "<email>",
      "password": "<password>"
    }
    """
  Then response status should be 201
```

#### Database Queries

```gherkin
@DataProvider(source="database", query="SELECT * FROM test_users WHERE active = 1")
Scenario Outline: Process active users
  When I process user "<user_id>" with email "<email>"
  Then processing should be successful
```

#### API Responses

```gherkin
@DataProvider(source="api", endpoint="/test-data/users")
Scenario Outline: Validate user data
  When I verify user "<id>" has name "<name>"
  Then user data should be valid
```

### Data Generation

```typescript
import { CSDataGenerator } from 'cs-playwright-test-framework';

const generator = CSDataGenerator.getInstance();

// Generate random data
const email = generator.email();           // random.user@example.com
const username = generator.username();     // user_abc123
const password = generator.password();     // Complex123!@#
const firstName = generator.firstName();   // John
const lastName = generator.lastName();     // Doe
const fullName = generator.fullName();     // John Doe
const phoneNumber = generator.phoneNumber(); // +1-555-123-4567
const address = generator.address();       // Full address object
const company = generator.companyName();   // Acme Corporation
const uuid = generator.uuid();             // 550e8400-e29b-41d4-a716-446655440000
const number = generator.number(1, 100);   // Random number between 1-100

// Generate with pattern
const customId = generator.pattern('USER_{random}_{timestamp}');
// Result: USER_abc123_1234567890
```

---

## 🤖 AI & Self-Healing

### Self-Healing Elements

When an element fails to be found, the framework automatically tries alternative strategies:

```typescript
@CSElement({
    id: 'submit-btn',           // Primary locator
    css: 'button[type="submit"]', // Fallback 1
    text: 'Submit',              // Fallback 2
    role: 'button',              // Fallback 3
    selfHeal: true,             // Enable self-healing
    visualDescription: 'Blue submit button at bottom right' // AI fallback
})
```

### Healing Strategies

1. **Locator Fallback** - Try alternative locators in order
2. **Fuzzy Text Matching** - Match text with tolerance
3. **AI Visual Recognition** - Find by visual description
4. **DOM Structure Analysis** - Analyze DOM changes
5. **Similar Element Detection** - Find similar elements
6. **Pattern Learning** - Learn from past successful finds
7. **Predictive Healing** - Predict likely element locations
8. **Context-Based** - Use surrounding elements as context

### AI Features

```gherkin
# AI-powered element finding
When user clicks on element described as "blue button at bottom right"
When user types "text" into element described as "username input field"

# Visual element recognition
When user finds element by visual description "login button"

# Smart assertions
Then page should show "success message" somewhere
```

### Configuration

```properties
# Enable/disable AI features
AI_ENABLED=true
AI_HEALING_ENABLED=true
AI_PREDICTION_ENABLED=true
AI_LEARNING_ENABLED=true

# AI settings
AI_CONFIDENCE_THRESHOLD=0.7
AI_MAX_HEALING_ATTEMPTS=3
AI_LEARNING_DATA_PATH=./ai-data
```

---

## ⚡ Parallel Execution

### Configuration

```properties
# Enable parallel execution
PARALLEL=true
MAX_PARALLEL_WORKERS=8

# Worker configuration
WORKER_TIMEOUT=600000
WORKER_RETRY_COUNT=2

# Browser reuse (for faster execution)
BROWSER_REUSE_ENABLED=true
BROWSER_REUSE_STRATEGY=new-context-per-scenario
```

### Command Line

```bash
# Run in parallel
npx cs-playwright-run --project=myproject --parallel --workers=8

# Run specific number of workers
npx cs-playwright-run --project=myproject --parallel=6

# Serial execution (default)
npx cs-playwright-run --project=myproject --parallel=false
```

### Worker Isolation

Each worker gets:
- Isolated browser instance or context
- Separate database connections
- Independent API context
- Isolated configuration snapshot
- Separate evidence collection

### Parallel Database Testing

```properties
# Connection pool for parallel execution
DB_CONNECTION_POOL_SIZE=10
DB_CONNECTION_PER_WORKER=true
```

### Parallel API Testing

```properties
# API concurrency
API_MAX_CONCURRENT_REQUESTS=20
API_RATE_LIMIT=100
```

---

## 📊 Reporting & Evidence

### Report Formats

```properties
REPORT_FORMATS=html,json,junit,pdf
REPORT_OUTPUT_DIR=./reports
REPORT_OPEN_AFTER_RUN=true
REPORT_NAME=Test_Report_{timestamp}
```

### HTML Report Features

- Test execution timeline
- Pass/fail status with details
- Screenshots for failures
- Video recordings
- Console logs
- Network HAR files
- Step-by-step execution
- Filterable by tags
- Search functionality
- Export to PDF

### Evidence Collection

```properties
# Screenshots
SCREENSHOT_ON_FAILURE=true
SCREENSHOT_ON_PASS=false
SCREENSHOT_FULL_PAGE=true

# Video
VIDEO_RECORD=on-failure
VIDEO_SIZE=1920x1080
VIDEO_FPS=25

# Network
NETWORK_HAR_ENABLED=true
NETWORK_HAR_ON_FAILURE_ONLY=false

# Console Logs
CONSOLE_LOG_ENABLED=true
CONSOLE_LOG_LEVEL=warn

# Evidence retention
EVIDENCE_RETENTION_DAYS=30
EVIDENCE_COMPRESS=true
```

### Live Dashboard

```properties
DASHBOARD_ENABLED=true
DASHBOARD_WS_PORT=8080
DASHBOARD_AUTO_OPEN=true
DASHBOARD_REFRESH_INTERVAL=1000
```

Access at: `http://localhost:8080`

Features:
- Real-time test execution
- Live test status
- Progress tracking
- Worker status
- Resource usage
- Error notifications
- Test metrics

---

## 🔗 Azure DevOps Integration

### Configuration

```properties
ADO_ENABLED=true
ADO_ORGANIZATION=myorg
ADO_PROJECT=myproject
ADO_PAT=ENCRYPTED:U2FsdGVkX1+ado123...

# Test case sync
ADO_UPDATE_TEST_CASES=true
ADO_CREATE_TEST_RUNS=true
ADO_ATTACH_EVIDENCE=true

# Bug creation
ADO_CREATE_BUGS_ON_FAILURE=true
ADO_BUG_AREA_PATH=Product\QA
ADO_BUG_ITERATION_PATH=Sprint 1
ADO_BUG_ASSIGNED_TO=qa-team@example.com

# Proxy
ADO_PROXY_ENABLED=true
ADO_PROXY_HOST=proxy.company.com
ADO_PROXY_PORT=8080
```

### Features

- Automatic test case sync
- Test run creation
- Result publishing
- Evidence attachment (screenshots, videos, logs)
- Bug creation on failure
- Work item linking
- Test plan integration
- Tag extraction
- Custom fields mapping

---

## 🚀 Advanced Features

### Custom Step Definitions

```typescript
import { CSBDDStepDef } from 'cs-playwright-test-framework';

export class CustomSteps {

    @CSBDDStepDef('user performs custom action {string}')
    async customAction(action: string): Promise<void> {
        // Your implementation
        const config = this.config;
        const browser = this.browserManager;
        const page = browser.getPage();

        // Perform action
        await page.locator(`[data-action="${action}"]`).click();
    }
}
```

### Hooks

```typescript
import { BeforeAll, AfterAll, Before, After } from 'cs-playwright-test-framework';

@BeforeAll()
async function globalSetup() {
    // Runs once before all tests
    console.log('Global setup');
}

@Before({ tags: '@database' })
async function setupDatabase() {
    // Runs before each @database test
}

@After()
async function cleanup() {
    // Runs after each test
}

@AfterAll()
async function globalTeardown() {
    // Runs once after all tests
}
```

### Custom Reporters

```typescript
import { CSReporter } from 'cs-playwright-test-framework';

export class CustomReporter {

    onTestStart(test: TestInfo) {
        CSReporter.info(`Starting: ${test.name}`);
        // Send to external system
    }

    onTestEnd(test: TestInfo) {
        if (test.status === 'failed') {
            // Send notification
            this.notifySlack(test);
        }
    }
}
```

### Variable Encryption

```bash
# Encrypt value
npx cs-encrypt "mySecretPassword"
# Output: ENCRYPTED:U2FsdGVkX1+abc123...

# Decrypt value (for verification)
npx cs-decrypt "ENCRYPTED:U2FsdGVkX1+abc123..."
# Output: mySecretPassword

# Batch encrypt from file
npx cs-encrypt-file config/secrets.txt
```

### Configuration Validation

```bash
# Validate configuration files
npx cs-config-validate --project=myproject --env=prod

# Show effective configuration
npx cs-config-show --project=myproject --env=prod

# Check variable resolution
npx cs-config-resolve "{{BASE_URL}}/api"
```

---

## 📖 Built-in Step Definitions Reference

### Database Steps (100+)

#### Connection Management
```
user connects to "{database_name}" database
user connects with connection string "{connection_string}"
user connects to database with options:
user switches to database "{database_name}"
user disconnects from database
user disconnects from "{database_name}" database
user disconnects from all databases
user verifies database connection
user sets database timeout to {seconds} seconds
```

#### Query Execution
```
user executes query "{sql}"
user executes query from file "{file_path}"
user executes parameterized query "{sql}" with parameters:
user executes predefined query "{query_name}"
user executes batch queries:
user executes query "{sql}" with timeout {seconds} seconds
user executes invalid query "{sql}"
user executes scalar query "{sql}"
user executes count query "{sql}"
user executes query "{sql}" and fetches first row
user executes query "{sql}" with limit {number}
user profiles query "{sql}"
user cancels running query
```

#### Data Validation
```
the query result should have {number} rows
the query result should have at least {number} rows
the query result should have at most {number} rows
the query result should be empty
the value in row {row} column "{column}" should be "{value}"
the value in row {row} column "{column}" should contain "{value}"
the value in row {row} column "{column}" should match pattern "{regex}"
the value in row {row} column "{column}" should be null
the value in row {row} column "{column}" should not be null
all values in column "{column}" should be unique
all values in column "{column}" should be "{value}"
column "{column}" should contain value "{value}"
column "{column}" should not contain value "{value}"
the sum of column "{column}" should be {number}
the average of column "{column}" should be {number}
the minimum value in column "{column}" should be "{value}"
the maximum value in column "{column}" should be "{value}"
column "{column}" should have data type "{type}"
values in column "{column}" should be between "{min}" and "{max}"
the result should have columns:
the result should match:
the scalar result should be "{value}"
```

#### Transactions
```
user begins database transaction
user begins database transaction with isolation level "{level}"
user commits database transaction
user rolls back database transaction
user creates savepoint "{name}"
user rolls back to savepoint "{name}"
user releases savepoint "{name}"
database should have active transaction
database should not have active transaction
user executes query "{sql}" within transaction
user sets transaction timeout to {seconds} seconds
```

#### Stored Procedures & Functions
```
user executes stored procedure "{procedure_name}"
user executes stored procedure "{procedure_name}" with parameters:
user calls function "{function_name}" and stores result as "{variable}"
user calls function "{function_name}" with parameters:
the output parameter "{param_name}" should be "{value}"
user stores output parameter "{param_name}" as "{variable}"
the stored procedure should return {number} result sets
user selects result set {number}
the return value should be "{value}"
user executes system stored procedure "{procedure_name}"
user lists available stored procedures
```

#### Database Utilities
```
user analyzes table "{table_name}"
user backs up database to "{file_path}"
user clears database cache
user truncates table "{table_name}"
user drops table "{table_name}"
user creates table "{table_name}" with schema:
user bulk inserts into table "{table_name}" from file "{file_path}"
user bulk inserts into table "{table_name}" from data:
user gets database version
user lists all tables
user describes table "{table_name}"
```

### API Steps (REST) (150+)

#### HTTP Methods
```
I send a GET request to "{endpoint}"
I send a POST request to "{endpoint}"
I send a POST request to "{endpoint}" with body:
I send a PUT request to "{endpoint}"
I send a PATCH request to "{endpoint}"
I send a DELETE request to "{endpoint}"
I send a HEAD request to "{endpoint}"
I send an OPTIONS request to "{endpoint}"
```

#### Request Configuration
```
I set request header "{name}" to "{value}"
I set request headers:
I set query parameter "{name}" to "{value}"
I set request body to:
I set form field "{name}" to "{value}"
I set form fields:
I set JSON body:
I set XML body:
I set raw body to "{content}"
I set binary body from "{file_path}" file
I set multipart field "{name}" to "{value}"
I add file "{file_path}" as "{field_name}" to multipart
I set GraphQL query:
I set GraphQL variables:
I set request timeout to {seconds} seconds
I clear request body
```

#### Authentication
```
I use basic authentication with username "{username}" and password "{password}"
I use bearer token "{token}"
I use API key "{header_name}" with value "{value}"
I use JWT authentication with token "{token}"
I use OAuth2 with client credentials:
I use OAuth2 with password grant:
I use digest authentication with username "{username}" and password "{password}"
I use NTLM authentication with domain "{domain}" username "{username}" and password "{password}"
I use AWS signature authentication with access key "{access_key}" and secret key "{secret_key}"
I use AWS signature authentication with region "{region}" and service "{service}"
I use certificate authentication with cert "{cert_path}" and key "{key_path}"
I add custom authentication header "{name}" with value "{value}"
I clear authentication
```

#### Response Validation
```
response status should be {status_code}
response from "{endpoint}" status should be {status_code}
response time should be less than {milliseconds} ms
response header "{name}" should be "{value}"
response header "{name}" should contain "{value}"
response cookie "{name}" should exist
response body should be empty
response body should contain "{text}"
response body should match regex "{pattern}"
response body should be valid JSON
response JSON should have properties:
response JSON path "{json_path}" should equal "{value}"
response JSON path "{json_path}" should contain "{value}"
response JSON path "{json_path}" array should have length {number}
response JSON path "{json_path}" should be of type "{type}"
response JSON path "{json_path}" should exist
response body should match JSON schema in "{file_path}"
response XML path "{xpath}" should equal "{value}"
response body MD5 hash should be "{hash}"
I validate the response with custom validation:
```

#### Data Extraction
```
I extract "{json_path}" from response and save as "{variable}"
I set variable "{name}" to "{value}"
API response should be saved as "{variable}"
I print the last response
I print the current context
```

#### File Operations
```
I upload file "{file_path}" to "{endpoint}"
I download file from "{endpoint}" to "{file_path}"
```

#### Context Management
```
I use environment "{environment}"
I clear the API context
I wait for {seconds} seconds
```

### SOAP Steps (30+)

#### Basic Operations
```
I load WSDL from "{wsdl_url}"
I set SOAP endpoint to "{endpoint}"
I set SOAP namespace to "{namespace}"
I set SOAP version to "{version}"
I set SOAP action to "{action}"
```

#### Send Requests
```
I send SOAP request to "{endpoint}" with operation "{operation}"
I send SOAP request to "{endpoint}" with operation "{operation}" and parameters:
I send SOAP request with body:
I send SOAP request with Basic Authentication using username "{username}" and password "{password}"
I send SOAP request with WS-Security username "{username}" password "{password}" type "{type}"
I add WS-Security UsernameToken with username "{username}" and password "{password}"
I add WS-Security Timestamp with TTL {seconds} seconds
```

#### Response Validation
```
the SOAP response status should be {status_code}
the SOAP response header "{name}" should be "{value}"
the SOAP response header "{name}" should contain "{value}"
the SOAP response Content-Type should be "{type}"
I validate SOAP response time is less than {milliseconds} ms
the SOAP response should be valid XML
the SOAP response XPath "{xpath}" should equal "{value}"
the SOAP response XPath "{xpath}" should contain "{value}"
the SOAP response XPath "{xpath}" should match pattern "{pattern}"
the SOAP response element "{element}" should exist
the SOAP response element "{element}" should have value "{value}"
the SOAP response element "{element}" should contain "{value}"
the SOAP response should have {number} occurrences of element "{element}"
the SOAP response should match XML:
the SOAP response should match XML ignoring order:
the SOAP response should not contain fault
the SOAP response should contain fault with code "{code}"
the SOAP response should contain fault with message "{message}"
```

#### Data Extraction
```
I extract SOAP element "{xpath}" and save as "{variable}"
I query SOAP response with XPath "{xpath}" and save as "{variable}"
I save SOAP response to variable "{variable}"
I print SOAP request
I print SOAP response
```

---

## 🔧 API Reference

### Core Classes

#### CSConfigurationManager
```typescript
// Get instance
const config = CSConfigurationManager.getInstance();

// Initialize with args
await config.initialize({ project: 'myproject', env: 'dev' });

// Get values
const baseUrl = config.get('BASE_URL');
const timeout = config.getNumber('TIMEOUT', 30000);
const isEnabled = config.getBoolean('FEATURE_ENABLED', false);

// Set values
config.set('CUSTOM_VAR', 'value');

// Interpolation
const url = config.interpolate('{{BASE_URL}}/{{endpoint}}', contextVariables);

// Check existence
if (config.has('API_KEY')) {
    // ...
}
```

#### CSBrowserManager
```typescript
const browserManager = CSBrowserManager.getInstance();

// Launch browser
await browserManager.launch({
    headless: true,
    browser: 'chromium'
});

// Get page
const page = browserManager.getPage();

// Get browser
const browser = browserManager.getBrowser();

// Close
await browserManager.close();
```

#### CSAPIClient
```typescript
const apiClient = CSAPIClient.getInstance();

// Set base URL
apiClient.setBaseURL('https://api.example.com');

// Make requests
const response = await apiClient.get('/users');
const postResponse = await apiClient.post('/users', { name: 'John' });

// With headers
const headers = { 'Authorization': 'Bearer token' };
const response2 = await apiClient.get('/users', {}, headers);

// With authentication
apiClient.setBasicAuth('username', 'password');
apiClient.setBearerToken('token');
```

#### DatabaseContext
```typescript
const dbContext = DatabaseContext.getInstance();

// Execute query
const result = await dbContext.executeQuery('SELECT * FROM users');

// With parameters
const result2 = await dbContext.executeQuery(
    'SELECT * FROM users WHERE id = ?',
    [userId]
);

// Transactions
await dbContext.beginTransactionTracking();
await dbContext.executeQuery('INSERT INTO users...');
await dbContext.commitTransaction();

// Store results
dbContext.storeResult('users', result);
const storedResult = dbContext.getStoredResult('users');
```

#### CSReporter
```typescript
// Logging
CSReporter.info('Info message');
CSReporter.debug('Debug message');
CSReporter.warn('Warning message');
CSReporter.error('Error message');

// Test lifecycle
CSReporter.startTest('Test Name');
CSReporter.pass('Test passed');
CSReporter.fail('Test failed', error);
CSReporter.endTest('pass');

// Evidence
CSReporter.addScreenshot(path);
CSReporter.addVideo(path);
CSReporter.addLog('Custom log entry');
```

---

## 🎓 Best Practices

### Configuration
1. Use 7-level hierarchy effectively - put environment-specific values in environment configs
2. Encrypt all sensitive data - passwords, API keys, tokens
3. Use variable interpolation - avoid duplication
4. Keep config files in version control - except sensitive values
5. Document custom variables - use comments

### Test Organization
1. Follow BDD principles - clear Given/When/Then
2. Use tags effectively - for filtering and organization
3. Keep scenarios focused - one feature per scenario
4. Avoid hardcoding - use configuration and variables
5. Use page objects - for UI tests
6. Reuse step definitions - from built-in library

### Database Testing
1. Use transactions - for data isolation
2. Clean up test data - after tests
3. Use connection pools - for parallel execution
4. Index test queries - for performance
5. Validate critical data - don't assume

### API Testing
1. Use request chaining - extract and reuse values
2. Validate all responses - status, headers, body
3. Test error scenarios - not just happy path
4. Use authentication - don't hardcode tokens
5. Handle rate limiting - use retries

### Parallel Execution
1. Design for isolation - no shared state
2. Use connection pools - for databases
3. Test locally first - before parallel
4. Monitor resources - CPU, memory, connections
5. Clean up properly - in After hooks

---

## 🆘 Troubleshooting

### Common Issues

#### Configuration Not Loading
```bash
# Debug configuration
export DEBUG=true
npx cs-playwright-run --project=myproject --env=dev

# Validate configuration
npx cs-config-validate --project=myproject
```

#### Database Connection Fails
```
Error: No active database connection

Solution:
1. Check database configuration
2. Verify credentials
3. Test network connectivity
4. Check connection pool settings
```

#### Element Not Found
```
Error: Element not found

Solution:
1. Enable self-healing: selfHeal: true
2. Add multiple locators
3. Increase timeout
4. Use AI element finding
```

#### Parallel Execution Issues
```
Error: Worker timeout

Solution:
1. Increase WORKER_TIMEOUT
2. Check resource limits
3. Reduce worker count
4. Enable browser reuse
```

---

## 📄 License

CS License

---

## 💬 Support & Community

- **Issues**: [GitHub Issues](your-repo/issues)
- **Discussions**: [GitHub Discussions](your-repo/discussions)
- **Documentation**: [Full Docs](your-docs-url)
- **Examples**: [Example Repository](your-examples-repo)

---

**Built with ❤️ by the CS Team**

*Remember: Everything is configurable, nothing is hardcoded!* ⚡
