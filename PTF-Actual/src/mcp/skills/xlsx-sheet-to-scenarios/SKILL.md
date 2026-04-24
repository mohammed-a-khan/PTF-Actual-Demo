---
name: xlsx-sheet-to-scenarios
description: Use when converting a legacy Excel sheet into a scenarios JSON file. One sheet → one scenarios JSON.
---

# Pattern: xlsx sheet → scenarios JSON (flat shape)

## When to use

Legacy projects typically ship a single `.xlsx` file with one sheet per feature / module. Each row is one test case. The tool `data_parse` auto-detects xlsx and emits canonical scenarios JSON.

## How the mapping works

- **First row** of the sheet = header = becomes JSON field names (camelCased)
- **Subsequent rows** = scenarios
- Column recognised as `scenarioId` (or `testId`, `tcId`, `id`) supplies `scenarioId`
- Column `runFlag` / `run` supplies `runFlag` ("Yes" or "No")
- Missing `scenarioId` → auto-generated `TC_001`, `TC_002`, ...

## Example

Source sheet:

| scenarioId | scenarioName | userName | expectedHeader | runFlag |
|---|---|---|---|---|
| TS_LOGIN_01 | Standard login | alice@example.com | Welcome, Alice | Yes |
| TS_LOGIN_02 | Locked account | locked@example.com | Account locked | Yes |
| TS_LOGIN_03 | Pending reset | reset@example.com | Reset email sent | No |

`data_parse` invocation:

```
data_parse(path: "test-data/login.xlsx")
```

Output JSON:

```json
[
  { "scenarioId": "TS_LOGIN_01", "scenarioName": "Standard login",
    "userName": "alice@example.com", "expectedHeader": "Welcome, Alice", "runFlag": "Yes" },
  { "scenarioId": "TS_LOGIN_02", "scenarioName": "Locked account",
    "userName": "locked@example.com", "expectedHeader": "Account locked", "runFlag": "Yes" },
  { "scenarioId": "TS_LOGIN_03", "scenarioName": "Pending reset",
    "userName": "reset@example.com", "expectedHeader": "Reset email sent", "runFlag": "No" }
]
```

## Rules

- One sheet → one JSON scenarios file (unless multi-row-per-id shape, see `xlsx-multi-row-per-id`)
- Sheet headers become camelCase keys (`User Name` → `userName`, `Expected Header` → `expectedHeader`)
- Empty cells → missing keys in the JSON (not empty string), so agents can reason about optional fields
- No `REPLACE_WITH_*` values ever — if a cell is known-incomplete, set `runFlag: No`
- Re-running `data_parse` on the same xlsx should be idempotent (deterministic ordering)
