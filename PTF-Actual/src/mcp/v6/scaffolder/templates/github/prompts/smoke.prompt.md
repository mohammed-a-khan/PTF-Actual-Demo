---
description: CI dry-run of every v3 slash-command pipeline against fixture inputs. Fails if any pipeline errors or overshoots its declared expected_token_budget.
argument-hint: "(no args — CI invokes)"
tools:
  - cs-qa/cs_qa_status
  - cs-qa/cs_qa_find_tool
  - cs-qa/cs_qa_publish_feature_to_ado
  - cs-qa/cs_qa_detect_tc_drift
  - cs-qa/cs_qa_ado_testplan_list
  - cs-qa/cs_qa_scope_regression
  - cs-qa/cs_qa_run_test
  - cs-qa/cs_qa_heal_loop
  - cs-qa/cs_qa_index_page_objects
  - cs-qa/cs_qa_index_step_defs
  - cs-qa/cs_qa_index_features
  - cs-qa/cs_qa_find_similar_page
  - cs-qa/cs_qa_validate_generated_code
  - cs-qa/cs_qa_rewrite_playwright_to_wrappers
  - cs-qa/cs_qa_parse_brd_txt
  - cs-qa/cs_qa_parse_brd_csv
  - cs-qa/cs_qa_parse_brd_xlsx
  - cs-qa/cs_qa_parse_brd_pdf
  - cs-qa/cs_qa_parse_brd_docx
  - cs-qa/cs_qa_detect_legacy_source
  - cs-qa/cs_qa_extract_legacy_locators
  - cs-qa/cs_qa_transpile_legacy_page
  - cs-qa/cs_qa_transpile_legacy_test
  - cs-qa/cs_qa_explore
  - cs-qa/cs_qa_capture_flow
  - cs-qa/cs_qa_find_dupe_bug
  - cs-qa/cs_qa_preview_bug
  - cs-qa/cs_qa_ado_pr_list
  - cs-qa/cs_qa_db_select
  - cs-qa/cs_qa_cost_report
  - cs-qa/cs_qa_coverage_gate
  - cs-qa/cs_qa_compliance_report
  - cs-qa/cs_qa_otel_export
max_iterations: 4
expected_token_budget: 30000
---

# /smoke

End-to-end dry-run of every v3 pipeline. Used by CI on every framework
release + by anyone who wants a fast health check.

## What it does

Runs each callable pipeline against a fixture input (`test/fixtures/smoke/`)
in dry-run mode where possible:

  * cs_qa_status — sanity
  * cs_qa_find_tool — 3 queries; expect matches
  * cs_qa_index_{page_objects,step_defs,features} — expect no crashes
  * cs_qa_validate_generated_code — against a known-clean fixture (expect ok:true)
  * cs_qa_rewrite_playwright_to_wrappers — against a fixture with raw `page.locator`
  * cs_qa_parse_brd_txt/csv/xlsx — expect ≥1 requirement each from fixtures
  * cs_qa_detect_legacy_source — expect selenium-java match on fixture
  * cs_qa_transpile_legacy_page/test — expect skeleton emit
  * cs_qa_explore — invoke with elapsedMs=0 to prove state tracker
  * cs_qa_capture_flow — with all-gates-clean fixture; expect canAutoCommit:true
  * cs_qa_scope_regression — expect graceful no-op on unchanged workspace
  * cs_qa_db_select — expect SELECT-only guard fires on INSERT fixture
  * cs_qa_cost_report — after all the above, expect ≥N entries
  * cs_qa_coverage_gate — with warnOnly:true, expect no crash
  * cs_qa_compliance_report — expect markdown output ≥100 chars

## Rules

- Fixtures live in `test/fixtures/smoke/` — DO NOT touch consumer state.
- Any tool that would mutate ADO (create/update/publish) is called with
  `dryRun: true` where the tool supports it, or SKIPPED entirely.
- Total budget: 30K tokens across all pipelines. Overshoot = FAIL.

## When to invoke

- CI, on every commit to main.
- Manually, after a Copilot restart to confirm every tool loads.
