---
description: Push local branch to origin + open a PR via HITL preview+confirm. Uses cs_qa_push_branch + cs_qa_preview_pr_create + cs_qa_confirm_pr_create.
argument-hint: "<branch>  <title>  [description]  [workItemIds]"
tools:
  - cs-qa/cs_qa_push_branch
  - cs-qa/cs_qa_preview_pr_create
  - cs-qa/cs_qa_confirm_pr_create
  - cs-qa/cs_qa_ado_pr_list
max_iterations: 3
expected_token_budget: 5000
---

# /push-pr

Deterministic push + open-PR flow.

## Steps

1. `cs_qa_push_branch({ branch: '${input:1}' })` — pushes the local
   branch to origin with `-u`. If already pushed, git returns
   "everything up-to-date" — no-op.

2. `cs_qa_preview_pr_create({ repositoryId, sourceBranch: '${input:1}',
   targetBranch, title: '${input:2}', description?: '${input:3}',
   workItemIds?: [...] })` — get HMAC preview + token.

3. **HITL.** Present preview to user + ask to confirm.

4. `cs_qa_confirm_pr_create({ token, ...same params })` — opens the PR.

5. Return the PR URL.

## Rules

- Push MUST succeed before preview. If `pushed: false`, halt with the
  stderr from git.
- User picks `targetBranch` (default `main` — but check if repo uses
  `master` or a release branch).
- Never open a PR without HITL confirm.

## Token budget

5K target — mostly deterministic. Only LLM turn is composing the PR
description if user didn't supply one.
