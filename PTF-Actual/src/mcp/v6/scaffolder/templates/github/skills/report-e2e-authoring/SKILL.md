---
name: report-e2e-authoring
description: Author end-to-end PDF regression tests where the app UI produces the PDF (login → nav → enter data → generate → validate). Load this when the user is building a NEW report test from scratch AND has an application to drive, not just a PDF in hand.
triggers:
  - end-to-end PDF test
  - generate PDF from UI
  - report end-to-end
  - login and download PDF
  - PDF regression automation
tokenBudget: 1600
---

# End-to-End Report Test Authoring — Five Patterns

Use this skill when the consumer must drive an application (login, nav, forms) to produce the PDF THEN validate it. If the PDF is already on disk, use the smaller `report-validation` skill.

## Source normalization (always first)

If the user provided an ADO story / test case / test plan / requirements-doc / source-code repo, run them through `cs_qa_intent_brief verb=build` FIRST. The brief is the small structured shape every downstream step reads — never round-trip raw sources through the model.

```
cs_qa_intent_brief({
  verb: 'build',
  sources: [
    { kind: 'ado-story', ref: '12345' },
    { kind: 'repo', ref: '/path/to/app-src', pathGlob: 'src/pegas/**' },
    { kind: 'doc-set', ref: ['./reqs/pegas-invoice.pdf'], corpusName: 'pegas-reqs' }
  ]
})
→ { briefId, brief: { title, acceptanceCriteria, targetScreens, dataInputs, reportOutputs, provenance, warnings } }
```

Trust order for conflict resolution: source code > ADO test case > ADO test plan > ADO story > docs > openapi. When the story says "user enters Name" and the source-code says "field allows [A-Z0-9]{6,}", trust the source.

## The five patterns

Each pattern differs ONLY in where expected values come from. The UI-side authoring (page objects, step-defs, feature file) is the same as any other UI test — reuse `/generate-from-story` or the underlying primitives (`cs_qa_start_run`, `cs_qa_prep_design`, `cs_qa_snapshot_screen`, `cs_qa_generate_files`).

### Pattern 1 — File-source
Expected values in JSON. Scenario data-driven off it. Simplest.
```
Scenario Outline: <scenarioId> — invoice PDF matches values
  Given the expected report values from the current scenario row
  Then the PDF at "<pdfPath>" matches spec "<specName>"
  Examples: {"type":"json","source":"test/pegas/data/invoice_scenarios.json"}
```

### Pattern 2 — DB-source
Expected values fetched from the source-of-truth DB after generation.
```
Scenario: Standard invoice PDF matches values fetched from the DB
  Given I fetch expected invoice header from DB for id "2448711"
  When I download the invoice PDF for id "2448711"
  Then the last downloaded PDF matches spec "invoice-standard"
```
Under the hood: DB step uses `cs_qa_db_select` in the framework, bag stored in `CSBDDContext`.

### Pattern 3 — UI-capture
Remember what was typed into the form as the test drives it. Best when there's no DB access and no test-data file.
```
Given I login to the pegas app
When I create a new invoice with:
  | field           | value                  |
  | invoiceNumber   | INV-<UNIQUE>           |
  | payerCompany    | Minnesota Housing FA   |
And I download the generated invoice PDF
Then the downloaded PDF matches spec "invoice-standard" against captured UI values
```
The "create with" step wraps every fill with `cs_qa_capture_ui_values verb=record`. The final step calls verb=dump to build the expectedValues bag. **This is the only pattern that needs `cs_qa_capture_ui_values`.**

### Pattern 4 — UI-fetch
Post-generation display screen holds the source-of-truth. Snapshot that screen, extract text under specific selectors, use as expected. Compose: `cs_qa_snapshot_screen` + a step-def that scrapes elements into a bag.

### Pattern 5 — Report-vs-report
Two PDFs (Crystal-generated vs SSRS-generated, old release vs new release, etc.). Two flavours:
- **Phase 6 versionDiff** in the spec — quick text-diff or structural-diff with drift thresholds. Cheapest.
- **Full CSReportReconciler** — cell-level reconciliation with tolerance rules + known-difference exceptions. Use when audit-trail matters.

## The download-wait wrinkle

After clicking "Generate", the browser fires the download DURING the click. `page.click()` completes but the download event needs to be awaited around the click. That's what `cs_qa_report_download_wait verb=click-then-wait` handles.

```
cs_qa_report_download_wait({
  verb: 'click-then-wait',
  sessionId: <same as cs_qa_browse>,
  triggerSelector: 'button:has-text("Generate Invoice")',
  saveTo: '.cct-qa/downloads/invoice-<uid>.pdf',
  timeoutMs: 30000
})
→ { filePath, sizeBytes, suggestedFilename }
```

## Cost-conscious composition (Copilot per-token billing)

- **Never call `cs_qa_ask_user`.** MCP elicitation is unreliable in Copilot — values don't round-trip. Ask in chat prose or drive from `.cs-qa/e2e-config.json` if the user provided one.
- Slash-command args cover known-upfront choices (`--pattern=ui-capture`).
- Runtime unknowns: model asks the user in its chat response text and waits for the next chat turn before continuing.
- Primitive envelopes stay tight. When a primitive returns `resourceRef`, the model reads it via `cs_qa_fs` ONLY when it needs the specific detail — not up-front.
- RAG corpus builds are expensive on disk + tokens. Reuse an existing corpus rather than rebuilding unless `forceReindex` is set.

## The full pipeline (12 steps, typical spend ~30-60k tokens)

1. `cs_qa_intent_brief verb=build` — reads sources, produces brief.
2. `cs_qa_start_run` — creates run + context.
3. `cs_qa_prep_design` — feed the brief's title/AC/targetScreens/dataInputs; propose a design covering login + nav + data-entry + trigger.
4. `cs_qa_apply_design` — commits the design; primitive enforces AC coverage.
5. For each screen: `cs_qa_snapshot_screen` (headed by default so user sees the walk).
6. `cs_qa_generate_files` — page objects + step-defs + feature file skeleton.
7. Run the UI part end-to-end via `cs_qa_run_tests`, stopping BEFORE the download-and-validate step.
8. `cs_qa_report_download_wait verb=click-then-wait` — capture the PDF.
9. `cs_qa_report_spec_init` on the captured PDF — starter spec.
10. `cs_qa_report_spec_edit verb=add-check-block` for each stricter block the user opts into (asked in chat).
11. Wire the validation scenario using the chosen expected-values pattern; write it via `cs_qa_fs`.
12. `cs_qa_report_validate` — confirm green. If red, iterate via `cs_qa_prep_heal` + `cs_qa_apply_heal`.

Report the summary + HTML report path to the user. Don't paste findings back verbatim.
