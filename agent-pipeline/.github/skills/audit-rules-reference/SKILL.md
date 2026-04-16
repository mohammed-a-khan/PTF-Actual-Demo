---
name: audit-rules-reference
description: >
  Complete reference of audit rules agents enforce manually
  before writing any target framework file. Each rule has a
  unique identifier, a severity, the file types it applies to,
  a description, and a detection pattern agents walk through
  mentally. Load when generating any target framework file (to
  avoid violations in the first draft) and when healing failed
  validations (to map violations to fixes).
---

# Audit Rules Reference

## When this skill applies

Every generation and healing cycle consults these audit rules.
The generator agent uses them to avoid violations in the first
draft. The healer agent uses them to map runtime validation
errors back to the rule that was violated.

There is no dedicated audit tool. Each agent walks through the
relevant rules manually as a self-check before calling
`write_file` or returning its manifest. When combined with a
`run_in_terminal` call to `npx tsc --noEmit`, the agent catches
both compile errors and framework-convention violations before
any test run.

## Severity levels

- **error** — must be fixed before the file can be returned.
  Errors block compilation or cause runtime failures.
- **warning** — should be fixed but does not block the file.
  Warnings indicate drift from convention or non-optimal
  choices.
- **info** — advisory only. Infos suggest improvements that
  are optional.

The generator's internal loop fixes every `error`-severity
violation. Warnings are fixed when the fix is cheap; otherwise
they're logged in the generation manifest. Infos are logged
only.

## Rule categories

Rules are organised by category prefix:

- `IMP` — import rules
- `NAM` — naming conventions
- `STR` — structure rules (class shape, decorators, required
  methods)
- `DEC` — decorator usage
- `SYN` — syntax / API usage
- `LOC` — locator placement and quality
- `ASS` — assertion rules
- `REP` — reporter usage
- `DB` — database rules
- `CFG` — configuration rules
- `DUP` — duplication checks
- `FWD` — forbidden word checks
- `SEC` — security checks (secrets, credentials)

## Import rules (IMP)

- **IMP001 (error)** — No barrel imports. Must import from a
  framework submodule path. Applies to all `.ts` files.
- **IMP002 (error)** — No duplicate import lines for the same
  module. Group imports from one submodule in a single line.
- **IMP003 (warning)** — Unused imports must be removed.
- **IMP004 (error)** — No imports from raw Playwright
  (`@playwright/test`) in page objects, step definitions, or
  helpers. Use framework wrappers.
- **IMP005 (error)** — No imports from raw database drivers
  (`oracledb`, `mssql`, `pg`, `mysql2`). Use `CSDBUtils`.
- **IMP006 (error)** — No `console` imports or method calls.
  Use `CSReporter`.
- **IMP007 (warning)** — Framework imports grouped by
  submodule, one blank line between framework and local
  imports.

## Naming rules (NAM)

- **NAM001 (error)** — Page object files: PascalCase ending in
  `Page.ts`. Class name matches filename minus `.ts`.
- **NAM002 (error)** — Step definition files: kebab-case
  ending in `.steps.ts`. Class name PascalCase ending in
  `Steps`.
- **NAM003 (error)** — Feature files: kebab-case or snake_case
  ending in `.feature`.
- **NAM004 (error)** — Helper files: PascalCase ending in
  `Helper.ts`. Class name matches filename minus `.ts`.
- **NAM005 (warning)** — Element field names use type-prefix
  convention (`textBox`, `button`, `dropDown`, `link`,
  `label`, etc.).
- **NAM006 (error)** — No `index.ts` barrel files in any
  generated folder.
- **NAM007 (error)** — Config keys are `SCREAMING_SNAKE_CASE`.
- **NAM008 (error)** — Named query keys start with `DB_QUERY_`.
- **NAM009 (error)** — Data file keys (JSON) are camelCase.
- **NAM010 (warning)** — Method names describe business
  actions, not element operations.

## Structure rules (STR)

- **STR001 (error)** — Page object class extends `CSBasePage`
  or `CSFramePage`.
- **STR002 (error)** — Page object class has `@CSPage` decorator
  with a unique identifier string.
- **STR003 (error)** — Page object implements
  `initializeElements(): void`.
- **STR004 (error)** — Page object does not redeclare inherited
  protected properties (`page`, `browserManager`, `config`,
  `url`, `elements`).
- **STR005 (error)** — Step definitions class has
  `@StepDefinitions` decorator.
- **STR006 (error)** — Feature file has exactly one `Feature:`
  declaration.
- **STR007 (error)** — Feature file has `As a / I want / So
  that` narrative block.
- **STR008 (error)** — Background block (if present) contains
  only `Given` steps.
- **STR009 (error)** — `Examples:` block requires
  `Scenario Outline:` declaration, not `Scenario:`.
- **STR010 (error)** — Helper class is an `export class` with
  all `public static async` (or `public static`) methods.
- **STR011 (warning)** — Helper class has no mutable static
  fields (only `private static readonly` constants).

