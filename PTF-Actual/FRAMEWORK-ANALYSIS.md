# CS PLAYWRIGHT TEST FRAMEWORK - ENCYCLOPEDIA

This document provides COMPLETE technical documentation of every component.

---

## TABLE OF CONTENTS

### Part 1: Core Framework Architecture
1. Entry Point & CLI (`src/index.ts`)
2. Configuration System (`CSConfigurationManager`)
3. Module Detection (`CSModuleDetector`)
4. Step Loading System (`CSStepLoader`)

### Part 2: BDD Implementation
5. BDD Engine (`CSBDDEngine` - Gherkin Parser)
6. BDD Runner (`CSBDDRunner` - Test Executor)
7. Step Registry (`CSStepRegistry`)
8. Decorators (`CSBDDDecorators`)

### Part 3: Page Object Model
9. Base Page (`CSBasePage`)
10. Page Factory (`CSPageFactory`)
11. Element System (`CSWebElement`)

### Part 4: Browser Management
12. Browser Manager (`CSBrowserManager`)
13. Browser Pool
14. Context Management

### Part 5: Data & API Testing
15. Data Provider (`CSDataProvider`)
16. API Client (`CSAPIClient`)
17. HTTP Client (`CSHttpClient`)

### Part 6: Database Testing
18. Database Manager (`CSDatabaseManager`)
19. Database Adapters (MySQL, PostgreSQL, etc.)

### Part 7: Reporting & Monitoring
20. Reporter System (`CSReporter`)
21. HTML Reporter (`CSHTMLReporter`)
22. Test Results Manager

### Part 8: Parallel Execution
23. Worker Manager
24. Parallel Orchestrator

---

# PART 1: CORE FRAMEWORK ARCHITECTURE

## 1. Entry Point - src/index.ts

**Purpose**: CLI entry point that orchestrates framework initialization and execution.

**File Size**: 347 lines

### Imports Strategy
```typescript
// PERFORMANCE OPTIMIZATION: Only minimist imported at top level
import minimist from 'minimist';
// All other imports are LAZY LOADED inside functions
```

**Why**: Importing modules like CSBDDRunner triggers loading of entire dependency chain (Playwright, database drivers, etc.) adding 20-25 seconds to startup. Lazy loading reduces startup to <1 second.

### Key Functions

#### `main()` - Lines 78-163
**Purpose**: Main entry point

**Process Flow**:
1. Parse CLI args with minimist
2. Handle `--help` and `--version` flags (no module loading)
3. Lazy load `CSConfigurationManager`
4. Initialize configuration (<100ms target)
5. Determine execution mode (bdd/api/database)
6. Load only required modules (<200ms target)
7. Execute tests

**Performance Tracking**:
```typescript
const startTime = Date.now();
// ... initialization ...
const totalStartupTime = Date.now() - startTime;
if (totalStartupTime < 1000) {
    CSReporter.debug(`⚡ Lightning-fast startup: ${totalStartupTime}ms`);
}
```

#### `determineExecutionMode(args, config)` - Lines 165-183
**Returns**: 'bdd' | 'api' | 'database'

**Logic**:
1. If `args.feature` or `config.get('FEATURES')` → 'bdd'
2. If `args.api` or `config.get('API_TESTS')` → 'api'
3. If `args.db` or `config.get('DB_TESTS')` → 'database'
4. Default → 'bdd'

#### `loadRequiredModules(mode, config)` - Lines 185-207
**Purpose**: Conditionally load modules based on mode

**Critical Logic** (Lines 191-194):
```typescript
if (lazyLoading) {
    console.log(`[PERF] Lazy loading enabled - skipping module preload`);
    return;  // Don't preload ANY modules
}
```

When `LAZY_LOADING=true` (default), modules load on-demand.

#### `execute(mode)` - Lines 209-332
**Purpose**: Execute tests based on mode

**BDD Mode Process** (Lines 217-312):
1. Lazy load `CSBDDRunner` with timing
2. Get singleton instance
3. Build options object from CLI args:
   - `--project` → `options.project`
   - `--features` → `options.features` + set in config
   - `--tags` → `options.tags` + set in config
   - `--headless` → `options.headless` + set in config
   - `--browser` → `options.browser` + set in config
   - `--modules` → `options.modules` + set in config
   - `--parallel` / `--workers` → `options.parallel` (number of workers)
   - `--retry` → `options.retry` + set in config
   - `--env` → `options.env` + set in config
4. Call `runner.run(options)`

**Parallel Execution Logic** (Lines 274-296):
```typescript
if (args.parallel !== undefined || args.workers !== undefined) {
    const workerCount = args.workers ? parseInt(args.workers) : 3;

    if (args.parallel === true || args.parallel === 'true') {
        options.parallel = workerCount;  // Use worker count
    } else if (typeof args.parallel === 'number') {
        options.parallel = args.parallel;  // Use specific number
    }

    config.set('PARALLEL', String(options.parallel));
    config.set('MAX_PARALLEL_WORKERS', String(workerCount));
}
```

### Exports
```typescript
export { main };
```

**Usage**: Can be imported and called programmatically:
```typescript
import { main } from 'cs-playwright-test-framework';
await main();
```

### Binary Commands
From `package.json`:
```json
"bin": {
  "cs-playwright-run": "dist/index.js",
  "cs-playwright-framework": "dist/index.js"
}
```

Both commands execute the same entry point.

---

## 2. Configuration System - CSConfigurationManager

**File**: `src/core/CSConfigurationManager.ts` (473 lines)

### Architecture

**Pattern**: Singleton
**Purpose**: 7-level hierarchical configuration with interpolation, encryption, and validation

**Hierarchy** (Lines 8-17):
```
Level 1 (Highest)  → CLI arguments (--headless=true)
Level 2            → Environment variables (process.env.HEADLESS)
Level 3            → config/{project}/environments/{env}.env
Level 4            → config/{project}/common/common.env
Level 5            → config/common/environments/{env}.env
Level 6            → config/common/common.env
Level 7 (Lowest)   → config/global.env
```

### Properties

```typescript
private static instance: CSConfigurationManager;   // Singleton
private config: Map<string, string> = new Map();   // Key-value store
private encryptionUtil: CSEncryptionUtil;           // Decrypts ENCRYPTED: values
private loadStartTime: number = Date.now();         // Performance tracking
```

### Complete Method Reference

#### Core Methods

**`static getInstance(): CSConfigurationManager`** - Lines 28-33
- Returns singleton instance
- Creates on first call
- Thread-safe (single Node.js thread)

**`async initialize(args: any = {}): Promise<void>`** - Lines 35-84
- **Purpose**: Load all configuration levels
- **Process**:
  1. Determine project: `args.project || process.env.PROJECT || 'common'`
  2. Determine environment: `args.env || process.env.ENVIRONMENT || 'dev'`
  3. Load files in reverse priority (lowest first):
     ```typescript
     await this.loadConfig('config/global.env', 'Global defaults');
     await this.loadConfig('config/common/common.env', 'Common config');
     await this.loadAllEnvFilesFromDirectory('config/common', 'Common configs');
     await this.loadConfig(`config/common/environments/${environment}.env`, 'Common environment');
     await this.loadConfig(`config/${project}/common/common.env`, 'Project common');
     await this.loadAllEnvFilesFromDirectory(`config/${project}/common`, 'Project common configs');
     await this.loadConfig(`config/${project}/environments/${environment}.env`, 'Project environment');
     await this.loadAllEnvFilesFromDirectory(`config/${project}`, 'Project configs', true);
     this.loadEnvironmentVariables();  // Level 2
     this.loadCommandLineArgs(args);   // Level 1
     ```
  4. Perform interpolation: `performAdvancedInterpolation()`
  5. Decrypt values: `decryptValues()`
  6. Warn if >100ms

**`private async loadConfig(filePath, description): Promise<void>`** - Lines 86-104
- Resolves path with `path.join(process.cwd(), filePath)`
- Checks file exists with `fs.existsSync()`
- Parses with `dotenv.parse(fs.readFileSync(fullPath))`
- Sets each entry in Map
- **Special handling**: `LOG_LEVEL` set to `process.env` immediately for CSReporter

**`private async loadAllEnvFilesFromDirectory(dirPath, description, excludeSubdirs): Promise<void>`** - Lines 106-143
- Reads all files in directory
- Filters: `file.endsWith('.env') && file !== 'common.env'`
- If `excludeSubdirs=true`: Skips 'common' and 'environments' subdirectories
- Sorts files alphabetically for consistency
- Loads each file with `loadConfig()`

**`private loadEnvironmentVariables(): void`** - Lines 145-151
- Iterates `Object.entries(process.env)`
- Sets each in Map (overrides file-based config)

**`private loadCommandLineArgs(args): void`** - Lines 153-163
- Converts keys to uppercase: `key.toUpperCase().replace(/-/g, '_')`
- Stores both original and uppercase keys
- **Example**: `--headless` → `HEADLESS` and `headless`

#### Interpolation System

**`private performAdvancedInterpolation(): void`** - Lines 166-183
- Iterates up to 10 times to resolve nested variables
- Calls `interpolateAdvanced()` for each value
- Stops when no more changes

**`private interpolateAdvanced(str): string`** - Lines 185-219
Supports multiple syntaxes:

1. **`{VARIABLE}`** - Lines 189-196
   ```typescript
   str.replace(/{([^}]+)}/g, (match, variable) => {
       if (variable.includes(':')) {
           return this.handleComplexVariable(variable);
       }
       return this.config.get(variable) || this.config.get(variable.toUpperCase()) || match;
   })
   ```

2. **`${VAR:-default}`** - Lines 199-211
   ```typescript
   str.replace(/\${([^}]+)}/g, (match, envVar) => {
       const [varName, defaultValue] = envVar.split(':-');
       const configValue = this.config.get(varName) || this.config.get(varName.toUpperCase());
       if (configValue) return configValue;
       return process.env[varName] || defaultValue || match;
   })
   ```

3. **`<placeholder>`** - Lines 213-216
   ```typescript
   str.replace(/<([^>]+)>/g, (match, placeholder) => {
       return this.handleDynamicPlaceholder(placeholder) || match;
   })
   ```

**`private handleComplexVariable(variable): string`** - Lines 221-257
Supports:
- `{env:VAR}` - Environment variable
- `{config:KEY}` - Config value
- `{ternary:condition?true:false}` - Conditional
- `{concat:VAR1+VAR2+VAR3}` - Concatenation
- `{upper:VAR}` - Uppercase
- `{lower:VAR}` - Lowercase

**`private handleDynamicPlaceholder(placeholder): string`** - Lines 259-288
Supports:
- `<random>` - Random string
- `<timestamp>` - Current timestamp
- `<uuid>` - UUID v4
- `<date:format>` - Formatted date
- `<env:VAR>` - Environment variable
- `<generate:type>` - Generated value (email, phone, username, password)

#### Decryption

**`private decryptValues(): void`** - Lines 340-353
- Iterates all config values
- If starts with `ENCRYPTED:`, calls `encryptionUtil.decrypt(value)`
- Replaces encrypted value with decrypted

**`public encrypt(value): string`** - Lines 460-462
- Public API for encrypting values
- Returns `ENCRYPTED:...` format

####  Public Getter/Setter Methods

**`get(key, defaultValue = ''): string`** - Lines 356-358
- Tries exact key, then uppercase
- Returns defaultValue if not found

**`set(key, value): void`** - Lines 360-363
- Sets both exact key and uppercase version

**`getNumber(key, defaultValue = 0): number`** - Lines 365-368
- Gets value, parses with `parseInt(value, 10)`

**`getBoolean(key, defaultValue = false): boolean`** - Lines 370-374
- Checks: `'true' | '1' | 'yes'` (case-insensitive)

**`getArray(key, delimiter = ';'): string[]`** - Lines 376-379
**`getList(key, delimiter = ';'): string[]`** - Lines 381-383
- Splits string by delimiter, trims each

**`getJSON(key, defaultValue = {}): any`** - Lines 385-393
- Parses JSON, returns default on error

**`has(key): boolean`** - Lines 395-397
- Checks Map has key (case-insensitive)

**`getAll(): Map<string, string>`** - Lines 399-401
- Returns copy of entire config Map

#### Validation

**`validate(schema): void`** - Lines 403-457
Schema structure:
```typescript
{
    required?: string[];
    types?: Record<string, 'string'|'number'|'boolean'|'array'|'json'>;
    validators?: Record<string, (value: any) => boolean>;
}
```

**Example**:
```typescript
config.validate({
    required: ['BASE_URL', 'BROWSER'],
    types: {
        TIMEOUT: 'number',
        HEADLESS: 'boolean',
        TAGS: 'array'
    },
    validators: {
        BROWSER: (v) => ['chrome','firefox','webkit'].includes(v)
    }
});
```

#### Debug Helper

**`debug(): void`** - Lines 465-472
- Prints config summary to console
- Shows: Total count, key configurations

### Usage Patterns

**Basic Usage**:
```typescript
const config = CSConfigurationManager.getInstance();
await config.initialize(minimistArgs);
const url = config.get('BASE_URL');
const timeout = config.getNumber('TIMEOUT', 30000);
const isHeadless = config.getBoolean('HEADLESS', false);
```

**Variable Interpolation**:
```env
PROJECT=myapp
ENVIRONMENT=dev
BASE_URL=https://{PROJECT}-{ENVIRONMENT}.example.com
# Resolves to: https://myapp-dev.example.com
```

**Encryption**:
```env
DB_PASSWORD=ENCRYPTED:eyJlbmNyeXB0ZWQi...
```

### Best Practices (from code)

1. **Performance**: Target <100ms for initialization
2. **Case-Insensitive**: Always stores both original and uppercase keys
3. **Lazy Loading**: Don't load CSReporter at top level (uses console.log instead)
4. **Validation**: Validate required configs early in startup
5. **Interpolation**: Max 10 iterations to prevent infinite loops

---

## 3. Module Detection System - CSModuleDetector

**File**: `src/core/CSModuleDetector.ts` (363 lines)

### Architecture

**Pattern**: Singleton with Worker-Aware Instance Management
**Purpose**: Intelligently detect which modules (browser, API, database, SOAP) are required for test scenarios

