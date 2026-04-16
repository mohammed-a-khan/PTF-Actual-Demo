---
name: config-patterns
description: >
  Canonical patterns for configuration files in the target test
  framework. Covers the environments/common/global hierarchy,
  precedence order, variable reference syntax, database
  connection settings, encrypted secrets, application URLs,
  browser settings, timeout tuning, feature flags, and forbidden
  patterns. Load when generating, auditing, or modifying any
  config .env file.
---

# Configuration Patterns

## When this skill applies

Any generated or modified file under `config/<project>/` that
holds environment or runtime configuration values. The
framework reads these files and merges them into a single
configuration accessible via `CSConfigurationManager.getInstance()`.

## Folder structure

```
config/
  global.env                             # cross-project global defaults
  <project>/
    environments/
      dev.env                            # development environment
      sit.env                            # system integration test
      uat.env                            # user acceptance test
      prod.env                           # production (read-only tests)
    common/
      common.env                         # cross-environment common values
      <project>-db-queries.env           # named database queries (may be
                                         # split into multiple files by
                                         # functional area)
    global.env                           # project-wide defaults
```

Every project has the same folder shape. The environment name
is chosen at runtime via a `--env=<name>` command-line argument
or an `ENVIRONMENT=<name>` variable.

## Configuration precedence

Values merge with this priority (highest wins):

1. Command-line arguments (`--key=value`)
2. Process environment variables
3. Project environment-specific file (`<project>/environments/<env>.env`)
4. Project common file (`<project>/common/common.env`)
5. Project global file (`<project>/global.env`)
6. Framework global file (`config/global.env`)
7. Built-in defaults

Command-line and environment-variable overrides are designed for
CI/CD pipelines that inject secrets at run time. Local
development reads from the env files directly.

## File format

Standard dotenv: one `KEY=VALUE` per line, comments prefixed
with `#`, blank lines allowed, no quoting around values (unless
the value contains spaces).

```
# ==============================================================================
# APPLICATION SETTINGS
# ==============================================================================
ENVIRONMENT=dev
BASE_URL=https://app.example.test/
LOGIN_URL=https://app.example.test/login
BROWSER_NAVIGATION_TIMEOUT=30000

# ==============================================================================
# FEATURE FLAGS
# ==============================================================================
FEATURE_NEW_CHECKOUT_ENABLED=true
FEATURE_LEGACY_REPORTS_ENABLED=false
```

Rules:
- Keys are `SCREAMING_SNAKE_CASE`
- Values are unquoted unless they contain spaces or `#`
- Multi-line values are not supported; wrap long values on one
  line or use a helper
- Comments start with `#` on their own line

## Key naming conventions

Prefix keys by category so they sort logically and the audit
tool can validate them:

- **Environment sentinel**: `ENVIRONMENT=<name>`
- **URLs**: `BASE_URL`, `LOGIN_URL`, `API_BASE_URL`,
  `DOCS_URL`
- **Timeouts**: `BROWSER_NAVIGATION_TIMEOUT`,
  `ELEMENT_WAIT_TIMEOUT`, `API_REQUEST_TIMEOUT`,
  `DB_QUERY_TIMEOUT`
- **Browser**: `BROWSER_TYPE` (chromium / firefox / webkit),
  `BROWSER_HEADLESS`, `BROWSER_VIEWPORT_WIDTH`,
  `BROWSER_VIEWPORT_HEIGHT`, `BROWSER_DOWNLOADS_DIR`
- **Database**: `DB_<ALIAS>_TYPE`, `DB_<ALIAS>_HOST`,
  `DB_<ALIAS>_PORT`, `DB_<ALIAS>_DATABASE`,
  `DB_<ALIAS>_USERNAME`, `DB_<ALIAS>_PASSWORD`,
  `DB_<ALIAS>_POOL_MIN`, `DB_<ALIAS>_POOL_MAX`
- **Database list**: `DATABASE_CONNECTIONS=<alias1>,<alias2>` —
  comma-separated list of aliases the framework should
  initialise at startup
- **Named queries**: `DB_QUERY_<NAME>=<SQL>` — lives in
  `<project>-db-queries.env` files
- **Application credentials**: `APP_USERNAME_<ROLE>`,
  `APP_PASSWORD_<ROLE>` for role-based test users
