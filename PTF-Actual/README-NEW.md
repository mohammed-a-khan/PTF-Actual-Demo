# CS Playwright Test Framework

## Introduction

The CS Playwright Test Framework is a TypeScript-based test automation framework built on Microsoft Playwright. It provides a structured approach to writing, organizing, and executing automated tests for web applications, APIs, databases, and SOAP services.

## What This Framework Provides

### Core Capabilities

**BDD/Gherkin Support**
- Write tests in Gherkin syntax using Feature files
- Organize step definitions using TypeScript decorators
- Support for Scenario Outlines with data providers
- Background steps and hooks for test lifecycle management

**Multi-Module Testing**
- **UI Testing**: Browser automation with Playwright
- **API Testing**: REST/HTTP request and response validation
- **Database Testing**: SQL queries, transactions, stored procedures
- **SOAP Testing**: SOAP/WSDL web service integration

**Configuration Management**
- Hierarchical configuration system (global → project → environment)
- Environment variable interpolation and runtime resolution
- Encryption support for sensitive data
- Command-line override capabilities

**Element Self-Healing**
- Automatic fallback to alternative locator strategies
- AI-powered element detection when standard locators fail
- Configurable healing strategies and logging

**Parallel Execution**
- Worker-based parallel test execution
- Browser pool management for resource optimization
- Per-worker configuration isolation

**Comprehensive Reporting**
- HTML reports with detailed test execution data
- PDF export capabilities
- Excel reports for test management
- JSON output for CI/CD integration
- JUnit XML for test result publishing

**Azure DevOps Integration**
- Test case synchronization
- Test run creation and updates
- Bug creation on test failures
- Proxy support for corporate environments

## Who Should Use This Framework

**QA Engineers** who need to:
- Write maintainable automated tests using BDD
- Test multiple layers (UI, API, Database)
- Execute tests in parallel for faster feedback
- Generate professional reports for stakeholders

**Development Teams** who need to:
- Integrate automated tests into CI/CD pipelines
- Maintain test suites across multiple projects
- Share common test utilities and configurations
- Track test results in Azure DevOps

**Test Automation Architects** who need to:
- Standardize testing practices across teams
- Implement self-healing test strategies
- Optimize test execution performance
- Integrate with enterprise tools and workflows

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    CLI Entry Point                           │
│                   (src/index.ts)                             │
└────────────────────────┬────────────────────────────────────┘
                         │
        ┌────────────────┴────────────────┐
        │                                 │
┌───────▼────────┐              ┌────────▼────────┐
│  Configuration │              │   BDD Runner    │
│    Manager     │◄─────────────┤  (CSBDDRunner)  │
└────────────────┘              └────────┬────────┘
                                         │
                    ┌────────────────────┼────────────────────┐
                    │                    │                    │
            ┌───────▼────────┐  ┌───────▼────────┐  ┌───────▼────────┐
            │  Browser Mgmt  │  │   API Client   │  │  Database Mgmt │
            │ (CSBrowserMgr) │  │  (CSAPIClient) │  │  (CSDatabase)  │
            └────────┬────────┘  └────────┬───────┘  └────────┬───────┘
                     │                    │                   │
            ┌────────▼────────┐  ┌───────▼────────┐  ┌───────▼───────┐
            │  Element Layer  │  │  Request Layer │  │  Query Layer  │
            │  (CSWebElement) │  │  (Validation)  │  │ (Transaction) │
            └─────────────────┘  └────────────────┘  └───────────────┘
                     │                    │                   │
            ┌────────▼────────────────────▼───────────────────▼───────┐
            │                    Reporter System                        │
            │         (HTML, PDF, Excel, JSON, JUnit)                  │
            └──────────────────────────────────────────────────────────┘