**Key Innovation**: Analyzes tags and step text patterns to avoid launching unnecessary modules (e.g., don't launch browser for API-only tests)

### Type Definitions

```typescript
export interface ModuleRequirements {
    browser: boolean;
    api: boolean;
    database: boolean;
    soap: boolean;
}

export type DetectionMode = 'auto' | 'explicit' | 'hybrid';
```

### Properties

```typescript
private static instance: CSModuleDetector;                    // Main thread instance
private static workerInstances: Map<number, CSModuleDetector>; // Per-worker instances
private config: CSConfigurationManager;                        // Configuration access

// Tag to module mapping (Lines 33-44)
private readonly TAG_MAPPING: Record<string, keyof ModuleRequirements> = {
    '@ui': 'browser',
    '@browser': 'browser',
    '@web': 'browser',
    '@api': 'api',
    '@rest': 'api',
    '@http': 'api',
    '@database': 'database',
    '@db': 'database',
    '@sql': 'database',
    '@soap': 'soap'
};

// Step pattern regex for implicit detection (Lines 51-107)
private readonly STEP_PATTERNS: Record<keyof ModuleRequirements, RegExp[]>;
```

### Step Pattern Detection (Lines 51-107)

**Browser Patterns** - Detects UI testing:
```typescript
browser: [
    // Navigation - flexible subject
    /(?:I|user|users|we|they|he|she)\s+navigate/i,
    /(?:I|user|users|we|they|he|she)\s+(?:go|goes)\s+to/i,
    /(?:I|user|users|we|they|he|she)\s+(?:am|is|are)\s+on\s+.*page/i,

    // Interaction
    /(?:I|user|users|we|they|he|she)\s+click/i,
    /(?:I|user|users|we|they|he|she)\s+(?:enter|type|input)/i,
    /(?:I|user|users|we|they|he|she)\s+select/i,
    /(?:I|user|users|we|they|he|she)\s+(?:wait|scroll|hover|press)/i,

    // Verification
    /(?:I|user|users|we|they|he|she)\s+should\s+(?:see|not see)/i,
    /(?:I|user|users|we|they|he|she)\s+should\s+(?:still be|NOT be)\s+logged in/i,

    // Element/Browser keywords
    /(?:switch|close|open).*browser/i,
    /the\s+(?:page|element|button|link|input|dropdown|checkbox|radio|tab|window)/i,
    /(?:browser|webpage|current\s+page)/i
]
```

**Why Flexible Patterns?**: Supports multiple subjects ("I navigate", "user navigates", "we click") for natural language variations.

**API Patterns** - Detects API testing:
```typescript
api: [
    // HTTP methods
    /(?:I|user|users|we|they|he|she)\s+send.*(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+request/i,
    /(?:I|user|users|we|they|he|she)\s+(?:call|invoke).*(?:API|endpoint)/i,
    /(?:I|user|users|we|they|he|she)\s+set.*(?:header|query parameter|body|authentication)/i,

    // Response validation
    /(?:the\s+)?response\s+(?:status|code|body)/i,
    /(?:the\s+)?(?:JSON|XML)\s+response/i,
    /status\s+code\s+should/i,

    // Keywords
    /\b(?:API|REST|HTTP|endpoint)\b/i,
    /request\s+to\s+[/\"']/i
]
```

**Database Patterns** - Detects database testing:
```typescript
database: [
    // Connection
    /(?:I|user|users|we|they|he|she)\s+connect.*(?:to\s+)?database/i,
    /(?:I|user|users|we|they|he|she)\s+(?:disconnect|close).*database/i,

    // Query execution
    /(?:I|user|users|we|they|he|she)\s+(?:execute|run).*query/i,
    /(?:I|user|users|we|they|he|she)\s+execute.*stored\s+procedure/i,

    // Transactions
    /(?:I|user|users|we|they|he|she)\s+(?:begin|start).*transaction/i,
    /(?:I|user|users|we|they|he|she)\s+(?:commit|rollback).*transaction/i,

    // SQL Keywords
    /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE)\b.*\b(?:FROM|INTO|TABLE|DATABASE)\b/i,
    /\b(?:SQL|database|query\s+result|stored\s+procedure)\b/i,
    /(?:the\s+)?(?:database|table|query)/i
]
```

**SOAP Patterns** - Detects SOAP testing:
```typescript
soap: [
    /(?:I|user|users|we|they|he|she)\s+send.*SOAP/i,
    /(?:I|user|users|we|they|he|she)\s+(?:call|invoke).*(?:web\s+service|SOAP\s+service)/i,
    /\b(?:SOAP|WSDL|web\s+service)\b/i
]
```

### Methods

#### `static getInstance(): CSModuleDetector` - Lines 119-134
**Purpose**: Worker-aware singleton

**Logic**:
```typescript
// Check if running in worker thread
if (typeof process !== 'undefined' && process.env.WORKER_ID) {
    const workerId = parseInt(process.env.WORKER_ID);
    if (!CSModuleDetector.workerInstances.has(workerId)) {
        CSModuleDetector.workerInstances.set(workerId, new CSModuleDetector());
    }
    return CSModuleDetector.workerInstances.get(workerId)!;
}

// Main thread singleton
if (!CSModuleDetector.instance) {
    CSModuleDetector.instance = new CSModuleDetector();
}
return CSModuleDetector.instance;
```

**Why?**: Each worker process needs its own instance to avoid state conflicts in parallel execution.

#### `detectRequirements(scenario, feature): ModuleRequirements` - Lines 149-220
**Purpose**: Main detection logic with priority-based resolution

**Priority Order**:
1. **Explicit MODULES config/CLI** (Lines 153-162)
   ```typescript
   const explicitModules = this.config.get('MODULES', '').trim();
   if (explicitModules) {
       return this.parseExplicitModules(explicitModules);
   }
   ```

2. **Feature Flag Check** (Lines 165-174)
   ```typescript
   const enabled = this.config.getBoolean('MODULE_DETECTION_ENABLED', true);
   if (!enabled) {
       return { browser: true, api: false, database: false, soap: false };
   }
   ```

3. **Detection Mode** (Lines 176-206)
   ```typescript
   const mode = this.config.get('MODULE_DETECTION_MODE', 'hybrid') as DetectionMode;

   switch (mode) {
       case 'explicit':
           // Only use tags, no pattern detection
           requirements = this.detectFromTags(allTags);
           break;

       case 'auto':
           // Only use patterns, ignore tags
           requirements = this.detectFromSteps(scenario.steps || []);
           break;

       case 'hybrid':
       default:
           // Tags first (explicit), then patterns (implicit) as fallback
           const tagRequirements = this.detectFromTags(allTags);
           const hasExplicitTags = Object.values(tagRequirements).some(v => v === true);

           if (hasExplicitTags) {
               requirements = tagRequirements;
           } else {
               requirements = this.detectFromSteps(scenario.steps || []);
           }
           break;
   }
   ```

4. **Logging** (Lines 208-217)
   ```typescript
   if (this.config.getBoolean('MODULE_DETECTION_LOGGING', false)) {
       const workerId = process.env.WORKER_ID ? `Worker ${process.env.WORKER_ID}` : 'Main';
       const modules = Object.entries(requirements)
           .filter(([_, enabled]) => enabled)
           .map(([module]) => module)
           .join(', ') || 'none';

       CSReporter.debug(`[${workerId}] Module Detection (${mode}): ${modules} | Scenario: ${scenario.name}`);
   }
   ```

#### `private detectFromTags(tags): ModuleRequirements` - Lines 225-244
**Purpose**: Explicit tag-based detection

**Process**:
```typescript
const requirements: ModuleRequirements = {
    browser: false, api: false, database: false, soap: false
};

for (const tag of tags) {
    const normalizedTag = tag.toLowerCase().trim();

    // Check exact matches
    for (const [tagPattern, module] of Object.entries(this.TAG_MAPPING)) {
        if (normalizedTag === tagPattern) {
            requirements[module] = true;
        }
    }
}

return requirements;
```

**Example**:
- Tags: `@ui @smoke` → `{ browser: true, api: false, database: false, soap: false }`
- Tags: `@api @database` → `{ browser: false, api: true, database: true, soap: false }`

#### `private detectFromSteps(steps): ModuleRequirements` - Lines 250-278
**Purpose**: Pattern-based implicit detection

**Process**:
```typescript
const requirements: ModuleRequirements = {
    browser: false, api: false, database: false, soap: false
};

for (const step of steps) {
    const stepText = `${step.keyword || ''} ${step.text || ''}`.trim();

    // Check each module's patterns
    for (const [module, patterns] of Object.entries(this.STEP_PATTERNS)) {
        if (this.matchesAnyPattern(stepText, patterns)) {
            requirements[module as keyof ModuleRequirements] = true;
        }
    }
}

// Default to browser if no patterns matched (backward compatibility)
const hasAnyMatch = Object.values(requirements).some(v => v === true);
if (!hasAnyMatch) {
    const defaultToBrowser = this.config.getBoolean('MODULE_DETECTION_DEFAULT_BROWSER', true);
    if (defaultToBrowser) {
        requirements.browser = true;
    }
}

return requirements;
```

**Example**:
- Step: "When user sends GET request to /api/users"
  → `{ browser: false, api: true, database: false, soap: false }`
- Step: "When I navigate to the login page"
  → `{ browser: true, api: false, database: false, soap: false }`

#### `private matchesAnyPattern(text, patterns): boolean` - Lines 284-286
```typescript
return patterns.some(pattern => pattern.test(text));
```

Simple helper to test if text matches any regex in array.

#### `private parseExplicitModules(moduleSpec): ModuleRequirements` - Lines 300-338
**Purpose**: Parse CLI/config module specification

**Supported Formats**:
```typescript
// Single module
--modules=api          → { browser: false, api: true, database: false, soap: false }

// Multiple modules (comma-separated)
--modules=api,database → { browser: false, api: true, database: true, soap: false }

// All modules
--modules=ui,api,database,soap → { browser: true, api: true, database: true, soap: true }
```

**Aliases Supported**:
```typescript
switch (module) {
    case 'ui':
    case 'browser':
    case 'web':
        requirements.browser = true;
        break;
    case 'api':
    case 'rest':
    case 'http':
        requirements.api = true;
        break;
    case 'database':
    case 'db':
    case 'sql':
        requirements.database = true;
        break;
    case 'soap':
    case 'wsdl':
        requirements.soap = true;
        break;
    default:
        CSReporter.warn(`Unknown module in MODULES specification: "${module}". Valid: ui, api, database, soap`);
}
```

#### `getRequirementsSummary(requirements): string` - Lines 343-349
**Purpose**: Human-readable summary

**Example**:
```typescript
{ browser: true, api: true, database: false, soap: false }
→ "browser, api"
```

#### `isBrowserRequired(requirements): boolean` - Lines 355-362
**Purpose**: Check if browser should launch

**Logic**:
```typescript
// Check for override
if (this.config.getBoolean('BROWSER_ALWAYS_LAUNCH', false)) {
    return true;
}

return requirements.browser;
```

**Use Case**: Force browser launch even for API tests (for debugging).

### Configuration Properties

| Property | Default | Purpose |
|----------|---------|---------|
| `MODULE_DETECTION_ENABLED` | `true` | Enable/disable intelligent detection |
| `MODULE_DETECTION_MODE` | `hybrid` | Detection strategy: auto/explicit/hybrid |
| `MODULE_DETECTION_DEFAULT_BROWSER` | `true` | Launch browser when no patterns match |
| `MODULE_DETECTION_LOGGING` | `false` | Log detection decisions |
| `BROWSER_ALWAYS_LAUNCH` | `false` | Override detection, always launch browser |
| `MODULES` | `""` | Explicit module specification (CLI: `--modules=api,database`) |

### Usage Scenarios

**Scenario 1: API-Only Testing**
```gherkin
@api
Scenario: Test user API endpoint
  When user sends GET request to "/api/users"
  Then response status should be 200
```
**Detection**: `{ browser: false, api: true, database: false, soap: false }`
**Result**: No browser launched, saves ~2 seconds

**Scenario 2: Database-Only Testing**
```gherkin
@database
Scenario: Verify user data in database
  When user connects to 'MAIN' database
  And user executes query "SELECT * FROM users WHERE id = 1"
  Then query should return 1 row
```
**Detection**: `{ browser: false, api: false, database: true, soap: false }`
**Result**: No browser launched

**Scenario 3: Hybrid Testing**
```gherkin
@ui @api
Scenario: E2E user registration
  When user navigates to "/register"
  And user fills registration form
  And user submits form
  Then user sends GET request to "/api/users/me"
  And response should contain user email
```
**Detection**: `{ browser: true, api: true, database: false, soap: false }`
**Result**: Both browser and API client initialized

**Scenario 4: Pattern-Based Detection (No Tags)**
```gherkin
Scenario: Login test
  When user navigates to "/login"
  And user enters username "test@example.com"
  And user clicks login button
  Then user should see dashboard
```
**Detection**: Analyzes step text:
- "navigates to" → matches browser pattern
- "enters" → matches browser pattern
- "clicks" → matches browser pattern
**Result**: `{ browser: true, api: false, database: false, soap: false }`

**Scenario 5: Explicit Module Specification (CLI)**
```bash
npm run cs-framework -- --project=myproject --modules=api
```
**Result**: Ignores tags and patterns, only loads API module

### Best Practices (from code analysis)

1. **Use Explicit Tags for Clarity**
   ```gherkin
   @api
   Scenario: API test
   ```
   Better than relying on pattern detection.

2. **Hybrid Mode is Default**
   - Tags take precedence (explicit intent)
   - Falls back to patterns (implicit detection)
   - Most flexible approach

3. **Enable Logging During Development**
   ```env
   MODULE_DETECTION_LOGGING=true
   ```
   See which modules are detected for each scenario.

4. **Override for Debugging**
   ```env
   BROWSER_ALWAYS_LAUNCH=true
   ```
   Force browser launch even for API tests (useful for debugging).

5. **CLI Override for Quick Testing**
   ```bash
   # Test only API, ignore all tags
   npm test -- --modules=api
   ```

6. **Worker-Safe Design**
   - Each worker gets its own detector instance
   - No shared state conflicts in parallel execution

### Performance Impact

**Without Module Detection**:
- Every scenario launches browser (~2 seconds)
- 100 API scenarios = 200 seconds wasted on browser launches

**With Module Detection**:
- API-only scenarios skip browser
- 100 API scenarios = 0 seconds on browser launches
- **Savings**: ~200 seconds (3+ minutes) on test suite

### Integration Points

**Used By**:
1. `CSBDDRunner.run()` - Before executing scenarios
2. `CSStepLoader.loadRequiredSteps()` - To determine which step groups to load
3. `parallel-orchestrator.ts` - Worker initialization

**Depends On**:
1. `CSConfigurationManager` - For config values
2. `CSReporter` - For logging decisions

---

TO BE CONTINUED... (Completed 3/20+ components. Next: CSStepLoader)

## 4. Step Loading System - CSStepLoader

**File**: `src/core/CSStepLoader.ts` (717 lines)

### Architecture

**Pattern**: Worker-Aware Singleton with Caching
**Purpose**: Selectively load only required step definition files to optimize startup time and memory

**Key Innovation**: Three-tier loading optimization:
1. **Group-Level**: Load only modules needed (api/database/soap/browser)
2. **File-Level**: Within a module, load only files with required steps
3. **Convention-Based**: Match feature file paths to step file paths

### Type Definitions

```typescript
export type StepGroup = 'common' | 'api' | 'database' | 'soap' | 'browser';
```

### Properties

```typescript
private static instance: CSStepLoader;                           // Main thread instance
private static workerInstances: Map<number, CSStepLoader>;       // Per-worker instances
private loadedGroups: Set<StepGroup> = new Set();                // Cache of loaded groups
private config: CSConfigurationManager;                           // Configuration access
private frameworkRoot: string;                                    // Framework installation path

// Step definition file groups (Lines 31-65)
private readonly STEP_GROUPS: Record<StepGroup, string[]> = {
    common: ['src/steps/common/CSCommonSteps.ts'],
    api: [
        'src/steps/api/CSAPIRequestSteps.ts',
        'src/steps/api/CSAPIRequestExecutionSteps.ts',
        'src/steps/api/CSAPIResponseValidationSteps.ts',
        'src/steps/api/CSAPIValidationSteps.ts',
        'src/steps/api/CSAPIRequestBodySteps.ts',
        'src/steps/api/CSAPIRequestHeaderSteps.ts',
        'src/steps/api/CSAPIRequestConfigSteps.ts',
        'src/steps/api/CSAPIAuthenticationSteps.ts',
        'src/steps/api/CSAPIUtilitySteps.ts',
        'src/steps/api/CSAPIChainingSteps.ts',
        'src/steps/api/CSAPIGenericSteps.ts'
    ],
    database: [
        'src/steps/database/CSDatabaseAPISteps.ts',
        'src/steps/database/QueryExecutionSteps.ts',
        'src/steps/database/StoredProcedureSteps.ts',
        'src/steps/database/DatabaseGenericSteps.ts',
        'src/steps/database/ConnectionSteps.ts',
        'src/steps/database/TransactionSteps.ts',
        'src/steps/database/DataValidationSteps.ts',
        'src/steps/database/DatabaseUtilitySteps.ts'
    ],
    soap: ['src/steps/soap/CSSoapSteps.ts'],
    browser: []  // Browser steps in common group
};
```

### Methods

#### `private detectFrameworkRoot(): string` - Lines 80-118
**Purpose**: Auto-detect framework installation location

**Logic**:
```typescript
// 1. Check if in dist/core (compiled framework)
if (thisFileDir.includes('dist/core')) {
    const frameworkRoot = path.resolve(thisFileDir, '../..');  // Go up 2 levels
    const packageJsonPath = path.join(frameworkRoot, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath));
        if (pkg.name === 'cs-playwright-test-framework') {
            return frameworkRoot;
        }
    }
}

// 2. Try to resolve from node_modules
const frameworkPackagePath = require.resolve('cs-playwright-test-framework/package.json');
return path.dirname(frameworkPackagePath);

// 3. Fallback to cwd (development mode)
return process.cwd();
```

**Why Important**: Framework can be:
- Installed in node_modules
- Linked locally during development
- Run from source

#### `static getInstance(): CSStepLoader` - Lines 124-139
Worker-aware singleton (same pattern as CSModuleDetector).

#### `async loadRequiredSteps(requirements, features?): Promise<void>` - Lines 147-218
**Purpose**: Main entry point for loading framework steps

**Process Flow**:

1. **Check if Framework Steps Should Load** (Lines 148-156)
   ```typescript
   const stepPaths = this.config.get('STEP_DEFINITIONS_PATH');
   const shouldLoadFrameworkSteps = 
       stepPaths.includes('node_modules/cs-playwright-test-framework') ||
       stepPaths.includes('cs-playwright-test-framework/dist/steps');

   if (!shouldLoadFrameworkSteps) {
       return;  // User excluded framework steps
   }
   ```

2. **Get Loading Strategy** (Line 158)
   ```typescript
   const strategy = this.config.get('STEP_LOADING_STRATEGY', 'all');
   ```

3. **Extract Step Patterns** (Line 163)
   ```typescript
   const stepPatterns = features ? this.extractStepPatterns(features) : undefined;
   ```

4. **Selective Loading** (Lines 166-194)
   ```typescript
   if (strategy === 'selective') {
       // Always load common steps (contains browser/UI steps)
       if (!this.loadedGroups.has('common')) {
           const loaded = await this.loadStepGroup('common', stepPatterns);
           filesLoaded.push(...loaded);
       }

       // Load API steps if required
       if (requirements.api && !this.loadedGroups.has('api')) {
           const loaded = await this.loadStepGroup('api', stepPatterns);
           filesLoaded.push(...loaded);
       }

       // Load Database steps if required
       if (requirements.database && !this.loadedGroups.has('database')) {
           const loaded = await this.loadStepGroup('database', stepPatterns);
           filesLoaded.push(...loaded);
       }

       // Load SOAP steps if required
       if (requirements.soap && !this.loadedGroups.has('soap')) {
           const loaded = await this.loadStepGroup('soap', stepPatterns);
           filesLoaded.push(...loaded);
       }
   }
   ```

5. **ALL Strategy** (Lines 195-205)
   ```typescript
   else {
       const allGroups: StepGroup[] = ['common', 'api', 'database', 'soap'];
       for (const group of allGroups) {
           if (!this.loadedGroups.has(group)) {
               const loaded = await this.loadStepGroup(group, stepPatterns);
               filesLoaded.push(...loaded);
           }
       }
   }
   ```

6. **Logging** (Lines 208-217)
   ```typescript
   if (this.config.getBoolean('MODULE_DETECTION_LOGGING', false)) {
       const workerId = process.env.WORKER_ID ? `Worker ${process.env.WORKER_ID}` : 'Main';
       CSReporter.debug(`[${workerId}] Loaded framework step groups (${strategy}, file-level): ${groupsLoaded.join(', ')} - ${filesLoaded.length} files`);
   }
   ```

#### `private async loadStepGroup(groupName, stepPatterns?): Promise<string[]>` - Lines 226-267
**Purpose**: Load all files in a step group with optional file-level filtering

**Process**:
```typescript
const files = this.STEP_GROUPS[groupName] || [];

for (const file of files) {
    const fullPath = this.resolvePath(file);  // Converts src/ to dist/, .ts to .js
    
    // Check if file exists
    if (!fs.existsSync(fullPath)) {
        const srcPath = fullPath.replace('/dist/', '/src/').replace('.js', '.ts');
        if (fs.existsSync(srcPath)) {
            pathToCheck = srcPath;  // Development mode
        } else {
            continue;  // Skip missing file
        }
    }

    // File-level filtering
    if (stepPatterns && stepPatterns.size > 0) {
        const containsSteps = await this.fileContainsSteps(pathToCheck, stepPatterns);
        if (!containsSteps) {
            CSReporter.debug(`Skipping framework step file (no required steps): ${path.basename(pathToCheck)}`);
            continue;
        }
    }

    // Load the file
    require(pathToCheck);
    loadedFiles.push(path.basename(pathToCheck));
}

this.loadedGroups.add(groupName);
return loadedFiles;
```

#### `private resolvePath(relativePath): string` - Lines 273-287
**Purpose**: Convert source paths to compiled paths

**Transformations**:
```typescript
'src/steps/api/CSAPIRequestSteps.ts'
→ 'dist/steps/api/CSAPIRequestSteps.js'
```

#### `private extractStepPatterns(features): Set<string>` - Lines 294-314
**Purpose**: Extract all unique step texts from parsed features

**Process**:
```typescript
for (const feature of features) {
    // Add background steps
    if (feature.background) {
        feature.background.steps.forEach(step => {
            stepPatterns.add(step.text);
        });
    }

    // Add scenario steps
    for (const scenario of feature.scenarios) {
        scenario.steps.forEach(step => {
            stepPatterns.add(step.text);
        });
    }
}
```

**Example Output**:
```typescript
Set {
    'user navigates to "/login"',
    'user enters "admin" into username field',
    'user clicks login button',
    'user should see dashboard'
}
```

#### `private async fileContainsSteps(filePath, stepPatterns): Promise<boolean>` - Lines 322-394
**Purpose**: Check if a step file contains any required steps (FILE-LEVEL FILTERING)

**Complex Pattern Matching Logic**:

1. **Check for Decorators** (Lines 326-333)
   ```typescript
   // Source (.ts): @CSBDDStepDef('pattern')
   // Compiled (.js): CSBDDStepDef)('pattern')
   if (!content.includes('@CSBDDStepDef') &&
       !content.includes('CSBDDStepDef(') &&
       !content.includes('CSBDDStepDef)')) {
       return false;  // Not a step file
   }
   ```

2. **Pattern Matching** (Lines 336-387)
   ```typescript
   for (const pattern of stepPatterns) {
       // Remove quoted values and parameters
       const baseText = pattern
           .replace(/"[^"]*"/g, '')           // Remove "strings"
           .replace(/\d+/g, '')               // Remove numbers
           .replace(/^\s*(Given|When|Then|And|But)\s+/i, '') // Remove keywords
           .trim();

       // Extract significant words
       const stepWords = baseText.split(/\s+/).filter(word => word.length > 2);

       // Strategy 1: Keyword matching with {string} parameters
       const searchPattern = stepWords.join('.*');
       const regex = new RegExp(`@CSBDDStepDef\\(['\"\`].*${searchPattern}.*['\"\`]\\)`, 'i');
       if (regex.test(content)) {
           return true;
       }

       // Strategy 2: Convert step to parameter placeholder format
       const withoutKeyword = pattern.replace(/^\s*(Given|When|Then|And|But)\s+/i, '');
       const stepPattern = withoutKeyword
           .replace(/"[^"]*"/g, '{string}')           // "admin" → {string}
           .replace(/\b\d+\.\d+\b/g, '{float}')       // 3.14 → {float}
           .replace(/\b\d+\b/g, '{int}')              // 42 → {int}
           .replace(/\b(true|false)\b/gi, '{boolean}'); // true → {boolean}

       if (content.includes(stepPattern)) {
           return true;
       }

       // Strategy 3: Generic {word} matching
       const genericPattern = withoutKeyword
           .replace(/"[^"]*"/g, '{word}')
           .replace(/\b\d+\.\d+\b/g, '{word}')
           .replace(/\b\d+\b/g, '{word}');

       if (content.includes(genericPattern)) {
           return true;
       }
   }
   ```

**Example Matching**:

Feature step: `When user enters "admin" into username field`

Step definition: `@CSBDDStepDef('user enters {string} into username field')`

1. Extracts base text: "user enters into username field"
2. Extracts words: ["user", "enters", "into", "username", "field"]
3. Creates pattern: "user.*enters.*into.*username.*field"
4. Tests regex against file content
5. **OR** converts step to: "user enters {string} into username field"
6. Checks if this exact string is in file
7. Returns `true` if match found

#### `async loadSelectiveProjectSteps(project, featureFiles, stepPaths?): Promise<void>` - Lines 424-496
**Purpose**: Load user's project steps with advanced selective loading

**Multi-Strategy Matching** (Lines 591-656):

**Strategy 1: Keyword Matching**
```typescript
// Extract keywords from step patterns
const keywords = new Set<string>();
for (const pattern of requiredPatterns) {
    const words = pattern
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !['given', 'when', 'then'].includes(w));
    words.forEach(w => keywords.add(w));
}

// Match keywords to file names
for (const [fileName, filePath] of availableFiles) {
    const fileBaseName = fileName.toLowerCase().replace(/\.steps\.(ts|js)$/, '');
    for (const keyword of keywords) {
        if (fileBaseName.includes(keyword)) {
            filesToLoad.add(filePath);
        }
    }
}
```

**Example**:
- Step: "user enters credentials and clicks login button"
- Keywords: ["user", "enters", "credentials", "clicks", "login", "button"]
- Matches files: `login.steps.ts`, `authentication.steps.ts`

**Strategy 2: Convention-Based Matching**
```typescript
// If feature is in "features/login/", load steps from "steps/login/"
for (const featureFile of featureFiles) {
    const featureDirName = path.basename(path.dirname(featureFile));
    
    for (const [dir, files] of dirFiles) {
        if (dir.toLowerCase().includes(featureDirName.toLowerCase())) {
            files.forEach(f => filesToLoad.add(f));
        }
    }
}
```

**Example**:
- Feature: `test/myproject/features/login/login.feature`
- Loads all steps from: `test/myproject/steps/login/*.steps.ts`

**Strategy 3: Always Load Common Steps**
```typescript
for (const [fileName, filePath] of availableFiles) {
    if (fileName.includes('common') || 
        fileName.includes('shared') || 
        fileName.includes('base')) {
        filesToLoad.add(filePath);
    }
}
```

**Fallback Strategy**:
```typescript
if (filesToLoad.size === 0) {
    CSReporter.warn('[SelectiveLoading] No step files matched, loading all as fallback');
    availableFiles.forEach(path => filesToLoad.add(path));
}
```

#### `async loadProjectSteps(project, stepPaths?): Promise<void>` - Lines 505-529
**Purpose**: Backward-compatible method that loads ALL step files

**When Used**: When `STEP_LOADING_STRATEGY=all` (default for safety)

#### `private loadStepFilesRecursively(dir): boolean` - Lines 662-704
**Purpose**: Recursively load all step files from a directory

**TypeScript/JavaScript Handling** (Lines 681-686):
```typescript
let fileToLoad = fullPath;
if (fullPath.endsWith('.ts') && fullPath.includes('/src/')) {
    const distPath = fullPath.replace('/src/', '/dist/').replace('.ts', '.js');
    if (fs.existsSync(distPath)) {
        fileToLoad = distPath;  // Prefer compiled version
    }
}
```

#### `private isStepFile(filename): boolean` - Lines 709-716
**Purpose**: Identify step definition files by naming convention

**Accepted Patterns**:
```typescript
- '*.steps.ts'
- '*.steps.js'
- '*Steps.ts'
- '*Steps.js'
```

### Configuration Properties

| Property | Default | Purpose |
|----------|---------|---------|
| `STEP_LOADING_STRATEGY` | `all` | `selective` or `all` |
| `STEP_DEFINITIONS_PATH` | See below | Semicolon-separated paths to step files |
| `MODULE_DETECTION_LOGGING` | `false` | Log loading decisions |

**Default STEP_DEFINITIONS_PATH**:
```
test/common/steps;test/{project}/steps;test/{project}/step-definitions;src/steps;node_modules/cs-playwright-test-framework/dist/steps
```

### Performance Impact

**Without Selective Loading** (`STEP_LOADING_STRATEGY=all`):
- Loads all 21 framework step files
- Loads all project step files
- ~500ms-1s to load and parse all files

**With Selective Loading** (`STEP_LOADING_STRATEGY=selective`):
- API-only test: Loads 11 API step files (skips 10 files)
- Database-only test: Loads 8 database step files (skips 13 files)
- File-level filtering: Loads only 2-3 files instead of all 11 API files
- **Savings**: 50-80% reduction in loading time

**Example Scenario**:
- Test suite: 100 API scenarios
- Without selective: Loads all 21 framework files + all project files = ~800ms
- With selective (group-level): Loads 11 API files + matching project files = ~400ms
- With selective (file-level): Loads 3 API files + matching project files = ~200ms
- **Net savings**: 600ms × faster iterations during development

### Usage Patterns

**Enable Selective Loading**:
```env
STEP_LOADING_STRATEGY=selective
MODULE_DETECTION_ENABLED=true
MODULE_DETECTION_LOGGING=true
```

**Exclude Framework Steps** (use only project steps):
```env
STEP_DEFINITIONS_PATH=test/common/steps;test/{project}/steps
```

**Custom Step Paths**:
```env
STEP_DEFINITIONS_PATH=custom/path/steps;another/path/steps;node_modules/cs-playwright-test-framework/dist/steps
```

### Best Practices

1. **Use Selective Loading in Development**
   - Faster test iterations
   - Clear visibility into which steps are loaded
   - Early detection of missing step files

2. **Use ALL Strategy in CI/CD**
   - Safety: Ensures all steps available
   - Avoids false negatives from incomplete pattern matching
   - Configuration:
     ```yaml
     # .env.ci
     STEP_LOADING_STRATEGY=all
     ```

3. **Follow Naming Conventions**
   - Feature: `features/login/user-authentication.feature`
   - Steps: `steps/login/login.steps.ts`
   - Loader automatically matches via convention

4. **Use Common/Shared Files**
   - Name: `common.steps.ts` or `shared.steps.ts`
   - These are ALWAYS loaded (Strategy 3)

5. **Enable Logging During Development**
   ```env
   MODULE_DETECTION_LOGGING=true
   LOG_LEVEL=DEBUG
   ```
   See exactly which files are loaded and why.

### Integration Points

**Called By**:
1. `CSBDDRunner.run()` - Before scenario execution
2. `parallel-orchestrator.ts` - Worker initialization

**Calls**:
1. `CSModuleDetector` - To determine required modules
2. `require()` - To load step definition files dynamically

**Depends On**:
1. `CSConfigurationManager` - For config values
2. `CSReporter` - For logging
3. `CSBDDEngine` (ParsedFeature type) - For feature file structure

### Common Issues & Solutions

**Issue 1: "Step definition not found"**

**Cause**: Selective loading filtered out the required file

**Solution**: 
```env
# Temporary: Disable selective loading
STEP_LOADING_STRATEGY=all

# OR: Add to common steps
# Move step to common.steps.ts

# OR: Fix naming convention
# Rename: user-management.steps.ts → user.steps.ts (matches "user" keyword)
```

**Issue 2: "No step files discovered"**

**Cause**: STEP_DEFINITIONS_PATH doesn't include project paths

**Solution**:
```env
STEP_DEFINITIONS_PATH=test/common/steps;test/myproject/steps;node_modules/cs-playwright-test-framework/dist/steps
```

**Issue 3: Slow loading even with selective strategy**

**Cause**: File-level filtering disabled (no features passed)

**Solution**: Ensure CSBDDRunner passes features to loader:
```typescript
await stepLoader.loadRequiredSteps(aggregatedRequirements, features);
```

---

**Completed: 4/20+ components**
**Total Lines Documented: 1,900 (2.1% of 89,095)**

Next: CSBDDEngine (915 lines) - Gherkin parser


## 5. BDD Engine - CSBDDEngine (Gherkin Parser)

**File**: `src/bdd/CSBDDEngine.ts` (915 lines)

### Architecture

**Pattern**: Singleton
**Purpose**: Parse Gherkin (.feature) files into structured data for test execution

**Key Responsibilities**:
1. Parse .feature files using @cucumber/gherkin
2. Expand Scenario Outlines into individual scenarios
3. Handle external data sources (Excel, CSV, JSON, XML, Database, API)
4. Support selective step loading
5. Register ts-node for TypeScript step files
6. Validate features and scenarios

**Performance Optimization**: Lazy-loads @cucumber/gherkin module (saves ~4 seconds at startup)

### Type Definitions

```typescript
export interface ParsedFeature {
    name: string;
    description?: string;
    tags: string[];
    scenarios: ParsedScenario[];
    background?: ParsedBackground;
    rules?: ParsedRule[];
    uri?: string;  // Path to the feature file
}

export interface ParsedScenario {
    name: string;
    tags: string[];
    steps: ParsedStep[];
    examples?: ParsedExamples;
    type: 'Scenario' | 'ScenarioOutline';
}

export interface ParsedStep {
    keyword: string;  // Given, When, Then, And, But
    text: string;
    dataTable?: any[][];  // Optional data table
    docString?: string;   // Optional doc string (""" ... """)
}

export interface ParsedBackground {
    name?: string;
    steps: ParsedStep[];
}

export interface ParsedRule {
    name: string;
    scenarios: ParsedScenario[];
}

export interface ParsedExamples {
    name?: string;
    headers: string[];
    rows: string[][];
    dataSource?: ExternalDataSource;  // For external data
}

export interface ExternalDataSource {
    type: 'excel' | 'csv' | 'json' | 'xml' | 'database' | 'api';
    source: string;      // File path or connection string
    sheet?: string;      // Excel sheet name
    delimiter?: string;  // CSV delimiter
    path?: string;       // JSON path
    xpath?: string;      // XML XPath
    filter?: string;     // Filter expression
    query?: string;      // Database query
    connection?: string; // Database connection name
}
```

### Properties

```typescript
private static instance: CSBDDEngine;                      // Singleton
private config: CSConfigurationManager;                     // Configuration access
private features: Map<string, ParsedFeature> = new Map();   // Cached parsed features
private stepDefinitionPaths: string[] = [];                 // Paths to step files
private dataProviderConfigs: Map<string, string> = new Map(); // DataProvider configurations
private tsNodeRegistered: boolean = false;                  // ts-node registration flag
```

### Lazy Loading Strategy

```typescript
// Lines 3-10
let gherkinModule: any = null;
const getGherkin = () => {
    if (!gherkinModule) {
        gherkinModule = require('@cucumber/gherkin');  // Load on first use
    }
    return gherkinModule;
};
```

**Why**: @cucumber/gherkin takes ~4 seconds to load. Lazy loading defers this until actually parsing features.

### Core Methods

#### `static getInstance(): CSBDDEngine` - Lines 133-138
Standard singleton pattern.

#### `private registerTsNode(): void` - Lines 95-131
**Purpose**: Register ts-node to load TypeScript step files

**Process**:
```typescript
// Check if any step paths contain .ts files
const hasTsFiles = this.stepDefinitionPaths.some(p => {
    if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
            return fs.readdirSync(p).some(f => f.endsWith('.ts'));
        }
        return p.endsWith('.ts');
    }
    return false;
});

if (hasTsFiles) {
    require('ts-node').register({
        transpileOnly: true,  // Fast compilation (no type checking)
        compilerOptions: {
            module: 'commonjs',
            target: 'es2017',
            esModuleInterop: true,
            skipLibCheck: true,
            experimentalDecorators: true,     // Required for @CSBDDStepDef
            emitDecoratorMetadata: true       // Required for decorator reflection
        }
    });
    this.tsNodeRegistered = true;
}
```

**Why Important**: Allows users to write step definitions in TypeScript without pre-compilation.

#### `private initializeStepDefinitionPaths(): void` - Lines 140-154
**Purpose**: Initialize step definition search paths

**Default Paths**:
```typescript
STEP_DEFINITIONS_PATH = 'test/common/steps;test/{project}/steps;src/steps'
```

**Process**:
```typescript
const pathsConfig = this.config.get('STEP_DEFINITIONS_PATH', 'test/common/steps;test/{project}/steps;src/steps');
const project = this.config.get('PROJECT', 'common');

const paths = pathsConfig.split(';').map(p => {
    p = p.replace('{project}', project);  // Replace placeholder
    return path.resolve(process.cwd(), p);  // Resolve to absolute path
});

this.stepDefinitionPaths = paths;
```

#### `public parseFeature(featurePath): ParsedFeature` - Lines 164-174
**Purpose**: Parse a single .feature file

**Process**:
```typescript
const fullPath = path.resolve(process.cwd(), featurePath);
if (!fs.existsSync(fullPath)) {
    throw new Error(`Feature file not found: ${fullPath}`);
}

const content = fs.readFileSync(fullPath, 'utf8');
return this.parseGherkin(content, fullPath);
```

#### `public parseDirectory(dirPath): ParsedFeature[]` - Lines 184-206
**Purpose**: Parse all .feature files in a directory recursively

**Process**:
```typescript
const files = this.findFeatureFiles(fullPath);  // Recursive file search

for (const file of files) {
    try {
        const feature = this.parseFeature(file);
        features.push(feature);
        this.features.set(file, feature);  // Cache
    } catch (error: any) {
        CSReporter.error(`Failed to parse feature: ${file} - ${error.message}`);
    }
}

return features;
```

#### `public parseWithFilters(dirPath, filters): ParsedFeature[]` - Lines 209-255
**Purpose**: Parse features with tag and scenario filtering

**Supported Filters**:
```typescript
{
    tags?: string;         // Required tags (comma-separated)
    excludeTags?: string;  // Excluded tags (comma-separated)
    scenario?: string;     // Scenario name filter
}
```

**Tag Filtering Logic** (Lines 221-228):
```typescript
if (filters.tags) {
    const requiredTags = filters.tags.split(',').map(t => t.trim());
    const scenarioTags = [...feature.tags, ...scenario.tags];

    if (!requiredTags.some(tag => scenarioTags.includes(tag))) {
        return false;  // Scenario doesn't have any required tag
    }
}
```

**Example**:
```typescript
parseWithFilters('test/features', {
    tags: '@smoke,@regression',  // Must have @smoke OR @regression
    excludeTags: '@skip,@wip'    // Must NOT have @skip or @wip
});
```

#### `public parseGherkin(gherkinText, sourcePath?): ParsedFeature` - Lines 258-323
**Purpose**: Main Gherkin parsing method

**Process Flow**:

1. **Preprocess DataProvider Tags** (Line 261)
   ```typescript
   const processedText = this.preprocessDataProviderTags(gherkinText);
   ```

2. **Parse with Gherkin Library** (Lines 263-265)
   ```typescript
   const { Parser, AstBuilder, GherkinClassicTokenMatcher } = getGherkin();
   const parser = new Parser(new AstBuilder(uuidFn), new GherkinClassicTokenMatcher());
   const ast = parser.parse(processedText);
   ```

3. **Extract Feature Metadata** (Lines 271-283)
   ```typescript
   const featureTags = (feature.tags || []).map((t: any) => t.name);
   const parsedFeature: ParsedFeature = {
       name: feature.name || 'Unnamed Feature',
       description: feature.description,
       tags: featureTags,
       scenarios: [],
       uri: sourcePath,
       background: undefined,
       rules: [],
       gherkinDocument: ast  // Store raw AST
   };
   ```

4. **Parse Children** (Lines 289-316)
   ```typescript
   for (const child of feature.children || []) {
       if (child.background) {
           parsedFeature.background = {
               name: child.background.name || 'Background',
               steps: this.parseSteps([...child.background.steps])
           };
       } else if (child.scenario) {
           const scenario = this.parseScenario(child.scenario);

           // Check if scenario outline with examples
           if (child.scenario.examples && child.scenario.examples.length > 0) {
               // Expand into multiple scenarios
               const expandedScenarios = this.expandScenarioOutline(child.scenario);
               parsedFeature.scenarios.push(...expandedScenarios);
           } else {
               parsedFeature.scenarios.push(scenario);
           }
       } else if (child.rule) {
           parsedFeature.rules?.push(this.parseRule(child.rule));
       }
   }
   ```

#### `private parseScenario(scenario): ParsedScenario` - Lines 334-396
**Purpose**: Parse a single scenario

**DataProvider Handling** (Lines 338-380):

1. **Check for @data-config Tag** (Lines 341-348)
   ```typescript
   const configTag = tags.find((tag: string) => tag.startsWith('@data-config:'));
   if (configTag) {
       const base64Config = configTag.substring('@data-config:'.length);
       const configStr = Buffer.from(base64Config, 'base64').toString('utf-8');
       dataProviderConfig = this.parseDataProviderString(configStr);
   }
   ```

2. **Check for @DataProvider Tag** (Lines 356-361)
   ```typescript
   const hasDataProviderTag = tags.some((tag: string) =>
       tag === '@data-provider' ||
       tag === '@DataProvider' ||
       tag.includes('data-source') ||
       tag.includes('data-provider')
   );
   ```

3. **Create Examples from Config** (Lines 368-376)
   ```typescript
   if (hasDataProviderTag && dataProviderConfig) {
       const hasEmptyExamples = !examples || (examples.headers.length === 0 && examples.rows.length === 0);
       if (hasEmptyExamples) {
           examples = this.createExamplesFromConfig(dataProviderConfig);
       }
   }
   ```

**Return Structure** (Lines 389-395):
```typescript
return {
    name: scenario.name || 'Unnamed Scenario',
    tags,
    steps: this.parseSteps(scenario.steps),
    examples: hasActualExamples ? examples : undefined,
    type: hasActualExamples ? 'ScenarioOutline' : 'Scenario'
};
```

#### `private expandScenarioOutline(scenario): ParsedScenario[]` - Lines 398-450
**Purpose**: Expand Scenario Outline into individual scenarios

**Example Input**:
```gherkin
Scenario Outline: Login with different users
  When user enters "<username>" and "<password>"
  Then login should be "<result>"

  Examples:
    | username | password | result  |
    | admin    | admin123 | success |
    | user     | user456  | success |
    | invalid  | wrong    | failure |
```

**Expansion Process**:
```typescript
for (const example of scenario.examples) {
    const headers = example.tableHeader?.cells?.map((c: any) => c.value) || [];

    for (const row of example.tableBody) {
        const values = row.cells.map((c: any) => c.value);
        const exampleData: Record<string, string> = {};

        headers.forEach((header: string, index: number) => {
            exampleData[header] = values[index] || '';
        });

        // Create scenario name with values
        const scenarioName = `${scenario.name} [${values.join(', ')}]`;

        // Replace placeholders in steps
        const expandedSteps = scenario.steps.map((step: any) => {
            let text = step.text;
            headers.forEach((header: string, index: number) => {
                const placeholder = `<${header}>`;
                const value = values[index] || '';
                text = text.replace(new RegExp(placeholder, 'g'), value);
            });

            return {
                keyword: step.keyword,
                text: text,
                dataTable: step.dataTable,
                docString: step.docString
            };
        });

        expandedScenarios.push({
            name: scenarioName,
            tags: (scenario.tags || []).map((t: any) => t.name),
            steps: this.parseSteps(expandedSteps),
            type: 'Scenario',
            exampleData: exampleData  // Store for reference
        });
    }
}
```

**Output** (3 scenarios):
```
1. Login with different users [admin, admin123, success]
   - When user enters "admin" and "admin123"
   - Then login should be "success"

2. Login with different users [user, user456, success]
   - When user enters "user" and "user456"
   - Then login should be "success"

3. Login with different users [invalid, wrong, failure]
   - When user enters "invalid" and "wrong"
   - Then login should be "failure"
```

#### `private preprocessDataProviderTags(gherkinText): string` - Lines 648-686
**Purpose**: Preprocess @DataProvider tags before Gherkin parsing

**Why Needed**: Gherkin parser doesn't understand complex @DataProvider(...) syntax. Need to convert to simple tags.

**Transformation**:
```gherkin
# BEFORE preprocessing
@DataProvider(source="testdata.xlsx", sheet="Users", type="excel")
Scenario: Test with Excel data

# AFTER preprocessing
@data-provider @data-config:c291cmNlPSJ0ZXN0ZGF0YS54bHN4Iixz...
Scenario: Test with Excel data
```

**Process** (Lines 655-681):
```typescript
for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const dataProviderMatch = line.match(/@DataProvider\([^)]+\)/g);

    if (dataProviderMatch) {
        // Extract configuration
        dataProviderMatch.forEach(match => {
            pendingConfig = match.substring('@DataProvider('.length, match.length - 1);
        });

        // Replace with simple tags + base64 encoded config
        let processedLine = line;
        dataProviderMatch.forEach(match => {
            processedLine = processedLine.replace(
                match,
                `@data-provider @data-config:${Buffer.from(pendingConfig || '').toString('base64')}`
            );
        });

        processedLines.push(processedLine);
        pendingConfig = null;
    } else {
        processedLines.push(line);
    }
}
```

**Base64 Encoding**: Encodes the configuration string to avoid Gherkin syntax conflicts.

#### `private parseDataProviderString(configStr): ExternalDataSource | null` - Lines 610-637
**Purpose**: Parse DataProvider configuration string

**Input Format**:
```
source="testdata.xlsx", sheet="Users", type="excel", filter="active=true"
```

**Parsing Logic** (Lines 614-619):
```typescript
const params: any = {};
const paramRegex = /(\w+)="([^"]*)"/g;
let match;
while ((match = paramRegex.exec(configStr)) !== null) {
    params[match[1]] = match[2];
}
```

**Output**:
```typescript
{
    type: 'excel',
    source: 'testdata.xlsx',
    sheet: 'Users',
    filter: 'active=true',
    delimiter: undefined,
    path: undefined,
    xpath: undefined,
    query: undefined,
    connection: undefined
}
```

#### `async loadRequiredStepDefinitions(features): Promise<void>` - Lines 719-775
**Purpose**: Selectively load only step files required for the features

**Process**:

1. **Extract Step Patterns** (Lines 729-745)
   ```typescript
   const stepPatterns = new Set<string>();

   for (const feature of features) {
       if (feature.background) {
           feature.background.steps.forEach(step => {
               stepPatterns.add(step.text);
           });
       }

       for (const scenario of feature.scenarios) {
           scenario.steps.forEach(step => {
               stepPatterns.add(step.text);
           });
       }
   }
   ```

2. **Load Matching Files** (Lines 750-771)
   ```typescript
   for (const stepPath of this.stepDefinitionPaths) {
       if (fs.existsSync(stepPath)) {
           const files = this.findStepFiles(stepPath);

           for (const file of files) {
               if (await this.fileContainsSteps(file, stepPatterns)) {
                   await this.loadStepFile(file);
                   loadedFiles.push(file);
               }
           }
       }
   }

   CSReporter.info(`Selective step loading: ${loadedFiles.length} files in ${loadTime}ms`);
   ```

#### `private async fileContainsSteps(filePath, stepPatterns): Promise<boolean>` - Lines 812-876
**Purpose**: Check if a step file contains any required steps

**Same logic as CSStepLoader** - See CSStepLoader documentation for details.

#### `private async loadStepFile(filePath): Promise<void>` - Lines 878-905
**Purpose**: Load a step definition file

**TypeScript Handling** (Lines 884-896):
```typescript
if (filePath.endsWith('.ts')) {
    // Always use TypeScript file when ts-node is registered
    fileToLoad = filePath;
} else if (filePath.endsWith('.js')) {
    // Try to find TypeScript source
    const tsPath = filePath.replace('/dist/', '/src/').replace('.js', '.ts');
    if (fs.existsSync(tsPath)) {
        fileToLoad = tsPath;  // Prefer source over compiled
    }
}

require(fileToLoad);
```

**Why Prefer TypeScript**: When ts-node is registered, using .ts files ensures consistent module instances.

### DataProvider Examples

**Example 1: Excel Data Source**
```gherkin
@DataProvider(source="testdata/users.xlsx", sheet="LoginData", type="excel")
Scenario Outline: Login with Excel data
  When user enters "<username>" and "<password>"
  Then login result should be "<result>"
```

**Example 2: CSV Data Source**
```gherkin
@DataProvider(source="testdata/users.csv", type="csv", delimiter=",")
Scenario Outline: Login with CSV data
  When user logs in with "<email>" and "<password>"
```

**Example 3: Database Query**
```gherkin
@DataProvider(type="database", connection="MAIN_DB", query="SELECT username, password FROM test_users WHERE active=1")
Scenario Outline: Login with database users
  When user logs in as "<username>" with "<password>"
```

**Example 4: API Data Source**
```gherkin
@DataProvider(type="api", source="https://api.example.com/test-users")
Scenario Outline: Login with API data
  When user logs in with credentials from API
```

**Example 5: JSON File**
```gherkin
@DataProvider(source="testdata/users.json", type="json", path="$.users[*]")
Scenario Outline: Login with JSON data
  When user enters "<username>" and "<password>"
```

### Configuration Properties

| Property | Default | Purpose |
|----------|---------|---------|
| `STEP_DEFINITIONS_PATH` | `test/common/steps;test/{project}/steps;src/steps` | Paths to step files |
| `SELECTIVE_STEP_LOADING` | `true` | Enable selective loading |
| `PROJECT` | `common` | Project name for {project} placeholder |

### Integration Points

**Called By**:
1. `CSBDDRunner.run()` - To parse features before execution

**Calls**:
1. `@cucumber/gherkin` - For Gherkin parsing
2. `ts-node` - For TypeScript support
3. `CSConfigurationManager` - For configuration
4. `CSReporter` - For logging

**Exports**:
- `ParsedFeature`, `ParsedScenario`, `ParsedStep` interfaces
- `CSBDDEngine` class

### Best Practices

1. **Use Explicit DataProvider Tags**
   ```gherkin
   @DataProvider(source="testdata.xlsx", sheet="Sheet1", type="excel")
   ```
   More explicit than relying on Examples table JSON.

2. **Organize Feature Files**
   ```
   test/features/
   ├── login/
   │   └── login.feature
   ├── registration/
   │   └── registration.feature
   └── api/
       └── user-api.feature
   ```

3. **Use Background for Common Steps**
   ```gherkin
   Feature: User Management

   Background:
     Given application is running
     And database is connected

   Scenario: Create user
     When user is created
   ```

4. **Tag Strategically**
   ```gherkin
   @smoke @ui @regression
   Scenario: Critical login test
   ```

5. **Use Rules for Organization**
   ```gherkin
   Feature: Account Management

   Rule: User Registration
     Scenario: Register new user
     Scenario: Register with existing email

   Rule: User Login
     Scenario: Login with valid credentials
     Scenario: Login with invalid credentials
   ```

### Common Issues & Solutions

**Issue 1: "Failed to parse Gherkin"**

**Cause**: Syntax error in .feature file

**Solution**: Validate Gherkin syntax. Common mistakes:
- Missing colon after Feature/Scenario
- Incorrect indentation
- Special characters in step text

**Issue 2: "Step definition not found"**

**Cause**: Selective loading filtered out the step file

**Solution**:
```env
SELECTIVE_STEP_LOADING=false
```

**Issue 3: "DataProvider configuration not recognized"**

**Cause**: Incorrect @DataProvider syntax

**Valid Syntax**:
```gherkin
@DataProvider(source="file.xlsx", sheet="Sheet1", type="excel")
```

**Invalid**:
```gherkin
@DataProvider source="file.xlsx"  # Missing parentheses
```

---

**Completed: 5/20+ components**
**Total Lines Documented: 2,815 (3.2% of 89,095)**

Next: CSBDDRunner (3123 lines) - THE BIG ONE - Test executor and orchestrator


## 6. BDD Runner - CSBDDRunner (Test Orchestrator)

**File**: `src/bdd/CSBDDRunner.ts` (3,123 lines)

### Architecture

**Pattern**: Singleton
**Purpose**: Central test orchestration - coordinates all framework components for BDD test execution

**Key Responsibilities**:
1. Parse features and scenarios
2. Manage test lifecycle (setup, execution, teardown)
3. Coordinate browser/API/database modules
4. Execute steps and match to step definitions
5. Handle parallel execution
6. Collect test results and generate reports
7. Integrate with Azure DevOps
8. Manage AI-powered features

**Performance Strategy**: Aggressive lazy loading
- Playwright: Saves ~27s
- CSBrowserManager: Saves ~36s  
- ADO Integration: On-demand
- AI Integration: On-demand
- **Total startup savings**: ~60+ seconds

### Properties (85+ State Variables)

```typescript
// Core Components
private static instance: CSBDDRunner;              // Singleton
private bddEngine: CSBDDEngine;                    // Feature parser
private config: CSConfigurationManager;             // Configuration
private context: CSBDDContext;                      // World context
private featureContext: CSFeatureContext;           // Feature-level context
private scenarioContext: CSScenarioContext;         // Scenario-level context
private browserManager: any;                        // Lazy-loaded CSBrowserManager
private resultsManager: CSTestResultsManager;       // Report management
private adoIntegration: any;                        // Lazy-loaded Azure DevOps
private aiIntegration: any;                         // Lazy-loaded AI features

// Test State Tracking
private failedScenarios: Array<{scenario, feature, error}> = [];
private testSuite: ProfessionalTestSuite;          // Report suite object
private currentFeature: TestFeature | null = null;  // Currently executing feature
private currentScenario: TestScenario | null = null; // Currently executing scenario
private passedCount: number = 0;                    // Passed scenarios
private failedCount: number = 0;                    // Failed scenarios
private skippedCount: number = 0;                   // Skipped scenarios
private anyTestFailed: boolean = false;             // HAR decision flag
private passedSteps: number = 0;                    // Step counters
private failedSteps: number = 0;
private skippedSteps: number = 0;
private startTime: number = Date.now();             // Execution start time
private testResults: any = {};                      // Results accumulator
private parallelExecutionDone: boolean = false;     // Parallel completion flag
private scenarioCountForReuse: number = 0;          // Browser reuse counter
private lastScenarioError: any = null;              // ADO error tracking
```

### Lazy Loading Implementation

**Lines 1-35**: Strategic imports
```typescript
// Lazy load Playwright (saves 27s)
type Page = any;
type BrowserContext = any;

// Lazy load CSBrowserManager (saves 36s)
let CSBrowserManager: any = null;

// Lazy load ADO (on-demand)
let CSADOIntegration: any = null;

// Lazy load AI (on-demand)
let CSAIIntegrationLayer: any = null;

// Lazy load report generators (on-demand)
type ProfessionalTestSuite = any;
```

**`async ensureBrowserManager(): Promise<any>`** - Lines 139-151
```typescript
private async ensureBrowserManager(): Promise<any> {
    if (!this.browserManager) {
        if (!CSBrowserManager) {
            CSBrowserManager = require('../browser/CSBrowserManager').CSBrowserManager;
        }
        this.browserManager = CSBrowserManager.getInstance();
    }
    return this.browserManager;
}
```

**`ensureADOIntegration(): any`** - Lines 153-161
```typescript
private ensureADOIntegration(): any {
    if (!this.adoIntegration) {
        if (!CSADOIntegration) {
            CSADOIntegration = require('../ado/CSADOIntegration').CSADOIntegration;
        }
        this.adoIntegration = CSADOIntegration.getInstance();
    }
    return this.adoIntegration;
}
```

### Main Entry Point

#### `public async run(options: RunOptions = {}): Promise<void>` - Lines 208-1091

**Purpose**: Main test execution orchestrator

**RunOptions Interface** (Lines 45-57):
```typescript
export interface RunOptions {
    features?: string | string[];    // Feature path(s)
    tags?: string;                   // Tag filter
    excludeTags?: string;            // Exclude tags
    scenario?: string;               // Scenario name filter
    parallel?: boolean | number;     // Parallel mode
    workers?: number;                // Worker count
    retry?: number;                  // Retry attempts
    dryRun?: boolean;                // Validation only
    failFast?: boolean;              // Stop on first failure
    stepTimeout?: number;            // Step timeout ms
    screenshot?: 'always' | 'onFailure' | 'never';
    video?: 'always' | 'onFailure' | 'never';
    report?: string[];               // Report types
    [key: string]: any;              // Additional props
}
```

**Execution Flow**:

**1. Configuration Setup** (Lines 209-234)
```typescript
// Apply options to config
if (options.project) this.config.set('PROJECT', options.project);
if (options.features) this.config.set('FEATURES', options.features);
if (options.tags) this.config.set('TAGS', options.tags);
if (options.headless !== undefined) this.config.set('HEADLESS', String(options.headless));
if (options.browser) this.config.set('BROWSER', options.browser);
// ... more config overrides

// Initialize results manager
const { dirs, timestamp } = this.resultsManager.initializeDirectories();
CSReporter.info(`Test execution started: ${timestamp}`);
```

**2. Feature Discovery & Parsing** (Lines 236-286)
```typescript
// Get feature files
const featurePattern = this.config.get('FEATURES', 'test/**/*.feature');
let featureFiles: string[] = [];

if (Array.isArray(featurePattern)) {
    for (const pattern of featurePattern) {
        const files = await glob(pattern, { cwd: process.cwd(), absolute: true });
        featureFiles.push(...files);
    }
} else {
    featureFiles = await glob(featurePattern, { cwd: process.cwd(), absolute: true });
}

if (featureFiles.length === 0) {
    throw new Error(`No feature files found matching: ${featurePattern}`);
}

// Parse features
const features: ParsedFeature[] = [];
for (const file of featureFiles) {
    const feature = this.bddEngine.parseFeature(file);
    features.push(feature);
}

CSReporter.info(`Found ${features.length} feature(s) with ${this.getTotalScenarios(features)} scenario(s)`);
```

**3. Module Detection & Step Loading** (Lines 258-279)
```typescript
// Load required step definitions using selective loading
await this.bddEngine.loadRequiredStepDefinitions(features);

// Load framework steps with file-level filtering
const moduleDetector = CSModuleDetector.getInstance();
const aggregatedRequirements: ModuleRequirements = {
    browser: false, api: false, database: false, soap: false
};

for (const feature of features) {
    for (const scenario of feature.scenarios) {
        const req = moduleDetector.detectRequirements(scenario, feature);
        aggregatedRequirements.browser ||= req.browser;
        aggregatedRequirements.api ||= req.api;
        aggregatedRequirements.database ||= req.database;
        aggregatedRequirements.soap ||= req.soap;
    }
}

const stepLoader = CSStepLoader.getInstance();
await stepLoader.loadRequiredSteps(aggregatedRequirements, features);
```

**4. Parallel vs Sequential Execution** (Lines 288-382)
```typescript
const parallelConfig = this.config.get('PARALLEL', '1');
const isParallel = options.parallel || (parallelConfig && parallelConfig !== '1');

if (isParallel) {
    // PARALLEL EXECUTION
    await this.runWithParallel(features, options);
} else {
    // SEQUENTIAL EXECUTION
    for (const feature of features) {
        await this.executeFeature(feature, options);
    }
}
```

**5. Report Generation** (Lines 900-1091)
```typescript
// Generate reports in configured formats
const reportTypes = this.config.get('REPORT_TYPES', 'html,json').split(',');

for (const type of reportTypes) {
    switch (type.trim()) {
        case 'html':
            await this.generateHTMLReport();
            break;
        case 'json':
            await this.generateJSONReport();
            break;
        case 'junit':
            await this.generateJUnitReport();
            break;
        case 'pdf':
            await this.generatePDFReport();
            break;
        case 'excel':
            await this.generateExcelReport();
            break;
    }
}

CSReporter.success(`Reports generated in: ${this.resultsManager.getBaseDirectory()}`);
```

**6. ADO Integration** (Lines 1050-1089)
```typescript
// Sync with Azure DevOps if enabled
if (this.config.getBoolean('ADO_ENABLED', false)) {
    try {
        const adoIntegration = this.ensureADOIntegration();
        await adoIntegration.syncTestResults(this.testResults);
        CSReporter.success('Test results synced to Azure DevOps');
    } catch (error) {
        CSReporter.warn(`ADO sync failed: ${error.message}`);
    }
}
```

### Scenario Execution

#### `private async executeScenario(scenario, feature, options): Promise<void>` - Lines 1093-1771

**Purpose**: Execute a single scenario (most complex method)

**Key Phases**:

**Phase 1: Pre-Execution** (Lines 1096-1230)
```typescript
// 1. Module detection
const moduleDetector = CSModuleDetector.getInstance();
const requirements = moduleDetector.detectRequirements(scenario, feature);

// 2. Browser launch decision
if (requirements.browser && !this.browserManager) {
    await this.ensureBrowserManager();
    const reuseEnabled = this.config.getBoolean('BROWSER_REUSE_ENABLED', false);
    
    if (!reuseEnabled || !this.browserManager.getBrowser()) {
        await this.browserManager.launch();
    }
}

// 3. Create scenario context
this.scenarioContext.startScenario(scenario.name);
this.currentScenario = this.addScenarioToReport(scenario, feature);

// 4. Handle Data Provider (Excel/CSV/DB)
if (scenario.examples?.dataSource) {
    const dataProvider = new CSDataProvider();
    const rows = await dataProvider.loadData(scenario.examples.dataSource);
    
    // Execute scenario for each data row
    for (const row of rows) {
        await this.executeScenarioWithData(scenario, feature, row, options);
    }
    return;
}
```

---

## 7. Browser Manager - CSBrowserManager (Browser & Context Orchestrator)

**File**: `src/browser/CSBrowserManager.ts` (1,416 lines)

### Architecture
**Pattern**: Worker-Aware Singleton
**Purpose**: Manages browser lifecycle, contexts, pages, and artifacts (videos, HAR, traces, screenshots)

### Worker-Aware Threading Model
Each parallel worker gets its own isolated browser instance:
```typescript
// Lines 54-68: getInstance()
if (typeof process !== 'undefined' && process.env.WORKER_ID) {
    const workerId = parseInt(process.env.WORKER_ID);
    if (!CSBrowserManager.threadInstances.has(workerId)) {
        CSBrowserManager.threadInstances.set(workerId, new CSBrowserManager());
    }
    return CSBrowserManager.threadInstances.get(workerId)!;
}
```

### Properties (State Variables)

**Core Browser Components**:
- `private static instance: CSBrowserManager` - Main thread singleton
- `private static threadInstances: Map<number, CSBrowserManager>` - Worker-specific instances
- `private browser: any | null` - Playwright Browser instance
- `private context: any | null` - BrowserContext instance
- `private page: any | null` - Page instance
- `private browserPool: Map<string, any>` - Browser instances pool for reuse
- `private currentBrowserType: string` - Current browser type (chrome/edge/firefox/webkit)

**State Management**:
- `private browserState: BrowserState` - Saved cookies, localStorage, sessionStorage, URL
- `private restartCount: number` - Browser crash recovery counter
- `private isWorkerThread: boolean` - Worker thread flag
- `private workerId: number` - Worker ID for parallel execution

**Artifact Tracking**:
- `private videosToDelete: string[]` - Videos marked for deletion based on test status
- `private harsToDelete: string[]` - HAR files marked for deletion
- `private currentHarPath: string | null` - Current HAR file path (accumulates with reuse)
- `private traceStarted: boolean` - Trace recording state flag
- `private sessionArtifacts: { videos, traces, har, screenshots }` - Artifacts for current session

### Lazy Loading Implementation

**Playwright Lazy Loading** (saves 27 seconds at startup):
```typescript
// Lines 79-85: ensurePlaywright()
private ensurePlaywright(): any {
    if (!playwright) {
        // Lazy load playwright - this takes 27 seconds!
        playwright = require('@playwright/test');
    }
    return playwright;
}
```

**Why This Matters**:
- API/Database-only tests don't load Playwright at all
- Browser tests only load Playwright when first browser launches
- 27-second startup time saved for non-UI tests

### Main Methods

#### 1. public async launch(browserType?: string): Promise<void> - Lines 87-135
**Purpose**: Launch browser with reuse strategy

**Algorithm**:
```typescript
1. Get browser type (default: 'chrome' from BROWSER config)
2. Check BROWSER_REUSE_ENABLED:
   - If enabled and browser exists → reuse existing browser
   - Otherwise → launch new browser via launchBrowser()
3. Create context if not exists
4. Create page if not exists
5. Performance check: warn if launch > 3000ms
```

**Browser Reuse Strategy**:
- When enabled: Browser instance stays alive across scenarios
- Context recreated per scenario for isolation
- Page can be reused or recreated based on configuration

**Configuration**:
- `BROWSER` - Browser type (chrome, firefox, webkit, edge)
- `BROWSER_REUSE_ENABLED` - Enable browser reuse across scenarios
- `BROWSER_LAUNCH_TIMEOUT` - Launch timeout (default: 30000ms)

#### 2. private async launchBrowser(browserType: string): Promise<any> - Lines 137-187
**Purpose**: Launch specific browser with configuration

**Supported Browsers**:
1. **Chrome/Chromium** (Lines 166-171):
   - Uses `pw.chromium.launch()`
   - Custom args via `getChromeArgs()`

2. **Firefox** (Lines 172-176):
   - Uses `pw.firefox.launch()`
   - Custom args via `getFirefoxArgs()`

3. **WebKit/Safari** (Lines 177-179):
   - Uses `pw.webkit.launch()`

4. **Edge** (Lines 180-183):
   - Uses `pw.chromium.launch()` with channel: 'msedge'

**Browser Options** (Lines 140-163):
```typescript
{
    headless: HEADLESS,
    timeout: BROWSER_LAUNCH_TIMEOUT,
    slowMo: BROWSER_SLOWMO,
    devtools: BROWSER_DEVTOOLS,
    args: [...], // Browser-specific arguments
    proxy: { // If BROWSER_PROXY_ENABLED
        server: BROWSER_PROXY_SERVER,
        username: BROWSER_PROXY_USERNAME,
        password: BROWSER_PROXY_PASSWORD,
        bypass: BROWSER_PROXY_BYPASS
    }
}
```

**Non-Headless Mode** (Lines 145-151):
Automatically adds maximize and rendering optimization args:
```typescript
'--start-maximized',
'--no-default-browser-check',
'--disable-web-security',
'--disable-features=VizDisplayCompositor',
'--force-device-scale-factor=1'
```

#### 3. private getChromeArgs(): string[] - Lines 189-215
**Purpose**: Chrome-specific launch arguments

**Configurable Args**:
- `BROWSER_INCOGNITO` → `--incognito`
- `BROWSER_DISABLE_GPU` → `--disable-gpu`
- `BROWSER_NO_SANDBOX` → `--no-sandbox`
- `BROWSER_CHROME_ARGS` → Custom args list

#### 4. private async createContext(): Promise<void> - Lines 231-361
**Purpose**: Create browser context with artifacts recording

**Context Options** (Lines 238-251):
```typescript
{
    viewport: HEADLESS ? { width: 1920, height: 1080 } : null,
    ignoreHTTPSErrors: true (default),
    locale: 'en-US' (default),
    timezoneId: 'America/New_York' (default),
    permissions: BROWSER_PERMISSIONS,
    geolocation: { latitude, longitude },
    colorScheme: 'light' | 'dark',
    reducedMotion: 'no-preference' | 'reduce',
    forcedColors: 'none' | 'active'
}
```

**Video Recording** (Lines 254-285):
```typescript
// Get results directory
const resultsManager = CSTestResultsManager.getInstance();
const dirs = resultsManager.getDirectories();

// Configure video
if (videoMode !== 'off' && videoMode !== 'never') {
    contextOptions.recordVideo = {
        dir: dirs.videos,
        size: { width: 1280, height: 720 }
    };
}
```

**HAR Recording** (Lines 287-303):
```typescript
const harCaptureMode = TRACE_CAPTURE_MODE; // 'always' | 'on-failure' | 'never'

if (harEnabled) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const uniqueId = this.isWorkerThread ? `w${this.workerId}` : 'main';
    this.currentHarPath = `${dirs.har}/network-${uniqueId}-${timestamp}.har`;
    contextOptions.recordHar = {
        path: this.currentHarPath,
        omitContent: BROWSER_HAR_OMIT_CONTENT
    };
}
```

**Trace Recording** (Lines 344-356):
```typescript
const traceCaptureMode = TRACE_CAPTURE_MODE;
if (traceCaptureMode !== 'never') {
    await this.context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: true
    });
    this.traceStarted = true;
}
```

**Additional Options**:
- User Agent (Line 306-309): `BROWSER_USER_AGENT`
- Extra Headers (Lines 312-315): `BROWSER_EXTRA_HEADERS` (JSON)
- Offline Mode (Lines 318-320): `BROWSER_OFFLINE`
- HTTP Credentials (Lines 323-330): `BROWSER_HTTP_USERNAME/PASSWORD`
- State Restoration (Lines 333-338): Restore cookies from previous browser

**Timeouts** (Lines 359-360):
```typescript
context.setDefaultTimeout(BROWSER_ACTION_TIMEOUT); // Default: 10000ms
context.setDefaultNavigationTimeout(BROWSER_NAVIGATION_TIMEOUT); // Default: 30000ms
```

#### 5. private async createPage(): Promise<void> - Lines 363-402
**Purpose**: Create page with event listeners

**Event Listeners**:

1. **Console Logs** (Lines 377-383):
```typescript
if (CONSOLE_LOG_CAPTURE) {
    page.on('console', (msg) => {
        resultsManager.addConsoleLog(msg.type(), msg.text(), new Date());
        CSReporter.debug(`Console [${msg.type()}]: ${msg.text()}`);
    });
}
```

2. **Page Errors** (Lines 386-388):
```typescript
page.on('pageerror', (error) => {
    CSReporter.warn(`Page error: ${error.message}`);
});
```

3. **Request Failures** (Lines 391-393):
```typescript
page.on('requestfailed', (request) => {
    CSReporter.debug(`Request failed: ${request.url()} - ${request.failure()?.errorText}`);
});
```

4. **Crash Detection** (Lines 396-401):
```typescript
page.on('crash', () => {
    CSReporter.error('Page crashed!');
    if (BROWSER_AUTO_RESTART_ON_CRASH) {
        this.handleCrash();
    }
});
```

#### 6. public async restartBrowser(): Promise<void> - Lines 448-473
**Purpose**: Restart browser with state preservation

**Algorithm**:
```typescript
1. Save state if BROWSER_RESTART_MAINTAIN_STATE is true:
   - Current URL
   - Cookies
   - localStorage
