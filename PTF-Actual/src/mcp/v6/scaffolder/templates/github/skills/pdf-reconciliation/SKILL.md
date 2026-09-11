---
name: pdf-reconciliation
description: Cell-level reconciliation between two reports (PDF↔PDF or PDF↔DB) with tolerance, column/section aliases, and known-difference exceptions. Load this when the user needs to prove one report matches another during a migration (Crystal→SSRS, engine A→B) or against a source-of-truth database.
triggers:
  - reconcile
  - reconciliation
  - Crystal
  - SSRS
  - migration report
  - PDF vs DB
  - cell-by-cell
  - column alias
  - tolerance
tokenBudget: 1400
---

# Report Reconciliation — Progressive Playbook

Cell-level comparison across two report sides. For simple "does this PDF have
these values?" use the `pdf-validation-simple` skill instead — this skill is
strictly for two-side reconciliation.

## When to use — three paths

| Question | Path |
|---|---|
| "Do these two PDFs (Crystal ↔ SSRS) reconcile at the cell level, with tolerance and known-differences?" | **PDF-vs-PDF** (this skill § 1) |
| "Does this PDF match the source-of-truth rows in our DB (SELECT or stored proc, single or multi result-set)?" | **PDF-vs-DB** (this skill § 2) |
| "Just check the PDF has some expected values — no reference source." | Skill `pdf-validation-simple`, NOT this one |

## 1 — PDF-vs-PDF

### Composition

1. **Bootstrap the rules JSON** via `cs_qa_report_recon_init({verb:'init', candidatePdfPath, referencePdfPath, outPath})`. Framework extracts sections + columns from both, auto-matches high-confidence pairs (Levenshtein ≥ 0.85), emits a starter JSON with an `_unmatched` block listing what needs consumer input.

2. **Consumer reviews `_unmatched`**. Model surfaces the counts to the consumer in chat:
   > "recon_init detected {N} sections on candidate, {M} on reference, auto-matched {K}. Unmatched: {sectionsInReferenceOnly.length} sections + {columnsInReferenceOnly.length} columns need your input. Nearest fuzzy suggestions are in the `_unmatched` block."

3. **Consumer edits the rules JSON** — moves needed items from `_unmatched` into `sections[X].aliases` (for sections) or `sections[X].columns[Y].aliases` (for columns), then DELETES the `_unmatched` block.

4. **Reconcile** via `cs_qa_report_reconcile({verb:'reconcile', candidatePdfPath, referencePdfPath, rulesPath})`. Returns pass/fail + finding counts + firstFindings sample + resource ref to full findings.

5. **Author a scenario** — one line:
   ```gherkin
   Then the PDF at "candidate.pdf" matches the reference PDF at "reference.pdf" using rules from "rules.json"
   ```

## 2 — PDF-vs-DB

### Composition

1. **Consumer authors the DB helper** (framework never talks to the DB — enforces `feedback_db_calls_in_db_helper_only`). Example patterns:
   ```js
   async getRows(params) {
       return CSDBUtils.executeQuery('SELECT ...', params);
   }
   async getMultiResultSetRows(params) {
       const result = await CSDBUtils.executeStoredProcedure('usp_...', params);
       return { resultSets: result.recordsets };
   }
   ```

2. **Author the rules JSON** with a `referenceDataSource` block:
   ```jsonc
   {
     "referenceDataSource": {
       "kind": "consumer-helper",
       "module": "test/pegas/helpers/PegasReconciliationDbHelper.js",
       "className": "PegasReconciliationDbHelper",
       "sections": {
         "Invoice Header": { "method": "getInvoiceHeaderAndLines", "params": {...}, "resultSetIndex": 0 },
         "Invoice Lines":  { "method": "getInvoiceHeaderAndLines", "params": {...}, "resultSetIndex": 1 }
       }
     },
     "sections": { /* same shape as PDF-vs-PDF */ }
   }
   ```

3. **Reconcile** via `cs_qa_report_reconcile_pdf_db({verb:'reconcile', candidatePdfPath, rulesPath})`.

4. **Author a scenario**:
   ```gherkin
   Then the PDF at "invoice.pdf" matches the reference DB rows using rules from "rules.json"
   ```

### Multi-result-set stored procedures

The helper's return shape is `{resultSets: Row[][]}` when the underlying DB
driver's stored-proc call returns multiple result sets (mssql's `recordsets`,
oracledb's `rows` per statement, etc.). Rules JSON's `resultSetIndex` maps
each result set to one section.

## Rules JSON key fields

Only what needs an override needs declaration. Everything else auto-detected:

- `sections[X]` — canonical section name (typically the reference-side title)
  - `.aliases` — extra names to match against on either side (fuzzy still applies to non-declared)
  - `.keyColumns` — row-identity columns (auto-detected: first non-numeric high-cardinality column)
  - `.columns` — per-column rules
    - `.aliases`, `.tolerance`, `.kind`
- `globalTolerance` — kind-scoped defaults: `{currency, percentage, count, number}`
- `knownDifferences` — allowlist for intentional diffs; matches become `KNOWN_DIFFERENCE_MATCHED` (recorded, not failing)
- `ignoreSections`, `ignoreColumns` — skip entirely
- `aliasFuzzyThreshold` — Levenshtein similarity for auto-alias matching. Default 0.85 (strict). Lower = more auto-suggestions (also more false positives).

## Finding kinds

| Kind | When | Action |
|---|---|---|
| `CELL_MISMATCH` | Both sides have the cell, values differ beyond tolerance | Tighten tolerance, add knownDifference, or fix the drift |
| `CELL_MISSING_CANDIDATE` / `_REFERENCE` | One side missing the cell for a matched row | Investigate why one source dropped the value |
| `ROW_MISSING_CANDIDATE` / `_REFERENCE` | Row (by keyColumns) present on one side only | Coverage gap |
| `SECTION_MISSING_CANDIDATE` / `_REFERENCE` | Section declared in rules but not found on one side | Add alias to `sections[X].aliases` OR move to `ignoreSections` |
| `COLUMN_MISSING_CANDIDATE` / `_REFERENCE` | Column declared but not found | Add alias to `sections[X].columns[Y].aliases` OR move to `ignoreColumns` |
| `KNOWN_DIFFERENCE_MATCHED` | Finding matched an entry in `knownDifferences` | Verify the reason still applies each release |

## Cost-conscious composition

- **Never call `cs_qa_ask_user`.** MCP elicitation is unreliable — ask in chat prose.
- **`recon_init` outputs contain rich detail**: emit the counts + `_unmatched` summary to the user in chat, DON'T dump the full JSON. Consumer opens the file in their editor.
- **`reconcile` primitives return tight envelopes** — `firstFindings` capped at 20. Model reads `resourceRef` only if the consumer asks for detail beyond the first 20.
- **Fuzzy matching is O(candCols × refCols × candSections × refSections)**. For very wide reports (hundreds of columns), consider tuning `aliasFuzzyThreshold` higher to bound the search space.

## Composition with test-data-first

The two flows are complementary, not competing:

- **Same-PDF value assertions** (invoice number = X, total = Y) → `pdf-validation-simple` (test-data-first)
- **PDF-vs-PDF reconciliation** with tolerance + aliases → this skill
- **PDF-vs-DB reconciliation** → this skill

A consumer project can have both — a feature file that uses `Then the PDF at X matches expected values from Y.json` for regression on individual PDFs, AND `Then the PDF at X matches the reference PDF at Y using rules from Z.json` for migration reconciliation.