```

### Component Responsibilities

**Configuration Manager** (`CSConfigurationManager`)
- Loads and merges configuration from multiple sources
- Resolves variables and encrypted values
- Provides thread-safe access to configuration properties

**BDD Runner** (`CSBDDRunner`)
- Parses Gherkin feature files
- Executes scenarios and manages test lifecycle
- Coordinates browser, API, and database operations
- Handles parallel execution with worker processes

**Browser Manager** (`CSBrowserManager`)
- Manages browser instances and contexts
- Implements browser reuse strategies
- Handles browser pool for parallel execution
- Captures artifacts (screenshots, videos, traces, HAR files)

**Element Layer** (`CSWebElement`)
- Provides enhanced element interaction methods
- Implements self-healing with fallback locators
- Integrates with AI for visual element detection
- Logs all interactions for debugging

**API Client** (`CSAPIClient`)
- Executes HTTP requests with configuration
- Chains requests with variable extraction
- Validates responses against expectations
- Supports authentication strategies

**Database Manager** (`CSDatabaseManager`)
- Connects to multiple database types (MySQL, PostgreSQL, SQL Server, MongoDB, Oracle, Redis)
- Executes queries and stored procedures
- Manages transactions with auto-rollback
- Maintains connection pools for performance

**Reporter System** (`CSReporter`, `CSHTMLReporter`)
- Collects test execution data
- Generates multiple report formats
- Provides real-time dashboard via WebSocket
- Integrates with Azure DevOps

## Framework Design Principles

**1. Configuration Over Code**
- All behavior controlled through configuration files
- No hard-coded values in test code
- Environment-specific configurations isolated

**2. Convention Over Configuration**
- Standard directory structure for projects
- Predictable file naming patterns
- Automatic discovery of step definitions

**3. Separation of Concerns**
- Step definitions contain only business logic
- Page objects encapsulate element locations
- Utilities handle technical operations

**4. Fail-Safe Defaults**
- Sensible defaults for all configurations
- Graceful degradation when features unavailable
- Comprehensive error messages

**5. Performance First**
- Lazy loading of modules
- Selective step definition loading
- Efficient browser reuse strategies
- Parallel execution support

## Prerequisites

Before using this framework, ensure you have:

**Required Software**
- **Node.js**: Version 20.0.0 or higher
- **npm**: Version 9.0.0 or higher (included with Node.js)
- **Git**: For version control and cloning repositories

**Operating System**
- Windows 10/11 (x64)
- macOS 12+ (Intel or Apple Silicon)
- Linux (Ubuntu 20.04+, CentOS 8+, or equivalent)

**Development Environment**
- **VS Code** (recommended) with extensions:
  - Cucumber (Gherkin) Full Support
  - ESLint
  - Prettier - Code formatter
- **OR** Any IDE with TypeScript support (WebStorm, IntelliJ IDEA)

**Optional Software**
- **Docker**: For database testing (if using containerized databases)
- **Azure CLI**: For Azure DevOps integration
- **MySQL/PostgreSQL/SQL Server Client**: For database testing verification

**Network Access**
- Internet connection for npm package installation
- Playwright browser downloads (~500MB per browser)
- Azure DevOps API access (if using ADO integration)
- Corporate proxy configuration (if behind firewall)

**Skills Required**
- Basic TypeScript/JavaScript knowledge
- Understanding of Gherkin/BDD syntax
- Familiarity with CSS selectors and XPath
- Basic command-line usage

---

## Installation & Quick Start

This section provides step-by-step instructions for installing the framework, initializing a test project, and running your first automated test.

### Installation Methods

The CS Playwright Test Framework is distributed as an npm package and can be installed in two ways:

**Method 1: Install from Azure Artifacts Feed** (Recommended for organizations)
```bash
# Configure npm to use Azure Artifacts feed
npm config set registry https://pkgs.dev.azure.com/mdakhan/_packaging/cs-framework/npm/registry/

# Install the framework globally
npm install -g cs-playwright-test-framework

# OR install as project dependency
npm install --save-dev cs-playwright-test-framework
```

**Method 2: Install from Local Package** (For development or offline environments)
```bash
# If you have the framework source code
cd /path/to/cs-playwright-test-framework
npm run build
npm pack