2. Close current browser
3. Increment restartCount
4. Launch browser again with same type
5. Restore state (navigate to URL)
```

**Max Restarts** (Lines 475-485):
```typescript
private async handleCrash(): Promise<void> {
    const maxRestarts = BROWSER_MAX_RESTART_ATTEMPTS; // Default: 3

    if (this.restartCount >= maxRestarts) {
        throw new Error('Browser crash recovery failed');
    }

    await this.restartBrowser();
}
```

#### 7. public async close(testStatus?: 'passed' | 'failed'): Promise<void> - Lines 644-803
**Purpose**: Close browser with artifact cleanup based on test status

**Algorithm**:
```typescript
1. Initialize artifact tracking
2. Handle trace recording:
   - Stop trace and save to file
   - Check TRACE_CAPTURE_MODE + testStatus
   - Delete trace if shouldDeleteArtifact() returns true
3. Handle video recording:
   - Get video path from page.video()
   - Check BROWSER_VIDEO mode + testStatus
   - Mark for deletion if shouldDeleteArtifact() returns true
4. Handle HAR file:
   - Check HAR_CAPTURE_MODE + testStatus
   - Mark for deletion if needed
5. Close page
6. Close context (triggers video/HAR save by Playwright)
7. Wait 2 seconds for video encoding to finish
8. Delete marked artifacts with retry logic (EBUSY handling)
9. Close browser if BROWSER_REUSE_ENABLED is false
```

**Artifact Cleanup Logic** (Lines 621-642):
```typescript
private shouldDeleteArtifact(captureMode: string, testStatus?: 'passed' | 'failed'): boolean {
    switch(captureMode) {
        case 'always':
            return false; // Never delete
        case 'on-failure-only':
        case 'on-failure':
        case 'retain-on-failure':
            return testStatus === 'passed'; // Delete if passed, keep if failed
        case 'on-pass-only':
        case 'on-pass':
            return testStatus === 'failed'; // Delete if failed, keep if passed
        case 'never':
        case 'off':
            return true; // Always delete
        default:
            return false; // Keep if unknown mode
    }
}
```

**Video Deletion with Retry** (Lines 760-780):
Handles EBUSY errors when video file is still locked by Playwright:
```typescript
for (const videoToDelete of this.videosToDelete) {
    let retries = 3;
    while (retries > 0) {
        try {
            if (fs.existsSync(videoToDelete)) {
                fs.unlinkSync(videoToDelete);
                break;
            }
        } catch (error) {
            retries--;
            if (retries > 0 && error.code === 'EBUSY') {
                await new Promise(resolve => setTimeout(resolve, 500));
            } else {
                break;
            }
        }
    }
}
```

#### 8. public async closeAll(finalStatus?: 'passed' | 'failed'): Promise<void> - Lines 805-933
**Purpose**: Close all browsers at end of test run (parallel/sequential)

**Browser Reuse Handling** (Lines 822-841):
When browser reuse is enabled, HAR file accumulates across all scenarios:
```typescript
// Determine final HAR status based on ALL test results
const shouldKeepHar = harCaptureMode === 'always' ||
                     (harCaptureMode === 'on-failure' && finalStatus === 'failed');

