---
name: database-query-patterns
description: >
  Canonical patterns for database operations in the target TypeScript
  test framework. Covers the static CSDBUtils API, named-query env
  files, multi-database aliases, every query execution method
  (single value, single row, multi-row, exists, count, column
  extraction, map, transaction, stored procedure, paged query, insert
  with returned id), test data setup and teardown, helper class
  shape, hook scoping, secret handling, error handling, and
  forbidden patterns. Load when generating, auditing, or healing
  any code that touches a database — step definitions, helper
  classes, or before/after hooks.
---

# Database Query Patterns

## When this skill applies

Any generated or modified code that reads from or writes to a
database — most commonly:

- Step definitions that set up or verify test data
- Helper classes that wrap domain-specific queries
- `@CSBefore` / `@CSAfter` hooks that prepare or clean up state

Database code NEVER lives in page object classes. Page objects are
for DOM interaction only. Database code lives in step definitions,
helpers, or hooks.

## The CSDBUtils class — fully static

Every database operation goes through `CSDBUtils`. The class is
fully static — every method is called as `CSDBUtils.<method>(...)`.
There is no `getInstance()`, no `new CSDBUtils()`, no singleton
per alias. The first argument to every method is the database
alias (a short string identifying which connection to use).

Connection lifecycle is managed by the framework. Connections are
opened lazily on first use and reused across calls with the same
alias. There is no manual open or close step in test code.

### Import

```
import { CSDBUtils } from '<framework>/database-utils';
import { CSReporter } from '<framework>/reporter';
```

`<framework>` is the project's framework package — the install
script substitutes the real package name when the template is
deployed into a project.

## Where SQL lives

SQL query text NEVER appears as a string literal in TypeScript
source code. Every query lives in a named-query environment file
and is referenced by a symbolic name. This rule has no exceptions.

### Named query file location

- Path: `config/<project>/common/<project>-<area>-db-queries.env`
- Format: standard dotenv, one query per line
- Naming convention for entries: `DB_QUERY_<UPPERCASE_SNAKE_NAME>=<SQL>`
- Multiple files allowed for large projects, grouped by functional
  area (e.g., one file for user-related queries, one for
  order-related, one for reporting)

### Query naming convention

- All entries start with `DB_QUERY_`
- Names are SCREAMING_SNAKE_CASE
- Names describe intent, not table or operation:
  good — `DB_QUERY_FIND_USER_BY_EMAIL`
  bad — `DB_QUERY_SELECT_FROM_USERS`
- Single-line entries only. If a query is too long for one line,
  it should be a stored procedure or a view.

### Query name resolution

When you call any `CSDBUtils` method, the second argument is
either raw SQL (a string containing spaces or SQL keywords) or a
query key name. The framework auto-resolves query keys against
the env files: it accepts both the bare name (`GET_USER_BY_EMAIL`)
and the full prefixed name (`DB_QUERY_GET_USER_BY_EMAIL`). Both
resolve to the same entry.

Prefer the bare name in code — it reads more cleanly:

```
const result = await CSDBUtils.executeQuery(
    DB_ALIAS,
    'GET_USER_BY_EMAIL',
    [email]
);
```

The framework reports an error at startup if any referenced query
key cannot be resolved to an env entry, so typos are caught
before tests run.

## Connection configuration

Connection settings live in environment env files, one entry per
connection alias. The alias is a short symbolic name your code
references.

### Location and format

- Path: `config/<project>/environments/<env>.env`
  (one file per environment: `dev.env`, `sit.env`, `uat.env`, etc.)
- Variable naming: `DB_<ALIAS>_<SETTING>`

Required settings per alias:

- `DB_<ALIAS>_TYPE` — one of: `oracle`, `sqlserver`, `postgres`,
  `mysql`, `db2`, `sqlite`