- **Feature flags**: `FEATURE_<NAME>_ENABLED=true|false`
- **API auth**: `API_KEY_<SERVICE>`, `API_TOKEN_<SERVICE>`

## Variable references inside config files

Config values can reference other config values via
`${VAR_NAME}` syntax. The framework resolves references at
read time.

```
BASE_URL=https://app-${ENVIRONMENT}.example.test/
LOGIN_URL=${BASE_URL}login
API_BASE_URL=${BASE_URL}api/v1
```

Rules:
- Use `${VAR_NAME}` in config file values only — NOT inside
  step definitions or data files (those use `{config:VAR_NAME}`)
- Circular references are an error — the audit detects them at
  startup
- Undefined references are errors — the audit fails the run if
  any reference cannot be resolved

## Database connection settings

Every database alias needs a complete set of `DB_<ALIAS>_*`
entries in the environment-specific file. The alias name is
chosen by the project team and is the same string passed as the
first argument to every `CSDBUtils` method.

### Common settings (all database types)

```
DB_<ALIAS>_TYPE=<oracle|postgres|mysql|sqlserver|db2|sqlite>
DB_<ALIAS>_HOST=<hostname>
DB_<ALIAS>_PORT=<port>
DB_<ALIAS>_DATABASE=<database-name>
DB_<ALIAS>_USERNAME=<user>
DB_<ALIAS>_PASSWORD=<encrypted>
DB_<ALIAS>_POOL_MIN=2
DB_<ALIAS>_POOL_MAX=10
DB_<ALIAS>_CONNECTION_TIMEOUT=60000
DB_<ALIAS>_REQUEST_TIMEOUT=60000
```

### Oracle-specific

Oracle needs a service name (TNS identifier) in addition to or
instead of a plain database name:

```
DB_<ALIAS>_SERVICE_NAME=<service-name>
DB_<ALIAS>_POOL_INCREMENT=2
```

### SQL Server-specific

SQL Server supports Windows authentication:

```
DB_<ALIAS>_USE_WINDOWS_AUTH=true
DB_<ALIAS>_DOMAIN=<domain>
```

When Windows auth is used, `DB_<ALIAS>_USERNAME` and
`DB_<ALIAS>_PASSWORD` are not required.

### Declaring active connections

The framework only opens connections listed in
`DATABASE_CONNECTIONS`:

```
DATABASE_CONNECTIONS=PRIMARY_DB,REPORTS_DB
```

Aliases absent from this list are ignored even if their
`DB_<ALIAS>_*` entries exist. This lets one env file hold
configuration for many environments while only activating the
relevant subset at runtime.

## Named database queries

Named queries live in dedicated files named
`<project>-<area>-db-queries.env` under `common/`. One line per
query, `DB_QUERY_<NAME>=<SQL>`.

See `database-query-patterns` skill for the full rules.

Rules for the env file itself:
- No duplicate query names across files in the same project —
  the audit fails the run on duplicates
- SQL is on one line; multi-line queries are forbidden in env
  files
- Use `?` placeholders for parameters, never string
  interpolation
- Queries may be grouped by functional area into multiple
  files (one for users, one for orders, etc.)

## Encrypted secrets

Sensitive values (passwords, API keys, tokens, client secrets)
are encrypted at rest using the framework's encryption helper.
Encrypted values are stored with an `ENCRYPTED:` prefix:

```
DB_PRIMARY_DB_PASSWORD=ENCRYPTED:<base64-encoded-encrypted-blob>
API_KEY_PAYMENT_GATEWAY=ENCRYPTED:<base64-encoded-encrypted-blob>
```

The framework's `CSValueResolver` decrypts them transparently
when read. Downstream code never sees the ciphertext.

Rules:
- Never commit an unencrypted secret value
- Never log a secret — the framework's `CSSecretMasker` auto-masks
  any value whose key matches `*PASSWORD*`, `*SECRET*`,
  `*TOKEN*`, or `*KEY*`
- For local development, use a local encryption key checked into
  a developer-only location (not the repo)
- For CI/CD, use the pipeline's secret store and inject via
  environment variables (which take precedence over env files)

## Browser and framework settings

Standard browser-related keys:

