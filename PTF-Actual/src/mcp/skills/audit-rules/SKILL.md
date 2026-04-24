---
name: audit-rules
description: The canonical set of MANDATED rules every generated file must obey. Consumed by the cs-playwright-mcp audit_file tool. Load this skill before generating or reviewing any target file.
---

# CS Playwright Framework — MANDATED Rules

The `audit_file` MCP tool runs these rules deterministically. Any `error`-severity violation blocks the file from advancing to the commit-ready gate.

Rule IDs are stable — referenced by the healer, the generator, and escalation reports.

## Page-object rules (PO)

| ID | Severity | Rule |
|---|---|---|
| PO001 | error | Class decorated with `@CSPage('<kebab-case-id>')` |
| PO002 | error | Class extends `CSBasePage` (or `CSFramePage` if it has a `frame` property) |
| PO003 | error | Every `CSWebElement`-typed field has an `@CSGetElement` decorator |
| PO004 | error | `@CSGetElement` uses `xpath:` as primary locator (not `id:`, `css:`, or `role:` as primary) |
| PO005 | error | Every `@CSGetElement` has a `description:` string |
| PO006 | warn | Interactive elements (inputs, buttons, links, submits) have `selfHeal: true` |
| PO007 | error | No raw `this.page.locator(...)`, `this.page.click(...)`, `this.page.fill(...)` anywhere in the class |
| PO008 | error | Action methods use `*WithTimeout` variants, not bare `click()` / `fill()` |
| PO009 | warn | Navigation-triggering clicks use `clickWithTimeout(30000)` or higher |

## Step-definition rules (SD)

| ID | Severity | Rule |
|---|---|---|
| SD001 | error | Class has `@StepDefinitions` decorator |
| SD002 | error | Page injection via `@Page('<kebab-key>')` — no `new PageName()` anywhere |
| SD003 | error | Step decorator `@CSBDDStepDef('<exact text>')`; no other step decorator permitted |
| SD004 | error | Scenario-scoped state via `CSBDDContext.getInstance()` — no private class fields holding scenario data |
| SD005 | error | Each step body either calls `CSReporter.pass(msg)` on success, or calls `CSReporter.fail(msg)` followed by `throw new Error(msg)` — no silent return |
| SD006 | error | Config access via `CSValueResolver.resolve('{config:<KEY>}', context)` — no raw `process.env` |

## Feature-file rules (FF)

| ID | Severity | Rule |
|---|---|---|
| FF001 | error | Feature-level tags include a project tag + at least one module/feature-area tag |
| FF002 | error | Data-driven scenarios use `Scenario Outline:` + `Examples:` block with `"type": "json"` source |
| FF003 | error | `Examples:` filter clause uses `scenarioId=<id> AND runFlag=Yes` |
| FF004 | warn | Every scenario has at least 3 `Then`/`And` verification steps |

## Data-file rules (DF)

| ID | Severity | Rule |
|---|---|---|
| DF001 | error | Top-level JSON is an array of objects with at minimum `{scenarioId, scenarioName, runFlag}` |
| DF002 | error | No `REPLACE_WITH_*` placeholder values |
| DF003 | error | Every `scenarioId` in a feature file has a matching row in the data JSON |

## Helper / DB rules (DB)

| ID | Severity | Rule |
|---|---|---|
| DB001 | error | No inline SQL in pages or steps; every query resolves to a named entry in `<project>-db-queries.env` invoked via `CSDBUtils.executeQuery(alias, queryName, params)` |
| DB002 | error | Every query's `schema.table.column` is verified by `schema_lookup`; unresolved tables carry `-- SCHEMA REFERENCE NEEDED` sentinel |
| DB003 | error | DB helper methods are `static`, return typed interfaces (not `any`), handle case-tolerant column access (`r.col ?? r.COL`) |

## Cross-cutting rules (CC)

| ID | Severity | Rule |
|---|---|---|
| CC001 | error | No underscore separators in numeric literals — `5000` not `5_000` |
| CC002 | error | No application-source paths referenced in generated file comments (no `/WEB-INF/`, no upstream class names, no line-number citations) |
| CC003 | error | No `console.log` |
| CC004 | error | No bare `expect(...)` from `@playwright/test` |
| CC005 | error | Imports only from `@mdakhan.mak/cs-playwright-test-framework/*` subpaths or local files |
| CC006 | error | No `TODO`, `FIXME`, `XXX`, `HACK`, or `PLACEHOLDER` tokens |
| CC007 | error | No `@pending`, `@skip`, `@wip`, `@ignore` tags on shipped scenarios |

## How agents use this skill

- **Generator** loads this before drafting each file; runs through the rules mentally, then calls `audit_file` to verify deterministically
- **Healer** loads this before every proposed fix; audits the fix content before applying
- **Orchestrator** loads this at the commit-ready gate to verify the `audit_file` report is clean

The `rules.yaml` bundled alongside this SKILL.md is the machine-readable form of the same rule set, consumed directly by the `audit_file` tool.