- `DB_<ALIAS>_HOST`
- `DB_<ALIAS>_PORT`
- `DB_<ALIAS>_DATABASE`
- `DB_<ALIAS>_USERNAME`
- `DB_<ALIAS>_PASSWORD` (encrypted at rest — see Secrets section)

Optional settings per alias:

- `DB_<ALIAS>_QUERY_TIMEOUT_MS`
- `DB_<ALIAS>_CONNECT_TIMEOUT_MS`
- `DB_<ALIAS>_POOL_MIN`, `DB_<ALIAS>_POOL_MAX`
- `DB_<ALIAS>_SCHEMA` (default schema for unqualified table refs)
- `DB_<ALIAS>_SSL` (`true` / `false`)

### Multi-database support

A project may use multiple aliases when tests span more than one
backend (for example, an application database and a separate
reporting warehouse). Each alias gets its own complete set of
`DB_<ALIAS>_*` entries. Code references the alias by name as the
first argument to each `CSDBUtils` call:

```
const appResult = await CSDBUtils.executeQuery(
    'PRIMARY_DB', 'GET_USER_BY_EMAIL', [email]);

const reportResult = await CSDBUtils.executeQuery(
    'REPORTS_DB', 'COUNT_DAILY_TXNS', [date]);
```

There is no factory call — the alias string is enough. The
framework looks up the connection settings under
`DB_PRIMARY_DB_*` and `DB_REPORTS_DB_*` automatically.

## ResultSet — what every query returns

Most `CSDBUtils` methods return a `ResultSet` object with these
fields:

- `rows` — array of row objects (each row is `{ column_name: value }`)
- `rowCount` — number of rows
- `fields` — column metadata (name, type) when available

Read rows by column name from the row object:

```
const result = await CSDBUtils.executeQuery(DB_ALIAS, 'GET_USER_BY_EMAIL', [email]);
if (!result.rows || result.rows.length === 0) {
    throw new Error(`No user found for email: ${email}`);
}
const userId = result.rows[0].user_id;
const status = result.rows[0].status;
```

Methods like `count()`, `exists()`, `extractColumn()`, and
`getMap()` return their typed values directly rather than a
`ResultSet`.

## Query execution methods

Use the method that matches your intent. Don't reach for a more
general method than necessary.

### executeQuery — the workhorse

```
public static async executeQuery(
    alias: string,
    sql: string,           // raw SQL or named query key
    params?: any[]
): Promise<ResultSet>
```

The default for any read query. Accepts either raw SQL or a named
query key. Returns a `ResultSet`.

```
const result = await CSDBUtils.executeQuery(
    'PRIMARY_DB',
    'GET_USER_BY_EMAIL',
    ['user@example.test']
);
const user = result.rows[0];
```

### executeNamedQuery — explicit named query

```
public static async executeNamedQuery(
    alias: string,
    queryKey: string,
    params?: any[]
): Promise<ResultSet>
```

Same as `executeQuery` but takes only a named query key, never
raw SQL. Use this when you want to be explicit that the call
references a named query (the audit tool does not need to
distinguish, but human readers do).

### exists — boolean check

```
public static async exists(
    alias: string,
    sql: string,
    params?: any[]
): Promise<boolean>
```

Returns `true` if the query yields at least one row. Use for
pure existence checks where you don't need the row data.

```
const hasOpenOrders = await CSDBUtils.exists(
    'PRIMARY_DB',
    'HAS_OPEN_ORDERS_FOR_USER',
    [userId]
);
```

### count — row count

```
public static async count(
    alias: string,
    sql: string,
    params?: any[]
): Promise<number>
```

Returns the number of rows. Prefer this over reading
`result.rowCount` from `executeQuery` when the query is a count.

```
const openCount = await CSDBUtils.count(
    'PRIMARY_DB',
    'COUNT_OPEN_ORDERS',
    [userId]
);
```

### executeUpdate — INSERT / UPDATE / DELETE

```
public static async executeUpdate(
    alias: string,
    sql: string,
    params?: any[]
): Promise<number>
```

