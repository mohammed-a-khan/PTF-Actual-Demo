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
