---
name: ff-scenario-outline
description: Use when authoring a feature file with data-driven scenarios. Covers Scenario Outline + the JSON-sourced Examples block with filter syntax.
---

# Pattern: data-driven feature file with JSON Examples

## When to use

Any scenario that varies by data — different users, different inputs, different expected outcomes. The data lives in a sibling `_scenarios.json` file referenced from the `Examples:` block.

## Example

```gherkin
@my-project @login @smoke
Feature: Login — authenticated user reaches the dashboard

  @TS_LOGIN_01
  Scenario Outline: Valid credentials redirect to dashboard
    When I navigate to the login page
    And I login as "<userName>" with password "<password>"
    Then I should see the dashboard welcome for "<userName>"
    And the dashboard header should be visible
    And the account switcher should be enabled

    Examples: {"type": "json", "source": "test/my-project/data/login/login_scenarios.json", "path": "$", "filter": "scenarioId=TS_LOGIN_01 AND runFlag=Yes"}
```

And its sibling data file `login_scenarios.json`:

```json
[
  {
    "scenarioId": "TS_LOGIN_01",
    "scenarioName": "Standard user logs in",
    "userName": "alice@example.com",
    "password": "ENC:{AES256}xxxxx",
    "runFlag": "Yes"
  }
]
```

## Rules

- Feature-level tags: project tag (e.g., `@my-project`) + at least one module/area tag
- Scenario-level tag: the legacy test id (e.g., `@TS_LOGIN_01`) — preserve 1:1 with legacy, never rename
- `Scenario Outline` + `Examples:` (not plain `Scenario`) for data-driven tests
- `Examples:` block is a JSON object on one line with these keys:
  - `"type": "json"`
  - `"source"`: path relative to workspace root
  - `"path"`: JQ-style path into the file (usually `"$"` for root array)
  - `"filter"`: `"scenarioId=<id> AND runFlag=Yes"` — both clauses required
- Placeholders `<fieldName>` in steps must match JSON field names exactly
- Every scenario has at least 3 Then/And verification steps — thin scenarios (<3 verifications) are rejected by the audit
- No `@pending`, `@skip`, `@wip` tags on shipped scenarios — use `runFlag: "No"` in the JSON instead
