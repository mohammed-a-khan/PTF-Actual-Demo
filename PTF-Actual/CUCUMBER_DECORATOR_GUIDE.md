# Cucumber-Compatible Decorators Guide

## Overview

The CS Test Automation Framework now supports **Cucumber-compatible decorators** (`@Given`, `@When`, `@Then`, `@And`, `@But`, `@Step`) alongside the existing `@CSBDDStepDef` decorator.

This enables **full IDE plugin support** (autocomplete, Ctrl+Click navigation, step validation) while maintaining **100% backward compatibility** with existing code.

---

## Features

✅ **Dual-Purpose Decorators** - Work with both CS Framework execution AND Cucumber IDE plugins
✅ **Full IDE Support** - Ctrl+Click navigation, autocomplete, step validation
✅ **100% Backward Compatible** - Existing `@CSBDDStepDef` code works unchanged
✅ **All Gherkin Keywords** - Given, When, Then, And, But, Step
✅ **Zero Breaking Changes** - Can mix both decorator styles in same project
✅ **All Framework Features** - Page injection, retry logic, context management

---

## Quick Start

### Option 1: New Cucumber-Compatible Style (Recommended for IDE Support)

```typescript
import { Given, When, Then, And, But, Step } from 'cs-test-automation-framework';
import { StepDefinitions, Page } from 'cs-test-automation-framework';

@StepDefinitions
export class LoginSteps {

    @Page('login-page')
    private loginPage!: LoginPage;

    @Given('I am on the login page')
    async onLoginPage() {
        await this.loginPage.navigate();
    }

    @When('I enter username {string} and password {string}')
    async enterCredentials(username: string, password: string) {
        await this.loginPage.enterUsername(username);
        await this.loginPage.enterPassword(password);
    }

    @And('I click the login button')
    async clickLogin() {
        await this.loginPage.clickLoginButton();
    }

    @Then('I should see the dashboard')
    async shouldSeeDashboard() {
        await expect(this.dashboardPage.header).toBeVisible();
    }

    @But('I should not see the login form')
    async shouldNotSeeLoginForm() {
        await expect(this.loginPage.form).not.toBeVisible();
    }
}
```

### Option 2: Existing CS Framework Style (Still Fully Supported)

```typescript
import { CSBDDStepDef } from 'cs-test-automation-framework';

export class LoginSteps {

    @CSBDDStepDef('I am on the login page')
    async onLoginPage() {
        await this.loginPage.navigate();
    }

    @CSBDDStepDef('I enter username {string} and password {string}')
    async enterCredentials(username: string, password: string) {
        await this.loginPage.login(username, password);
    }
}
```

### Option 3: Mixed Usage (Both Styles in Same File)

```typescript
import { CSBDDStepDef, Given, When, Then } from 'cs-test-automation-framework';

export class MixedSteps {

    // Old style - still works perfectly
    @CSBDDStepDef('I use the old decorator')
    async oldStyle() {
        // Implementation
    }

    // New style - enables IDE support
    @Given('I use the new decorator')
    async newStyle() {
        // Implementation
    }
}
```

---

## Supported Gherkin Keywords

| Decorator | Purpose | Example |
|-----------|---------|---------|
| `@Given` | Preconditions | `@Given('I am logged in')` |
| `@When` | Actions | `@When('I click on {string}')` |
| `@Then` | Assertions | `@Then('I should see {string}')` |
| `@And` | Continuation | `@And('I verify the result')` |
| `@But` | Negation | `@But('I should not see errors')` |
| `@Step` | Generic (any keyword) | `@Step('the system is ready')` |

---

## Parameter Types

All Cucumber expression parameter types are supported:

```typescript
// String parameters
@Given('I enter {string}')
async enterText(text: string) { }

// Integer parameters
@When('I wait for {int} seconds')
async wait(seconds: number) { }

// Float parameters
@Then('the price should be {float}')
async checkPrice(price: number) { }

// Word parameters
@Given('I am on the {word} page')
async onPage(pageName: string) { }

// Multiple parameters
@When('I send a {string} request to {string} with status {int}')
async sendRequest(method: string, url: string, status: number) { }
```

---

## Advanced Features

### 1. Custom Timeout

```typescript
@Given('I wait for slow operation', 60000)  // 60 second timeout
async slowOperation() {
    // Long-running operation
}

@CSBDDStepDef('I use old decorator with timeout', 45000)
async oldStyleTimeout() {
    // Also works with old decorator
}
```

### 2. Data Tables

```typescript
@Given('I have the following users:')
async createUsers(dataTable: any) {
    const rows = dataTable.hashes();
    for (const row of rows) {
        await this.createUser(row.username, row.email);
    }
}
```

**Feature file:**
```gherkin
Given I have the following users:
  | username | email           |
  | john     | john@test.com   |
  | jane     | jane@test.com   |
```

### 3. Doc Strings

```typescript
@When('I submit the following JSON:')
async submitJson(docString: string) {
    const payload = JSON.parse(docString);
    await this.api.post('/data', payload);
}
```

**Feature file:**
```gherkin
When I submit the following JSON:
  """
  {
    "name": "Test",
    "value": 123
  }
  """
```

### 4. Page Injection (Works with ALL Decorators)

```typescript
import { Given, Page, StepDefinitions } from 'cs-test-automation-framework';

@StepDefinitions
export class PageSteps {

    @Page('login')
    private loginPage!: LoginPage;

    @Page('dashboard')
    private dashboardPage!: DashboardPage;

    @Given('I navigate to login page')
    async navigateToLogin() {
        // loginPage is auto-injected by framework
        await this.loginPage.navigate();
    }
}
```

