---
description: Migrate legacy tests (Selenium/UFT/pytest/Playwright/Cucumber-JVM) to framework-shape .feature + steps + page-object.
argument-hint: "<path>  [--module=X]  [--url=Y]"
tools:
  - cs-qa/cs_qa_detect_legacy_source
  - cs-qa/cs_qa_extract_legacy_locators
  - cs-qa/cs_qa_transpile_legacy_page
  - cs-qa/cs_qa_transpile_legacy_test
  - cs-qa/cs_qa_rewrite_playwright_to_wrappers
  - cs-qa/cs_qa_validate_generated_code
  - cs-qa/cs_qa_index_page_objects
  - cs-qa/cs_qa_index_step_defs
  - cs-qa/cs_qa_index_features
  - cs-qa/cs_qa_find_similar_page
  - cs-qa/cs_qa_run_test
  - cs-qa/cs_qa_heal_loop
  - playwright/browser_snapshot
  - playwright/browser_verify_element_visible
  - playwright/browser_generate_locator
max_iterations: 12
expected_token_budget: 100000
---

# /migrate-legacy

Migrate a legacy test file / folder into framework-shape code.

## Steps

1. **Detect + inventory.** If `${input:1}` is a file:
   - `cs_qa_detect_legacy_source({ path: '${input:1}' })`.
   If it's a folder:
   - Enumerate `.java`, `.cs`, `.py`, `.js`, `.ts`, `.vbs`, `.mts`, `.mtr`
     files (cap at 20 for one session — the rest go to follow-up calls).
   - Detect each; group by framework.

2. **Load the matching skill(s).** For each detected framework, ensure
   `.github/skills/migrate-<framework>/SKILL.md` + `examples/*.pair.md`
   are available. If not, ask the user.

3. **Scaffold per file** (concurrency 4):
   - Page-object-shaped file → `cs_qa_transpile_legacy_page`
   - Test file → `cs_qa_transpile_legacy_test`
   - Both → do both.
   - `cs_qa_extract_legacy_locators` supplements when the transpiler
     misses fields.

4. **Fill method bodies** using the skill's training pairs. Every body
   uses framework wrappers.

5. **Rewrite through wrappers + validate** — same protocol as generator.

6. **Handle unmapped abstractions.** If any `transpile_*` returned
   `unmappedAbstractions[]`, halt on those files. Options presented to
   user: skip, add training pair, or user handles manually.

7. **Run smoke.** `cs_qa_run_test({ tags: '@Migrated' })` — every
   migrated scenario should carry the `@Migrated` tag.

8. **Heal.** If failures, delegate to healer (bounded).

9. **Preview PR.**

## Token budget

100K per 10-file batch. Larger sets → chain /migrate-legacy calls.

## Rules

- Never fabricate an abstraction mapping. Skip or ask.
- Never modify assertions during heal.
- Every migrated scenario gets `@Migrated` tag for traceability.
- If any file's language detection is `low` confidence + no `framework`
  arg supplied, ask user before proceeding.
