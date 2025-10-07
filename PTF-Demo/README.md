# PTF Demo Project

This is a demo project utilizing the `cs-test-automation-framework` v3.0.0 published to Azure DevOps Artifacts.

## Prerequisites

- Node.js 16.0.0 or higher
- npm
- Access to Azure DevOps feed: `https://dev.azure.com/mdakhan/myproject/_artifacts/feed/cs-framework`

## Setup Instructions

### 1. Authenticate with Azure DevOps

You need to authenticate with Azure DevOps to install the framework. Choose one of these methods:

#### Method A: Using npm login (Interactive)
```bash
npm login --registry=https://pkgs.dev.azure.com/mdakhan/_packaging/cs-framework/npm/registry/
```

#### Method B: Using Personal Access Token (PAT)
1. Go to Azure DevOps: https://dev.azure.com/mdakhan
2. Generate a PAT with **Packaging (Read)** permissions
3. Create a `.npmrc` file with:
```
registry=https://pkgs.dev.azure.com/mdakhan/_packaging/cs-framework/npm/registry/
always-auth=true
//pkgs.dev.azure.com/mdakhan/_packaging/cs-framework/npm/registry/:username=mdakhan
//pkgs.dev.azure.com/mdakhan/_packaging/cs-framework/npm/registry/:_password=[BASE64_ENCODED_PAT]
//pkgs.dev.azure.com/mdakhan/_packaging/cs-framework/npm/registry/:email=npm requires email to be set but doesn't use the value
```

#### Method C: Using vsts-npm-auth (Recommended for Windows)
```bash
npm install -g vsts-npm-auth
vsts-npm-auth -config .npmrc
```

### 2. Install Dependencies

```bash
npm install
```

This will install:
- `cs-test-automation-framework@3.0.0` from Azure DevOps
- Required dev dependencies (@types/node, typescript)

### 3. Run Tests

```bash
# Run all tests (OrangeHRM project)
npm test

# Run OrangeHRM tests
npm run test:orangehrm

# Run API tests
npm run test:api

# Run UI tests only
npm run test:ui

# Run database tests
npm run test:database

# Run tests in parallel (4 workers)
npm run test:parallel

# Run in headless mode
npm run test:headless

# Run with debugging (dev environment)
npm run test:debug
```

#### Direct CLI Usage

Use the framework CLI directly:

```bash
# Basic usage
npx --package=cs-test-automation-framework cs-framework --project=orangehrm

# Specific feature file with visible browser
npx --package=cs-test-automation-framework cs-framework --project=orangehrm --features=test/orangehrm/features/orangehrm-login-navigation.feature --headless=false

# Run specific tags
npx --package=cs-test-automation-framework cs-framework --project=orangehrm --tags=@smoke

# Parallel execution
npx --package=cs-test-automation-framework cs-framework --project=orangehrm --parallel --workers=4

# View help
npx --package=cs-test-automation-framework cs-framework --help
```

**Shorter version using npm script**:
```bash
npm run cs-framework -- --project=orangehrm --features=test/orangehrm/features/orangehrm-login-navigation.feature --headless=false
```

## Project Structure

```
PTF-Demo-Project/
├── .npmrc                  # NPM registry configuration
├── package.json            # Project dependencies
├── tsconfig.json           # TypeScript configuration
├── config/                 # Environment configurations
│   ├── global.env         # Global framework settings
│   ├── orangehrm/         # OrangeHRM specific configs
│   └── api/               # API test configs
└── test/                  # Test files
    ├── orangehrm/         # UI tests for OrangeHRM
    │   ├── features/      # Gherkin feature files
    │   ├── pages/         # Page Object Models
    │   ├── steps/         # Step definitions
    │   └── data/          # Test data
    ├── api/               # API tests
    │   └── features/      # API feature files
    └── database/          # Database tests
        └── features/      # Database feature files
```

## Features

This demo project demonstrates:

✅ **UI Testing** - OrangeHRM login and navigation tests
✅ **API Testing** - REST API testing with httpbin examples
✅ **Database Testing** - MySQL database integration tests
✅ **SOAP Testing** - SOAP web service examples
✅ **Data-Driven Testing** - CSV, Excel, JSON, XML data sources
✅ **Azure DevOps Integration** - Test results publishing
✅ **Encrypted Configuration** - Secure credential management
✅ **Self-Healing Elements** - Auto-recovery from broken locators
✅ **Parallel Execution** - Multi-worker test execution
✅ **Cross-Domain Navigation** - SSO and Netscaler support

## Configuration

All configurations are in `config/global.env`. Key settings:

```bash
# Framework
FRAMEWORK_VERSION=3.0.0
FRAMEWORK_MODE=optimized

# Browser
BROWSER=chrome
HEADLESS=false
BROWSER_REUSE_ENABLED=true

# Parallel Execution
PARALLEL=false
MAX_PARALLEL_WORKERS=4

# Azure DevOps Integration
ADO_INTEGRATION_ENABLED=true
ADO_ORGANIZATION=mdakhan
ADO_PROJECT=myproject
```

## Available Test Scenarios

### UI Tests (OrangeHRM)
- Login with valid/invalid credentials
- Navigation menu verification
- Data-driven login tests
- Error handling

### API Tests
- HTTP methods (GET, POST, PUT, DELETE)
- Authentication (Basic, Bearer, OAuth2, AWS Signature)
- Request/Response validation
- JSON/XML parsing
- Certificate authentication

### Database Tests
- MySQL connection and queries
- Data validation
- Query result caching
- Multi-database support

## Troubleshooting

### Authentication Issues
If you get 401 errors during `npm install`:
1. Verify your PAT has **Packaging (Read)** permission
2. Check that your PAT hasn't expired
3. Ensure `.npmrc` is properly configured
4. Try `npm login` to re-authenticate

### Framework Not Found
If imports fail:
1. Verify `cs-test-automation-framework@3.0.0` is in `node_modules`
2. Run `npm install` again
3. Check that `package.json` has the correct version

### TypeScript Errors
1. Ensure `tsconfig.json` has `experimentalDecorators: true`
2. Run `npm install` to install type definitions
3. Restart your IDE/editor

## Support

For framework documentation and issues:
- Framework Repository: https://dev.azure.com/mdakhan/myproject/_git/ptf-ado-repo
- Artifacts Feed: https://dev.azure.com/mdakhan/myproject/_artifacts/feed/cs-framework

## License

MIT
