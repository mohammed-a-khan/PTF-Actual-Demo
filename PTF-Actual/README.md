# CS Test Automation Framework

## 🚀 Lightning-Fast, Zero-Hardcoding, Self-Healing Test Automation

A comprehensive test automation framework built on Playwright with TypeScript, featuring BDD support, self-healing elements, AI-powered testing, and complete configurability.

## ✨ Key Features

- **⚡ Lightning-Fast Startup** - Framework starts in <1 second with selective module loading
- **🔧 Zero Hardcoding** - Everything configurable through hierarchical configuration files
- **🤖 Self-Healing Elements** - Automatic fallback strategies when elements change
- **🧠 AI-Powered Testing** - Visual element recognition and smart test suggestions
- **🔐 Automatic Encryption/Decryption** - Transparent handling of encrypted values in tests and data
- **📊 Real-Time Dashboard** - Live test execution monitoring with WebSocket
- **🔄 Multi-Browser Support** - Chrome, Firefox, Safari, Edge with switching capabilities
- **📦 Data-Driven Testing** - Excel, CSV, JSON, API, Database data providers with auto-decryption
- **🔗 Azure DevOps Integration** - Test sync, bug creation, proxy support
- **📸 Evidence Collection** - Screenshots, videos, HAR files, console logs
- **🏊 Browser Pool Management** - Efficient parallel execution
- **🔑 Automatic Value Resolution** - Variables and encrypted values resolved transparently

## 📋 Prerequisites

- Node.js >= 16.0.0
- npm or yarn
- Playwright browsers (auto-installed)

## 🛠️ Installation

```bash
# Clone the repository
git clone <repository-url>

# Install dependencies
npm install

# Playwright browsers will be auto-installed
```

## 🚀 Quick Start

### 1. Simple Test Execution

```bash
# Run with all defaults (reads from config files)
npm run test

# Run specific project
npm run test:akhan

# Run with specific environment
npm run test:akhan -- --env=staging

# Run in parallel
npm run test:akhan -- --parallel=true --workers=8
```

### 2. Project Structure

```
├── config/                  # Configuration files
│   ├── global.env          # Global defaults
│   ├── common/             # Common project config
│   └── akhan/              # Project-specific config
├── src/                    # Framework source code
│   ├── core/              # Core modules
│   ├── browser/           # Browser management
│   ├── element/           # Element handling
│   ├── bdd/              # BDD/Cucumber support
│   └── ...               # Other modules
├── test/                  # Test files
│   └── akhan/
│       ├── features/      # Gherkin feature files
│       ├── steps/         # Step definitions
│       ├── pages/         # Page objects
│       └── data/          # Test data
└── reports/              # Test reports

```

## 📝 Writing Tests

### Feature File (Gherkin)

```gherkin
# test/akhan/features/login.feature

@smoke @login
Feature: User Login
  As a user
  I want to login to the application
  So that I can access my dashboard

  Scenario: Successful login
    Given I navigate to the AKHAN application
    When I enter username "testuser"
    And I enter password from config
    And I click on the login button
    Then I should be logged in successfully
    And I should see the dashboard
```

### Step Definition

```typescript
// test/akhan/steps/login.steps.ts

import { CSBDDStepDef } from '../../../src/bdd/CSStepRegistry';

export class LoginSteps {
    
    @CSBDDStepDef(/^I navigate to the AKHAN application$/)
    async navigateToApp(this: any) {
        const page = this.browserManager.getPage();
        await page.goto(this.config.get('BASE_URL'));
    }
    
    @CSBDDStepDef(/^I enter username "([^"]*)"$/)
    async enterUsername(this: any, username: string) {
        const loginPage = new LoginPage();
        await loginPage.enterUsername(username);
    }
}
```

### Page Object

```typescript
// test/akhan/pages/LoginPage.ts

import { CSPageBase } from '../../../src/core/CSPageBase';
import { CSPage, CSElement, CSAction } from '../../../src/core/CSPageFactory';

@CSPage('login')
export class LoginPage extends CSPageBase {
    
    @CSElement({
        id: 'username',
        css: 'input[name="username"]',
        description: 'Username field'
    })
    public usernameField!: CSWebElement;
    
    @CSElement({
        css: 'button[type="submit"]',
        text: 'Login',
        description: 'Login button',
        selfHeal: true
    })
    public loginButton!: CSWebElement;
    
    @CSAction('Enter username')
    async enterUsername(username: string) {
        await this.usernameField.type(username);
    }
    
    @CSAction('Click login')
    async clickLogin() {
        await this.loginButton.click();
    }
}
```

