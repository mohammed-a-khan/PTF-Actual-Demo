---
name: ir-and-session-state
description: Canonical JSON shapes for the intermediate representation (IR) shared between agents and the orchestrator session state file.
---

# IR (intermediate representation)

Analyzer produces IR. Every downstream agent reads IR. Shape is stable across source languages.

```json
{
  "source": {
    "path": "<absolute path | URL>",
    "language": "java | csharp | html-dom",
    "test_runner": "testng | junit4 | junit5 | nunit | xunit | greenfield",
    "ui_library": "selenium | webdriver.io | playwright-legacy",
    "hash": "sha256-<16 hex chars>"
  },
  "tests": [
    {
      "id": "TC_001",
      "name": "valid login",
      "description": "optional",
      "tags": ["@smoke", "@login"],
      "legacy_metadata": { "original_id": "TS_4482", "priority": "P1" },
      "data_refs": [
        { "key": "userName", "source_file": "test-data/users.xlsx", "sheet": "Users", "row_key": "TC_001" }
      ],
      "steps": [
        { "action": "navigate", "target": { "type": "config", "key": "BASE_URL" } },
        { "action": "click",    "element": { "field": "signInButton" } },
        { "action": "fill",     "element": { "field": "userIdField" }, "value": "$data.userName" },
        { "action": "assert_text", "element": { "field": "welcomeHeader" }, "expected": "Welcome" }
      ],
      "db_ops": [
        {
          "type": "select",
          "sql_raw": "SELECT id, name FROM users WHERE email = ?",
          "params": ["$userEmail"],
          "suggested_name": "USER_FIND_BY_EMAIL",
          "return_shape": "single-row"
        }
      ]
    }
  ],
  "page_objects": [
    {
      "name": "LoginPage",
      "screen_hint": "login",
      "elements": [
        { "field": "userIdField", "locator_type": "id", "value": "userId", "description": "User Id input" }
      ]
    }
  ],
  "summary": {
    "test_count": 1,
    "data_file_count": 1,
    "db_op_count": 1,
    "parse_confidence": "high | medium | low"
  }
}
```

## Enriched IR (after Locator Reconciler)

Every element gains:
```json
{
  "field": "userIdField",
  "description": "User Id input",
  "primary": { "locator_type": "xpath", "value": "//input[@id=\"userId\"]", "confidence": 95 },
  "alternatives": ["css:input#userId", "role:textbox|name:User Id"],
  "source": "live-DOM | memory | source-only",
  "selfHeal": true,
  "waitForVisible": true
}
```

# Session state

`.agent-runs/session-<runId>.json`:

```json
{
  "runId": "2026-04-23T14-02-11-a7f3",
  "project": "my-project",
  "mode": "migration | greenfield",
  "processed": ["LoginTest.java"],
  "approved": ["LoginTest.java"],
  "rejected": [],
  "pending": ["LogoutTest.java", "PasswordResetTest.java"],
  "currentStage": "GATE | RUNNING | AWAITING_USER_APPROVAL | IDLE",
  "correctionPatternsApplied": [],
  "_createdAt": "...",
  "_updatedAt": "..."
}
```

## Rules

- Every agent reads IR; no agent re-parses source
- `source.hash` lets downstream agents cache — same hash → same IR, reuse
- Empty arrays, not nulls, for no-data cases (`data_refs: []`, `db_ops: []`)
- Agents mutate nothing in-place; they return enriched copies
- Session state is shallow-merged on every update (`state_write` semantics)
