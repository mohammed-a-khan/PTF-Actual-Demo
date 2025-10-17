# How to Run Performance Tests - Complete Guide

## ⚡ Quick Start

**Run all performance tests:**
```bash
cd /mnt/e/PTF-Demo-Project

# Method 1: Using npm script (Recommended)
npm run test -- --features=test/performance/features/

# Method 2: Direct CLI
npx cs-playwright-framework --project=orangehrm --features=test/performance/features/
```

**Run specific test type:**
```bash
# Load tests only
npm run test -- --features=test/performance/features/ --tags="@load-test"

# Core Web Vitals only
npm run test -- --features=test/performance/features/ --tags="@core-web-vitals"
```

## 🎯 How the Framework Discovers & Runs Performance Tests

The CS Playwright Test Framework has an intelligent **auto-discovery system** that finds and loads your performance test step definitions automatically.

### Discovery Mechanism

```
┌─────────────────────────────────────────────────────────────┐
│ 1. CLI Command (from package.json)                         │
│    npm run test -- --features=test/performance/features/   │
│    ↓ calls                                                  │
│    npm run cs-framework -- --features=...                  │
│    ↓ executes                                              │
│    npx cs-playwright-framework --features=...              │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. CSBDDRunner (Main Orchestrator)                         │
│    - Parses .feature files                                  │
│    - Detects required modules (API, Database, Performance) │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. CSStepLoader (Step Discovery)                           │
│    - Scans configured step paths                            │
│    - Auto-discovers step files matching patterns:           │
│      • *.steps.ts / *.steps.js                              │
│      • *Steps.ts / *Steps.js                                │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Step Registration                                        │
│    - Loads matching step files with require()               │
│    - @CSBDDStepDef decorators auto-register steps          │
│    - CSStepRegistry stores step pattern → handler mapping   │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. Test Execution                                           │
│    - Matches Gherkin steps to registered handlers           │
│    - Executes step methods                                   │
│    - Generates reports                                       │
└─────────────────────────────────────────────────────────────┘
```

## 📂 Step Discovery Configuration

The framework searches for step definitions in these locations (configured via `STEP_DEFINITIONS_PATH`):

**IMPORTANT:** Use **semicolons (;)** to separate multiple paths, NOT commas!

### Default Search Paths:
```
test/common/steps                     # Shared steps across projects
test/{project}/steps                  # Project-specific steps
test/{project}/step-definitions       # Alternative location
node_modules/@mdakhan.mak/            # Framework built-in steps
  cs-playwright-test-framework/
  dist/steps/
```

### Example Configuration (config/performance/common/common.env):
```
STEP_DEFINITIONS_PATH=test/performance/steps;test/performance/step-definitions;node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/steps
```

**Note:** Use **semicolons** to separate paths!

### For Performance Tests:
Your performance steps in `test/performance/steps/` will be automatically discovered because:
1. They match the pattern `*Steps.ts`
2. They use `@CSBDDStepDef` decorator
3. The framework scans all subdirectories

## 🚀 Running Performance Tests

**Available Commands:**
The consumer project uses `npm run test` which internally calls `npx cs-playwright-framework`:

```bash
# In package.json:
"cs-framework": "cross-env NODE_OPTIONS=\"--tls-min-v1.2\" npx cs-playwright-framework"
"test": "npm run cs-framework -- --project=orangehrm"
```

**You can run tests using either:**
1. **Via npm script (Recommended)**: `npm run test -- <options>`
2. **Direct CLI**: `npx cs-playwright-framework <options>`

### Method 1: Run All Performance Tests
```bash
cd /mnt/e/PTF-Demo-Project

# Using npm script
npm run test -- --features=test/performance/features/

# OR direct CLI
npx cs-playwright-framework --project=orangehrm --features=test/performance/features/
```

**What happens:**
- `npx cs-playwright-framework` invokes the framework CLI
- CSBDDRunner finds `orangehrm-performance.feature`
- CSStepLoader automatically discovers `OrangeHRMPerformanceSteps.ts`
- Framework loads `CSPerformanceSteps` from `/performance` entry point
- Executes all 17 scenarios