## ⚙️ Configuration

### Hierarchical Configuration System

Configuration is loaded in priority order (highest to lowest):

1. Command line arguments
2. Environment variables  
3. Project environment config (`config/akhan/environments/dev.env`)
4. Project common config (`config/akhan/common/common.env`)
5. Common environment config (`config/common/environments/dev.env`)
6. Common config (`config/common/common.env`)
7. Global defaults (`config/global.env`)

### Example Configuration

```properties
# config/akhan/environments/dev.env

# URLs
BASE_URL=https://akhan-dev.example.com
API_BASE_URL=https://api-akhan-dev.example.com

# Browser Settings
HEADLESS=false
BROWSER=chrome
BROWSER_VIEWPORT_WIDTH=1920
BROWSER_VIEWPORT_HEIGHT=1080

# Timeouts
DEFAULT_TIMEOUT=30000
PAGE_LOAD_TIMEOUT=60000

# Features
SELF_HEALING_ENABLED=true
AI_ENABLED=true
DASHBOARD_ENABLED=true

# Credentials (encrypted)
DEFAULT_USERNAME=testuser
DEFAULT_PASSWORD=ENCRYPTED:a8f7d9s8f7d9f8

# Log Level Control
LOG_LEVEL=INFO  # DEBUG | INFO | WARN | ERROR (hide debug messages with INFO or higher)
```

### Variable Interpolation

```properties
# Use variables in configuration
PROJECT=akhan
ENVIRONMENT=dev
BASE_URL=https://{project}-{environment}.example.com
# Result: https://akhan-dev.example.com

# Dynamic values
REPORT_NAME=Report_{timestamp}_{project}
SESSION_ID={uuid}
TEST_USER=user_{random}
```

## 🎯 Advanced Features

### Self-Healing Elements

Elements automatically try alternative locators when primary fails:

```typescript
@CSElement({
    id: 'submit-btn',           // Primary
    css: 'button[type="submit"]', // Fallback 1
    text: 'Submit',              // Fallback 2
    selfHeal: true
})
```

### Data-Driven Testing

```gherkin
@DataProvider(source="users.xlsx", sheet="TestData")
Scenario Outline: Login with multiple users
    When I login as "<username>" with "<password>"
    Then I should see "<result>"
```

### AI-Powered Element Finding

```typescript
// Find element by visual description
const element = await aiEngine.findByVisualDescription(
    page, 
    "blue submit button at bottom right"
);
```

### Browser Management Strategies

```properties
# config/global.env

# Strategy options:
# - new-per-scenario: New browser for each test
# - reuse-across-scenarios: Single browser for all tests  
# - new-context-per-scenario: New context, same browser
# - pool: Browser pool for parallel execution

BROWSER_INSTANCE_STRATEGY=new-per-scenario
BROWSER_POOL_ENABLED=true
BROWSER_POOL_SIZE=4
```

### API Testing

```typescript
const apiClient = CSAPIClient.getInstance();

// Chain requests with automatic variable extraction
const response1 = await apiClient.post('/users', {
    name: 'John Doe',
    email: 'john@example.com'
});
// Automatically extracts: {{lastId}}

const response2 = await apiClient.get('/users/{{lastId}}');
```

### Database Testing

```typescript
const dbManager = CSDatabaseManager.getInstance();

// Multi-database support
await dbManager.query('SELECT * FROM users', [], 'mysql');
await dbManager.query('SELECT * FROM products', [], 'postgresql');

// Transaction with auto-rollback
await dbManager.beginTransaction('test-1');
await dbManager.insert('users', { name: 'Test User' });
// Automatically rolled back after test
```

## 📊 Reporting

### Multiple Report Formats

```properties
REPORT_FORMATS=html;json;junit;pdf
REPORT_OUTPUT_DIR=./reports
REPORT_OPEN_AFTER_RUN=true
```

### Live Dashboard

Access real-time test execution at `http://localhost:8080` when enabled:

```properties
DASHBOARD_ENABLED=true
DASHBOARD_WS_PORT=8080
DASHBOARD_AUTO_OPEN=true
```

## 🔌 Azure DevOps Integration

```properties
# config/global.env

ADO_ENABLED=true
ADO_ORGANIZATION=myorg
ADO_PROJECT=myproject
ADO_PAT=ENCRYPTED:encrypted_token
ADO_UPDATE_TEST_CASES=true
ADO_CREATE_BUGS_ON_FAILURE=true

# Proxy support
ADO_PROXY_ENABLED=true
ADO_PROXY_HOST=proxy.company.com
ADO_PROXY_PORT=8080
```

