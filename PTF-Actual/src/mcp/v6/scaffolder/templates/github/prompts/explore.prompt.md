---
description: Bounded exploratory walk of a target app URL. Captures flows through D8 6-gate quality-check; auto-commits (with HITL) only when all 6 pass.
argument-hint: "<url>  [--goal='...']  [--credentials=user:pw]"
tools:
  - cs-qa/cs_qa_explore
  - cs-qa/cs_qa_capture_flow
  - cs-qa/cs_qa_run_test
  - cs-qa/cs_qa_validate_generated_code
  - cs-qa/cs_qa_index_features
  - cs-qa/cs_qa_rewrite_playwright_to_wrappers
  - playwright/browser_navigate
  - playwright/browser_snapshot
  - playwright/browser_click
  - playwright/browser_type
  - playwright/browser_fill_form
  - playwright/browser_select_option
  - playwright/browser_verify_element_visible
  - playwright/browser_verify_text_visible
  - playwright/browser_generate_locator
  - playwright/browser_network_requests
max_iterations: 20
expected_token_budget: 400000
---

# /explore

Delegate to exploratory-tester with startUrl=`${input:1}`.

## Session bounds

Defaults (agent tracks + `cs_qa_explore` enforces):
- maxDepth: 4 clicks
- maxWidth: 10 flows
- maxDurationMs: 900000 (15 min)

## Steps

Handled by exploratory-tester.agent.md — see there for the loop.

## Rules

- SCOPE every browser_snapshot. Full-page = 50-135K tokens per call.
- Never navigate outside startUrl's origin.
- Never use browser_run_code_unsafe.
- Auto-commit only when all 6 D8 gates pass AND user confirms PR preview.

## Token budget

400K per 15-min session. Given Copilot's token-based billing, ONE
misconfigured exploration can burn 20-40× the cost of a normal
`/generate-from-story`. Use only when the target app genuinely needs
exploration (no ADO story, no BRD).