Returns the number of affected rows. Use for all write
operations that don't need the new row's id.

```
const affected = await CSDBUtils.executeUpdate(
    'PRIMARY_DB',
    'DELETE_TEST_DATA_BY_PREFIX',
    ['test-']
);
CSReporter.info(`Cleaned up ${affected} test rows`);
```

### executeInsertAndGetId — INSERT returning generated id

```
public static async executeInsertAndGetId(
    alias: string,
    sql: string,
    params?: any[]
): Promise<number | string>
```

Inserts and returns the generated primary key. Use when you need
the new row's id for subsequent calls.

```
const newUserId = await CSDBUtils.executeInsertAndGetId(
    'PRIMARY_DB',
    'CREATE_TEST_USER',
    ['test-user@example.test', 'Test User']
);
```

### extractColumn — single-column slice

```
public static async extractColumn<T = any>(
    alias: string,
    sql: string,
    columnName: string,
    params?: any[]
): Promise<T[]>
```

Returns one column across all rows as a typed array. Use when you
only care about one column from a multi-row result.

```
const emails = await CSDBUtils.extractColumn<string>(
    'PRIMARY_DB',
    'LIST_ACTIVE_USER_EMAILS',
    'email'
);
```

### getMap — lookup map keyed by one column

```
public static async getMap<K = any, V = any>(
    alias: string,
    sql: string,
    keyColumn: string,
    valueColumn: string,
    params?: any[]
): Promise<Map<K, V>>
```

Returns a `Map` where keys come from `keyColumn` and values from
`valueColumn`. Use when you need fast lookup by key.

```
const statusByEmail = await CSDBUtils.getMap<string, string>(
    'PRIMARY_DB',
    'LIST_USER_STATUSES',
    'email',
    'status'
);
const status = statusByEmail.get('test-user@example.test');
```

### executeQueryLimit — first N rows

```
public static async executeQueryLimit(
    alias: string,
    sql: string,
    limit: number,
    params?: any[]
): Promise<Record<string, any>[]>
```

Returns an array of plain row objects, capped at `limit` rows.
Use when the query may return many rows but you only need the
first few.

```
const topFive = await CSDBUtils.executeQueryLimit(
    'PRIMARY_DB',
    'GET_RECENT_TXNS_BY_USER',
    5,
    [userId]
);
```

### executeStoredProcedure — call a stored procedure

```
public static async executeStoredProcedure(
    alias: string,
    procedureName: string,
    params?: any[]
): Promise<ResultSet>
```

The framework wraps the underlying database's call syntax for you:

- Oracle → `BEGIN procedureName(?, ?, ?); END;`
- SQL Server → `EXEC procedureName ?, ?, ?`
- MySQL / PostgreSQL → `CALL procedureName(?, ?, ?)`

You don't write the wrapper SQL; you only pass the procedure
name and the parameters in order. The procedure name can be a
raw name or a named query key — for example, you can store
`DB_QUERY_REFRESH_USER_VIEW=refresh_user_v` in the env file and
reference it by `'REFRESH_USER_VIEW'`:

```
// Direct procedure name (Oracle package.method form)
await CSDBUtils.executeStoredProcedure(
    'PRIMARY_DB',
    'pkg_users.refresh_views',
    [tenantId]
);

// Named procedure from env (resolves DB_QUERY_REFRESH_USER_VIEW)
await CSDBUtils.executeStoredProcedure(
    'PRIMARY_DB',
    'REFRESH_USER_VIEW',
    [tenantId]
);

// Procedure with no parameters
await CSDBUtils.executeStoredProcedure(
    'PRIMARY_DB',
    'sp_recompute_aggregates'
);
```

The returned `ResultSet` carries any rows the procedure produces.
For procedures that only mutate state and return nothing, ignore
the return value or check `rowCount` for affected-row count.

### executeTransaction — multi-statement transaction