## Decorator rules (DEC)

- **DEC001 (error)** — `@CSGetElement` decorators have a
  `description` field.
- **DEC002 (error)** — `@CSGetElement` decorators have exactly
  one primary locator (xpath OR css OR role OR testId, not
  multiple).
- **DEC003 (error)** — `@Page` decorator identifier matches a
  `@CSPage` identifier somewhere in the project.
- **DEC004 (error)** — Step decorators (`@CSBDDStepDef`,
  `@Given`, `@When`, `@Then`, `@And`, `@But`) have a non-empty
  pattern string.
- **DEC005 (warning)** — Gherkin-style decorators (`@When`,
  `@Then`, etc.) match the feature file keyword for the
  corresponding step.
- **DEC006 (error)** — Hook decorators (`@CSBefore`,
  `@CSAfter`, `@CSBeforeStep`, `@CSAfterStep`) use correct
  option shape (`{ tags?, order? }`).

## Syntax / API rules (SYN)

- **SYN001 (error)** — No raw Playwright API calls
  (`page.click`, `page.fill`, `page.goto`,
  `page.waitForSelector`, `page.keyboard.*`, `page.mouse.*`).
- **SYN002 (error)** — Navigation uses
  `browserManager.navigateAndWaitReady(...)`, not
  `page.goto(...)`.
- **SYN003 (error)** — Every async method call on a framework
  object is awaited.
- **SYN004 (error)** — No hardcoded sleep/timer
  (`setTimeout(..., N)` as a wait).
- **SYN005 (warning)** — Use the inherited `this.page` or
  `this.browserManager` from `CSBasePage` rather than
  `CSBrowserManager.getInstance().getPage()` inside page
  objects.
- **SYN006 (error)** — `CSDBUtils` called statically, not via
  `new` or `getInstance()`.
- **SYN007 (error)** — `CSReporter` called statically, not via
  `getInstance()`.
- **SYN008 (error)** — `CSAssert` called via `getInstance()`,
  not statically.
- **SYN009 (error)** — `CSConfigurationManager` obtained via
  `getInstance()`.
- **SYN010 (error)** — `CSBDDContext` obtained via
  `getInstance()`, not `new`.

## Locator rules (LOC)

- **LOC001 (error)** — Locators live only in page object
  classes, never in step definitions, specs, or helpers.
- **LOC002 (warning)** — Absolute xpath starting with
  `/html/body` is a last resort; prefer role or testId.
- **LOC003 (warning)** — Selectors with auto-generated class
  names (`css-1a2b3c`) are brittle.
- **LOC004 (error)** — Dynamic element locators inside methods
  use `CSElementFactory`, not inline `new CSWebElement(...)`.
- **LOC005 (warning)** — Prefer role + name over xpath when the
  accessibility tree reveals it.

## Assertion rules (ASS)

- **ASS001 (error)** — Every assertion is awaited.
- **ASS002 (error)** — Assertion message (last parameter) is
  non-empty.
- **ASS003 (error)** — `CSAssert.getInstance().assert*` or
  `CSExpect.getInstance()` used, not Node `assert` or raw
  Playwright `expect`.
- **ASS004 (warning)** — Negative assertions use `Not` variants
  (`assertNotEqual`, `assertNotVisible`) over `assertFalse(...
  === ...)`.
- **ASS005 (error)** — Parameter order is `actual, expected,
  message`.

## Reporter rules (REP)

- **REP001 (error)** — No `console.log`, `console.error`,
  `console.warn`, `console.info`, `console.debug`.
- **REP002 (error)** — `CSReporter.info` at start of a step
  action, `CSReporter.pass` at end.
- **REP003 (warning)** — Helper internal logging uses
  `CSReporter.debug`, not `info`.
- **REP004 (error)** — `CSReporter.fail` followed by a throw
  statement or assertion that throws.
- **REP005 (error)** — No third-party logger imports (`debug`,
  `winston`, `pino`, etc.).

## Database rules (DB)

- **DB001 (error)** — SQL strings never inline in TypeScript.
  Use named queries via `CSDBUtils`.
- **DB002 (error)** — Named queries in env files use
  `DB_QUERY_*` prefix.
- **DB003 (error)** — Parameters use `?` placeholders, not
  string interpolation.
- **DB004 (error)** — Transactions use
  `CSDBUtils.executeTransaction(alias, queries[])` array form.
- **DB005 (error)** — Stored procedures use
  `CSDBUtils.executeStoredProcedure(...)`, not raw
  `BEGIN`/`EXEC`/`CALL` strings.
- **DB006 (error)** — No `new CSDBUtils()` or
  `CSDBUtils.getInstance(...)`. All calls are static.
- **DB007 (error)** — Database calls live in step definitions,
  helpers, or hooks — never in page objects.
- **DB008 (error)** — `DATABASE_CONNECTIONS` config lists every
  active alias.

## Configuration rules (CFG)

- **CFG001 (error)** — Sensitive values (passwords, keys,
  tokens) use `ENCRYPTED:` prefix in env files.