---

## IDE Plugin Setup

### VSCode with Cucumber Plugin

1. **Install Cucumber Plugin:**
   ```bash
   code --install-extension alexkrechik.cucumberautocomplete
   ```

2. **Configure `.vscode/settings.json`:**
   ```json
   {
     "cucumberautocomplete.steps": [
       "test/**/steps/**/*.ts",
       "src/**/steps/**/*.ts"
     ],
     "cucumberautocomplete.syncfeatures": "test/**/features/**/*.feature",
     "cucumberautocomplete.strictGherkinCompletion": false,
     "cucumberautocomplete.smartSnippets": true,
     "cucumberautocomplete.stepsInvariants": true,
     "cucumberautocomplete.customParameters": [
       {
         "parameter": "{string}",
         "value": "\"([^\"]*)\""
       },
       {
         "parameter": "{int}",
         "value": "(\\d+)"
       },
       {
         "parameter": "{float}",
         "value": "([\\d\\.]+)"
       }
     ]
   }
   ```

3. **Verify Setup:**
   - Open a `.feature` file
   - Hold `Ctrl` and click on a step
   - Should navigate to step definition ✅

---

## Migration Guide

### Migrating from @CSBDDStepDef to Cucumber Decorators

**Before:**
```typescript
import { CSBDDStepDef } from 'cs-test-automation-framework';

export class Steps {
    @CSBDDStepDef('I click on {string}')
    async click(element: string) { }
}
```

**After:**
```typescript
import { When } from 'cs-test-automation-framework';

export class Steps {
    @When('I click on {string}')
    async click(element: string) { }
}
```

**No code changes needed** - just replace the decorator. All framework features work identically.

---

## Benefits by Use Case

### For Test Developers
- ✅ IDE autocomplete suggests available steps
- ✅ Ctrl+Click navigates to step definitions
- ✅ Undefined steps highlighted in feature files
- ✅ Parameter type validation
- ✅ Faster test development

### For Framework Maintainers
- ✅ Standard Cucumber syntax (easier onboarding)
- ✅ Better IDE support reduces support requests
- ✅ No breaking changes (smooth migration)
- ✅ Industry-standard naming conventions

### For CI/CD Pipelines
- ✅ Zero impact on execution
- ✅ Same performance characteristics
- ✅ Compatible with all existing tests
- ✅ No pipeline changes needed

---

## FAQ

### Q: Do I need to migrate existing `@CSBDDStepDef` code?
**A:** No! Existing code works perfectly. Migrate only if you want IDE support.

### Q: Can I mix both decorator styles?
**A:** Yes! Both work in the same project, even in the same file.

### Q: Will this break my tests?
**A:** No! This is 100% backward compatible. All existing tests run unchanged.

### Q: Do I need to install Cucumber?
**A:** No! Cucumber is optional (only for IDE support). Framework works without it.

### Q: Does this affect performance?
**A:** No! Decorators are applied at design-time. Zero runtime impact.

### Q: What if Cucumber isn't installed?
**A:** Framework works normally. You just won't get IDE plugin features.

### Q: Do all framework features still work?
**A:** Yes! Page injection, retry logic, context management - everything works.

---

## Troubleshooting

### IDE Not Recognizing Steps

**Problem:** Ctrl+Click doesn't navigate to step definitions

**Solutions:**
1. Verify Cucumber plugin installed: `code --list-extensions | grep cucumber`
2. Check `.vscode/settings.json` has correct paths
3. Reload VSCode window: `Ctrl+Shift+P` → "Reload Window"
4. Verify step uses `@Given/@When/@Then` (not `@CSBDDStepDef`)

### Steps Not Found at Runtime

**Problem:** "Step definition not found" error

**Solutions:**
1. Verify step file is in configured step paths
2. Check import statement: `import { Given } from 'cs-test-automation-framework'`
3. Ensure step file is being loaded (check `STEP_DEFINITIONS_PATH` in config)
4. Verify pattern matches exactly (check quotes, spaces, parameters)

### Type Errors in IDE

**Problem:** TypeScript shows errors on decorators

**Solutions:**
1. Update framework: `npm install cs-test-automation-framework@latest`
2. Verify import: `import { Given, When, Then } from 'cs-test-automation-framework'`
3. Check TypeScript version: `tsc --version` (should be >= 5.0)
4. Rebuild: `npm run build`

---

## Technical Details

### How It Works

1. **Dual Registration:**
   - Decorators register steps with **CS Framework** (for execution)
   - Also register with **Cucumber** (for IDE plugins only)

2. **Execution Flow:**
   ```
   Feature File → CS BDD Engine → CS Step Registry → Your Step Code
                              ↓
                         (Cucumber not used for execution)
   ```

3. **IDE Plugin Flow:**
   ```
   IDE Plugin → Cucumber Registry → Find Step → Navigate to Code
   ```

4. **Lazy Loading:**
   - Cucumber loaded only when decorators used
   - No performance impact if not using new decorators
   - Graceful fallback if Cucumber not installed

---

## Support

- **Documentation:** See framework README
- **Issues:** Report at repository issue tracker
- **Examples:** See `src/steps/test/CucumberDecoratorTest.ts`

---

## Version History

- **v3.0.21** - Added Cucumber-compatible decorators (@Given, @When, @Then, @And, @But, @Step)
- **v3.0.20** - Excel/PDF reports, trend chart fixes
- **v3.0.19** - Previous features
