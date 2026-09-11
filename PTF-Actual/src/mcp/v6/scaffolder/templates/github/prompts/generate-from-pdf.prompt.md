---
name: generate-from-pdf
description: Author a SimpleReportSpec regression test from a sample PDF already on disk. Cheap flow — no UI walk-through. For the full login-to-PDF path use /generate-from-pdf-e2e.
agent: agent
argument-hint: <pdfPath> [--out=<specPath>] [--name=<slug>] [--enable=metadata,security,...]
tools:
  - cs-qa-v6/cs_qa_report_spec_init
  - cs-qa-v6/cs_qa_report_spec_edit
  - cs-qa-v6/cs_qa_report_validate
  - cs-qa-v6/cs_qa_fs
  - cs-qa-v6/cs_qa_rag
---

# Generate SimpleReportSpec from a sample PDF

Input: `${input:1}` = pdfPath (required). Optional args parsed from the rest of the invocation string.

Estimated token budget: **8-12k**.

## Composition

1. **Init the spec.**
   ```
   cs_qa_report_spec_init({
     verb: 'init',
     pdfPath: <arg1>,
     outPath: <--out or config/report-specs/<autoname>.json>,
     specName: <--name or derived from pdf basename>,
     force: false
   })
   ```
   Returns `{fieldsEmitted, tablesEmitted, checksEnabled, notes}`. Report those counts to the user in prose. The spec is now on disk at `outPath`.

2. **Read the spec** via `cs_qa_fs verb=read` and quote back the FIELD KEYS (not the whole file) so the user can see what got auto-detected. Do NOT dump 300 lines of JSON to chat.

3. **Ask the user (in chat prose) which stricter check blocks to enable.**
   Do NOT use `cs_qa_ask_user`. Message the user directly:
   > "The generator turned on: {checksEnabled}. Available stricter blocks:
   >  - **metadata** (title/author/producer/language)
   >  - **links** (URIs, mailto, dead-link scan)
   >  - **watermarks** (presence/absence)
   >  - **structural** (bookmarks/layers/annotation subtypes)
   >  - **security** (encryption/signatures/redaction leaks)
   >  - **images** (count/resolution/colorSpace)
   >  - **contrast** (WCAG 2.1)
   >  - **versionDiff** (compare against a baseline PDF)
   >  Reply with a comma-separated list or 'none'."
   
   Then STOP and wait for the user's next chat turn. Do NOT proceed to step 4 in the same turn.

4. **Apply each opt-in** via `cs_qa_report_spec_edit verb=add-check-block block=<name>`. One call per block. The primitive uses safe defaults; the user can tighten knobs after by rerunning with explicit `rule`.

5. **Run the validator** to confirm the enriched spec still passes on the sample PDF (green-out-of-the-box invariant):
   ```
   cs_qa_report_validate({ verb: 'validate', pdfPath: <arg1>, specName: <the spec>, expectedValues: {} })
   ```
   With no `expectedValues`, extract fields are informational (not asserted). Only check blocks assert. If any check-block fires findings, offer options in chat prose (loosen the rule, remove the block, or accept — user's call).

6. **Report** to the user:
   - Spec path + field/table counts + enabled check blocks.
   - HTML report path (from step 5).
   - A one-line next-step suggestion (e.g. "Author a BDD scenario using `Then the PDF at ... matches spec \"<name>\"` — see the report-validation SKILL for the five expected-values patterns.")

## Hard rules

- Never call `cs_qa_ask_user` — it's unreliable in Copilot Chat, values don't round-trip.
- Never paste full JSON specs or 300-finding tables back into chat. Cite file paths.
- Never invent fields / tables that the generator didn't emit. The generator is the source of truth for what the PDF contains.
- If the user asks about report-vs-report comparison at any step, escalate to `/generate-from-pdf-e2e` (which handles the two PDF paths).
