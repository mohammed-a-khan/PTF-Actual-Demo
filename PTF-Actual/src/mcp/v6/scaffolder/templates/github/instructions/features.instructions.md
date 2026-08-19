---
applyTo: "**/*.feature"
---

# Gherkin feature-file rules

- Given/When/Then vocabulary: use `Given` for setup, `When` for the action
  under test, `Then` for assertions. `And`/`But` continue the previous verb.
- Scenario names describe the business outcome, not the mechanics.
  `Scenario: User cannot submit payment above daily limit` ✓
  `Scenario: Click submit button on payment form` ✗
- Every scenario carries `@TC:NNN` (ADO test case id) and `@P1|@P2|@P3` (priority).
- `Scenario Outline` + `Examples:` for data-driven cases. Examples supports:
  - Table shape (Gherkin native)
  - Framework JSON shape: `type: 'excel' | 'csv' | 'json' | 'xlsx'`,
    `source: '<path>'`, `sheet?: string`, `filter?: 'runMode=yes'`
- Never inline test data > 5 rows — externalize.
- Tag conventions: `@Regression`, `@Smoke`, `@Migration`, `@Manual`, `@Skip`,
  `@exploratory-unvetted` (auto-committed by `/explore`, promoted after review).
- No AFDD / app-source references anywhere. Cite AFDD sections only in
  companion gap docs.