```
BROWSER_TYPE=chromium
BROWSER_HEADLESS=true
BROWSER_SLOW_MO=0
BROWSER_VIEWPORT_WIDTH=1920
BROWSER_VIEWPORT_HEIGHT=1080
BROWSER_NAVIGATION_TIMEOUT=30000
BROWSER_DOWNLOADS_DIR=./downloads
BROWSER_TRACE_ENABLED=true
BROWSER_VIDEO_ENABLED=true
BROWSER_SCREENSHOT_ON_FAILURE=true
```

Standard framework keys:

```
REPORTER_HTML_ENABLED=true
REPORTER_JSON_ENABLED=true
REPORTER_CONSOLE_ENABLED=true
REPORTER_SCREENSHOT_PATH=./results/screenshots
ELEMENT_WAIT_TIMEOUT=15000
ELEMENT_STABLE_TIMEOUT=5000
SELF_HEAL_ENABLED=true
SELF_HEAL_CONFIDENCE_THRESHOLD=0.85
```

Precise key names are framework-defined; the analyzer and
generator agents query `read_file` on the skill file ('config-patterns')` to
get the canonical list during migration.

## Feature flags

Feature flags toggle optional scenarios or application behaviour
at runtime. Use a consistent prefix:

```
FEATURE_NEW_CHECKOUT_ENABLED=true
FEATURE_LEGACY_REPORTS_ENABLED=false
FEATURE_DEBUG_UI_ENABLED=false
```

Feature-flag scenarios in the feature file use tags that match:

```
@feature-new-checkout-enabled
Scenario Outline: ...
```

A `@CSBefore({ tags: ['@feature-new-checkout-enabled'] })` hook
reads the flag from config and skips the scenario if the flag is
off.

## Cross-environment promotion rules

Values that change across environments:
- `BASE_URL`, `LOGIN_URL`, `API_BASE_URL`
- `DB_<ALIAS>_HOST`, `DB_<ALIAS>_PORT`, `DB_<ALIAS>_DATABASE`,
  `DB_<ALIAS>_USERNAME`, `DB_<ALIAS>_PASSWORD`
- `APP_USERNAME_*`, `APP_PASSWORD_*`
- `API_KEY_*`, `API_TOKEN_*`

Values that are typically the same across environments:
- `BROWSER_TYPE`, `BROWSER_HEADLESS`, `BROWSER_VIEWPORT_*`
- `ELEMENT_WAIT_TIMEOUT`, `BROWSER_NAVIGATION_TIMEOUT`
- `REPORTER_*` output settings
- `FEATURE_*` flags (unless the feature is rolling out per env)
- `DB_<ALIAS>_POOL_MIN`, `DB_<ALIAS>_POOL_MAX`

Put the second category in `common/common.env` and the first
category in `environments/<env>.env`. This minimises duplication
and keeps each env file focused on what actually differs.

## Forbidden patterns

Never do any of these in a config file:

- Commit an unencrypted password, API key, or secret
- Hardcode a URL that differs per environment in
  `common/common.env` or `global.env`
- Use `${VAR}` references with undefined variables
- Use quoted values for simple key=value pairs (breaks dotenv
  parsing in some tools)
- Use multi-line values in env files
- Duplicate a key across two files without intentional
  precedence (the override is fine but should be commented)
- Declare a `DB_<ALIAS>_*` group without adding the alias to
  `DATABASE_CONNECTIONS`
- Use lowercase keys or mixed case
- Reference secrets in comments (comments can leak into logs)
- Hardcode the environment name in source code — always resolve
  via `CSConfigurationManager.get('ENVIRONMENT')`

## Self-check before returning a config file

- [ ] File is under the correct folder (`environments/`,
      `common/`, `global.env`)
- [ ] All keys are `SCREAMING_SNAKE_CASE`
- [ ] `ENVIRONMENT` sentinel is set in each environment-specific
      file
- [ ] Every secret is encrypted with `ENCRYPTED:` prefix or
      injected from env/CI
- [ ] Every database alias has a complete `DB_<ALIAS>_*` group
- [ ] Every active alias is listed in `DATABASE_CONNECTIONS`
- [ ] No plain-text credentials anywhere
- [ ] No duplicate keys within a single file
- [ ] All `${VAR}` references resolve to defined variables
- [ ] Values that differ per environment live in `environments/`
      files, not `common/` or `global.env`
- [ ] `DB_QUERY_*` entries live in query files, not in
      environment files
- [ ] Comments describe WHY, not WHAT (the key name describes
      what)

If any item fails, fix it before returning. The audit checklist
tool enforces most of these rules.
