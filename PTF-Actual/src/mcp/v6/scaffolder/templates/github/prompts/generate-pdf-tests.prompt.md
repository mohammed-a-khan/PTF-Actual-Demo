---
name: generate-pdf-tests
description: Walk a folder of PDFs and generate one test-data JSON per PDF pre-populated with detected labels + one BDD feature file. Consumer fills expected values, runs. Zero spec authoring.
agent: agent
argument-hint: <pdf-folder> [--out=<test-data-folder>] [--feature=<feature-path>] [--project=<name>]
tools:
  - cs-qa-v6/cs_qa_fs
  - cs-qa-v6/cs_qa_report_infer_labels
---

# Generate PDF Test-Data Templates + Feature File

Estimated token cost: **~3-8k** depending on PDF count. Cheap. No spec files authored.

## Composition

1. **List the PDFs** — `cs_qa_fs verb=list dir=<pdf-folder> pattern=*.pdf` (recursive on).
2. **For each PDF, infer labels** — `cs_qa_report_infer_labels({verb: "infer", pdfPath, knownLabels: [], max: 50})`. Returns the detected candidate labels (colon-suffix or Title-Case short strings).
3. **Emit ONE JSON per PDF** via `cs_qa_fs verb=write`. Schema:
   ```json
   {
     "Invoice Number": "",
     "Billing Date": "",
     "Total Amount Due:": "",
     "_presence": ["Fee Invoice", "Corporate Trust"],
     "_checks": { "layout": { "minPageCount": 1 }, "textQuality": {} }
   }
   ```
   - Bare-string keys: the detected labels — values BLANK for consumer to fill.
   - `_presence`: any label ≥ 10 chars that isn't colon-suffix and looks template-static.
   - `_checks`: safe defaults — `layout.minPageCount: 1`, `textQuality: {}`. Consumer opts into stricter blocks by editing.
4. **Emit ONE feature file** at `test/<project>/features/pdf_validation.feature`. Schema:
   ```gherkin
   @<project> @pdf-validation
   Feature: <project> PDF regression
     Scenario: <basename> matches expected values
       Then the PDF at "<pdfPath>" matches expected values from "<jsonPath>"
   ```
   One scenario per PDF.
5. **Tell the user in chat prose** the file paths written + how to run:
   > "I generated {n} JSON templates under {out} and one feature at {feature}. Fill in the expected values in each JSON, then `npm run test:{project}` — every non-empty value becomes an assertion."

## Hard rules

- Never call `cs_qa_ask_user` — MCP elicitation is unreliable in Copilot Chat.
- Never author expected VALUES — you don't know them from the PDF alone. Leave them blank; consumer fills.
- Never author a spec file. The whole point of this flow is spec-lessness.
- Never author consumer step-defs. The framework ships the step-def.
- Use `cs_qa_report_infer_labels`, not `cs_qa_report_spec_init` — the latter is the old spec-based path.

## When this prompt is the WRONG tool

- **Two-PDF reconciliation with column aliases + tolerance rules**: use SimpleReportSpec + CSReportReconciler (documented in the older `report-validation` skill).
- **UI-driven flow (login → nav → generate PDF → validate)**: use `/generate-from-pdf-e2e` (kept from v1.51). This prompt assumes PDFs are already on disk.