- **CFG002 (error)** — `${VAR}` references in env files
  resolve to defined variables.
- **CFG003 (warning)** — Values that differ per environment
  live under `environments/`, not `common/` or `global.env`.
- **CFG004 (error)** — URLs, credentials, and connection
  strings are never hardcoded in source files.
- **CFG005 (error)** — Every environment file sets
  `ENVIRONMENT=<name>`.

## Duplication rules (DUP)

- **DUP001 (error)** — No two step decorator patterns match
  the same feature line (cross-file check).
- **DUP002 (error)** — No duplicate method names within a
  class.
- **DUP003 (error)** — No duplicate scenario names within a
  feature file.
- **DUP004 (error)** — No duplicate `DB_QUERY_*` keys across
  query files.
- **DUP005 (error)** — No duplicate `@CSPage` identifiers
  across page object files.
- **DUP006 (warning)** — No helper method that wraps a single
  framework utility call without adding value.

## Forbidden words / patterns (FWD)

- **FWD001 (error)** — No `TODO`, `FIXME`, or `XXX` comments
  in generated code. Record pending work in the generation
  manifest's `notes` field instead.
- **FWD002 (error)** — No `@pending` tags on scenarios. Every
  scenario must be fully migrated or escalated.
- **FWD003 (warning)** — No commented-out code blocks. Delete
  code that isn't used.
- **FWD004 (error)** — No `console` references.
- **FWD005 (error)** — No `debugger` statements.

## Security rules (SEC)

- **SEC001 (error)** — No plain-text passwords, API keys,
  tokens, secrets, certificates in any file.
- **SEC002 (error)** — Raw secret values not logged via
  `CSReporter`.
- **SEC003 (warning)** — Secrets in env files use the
  `ENCRYPTED:` prefix.
- **SEC004 (error)** — No disabled TLS verification
  (`rejectUnauthorized: false`) in API client configuration.

## Feature file rules (FEA)

- **FEA001 (error)** — Parameters use `"<paramName>"` syntax
  (double quotes, angle brackets).
- **FEA002 (error)** — Every scenario has at least three
  verification steps (thin scenario rejection).
- **FEA003 (error)** — Every scenario has a legacy test case
  ID tag when migrated from legacy.
- **FEA004 (error)** — Every scenario has at least one scope
  tag (`@smoke`, `@regression`, `@sanity`).
- **FEA005 (warning)** — Scenarios longer than ten steps use
  comment banners for readability.

## Data file rules (DAT)

- **DAT001 (error)** — Every scenario row has `scenarioId`,
  `scenarioName`, `runFlag` fields.
- **DAT002 (error)** — Row count matches legacy source exactly
  (when legacy source provided).
- **DAT003 (error)** — Column count matches legacy source
  exactly.
- **DAT004 (error)** — All keys match feature file `<parameters>`
  by camelCase.
- **DAT005 (error)** — Sensitive values use `{config:...}`
  references.
- **DAT006 (error)** — Empty legacy cells become `""`, never
  missing keys.

## Rule application by file type

Each rule applies to specific file types. The
the audit checklist(filePath, fileType)` tool uses the `fileType`
argument to select the rule set:

| File type | Applicable rule categories |
|---|---|
| page-object (.ts) | IMP, NAM, STR, DEC, SYN, LOC, ASS, REP, DUP, FWD, SEC |
| step-definition (.steps.ts) | IMP, NAM, STR, DEC, SYN, LOC, ASS, REP, DB, DUP, FWD, SEC |
| feature (.feature) | NAM, STR, DUP, FWD, FEA |
| data (.json/.csv) | DAT |
| config (.env) | NAM, CFG, DUP, SEC |
| helper (.ts) | IMP, NAM, STR, SYN, REP, DB, DUP, FWD, SEC |

## Rule lifecycle

- Generators check rules before compilation by calling
  the audit checklist(content, fileType)` on every draft file
- Healers re-check the full rule set after applying fixes
- New rules are added here as new violation patterns are
  detected during real migrations
- Deprecated rules are marked `(deprecated)` but remain until
  all projects have migrated past them

## Self-check before returning any generated file

- [ ] File type matches the expected naming and placement
- [ ] No imports violate IMP001-IMP007
- [ ] No structural rules violated (STR001-STR011)
- [ ] No decorator rules violated (DEC001-DEC006)
- [ ] No forbidden API calls (SYN001-SYN010)
- [ ] No locator placement violations (LOC001-LOC005)
- [ ] Every assertion is awaited and has a message (ASS001-ASS005)
- [ ] Reporter usage follows REP001-REP005
- [ ] Database rules pass (DB001-DB008) for any file that
      touches DB
- [ ] No duplicates (DUP001-DUP006)
- [ ] No forbidden words or commented-out code (FWD001-FWD005)
- [ ] No plain-text secrets (SEC001-SEC004)

Run the audit checklist(content, fileType)` after completing the
self-check. If the tool reports any additional errors, fix
them and re-run.
