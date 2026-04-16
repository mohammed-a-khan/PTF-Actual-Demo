---
name: helper-patterns
description: >
  Canonical patterns for creating helper utility classes in the
  target test framework. Covers when to create a helper vs reuse
  a framework utility, file placement, static class shape, single
  responsibility rule, stateless discipline, typed return values,
  dependency rules, and forbidden patterns. Load when generating,
  auditing, or healing any helper file under test/<project>/helpers/.
---

# Helper Patterns

## When this skill applies

Any generated or modified helper file under
`test/<project>/helpers/`. Helpers are project-specific utility
classes that wrap common operations so step definitions and page
objects stay focused.

## When to create a helper (and when not to)

### Create a helper when:

- The same database query or transformation is called from
  multiple step definition files
- The same API setup or teardown is needed across scenarios
- A business domain operation (e.g., "create a test customer
  with default profile and one active order") is used by many
  tests
- Legacy source has a support class with methods actually used
  by the tests being migrated
- Complex data manipulation logic (parsing a specific file
  format, computing a derived value) is needed

### Do NOT create a helper when:

- The framework already exposes a utility method for what you
  need. Check `CSStringUtility`, `CSDateTimeUtility`,
  `CSArrayUtility`, `CSMapUtility`, `CSCsvUtility`,
  `CSExcelUtility`, `CSComparisonUtility`, `CSValueResolver`
  first. If the framework has it, import it directly.
- The logic is used by only one step definition — keep it
  inline in the step method instead of abstracting prematurely
- The "helper" would just wrap a single framework call with a
  project-specific name — that's an indirection with no value
- The logic is UI interaction — that belongs in a page object,
  not a helper
- The logic is a test assertion — that belongs in a step
  definition or page object verification method

**Rule:** If the framework has the method, USE the framework
method directly. Never create a pass-through wrapper.

## Framework utility classes to check first

Before creating a helper, retrieve the relevant framework
utility via `read_file` on the skill file ('helper-patterns')` and confirm
it doesn't already expose what you need. The framework ships:

- `CSStringUtility` — case conversion, validation, trimming,
  padding, truncation, split/join, base64 encode/decode, email
  validation, URL validation
- `CSDateTimeUtility` — parse, format, add/subtract days/
  months/years, diff, comparisons, business day math, timestamp,
  now/today
- `CSArrayUtility` — unique, chunk, flatten, groupBy,
  intersection/union/difference, sort, aggregate (sum, avg, min,
  max)
- `CSMapUtility` — fromObject, toObject, filter, merge,
  deepMerge, pick, omit
- `CSCsvUtility` — parse, stringify, read, write, filter, sort,
  merge, toJSON, toExcel
- `CSExcelUtility` — read, write, getSheet, writeSheet, getCell,
  writeCell, appendRow, insertRow (heavy — use via require if
  avoiding startup cost)
- `CSComparisonUtility` — deepEqual, isEqual, differences
- `CSValueResolver` — resolve config, env, context, data
  references
- `CSEncryptionUtil` — encrypt, decrypt, hash, verify
- `CSSecretMasker` — mask secrets in log output
- `CSRegexUtils` — common regex patterns and validators

If your helper would duplicate one of these, don't create it.
Use the framework class directly.

## File placement and naming

- Directory: `test/<project>/helpers/`
- Filename: PascalCase ending in `Helper.ts` (e.g.,
  `UserDatabaseHelper.ts`, `OrderFactoryHelper.ts`,
  `ReportValidationHelper.ts`)
- One helper class per file. The class name matches the
  filename minus `.ts`.
- Group helpers by business domain, not by method count. Prefer
  several focused helpers (one for users, one for orders, one
  for reports) over one monolithic `ProjectHelper.ts`.
- Never create `index.ts` barrel files in the `helpers/` folder.

## Static class shape

Helpers are static classes. They do NOT instantiate; every
method is a `public static async` method (unless the method is
synchronous, in which case `public static`). State is limited
to `private static readonly` constants.

Minimal shape:

```
import { CSDBUtils } from '<framework>/database-utils';
import { CSReporter } from '<framework>/reporter';

export interface UserRecord {
    userId: string;
    email: string;
    status: string;
}

export class UserDatabaseHelper {
    private static readonly DB_ALIAS = 'PRIMARY_DB';

    public static async findUserByEmail(email: string): Promise<UserRecord | null> {
        const result = await CSDBUtils.executeQuery(
            this.DB_ALIAS,
            'FIND_USER_BY_EMAIL',
            [email]
        );
        if (!result.rows || result.rows.length === 0) {
            CSReporter.debug(`No user found for email: ${email}`);
            return null;
        }
        const row = result.rows[0];
        return {
            userId: String(row.user_id),
            email: row.email,
            status: row.status,
        };
    }

    public static async createTestUser(
        email: string,
        name: string
    ): Promise<string> {
        const newId = await CSDBUtils.executeInsertAndGetId(
            this.DB_ALIAS,
            'CREATE_TEST_USER',
            [email, name]
        );
        CSReporter.info(`Created test user ${email} (id ${newId})`);
        return String(newId);
    }

    public static async cleanupTestUsers(prefix: string): Promise<number> {
        const affected = await CSDBUtils.executeUpdate(
            this.DB_ALIAS,
            'DELETE_TEST_USERS_BY_PREFIX',
            [`${prefix}%`]
        );
        CSReporter.info(`Cleaned up ${affected} test users`);
        return affected;
    }
}
```

Rules:
- `export class` — helpers are exported
- All methods are `public static` — never instance methods
- All async methods are explicitly typed with
  `Promise<ReturnType>`
- State is limited to `private static readonly` constants
- Interfaces for domain types are exported from the same file
  (unless they're reused widely — then give them their own file)

## Single responsibility

Each helper class has one clear domain. Examples:

- `UserDatabaseHelper` — all user-related database operations
- `OrderFactoryHelper` — test order creation and cleanup
- `ReportValidationHelper` — comparing generated reports to
  expected content
- `FileUploadHelper` — common upload pre- and post-conditions
- `AuthenticationHelper` — login flows that are reused across
  many scenarios

If a helper starts handling two clearly different domains, split
it. Two focused classes are easier to maintain than one
sprawling one.

## Stateless discipline

Helpers do not store mutable state. Specifically:

- No `private static` mutable variables (except `readonly`
  constants)
- No caching inside helper methods unless the cache is managed
  via an explicit lifecycle (declare a `clearCache()` static
  method and document when to call it)
- No module-level mutable state
- Methods receive everything they need as parameters and return
  results — no hidden context

If two helper methods need to share state, that state belongs
in the `CSBDDContext` (scenario-scoped) or in an explicit
test-data record held by the calling step definition.

## Typed return values

Every helper method declares an explicit return type. For
domain entities (users, orders, reports), declare an interface
in the same file.

```
export interface OrderRecord {
    orderId: string;
    customerId: string;
    status: string;
    totalAmount: number;
    createdAt: Date;
    items: OrderItem[];
}

export interface OrderItem {
    sku: string;
    quantity: number;
    unitPrice: number;
}

export class OrderQueryHelper {
    public static async getOrderById(orderId: string): Promise<OrderRecord | null> {
        // ...
    }
}
```

Never return `any`. Never return `Record<string, any>` for
domain data. Always define an interface.

## Dependency rules

### What a helper CAN import

- Framework modules: `<framework>/database-utils`,
  `<framework>/reporter`, `<framework>/utilities`,
  `<framework>/api`, `<framework>/assertions`,
  `<framework>/core` (for `CSConfigurationManager`)
- Other helpers from the same project's `helpers/` folder
- Shared type definitions from `helpers/types/` (optional)
- Node.js built-ins: `fs`, `path`, `crypto`, `os`

### What a helper CANNOT import

- Page object classes — helpers never drive the UI
- Step definition classes — circular dependency
- Feature files or data files directly — read them via
  `CSCsvUtility` / `CSExcelUtility` / standard JSON parsing
- Raw Playwright APIs (`@playwright/test`)
- The database driver directly (`oracledb`, `mssql`, `pg`,
  `mysql2`) — always go through `CSDBUtils`
- Test framework internals not exported via submodule paths

The audit rejects helper files that import any forbidden
module.

## Async discipline

- Methods that do I/O (database, API, filesystem) are `async`
  and return `Promise<ReturnType>`
- Methods that are pure computation are synchronous — don't
  unnecessarily mark them `async`
- Never mix `async` return with synchronous execution (don't
  wrap a sync method in a `Promise.resolve`)
- Always `await` internal async calls — never fire-and-forget

## Reporting usage

Helpers report via `CSReporter` at a lower verbosity than page
objects:

- `CSReporter.debug(message)` — most helper operations use debug
  level, since the calling step definition already reports at
  info level
- `CSReporter.info(message)` — for operations that materially
  change state (created user, deleted records, uploaded file)
- `CSReporter.warn(message)` — for recoverable issues
- `CSReporter.error(message)` — for errors before rethrowing

Never use `console.log` in helpers. Never stay silent — every
helper method that does I/O should log at least once so
failures are traceable.

## Error handling

- Throw on failure by default. The caller decides whether to
  catch.
- Wrap errors from external libraries with a descriptive message
  that includes the helper method name and the key parameters
- Never swallow errors silently
- Never return `null` on error (reserve `null` for "not found"
  semantics)
- Use `try/catch` only when you can recover or add context; if
  you're just rethrowing, don't catch

```
public static async findUserByEmail(email: string): Promise<UserRecord | null> {
    try {
        const result = await CSDBUtils.executeQuery(
            this.DB_ALIAS, 'FIND_USER_BY_EMAIL', [email]);
        if (!result.rows || result.rows.length === 0) {
            return null; // "not found" is a valid outcome
        }
        return mapRow(result.rows[0]);
    } catch (error) {
        CSReporter.error(
            `UserDatabaseHelper.findUserByEmail failed for ${email}: ${(error as Error).message}`);
        throw error;
    }
}
```

## Forbidden patterns

Never do any of these in a helper file:

- Create a helper method that wraps a single framework utility
  call without adding value
- Use `new HelperClass()` — helpers are static; never
  instantiate
- Store mutable state in static variables
- Import page object classes
- Import step definition classes
- Import raw Playwright or raw database drivers
- Return `any` or `unknown` without a specific reason
- Use `console.log`
- Catch and swallow errors silently
- Inline SQL strings (use named queries via `CSDBUtils`)
- Hardcode URLs, credentials, or paths
- Write to the file system outside designated directories (test
  data, downloads, reports)

## Self-check before returning a helper file

- [ ] Filename is `<PascalCase>Helper.ts`
- [ ] Class name matches the filename
- [ ] Single business domain — no mixed responsibilities
- [ ] Verified that no framework utility already covers the
      logic
- [ ] All methods are `public static async` (or `public static`
      for sync)
- [ ] No instance state, no mutable static variables
- [ ] Typed interfaces for all domain return types
- [ ] No `any` return types
- [ ] No page object or step definition imports
- [ ] No raw Playwright or raw database driver imports
- [ ] Every database call uses `CSDBUtils` with named queries
- [ ] Every API call uses `CSAPIClient`
- [ ] Uses `CSReporter`, never `console.log`
- [ ] Errors are rethrown with descriptive context, not swallowed
- [ ] No duplicate method names within the class
- [ ] No hardcoded credentials, URLs, or connection strings

If any item fails, fix it before returning. The audit checklist
tool enforces most of these rules.
