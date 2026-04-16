---
applyTo: "test/**/*.ts,test/**/*.feature,test/**/*.json,config/**/*.env"
---

# Instructions for writing target framework code

These rules apply whenever Copilot is writing files under the target
test folder or the target config folder. They layer on top of the
project-wide instructions. The exact directory names (`test/`,
`config/`) match typical TypeScript test framework conventions;
adjust the `applyTo` pattern above if your project uses different
folder names.

## Shape and naming

- Page object classes: PascalCase, filename ends in `Page.ts`.
- Step definition files: kebab-case, filename ends in `.steps.ts`.
- Feature files: kebab-case, filename ends in `.feature`.
- Data files: kebab-case, filename ends in `-data.json` (or
  `-scenarios.json` if the file represents scenarios rather than
  raw test data).
- Helper files: PascalCase, filename ends in `Helper.ts`, placed
  in a `helpers/` subfolder under the project's test folder.
- Config env files: lowercase, `.env` extension, placed under
  `config/<project>/environments/` for environment-specific files
  and `config/<project>/common/` for cross-environment files.

## Never create

- `index.ts` barrel files in any generated folder. Each file stands
  alone and is imported directly.
- Helper files for logic that already exists in a framework utility.
  Retrieve the `helper-patterns` skill and check before creating.
- Step definitions that duplicate an existing step phrase anywhere
  in the project. The `audit_file` tool detects this; fix or reuse.

## Import discipline

- Module-specific imports only. Never import from the framework's
  root package — always from a submodule path.
- Group imports: framework first (grouped by submodule), external
  libraries second, local page imports third, local helper imports
  fourth. One blank line between groups.
- Never import a framework utility you don't use. Unused imports are
  an audit violation.

## Page object rules

- Every page object extends the framework base page class.
- Every page object has the framework page decorator with a unique
  identifier string.
- Every page object implements the required initialization method
  (usually `initializeElements`). Never omit it.
- Every element is declared as a decorated public field. Never
  instantiate elements inside methods with direct constructor calls
  unless the skill explicitly shows that pattern.
- Never redeclare inherited properties (`page`, `browser`, `config`,
  etc.). They come from the base class as `protected`.

## Step definition rules

- Every step definitions file is a class annotated with the
  framework step definitions decorator.
- Every step method is annotated with the framework step decorator
  carrying the exact phrase from the feature file.
- Pages are injected via the framework's page injection decorator,
  never by direct construction inside the step method.
- Hook methods (before scenario, after scenario, before step, after
  step) use the framework's hook decorators and may be tag-scoped.

## Feature file rules

- If a scenario uses an `Examples:` data source, it MUST be declared
  as `Scenario Outline:`, not `Scenario:`. This is a hard rule.
- Parameters in step phrases use `"<paramName>"` — double quotes
  surrounding angle brackets. Never single quotes. Never `${name}`.
- Every scenario carries its legacy test case ID as a tag, preserved
  one-to-one from the legacy source.
- Every scenario has at least three verification steps. Thin scenarios
  (only navigation and a single assertion) are rejected by the audit.

## Data file rules

- Every scenario-data entry has a `runFlag` field. If the legacy data
  didn't specify one, default to `"Yes"`.
- Column headers from the legacy source are converted to camelCase
  keys. Empty cells become empty strings, never missing keys.
- Row count and column count must match the legacy source exactly.
  The `audit_file` tool verifies this when run on a data file.

## Config rules

- Environment-specific values (URLs, credentials, feature flags) live
  in `environments/<env>.env` files and are referenced by symbolic
  name from generated code.
- Database connection settings use the convention
  `DB_<ALIAS>_HOST`, `DB_<ALIAS>_PORT`, etc., with the alias chosen
  to match the legacy source's connection reference.
- Named database queries live in `common/<project>-db-queries.env`
  with the convention `DB_QUERY_<NAME>=<SQL>`.
- Secrets (passwords, API keys, tokens) are marked for encryption at
  rest. The framework provides an encryption helper; the audit
  checks that sensitive values are not committed in plaintext.

## Forbidden patterns (common legacy habits)

- `page.goto(url)` — use the framework's navigate-and-wait helper.
- `page.click(...)`, `page.fill(...)` — use decorated elements.
- `page.waitForSelector(...)` for spinner waits — use the framework's
  spinner helper.
- Hardcoded SQL strings — extract to the db queries env file.
- Hardcoded sleep/wait calls — use the framework's wait helpers.
- `console.log`, `console.error` — use the framework reporter.
