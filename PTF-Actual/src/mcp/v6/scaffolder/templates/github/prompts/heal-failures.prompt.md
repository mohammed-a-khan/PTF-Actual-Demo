---
description: Heal a failing test by iterating locator patches via the healer agent (max 3 attempts, revert-on-regression).
argument-hint: "<test-selector> [maxAttempts=3] [healBudgetMs=180000]"
tools:
  - cs-qa/cs_qa_run_test
  - cs-qa/cs_qa_heal_loop
  - cs-qa/cs_qa_rewrite_playwright_to_wrappers
  - playwright/browser_snapshot
  - playwright/browser_verify_element_visible
  - playwright/browser_verify_text_visible
  - playwright/browser_verify_value
  - playwright/browser_generate_locator
max_iterations: 6
expected_token_budget: 40000
---

# /heal-failures

Delegate to the `healer` agent. Selector: `${input:1}` (tag expression
like `@Regression and @Broken` OR a spec path).

## Steps

The healer agent runs the bounded loop per its own definition. Track:
- `attemptNumber` starting at 1
- `elapsedMs` starting at 0
- `priorFailedCount` undefined initially

Each iteration:
1. Call `cs_qa_heal_loop({ selector: '${input:1}', attemptNumber, priorFailedCount, elapsedMs })`.
2. Follow the returned `nextAction` guidance verbatim.
3. If `passed: true` → summarize the successful patches and prompt user
   to open a PR via `/push-pr <branch> "Heal: <one-line summary>"`.
4. If `budgetExhausted` or `attemptsRemaining=0` without green → report
   the unresolved failure with a link to `.cct-qa/heal-attempts.jsonl`;
   do NOT open a PR of failed patches.

## Rules

- Never modify assertions, expected values, or scenario text — locators only.
- Scope every `browser_snapshot` to a region (full-page on SPAs = 50-135K
  tokens — one call can burn the whole session budget).
- If the healer proposes 3 different locator strategies and all fail, the
  test is telling you something is genuinely broken. Hand off to user.

## Token budget

40K per full session (3 attempts × ~12K per iteration). Prompt-file
budget alarm fires at 60K.
