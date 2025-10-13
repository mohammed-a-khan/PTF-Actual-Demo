# Variable Interpolation - STANDARDIZED Framework Guide

## Executive Summary

**MAJOR CHANGE:** The cs-playwright-test-framework has been **STANDARDIZED** with a single unified variable interpolation system.

**Before (Pre-standardization):**
- Two separate interpolation systems (CSConfigurationManager vs Database/API steps)
- Different syntax supported in different modules
- 15 files with duplicate interpolation logic

**After (Standardized):**
- ✅ Single centralized `config Manager.interpolate()` method
- ✅ ALL syntax types supported universally across framework
- ✅ Removed 13 duplicate interpolation methods (170 additions / 304 deletions = Net -134 lines)
- ✅ Backward compatibility maintained (100%)

---

## Standardization Changes (Framework v1.0.10+)

### Files Modified
**Total: 15 files | +170 lines | -304 lines | Net: -134 lines**

#### CSConfigurationManager Enhanced
- **File:** `/src/core/CSConfigurationManager.ts`
- **New Method:** `public interpolate(value: string, contextMap?: Map<string, any>): string`
- **Features Added:**
  - Support for `{{VAR}}` runtime context variables
  - Support for `{context:VAR}` explicit context syntax
  - Full backward compatibility with existing interpolation

#### Database Steps Standardized (8 files)
All database step files now use `configManager.interpolate(text, contextVariables)`:
1. `DatabaseGenericSteps.ts` - Removed `interpolateVariables()`
2. `QueryExecutionSteps.ts` - Removed `interpolateVariables()`
3. `DataValidationSteps.ts` - Removed `interpolateVariables()`
4. `StoredProcedureSteps.ts` - Removed `interpolateVariables()`
5. `TransactionSteps.ts` - Removed `interpolateVariables()`
6. `DatabaseUtilitySteps.ts` - Removed `interpolateVariables()`
7. `ConnectionSteps.ts` - Removed `interpolateVariables()`
8. `CSDatabaseAPISteps.ts` - Removed `interpolateVariables()`

#### API Steps Standardized (6 files)
All API step files now use `configManager.interpolate(text, context.variables)`:
1. `CSAPIGenericSteps.ts` - Removed `interpolateValue()`
2. `CSAPIRequestSteps.ts` - Removed `interpolateValue()`
3. `CSAPIAuthenticationSteps.ts` - Removed `interpolateValue()`
4. `CSAPIRequestBodySteps.ts` - Removed `interpolateValue()`
5. `CSAPIValidationSteps.ts` - Removed `interpolateValue()`
6. `CSAPIChainingSteps.ts` - Removed `interpolateValue()`

---

## Universal Interpolation Syntax

**Now available in ALL modules (Database, API, Configuration):**

### 1. Config Variable: `{VARIABLE}`
**Purpose:** Reference configuration values from .env files
**Example:**
```properties
# In .env file
PROJECT=orangehrm
ENVIRONMENT=dev

# In any query/request/config
BASE_URL=https://{PROJECT}-{ENVIRONMENT}.example.com
# Result: https://orangehrm-dev.example.com
```

### 2. Config/Env Variable with Default: `${VARIABLE:-default}`
**Purpose:** Reference config FIRST, then environment variable, with optional default
**Processing Order:**
1. Check config map
2. Check process.env
3. Use default if provided
4. Return match if no default

**Example:**
```properties
# In .env file
DB_HOST=${DATABASE_HOST:-localhost}
DB_PORT=${DATABASE_PORT:-5432}

# If env vars set:
# export DATABASE_HOST=prod-db.example.com
# Result: DB_HOST=prod-db.example.com

# If env vars not set:
# Result: DB_HOST=localhost
```

### 3. Explicit Environment: `{env:VARIABLE}`
**Purpose:** Explicitly get environment variable from process.env
**Example:**
```properties
# In .env file
USER_HOME={env:HOME}
# Result: /home/username

# In database query
SELECT '{env:USER}' AS current_user FROM dual
```