### Method 2: Run Specific Scenario by Tag
```bash
# Using npm script:

# Core Web Vitals only
npm run test -- --features=test/performance/features/orangehrm-performance.feature --tags="@core-web-vitals"

# Load tests only
npm run test -- --features=test/performance/features/orangehrm-performance.feature --tags="@load-test"

# Stress tests only
npm run test -- --features=test/performance/features/orangehrm-performance.feature --tags="@stress-test"

# Mobile performance
npm run test -- --features=test/performance/features/orangehrm-performance.feature --tags="@mobile"

# Single user tests
npm run test -- --features=test/performance/features/orangehrm-performance.feature --tags="@single-user"
```

```bash
# OR using direct CLI:

npx cs-playwright-framework --project=orangehrm --features=test/performance/features/orangehrm-performance.feature --tags="@core-web-vitals"
npx cs-playwright-framework --project=orangehrm --features=test/performance/features/orangehrm-performance.feature --tags="@load-test"
```

### Method 3: Run Specific Scenario by Name
```bash
# Using npm script
npm run test -- --features=test/performance/features/orangehrm-performance.feature --scenario="Core Web Vitals Assessment"

# OR direct CLI
npx cs-playwright-framework --project=orangehrm --features=test/performance/features/orangehrm-performance.feature --scenario="Core Web Vitals Assessment"
```

### Method 4: Run with Module Filter
```bash
# This ensures only performance-related steps are loaded

# Using npm script
npm run test -- --features=test/performance/features/ --modules=performance

# OR direct CLI
npx cs-playwright-framework --project=orangehrm --features=test/performance/features/ --modules=performance
```

## 🎨 How Step Discovery Works (Technical Details)

### 1. Feature File is Parsed
```gherkin
# File: orangehrm-performance.feature
@orangehrm-performance
Feature: OrangeHRM Application Performance Testing

  Scenario: Login Performance
    Given the OrangeHRM application is available at "..."
    When I perform a login operation
    Then the login should complete in less than 5000 milliseconds
```

### 2. Framework Extracts Step Patterns
```javascript
// Extracted patterns:
[
  "the OrangeHRM application is available at {string}",
  "I perform a login operation",
  "the login should complete in less than {int} milliseconds"
]
```

### 3. CSStepLoader Scans Directories
```javascript
// Scans these directories:
const searchPaths = [
  'test/performance/steps/',         // Your consumer steps
  'node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/steps/performance/'  // Framework steps
];

// Finds files matching:
- OrangeHRMPerformanceSteps.ts
- CSPerformanceSteps.js (from framework)
```

### 4. Files are Required (Loaded)
```javascript
// Framework executes:
require('test/performance/steps/OrangeHRMPerformanceSteps.ts');
require('node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/steps/performance/CSPerformanceSteps.js');
```

### 5. Decorators Register Steps
```typescript
// When file loads, decorators execute immediately:
export class OrangeHRMPerformanceSteps {
    @CSBDDStepDef('the OrangeHRM application is available at {string}')
    async setOrangeHRMApplicationUrl(url: string) {
        // This method gets registered in CSStepRegistry
    }
}

// CSStepRegistry now has:
// Pattern: "the OrangeHRM application is available at {string}"
// Handler: OrangeHRMPerformanceSteps.setOrangeHRMApplicationUrl
```

### 6. Steps are Matched During Execution
```javascript
// When executing scenario:
const stepText = "the OrangeHRM application is available at \"https://...\"";

// Framework matches pattern:
const matchingStep = CSStepRegistry.findMatch(stepText);
// Returns: OrangeHRMPerformanceSteps.setOrangeHRMApplicationUrl

// Executes with extracted parameters:
await matchingStep.handler("https://...");
```

## 📋 Configuration for Performance Tests

### Option 1: Using npm Scripts (Recommended)
Add these convenience scripts to your `package.json`:

