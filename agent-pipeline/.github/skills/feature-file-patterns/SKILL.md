---
name: feature-file-patterns
description: >
  Canonical patterns for writing Gherkin feature files in the target
  test framework. Covers file placement, Feature header, Background
  block, Scenario vs Scenario Outline rules, Examples data sources
  (JSON, CSV, database, API, inline), parameter quoting, tag
  conventions, thin-scenario rejection, and forbidden patterns.
  Load when generating, auditing, or healing any .feature file.
---

# Feature File Patterns

## When this skill applies

Any generated or modified Gherkin feature file — typically
filenames ending in `.feature` under `test/<project>/features/`.

## File placement and naming

- Directory: `test/<project>/features/`, or nested by module for
  large projects.
- Filename: kebab-case or snake_case ending in `.feature` (both
  acceptable; pick one convention project-wide). Avoid PascalCase
  and spaces.
- One feature per file. Never two `Feature:` declarations in the
  same file.
- Never create `index.feature` or barrel-style feature files.

## Feature header structure

Every feature file starts with:

1. A tag line (one or more tags, space-separated)
2. The `Feature:` keyword with a short business title
3. A three-line narrative: `As a ... I want ... So that ...`
4. Optional `Background:` block for common setup

Example:

```
@smoke @regression @orders
Feature: Order search and filtering
  As a customer service representative
  I want to search orders by multiple criteria
  So that I can quickly find a customer's history when they call

  Background:
    Given I am logged in as a customer service representative
```

Rules:
- Tags go on the line immediately above `Feature:`, not below
- Title is plain English, no test IDs, no code references
- Narrative is three lines, `As a` / `I want` / `So that`
- Background is optional but when present it contains only
  pre-condition `Given` steps shared by every scenario in the
  file

## Background block

- Background steps run before every scenario in the file
- Background contains only `Given` steps — no `When`, no `Then`
- Background never contains assertions (no verification, only
  setup)
- Background never contains data-driven steps
- If scenarios have different setups, do NOT force them into one
  Background — use per-scenario Given steps instead
- An empty Background (just the `Background:` keyword and a
  comment) is acceptable as a placeholder but prefer omitting the
  block entirely if there is nothing to put in it

## Scenario vs Scenario Outline — HARD RULE

- Use `Scenario:` ONLY when the scenario has no parameters and no
  `Examples:` data source. Pure static tests.
- Use `Scenario Outline:` WHENEVER the scenario uses `<param>`
  placeholders and/or an `Examples:` data source. This is a hard
  rule. A scenario with `Examples:` declared as plain `Scenario:`
  is a rejected pattern.

Correct static scenario:

```
Scenario: Verify the home page header is visible
  When I navigate to the home page
  Then I should see the header "Home"
```

Correct data-driven scenario:

```
Scenario Outline: Search orders by customer email
  When I login as "<userName>"
  And I search orders for email "<customerEmail>"
  Then the results table should contain "<expectedOrderId>"

  Examples: {"type": "json", "source": "test/<project>/data/order-search-scenarios.json", "path": "$", "filter": "runFlag=Yes"}
```

## Parameter syntax

- Parameters in step phrases use `"<paramName>"` — double quotes
  surrounding angle brackets. This is the only supported syntax.
- Never `'<paramName>'` (single quotes)
- Never `${paramName}` (shell-style)
- Never `{paramName}` (curly braces alone)
- Parameter names are camelCase, matching the keys in the data
  source
- The same parameter may appear multiple times in a scenario —
  each occurrence resolves to the same value

## Examples data sources

The `Examples:` tag takes a JSON object literal describing the
data source. Supported types:

### JSON source (most common)

```
Examples: {"type": "json", "source": "test/<project>/data/file.json", "path": "$", "filter": "runFlag=Yes"}
```

- `type` — `"json"`
- `source` — relative path from project root to the JSON file
- `path` — JSONPath expression; `$` for root, `$.key` for a
  nested collection, `$.parent.child` for deeper nesting
- `filter` — cucumber-expression-style filter on row fields,
  combinable with `AND` / `OR`, e.g., `runFlag=Yes AND region=US`

### CSV source

```
Examples: {"type": "csv", "source": "test/<project>/data/file.csv", "filter": "runFlag=Yes"}
```

- `type` — `"csv"`
- `source` — relative path from project root to the CSV file
- `filter` — same syntax as JSON

### Database source

```
Examples: {"type": "database", "source": "PRIMARY_DB", "query": "DB_QUERY_LIST_TEST_ORDERS", "filter": "region=US"}
```

- `type` — `"database"`
- `source` — database alias (matches `DB_<ALIAS>_*` config)
- `query` — named query key (matches `DB_QUERY_*` in the queries
  env file)
- `filter` — optional post-query filter
- The query returns rows that become scenario iterations; each
  column becomes a `<param>` available in the scenario body

### Inline examples

For small static tables that don't justify a data file:

```
Examples:
  | scenarioId | userName     | expected   |
  | TC_001     | alice        | Dashboard  |
  | TC_002     | bob          | Dashboard  |
  | TC_003     | admin        | Admin page |
```

