---
description: Multi-lens PR audit (security, coverage, conventions, regression). Posts a consolidated review comment via HITL.
argument-hint: "<repositoryId> <pullRequestId>"
tools:
  - cs-qa/cs_qa_ado_pr_get_diff
  - cs-qa/cs_qa_ado_pr_list
  - cs-qa/cs_qa_ado_workitem_get
  - cs-qa/cs_qa_ado_workitem_query_wiql
  - cs-qa/cs_qa_ado_repo_read_file
  - cs-qa/cs_qa_scope_regression
  - cs-qa/cs_qa_run_test
  - cs-qa/cs_qa_validate_generated_code
  - cs-qa/cs_qa_index_features
  - cs-qa/cs_qa_index_step_defs
  - cs-qa/cs_qa_index_page_objects
  - cs-qa/cs_qa_preview_pr_comment
  - cs-qa/cs_qa_confirm_pr_comment
max_iterations: 8
expected_token_budget: 80000
---

# /audit-pr

Delegate to pr-auditor. It spawns 4 lens subagents in parallel, merges
findings, and drafts a consolidated PR comment.

## Steps

Handled by pr-auditor.agent.md:
1. Fetch diff + scope regression.
2. Spawn: security-review, coverage, conventions, regression subagents.
3. Merge findings (severity: blocker > warning > info).
4. Compose Markdown comment (≤4000 chars per ADO thread limit).
5. HITL: cs_qa_preview_pr_comment → user confirms → cs_qa_confirm_pr_comment.

## Rules

- Never post a comment auto — always HITL confirm.
- Never bulk-read files; use scope_regression + validate_generated_code
  batched for the actually-changed set.
- Subagents run inside Copilot Chat's Agent Mode, not via CLI (vscode#304574).
- Comment format: emoji-severity + file:line + issue + fix, per section
  by lens.

## Token budget

80K target. Distribution:
- Diff fetch + regression scope: 5K
- Each subagent (4 total): 15-18K each = 60-72K
- Synthesis + comment: 5-8K

If lens findings would exceed 4K comment cap, split into multiple threads.
