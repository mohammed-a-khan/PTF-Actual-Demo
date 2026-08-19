---
name: generate-from-story
description: Generate CS Playwright BDD tests from an ADO user story (v4 primitives).
agent: agent
argument-hint: <workItemId> [projectName]
tools:
  - cs-qa-v4/cs_qa_start_run
  - cs-qa-v4/cs_qa_get_run_status
  - cs-qa-v4/cs_qa_prep_design
  - cs-qa-v4/cs_qa_apply_design
  - cs-qa-v4/cs_qa_snapshot_screen
  - cs-qa-v4/cs_qa_generate_files
  - cs-qa-v4/cs_qa_run_tests
  - cs-qa-v4/cs_qa_get_task
  - cs-qa-v4/cs_qa_prep_heal
  - cs-qa-v4/cs_qa_apply_heal
  - cs-qa-v4/cs_qa_finalize_run
  - cs-qa-v4/cs_qa_write_ado_tcs
---

# Generate BDD tests from ADO user story

You are composing v4 QA primitives. Each primitive is a typed, single-purpose tool.
The primitives themselves enforce schema, precondition, coverage, and semantic
verification — you don't police those in prose. Your job is intent + composition.

## Composition

**Given** `${input:1}` (workItemId, mandatory) and optionally `${input:2}` (projectName).

1. **Start** — call `cs_qa_start_run({source: {kind: 'ado-work-item', id: <workItemId>}, projectName})`.
   - Returns `{runId, requirementsSummary, next}`. Read `requirementsSummary.acCount` and `.title` — you need those for the plan.
   - If start_run returned an error, surface it to the user with the field/hint from the error envelope. Stop.

2. **Design context** — call `cs_qa_prep_design({runId})`.
   - Returns `{context, designShapeExample, hint, next}`. The `context.requirements.acceptanceCriteria` is the AC list you MUST cover (one scenario minimum per AC).
   - Compose a `Design` object matching the shape in `designShapeExample`:
     - Each scenario: id `TS_<sourceId>_NN`, acNumbers referencing REAL ACs, category tag, ≥2 steps, ≥1 assertion, reasoning field.
     - Each page-object: PascalCase name ending `Page`, kebab-slug, screens the design touches.
     - Every AC must be covered — the primitive will reject the design otherwise.
   - Call `cs_qa_apply_design({runId, design})`.
   - On `accepted: false`, read `rejections` + `hint`. Revise the design (the rejection will tell you exactly what — missing AC coverage, undeclared page, etc.) and call `cs_qa_apply_design` again.

3. **Snapshot each screen** the design declares.
   - For each `pages[].screens[]`: call `cs_qa_snapshot_screen({runId, label, url, preSteps?})`.
   - **Do NOT pass `headless: true`.** The user needs to see the browser drive through the app so they can trust the walk and diagnose failures visually. The default is headed. Only set `headless: true` if the user explicitly asks for CI/background mode.
   - **CRITICAL for post-save / post-navigation screens:** set `url` to the URL where you START (typically the create/entry URL), NOT the direct target URL. Then use `preSteps` to reach the target state from there. Direct URLs like `/pim/viewEmployee/1` only work if a record was already created in this session; navigating there fresh returns zero selectors.
     - Example (correct) — post-save employee detail tabs: `{url: ".../pim/addEmployee", preSteps: [{action:"fill",selector:"//input[@name='firstName']",value:"Probe"},{action:"fill",selector:"//input[@name='lastName']",value:"Snapshot"},{action:"click",selector:"//button[normalize-space()='Save']"},{action:"waitFor",selector:"//a[contains(.,'Personal Details')]"}]}`
     - Example (wrong) — `{url: ".../pim/viewEmployee/1"}` with preSteps trying to fill the create form. The preSteps target selectors from the CREATE page, which don't exist on the detail page → all fail.
   - The browser session is kept hot across snapshot calls in the same run. Later snapshots inherit the state from earlier ones (post-save session).
   - If a snapshot returns `warning: "Zero unique-verified selectors"`, retry with correct preSteps (start URL + reach steps) OR omit the affected scenarios (do NOT ship stubs).

4. **Generate files** — call `cs_qa_generate_files({runId})`.
   - On `accepted: false`, read `rejections`. Common cause: a scenario references an element name that no snapshot delivered, or a step-name promises verification that its body doesn't perform.
   - **Recovery: `cs_qa_apply_design` accepts a revised design from any pre-run phase** (ingested/designing/designed/exploring/generating). Revise the design — reduce assertions to elements that snapshots actually delivered, remove or split scenarios whose target surfaces were unreachable — then call `cs_qa_apply_design` again. Then re-snapshot any newly-added screens and re-invoke `cs_qa_generate_files`.
   - On success, files are on disk under `test/<projectName>/...`.

5. **Run tests** — call `cs_qa_run_tests({runId})`.
   - Returns `{taskHandle}`. Poll `cs_qa_get_task({runId, taskHandle})` every few seconds until status is `completed`, `failed`, or `cancelled`.
   - If `resultSummary.failed > 0`, proceed to heal loop. If green, jump to finalize.

6. **Heal loop** (for each failure in `resultSummary.failures`).
   - Call `cs_qa_prep_heal({runId, taskHandle, failureId, filePath?})`.
     - On `healed: true`, the fix was auto-applied. Call `cs_qa_run_tests` again to verify.
     - On `healed: false, needsFix: true`, read `failure.error` + `stackExcerpt` + `patternProposal`. Propose a specific fix and call `cs_qa_apply_heal({runId, failureId, fix: {mode: 'replace'|'rewrite', file, ...}, reasoning, autoRerun: true})`.
   - Loop until green OR the cost warning elicits user consent to stop.

7. **ADO test cases** (optional, ask user).
   - If tests are green and source was an ADO work item, ask the user: "Do you want to create ADO test cases in a plan/suite?"
   - If yes, elicit planId + suiteId, then call `cs_qa_write_ado_tcs({runId, planId, suiteId})`.

8. **Finalize** — call `cs_qa_finalize_run({runId})`.
   - Report the summary + reportPath to the user.

## Hard behaviours the primitives enforce (do NOT re-litigate in prose)

- Every AC has at least one scenario (coverage check in `cs_qa_apply_design`).
- No stub verifications (semantic verifier in `cs_qa_generate_files`).
- No `@playwright/test` imports (semantic verifier).
- DB queries are SELECT-only (DbGuard).
- ADO writes require user confirm (AdoWriteGuard elicitation).
- Tool responses ≤5KB (runtime enforcement — large artifacts go to disk).
- Every event is audited to `~/.cs-qa/runs/{runId}/audit.jsonl`.

## What NOT to do

- Do NOT invent selectors — use only ones returned by `cs_qa_snapshot_screen`.
- Do NOT skip an AC to "simplify" — the design will be rejected.
- Do NOT collapse multiple scenarios into one to "save time" — the design will be rejected.
- Do NOT emit stub bodies — the semantic verifier will reject them at `cs_qa_generate_files`.
- Do NOT try to orchestrate the whole workflow in a single tool call — each primitive is one clear decision.

If any primitive returns an error, read the `error.field` + `error.details` and correct the input. Retry the same primitive up to 3× before escalating to the user.