## 🚀 Performance Optimization

### Lightning-Fast Startup (<1 second)

```properties
# Optimization settings
LAZY_LOADING=true
SELECTIVE_STEP_LOADING=true
TS_NODE_TRANSPILE_ONLY=true
CACHE_COMPILED_TS=true
PARALLEL_INITIALIZATION=true
```

### Selective Step Loading

Only loads step definitions needed for features being executed:

```properties
STEP_DEFINITIONS_PATH=test/akhan/steps;test/common/steps
SELECTIVE_STEP_LOADING=true
```

## 🐛 Debugging

```bash
# Debug mode with browser DevTools
npm run test:debug

# Keep browser open on failure
npm run test -- --debug=true --headless=false

# Verbose logging
npm run test -- --log-level=debug
```

## 🔐 Automatic Encryption & Value Resolution

The framework provides **transparent automatic resolution** for encrypted values and variables throughout your tests.

### Key Features

- **Automatic Decryption** - Values with `ENCRYPTED:` prefix are automatically decrypted
- **Variable Substitution** - Multiple patterns with clear distinction between sources
- **Zero Manual Handling** - Step definitions receive fully resolved values
- **Works Everywhere** - Feature files, test data (CSV/JSON/Excel), configuration files

### Variable Resolution Patterns

| Pattern | Source | Example | Description |
|---------|--------|---------|-------------|
| `{{variable}}` | Test context | `{{userId}}` | Variables saved during test |
| `$variable` | Test context | `$username` | Alternative syntax for test vars |
| `{{config:KEY}}` | Config files | `{{config:API_TOKEN}}` | From .env files |
| `{{env:VAR}}` | Environment | `{{env:HOME}}` | OS environment variables |

### Quick Examples

#### In Feature Files
```gherkin
# Automatic decryption
Given user sets password to "ENCRYPTED:U2FsdGVkX1+abc123..."

# Test context variables
Given user saves "john.doe" as "username"
When user logs in as "{{username}}"

# Configuration values (from .env)
Given user sets API key to "{{config:API_TOKEN}}"

# Environment variables
Given user sets proxy to "{{env:HTTP_PROXY}}"
```

#### No Naming Conflicts
```gherkin
# Same name, different sources - no conflicts!
Given user saves "my-token" as "API_TOKEN"
When user uses test token "{{API_TOKEN}}"        # -> "my-token" (test var)
And user uses config token "{{config:API_TOKEN}}" # -> from .env file
And user uses env token "{{env:API_TOKEN}}"      # -> from OS environment
```

#### In Test Data (CSV)
```csv
username,password,apiKey
john,ENCRYPTED:U2FsdGVkX1+...,ENCRYPTED:U2FsdGVkX1+...
```

#### In Configuration (.env)
```bash
DB_PASSWORD=ENCRYPTED:U2FsdGVkX1+dbpass123...
API_KEY=ENCRYPTED:U2FsdGVkX1+apikey456...
```

### Your Step Definitions Stay Clean
```typescript
// No manual decryption needed - value is already decrypted!
@CSBDDStepDef("user sets password {string}")
async setPassword(password: string): Promise<void> {
    await this.page.fill('#password', password); // Already decrypted!
}
```

### Encrypting Values
```bash
# Encrypt a value
npx cs-encrypt "myPassword"
# Output: ENCRYPTED:U2FsdGVkX1+...
```

### 📖 Full Documentation

- [**Automatic Value Resolution Guide**](./AUTOMATIC_VALUE_RESOLUTION_GUIDE.md) - Complete guide with all features
- [**Quick Reference**](./ENCRYPTION_QUICK_REFERENCE.md) - Quick lookup for common patterns
- [**Practical Examples**](./test/examples/encryption-examples.feature) - Real-world scenarios

## 📚 API Documentation

### Core Classes

- `CSConfigurationManager` - Configuration management
- `CSBrowserManager` - Browser lifecycle management
- `CSWebElement` - Enhanced element interactions
- `CSPageFactory` - Page object factory with DI
- `CSReporter` - Multi-format reporting
- `CSAPIClient` - API testing with chaining
- `CSDatabaseManager` - Multi-database support
- `CSAIEngine` - AI-powered testing

## 🤝 Contributing

1. Follow the zero-hardcoding principle
2. Ensure <1 second startup time
3. Add configuration for all new features
4. Write self-healing capable elements
5. Include CSReporter integration

## 📄 License

MIT

## 🆘 Support

For issues and questions:
- Create an issue in the repository
- Check existing documentation
- Review example implementations

---

**Remember**: Everything is configurable, nothing is hardcoded! ⚡