if (shouldKeepHar) {
    CSReporter.info(`HAR will be saved: ${this.currentHarPath}`);
} else {
    this.harsToDelete.push(this.currentHarPath);
}
```

**Video Cleanup for Browser Reuse** (Lines 850-888):
If all tests passed with reuse enabled, delete ALL videos:
```typescript
if (shouldDeleteVideosAfterClose) {
    const videoDir = dirs.videos;
    const videoFiles = fs.readdirSync(videoDir).filter(file =>
        file.endsWith('.webm') || file.endsWith('.mp4')
    );

    for (const videoFile of videoFiles) {
        // Delete with retry logic
    }
}
```

**Browser Pool Cleanup** (Lines 928-932):
```typescript
// Close all pooled browsers
for (const [type, browser] of this.browserPool) {
    await browser.close();
}
this.browserPool.clear();
```

#### 9. public async switchBrowser(...): Promise<void> - Lines 1145-1272
**Purpose**: Switch browser type during test execution

**Parameters**:
```typescript
browserType: 'chrome' | 'edge' | 'firefox' | 'webkit' | 'safari'
options?: {
    preserveUrl?: boolean;   // Navigate to current URL after switch (default: true)
    clearState?: boolean;    // Clear cookies/storage after switch (default: false)
}
```

**Use Cases**:
1. **Cross-browser testing** within single scenario
2. **Browser-specific feature testing**
3. **Testing with state preservation** (same site, different browser)

**Algorithm**:
```typescript
1. Validate browser type (must be in validBrowsers list)
2. Save current URL if preserveUrl is true
3. If switching to SAME browser type:
   a. If clearState is false → no action needed
   b. If clearState is true:
      - REUSE MODE: Clear state WITHOUT recreating context
      - NON-REUSE MODE: Full restart (close and relaunch)