```json
{
  "scripts": {
    "cs-framework": "cross-env NODE_OPTIONS=\"--tls-min-v1.2\" npx cs-playwright-framework",
    "test": "npm run cs-framework -- --project=orangehrm",
    "test:performance": "npm run cs-framework -- --project=orangehrm --features=test/performance/features/",
    "test:perf:load": "npm run cs-framework -- --project=orangehrm --features=test/performance/features/ --tags='@load-test'",
    "test:perf:stress": "npm run cs-framework -- --project=orangehrm --features=test/performance/features/ --tags='@stress-test'",
    "test:perf:vitals": "npm run cs-framework -- --project=orangehrm --features=test/performance/features/ --tags='@core-web-vitals'",
    "test:perf:mobile": "npm run cs-framework -- --project=orangehrm --features=test/performance/features/ --tags='@mobile'",
    "test:perf:smoke": "npm run cs-framework -- --project=orangehrm --features=test/performance/features/ --tags='@smoke'",
    "test:perf:single": "npm run cs-framework -- --project=orangehrm --features=test/performance/features/ --tags='@single-user'"
  }
}
```

Then run:
```bash
npm run test:performance           # All performance tests
npm run test:perf:load             # Load tests only
npm run test:perf:vitals           # Core Web Vitals only
```

**Note:** The `cs-framework` script is a wrapper around `npx cs-playwright-framework` with TLS configuration.

### Option 2: Using Configuration File
Create `config/performance-config.json`:

```json
{
  "PERFORMANCE_TARGET_URL": "https://opensource-demo.orangehrmlive.com/",
  "PERFORMANCE_METRICS_INTERVAL": 1000,
  "PERFORMANCE_SCENARIO_PAUSE": 5000,
  "PERFORMANCE_SYSTEM_MONITORING": true,
  "PERFORMANCE_RESULT_RETENTION_TIME": 300000,
  "BROWSER_REUSE_ENABLED": false,
  "SCREENSHOT_ON_STEP_FAILURE": true,
  "SELECTIVE_STEP_LOADING": true
}
```

Load it:
```bash
# Using npm script
npm run test -- --features=test/performance/features/ --env=performance

# OR direct CLI
npx cs-playwright-framework --project=orangehrm --features=test/performance/features/ --env=performance
```

## 🔍 Debugging Step Discovery

### Check What Steps Are Loaded
Add this environment variable:
```bash
# Using npm script
DEBUG_MODE=true npm run test -- --features=test/performance/features/

# OR direct CLI
DEBUG_MODE=true npx cs-playwright-framework --project=orangehrm --features=test/performance/features/
```

You'll see:
```
[StepLoader] Loading framework step definitions...
[StepLoader] Loading 1 performance step files...
[StepLoader] Loaded CSPerformanceSteps.js (45ms)
✅ Loaded 1 framework step files in 45ms
Loaded step file: test/performance/steps/OrangeHRMPerformanceSteps.ts
```

### List All Registered Steps
The framework logs registered steps during execution. Look for:
```
[BDD] Registered step: "the OrangeHRM application is available at {string}"
[BDD] Registered step: "I have valid OrangeHRM credentials {string} and {string}"
...
```

### Verify Step Matching
If a step is not found, you'll see:
```
❌ No step definition found for: "I perform some unknown operation"

Available steps:
- the OrangeHRM application is available at {string}
- I have valid OrangeHRM credentials {string} and {string}
- I perform a login operation
...
```

## 🎯 Complete Example

### 1. Create Feature File
```bash
# Already exists: test/performance/features/orangehrm-performance.feature
```

### 2. Create Step Definitions
```bash
# Already exists: test/performance/steps/OrangeHRMPerformanceSteps.ts
```

### 3. Run Tests
```bash
cd /mnt/e/PTF-Demo-Project

# Install dependencies (if not done)
npm install

# Run all performance tests (using npm script)
npm run test -- --features=test/performance/features/

# Or run specific scenario
npm run test -- --features=test/performance/features/orangehrm-performance.feature --tags="@load-test"

# Direct CLI alternative (if you prefer)
npx cs-playwright-framework --project=orangehrm --features=test/performance/features/
npx cs-playwright-framework --project=orangehrm --features=test/performance/features/orangehrm-performance.feature --tags="@load-test"
```