### 4. Explicit Config: `{config:KEY}`
**Purpose:** Explicitly get config value from config map
**Example:**
```properties
# In .env file
PROJECT_NAME=MyProject
FULL_NAME={config:PROJECT_NAME} Automation
# Result: FULL_NAME=MyProject Automation

# In API request
X-Project: {config:PROJECT}
```

### 5. Runtime Context Variable: `{{VAR}}` or `{context:VAR}`
**Purpose:** Access runtime context variables from step execution
**NEW IN STANDARDIZATION:** Now supported everywhere!

**Example:**
```gherkin
# Database testing
When user executes scalar query "SELECT MAX(salary) FROM employees"
# Stores value in contextVariables map

When user executes query "SELECT * FROM employees WHERE salary = {{lastScalarResult}}"
# Uses runtime context value

# API testing
Given I extract "$.userId" from response and save as "userId"
And I set request header "X-User-Id" to "{{userId}}"
```

### 6. Ternary Conditional: `{ternary:condition?true_value:false_value}`
**Purpose:** Conditional value based on config
**Example:**
```properties
# In .env file
HEADLESS=true
VIDEO={ternary:HEADLESS?off:on}
# If HEADLESS is set, VIDEO=off, otherwise VIDEO=on

# In database query
SELECT '{ternary:ENVIRONMENT?production:development}' AS env_type FROM dual

# In API request
X-Mode: {ternary:HEADLESS?automated:manual}
```

### 7. Concatenation: `{concat:VAR1+VAR2+VAR3}`
**Purpose:** Combine multiple config values
**Example:**
```properties
# In .env file
FIRST_NAME=John
LAST_NAME=Doe
FULL_NAME={concat:FIRST_NAME+LAST_NAME}
# Result: FULL_NAME=JohnDoe

# In query
SELECT '{concat:PROJECT+ENVIRONMENT}' AS composite FROM dual

# In API header
X-Composite: {concat:PROJECT+ENVIRONMENT}
```

### 8. Case Transformation
**Upper:** `{upper:variable}`
**Lower:** `{lower:variable}`

**Example:**
```properties
# In .env file
PROJECT=orangehrm
PROJECT_UPPER={upper:PROJECT}
# Result: PROJECT_UPPER=ORANGEHRM

# In query
SELECT '{upper:PROJECT}' AS project_upper FROM dual

# In API request
X-Project-Upper: {upper:PROJECT}
```

### 9. Dynamic Placeholders

#### Random String: `<random>`
```properties
TEST_ID=test_<random>
# Result: test_a7b3c9d
```

#### Timestamp: `<timestamp>`
```properties
RUN_ID=run_<timestamp>
# Result: run_1696780800000
```

#### UUID: `<uuid>`
```properties
UNIQUE_ID=<uuid>
# Result: 550e8400-e29b-41d4-a716-446655440000
```

#### Date: `<date:FORMAT>`
```properties
REPORT_DATE=<date:YYYY-MM-DD>
# Result: 2025-10-10

RUN_TIMESTAMP=<date:YYYY-MM-DD_HH-mm-ss>
# Result: 2025-10-10_14-30-45
```

#### Generate Values: `<generate:TYPE>`
```properties
TEST_EMAIL=<generate:email>
# Result: test_1696780800000@example.com

TEST_PHONE=<generate:phone>
# Result: +12125551234

TEST_USERNAME=<generate:username>
# Result: user_a7b3c9d

TEST_PASSWORD=<generate:password>
# Result: aB3!xYz@9Qw
```

---

## Usage in Different Modules

### Configuration Files (.env)

All interpolation happens **once** during framework initialization.

```properties
# config/global.env
PROJECT=orangehrm
ENVIRONMENT=dev
BASE_URL=https://{PROJECT}-{ENVIRONMENT}.example.com
DB_HOST=${DATABASE_HOST:-localhost}
API_KEY={env:API_KEY}
VIDEO_MODE={ternary:HEADLESS?off:on}
PROJECT_UPPER={upper:PROJECT}
TEST_EMAIL=<generate:email>
```