```
public static async executeTransaction(
    alias: string,
    queries: Array<{ sql: string; params?: any[] }>
): Promise<ResultSet[]>
```

Runs a sequence of statements inside a single transaction. Commits
on success, rolls back on any thrown error. The argument is an
ARRAY of query descriptors, not a callback.

```
const results = await CSDBUtils.executeTransaction(
    'PRIMARY_DB',
    [
        {
            sql: 'CREATE_TEST_USER',
            params: ['test@example.test', 'Test User']
        },
        {
            sql: 'ASSIGN_TEST_ROLE',
            params: ['test@example.test', 'TESTER']
        },
        {
            sql: 'CREATE_TEST_PROFILE',
            params: ['test@example.test']
        }
    ]
);
```

`results` is an array of `ResultSet` objects in the same order as
the input queries. If any query throws, the entire transaction
rolls back and the error propagates to the caller. Never call
manual commit or rollback — the framework handles them via the
transaction wrapper.

## Parameterised queries — always

Use `?` placeholders in the named query text and pass values as
the params array. Never use string concatenation or template
literals to build queries.

### Correct

env file:
```
DB_QUERY_FIND_USER_BY_EMAIL=SELECT id FROM users WHERE email = ?
```

code:
```
const result = await CSDBUtils.executeQuery(
    'PRIMARY_DB', 'FIND_USER_BY_EMAIL', [email]);
```

### Wrong — rejected by audit

```
// SQL injection risk
const sql = `SELECT id FROM users WHERE email = '${email}'`;
const result = await CSDBUtils.executeQuery('PRIMARY_DB', sql);
```

```
// Hardcoded value in env file
DB_QUERY_FIND_TEST_USER=SELECT id FROM users WHERE email = 'test@example.test'
```

The audit tool rejects:
- TypeScript code that builds SQL via string concatenation or
  template interpolation with non-literal values
- Env entries that contain `${`, `'+'`, or string-quoted
  parameter values that look interpolated

## Helper class pattern

For DB operations reused across many step definitions, extract
them into a project helper class. The helper:

- Lives under `test/<project>/helpers/`
- Is named with a descriptive PascalCase name ending in
  `DatabaseHelper.ts` (one helper per functional area, not one
  monolithic helper for the whole project)
- Is a class with `public static async` methods only — no
  instances, no fields
- Declares the database alias as a `private static readonly`
  constant so all methods reference one source of truth
- Wraps each `CSDBUtils` call with a business-oriented name
  and a typed return
- Logs each call via `CSReporter.debug` for traceability

Shape:

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
        CSReporter.debug(`Found user ${row.user_id} for ${email}`);
        return {
            userId: row.user_id,
            email: row.email,
            status: row.status,
        };
    }

    public static async createTestUser(email: string, name: string): Promise<string> {
        const newId = await CSDBUtils.executeInsertAndGetId(
            this.DB_ALIAS,
            'CREATE_TEST_USER',
            [email, name]
        );
        CSReporter.info(`Created test user ${email} (id ${newId})`);
        return String(newId);
    }

    public static async deleteTestUsers(emailPrefix: string): Promise<number> {
        const affected = await CSDBUtils.executeUpdate(
            this.DB_ALIAS,
            'DELETE_TEST_USERS_BY_PREFIX',
            [`${emailPrefix}%`]
        );
        CSReporter.info(`Deleted ${affected} test users with prefix ${emailPrefix}`);
        return affected;
    }
}
```

Helpers that talk to a different alias declare their own
`DB_ALIAS` constant. A project with two databases typically has
two helper classes, one per alias.

## Where to call DB from

### Step definitions

The most common call site. Step defs use database operations to:

- Fetch expected data to compare against UI state
- Set up prerequisites before a UI flow
- Clean up after a UI flow
- Verify a persisted outcome after a UI action

### Helper classes

For business operations reused across many step definitions.
The step definition calls the helper; the helper calls
`CSDBUtils`. This keeps step definitions thin and lets multiple
step files share the same database semantics.

### Hook methods (`@CSBefore` / `@CSAfter` / `@CSBeforeStep` / `@CSAfterStep`)

For setup and teardown that wraps every scenario or step that
matches a tag. The hooks live in a step definition class and
use the framework's hook decorators with a `tags` filter:

```
import { StepDefinitions, CSBefore, CSAfter } from '<framework>/bdd';