# Install the generated .tgz file in your project
cd /path/to/your-project
npm install /path/to/cs-playwright-test-framework-1.0.8.tgz
```

**Post-Installation Browser Setup**

The framework uses Playwright, which requires browser binaries. These are automatically downloaded during installation through the `postinstall` script defined in `package.json:19`:

```json
"postinstall": "playwright install"
```

This downloads Chromium (~170MB), Firefox (~90MB), and WebKit (~80MB). To install only specific browsers:

```bash
# Install only Chromium
npx playwright install chromium

# Install Chromium and Firefox
npx playwright install chromium firefox
```

**Verification**

Verify the installation by checking the framework version:

```bash
npx cs-playwright-framework --version
# Output: CS Test Automation Framework v3.0.0
```

Display available CLI options:

```bash
npx cs-playwright-framework --help
```

### Project Initialization

After installing the framework, create a new test automation project with the required directory structure and configuration files.

**Step 1: Create Project Directory**

```bash
mkdir my-test-project
cd my-test-project
npm init -y
```

This creates a `package.json` file. Update it to include the framework dependency:

```json
{
  "name": "my-test-project",
  "version": "1.0.0",
  "scripts": {
    "cs-framework": "cross-env NODE_OPTIONS=\"--tls-min-v1.2\" npx cs-playwright-framework",
    "test": "npm run cs-framework -- --project=myproject",
    "test:headless": "npm run cs-framework -- --project=myproject --headless=true",
    "test:parallel": "npm run cs-framework -- --project=myproject --parallel --workers=4"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "cross-env": "^10.1.0",
    "ts-node": "^10.9.2",
    "typescript": "^5.0.0"
  }
}
```

**Understanding the Scripts:**

- **`cs-framework` script**: Base command with `cross-env` to set Node.js TLS minimum version to 1.2. This resolves TLS protocol errors when connecting to external APIs/databases (see `src/index.ts:7` - handled via package.json script).
- **`--project` parameter**: Specifies which project configuration to load from `config/{project}/` directory. Maps to `CSConfigurationManager` Level 4 & 3 in the 7-level hierarchy (`src/core/CSConfigurationManager.ts:54-59`).
- **`--headless` parameter**: Overrides `HEADLESS` configuration property to run browser without UI. Useful for CI/CD pipelines. Maps to configuration Level 1 (CLI arguments have highest priority - `src/core/CSConfigurationManager.ts:9`).
- **`--parallel` and `--workers`**: Enables parallel test execution with specified number of worker processes. See `src/parallel/worker-process.ts` and `src/parallel/CSWorkerManager.ts` for worker orchestration details.

**Step 2: Create Directory Structure**

The framework follows a convention-over-configuration approach with standard directory structure:

```bash
mkdir -p config/myproject/{common,environments}
mkdir -p test/myproject/{features,steps,pages}
```

**Directory Explanation:**

```
my-test-project/
├── config/                          # Configuration hierarchy
│   ├── global.env                   # Level 7: Global defaults (lowest priority)
│   ├── common/                      # Shared configuration across projects
│   │   ├── common.env              # Level 6: Common config
│   │   └── environments/
│   │       ├── dev.env             # Level 5: Common environment-specific
│   │       ├── staging.env
│   │       └── prod.env
│   └── myproject/                   # Project-specific configuration
│       ├── common/
│       │   └── common.env          # Level 4: Project common
│       ├── environments/
│       │   ├── dev.env             # Level 3: Project environment-specific (highest file priority)
│       │   ├── staging.env
│       │   └── prod.env
│       └── myproject.env           # Additional project config (loaded at Level 3)
├── test/
│   ├── common/                     # Shared test utilities
│   │   ├── steps/                  # Reusable step definitions
│   │   └── pages/                  # Shared page objects
│   └── myproject/                  # Project-specific tests
│       ├── features/               # Gherkin feature files
│       │   └── example.feature
│       ├── steps/                  # Step definition implementations
│       │   └── example.steps.ts
│       └── pages/                  # Page object models
│           └── ExamplePage.ts
├── reports/                        # Generated test reports
├── package.json
└── tsconfig.json                   # TypeScript configuration
```

**Configuration Hierarchy Deep Dive:**

The `CSConfigurationManager` (`src/core/CSConfigurationManager.ts:8-17`) implements a 7-level merge strategy where higher levels override lower levels:

1. **Level 1 (Highest)**: Command-line arguments (`--headless=true`)
2. **Level 2**: Environment variables (`export HEADLESS=true`)
3. **Level 3**: `config/{project}/environments/{environment}.env`
4. **Level 4**: `config/{project}/common/common.env`
5. **Level 5**: `config/common/environments/{environment}.env`
6. **Level 6**: `config/common/common.env`
7. **Level 7 (Lowest)**: `config/global.env`

**Why This Hierarchy?**

- **Flexibility**: Override production configs for local debugging via CLI without modifying files
- **Environment Isolation**: Separate dev/staging/prod configurations
- **Project Isolation**: Multiple projects can coexist with independent configurations
- **Common Defaults**: Share baseline configs across projects (timeouts, browser settings)
- **Version Control**: Commit common configs; exclude environment-specific secrets via `.gitignore`

**Loading Process** (`src/core/CSConfigurationManager.ts:35-84`):

```typescript
public async initialize(args: any = {}): Promise<void> {
    const project = args.project || process.env.PROJECT || 'common';
    const environment = args.env || args.environment || process.env.ENVIRONMENT || 'dev';

    // Load in reverse priority order (lowest → highest)
    await this.loadConfig('config/global.env', 'Global defaults');
    await this.loadConfig('config/common/common.env', 'Common config');
    await this.loadConfig(`config/common/environments/${environment}.env`, 'Common environment');
    await this.loadConfig(`config/${project}/common/common.env`, 'Project common');
    await this.loadConfig(`config/${project}/environments/${environment}.env`, 'Project environment');

    // Level 2 & 1: Environment variables and CLI args
    this.loadEnvironmentVariables();
    this.loadCommandLineArgs(args);

    // Advanced interpolation and decryption
    this.performAdvancedInterpolation();
    this.decryptValues();
}
```

**Step 3: Create Configuration Files**

**`config/global.env`** - Global defaults (copy from framework's example):

```env
# Core settings
PROJECT=myproject
ENVIRONMENT=dev
BASE_URL=https://example.com

