---
name: generate-reconciliation-tests
description: Bootstrap reconciliation rules JSON + feature file for a migration (Crystal↔SSRS) or PDF↔DB use case. Consumer supplies two PDFs (or PDF + DB helper); framework auto-generates a starter rules JSON with detected aliases and an `_unmatched` block for consumer review.
agent: agent
argument-hint: <candidate-pdf> <reference-pdf-or-db-helper-module> [--pattern=pdf|db] [--out=<rules-path>] [--feature=<feature-path>]
tools:
  - cs-qa-v6/cs_qa_fs
  - cs-qa-v6/cs_qa_report_recon_init
  - cs-qa-v6/cs_qa_report_reconcile
---

# Generate Reconciliation Tests (v1.53)

Estimated token cost: **~6-15k** — one recon_init call + a review of counts +
BDD authoring.

## Composition

### Path A — PDF-vs-PDF (Crystal ↔ SSRS)

1. **Bootstrap rules** via `cs_qa_report_recon_init({verb:'init', candidatePdfPath, referencePdfPath, outPath, force:true})`.
2. **Report counts to the user in chat prose** (do NOT dump the whole JSON):
   > "Auto-detected {N} sections on candidate, {M} on reference, matched {K} automatically. {S} sections in reference need alias/decision ({sectionsInReferenceOnly}). {C} columns need alias/decision. See {outPath} → review the `_unmatched` block, add aliases where appropriate, delete `_unmatched`, then rerun the scenario."
3. **Write the feature file** via `cs_qa_fs verb=write`:
   ```gherkin
   @migration @reconciliation
   Feature: <derived title>
     Scenario: <candidate-basename> reconciles against <reference-basename>
       Then the PDF at "<candidate>" matches the reference PDF at "<reference>" using rules from "<outPath>"
   ```
4. **STOP** — tell the consumer to review + edit the rules JSON, then invoke the scenario themselves. Do NOT call `cs_qa_report_reconcile` yet — that's for after the consumer has curated `_unmatched`.

### Path B — PDF-vs-DB (report ↔ SoR database)

1. **Ask the consumer in chat prose** for:
   - The candidate PDF path
   - The DB helper module path (relative to workspace root, must exist)
   - The class name on the helper module
   - Section-to-method mapping (which helper method returns rows for which section) with params
2. **Author the rules JSON via `cs_qa_fs verb=write`** with the `referenceDataSource` block. Leave `sections[X].columns` mostly empty — consumer fills after seeing first-run findings.
3. **Sanity-check the helper module exists** via `cs_qa_fs verb=exists`. If it doesn't, tell the consumer to author it first (see the `pdf-reconciliation` SKILL for helper-module patterns).
4. **Write the feature file**:
   ```gherkin
   Then the PDF at "<candidate>" matches the reference DB rows using rules from "<rules>"
   ```
5. **STOP** — same as Path A.

## Hard rules

- **Never call `cs_qa_ask_user`.** Use chat prose.
- **Never invent expected DB values or column mappings** without consumer input — you don't know the DB schema.
- **Never call `cs_qa_report_reconcile` on the auto-generated rules JSON** — the `_unmatched` block MUST be resolved by the consumer first. Automated invocation would either produce misleading passes (nothing to reconcile because everything is unmatched) or misleading failures (heaps of `SECTION_MISSING`/`COLUMN_MISSING`).
- **Never talk to the DB directly.** DB access lives in the consumer's helper module. Framework calls the helper; helper does the SQL/stored-proc.

## When this prompt is the WRONG tool

- Consumer wants "just assert some values in ONE PDF" → use `/generate-pdf-tests` (test-data-first).
- Consumer wants UI-driven flow (login → generate → download → validate) → use `/generate-from-pdf-e2e`.
- Consumer wants text-diff between two PDFs (no cell-level reconciliation) → they can use test-data-first with `_checks.versionDiff`.