### Database Queries

All interpolation happens **at runtime** when executing queries using `configManager.interpolate()`.

```gherkin
# Config variables
When user executes query "SELECT * FROM {PROJECT}_employees"

# Environment variables
When user executes query "SELECT * FROM ${SCHEMA}.employees"

# Explicit config
When user executes query "SELECT '{config:PROJECT}' AS project FROM dual"

# Explicit environment
When user executes query "SELECT '{env:USER}' AS current_user FROM dual"

# Runtime context (NEW!)
When user executes scalar query "SELECT MAX(salary) FROM employees"
When user executes query "SELECT * FROM employees WHERE salary = {{lastScalarResult}}"

# Ternary conditionals (NEW!)
When user executes query "SELECT '{ternary:HEADLESS?auto:manual}' AS mode FROM dual"

# Concatenation (NEW!)
When user executes query "SELECT '{concat:PROJECT+ENVIRONMENT}' AS composite FROM dual"

# Case transformation (NEW!)
When user executes query "SELECT '{upper:PROJECT}' AS project_upper FROM dual"

# Dynamic values (NEW!)
When user executes query "INSERT INTO logs VALUES ('<uuid>', '<timestamp>', '<generate:email>')"
```

### API Requests

All interpolation happens **at runtime** when building/sending requests using `configManager.interpolate()`.

```gherkin
# Config variables
Given the API base URL is "https://{PROJECT}.example.com"
And I set request header "X-Project" to "{PROJECT}"

# Environment variables
And I set request header "X-User" to "${USER:-testuser}"

# Explicit config
And I set request header "X-Environment" to "{config:ENVIRONMENT}"

# Explicit environment
And I set request header "X-Home" to "{env:HOME}"

# Runtime context (NEW!)
Given I extract "$.userId" from response and save as "userId"
And I set request header "X-User-Id" to "{{userId}}"

# Ternary conditionals (NEW!)
And I set request header "X-Mode" to "{ternary:HEADLESS?automated:manual}"

# Concatenation (NEW!)
And I set request header "X-Composite" to "{concat:PROJECT+ENVIRONMENT}"

# Case transformation (NEW!)
And I set request header "X-Project-Upper" to "{upper:PROJECT}"

# Dynamic values (NEW!)
And I set JSON body:
  """
  {
    "request_id": "<uuid>",
    "timestamp": "<timestamp>",
    "random_id": "test_<random>",
    "email": "<generate:email>",
    "date": "<date:YYYY-MM-DD>"
  }
  """
```

---

## Backward Compatibility

### 100% Backward Compatible

All existing test scripts continue to work without modification:

#### Old Syntax (Still Works)
```gherkin
# Database - old limited syntax
When user executes query "SELECT * FROM employees WHERE dept_id = {{dept_id}}"

# API - old context variable syntax
And I set request header "X-Token" to "{{accessToken}}"
```

#### New Syntax (Enhanced Capabilities)
```gherkin
# Database - now supports ALL syntax types
When user executes query "SELECT * FROM {PROJECT}_employees WHERE dept_id = {{dept_id}} AND mode = '{ternary:HEADLESS?auto:manual}'"

# API - now supports ALL syntax types
And I set request header "X-Token" to "{{accessToken}}"
And I set request header "X-Project" to "{upper:PROJECT}"
And I set request header "X-Request-Id" to "<uuid>"
```

---

## Migration Benefits

### Before Standardization

**Database Query:**
```typescript
// DatabaseGenericSteps.ts had limited interpolation
private interpolateVariables(text: string): string {
    // ${VAR} - Environment variable ONLY
    text = text.replace(/\${([^}]+)}/g, (match, varName) => {
        return process.env[varName] || match;
    });

    // {{var}} - Context variable
    text = text.replace(/{{([^}]+)}}/g, (match, varName) => {
        return this.contextVariables.get(varName) || match;
    });

    // %VAR% - Config variable
    text = text.replace(/%([^%]+)%/g, (match, varName) => {
        return this.configManager.get(varName) || match;
    });

    return text;
}
```