4. If switching to DIFFERENT browser type:
   a. Close current page and context (saves artifacts)
   b. Close current browser
   c. Remove old browser from pool
   d. Launch new browser
   e. Navigate to previous URL if preserveUrl is true
   f. Restore state if shouldSaveState is true
```

**Browser Reuse Optimization** (Lines 1179-1184):
With browser reuse, switching to same browser just clears state:
```typescript
if (browserReuseEnabled) {
    // Clear state WITHOUT recreating context (maintains artifacts)
    await this.clearStateWithoutRecreatingContext(currentUrl, preserveUrl);
}
```

**Usage Example**:
```gherkin
Given I navigate to "https://example.com" using chrome
When I switch to edge browser
Then I should see the same page in edge
When I switch to chrome with cleared state
Then I should have a fresh browser session
```

#### 10. public async clearContextAndReauthenticate(...): Promise<void> - Lines 1304-1415
**Purpose**: Clear browser context for re-authentication scenarios

**Use Case**: Testing workflows requiring different user credentials (e.g., employee → manager → approver)

**Parameters**:
```typescript
options?: {
    loginUrl?: string;           // URL to navigate to after clearing (default: BASE_URL)
    skipNavigation?: boolean;    // Don't navigate, just clear (default: false)
    waitForNavigation?: boolean; // Wait for navigation to complete (default: true)
}
```

**What Gets Cleared**:
- Cookies (context.clearCookies())
- Permissions (context.clearPermissions())
- localStorage (page.evaluate())
- sessionStorage (page.evaluate())
- Saved browser state

**Browser Reuse Mode** (Lines 1324-1361):
```typescript
// Clear state WITHOUT recreating context
1. Navigate to about:blank
2. Clear cookies at context level
3. Clear permissions
4. Clear localStorage and sessionStorage
5. Clear saved browser state
```

**Non-Reuse Mode** (Lines 1363-1384):
```typescript
// Recreate context for full clean state
1. Close current page
2. Close current context (saves artifacts)
3. Create fresh context
4. Create fresh page
```

**Navigation** (Lines 1386-1414):
```typescript
if (!skipNavigation) {
    const targetUrl = loginUrl || config.get('BASE_URL');
    await page.goto(targetUrl, {
        timeout: BROWSER_NAVIGATION_TIMEOUT,
        waitUntil: waitForNavigation ? 'domcontentloaded' : undefined
    });
}
```

**Usage Example**:
```gherkin
Given I login as employee
When I submit a leave request
And I clear context and reauthenticate
And I login as manager
Then I should be able to approve the leave request
```

#### 11. Additional Utility Methods

**public getPage(): any** - Lines 935-940
- Returns current page instance
- Throws error if page not initialized

**public getContext(): any** - Lines 1027-1032
- Returns current context instance
- Throws error if context not initialized

**public getBrowser(): any** - Lines 1034-1039
- Returns current browser instance
- Throws error if browser not initialized

**public async waitForSpinnersToDisappear(timeout?: number)** - Lines 1053-1075
- Waits for loading spinners to disappear
- Uses `SPINNER_SELECTORS` config (semicolon-separated)
- Default selectors: `.spinner;.loader;.loading;.progress`

**public async navigateAndWaitReady(url, options?)** - Lines 1080-1092
- Navigate to URL
- Automatically wait for spinners if `WAIT_FOR_SPINNERS` is true

**public async getSessionArtifacts()** - Lines 1097-1127
- Returns all artifacts for current session
- Includes: screenshots, videos, traces, HAR files

**public clearBrowserState(): void** - Lines 942-945
- Clears saved browser state
- Cookies will not be restored on next context creation

### Artifact Capture Modes

**Video Capture** (BROWSER_VIDEO):
- `always` - Record all tests, keep all videos
- `on-failure` - Record all tests, delete videos for passed tests
- `on-pass` - Record all tests, delete videos for failed tests
- `never` / `off` - No video recording

**HAR Capture** (HAR_CAPTURE_MODE):
- `always` - Record all network traffic, keep all HAR files
- `on-failure` - Record all traffic, delete HAR for passed tests
- `on-failure-only` - Same as on-failure
- `retain-on-failure` - Same as on-failure
- `never` - No HAR recording

**Trace Capture** (TRACE_CAPTURE_MODE):
- `always` - Record all traces, keep all trace files
- `on-failure` - Record all traces, delete for passed tests
- `never` - No trace recording

### Browser Reuse Strategy

**How It Works**:
1. **Browser Instance**: Stays alive across multiple scenarios
2. **Context**: Recreated per scenario for isolation
3. **Page**: Can be reused or recreated
4. **Artifacts**: Accumulate or per-scenario based on config

**Performance Benefits**:
- Browser launch: ~3 seconds per scenario → ~3 seconds total
- Context creation: ~500ms per scenario
- **Net savings**: ~2.5 seconds per scenario

**Trade-offs**:
- **Pros**: Faster execution, less CPU usage
- **Cons**: Potential state leakage if not cleared properly, accumulated HAR file

**Configuration**:
```typescript
BROWSER_REUSE_ENABLED=true
BROWSER_REUSE_MAX_SCENARIOS=10  // Restart browser after N scenarios
BROWSER_REUSE_CLEAR_STATE=true  // Clear state between scenarios
```

### Configuration Properties

**Browser Launch**:
- `BROWSER` - Browser type: chrome, firefox, webkit, edge (default: chrome)
- `HEADLESS` - Headless mode (default: false)
- `BROWSER_LAUNCH_TIMEOUT` - Launch timeout in ms (default: 30000)
- `BROWSER_SLOWMO` - Slow down operations in ms (default: 0)
- `BROWSER_DEVTOOLS` - Open DevTools (default: false)

**Chrome-Specific**:
- `BROWSER_INCOGNITO` - Incognito mode (default: false)
- `BROWSER_DISABLE_GPU` - Disable GPU (default: false)
- `BROWSER_NO_SANDBOX` - No sandbox (default: false)
- `BROWSER_CHROME_ARGS` - Custom args (comma-separated)

**Firefox-Specific**:
- `BROWSER_PRIVATE` - Private browsing (default: false)
- `BROWSER_FIREFOX_ARGS` - Custom args (comma-separated)

**Viewport**:
- `BROWSER_VIEWPORT_WIDTH` - Viewport width in headless (default: 1920)
- `BROWSER_VIEWPORT_HEIGHT` - Viewport height in headless (default: 1080)

**Network**:
- `BROWSER_IGNORE_HTTPS_ERRORS` - Ignore HTTPS errors (default: true)
- `BROWSER_PROXY_ENABLED` - Enable proxy (default: false)
- `BROWSER_PROXY_SERVER` - Proxy server URL
- `BROWSER_PROXY_USERNAME` - Proxy username
- `BROWSER_PROXY_PASSWORD` - Proxy password
- `BROWSER_PROXY_BYPASS` - Proxy bypass list
- `BROWSER_OFFLINE` - Offline mode (default: false)
- `BROWSER_HTTP_USERNAME` - HTTP auth username
- `BROWSER_HTTP_PASSWORD` - HTTP auth password

**Localization**:
- `BROWSER_LOCALE` - Browser locale (default: en-US)
- `BROWSER_TIMEZONE` - Timezone ID (default: America/New_York)
- `BROWSER_GEOLOCATION_LAT` - Latitude
- `BROWSER_GEOLOCATION_LON` - Longitude
- `BROWSER_PERMISSIONS` - Permissions list (comma-separated)
- `BROWSER_COLOR_SCHEME` - Color scheme: light, dark (default: light)
- `BROWSER_REDUCED_MOTION` - Reduced motion: no-preference, reduce (default: no-preference)
- `BROWSER_FORCED_COLORS` - Forced colors: none, active (default: none)

**Customization**:
- `BROWSER_USER_AGENT` - Custom user agent
- `BROWSER_EXTRA_HEADERS` - Extra HTTP headers (JSON string)

**Artifacts**:
- `BROWSER_VIDEO` - Video mode: always, on-failure, on-pass, never, off (default: off)
- `BROWSER_VIDEO_WIDTH` - Video width (default: 1280)
- `BROWSER_VIDEO_HEIGHT` - Video height (default: 720)
- `HAR_CAPTURE_MODE` - HAR mode: always, on-failure, never (default: never)
- `BROWSER_HAR_ENABLED` - Enable HAR recording (deprecated, use HAR_CAPTURE_MODE)
- `BROWSER_HAR_OMIT_CONTENT` - Omit response content from HAR (default: false)
- `TRACE_CAPTURE_MODE` - Trace mode: always, on-failure, never (default: never)
- `BROWSER_TRACE_ENABLED` - Enable trace recording (deprecated, use TRACE_CAPTURE_MODE)
- `CONSOLE_LOG_CAPTURE` - Capture console logs (default: true)

**Timeouts**:
- `BROWSER_ACTION_TIMEOUT` - Default action timeout (default: 10000)
- `BROWSER_NAVIGATION_TIMEOUT` - Navigation timeout (default: 30000)
- `BROWSER_AUTO_WAIT_TIMEOUT` - Auto-wait timeout (default: 5000)

**Browser Reuse**:
- `BROWSER_REUSE_ENABLED` - Enable browser reuse (default: false)
- `BROWSER_REUSE_MAX_SCENARIOS` - Max scenarios per browser (default: unlimited)
- `BROWSER_REUSE_CLEAR_STATE` - Clear state between scenarios (default: false)

**Crash Recovery**:
- `BROWSER_AUTO_RESTART_ON_CRASH` - Auto-restart on crash (default: true)
- `BROWSER_MAX_RESTART_ATTEMPTS` - Max restart attempts (default: 3)
- `BROWSER_RESTART_MAINTAIN_STATE` - Maintain state after restart (default: true)

**Spinners**:
- `SPINNER_SELECTORS` - Spinner selectors (semicolon-separated, default: .spinner;.loader;.loading;.progress)
- `WAIT_FOR_SPINNERS` - Auto-wait for spinners (default: true)

**Worker Threading**:
- `USE_WORKER_THREADS` - Enable parallel workers (default: false)
- `WORKER_ID` - Environment variable set by parallel runner (auto)

### Integration Points

**Integrates With**:
1. **CSBDDRunner** - Browser lifecycle management during scenario execution
2. **CSTestResultsManager** - Directory structure for artifacts
3. **CSConfigurationManager** - All browser configuration properties
4. **CSReporter** - Logging and debugging
5. **CSWebElement** - Page instance for element operations
6. **CSBasePage** - Page object model base class

**Used By**:
- CSBDDRunner (scenario execution)
- CSBasePage (page object model)
- Step definitions (direct browser access)

### Best Practices

1. **Always Use Browser Reuse for Fast Tests**:
```typescript
BROWSER_REUSE_ENABLED=true
BROWSER_REUSE_CLEAR_STATE=true
```

2. **Capture Artifacts on Failure Only**:
```typescript
BROWSER_VIDEO=on-failure
HAR_CAPTURE_MODE=on-failure
TRACE_CAPTURE_MODE=on-failure
```

3. **Use Worker-Aware Instances in Parallel Mode**:
```typescript
// Each worker gets isolated instance automatically
const browserManager = CSBrowserManager.getInstance();
```

4. **Handle Browser Switching Carefully**:
```typescript
// Preserve URL when switching
await browserManager.switchBrowser('edge', { preserveUrl: true });

