---
name: ff-smoke-scenario
description: Use when authoring a single non-data-driven scenario — smoke test, quick health check.
---

# Pattern: simple Scenario (not Outline)

## When to use

A scenario with no data variations — one fixed path, typically a smoke test or a single negative test. Use plain `Scenario:` not `Scenario Outline:`.

## Example

```gherkin
@my-project @login @smoke
Feature: Login — basic smoke

  @TS_LOGIN_SMOKE
  Scenario: Login page loads and required fields are visible
    When I navigate to the application login page
    Then the user id input is visible
    And the password input is visible
    And the sign in button is enabled
```

## Rules

- Feature-level tags: project + feature-area
- Scenario-level tag: legacy test id if this maps to one; otherwise a clear `@<purpose>` tag
- No `Examples:` block for plain `Scenario:`
- At least 3 Then/And verification steps (per audit rule FF004)
- Steps match step-definition text exactly