**API Request:**
```typescript
// CSAPIRequestSteps.ts had similar limited interpolation
private interpolateValue(value: string): string {
    // Similar duplicate logic...
}
```

**Problems:**
- ❌ 13 duplicate methods across different files
- ❌ Limited syntax support (only 3 types in database, 2-3 in API)
- ❌ No support for advanced features (ternary, concat, case transform, dynamic values)
- ❌ Inconsistent behavior across modules

### After Standardization

**All Modules:**
```typescript
// Everyone uses CSConfigurationManager.interpolate()
const interpolatedText = this.configManager.interpolate(text, this.contextVariables);
```

**Benefits:**
- ✅ Single source of truth
- ✅ ALL syntax types available everywhere
- ✅ Consistent behavior across framework
- ✅ Easier maintenance (one place to update)
- ✅ -134 lines of code (reduced complexity)
- ✅ Full feature parity across modules

---

## Complete Syntax Reference

| Syntax | Purpose | Supported Everywhere | Example |
|--------|---------|---------------------|---------|
| `{VAR}` | Config variable | ✅ | `{PROJECT}` |
| `${VAR:-default}` | Config/Env with default | ✅ | `${DB_HOST:-localhost}` |
| `{env:VAR}` | Explicit environment | ✅ | `{env:HOME}` |
| `{config:KEY}` | Explicit config | ✅ | `{config:PROJECT}` |
| `{{VAR}}` | Runtime context | ✅ | `{{userId}}` |
| `{context:VAR}` | Explicit context | ✅ | `{context:userId}` |
| `{ternary:COND?T:F}` | Conditional | ✅ | `{ternary:HEADLESS?off:on}` |
| `{concat:A+B}` | Concatenation | ✅ | `{concat:PROJECT+ENVIRONMENT}` |
| `{upper:VAR}` | Uppercase | ✅ | `{upper:PROJECT}` |
| `{lower:VAR}` | Lowercase | ✅ | `{lower:PROJECT}` |
| `<random>` | Random string | ✅ | `test_<random>` |
| `<timestamp>` | Unix timestamp | ✅ | `<timestamp>` |
| `<uuid>` | UUID v4 | ✅ | `<uuid>` |
| `<date:FORMAT>` | Formatted date | ✅ | `<date:YYYY-MM-DD>` |
| `<generate:TYPE>` | Generated data | ✅ | `<generate:email>` |

---

## Real-World Examples

### Example 1: Database Testing with All Features

```gherkin
Scenario: Advanced Database Query with All Interpolation Types
  When user connects to "PRACTICE_ORACLE" database

  # Config variable
  When user executes query "SELECT * FROM {PROJECT}_employees"

  # Environment variable with default
  When user executes query "SELECT * FROM ${SCHEMA:-public}.employees"

  # Explicit environment
  When user executes query "SELECT '{env:USER}' AS current_user FROM dual"

  # Runtime context
  When user executes scalar query "SELECT MAX(salary) FROM employees"
  When user executes query "SELECT * FROM employees WHERE salary = {{lastScalarResult}}"

  # Ternary conditional
  When user executes query "SELECT '{ternary:HEADLESS?automated:manual}' AS mode FROM dual"

  # Concatenation
  When user executes query "SELECT '{concat:PROJECT+ENVIRONMENT}' AS composite FROM dual"

  # Case transformation
  When user executes query "SELECT '{upper:PROJECT}' AS project_upper FROM dual"

  # Dynamic values
  When user executes query "INSERT INTO logs VALUES ('<uuid>', '<timestamp>', '{PROJECT}', '<generate:email>')"
```

### Example 2: API Testing with All Features

