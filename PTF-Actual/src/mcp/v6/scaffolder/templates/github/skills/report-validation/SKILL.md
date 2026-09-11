---
name: report-validation
description: PDF report regression testing with SimpleReportSpec — load this when the user mentions PDF, invoice, statement, report validation, Crystal, SSRS, or any file-format-driven regression flow.
triggers:
  - PDF
  - report validation
  - invoice check
  - statement compare
  - Crystal
  - SSRS
  - versionDiff
  - report drift
tokenBudget: 1200
---

# Report Validation — Progressive Playbook

Framework has TWO validators. Pick by what the user is trying to do.

| The question | Validator | Primitives |
|---|---|---|
| "Does this PDF have the fields/tables/checks we expect?" | **SimpleReportSpec** (default, 80% of cases) | `cs_qa_report_spec_init`, `cs_qa_report_spec_edit`, `cs_qa_report_validate` |
| "Do these two reports (PDF↔PDF, PDF↔DB) reconcile cell-by-cell with tolerance rules and known-difference exceptions?" | **CSReportReconciler** (migrations, engine A↔B) | Reconciler wraps its own spec + canonical extraction; use the existing `/generate-from-story` flow with the reconciliation option instead. |

## SimpleReportSpec — the check surface

Every check is opt-in via `spec.checks.<block>`. Declaring nothing = extract-only, no validation.

| Phase | Block | What it asserts |
|---|---|---|
| 1 | `metadata` | Info dict + XMP (title/author/subject/producer/creator/language/customProperties). |
| 1 | `links` | Annotation inventory, mailto syntax, dead-link scan (opt-in HTTP reachability). |
| 1 | `headerFooter` | Identical header/footer across pages, "Page X of Y" match, placeholder leak. |
| 1 | `watermarks` | Presence / absence per page (mode: `all` / `any` / `absent`). |
| 1 | `layout` | Page count / orientation / size (Letter/Legal/A4/A3/Tabloid) / blank pages. |
| 1 | `integrity` | File SHA256, TOC↔section count, attachment inventory. |
| 1 | `textQuality` | Placeholder-leak, encoding artifacts, PII regex scans (SSN / credit card / IBAN). |
| 3 | `structural` | Bookmarks / outlines / OCG layers / page labels / annotation subtypes. |
| 3 | `interactive` | AcroForm widgets (Tx/Btn/Ch/Sig), default values, tab order, JS allow/deny. |
| 3 | `attachments` | Embedded files, name allow-list, mime allow-list, XML well-formed, PDF/A-3 AFRelationship. |
| 3 | `tableDepth` | Merged-row detection, row arity, shape-accuracy score, empty-column detection. |
| 4 | `images` | Per-page image count, min-resolution, colorSpace allow-list. |
| 4 | `contrast` | WCAG 2.1 AA/AAA contrast ratio per text token. |
| 4 | `chartRegions` | Chart-region count / area / no-text-overlap. |
| 4 | `visualRegression` | Per-page pixel diff vs baseline PNG (needs `@napi-rs/canvas` + `pixelmatch` + `pngjs`). |
| 5 | `security` | Encryption / permissions / digital signatures / redaction-annotation leaks. |
| 5 | `barcodes` | 1D/2D barcode decode + payload/format allow-list (needs `@zxing/library`). |
| 6 | `versionDiff` | Text-diff / structural-diff against a baseline PDF (needs `diff` package for text mode). |

## The five expected-values patterns

| Pattern | When to use | Wiring |
|---|---|---|
| **file** | Static regression — expected values live in a JSON test-data file. | Feature reads via `Examples: {"type":"json","source":"..."}`. |
| **db** | Values live in the source-of-truth database (post-generation query). | `cs_qa_db_select` in a Given step; bag stored in `CSBDDContext`. |
| **ui-capture** | UI-driven flow — remember what was typed during data entry. | Data-entry step-defs call `cs_qa_capture_ui_values verb=record`. Validate step calls verb=dump for the bag. |
| **ui-fetch** | Post-generation display screen holds the source-of-truth values. | Snapshot the display screen, extract-text step reads them, feed into `expectedValues`. |
| **report-vs-report** | Migration drift check between two PDFs. | Use spec.checks.versionDiff (Phase 6) OR full `CSReportReconciler` for cell-level reconciliation. |

## Common failure modes and fixes

- **IBAN false-positive on fund security IDs** — fixed in v1.50.1. If a consumer pins < 1.50.1 and sees PII_LEAK on `LX\d+`, tell them to upgrade.
- **`brandName: "Computershare"` fails on legacy WF variant** — variant-specific presence markers should live in a variant-specific spec, not the shared one.
- **`invoiceNumber` extracted="Draft - 243401" but expected="243401"** — the DRAFT prefix is baked into the PDF for draft state. Two fixes: expected value includes the prefix, OR the field spec sets a `stripPrefixRegex` (not shipped yet — hand-strip in the step).
- **PAGE_COUNT_DRIFT under versionDiff** — legitimate finding when engines produce different pagination. Split into two specs: `<name>` (runTextDiff:true, runStructuralDiff:false) for green path + `<name>-strict` (both on) for detection.
- **Inline data-table type error** — fixed in v1.50.1. Consumer step-defs must not type table params as `Array<Record>` — use `unknown` and coerce via `.hashes()`.

## Cost-conscious authoring flow (Copilot billing per token)

1. Read the sample PDF once via `cs_qa_report_spec_init` → starter spec with auto `checks:` block.
2. Ask the user in chat prose (NOT via elicitation) which stricter blocks to enable. Give the phase table above; wait for a chat reply.
3. Apply each with `cs_qa_report_spec_edit verb=add-check-block`. Deterministic — no re-serialising the JSON via the model.
4. `cs_qa_report_validate` → tight envelope. If failures, read the resource ref for details.
5. HTML report drops at `reports/report-validation/<spec>-<epoch>.html` — hand the user the path, don't paste the content back.

Full end-to-end (login → nav → data-entry → PDF → validate) lives in the `report-e2e-authoring` skill.