// Clear state when switching
await browserManager.switchBrowser('chrome', { clearState: true });
```

5. **Clear Context for Re-authentication**:
```typescript
// Clear and navigate to login page
await browserManager.clearContextAndReauthenticate();

// Clear without navigation (manual login flow)
await browserManager.clearContextAndReauthenticate({ skipNavigation: true });
```

### Common Issues and Solutions

**Issue 1: Video files not deleted**
- **Cause**: Playwright still encoding video
- **Solution**: close() method waits 2 seconds before deletion (Line 755)

**Issue 2: HAR file accumulates in browser reuse mode**
- **Cause**: HAR records all scenarios until context closes
- **Solution**: This is expected behavior. HAR saved in closeAll() based on final status

**Issue 3: Browser crashes in parallel mode**
- **Cause**: Shared singleton causing conflicts
- **Solution**: Worker-aware singleton creates isolated instances per worker

**Issue 4: State leakage between scenarios**
- **Cause**: Browser reuse without clearing state
- **Solution**: Set `BROWSER_REUSE_CLEAR_STATE=true`

**Issue 5: Browser not launching in CI/CD**
- **Cause**: Missing dependencies or sandbox issues
- **Solution**: Set `BROWSER_NO_SANDBOX=true` for containerized environments

### Performance Optimizations

1. **Lazy Loading**: Playwright loaded only when first browser launches (saves 27s)
2. **Browser Reuse**: Browser instance reused across scenarios (saves ~2.5s per scenario)
3. **Context Pooling**: Browser pool for multiple browser types
4. **Artifact Cleanup**: Automatic deletion of unnecessary artifacts (saves disk space)
5. **Worker Isolation**: Each worker has independent browser instance (no contention)

---

**Completed: 7/20+ components**
**Total Lines Documented: 7,354 (8.3% of 89,095)**

---

## 8. Web Element - CSWebElement (Universal Element Wrapper)

**File**: `src/element/CSWebElement.ts` (1,822 lines)

### Architecture
**Pattern**: Fluent API Wrapper with Self-Healing
**Purpose**: Complete Playwright Locator API wrapper with 200+ methods, self-healing, retry logic, and performance tracking

### Core Capabilities
- **59+ Playwright methods** - Full coverage of Playwright Locator API
- **200+ convenience methods** - Shortcuts for common operations
- **Self-healing** - AI-powered element detection with alternative locators
- **Auto-retry** - Configurable retry logic for flaky element detection
- **Performance tracking** - Measure action execution times
- **Screenshot integration** - Auto-capture on actions
- **Multiple selectors** - CSS, XPath, text, ID, role, testId, name

### Properties

**Core State**:
- `private page: Page` - Playwright page instance
- `private locator: Locator | null` - Cached locator instance
- `private description: string` - Element description for logging
- `private options: ElementOptions` - Element configuration
- `private config: CSConfigurationManager` - Framework configuration
- `private selfHealingEngine: CSSelfHealingEngine` - AI self-healing engine
- `private retryCount: number` - Retry attempts (default: 3)
- `private actionTimeout: number` - Action timeout (default: 10000ms)
- `private performanceMetrics: Map<string, number[]>` - Action performance tracking

### Element Options Interface

```typescript
interface ElementOptions {
    // Selectors
    css?: string;
    xpath?: string;
    text?: string;
    id?: string;
    name?: string;
    role?: string;
    testId?: string;