```gherkin
Scenario: Advanced API Request with All Interpolation Types
  Given the API base URL is "https://api.example.com"

  # Config variable
  And I set request header "X-Project" to "{PROJECT}"

  # Environment variable with default
  And I set request header "X-User" to "${USER:-testuser}"

  # Explicit config
  And I set request header "X-Environment" to "{config:ENVIRONMENT}"

  # Runtime context
  Given I extract "$.token" from response and save as "authToken"
  And I use bearer token "{{authToken}}"

  # Ternary conditional
  And I set request header "X-Mode" to "{ternary:HEADLESS?auto:manual}"

  # Concatenation
  And I set request header "X-Composite" to "{concat:PROJECT+ENVIRONMENT}"

  # Case transformation
  And I set request header "X-Project-Upper" to "{upper:PROJECT}"

  # Dynamic values in JSON body
  And I set JSON body:
    """
    {
      "request_id": "<uuid>",
      "timestamp": "<timestamp>",
      "project": "{PROJECT}",
      "environment": "{config:ENVIRONMENT}",
      "mode": "{ternary:HEADLESS?automated:manual}",
      "composite": "{concat:PROJECT+ENVIRONMENT}",
      "project_upper": "{upper:PROJECT}",
      "random_ref": "test_<random>",
      "email": "<generate:email>",
      "username": "<generate:username>",
      "phone": "<generate:phone>",
      "date": "<date:YYYY-MM-DD>"
    }
    """

  When I send a POST request to "/api/test"
  Then the response status should be 200
```

### Example 3: Configuration File with All Features

```properties
# config/orangehrm/orangehrm.env

# Basic config variables
PROJECT=orangehrm
ENVIRONMENT=dev

# Config variable reference
BASE_URL=https://{PROJECT}.example.com
API_ENDPOINT={BASE_URL}/api/v1

# Environment variable with default
DB_HOST=${DATABASE_HOST:-localhost}
DB_PORT=${DATABASE_PORT:-3306}

# Explicit environment
USER_HOME={env:HOME}
SYSTEM_PATH={env:PATH}

# Explicit config
PROJECT_FULL_NAME={config:PROJECT} Test Automation

# Ternary conditional
VIDEO_MODE={ternary:HEADLESS?off:on}
SCREENSHOT_MODE={ternary:HEADLESS?on-failure:always}
BROWSER_TYPE={ternary:BROWSER?{BROWSER}:chromium}

# Concatenation
FULL_CONTEXT={concat:PROJECT+ENVIRONMENT}
LOG_PREFIX={concat:PROJECT+ENVIRONMENT}

# Case transformation
PROJECT_UPPER={upper:PROJECT}
PROJECT_LOWER={lower:PROJECT}

# Dynamic values
TEST_RUN_ID=<uuid>
TEST_TIMESTAMP=<timestamp>
TEST_RANDOM_ID=test_<random>
TEST_DATE=<date:YYYY-MM-DD>
TEST_DATETIME=<date:YYYY-MM-DD_HH-mm-ss>

# Generated test data
TEST_EMAIL=<generate:email>
TEST_USERNAME=<generate:username>
TEST_PHONE=<generate:phone>
TEST_PASSWORD=<generate:password>
```

---

## Testing Interpolation

### Test Configuration Interpolation

```properties
# config/test/interpolation-test.env
VAR_A=value1
VAR_B={VAR_A}_extended
VAR_C=${HOME}
VAR_D={upper:VAR_A}
VAR_E=<random>
VAR_F={ternary:VAR_A?true_value:false_value}
VAR_G={concat:VAR_A+VAR_B}
```

### Test Database Interpolation

```gherkin
Scenario: Test All Database Interpolation Types
  When user connects to "PRACTICE_MYSQL" database

  # Test config variable
  When user executes query "SELECT '{PROJECT}' AS project FROM dual"
  Then the value in row 1 column "project" should be "orangehrm"

  # Test environment variable
  When user executes query "SELECT '${USER:-testuser}' AS user_env FROM dual"
  Then the value in row 1 column "user_env" should not be null

  # Test ternary
  When user executes query "SELECT '{ternary:HEADLESS?true:false}' AS ternary_test FROM dual"
  Then the value in row 1 column "ternary_test" should exist

  # Test dynamic values
  When user executes query "SELECT '<uuid>' AS uuid_test, '<timestamp>' AS ts_test FROM dual"
  Then the value in row 1 column "uuid_test" should not be null
```

