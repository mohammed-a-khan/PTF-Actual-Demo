---
description: Enumerate an ADO Test Plan, let user pick suites, generate + run tests. Detects drift and offers to sync back to ADO.
argument-hint: "<planId>"
tools:
  - cs-qa/cs_qa_ado_testplan_get
  - cs-qa/cs_qa_ado_testsuite_list
  - cs-qa/cs_qa_ado_testcase_get_in_suite
  - cs-qa/cs_qa_ado_workitem_get
  - cs-qa/cs_qa_ado_workitem_batch_get
  - cs-qa/cs_qa_index_page_objects
  - cs-qa/cs_qa_index_step_defs
  - cs-qa/cs_qa_index_features
  - cs-qa/cs_qa_find_similar_page
  - cs-qa/cs_qa_rewrite_playwright_to_wrappers
  - cs-qa/cs_qa_validate_generated_code
  - cs-qa/cs_qa_detect_tc_drift
  - cs-qa/cs_qa_ado_testcase_update_steps
  - cs-qa/cs_qa_run_test
  - cs-qa/cs_qa_heal_loop
  - cs-qa/cs_qa_publish_feature_to_ado
  - playwright/browser_snapshot
  - playwright/browser_verify_element_visible
  - playwright/browser_generate_locator
max_iterations: 10
expected_token_budget: 80000
---

# /generate-from-test-plan

Plan-id → suite selection → generate tests → run → heal → sync back.

## Steps

1. `cs_qa_ado_testplan_get({ planId: ${input:1} })` — confirm plan exists.
2. `cs_qa_ado_testsuite_list({ planId: ${input:1} })` — list suites.
3. **HITL: which suite(s)?** Present the list; ask user for one or more
   (or "all" — capped at 5 per session to stay under budget).
4. For each selected suite:
   - `cs_qa_ado_testcase_get_in_suite({ planId, suiteId })` — list TCs
     (id + title only; batch-fetch content next).
   - `cs_qa_ado_workitem_batch_get({ ids: [...testCaseIds] })` — bulk
     fetch step content.
   - **Plan.** For each TC, extract scenario shape from
     `Microsoft.VSTS.TCM.Steps` XML.
   - **Generate.** Standard generator protocol.
   - **Detect drift.** For each TC that already had steps, call
     `cs_qa_detect_tc_drift({ testCaseId, featurePath, scenarioTag })`
     to compare committed spec to live ADO TC. If drift:
     - **HITL:** show driftFields. User picks: update ADO to match spec
       (via `cs_qa_ado_testcase_update_steps`), leave alone, or investigate.
5. **Run + heal.** Standard.
6. **Preview PR.** Standard.

## Token budget

80K per suite (design target). Per TC within a suite: ~5-8K.

## Rules

- **Never delete an ADO TC.** If a TC is in the suite but the generated
  spec has no matching scenario, that's an orphan — report but don't
  remove.
- **Drift reconciliation always HITL.** ADO is the source of truth for
  test plans; the spec is the executable — user decides which wins on drift.
- Never process >5 suites per session. Send the user follow-up calls
  for the rest.