Use inline examples for throwaway permutations. For any data set
that's reused or maintained, prefer an external source.

## Tag conventions

Tags appear on the line above `Feature:` (feature-level tags) or
above `Scenario:` / `Scenario Outline:` (scenario-level tags).
Multiple tags separated by spaces.

Standard tag categories:

- **Scope**: `@smoke`, `@regression`, `@sanity`, `@wip`, `@manual`
- **Risk**: `@high-risk`, `@medium-risk`, `@low-risk`
- **Module**: `@auth`, `@orders`, `@reporting`, `@admin`, etc.
- **Test case ID**: one per scenario, preserving the legacy test
  identifier exactly. Formats vary by project — `@TC_001`,
  `@TS_90546`, `@REQ-1234`, etc.
- **Data**: `@data-driven`, `@requires-test-user`,
  `@needs-clean-db`
- **Feature flag**: `@feature-flag-xyz-enabled`

Rules:
- Every scenario must carry exactly one test case ID tag when a
  legacy source id exists. Preserve the id 1:1 from the legacy
  source.
- Every scenario must carry at least one scope tag
  (`@smoke`, `@regression`, or `@sanity`).
- Module tags are mandatory for features larger than three
  scenarios.
- Tag names are lowercase kebab-case, always prefixed with `@`.

## Step phrasing

- Present tense, first-person implied: "When I click Save",
  "Then I should see the confirmation message"
- Each `When` step corresponds to one user action
- Each `Then` step corresponds to one verification
- Avoid compound steps that describe multiple actions in one
  phrase (split into two steps)
- Avoid chained verifications in a single `Then` — use `And`
  continuation instead

## Thin scenario rule

A scenario with fewer than three verification steps (`Then` and
`And ... should ...` steps combined) is considered thin and will
be rejected by the audit. Every scenario must verify at least
three distinct properties of the system under test.

The rationale: a scenario with only one assertion usually hides
brittle coverage — it passes green but tells you almost nothing
when it fails. Three-plus verifications give enough signal to
diagnose the failure without re-running.

Thin scenarios are typically symptom of either:
- A missing `Then` section that should exist
- A scenario that should be split into multiple focused ones
- A legacy test migration that dropped assertions along the way

Fix the scenario, not the audit rule.

## Scenario structure

Recommended internal organisation with comment banners for
readability:

```
Scenario Outline: <descriptive title>
  # ============================================================
  # SCENARIO CONTEXT
  # ============================================================
  # Scenario: <scenarioId>
  # User: <userName>

  # ============================================================
  # PART A: <first logical section>
  # ============================================================
  When I login as "<userName>"
  Then I should see the home page

  # ============================================================
  # PART B: <next logical section>
  # ============================================================
  When I navigate to the orders list
  Then I should see the orders table
  And the orders table should have at least one row

  # ============================================================
  # PART C: <verification section>
  # ============================================================
  When I click the first order
  Then I should see the order detail page
  And the order id should match "<expectedOrderId>"

  Examples: {"type": "json", "source": "test/<project>/data/order-scenarios.json", "path": "$", "filter": "runFlag=Yes"}
```

The comment banners are optional but recommended for scenarios
longer than ten steps.

## Forbidden patterns

Never do any of these in a feature file:

- Mix `Scenario:` and `Examples:` — always use `Scenario Outline:`
  with Examples
- Hardcode test data values in scenario bodies (use
  `<parameters>` sourced from Examples)
- Embed step definitions in comments or doc strings
- Use single quotes for parameters: `'<paramName>'`
- Use legacy parameter syntax: `${paramName}`, `{paramName}`
- Reference files or data that don't exist in the project
- Declare two scenarios with the same title in the same feature
- Use `Feature:` inside a scenario title (only one feature per
  file)
- Skip the narrative block (`As a ... I want ... So that ...`)
- Write thin scenarios with fewer than three verification steps
- Forget the legacy test case ID tag when migrating
- Use `When` steps for verifications, or `Then` steps for actions
  (mixing action and verification in one keyword)

## Self-check before returning a feature file

- [ ] Filename ends in `.feature` and uses kebab-case or
      snake_case, never PascalCase
- [ ] Tag line appears above `Feature:`
- [ ] Feature title is plain English, no test ids
- [ ] Narrative block is three lines
- [ ] Background is optional, contains only `Given` steps
- [ ] `Scenario Outline:` used whenever `<parameters>` or
      `Examples:` appear
- [ ] `Scenario:` used only for fully static scenarios
- [ ] All parameters use `"<paramName>"` syntax
- [ ] Every scenario has a test case ID tag (when migrated from
      legacy)
- [ ] Every scenario has at least one scope tag
- [ ] Every scenario has at least three verification steps
- [ ] No duplicate scenario titles in the file
- [ ] Every referenced data file and query exists
- [ ] Every step phrase has a matching step definition somewhere
      in the project (the audit cross-checks this against the
      step registry)

If any item fails, fix it before returning. The audit checklist
enforces most of these rules.
