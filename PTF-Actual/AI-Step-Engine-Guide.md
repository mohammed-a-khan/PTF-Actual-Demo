# AI Step Engine — Complete Feature Guide

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Coded Steps vs AI Steps — Side-by-Side Comparison](#coded-steps-vs-ai-steps)
4. [Phase 1: Enhanced Wait Strategies](#phase-1-enhanced-wait-strategies)
5. [Phase 2: Browser & Tab Management](#phase-2-browser--tab-management)
6. [Phase 3: Key Combinations & Keyboard Shortcuts](#phase-3-key-combinations--keyboard-shortcuts)
7. [Phase 4: Enhanced Assertions](#phase-4-enhanced-assertions)
8. [Phase 5: URL Parameter Operations](#phase-5-url-parameter-operations)
9. [Phase 6: Table Data Operations](#phase-6-table-data-operations)
10. [Phase 7: Data Generation & Context](#phase-7-data-generation--context)
11. [Phase 8: Frame/iFrame Switching](#phase-8-frameiframe-switching)
12. [Phase 9: Cookie & Storage Operations](#phase-9-cookie--storage-operations)
13. [Phase 10: File Download Verification](#phase-10-file-download-verification)
14. [Phase 11: Inline API Calls](#phase-11-inline-api-calls)
15. [Phase 12: JavaScript Execution](#phase-12-javascript-execution)
16. [Complete Intent Reference](#complete-intent-reference)
17. [Grammar Rule Reference](#grammar-rule-reference)

---

## Overview

The AI Step Engine enables **zero-code natural language test steps** in Gherkin `.feature` files. Instead of writing coded step definitions in TypeScript, testers write plain English instructions prefixed with `AI`.

**Key characteristics:**
- No external LLM or cloud API required — grammar-based parsing runs locally
- Deterministic — same instruction always produces same result
- 80 intents across actions, assertions, and queries
- ~130 grammar rules across 7 grammar files
- Works alongside 400+ coded step definitions in the same feature file

### BDD Patterns

```gherkin
# Pattern 1: General action/assertion
When AI "Click the Login button"
Then AI "Verify the Dashboard heading is displayed"

# Pattern 2: Query with variable storage
When AI "Get the text from the heading" and store as "headingText"

# Pattern 3: Action with explicit value injection
When AI "Type in the search field" with value "{scenario:searchTerm}"

# Pattern 4: Conditional execution
When AI "Check the Terms checkbox" if "acceptTerms" is "Yes"
```

---

## Architecture

```
.feature file
    │
    ├── AI "instruction" ──→ CSAISteps (@CSBDDStepDef)
    │                            │
    │                            ▼
    │                       CSAIStepBDD (variable resolution)
    │                            │
    │                            ▼
    │                       csAI() orchestrator
    │                            │
    │                   ┌────────┴────────┐
    │                   ▼                 ▼
    │              CSAIStepParser     CSAccessibilityTreeMatcher
    │              (grammar + NLP)    (element finding)
    │                   │                 │
    │                   ▼                 ▼
    │              CSAIActionExecutor (dispatch + execute)
    │
    └── Regular step ──→ @CSBDDStepDef coded step definitions
```

**Grammar files:**
| File | Content | Priority Range |
|------|---------|---------------|
| `action-grammars.ts` | Click, type, select, hover, scroll, wait, keyboard | 10-89 |
| `assertion-grammars.ts` | Verify visible, text, enabled, CSS, dropdown, URL param | 100-149 |
| `query-grammars.ts` | Get text, value, count, URL, URL param | 200-254 |
| `navigation-grammars.ts` | Navigate, go back, reload | 150-312 |
| `browser-grammars.ts` | Tab, browser, frame, cookie, storage | 350-530 |
| `table-grammars.ts` | Table data, cell, column, row count | 400-449 |
| `data-grammars.ts` | Data generation, screenshot, download, API, JS | 450-499 |

---

## Coded Steps vs AI Steps

### Enterprise Application Comparison

The following examples show how coded step definitions compare to AI step equivalents. These are based on typical enterprise test scenarios for a web application with forms, tables, approval workflows, and reports.

---

### Login & Navigation

**Coded (requires step definitions in app-login.steps.ts):**
```gherkin
Given I login to the application as "testUser"
Then I should see Home page header
And I should see welcome message with username "testUser"
When I click on Products menu item
Then I should see Products page header
And I wait for loader to complete
```

**AI (zero-code, no step definitions needed):**
```gherkin
Given AI "Navigate to 'https://myapp.example.com/login'"
When AI "Type 'testUser' in the Username field"
And AI "Type 'password123' in the Password field"
And AI "Click the Log On button"
Then AI "Verify the Home heading is displayed"
And AI "Verify the page contains 'Welcome, testUser'"
When AI "Click the Products menu item"
Then AI "Verify the Products heading is displayed"
And AI "Wait for the loading spinner to disappear"
```

---

### Element Verification (Page Elements Test)

**Coded (requires app-products.steps.ts — thousands of lines):**
```gherkin
Then I should see Add Product button
And Add Product button should be enabled
And I should see Active tab
And Active tab should be selected by default
And I should see Archived tab
And I should see Filters button on active tab
And Filters area should not be expanded by default
```

**AI (zero-code):**
```gherkin
Then AI "Verify the Add Product button is displayed"
And AI "Verify the Add Product button is enabled"
And AI "Verify the Active tab is visible"
And AI "Verify the Active tab is checked"
And AI "Verify the Archived tab is visible"
And AI "Verify the Filters button is displayed"
And AI "Verify the Filters area is hidden"
```

---

### Form Interaction (Create Record)

**Coded:**
```gherkin
When I click Category dropdown button on Add screen
Then I should see Category dropdown list
When I select "{scenario:categoryName}" from Category dropdown on Add screen
Then Category dropdown should show "{scenario:categoryName}" on Add screen
```

**AI:**
```gherkin
When AI "Click the Category dropdown"
Then AI "Verify the Category dropdown list is visible"
When AI "Select '{scenario:categoryName}' from the Category dropdown"
Then AI "Verify the Category dropdown selected option is '{scenario:categoryName}'"
```

---

### Maker-Checker Approval Workflow (Multi-User)

**Coded (requires complex re-authentication coded steps):**
```gherkin
# Maker creates record
When I click Save button on Add screen
Then I should see Record Details page header

# Switch to Checker for approval
When I clear browser context for re-authentication
And I login to the application as "approverUser"
Then I should see Home page header
```

**AI (zero-code):**
```gherkin
# Maker creates record
When AI "Click the Save button"
Then AI "Verify the Record Details heading is displayed"

# Switch to Checker for approval
When AI "Clear browser session for re-authentication"
And AI "Navigate to 'https://myapp.example.com/login'"
And AI "Type 'approverUser' in the Username field"
And AI "Type 'approverPassword' in the Password field"
And AI "Click the Log On button"
Then AI "Verify the Home heading is displayed"
```

---

### Background Job Execution

**Coded:**
```gherkin
When I click on Settings link button
And I click on menu option "Scheduled Jobs" in Settings
Then I should see "Scheduled Jobs" page displayed
When I click DataSyncJobTrigger link
Then I should see Trigger Detail page header
When I click Run Job button and wait for job to complete
```

**AI:**
```gherkin
When AI "Click the Settings link"
And AI "Click the Scheduled Jobs menu item"
Then AI "Verify the Scheduled Jobs heading is displayed"
When AI "Click the DataSyncJobTrigger link"
Then AI "Verify the Trigger Detail heading is displayed"
When AI "Click the Run Job button"
And AI "Wait for the status text to be 'Complete'"
```

---

### Search & Filter

**Coded:**
```gherkin
When I search for the created record in list
When I navigate to the created record details
Then I should see Record Details page header
```

**AI:**
```gherkin
When AI "Type '{scenario:recordName}' in the search field"
And AI "Press Enter on the search field"
And AI "Wait 2 seconds"
When AI "Click the '{scenario:recordName}' link"
Then AI "Verify the Record Details heading is displayed"
```

---

### Table Data Verification

**Coded (requires custom table iteration steps):**
```gherkin
Then I verify Job Triggers table headers
When I click DataSyncJobTrigger link
```

**AI:**
```gherkin
Then AI "Get all data from the Job Triggers table" and store as "tableData"
And AI "Verify row 1 column 'Trigger Name' of the Job Triggers table is 'DataSyncJobTrigger'"
And AI "Get the number of rows in the Job Triggers table" and store as "rowCount"
When AI "Get value from row 1 column 'Trigger Name' of the Job Triggers table" and store as "triggerName"
```

---

### File Upload

**Coded (requires app-file-upload.steps.ts — hundreds of lines):**
```gherkin
Then I verify Add files button is enabled
And I verify Upload button is disabled
When I prepare file upload test data for scenario
And I click the Upload button
And I wait for file row 1 upload to complete
Then I verify selected file count text is "1"
```

**AI:**
```gherkin
Then AI "Verify the Add files button is enabled"
And AI "Verify the Upload button is disabled"
When AI "Upload the file 'test-data/sample-data.csv' to the file input"
And AI "Click the Upload button"
And AI "Wait for the progress bar to disappear"
Then AI "Verify the page contains '1 file'"
```

---

### Export & Download

**Coded:**
```gherkin
When I click Export button
Then I verify file was downloaded successfully
And I verify exported file contains expected data
```

**AI:**
```gherkin
When AI "Click the Export button"
And AI "Wait 3 seconds"
Then AI "Verify a file was downloaded"
And AI "Verify the downloaded file contains 'Product Name'"
And AI "Get the path of the downloaded file" and store as "exportPath"
```

---

## Phase 1: Enhanced Wait Strategies

### Intents
| Intent | Type | Page-Level | Description |
|--------|------|:----------:|-------------|
| `wait-seconds` | Action | Yes | Fixed time delay |
| `wait-url-change` | Action | Yes | Wait for URL to change or contain pattern |
| `wait-text-change` | Action | No | Wait for element text to change or match |

### Usage Examples

```gherkin
# Fixed waits
When AI "Wait 5 seconds"
When AI "Pause for 3 seconds"
When AI "Wait 500 milliseconds"

# URL-based waits
When AI "Wait for URL to contain '/dashboard'"
When AI "Wait for the URL to change"

# Text-based waits (element-targeted)
When AI "Wait for the heading text to be 'Welcome'"
When AI "Wait for the status text to change"
```

### When to Use
- **wait-seconds**: After actions that trigger async operations without observable DOM changes
- **wait-url-change**: After clicks that trigger navigation (SPA route changes)
- **wait-text-change**: After actions that update text content (e.g., status after job execution)

---

## Phase 2: Browser & Tab Management

### Intents
| Intent | Type | Page-Level | Description |
|--------|------|:----------:|-------------|
| `switch-tab` | Action | Yes | Switch to tab by index, latest, or main |
| `open-new-tab` | Action | Yes | Open a new browser tab |
| `close-tab` | Action | Yes | Close current or specific tab |
| `switch-browser` | Action | Yes | Switch to different browser type |
| `clear-session` | Action | Yes | Clear cookies/storage for re-auth |

### Usage Examples

```gherkin
# Tab switching
When AI "Switch to tab 2"
When AI "Switch to the latest tab"
When AI "Switch to the main tab"

# Tab lifecycle
When AI "Open a new tab"
When AI "Open a new tab with 'https://example.com'"
When AI "Close the current tab"
When AI "Close tab 2"

# Browser switching (multi-browser tests)
When AI "Switch to Firefox browser"
When AI "Switch to Chrome browser"

# Re-authentication (maker-checker workflow)
When AI "Clear browser session for re-authentication"
When AI "Clear session and navigate to '/login'"
```

### Example: Maker-Checker Approval Workflow
```gherkin
@approval-flow
Scenario: Create and approve a record

    # Step 1: Maker creates record
    When AI "Type 'maker@test.com' in the Username field"
    And AI "Type 'password' in the Password field"
    And AI "Click the Login button"
    And AI "Click the Create New button"
    And AI "Type 'Test Record' in the Name field"
    And AI "Click the Save button"
    Then AI "Verify the success message is displayed"

    # Step 2: Switch to Checker
    When AI "Clear browser session for re-authentication"
    And AI "Type 'approver@test.com' in the Username field"
    And AI "Type 'password' in the Password field"
    And AI "Click the Login button"

    # Step 3: Approve record
    When AI "Click the Pending Approvals menu item"
    And AI "Click the 'Test Record' link"
    And AI "Click the Approve button"
    Then AI "Verify the approval success message is displayed"
```

---

## Phase 3: Key Combinations & Keyboard Shortcuts

### Grammar Rules (no new intents — extends existing `press-key`)

### Usage Examples

```gherkin
# Key combinations
When AI "Press Ctrl+A"
When AI "Press Control+Shift+Delete"
When AI "Press Ctrl+C on the text field"

# Named shortcuts
When AI "Select all text"
When AI "Copy the text"
When AI "Paste"
When AI "Cut the selection"
When AI "Undo"
When AI "Redo"
```

### Supported Modifiers
| Input | Normalized |
|-------|-----------|
| `Ctrl`, `Control` | `Control` |
| `Alt` | `Alt` |
| `Shift` | `Shift` |
| `Cmd`, `Command`, `Meta` | `Meta` |

---

## Phase 4: Enhanced Assertions

### Intents
| Intent | Type | Description |
|--------|------|-------------|
| `verify-css` | Assertion | Verify CSS property value |
| `verify-matches` | Assertion | Verify text matches regex pattern |
| `verify-selected-option` | Assertion | Verify dropdown selected option |
| `verify-dropdown-options` | Assertion | Verify dropdown contains specific options |

### Usage Examples

```gherkin
# CSS property verification
Then AI "Verify the button CSS 'background-color' is 'red'"
Then AI "Verify the heading style 'color' equals 'rgb(0, 0, 0)'"

# Regex pattern matching
Then AI "Verify the phone field matches pattern '\d{3}-\d{4}'"
Then AI "Verify the email field matches regex '^[a-z]+@[a-z]+\.[a-z]+$'"

# Dropdown verification
Then AI "Verify the Currency dropdown selected option is 'USD'"
Then AI "Verify the Method dropdown contains options 'Standard, Premium, Enterprise'"

# Negated text assertion
Then AI "Verify the heading text is not 'Error'"
Then AI "Verify the status does not equal 'Failed'"
```

### Example: Dropdown Verification on Add Screen
```gherkin
When AI "Click the Category dropdown"
And AI "Select 'Premium' from the Category dropdown"
Then AI "Verify the Category dropdown selected option is 'Premium'"
And AI "Verify the Pricing Model dropdown contains options 'Fixed, Variable, Tiered'"
```

---

## Phase 5: URL Parameter Operations

### Intents
| Intent | Type | Page-Level | Description |
|--------|------|:----------:|-------------|
| `get-url-param` | Query | Yes | Extract URL parameter value |
| `verify-url-param` | Assertion | Yes | Verify URL parameter value |

### Usage Examples

```gherkin
# Extract URL parameters
When AI "Get the URL parameter 'id'" and store as "selectedId"
When AI "Get the URL parameter 'tab'" and store as "activeTab"

# Verify URL parameters
Then AI "Verify the URL parameter 'id' is '12345'"
Then AI "Verify the URL parameter 'tab' is 'details'"
Then AI "Verify the URL contains parameter 'session'"
```

### Example: Navigate and Extract Record ID
```gherkin
When AI "Click the first row in the results table"
Then AI "Wait for URL to contain '/details'"
And AI "Get the URL parameter 'id'" and store as "recordId"
And AI "Verify the URL parameter 'tab' is 'details'"
```

---

## Phase 6: Table Data Operations

### Intents
| Intent | Type | Description |
|--------|------|-------------|
| `get-table-data` | Query | Capture entire table as JSON array |
| `get-table-cell` | Query | Get specific cell value by row/column |
| `get-table-column` | Query | Get all values from a column |
| `get-table-row-count` | Query | Count table rows |
| `verify-table-cell` | Assertion | Verify specific cell value |

### Usage Examples

```gherkin
# Capture entire table
When AI "Get all data from the results table" and store as "tableData"
When AI "Capture the table data" and store as "allRows"

# Access specific cell (by column index)
When AI "Get value from row 2 column 3 of the table" and store as "cellValue"

# Access specific cell (by column header name)
When AI "Get value from row 1 column 'Rate Name' of the table" and store as "rateName"

# Get entire column
When AI "Get all values from column 'Status' in the table" and store as "statuses"
When AI "Get all values from column 3 in the table" and store as "col3Values"

# Row count
When AI "Get the number of rows in the table" and store as "rowCount"
When AI "Count rows in the results table" and store as "totalRows"

# Verify cell value
Then AI "Verify row 1 column 'Status' of the table is 'Active'"
Then AI "Verify row 2 column 3 of the table is 'USD'"
```

### Example: Verify Data Table
```gherkin
Then AI "Verify the Users table is displayed"
And AI "Get the number of rows in the Users table" and store as "userCount"
And AI "Verify row 1 column 'Name' of the Users table is 'John Smith'"
And AI "Get value from row 1 column 'Status' of the Users table" and store as "userStatus"
```

---

## Phase 7: Data Generation & Context

### Intents
| Intent | Type | Page-Level | Description |
|--------|------|:----------:|-------------|
| `generate-data` | Query | Yes | Generate UUID, timestamp, random values |
| `set-variable` | Action | Yes | Store a value in scenario context |
| `take-screenshot` | Action | Yes | Capture page screenshot |

### Usage Examples

```gherkin
# Data generation
When AI "Generate a UUID" and store as "testId"
When AI "Generate a timestamp" and store as "testDate"
When AI "Generate a random string of length 10" and store as "randomCode"
When AI "Generate a random number between 1 and 100" and store as "randomNum"
When AI "Generate a random email" and store as "testEmail"

# Variable management
When AI "Set variable 'userName' to 'admin'"

# Screenshot capture
When AI "Take a screenshot"
When AI "Take a screenshot as 'login-page'"
```

### Example: Dynamic Test Data
```gherkin
# Generate unique test data
When AI "Generate a random email" and store as "testEmail"
And AI "Generate a UUID" and store as "uniqueRef"

# Use generated data in form
And AI "Type in the Email field" with value "{scenario:testEmail}"
And AI "Type in the Reference field" with value "{scenario:uniqueRef}"
And AI "Click the Save button"
Then AI "Verify the success message is displayed"

# Screenshot for evidence
And AI "Take a screenshot as 'created-record'"
```

---

## Phase 8: Frame/iFrame Switching

### Intents
| Intent | Type | Page-Level | Description |
|--------|------|:----------:|-------------|
| `switch-frame` | Action | Yes | Switch to a specific frame |
| `switch-main-frame` | Action | Yes | Return to main/top frame |

### Usage Examples

```gherkin
# Switch by CSS selector
When AI "Switch to frame '#payment-iframe'"

# Switch by name
When AI "Switch to frame named 'content'"

# Switch by index
When AI "Switch to frame 1"

# Return to main frame
When AI "Switch to main frame"
When AI "Switch to the default content"
```

### Example: Embedded Report
```gherkin
When AI "Switch to frame '#report-iframe'"
Then AI "Verify the Report heading is displayed"
And AI "Get the text from the total row" and store as "reportTotal"
When AI "Switch to main frame"
Then AI "Verify the Dashboard heading is displayed"
```

---

## Phase 9: Cookie & Storage Operations

### Intents
| Intent | Type | Page-Level | Description |
|--------|------|:----------:|-------------|
| `clear-cookies` | Action | Yes | Clear all cookies |
| `get-cookie` | Query | Yes | Get cookie value |
| `set-cookie` | Action | Yes | Set cookie value |
| `clear-storage` | Action | Yes | Clear local/session storage |
| `set-storage-item` | Action | Yes | Set storage item |
| `get-storage-item` | Query | Yes | Get storage item |

### Usage Examples

```gherkin
# Cookie operations
When AI "Clear all cookies"
When AI "Get the cookie 'session_token'" and store as "token"

# Local storage
When AI "Set local storage 'theme' to 'dark'"
When AI "Get local storage item 'theme'" and store as "currentTheme"
When AI "Clear local storage"

# Session storage
When AI "Set session storage 'token' to 'abc123'"
When AI "Get session storage item 'token'" and store as "authToken"
When AI "Clear session storage"

# Clear everything
When AI "Clear all storage"
```

### Example: Feature Flag Testing
```gherkin
# Set feature flag before test
When AI "Set local storage 'featureFlags' to '{\"darkMode\":true}'"
And AI "Navigate to '/dashboard'"
Then AI "Verify the body CSS 'background-color' is 'rgb(0, 0, 0)'"
```

---

## Phase 10: File Download Verification

### Intents
| Intent | Type | Page-Level | Description |
|--------|------|:----------:|-------------|
| `verify-download` | Assertion | Yes | Verify file was downloaded |
| `get-download-path` | Query | Yes | Get downloaded file path |
| `verify-download-content` | Assertion | Yes | Verify downloaded file content |

### Usage Examples

```gherkin
# Verify specific file downloaded
Then AI "Verify file 'report.csv' was downloaded"

# Verify any download occurred
Then AI "Verify a file was downloaded"

# Get download path
When AI "Get the path of the downloaded file" and store as "filePath"

# Verify file content
Then AI "Verify the downloaded file contains 'Total Revenue'"
Then AI "Verify downloaded file 'data.csv' contains 'header'"
```

### Example: Export Verification
```gherkin
When AI "Click the Export button"
And AI "Wait 3 seconds"
Then AI "Verify file 'products-export.csv' was downloaded"
And AI "Verify the downloaded file contains 'Product Name'"
And AI "Verify the downloaded file contains '{scenario:productName}'"
```

---

## Phase 11: Inline API Calls

### Intents
| Intent | Type | Page-Level | Description |
|--------|------|:----------:|-------------|
| `api-call` | Action | Yes | Make HTTP API call |
| `verify-api-response` | Assertion | Yes | Verify API response status/content |
| `get-api-response` | Query | Yes | Extract value from API response |

### Usage Examples

```gherkin
# GET request
When AI "Call API GET 'https://api.example.com/users/1'"
Then AI "Verify API response status is 200"

# POST with body
When AI "Call API POST '/api/users' with body '{\"name\":\"Test User\"}'"
Then AI "Verify API response status is 201"
And AI "Verify API response contains 'success'"

# Extract response data
When AI "Get API response body" and store as "responseBody"
When AI "Get value '$.data.id' from API response" and store as "userId"

# Combine API + UI
When AI "Call API POST '/api/users' with body '{\"name\":\"Test\"}'"
And AI "Get value '$.id' from API response" and store as "userId"
And AI "Navigate to '/users/{scenario:userId}'"
Then AI "Verify the heading text is 'Test'"
```

### Example: Seed Data Before UI Test
```gherkin
# Create test data via API
When AI "Call API POST '/api/products' with body '{\"name\":\"Test Product\",\"price\":29.99}'"
Then AI "Verify API response status is 201"
And AI "Get value '$.id' from API response" and store as "productId"

# Verify in UI
When AI "Navigate to '/products'"
And AI "Type 'Test Product' in the search field"
And AI "Press Enter"
Then AI "Verify the 'Test Product' link is displayed"
```

---

## Phase 12: JavaScript Execution

### Intents
| Intent | Type | Page-Level | Description |
|--------|------|:----------:|-------------|
| `execute-js` | Action | Yes | Execute JavaScript (fire-and-forget) |
| `evaluate-js` | Query | Yes | Evaluate JavaScript and return result |

### Usage Examples

```gherkin
# Execute JavaScript
When AI "Execute JavaScript 'document.title = \"New Title\"'"
When AI "Run script 'window.scrollTo(0, document.body.scrollHeight)'"

# Evaluate and capture result
When AI "Evaluate JavaScript 'document.querySelectorAll(\"tr\").length'" and store as "rowCount"
When AI "Get JavaScript value 'window.innerWidth'" and store as "viewportWidth"
```

### Example: Handle Edge Cases
```gherkin
# Scroll to bottom of infinite scroll
When AI "Execute JavaScript 'window.scrollTo(0, document.body.scrollHeight)'"
And AI "Wait 2 seconds"
And AI "Execute JavaScript 'window.scrollTo(0, document.body.scrollHeight)'"

# Get performance timing
When AI "Evaluate JavaScript 'performance.now()'" and store as "loadTime"
```

---

## Complete Intent Reference

### Action Intents (31 total)

| Intent | Description | Page-Level |
|--------|-------------|:----------:|
| `click` | Click element | No |
| `double-click` | Double-click element | No |
| `right-click` | Right-click element | No |
| `type` / `fill` | Type text into input | No |
| `clear` | Clear input field | No |
| `select` | Select dropdown option | No |
| `check` | Check checkbox | No |
| `uncheck` | Uncheck checkbox | No |
| `toggle` | Toggle checkbox/switch | No |
| `hover` | Hover over element | No |
| `scroll` | Scroll page directionally | Yes* |
| `scroll-to` | Scroll element into view | No |
| `press-key` | Press keyboard key/combo | Yes* |
| `navigate` | Navigate to URL | Yes |
| `upload` | Upload file | No |
| `drag` | Drag element to target | No |
| `focus` | Focus element | No |
| `wait-for` | Wait for element visible/hidden | No |
| `wait-seconds` | Wait fixed time | Yes |
| `wait-url-change` | Wait for URL change | Yes |
| `wait-text-change` | Wait for text change | No |
| `switch-tab` | Switch browser tab | Yes |
| `open-new-tab` | Open new tab | Yes |
| `close-tab` | Close tab | Yes |
| `switch-browser` | Switch browser type | Yes |
| `clear-session` | Clear session for re-auth | Yes |
| `switch-frame` | Switch to iframe | Yes |
| `switch-main-frame` | Return to main frame | Yes |
| `set-variable` | Set context variable | Yes |
| `take-screenshot` | Capture screenshot | Yes |
| `clear-cookies` | Clear all cookies | Yes |
| `set-cookie` | Set a cookie | Yes |
| `clear-storage` | Clear local/session storage | Yes |
| `set-storage-item` | Set storage item | Yes |
| `api-call` | Make HTTP API request | Yes |
| `execute-js` | Execute JavaScript | Yes |

*Page-level when no target element specified

### Assertion Intents (24 total)

| Intent | Description |
|--------|-------------|
| `verify-visible` | Element is visible/displayed |
| `verify-hidden` | Element is hidden |
| `verify-text` | Element text matches (+ negated) |
| `verify-value` | Input value matches |
| `verify-enabled` | Element is enabled |
| `verify-disabled` | Element is disabled |
| `verify-checked` | Checkbox is checked |
| `verify-unchecked` | Checkbox is unchecked |
| `verify-count` | Element count matches |
| `verify-contains` | Element text contains substring |
| `verify-not-contains` | Element text does not contain |
| `verify-not-present` | Element does not exist in DOM |
| `verify-url` | Page URL matches |
| `verify-title` | Page title matches |
| `verify-attribute` | Element attribute value matches |
| `verify-css` | CSS property value matches |
| `verify-matches` | Text matches regex pattern |
| `verify-selected-option` | Dropdown selected option matches |
| `verify-dropdown-options` | Dropdown contains expected options |
| `verify-url-param` | URL parameter value matches |
| `verify-table-cell` | Table cell value matches |
| `verify-download` | File was downloaded |
| `verify-download-content` | Downloaded file contains text |
| `verify-api-response` | API response status/content matches |

### Query Intents (19 total)

| Intent | Description | Returns |
|--------|-------------|---------|
| `get-text` | Get element text content | `string` |
| `get-value` | Get input field value | `string` |
| `get-attribute` | Get element attribute | `string` |
| `get-count` | Count matching elements | `number` |
| `get-list` | Get all matching texts | `string[]` |
| `get-url` | Get current page URL | `string` |
| `get-title` | Get page title | `string` |
| `check-exists` | Check if element exists | `boolean` |
| `get-url-param` | Get URL parameter value | `string` |
| `get-table-data` | Capture entire table as JSON | `string` (JSON) |
| `get-table-cell` | Get specific table cell | `string` |
| `get-table-column` | Get all values in column | `string[]` |
| `get-table-row-count` | Count table rows | `number` |
| `generate-data` | Generate UUID/timestamp/random | `string` |
| `get-cookie` | Get cookie value | `string` |
| `get-storage-item` | Get storage item value | `string` |
| `get-download-path` | Get download file path | `string` |
| `get-api-response` | Get API response body/value | `string` |
| `evaluate-js` | Evaluate JavaScript expression | `string` |

---

## Grammar Rule Reference

### Total: ~130 grammar rules across 7 files

| File | Rules | Priority Range |
|------|:-----:|:-------------:|
| `action-grammars.ts` | 34 | 10-89, 125-127 |
| `assertion-grammars.ts` | 22 | 100-149 |
| `query-grammars.ts` | 14 | 200-254 |
| `navigation-grammars.ts` | 6 | 150-312 |
| `browser-grammars.ts` | 18 | 350-530 |
| `table-grammars.ts` | 9 | 400-449 |
| `data-grammars.ts` | 17 | 450-499 |

### Priority Resolution

When multiple grammar rules could match an instruction, the **lowest priority number wins**. This ensures more specific rules take precedence over general ones.

Example:
- `"Press Ctrl+A"` matches `action-press-key-combo` (priority 62) **before** `action-press-key` (priority 61 but less specific pattern)
- `"Verify the button CSS 'color' is 'red'"` matches `assert-css-property` (priority 131) **not** `assert-text-equals` (priority 110 but wrong pattern)

### Two-Pass Matching

1. **Pass 1**: Try grammar rules on original text (no synonym normalization)
2. **Pass 2**: If no match, normalize synonyms (tap→click, enter→type, etc.) and try again

This ensures:
- `"Press Enter"` matches `press-key` (Pass 1) — not normalized to `click Enter`
- `"Tap the Submit button"` → normalized to `click the Submit button` → matches `click` (Pass 2)
