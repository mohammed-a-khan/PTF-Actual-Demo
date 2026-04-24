---
name: xlsx-multi-row-per-id
description: Use when a legacy xlsx sheet has multiple data rows per test id (variant rows). Covers flattening into scenarioId suffixes.
---

# Pattern: xlsx with multi-row-per-id shape (variants)

## When to use

Some legacy test-data sheets pack variant data under a single test id — e.g., one "smoke test" runs with three different users, three rows under the same `TS_LOGIN_01` id. `data_parse` handles this by flattening variants into distinct `scenarioId` entries.

## The input shape

Source sheet:

| scenarioId | scenarioName | userName | expectedOutcome | runFlag |
|---|---|---|---|---|
| TS_LOGIN_VARIANTS | Login variant 1 | alice@example.com | Welcome, Alice | Yes |
|   |   (empty)       | bob@example.com  | Welcome, Bob   | Yes |
|   |   (empty)       | charlie@example.com | Welcome, Charlie | Yes |
| TS_LOGOUT_01 | Logout | any@example.com | Goodbye | Yes |

Rows 2–3 share row 1's id because `scenarioId` is blank (variant continuation).

## How the flattening works

`data_parse` produces:

```json
[
  { "scenarioId": "TS_LOGIN_VARIANTS",    "scenarioName": "Login variant 1",
    "userName": "alice@example.com",   "expectedOutcome": "Welcome, Alice",   "runFlag": "Yes" },
  { "scenarioId": "TS_LOGIN_VARIANTS-v2", "scenarioName": "Login variant 1",
    "userName": "bob@example.com",     "expectedOutcome": "Welcome, Bob",     "runFlag": "Yes" },
  { "scenarioId": "TS_LOGIN_VARIANTS-v3", "scenarioName": "Login variant 1",
    "userName": "charlie@example.com", "expectedOutcome": "Welcome, Charlie", "runFlag": "Yes" },
  { "scenarioId": "TS_LOGOUT_01",         "scenarioName": "Logout",
    "userName": "any@example.com",     "expectedOutcome": "Goodbye",          "runFlag": "Yes" }
]
```

## Feature-file consumption

The `Examples:` filter now uses OR to include all variants:

```
filter: "(scenarioId=TS_LOGIN_VARIANTS OR scenarioId=TS_LOGIN_VARIANTS-v2 OR scenarioId=TS_LOGIN_VARIANTS-v3) AND runFlag=Yes"
```

Or simpler — glob prefix:

```
filter: "scenarioId~TS_LOGIN_VARIANTS AND runFlag=Yes"
```

(Depending on framework filter parser support.)

## Rules

- Blank `scenarioId` = continuation of previous row's id with suffix `-vN` (N starting at 2)
- `scenarioName` is inherited from the first variant row unless the variant has its own
- All fields default-inherit the first row's values for any blank cell in the variant
- The flattened output is always the canonical scenarios shape — downstream code treats each variant as a first-class scenario