# Browser configuration
BROWSER=chrome
HEADLESS=false
TIMEOUT=30000
BROWSER_VIEWPORT_WIDTH=1920
BROWSER_VIEWPORT_HEIGHT=1080

# Feature and step paths
FEATURES=test/{project}/features/*.feature
STEP_DEFINITIONS_PATH=test/common/steps;test/{project}/steps;node_modules/cs-playwright-test-framework/dist/steps

# Performance
LAZY_LOADING=true
SELECTIVE_STEP_LOADING=true

# Module detection
MODULE_DETECTION_ENABLED=true
MODULE_DETECTION_MODE=hybrid
MODULE_DETECTION_DEFAULT_BROWSER=true

# Reporting
REPORTS_BASE_DIR=./reports
REPORT_TYPES=html
```

**Understanding Key Properties:**

- **`{project}` placeholder**: Automatically replaced with `--project` value during initialization (`src/core/CSConfigurationManager.ts:71-72`). Enables path templates like `test/{project}/features` → `test/myproject/features`.

- **`STEP_DEFINITIONS_PATH`**: Semicolon-separated list of directories to search for step definitions. Processed by `CSStepLoader` (`src/core/CSStepLoader.ts:141-150`). Order matters for override behavior.

- **`LAZY_LOADING=true`**: Critical performance optimization. When enabled, modules are loaded on-demand instead of at startup, reducing initialization time from ~25 seconds to <1 second (`src/index.ts:191-194`).

- **`SELECTIVE_STEP_LOADING=true`**: Loads only step definition files containing steps used in the feature files, not entire directories. Implemented in `CSStepLoader.loadRequiredSteps()` (`src/core/CSStepLoader.ts:147-279`).

- **`MODULE_DETECTION_ENABLED=true`**: Enables intelligent module detection to launch only required modules (browser, API, database, SOAP) based on scenario tags and step patterns. Prevents unnecessary browser launch for API-only tests. Implemented in `CSModuleDetector` (`src/core/CSModuleDetector.ts:165-174`).

- **`MODULE_DETECTION_MODE=hybrid`**: Three modes available:
  - `explicit`: Detect via tags only (`@api`, `@database`, `@ui`)
  - `auto`: Detect via step text patterns (`/user sends GET request/i`)
  - `hybrid`: Tags first, then patterns as fallback (default)

  See `CSModuleDetector.detectRequirements()` (`src/core/CSModuleDetector.ts:149-220`).

**Advanced Interpolation** (`src/core/CSConfigurationManager.ts:166-257`):

The configuration manager supports multiple interpolation syntaxes:

1. **Simple Variable Reference**: `{VARIABLE_NAME}`
```env
PROJECT=myproject
BASE_URL=https://{PROJECT}.example.com
# Resolves to: https://myproject.example.com
```

2. **Environment Variable with Default**: `${VAR_NAME:-default}`
```env
DB_HOST=${DATABASE_HOST:-localhost}
# Uses DATABASE_HOST env var, falls back to 'localhost'
```

3. **Complex Variable Operations**:
```env
# Ternary: {ternary:condition?true_value:false_value}
PROTOCOL={ternary:USE_HTTPS?https:http}

# Concatenation: {concat:VAR1+VAR2+VAR3}
FULL_URL={concat:PROTOCOL+://+DOMAIN+:+PORT}

# Case transformation
PROJECT_UPPER={upper:PROJECT}
PROJECT_LOWER={lower:PROJECT}
```

4. **Dynamic Placeholders**: `<type:format>`
```env
# Generate values at runtime
TEST_EMAIL=<generate:email>          # test_1699876543210@example.com
TEST_UUID=<uuid>                      # a1b2c3d4-e5f6-7890-abcd-ef1234567890
TEST_DATE=<date:YYYY-MM-DD>          # 2025-10-09
RANDOM_ID=<random>                    # x7k9m2p
```

See `handleComplexVariable()` and `handleDynamicPlaceholder()` methods in `src/core/CSConfigurationManager.ts:221-288`.

**Encryption Support**:

Sensitive values (passwords, API tokens) can be encrypted:

```env
# Encrypted value (use framework's encryption utility)
ADO_PAT=ENCRYPTED:eyJlbmNyeXB0ZWQiOiIycGQ5aWs...

# Decrypted automatically at runtime
```

Values prefixed with `ENCRYPTED:` are decrypted using `CSEncryptionUtil` during initialization (`src/core/CSConfigurationManager.ts:340-354`).

**`config/myproject/common/common.env`** - Project defaults:

```env
# Project-specific base URL
BASE_URL=https://myproject-app.example.com

# Project-specific timeouts
TIMEOUT=60000
ELEMENT_TIMEOUT=15000

# Browser settings for this project
BROWSER_REUSE_ENABLED=true
BROWSER_REUSE_CLEAR_STATE=true

# Reporting
REPORTS_CREATE_TIMESTAMP_FOLDER=true
```

**`config/myproject/environments/dev.env`** - Development environment:

```env
# Development server
BASE_URL=https://dev.myproject.example.com

# Debug mode
DEBUG_MODE=true
LOG_LEVEL=DEBUG

# Database (development instance)
DB_ENABLED=true
DATABASE_CONNECTIONS=DEV_DB
DB_DEV_DB_TYPE=mysql
DB_DEV_DB_HOST=localhost
DB_DEV_DB_PORT=3306
DB_DEV_DB_USERNAME=dev_user
DB_DEV_DB_PASSWORD=dev_password
DB_DEV_DB_DATABASE=myproject_dev
```

### Creating Your First Test

**Step 1: Create Feature File**

Create `test/myproject/features/login.feature`:

```gherkin
Feature: User Authentication
  As a user
  I want to log in to the application
  So that I can access my account

  Background:
    Given test execution starts

  @ui @smoke
  Scenario: Successful login with valid credentials
    When user navigates to "https://example.com/login"
    And user enters "testuser" into field with css selector "#username"
    And user enters "password123" into field with css selector "#password"
    And user clicks element with css selector "button[type='submit']"
    Then user should see element with css selector ".dashboard-welcome"
    And the page title should contain "Dashboard"
```

**Feature File Structure** (parsed by `CSBDDEngine` - `src/bdd/CSBDDEngine.ts:24-76`):

- **Feature**: Top-level container describing functionality being tested
- **Background**: Steps executed before each scenario (like `@BeforeEach`)
- **Scenario**: Individual test case with Given/When/Then steps
- **Tags**: `@ui @smoke` used for filtering (`--tags`) and module detection

**Module Detection via Tags** (`src/core/CSModuleDetector.ts:33-44`):

```typescript
private readonly TAG_MAPPING: Record<string, keyof ModuleRequirements> = {
    '@ui': 'browser',
    '@browser': 'browser',
    '@api': 'api',
    '@database': 'database',
    '@db': 'database',
    '@soap': 'soap'
};
```

The `@ui` tag tells the framework to launch a browser for this scenario.

**Step 2: Create Step Definitions**

Create `test/myproject/steps/login.steps.ts`:

```typescript
import { CSBDDStepDef, StepDefinitions, CSReporter } from 'cs-playwright-test-framework';

@StepDefinitions
export class LoginSteps {

    @CSBDDStepDef('test execution starts')
    async testStarts() {
        CSReporter.info('Test execution starting');
    }

    @CSBDDStepDef('user navigates to {string}')
    async navigateToUrl(url: string) {
        CSReporter.info(`Navigating to: ${url}`);
        const page = this.context.browserManager.getPage();
        await page.goto(url);
        CSReporter.pass(`Navigation successful`);
    }

    @CSBDDStepDef('user enters {string} into field with css selector {string}')
    async enterTextInField(text: string, selector: string) {
        CSReporter.info(`Entering text into: ${selector}`);
        const page = this.context.browserManager.getPage();
        await page.locator(selector).fill(text);
        CSReporter.pass(`Text entered successfully`);
    }

    @CSBDDStepDef('user clicks element with css selector {string}')
    async clickElement(selector: string) {
        CSReporter.info(`Clicking element: ${selector}`);
        const page = this.context.browserManager.getPage();
        await page.locator(selector).click();
        CSReporter.pass(`Element clicked successfully`);
    }

    @CSBDDStepDef('user should see element with css selector {string}')
    async verifyElementVisible(selector: string) {
        CSReporter.info(`Verifying element visible: ${selector}`);
        const page = this.context.browserManager.getPage();
        await page.locator(selector).waitFor({ state: 'visible' });
        CSReporter.pass(`Element is visible`);
    }

    @CSBDDStepDef('the page title should contain {string}')
    async verifyPageTitle(expectedTitle: string) {
        CSReporter.info(`Verifying page title contains: ${expectedTitle}`);
        const page = this.context.browserManager.getPage();
        const title = await page.title();
        if (!title.includes(expectedTitle)) {
            throw new Error(`Expected title to contain "${expectedTitle}", but got "${title}"`);
        }
        CSReporter.pass(`Page title verified`);
    }
}
```

**Step Definition Deep Dive:**

- **`@StepDefinitions` decorator**: Marks class as containing step definitions. Processed by `registerStepDefinition()` in `src/bdd/CSBDDDecorators.ts`.

- **`@CSBDDStepDef(pattern)` decorator**: Registers step with pattern. Supports:
  - String literals: `'user clicks button'`
  - Parameter placeholders: `{string}`, `{int}`, `{float}`, `{word}`
  - Cucumber expressions: `/user clicks on (.*) button/i`

- **`this.context`**: World context injected by framework containing:
  - `browserManager`: Browser/page management (`CSBrowserManager`)
  - `config`: Configuration access (`CSConfigurationManager`)
  - `reporter`: Logging (`CSReporter`)
  - `scenarioContext`: Scenario-scoped data storage (Map)

  See `WorldContext` interface in `src/bdd/CSStepRegistry.ts:15-30`.

- **CSReporter methods**: Structured logging for test execution:
  - `info()`: Informational messages
  - `debug()`: Debug-level logs (shown when `LOG_LEVEL=DEBUG`)
  - `pass()`: Mark step as passed
  - `fail()`: Mark step as failed

  Logs are captured and included in HTML reports.

### Running Your First Test

**Basic Execution:**

```bash
npm test
# Equivalent to: npm run cs-framework -- --project=myproject
```

**Execution Flow** (`src/index.ts:78-332`):

1. **CLI Parsing**: `minimist` parses command-line arguments (`src/index.ts:81`)
2. **Configuration Initialization**: Load 7-level hierarchy (<100ms target - `src/index.ts:114-118`)
3. **Execution Mode Detection**: Determine if BDD, API, or database mode (`src/index.ts:165-183`)
4. **Module Loading**: Lazy load only required modules (`src/index.ts:185-207`)
5. **BDD Runner Execution**: Parse features, load steps, execute scenarios (`src/index.ts:209-312`)

**Test Execution in BDD Runner** (`src/bdd/CSBDDRunner.ts`):

1. **Feature Parsing**: Gherkin files parsed using `@cucumber/gherkin` (`CSBDDEngine.parseFeatures()`)
2. **Module Detection**: Analyze scenarios to detect required modules (`CSModuleDetector.detectRequirements()`)
3. **Step Loading**: Selectively load step definitions (`CSStepLoader.loadRequiredSteps()`)
4. **Browser Launch**: Launch browser if `MODULE_DETECTION` indicates UI module required
5. **Scenario Execution**: Execute steps sequentially, matching patterns to registered step definitions
6. **Artifact Collection**: Capture screenshots/videos/traces based on configuration
7. **Report Generation**: Generate HTML/JSON/JUnit reports

**With Tags (Filter Scenarios):**

```bash
npm run cs-framework -- --project=myproject --tags="@smoke"
# Run only scenarios tagged with @smoke

npm run cs-framework -- --project=myproject --tags="@ui and @smoke"
# Run scenarios with BOTH tags

npm run cs-framework -- --project=myproject --tags="@ui or @api"
# Run scenarios with EITHER tag

npm run cs-framework -- --project=myproject --tags="not @skip"
# Run all except @skip tagged scenarios
```

**Tag Expression Parsing** (`src/bdd/CSBDDEngine.ts`): Uses Cucumber tag expressions for complex filtering.

**With Environment Override:**

```bash
npm run cs-framework -- --project=myproject --env=staging
# Loads config/myproject/environments/staging.env instead of dev.env
```

**Headless Mode:**

```bash
npm run test:headless
# Runs browser without UI (faster, suitable for CI/CD)
```

**Parallel Execution:**

```bash
npm run test:parallel
# Runs tests across 4 worker processes
```

**Parallel Execution Details** (`src/parallel/CSWorkerManager.ts`):

- **Worker Pool**: Creates N worker processes (default: 3, configured via `MAX_PARALLEL_WORKERS`)
- **Scenario Distribution**: Distributes scenarios round-robin across workers
- **Browser Pools**: Each worker maintains its own browser instance pool
- **Configuration Isolation**: Each worker gets a separate configuration instance (thread-safe via `WORKER_ID` environment variable)
- **Resource Management**: Monitors memory usage and restarts crashed workers (up to `BROWSER_MAX_RESTART_ATTEMPTS` times)

**Module-Specific Execution:**

```bash
# Explicit module specification (CLI argument)
npm run cs-framework -- --project=myproject --modules=api
# Only loads API module, skips browser launch

npm run cs-framework -- --project=myproject --modules=api,database
# Loads API and database modules only

npm run cs-framework -- --project=myproject --modules=ui,api,database
# Loads all three modules
```

**Module Priority** (`src/core/CSModuleDetector.ts:149-162`):

1. **Explicit CLI**: `--modules=api` (highest priority)
2. **Configuration Property**: `MODULES=api` in .env file
3. **Tag Detection**: `@api` tag in feature/scenario
4. **Pattern Detection**: Step text like "user sends GET request"
5. **Default**: Browser module (when `MODULE_DETECTION_DEFAULT_BROWSER=true`)

**Viewing Test Results:**

After execution, reports are generated in `reports/` directory:

```
reports/
└── test-results-2025-10-09_14-30-45/
    ├── index.html              # Main HTML report (open in browser)
    ├── test-results.json       # JSON data for CI/CD integration
    ├── junit-results.xml       # JUnit XML for test management tools
    ├── screenshots/            # Failure screenshots
    ├── videos/                 # Test execution videos
    ├── traces/                 # Playwright traces
    └── har/                    # HTTP Archive files
```

Open `reports/test-results-{timestamp}/index.html` in a web browser to view the detailed HTML report with:
- Test execution summary
- Scenario pass/fail status
- Step-by-step execution logs
- Screenshots and videos
- Execution timeline
- Failure analysis

**Report Generation** (`src/reporter/CSHTMLReporter.ts`): Uses template-based HTML generation with embedded JavaScript for interactivity.

### Common Installation Issues

**Issue 1: Playwright Browser Download Fails**

```
Error: Failed to download browsers
```

**Solution**: Set proxy if behind corporate firewall:

```bash
# Windows
set HTTPS_PROXY=http://proxy.company.com:8080

# Linux/Mac
export HTTPS_PROXY=http://proxy.company.com:8080

npx playwright install
```

Or download manually and set `PLAYWRIGHT_BROWSERS_PATH`:

```bash
export PLAYWRIGHT_BROWSERS_PATH=/path/to/browsers
npx playwright install
```

**Issue 2: TypeScript Compilation Errors**

```
error TS2304: Cannot find name 'CSBDDStepDef'
```

**Solution**: Ensure `tsconfig.json` is configured correctly:

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "module": "commonjs",
    "lib": ["ES2017"],
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "strict": false,
    "resolveJsonModule": true,
    "typeRoots": ["./node_modules/@types"]
  },
  "include": ["test/**/*.ts"],
  "exclude": ["node_modules"]
}
```

**Critical Settings:**
- `experimentalDecorators: true`: Required for `@CSBDDStepDef` and `@StepDefinitions` decorators
- `emitDecoratorMetadata: true`: Required for decorator reflection used by step registry

**Issue 3: Step Definitions Not Found**

```
Step definition not found for: user navigates to "url"
```

**Solution**: Verify `STEP_DEFINITIONS_PATH` configuration:

```env
# Ensure path includes your step directory
STEP_DEFINITIONS_PATH=test/common/steps;test/myproject/steps;node_modules/cs-playwright-test-framework/dist/steps
```

Check step loading logs (set `LOG_LEVEL=DEBUG`):

```bash
npm run cs-framework -- --project=myproject --tags="@smoke" 2>&1 | grep "Loaded step"
```

**Issue 4: Module Detection Not Working**

```
Browser launched for API-only test
```

**Solution**: Verify module detection is enabled:

```env
MODULE_DETECTION_ENABLED=true
MODULE_DETECTION_MODE=hybrid
```

Add explicit tags to scenarios:

```gherkin
@api
Scenario: API test
  When user sends GET request to "/endpoint"
```

Or use CLI override:

```bash
npm run cs-framework -- --project=myproject --modules=api
```

---

**Next Section**: Project Structure & Organization

