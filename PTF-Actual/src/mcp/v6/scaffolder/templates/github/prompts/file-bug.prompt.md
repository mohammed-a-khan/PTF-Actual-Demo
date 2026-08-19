---
description: File an ADO bug from a failure context. Runs dupe detection + HITL preview + confirm.
argument-hint: "<failure-context OR runId>"
tools:
  - cs-qa/cs_qa_find_dupe_bug
  - cs-qa/cs_qa_preview_bug
  - cs-qa/cs_qa_confirm_bug
  - cs-qa/cs_qa_ado_bug_link_to_tc
  - cs-qa/cs_qa_ado_workitem_link_add
  - cs-qa/cs_qa_ado_workitem_get
max_iterations: 5
expected_token_budget: 15000
---

# /file-bug

Delegate to bug-filer. `${input:1}` may be:
- A run id / failure-log path — bug-filer reads the failure context from it.
- A brief natural-language failure description — bug-filer uses it verbatim
  as the seed for title + description.

## Rules

- Never file without dupe check.
- Never file without HITL confirm.
- Never auto-close a duplicate.
- Never file a bug on a `@Migrated` test failure without user OK — those
  failures often reflect known-unfinished migration work rather than app bugs.

## Token budget

15K target — dupe check + preview + confirm is small.
