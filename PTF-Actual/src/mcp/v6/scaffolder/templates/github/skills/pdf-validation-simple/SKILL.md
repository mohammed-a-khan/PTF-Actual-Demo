---
name: pdf-validation-simple
description: Test-data-first PDF regression testing. Load this when the user has a PDF and wants a simple regression scenario without authoring a spec file.
triggers:
  - PDF
  - invoice
  - statement
  - test data JSON
  - regression PDF
tokenBudget: 900
---

# Test-Data-First PDF Validation

**The 80% case in one paragraph**: Drop a PDF. Write ONE JSON per scenario whose keys ARE the labels as they appear in the PDF, values are the expected extractions. Add one BDD line. Done. No spec file, no scenario outline, no consumer step-def, no `currentRow` mechanism.

## When to use this vs the older spec-based path

| Question | Path |
|---|---|
| "Does this PDF have these values?" (single PDF, per-scenario assertions) | **This skill** — test-data-first (v1.52+) |
| Table validation with structured rows + column detection | Older SimpleReportSpec + `spec.tables` (v1.51 surface, still supported) |
| Cell-by-cell reconciliation between TWO reports with column aliases + tolerances + known-differences | SimpleReportSpec + `CSReportReconciler` (v1.51 surface) |
| Simple two-PDF drift check (text/structural diff) | Test-data-first via `_checks.versionDiff` block |

## The test-data JSON contract

```json
{
  "Invoice Number": "2448711",
  "Billing Date": "08/22/2025",
  "Due Date": "09/21/2025",
  "Total Amount Due:": "$200.00",
  "Account Number": "99714300",

  "Mailing Address": {
    "expected": "ACME Corp",
    "readFrom": "leftOf",
    "hint": "in the payer block"
  },

  "_presence": [
    "Fee Invoice",
    "Corporate Trust",
    "Please retain this portion for your records"
  ],

  "_checks": {
    "layout": { "minPageCount": 1 },
    "security": { "forbidRedactionAnnotations": true },
    "textQuality": {},
    "versionDiff": {
      "baselinePdfPath": "samples/reports/legacy-report.pdf",
      "runTextDiff": true,
      "maxAddedLines": 100
    }
  }
}
```

### Rules

- **Bare string value** → framework auto-extracts using AUTO cascade (`inline → right → below` for colon-suffix labels, `inline → below → right` otherwise). Consumer supplies no `readFrom`.
- **Object value** `{expected, readFrom?, kind?, hint?}` → explicit override when AUTO picks wrong. Only needed for `leftOf` / `belowLine` / disambiguation edge cases (~5% of fields).
- **Underscore-prefixed keys** are RESERVED:
  - `_presence: string[]` — substrings the PDF must contain anywhere
  - `_checks: {…}` — Phase 1-6 check blocks (metadata / security / contrast / versionDiff / etc.)
  - `_tables`, `_formatting` — reserved for future v1.53
  - `_meta` — reserved for spec-override escape hatch

## The BDD scenario — one file, one line per scenario

```gherkin
@pegas @pdf
Feature: Pegas Invoice PDF regression
  Scenario: Standard billed invoice
    Then the PDF at "samples/pegas/03_Standard_Billed.pdf" matches expected values from "test/pegas/data/03-standard-billed.json"

  Scenario: Draft variant
    Then the PDF at "samples/pegas/12_Draft_Standard.pdf" matches expected values from "test/pegas/data/12-draft-standard.json"
```

**No Scenario Outline. No Examples. No consumer step-def.** The step-def is shipped by the framework.

## Failure output

Framework rolls every finding into the thrown-error message so CI logs name the drift directly:

```
PDF validation FAILED for "samples/pegas/03_Standard_Billed.pdf" against test-data "03-standard-billed.json"
  field "totalAmountDue": expected="$200.00" extracted="$205.00" (mismatch)
  Text quality (2):
    - [PLACEHOLDER_LEAK] Page 1 contains placeholder pattern "{{amount}}"
    - [PII_LEAK] Page 2 contains PII-shaped substring "111-22-3333"
```

Plus an HTML report drops at `reports/report-validation/<data-name>-<epoch>.html` with the same content in table form.

## Cost-conscious authoring flow

1. `cs_qa_report_infer_labels` on the PDF → returns detected labels the JSON doesn't cover. Use for the FIRST authoring pass to know what to fill.
2. Consumer fills expected values.
3. `cs_qa_report_validate_from_data` for CI validation (or the BDD step for suite runs).
4. Fail → HTML report path in the response envelope. Model reads the resource only if the consumer asks.

## Common pitfalls + fixes

- **`kaylaVang` field appears in the JSON but doesn't extract on other invoices** — that label is dynamic (payer contact name), not a template label. Remove from JSON; add to `_presence` if you want to assert "some contact name exists"; or use a per-scenario JSON.
- **`Amount Due` matches TWO different values (header vs total)** — the AUTO cascade grabs the first match. Add a colon or more specific context to disambiguate: `"Amount Due:": "$200.00"` for the header vs `"Total Amount Due:": "$200.00"` for the total.
- **Label collision across sections** — use the section header as prefix: `"Header - Amount Due"` — framework strips ` - suffix` for extraction; consumer gets a distinctive JSON key.
- **`_checks.versionDiff` gives PAGE_COUNT_DRIFT on Crystal-vs-SSRS** — set `runStructuralDiff: false` and rely on `runTextDiff` for the loose match; use a second spec with strict mode for the "detects drift" negative test.