    // Metadata
    description?: string;
    tags?: string[];

    // Wait options
    timeout?: number;
    waitForVisible?: boolean;
    waitForEnabled?: boolean;
    waitForStable?: boolean;

    // Behavior
    scrollIntoView?: boolean;
    retryCount?: number;
    selfHeal?: boolean;
    alternativeLocators?: string[];
    screenshot?: boolean;
    highlight?: boolean;
    force?: boolean;

    // Performance
    measurePerformance?: boolean;

    // Debugging
    debug?: boolean;
}
```

### Locator Strategy System

#### 1. private async getLocator(): Promise<Locator> - Lines 322-401
**Purpose**: Get locator with self-healing fallback

**Algorithm**:
```typescript
1. If locator cached → return cached locator
2. Build locator strategies from options:
   - Priority order: ID → testId → CSS → XPath → text → name → role
   - Add alternative locators to strategy list
3. Try each strategy in order:
   a. Create locator from strategy
   b. Check if element exists (locator.count() > 0)
   c. If found:
      - Cache locator
      - Record AI healing if alternative locator used
      - Return locator
4. If all strategies fail:
   - Try AI self-healing via CSSelfHealingEngine
   - If healed:
      - Cache healed locator
      - Record AI healing metrics
      - Return healed locator
5. If everything fails → throw error
```

**Self-Healing Integration** (Lines 340-357):
```typescript
// Alternative locator used (manual self-healing)
if (strategyIndex > 0) {
    CSReporter.pass(`🔧 Self-healed element using ${strategy.type}: ${strategy.value}`);
    CSReporter.recordAIHealing({
        attempted: true,
        success: true,
        strategy: 'alternative',
        confidence: 1.0,
        duration: healingDuration,
        originalLocator: primaryStrategy.value,
        healedLocator: `${strategy.type}:${strategy.value}`,
        attempts: strategyIndex + 1
    });
}
```

**AI Self-Healing** (Lines 370-397):
```typescript
const healingResult = await this.selfHealingEngine.heal(
    this.page,
    primaryStrategy.value,
    this.options.alternativeLocators
);

if (healingResult.success) {
    this.locator = this.page.locator(healingResult.healedLocator);
    CSReporter.pass(`🤖 AI-healed element using ${healingResult.strategy}: ${healingResult.healedLocator}`);
    CSReporter.recordAIHealing({
        attempted: true,
        success: true,
        strategy: healingResult.strategy,
        confidence: (healingResult.confidence || 70) / 100,
        duration: healingDuration,
        originalLocator: primaryStrategy.value,
        healedLocator: healingResult.healedLocator,
        attempts: strategies.length + 1
    });
}
```

#### 2. private buildLocatorStrategies(): Array<{type, value}> - Lines 403-423
**Purpose**: Build priority-ordered locator strategies

**Priority Order**:
1. ID (`#elementId`)
2. Test ID (`[data-testid="value"]`)
3. CSS selector
4. XPath
5. Text content
6. Name attribute
7. ARIA role
8. Alternative locators (with type detection)

#### 3. private parseAlternativeLocator(locator: string) - Lines 425-442
**Purpose**: Parse alternative locators with prefix notation

**Supported Prefixes**:
- `xpath:` → XPath selector
- `css:` → CSS selector
- `text:` → Text content
- `testId:` → Test ID
- `role:` → ARIA role
- `placeholder:` → Placeholder text
- No prefix → Default to CSS

### Action Execution Framework

#### private async executeAction<T>(...): Promise<T> - Lines 468-526
**Purpose**: Execute actions with retry, reporting, and performance tracking

**Features**:
1. **Auto-retry** - Configurable retry count with progressive delay
2. **Element highlighting** - Visual feedback if configured
3. **Performance tracking** - Measure execution time
4. **Action reporting** - Track pass/fail for test reports
5. **Screenshot capture** - Auto-capture on configured actions
6. **Error handling** - Graceful failure with detailed logging

**Algorithm**:
```typescript
1. Record start time
2. For each retry attempt (1 to retryCount):
   a. Highlight element if configured
   b. Execute the action
   c. Track performance if enabled
   d. Record action in reporter
   e. Take screenshot if configured
   f. Return result on success
   g. On failure:
      - Log warning with attempt number
      - Wait with progressive delay (1s * attempt)
      - Continue to next attempt
3. If all attempts fail:
   - Record failed action in reporter
   - Throw last error
```

**Progressive Delay** (Line 519):
```typescript
await this.page.waitForTimeout(1000 * attempt); // 1s, 2s, 3s...
```

### Method Categories (200+ Methods)

#### 1. Click Methods (15 methods) - Lines 539-604
**Core Method**: `async click(options?: ClickOptions): Promise<void>`

**Convenience Methods**:
- `clickWithButton(button)` - Left, right, or middle click
- `clickWithPosition(x, y)` - Click at specific coordinates
- `clickWithModifiers(modifiers[])` - Click with Alt/Ctrl/Meta/Shift
- `clickMultipleTimes(count)` - Multi-click
- `clickWithDelay(ms)` - Click with delay
- `clickWithForce()` - Force click (bypass actionability checks)
- `clickWithTimeout(ms)` - Custom timeout
- `clickWithoutWaiting()` - No wait after click
- `clickWithTrial()` - Trial click (no action, just check)
- `rightClick()` - Context menu click
- `middleClick()` - Middle mouse button click

#### 2. Double Click Methods (6 methods) - Lines 609-639
**Core**: `async dblclick(options?: DblClickOptions)`

**Variants**: Position, modifiers, force, timeout, delay

#### 3. Tap Methods (5 methods) - Lines 645-670
**Core**: `async tap(options?: TapOptions)`
**Purpose**: Mobile touch interactions

#### 4. Hover Methods (5 methods) - Lines 676-701
**Core**: `async hover(options?: HoverOptions)`

**Variants**: Position, modifiers, force, timeout

#### 5. Drag Methods (4 methods) - Lines 707-730
**Core**: `async dragTo(target: Locator | CSWebElement, options?)`

**Features**:
- Accepts both Playwright Locator and CSWebElement as target
- Source/target position customization
- Force drag option

#### 6. Focus & Blur Methods (4 methods) - Lines 736-758
**Methods**: `focus()`, `focusWithTimeout()`, `blur()`, `blurWithTimeout()`

#### 7. Keyboard Methods (9 methods) - Lines 764-819
**Core Methods**:
- `press(key, options)` - Press single key
- `pressSequentially(text, options)` - Type character by character
- `type(text, options)` - Type text with auto-clear

**Type Method Enhancement** (Lines 798-814):
```typescript
async type(text: string, options?: TypeOptions) {
    // Auto-clear before typing if configured
    if (this.config.getBoolean('ELEMENT_CLEAR_BEFORE_TYPE', true)) {
        await locator.clear();
    }
    await locator.type(text, options);
}
```

**Convenience Methods**: With delay, timeout, without waiting

#### 8. Input Methods (6 methods) - Lines 825-862
**Core Methods**:
- `fill(value, options)` - Fill input/textarea
- `clear(options)` - Clear input value

**Convenience**: Force fill, fill with timeout, clear with force

#### 9. Select Methods (6 methods) - Lines 868-907
**Core**: `selectOption(values, options)` - Select dropdown options

**Selection Strategies**:
- `selectOptionByValue(value)` - By option value attribute
- `selectOptionByLabel(label)` - By visible text
- `selectOptionByIndex(index)` - By index (0-based)
- `selectText(options)` - Select text content

**Usage Example**:
```typescript
// Select by value
await dropdown.selectOptionByValue('option1');

// Select by label
await dropdown.selectOptionByLabel('Option One');

// Select multiple
await dropdown.selectOption(['opt1', 'opt2']);
```

#### 10. File Upload Methods (4 methods) - Lines 913-933
**Core**: `setInputFiles(files, options)`

**Convenience**:
- `uploadFile(filePath)` - Upload single file
- `uploadFiles(filePaths[])` - Upload multiple files
- `clearFiles()` - Clear file input

#### 11. Checkbox & Radio Methods (7 methods) - Lines 939-978
**Core Methods**:
- `check(options)` - Check checkbox/radio
- `uncheck(options)` - Uncheck checkbox
- `setChecked(boolean, options)` - Set checked state

**Convenience**: Force check/uncheck, check at position

#### 12. Content Retrieval Methods (9 methods) - Lines 984-1056
**Core Methods**:
- `textContent(options)` - Get text content (may be null)
- `innerText(options)` - Get inner text (visible text only)
- `innerHTML(options)` - Get inner HTML
- `getAttribute(name, options)` - Get attribute value
- `inputValue(options)` - Get input field value
- `allTextContents()` - Get all matching elements' text
- `allInnerTexts()` - Get all matching elements' inner text

**Usage Example**:
```typescript
const text = await element.textContent();
const value = await input.inputValue();
const href = await link.getAttribute('href');
```

#### 13. State Check Methods (12 methods) - Lines 1062-1132
**Boolean State Methods**:
- `isChecked(options)` - Check if checked
- `isDisabled(options)` - Check if disabled
- `isEditable(options)` - Check if editable
- `isEnabled(options)` - Check if enabled
- `isHidden(options)` - Check if hidden
- `isVisible(options)` - Check if visible

All have `*WithTimeout(ms)` variants

#### 14. Wait Methods (5 methods) - Lines 1138-1163
**Core**: `waitFor(options)` - Wait for element state

**Convenience**:
- `waitForAttached(timeout)` - Wait for attached to DOM
- `waitForDetached(timeout)` - Wait for removed from DOM
- `waitForVisible(timeout)` - Wait for visible
- `waitForHidden(timeout)` - Wait for hidden

#### 15. Evaluation Methods (3 methods) - Lines 1169-1194
**Purpose**: Execute JavaScript in element context

**Methods**:
- `evaluate(fn, arg, options)` - Evaluate function on single element
- `evaluateAll(fn, arg)` - Evaluate on all matching elements
- `evaluateHandle(fn, arg, options)` - Get JSHandle to result

**Usage Example**:
```typescript
// Get element's computed style
const color = await element.evaluate(el => getComputedStyle(el).color);

// Click via JavaScript
await element.evaluate(el => el.click());
```

#### 16. Location Methods (5 methods) - Lines 1200-1239
**Methods**:
- `boundingBox(options)` - Get { x, y, width, height } or null
- `screenshot(options)` - Take element screenshot
- `screenshotToFile(path, options)` - Save screenshot to file
- `screenshotFullPage()` - Full page screenshot
- `scrollIntoViewIfNeeded(options)` - Scroll element into view

#### 17. Element Query Methods (6 methods) - Lines 1245-1298
**Methods**:
- `count()` - Count matching elements
- `all()` - Get all matching Playwright Locators
- `first()` - Get first matching element as CSWebElement
- `last()` - Get last matching element
- `nth(index)` - Get nth element (0-based)
- `filter(options)` - Filter elements
- `subLocator(selector, options)` - Get child locator

**Usage Example**:
```typescript
const count = await table.count(); // Number of rows
const firstRow = table.first();
const lastRow = table.last();
const thirdRow = table.nth(2);
const visibleRows = table.filter({ hasText: 'Active' });
```

#### 18. Logical Operators (2 methods) - Lines 1304-1322
**Methods**:
- `and(locator)` - Logical AND (element matches both conditions)
- `or(locator)` - Logical OR (element matches either condition)

**Usage Example**:
```typescript
// Find button that is both visible AND enabled
const button = element.and(page.locator(':visible')).and(page.locator(':enabled'));
```

#### 19. Locator Creation Methods (7 methods) - Lines 1328-1396
**Purpose**: Create child locators with semantic selectors

**Methods**:
- `getByAltText(text, options)` - By image alt text
- `getByLabel(text, options)` - By form label
- `getByPlaceholder(text, options)` - By input placeholder
- `getByRole(role, options)` - By ARIA role
- `getByTestId(testId)` - By test ID attribute
- `getByText(text, options)` - By text content
- `getByTitle(text, options)` - By title attribute

**Usage Example**:
```typescript
const submitButton = form.getByRole('button', { name: 'Submit' });
const emailInput = form.getByLabel('Email Address');
const searchBox = page.getByPlaceholder('Search...');
```

#### 20. Frame Methods (2 methods) - Lines 1402-1411
**Methods**:
- `frameLocator(selector)` - Get frame locator
- `contentFrame()` - Get content frame of iframe element