@StepDefinitions
export class TestSetupSteps {

    @CSBefore({ tags: ['@needs-test-user'] })
    async createTestUser(): Promise<void> {
        await UserDatabaseHelper.createTestUser(
            'test-user@example.test', 'Test User');
    }

    @CSAfter({ tags: ['@needs-test-user'] })
    async cleanupTestUser(): Promise<void> {
        await UserDatabaseHelper.deleteTestUsers('test-user');
    }
}
```

The available hook decorators are:

- `@CSBefore({ tags?, order? })` — runs before each scenario
  matching the tag filter
- `@CSAfter({ tags?, order? })` — runs after each scenario
  matching the tag filter
- `@CSBeforeStep({ tags?, order? })` — runs before each step
- `@CSAfterStep({ tags?, order? })` — runs after each step

`order` is an integer; lower values run earlier. Both options
are optional.

### NEVER from page objects

Page objects are for DOM interaction. They never import
`CSDBUtils`, never reference `DB_QUERY_*` keys, and never call
helper classes that wrap database operations. The audit rejects
any page object file with a database import.

## Test data setup patterns

### Minimal setup

Create only the data the current scenario needs. Avoid broad
fixtures that other scenarios accidentally depend on.

### Deterministic setup

Tests that create data should use deterministic but unique
inputs (for example, `test-{timestamp}-{run-id}@example.test`)
so concurrent runs don't collide and cleanup queries can target
them precisely.

### Idempotent cleanup

Cleanup queries must be safe to run multiple times and safe to
run when no test data exists. Prefer prefix-based deletes
(`DELETE FROM users WHERE email LIKE 'test-%'`) over id-based
deletes (`DELETE FROM users WHERE id = ?`) — the former
succeeds even if the row is already gone.

### Separation of setup and verification

Set up data with known values, then verify the UI flow against
those values. Do not verify the UI against data the test also
set up via the UI — that's circular.

## Result type coercion

- Numeric columns return as JavaScript numbers, except very
  large integers (BIGINT) which some drivers return as strings.
  When in doubt, cast explicitly: `String(row.id)` or
  `Number(row.amount)`.
- Date and datetime columns return as `Date` objects in the
  framework's default configuration. Format them via
  `CSDateTimeUtility.format` when you need a string.
- Boolean columns vary by driver; the framework normalises to
  JavaScript `true` / `false`.
- NULL values return as JavaScript `null`.

When writing assertions, account for these types:

```
import { CSAssert } from '<framework>/assertions';

const balance = await CSDBUtils.executeQuery(
    'PRIMARY_DB', 'GET_ACCOUNT_BALANCE', [accountId]);
const value = Number(balance.rows[0].balance);
await CSAssert.getInstance().assertEqual(
    value, 1000.50, 'Account balance should be 1000.50');
