---
description: Sanity-check the cs-qa MCP is alive and journalling.
argument-hint: "(no args)"
tools:
  - cs-qa/cs_qa_status
max_iterations: 2
expected_token_budget: 5000
---

Call `cs_qa_status` and report the returned session state as a short bulleted
list. Include:
- version
- workspaceRoot
- journalDir
- session.auditEntries (how many tool calls have been journaled)
- adoConfigured (true/false)

Then confirm to the user that the MCP interceptor is live by naming ONE audit
entry that was just written (this very call is journaled).

Do not call any other tool. Do not narrate your reasoning.