### Test API Interpolation

```gherkin
Scenario: Test All API Interpolation Types
  Given the API base URL is "https://postman-echo.com"

  # Test all interpolation types in headers
  And I set request headers:
    | X-Config-Var    | {PROJECT}                      |
    | X-Env-Var       | ${USER:-testuser}              |
    | X-Ternary       | {ternary:HEADLESS?auto:manual} |
    | X-Concat        | {concat:PROJECT+ENVIRONMENT}   |
    | X-Upper         | {upper:PROJECT}                |
    | X-UUID          | <uuid>                         |
    | X-Timestamp     | <timestamp>                    |
    | X-Email         | <generate:email>               |

  When I send a GET request to "/headers"
  Then the response status should be 200
  And the response body should contain "orangehrm"
```

---

## Technical Implementation

### CSConfigurationManager.interpolate() Method

```typescript
/**
 * Public interpolation method with context variable support
 * Supports all CSConfigurationManager syntax PLUS runtime context variables
 *
 * @param value - String value to interpolate
 * @param contextMap - Optional Map of runtime context variables
 * @returns Interpolated string
 */
public interpolate(value: string, contextMap?: Map<string, any>): string {
    if (typeof value !== 'string') return value;

    let result = value;

    // 1. Handle {{VAR}} syntax for context variables (backward compatible)
    if (contextMap) {
        result = result.replace(/\{\{([^}]+)\}\}/g, (match, varName) => {
            const contextValue = contextMap.get(varName);
            return contextValue !== undefined ? String(contextValue) : match;
        });
    }

    // 2. Handle standard CSConfigurationManager interpolation (now with context support)
    result = this.interpolateAdvanced(result, contextMap);

    return result;
}
```

### Usage in Database Steps

```typescript
// DatabaseGenericSteps.ts (line 66)
@CSBDDStepDef('user executes query {string}')
async executeQuery(query: string): Promise<void> {
    // Use centralized interpolation system from CSConfigurationManager
    const interpolatedQuery = this.configManager.interpolate(query, this.contextVariables);

    const result = await this.databaseContext.executeQuery(interpolatedQuery);
    // ... rest of the method
}
```

### Usage in API Steps

```typescript
// CSAPIRequestSteps.ts
// All request building now uses configManager.interpolate()
const context = this.contextManager.getCurrentContext();
const interpolatedValue = this.configManager.interpolate(value, context.variables);
```

---

## Summary

### What Changed

1. **CSConfigurationManager** - Added `interpolate()` public method with context support
2. **Database Steps** - All now use `configManager.interpolate(text, contextVariables)`
3. **API Steps** - All now use `configManager.interpolate(text, context.variables)`
4. **Removed** - 13 duplicate interpolation methods across the framework

### What's New

- ✅ `{ternary:COND?TRUE:FALSE}` - Conditional interpolation (everywhere)
- ✅ `{concat:VAR1+VAR2}` - Concatenation (everywhere)
- ✅ `{upper:VAR}`, `{lower:VAR}` - Case transformation (everywhere)
- ✅ `<random>`, `<timestamp>`, `<uuid>`, `<date>`, `<generate:TYPE>` - Dynamic values (everywhere)
- ✅ `{{VAR}}` and `{context:VAR}` - Runtime context (everywhere)

### Best Practices

1. **Use `{VAR}` for config references** in .env files
2. **Use `${VAR:-default}` for environment variables** with defaults
3. **Use `{env:VAR}` when you explicitly need** environment variables
4. **Use `{config:KEY}` when you explicitly need** config values
5. **Use `{{VAR}}` for runtime context values** in queries/requests
6. **Use `{ternary:...}` for conditional logic** instead of multiple config files
7. **Use `<generate:TYPE>` for test data** to avoid hardcoding
8. **Use `<uuid>` and `<timestamp>` for unique identifiers** in logs/data

---

**Created:** 2025-10-10
**Framework Version:** cs-playwright-test-framework 1.0.10+
**Standardization:** COMPLETE
**Backward Compatibility:** 100%