#### 21. Other Methods (5 methods) - Lines 1417-1479
**Methods**:
- `getPage()` - Get page instance
- `highlight()` - Highlight element visually
- `dispatchEvent(type, eventInit, options)` - Dispatch DOM event
- `getPerformanceMetrics()` - Get action performance statistics
- `clearPerformanceMetrics()` - Clear tracked metrics

**Performance Metrics Structure**:
```typescript
Map<string, {
    avg: number;    // Average duration
    min: number;    // Minimum duration
    max: number;    // Maximum duration
    count: number;  // Number of executions
}>
```

### CSElements Class (Multiple Elements)

**Purpose**: Handle collections of elements uniformly
**Lines**: 1485-1581

**Methods**:
- `async getAll()` - Get all elements as CSWebElement[]
- `async count()` - Count elements
- `async clickAll()` - Click all elements sequentially
- `async fillAll(value)` - Fill all inputs with same value
- `async getTexts()` - Get text content from all elements
- `async getValues()` - Get input values from all elements
- `async checkAll()` - Check all checkboxes
- `async uncheckAll()` - Uncheck all checkboxes

**Usage Example**:
```typescript
const checkboxes = new CSElements({ css: 'input[type="checkbox"]' });
await checkboxes.checkAll();
const texts = await checkboxes.getTexts();
```

### Dynamic Element Creation (14 Factory Methods)

**Purpose**: Create elements dynamically without Page Objects
**Lines**: 1586-1822

#### Static Factory Methods (Lines 1593-1808):

1. **createByCSS(selector, description?, page?)** - Create by CSS selector
2. **createByXPath(xpath, description?, page?)** - Create by XPath
3. **createByText(text, exact?, description?, page?)** - Create by text
4. **createById(id, description?, page?)** - Create by ID
5. **createByName(name, description?, page?)** - Create by name attribute
6. **createByRole(role, description?, page?)** - Create by ARIA role
7. **createByTestId(testId, description?, page?)** - Create by test ID
8. **create(options, page?)** - Create with custom options
9. **createWithTemplate(template, values, description?, page?)** - Template with placeholders
10. **createMultiple(selector, description?, page?)** - Create array of elements
11. **createTableCell(tableSelector, row, col, description?, page?)** - Create table cell
12. **createByLabel(labelText, fieldType, description?, page?)** - Create by form label
13. **createChained(selectors[], description?, page?)** - Chain selectors
14. **createWithFilter(selector, filters, description?, page?)** - Create with filters
15. **createNth(selector, index, description?, page?)** - Create nth element

**Usage Examples**:
```typescript
// Dynamic CSS creation
const button = CSElements.createByCSS('button.submit', 'Submit Button');
await button.click();

// Template with placeholders
const cell = CSElements.createWithTemplate(
    'td[data-row="{row}"][data-col="{col}"]',
    { row: '5', col: '3' }
);

// Table cell access
const cell = CSElements.createTableCell('table.data', 3, 4);
const value = await cell.textContent();

// Create by label (forms)
const emailInput = CSElements.createByLabel('Email Address', 'input');
await emailInput.fill('test@example.com');

// Filtered creation
const activeUsers = CSElements.createWithFilter('tr.user', {
    hasText: 'Active',
    visible: true,
    enabled: true
});

// Multiple elements
const allButtons = await CSElements.createMultiple('button', 'All Buttons');
for (const button of allButtons) {
    await button.click();
}
```

### Configuration Properties

**Element Behavior**:
- `ELEMENT_RETRY_COUNT` - Retry attempts for element operations (default: 3)
- `ELEMENT_TIMEOUT` - Element action timeout in ms (default: 10000)
- `ELEMENT_CLEAR_BEFORE_TYPE` - Auto-clear before typing (default: true)

**Self-Healing**:
- Element-level `selfHeal` option (default: false)
- `alternativeLocators` array for fallback strategies

### Integration Points

**Integrates With**:
1. **CSBrowserManager** - Get page instance
2. **CSSelfHealingEngine** - AI-powered element healing
3. **CSReporter** - Action logging and AI healing metrics
4. **CSConfigurationManager** - Element configuration
5. **CSBasePage** - Page object model base class

**Used By**:
- CSBasePage (page object elements)
- Step definitions (direct element access)
- Zero-code testing (dynamic element creation)

### Best Practices

1. **Always Provide Description**:
```typescript
const loginButton = new CSWebElement({
    css: 'button#login',
    description: 'Login Button' // Helps with logging and debugging
});
```

2. **Use Self-Healing for Critical Elements**:
```typescript
const submitButton = new CSWebElement({
    css: 'button.submit',
    selfHeal: true,
    alternativeLocators: [
        'xpath://button[contains(text(), "Submit")]',
        'css:button[type="submit"]',
        'testId:submit-btn'
    ],
    description: 'Submit Button'
});
```

3. **Leverage Convenience Methods**:
```typescript
// Instead of:
await element.click({ force: true, timeout: 5000 });

// Use:
await element.clickWithForce();
await element.clickWithTimeout(5000);
```

4. **Use Dynamic Creation for Ad-hoc Elements**:
```typescript
// Don't create Page Object for one-off elements
const notification = CSElements.createByCSS('.notification.success');
const message = await notification.textContent();
```

5. **Track Performance for Critical Paths**:
```typescript
const searchButton = new CSWebElement({
    css: 'button.search',
    measurePerformance: true
});

await searchButton.click();
const metrics = searchButton.getPerformanceMetrics();
// { Click: { avg: 150, min: 120, max: 200, count: 1 } }
```

### Common Issues and Solutions

**Issue 1: Element not found despite being visible**
- **Cause**: Timing issue, element not yet in DOM
- **Solution**: Use `waitForVisible()` before interaction
```typescript
await element.waitForVisible(5000);
await element.click();
```

**Issue 2: Click fails with "element is not actionable"**
- **Cause**: Element covered by another element
- **Solution**: Use `clickWithForce()` or `scrollIntoViewIfNeeded()`
```typescript
await element.scrollIntoViewIfNeeded();
await element.click();
// OR
await element.clickWithForce();
```

**Issue 3: Flaky element detection**
- **Cause**: Dynamic DOM, changing IDs/classes
- **Solution**: Enable self-healing with alternative locators
```typescript
const element = new CSWebElement({
    css: '#dynamic-id-123',
    selfHeal: true,
    alternativeLocators: [
        'xpath://div[@data-testid="stable-id"]',
        'text:Expected Text Content'
    ]
});
```

**Issue 4: Type not clearing previous value**
- **Cause**: `type()` doesn't auto-clear by default in some cases
- **Solution**: Use `fill()` or enable auto-clear
```typescript
await input.fill('new value'); // Always clears first
// OR
config.set('ELEMENT_CLEAR_BEFORE_TYPE', 'true');
```

**Issue 5: Screenshot not capturing element**
- **Cause**: Element not in viewport
- **Solution**: Scroll into view first
```typescript
await element.scrollIntoViewIfNeeded();
await element.screenshot({ path: 'element.png' });
```

### Performance Optimizations

1. **Locator Caching**: First locator resolution cached, subsequent calls instant
2. **Lazy Loading**: CSBrowserManager loaded only when page needed
3. **Progressive Retry Delay**: Smart backoff (1s, 2s, 3s) prevents excessive retries
4. **Selective Metrics**: Performance tracking optional (disabled by default)
5. **Shared Instances**: CSElements reuses CSWebElement instances efficiently

---

**Completed: 8/20+ components**
**Total Lines Documented: 9,176 (10.3% of 89,095)**

**Phase 2: Background Steps** (Lines 1235-1260)
```typescript
// Execute background steps (run before each scenario)
if (feature.background) {
    CSReporter.info('Executing background steps');
    
    for (const step of feature.background.steps) {
        await this.executeStep(step, options);
    }
}
```

**Phase 3: Scenario Steps** (Lines 1265-1350)
```typescript
// Execute scenario steps
for (const step of scenario.steps) {
    try {
        // Before step hooks
        await this.runHooks('beforeStep', { step, scenario });
        
        // Execute step
        await this.executeStep(step, options);
        
        // After step hooks
        await this.runHooks('afterStep', { step, scenario, status: 'passed' });
        
    } catch (error) {
        // Step failed
        this.handleStepFailure(step, error, scenario, options);
        
        if (options.failFast) {
            throw error;  // Stop execution
        }
    }
}
```

**Phase 4: Post-Execution Cleanup** (Lines 1655-1771)
```typescript
// Capture artifacts if scenario failed
if (scenarioFailed && requirements.browser) {
    await this.captureFailureArtifacts(scenario, feature);
}

// Browser cleanup
const reuseEnabled = this.config.getBoolean('BROWSER_REUSE_ENABLED', false);

if (!reuseEnabled) {
    // Close browser completely
    await this.browserManager.close();
} else {
    // Keep browser, close page/context
    await this.browserManager.closePage();
    await this.browserManager.closeContext();
    this.scenarioCountForReuse++;
    
    // Restart browser every N scenarios
    const reuseMax = this.config.getNumber('BROWSER_REUSE_MAX_SCENARIOS', 10);
    if (this.scenarioCountForReuse >= reuseMax) {
        await this.browserManager.close();
        this.scenarioCountForReuse = 0;
    }
}

// Update scenario result
this.currentScenario.status = scenarioFailed ? 'failed' : 'passed';
this.currentScenario.duration = Date.now() - scenarioStartTime;

// Track counters
if (scenarioFailed) {
    this.failedCount++;
    this.anyTestFailed = true;
} else {
    this.passedCount++;
}
```

### Step Execution

#### `private async executeStep(step, options, exampleRow?, exampleHeaders?): Promise<void>` - Lines 1772-1907

**Purpose**: Execute a single step and match to step definition

**Process**:

**1. Step Text Interpolation** (Lines 1775-1790)
```typescript
let stepText = step.text;

// Replace example placeholders <column>
if (exampleRow && exampleHeaders) {
    for (let i = 0; i < exampleHeaders.length; i++) {
        const placeholder = `<${exampleHeaders[i]}>`;
        const value = exampleRow[i] || '';
        stepText = stepText.replace(new RegExp(placeholder, 'g'), value);
    }
}
```

**2. Step Definition Matching & Execution** (Lines 1792-1810)
```typescript
// Execute step through decorator system
const dataTable = step.dataTable ? new DataTable(step.dataTable) : undefined;

try {
    await executeStep(
        stepText,
        step.keyword.trim(),
        this.context,
        dataTable?.raw(),
        step.docString
    );
    
    // Step passed
    this.passedSteps++;
    this.addStepToReport(step, 'passed', Date.now() - stepStartTime);
    
} catch (error) {
    // Step failed or not found
    this.failedSteps++;
    this.addStepToReport(step, 'failed', Date.now() - stepStartTime, error);
    throw error;
}
```

**3. Self-Healing on Failure** (Lines 1815-1905)
```typescript
// If step failed, try self-healing
if (error.message.includes('Element not found') ||
    error.message.includes('Timeout')) {
    
    if (this.config.getBoolean('SELF_HEALING_ENABLED', true)) {
        CSReporter.info('Attempting self-healing...');
        
        try {
            // Extract locator from step text
            const locator = await this.extractLocator(stepText);
            
            // Try AI-powered element detection
            const aiElement = await this.findElementWithAI(locator);
            
            if (aiElement) {
                // Retry step with healed locator
                await executeStep(
                    stepText.replace(locator, aiElement),
                    step.keyword.trim(),
                    this.context,
                    dataTable?.raw(),
                    step.docString
                );
                
                CSReporter.success('Self-healing successful!');
                this.passedSteps++;
                return;
            }
        } catch (healError) {
            CSReporter.warn(`Self-healing failed: ${healError.message}`);
        }
    }
}
```

### Parallel Execution

#### `private async runWithParallel(features, options): Promise<void>` - Lines 620-850

**Purpose**: Distribute scenarios across worker processes

**Process**:

**1. Worker Pool Setup** (Lines 625-645)
```typescript
const workerCount = typeof options.parallel === 'number' 
    ? options.parallel 
    : this.config.getNumber('MAX_PARALLEL_WORKERS', 3);

const { CSWorkerManager } = require('../parallel/CSWorkerManager');
const workerManager = new CSWorkerManager({
    maxWorkers: workerCount,
    timeout: this.config.getNumber('WORKER_TIMEOUT', 300000),
    retryAttempts: this.config.getNumber('WORKER_RETRY_ATTEMPTS', 2)
});

CSReporter.info(`Starting parallel execution with ${workerCount} workers`);
```

**2. Scenario Distribution** (Lines 650-710)
```typescript
// Flatten all scenarios
const allScenarios: Array<{scenario, feature}> = [];
for (const feature of features) {
    for (const scenario of feature.scenarios) {
        allScenarios.push({ scenario, feature });
    }
}

// Distribute round-robin
const workerTasks: Array<Array<{scenario, feature}>> = Array.from(
    { length: workerCount },
    () => []
);

for (let i = 0; i < allScenarios.length; i++) {
    const workerIndex = i % workerCount;
    workerTasks[workerIndex].push(allScenarios[i]);
}

CSReporter.debug(`Distributed ${allScenarios.length} scenarios across ${workerCount} workers`);
```

**3. Worker Execution** (Lines 715-780)
```typescript
// Execute workers in parallel
const workerPromises = workerTasks.map((tasks, workerId) => {
    return workerManager.executeWorker(workerId, tasks, options);
});

const workerResults = await Promise.all(workerPromises);

// Aggregate results
for (const result of workerResults) {
    this.passedCount += result.passed;
    this.failedCount += result.failed;
    this.skippedCount += result.skipped;
    this.passedSteps += result.passedSteps;
    this.failedSteps += result.failedSteps;
    this.testResults.scenarios.push(...result.scenarios);
}
```

### Configuration Properties Used

| Property | Default | Purpose |
|----------|---------|---------|
| `PARALLEL` | `1` | Parallel worker count |
| `MAX_PARALLEL_WORKERS` | `3` | Max workers |
| `BROWSER_REUSE_ENABLED` | `false` | Reuse browser between scenarios |
| `BROWSER_REUSE_MAX_SCENARIOS` | `10` | Restart browser after N scenarios |
| `SELF_HEALING_ENABLED` | `true` | Enable self-healing |
| `SCREENSHOT_ON_FAILURE` | `true` | Capture screenshot on failure |
| `VIDEO` | `retain-on-failure` | Video recording mode |
| `HAR_ENABLED` | `false` | Capture network HAR |
| `TRACE_ENABLED` | `false` | Playwright trace |
| `REPORT_TYPES` | `html,json` | Report formats |
| `ADO_ENABLED` | `false` | Azure DevOps sync |
| `FAIL_FAST` | `false` | Stop on first failure |
| `RETRY_COUNT` | `0` | Retry failed scenarios |

### Integration Points

**Orchestrates**:
1. `CSBDDEngine` - Feature parsing
2. `CSModuleDetector` - Module detection
3. `CSStepLoader` - Step loading
4. `CSBrowserManager` - Browser management
5. `CSDataProvider` - External data
6. `CSReporter` - Logging
7. `CSTestResultsManager` - Report generation
8. `CSADOIntegration` - Azure DevOps
9. `CSAIIntegrationLayer` - AI features
10. `CSWorkerManager` - Parallel execution

### Performance Optimizations

1. **Lazy Loading**: Saves ~60s startup time
2. **Selective Step Loading**: Only loads required step files
3. **Module Detection**: Skip unused modules (browser/API/DB)
4. **Browser Reuse**: Reuse browser across scenarios
5. **Parallel Execution**: Run scenarios concurrently
6. **Incremental Reporting**: Stream results during execution

### Best Practices

1. **Use Parallel Execution for Large Suites**
   ```bash
   npm test -- --parallel --workers=4
   ```

2. **Enable Browser Reuse for Speed**
   ```env
   BROWSER_REUSE_ENABLED=true
   BROWSER_REUSE_MAX_SCENARIOS=10
   ```

3. **Configure Fail-Fast for Development**
   ```env
   FAIL_FAST=true  # Stop on first failure
   ```

4. **Enable Self-Healing**
   ```env
   SELF_HEALING_ENABLED=true
   ```

5. **Optimize Artifact Collection**
   ```env
   SCREENSHOT_ON_FAILURE=true
   VIDEO=retain-on-failure  # Not 'always'
   ```

---

**Completed: 6/20+ components**
**Total Lines Documented: 5,938 (6.7% of 89,095)**

**Remaining Major Components**:
- CSBrowserManager (1,415 lines)
- CSWebElement (1,822 lines)  
- CSBasePage & CSPageFactory (604 lines)
- API Testing Components (~2,000 lines)
- Database Components (~1,500 lines)
- Reporting (~2,000 lines)

**Decision Point**: Continue with remaining components or pivot to README writing based on comprehensive analysis completed so far?