```

## Secret handling

- Database passwords are encrypted at rest in the env file via
  the framework's encryption helper. The framework decrypts them
  at runtime when reading `DB_<ALIAS>_PASSWORD`.
- Never commit an unencrypted password value.
- Never log a password. The framework's reporter masks any
  value whose key matches `*PASSWORD*`, `*SECRET*`, `*TOKEN*`,
  or `*KEY*`.
- For local development, encrypted values use a local key; for
  CI/CD pipelines, use the pipeline's secret store and inject
  via environment variables.

## Error handling

- `CSDBUtils` methods throw on failure. Catch only when the test
  can meaningfully recover or report a specific diagnostic.
- A DB error in a `@CSBefore` hook fails the scenario.
- A DB error in a `@CSAfter` hook is logged but does not fail
  the scenario (the test already finished).
- A DB error during a step fails the current step.
- Never swallow a database error silently. Either catch, report
  with `CSReporter.fail`, and rethrow, or let it propagate.

```
try {
    const user = await UserDatabaseHelper.findUserByEmail(email);
    if (user === null) {
        throw new Error(`Expected test user not found: ${email}`);
    }
    return user;
} catch (error) {
    CSReporter.fail(`DB lookup failed for ${email}: ${(error as Error).message}`);
    throw error;
}
```

## Timeouts

- Per-query timeout comes from `DB_<ALIAS>_QUERY_TIMEOUT_MS`.
  Default is framework-defined (typically 30 seconds).
- For long-running queries (reports, aggregations), either move
  the work to a stored procedure with its own timeout policy or
  raise the alias-level setting in the env file.
- Never set a timeout to zero or infinity. Slow tests mask real
  failures.

## Forbidden patterns

Never do any of these in generated code — the audit will reject
the file:

- Inline SQL strings in TypeScript source (always use named queries)
- SQL built via string concatenation or template interpolation
  with non-literal values
- `new CSDBUtils()` or `CSDBUtils.getInstance(...)` — the class
  is fully static
- Importing the underlying database driver directly (`oracledb`,
  `mssql`, `pg`, `mysql2`, etc.) — always go through `CSDBUtils`
- Manual commit or rollback calls — let `executeTransaction`
  handle them
- Hardcoded connection strings or credentials
- Plain-text passwords in env files
- Database calls inside a page object class
- `console.log` or `console.error` of query results — use
  `CSReporter`
- Catching a database error and returning a fallback value
  silently — either rethrow or escalate
- Named queries that don't start with `DB_QUERY_`
- Multiple env entries with the same query name (a dedup audit
  runs on the queries env file at startup)
- `CSDBUtils.executeQuery(alias, sql)` where `sql` was built by
  concatenation — use a named query

## Self-check before returning DB code

- [ ] Every SQL string lives in a named-query env file
- [ ] Every named query uses the `DB_QUERY_` prefix
- [ ] Every query uses `?` placeholders for parameters
- [ ] Every database call goes through `CSDBUtils` (static)
- [ ] No `getInstance()` or `new CSDBUtils()` anywhere
- [ ] The right method is used for the query's intent (executeQuery
      / executeNamedQuery / exists / count / executeUpdate /
      executeInsertAndGetId / extractColumn / getMap /
      executeQueryLimit / executeStoredProcedure / executeTransaction)
- [ ] Stored procedures use `executeStoredProcedure`, not raw
      `BEGIN`/`EXEC`/`CALL` strings
- [ ] Transactions use the `executeTransaction(alias, queries[])`
      array form
- [ ] Database calls live in step definitions, helper classes,
      or `@CSBefore` / `@CSAfter` hooks — never in page objects
- [ ] Helper classes use `public static async` methods with a
      `private static readonly DB_ALIAS` constant
- [ ] `CSReporter` is used for logging, never `console.log`
- [ ] Hooks use `@CSBefore` / `@CSAfter` / `@CSBeforeStep` /
      `@CSAfterStep`, never any other decorator name
- [ ] Credentials are encrypted in the env file
- [ ] No hardcoded SQL, no string-interpolated SQL, no connection
      strings, no plain passwords
- [ ] Errors propagate or are reported via `CSReporter.fail`
      and rethrown
- [ ] Test data cleanup is idempotent (prefix-based, not id-based)
- [ ] New `DB_QUERY_*` entries do not duplicate existing ones

If any item fails, fix it before calling `npx tsc --noEmit` via `run_in_terminal` or
returning the manifest. The audit checklist enforces most of
these rules and will reject a file that doesn't comply.
