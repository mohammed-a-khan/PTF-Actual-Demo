---
applyTo: "**/*.spec.ts"
---

# Playwright spec-file rules

- Only for framework-internal specs (`test/**/*.spec.ts`). Consumer BDD flows
  live in `.feature` + `.steps.ts`.
- Never import from `@playwright/test` in consumer code. Use the framework's
  `@mdakhan.mak/cs-playwright-test-framework/spec` re-exports (`describe`, `test`,
  `expect`, `beforeEach`) so hooks + tagging work.
- `test.describe.configure({ mode: 'parallel' })` at the top of every suite.
- Every `test(...)` must carry an `@TestCaseId:NNN` tag in its name for ADO
  auto-linking.
- Never `test.only(...)` — CI treats it as a failure.
- Use `expect.poll(...)` for async settling, never `waitForTimeout`.
