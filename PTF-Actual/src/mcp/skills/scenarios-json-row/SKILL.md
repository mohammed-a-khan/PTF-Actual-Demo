---
name: scenarios-json-row
description: Use when authoring or updating a _scenarios.json data file. Covers canonical array shape, required fields, runFlag semantics, and the no-placeholder rule.
---

# Pattern: canonical scenarios JSON shape

## When to use

Every feature file has a matching `<feature>_scenarios.json`. Its shape is fixed — do not improvise.

## Example

```json
[
  {
    "scenarioId": "TS_LOGIN_01",
    "scenarioName": "Standard user logs in successfully",
    "userName": "alice@example.com",
    "expectedDashboardHeader": "Welcome, Alice",
    "runFlag": "Yes"
  },
  {
    "scenarioId": "TS_LOGIN_02",
    "scenarioName": "Locked account shows error banner",
    "userName": "locked@example.com",
    "expectedErrorMessage": "Account locked after too many attempts",
    "runFlag": "Yes"
  },
  {
    "scenarioId": "TS_LOGIN_03",
    "scenarioName": "Password reset redirect flow",
    "runFlag": "No",
    "notes": "Pending: reset-email flow needs test-inbox access"
  }
]
```

## Shape rules

- Top-level is a JSON **array** `[ ... ]`, not an object
- Every row has:
  - `scenarioId` (string) — matches the feature file `filter:` clause
  - `scenarioName` (string) — human-readable summary
  - `runFlag` (string, `"Yes"` or `"No"`)
- Other keys are scenario fields — camelCase, matching the `<placeholders>` in the feature steps exactly
- A row with `runFlag: "No"` may also carry a `notes` field explaining why — helps reviewers

## Forbidden values

- **No `REPLACE_WITH_*` placeholders anywhere.** A row with unresolved values is set to `runFlag: "No"` with a `notes` field, not shipped with a bogus placeholder
- No `TODO`, `FIXME`, `XXX`, `PLACEHOLDER`
- No empty required fields — if a field is unknown, omit the row (don't ship `"userName": ""`)

## Relationship with the feature file

- The feature's `Examples:` `filter` clause (`scenarioId=<id> AND runFlag=Yes`) matches exactly one row with the named id and `Yes` flag
- A feature with N `Scenario Outline:` blocks may reference N different filters in one data file, or N data files
- Every `scenarioId` in the feature must exist in the data file, and every row marked `Yes` should correspond to a feature-file scenario
