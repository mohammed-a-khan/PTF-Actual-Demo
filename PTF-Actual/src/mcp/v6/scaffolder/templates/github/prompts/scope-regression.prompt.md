---
description: Given a git diff or a PR, identify affected spec/feature files. Deterministic — no LLM reasoning.
argument-hint: "<fromRef> [toRef=HEAD]  OR  --pr <prId> --repo <repoId>"
tools:
  - cs-qa/cs_qa_scope_regression
  - cs-qa/cs_qa_ado_pr_get_diff
  - cs-qa/cs_qa_index_page_objects
  - cs-qa/cs_qa_index_step_defs
  - cs-qa/cs_qa_index_features
max_iterations: 2
expected_token_budget: 8000
---

# /scope-regression

Deterministic scope analysis.

## Steps

If arg 1 is a ref name:
- `cs_qa_scope_regression({ fromRef: '${input:1}', toRef: '${input:2}' })`
  (toRef defaults to HEAD).

If arg 1 is `--pr`:
- `cs_qa_ado_pr_get_diff({ repositoryId: <repo>, pullRequestId: <prId> })`
- Extract source + target refs, call `cs_qa_scope_regression`.

Present output as bulleted lists:
- Changed files
- Affected specs (per changed file)
- Suggested selector for cs_qa_run_test
- Unmapped changed files (coverage gap)

## Rules

- Never run tests; report only. User runs the suggested selector via
  `/heal-failures` or manual `cs_qa_run_test`.
- Never modify anything. Read-only.

## Token budget

8K target — deterministic-heavy, minimal LLM reasoning.