### 4. View Reports
```bash
# Reports are generated in:
open reports/html-report.html          # HTML report with Performance tab
open reports/test-results.json         # JSON results
open reports/enterprise-dashboard.html # Enterprise dashboard
```

## 🚨 Troubleshooting

### Issue: Steps Not Found
**Symptom:** `No step definition found for: "..."`

**Solution:**
1. Check step file naming: Must end with `Steps.ts` or `.steps.ts`
2. Verify decorator is used: `@CSBDDStepDef('pattern')`
3. Check step pattern matches Gherkin text exactly
4. Ensure file is in configured step paths

### Issue: Module Not Loaded
**Symptom:** `Cannot find module '@mdakhan.mak/cs-playwright-test-framework/performance'`

**Solution:**
```bash
# Re-install framework
npm install @mdakhan.mak/cs-playwright-test-framework@latest

# Verify installation
ls node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/lib/performance.js
```

### Issue: TypeScript Errors
**Symptom:** `error TS2307: Cannot find module`

**Solution:**
```bash
# Rebuild framework (if in development)
cd /mnt/e/PTF-ADO
npm run build

# Or in consumer project
cd /mnt/e/PTF-Demo-Project
npx tsc --noEmit  # Check for errors
```

## 📊 Expected Output

When you run performance tests, you should see:

```
🚀 CS Playwright Test Framework
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[StepLoader] Loading framework step definitions...
✅ Loaded 1 framework step files in 45ms
Loaded step file: test/performance/steps/OrangeHRMPerformanceSteps.ts

Feature: OrangeHRM Application Performance Testing

  @orangehrm-performance @load-test @multi-user
  Scenario: Multiple User Login Performance Test
    ✓ Given the OrangeHRM application is available at "https://..."
    ✓ And I have valid OrangeHRM credentials "Admin" and "admin123"
    ✓ And I have a UI load test with 5 concurrent users for OrangeHRM
    ✓ And I set the test duration to 60 seconds
    ✓ When I execute the load test
    ✓ Then the success rate should be at least 95 percent
    ✓ And the average login time should be less than 6000 milliseconds

Test Results:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Passed: 17 scenarios
❌ Failed: 0 scenarios
⏭️  Skipped: 0 scenarios
⏱️  Duration: 5m 23s

Reports generated:
  📄 reports/html-report.html
  📊 reports/test-results.json
  📈 reports/enterprise-dashboard.html
```

## 🎓 Key Takeaways

1. **CLI Command**: Use `npx cs-playwright-framework` or the npm script `npm run test`
2. **Auto-Discovery**: Framework automatically finds step files - no manual registration needed
3. **Decorator-Based**: Steps are registered via `@CSBDDStepDef` decorator when file loads
4. **Pattern Matching**: Framework matches Gherkin text to registered patterns
5. **Selective Loading**: Only loads steps needed for your features (faster startup)
6. **No Special Config**: Just follow naming conventions (`*Steps.ts`) and it works

## 📦 Framework CLI Binaries

The framework package (`@mdakhan.mak/cs-playwright-test-framework`) provides two CLI binaries:
- `cs-playwright-framework` - Main CLI entry point
- `cs-playwright-test` - Alternative alias

Both point to the same executable: `dist/index.js`

**Consumer project npm scripts:**
```json
{
  "cs-framework": "cross-env NODE_OPTIONS=\"--tls-min-v1.2\" npx cs-framework",
  "test": "npm run cs-framework -- --project=orangehrm"
}
```

**Note:** The `npx cs-framework` command in the consumer project uses a globally installed alias from a previous framework version. For new setups, use `npx cs-playwright-framework` directly or create the npm script wrapper as shown above.

## 🔗 Related Documentation

- Main README: `/mnt/e/PTF-Demo-Project/test/performance/README.md`
- Framework Setup: `/mnt/e/PTF-ADO/PERFORMANCE_MODULE_SETUP.md`
- Step Definitions: `/mnt/e/PTF-Demo-Project/test/performance/steps/`
- Feature Files: `/mnt/e/PTF-Demo-Project/test/performance/features/`

---

**The framework is intelligent - you write steps, it finds and runs them automatically!** ✨
