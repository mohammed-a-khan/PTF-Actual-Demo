---
applyTo: "config/report-specs/**/*.json"
description: Path-scoped rules for SimpleReportSpec JSON files.
---

# SimpleReportSpec authoring rules

These rules apply to any JSON file under `config/report-specs/**/`. They enforce conventions the framework's loader and validator expect.

## Required fields

- **`name`** — kebab-case, unique across the project. Should match the filename (without `.json`). The recursive loader picks by name; a collision produces a "spec not found" error at validate time.
- **`fields`** OR **`tables`** OR **`checks`** — at least one must be non-empty. A spec with none of these three does nothing.

## Optional but recommended

- **`description`** — one-sentence purpose. Shows in the HTML report header.

## Fields

Each entry in `fields:` is either:
- A **label-anchored extractor**: `{ label: "Invoice Number", readFrom: "right" | "below" | "belowLine" | "inline" | "leftOf", kind: "string" | "number" | "date" | "currency", ... }`.
- A **presence marker**: `{ presenceOfText: "Total Amount Due:", meansValue?: "billed", elseValue?: "draft" }` — auto-asserts "present" when no expected value supplied.
- **Never both.** Presence markers ignore `label`/`readFrom`.

Formatting rules attach as `formatting: { bold?, italic?, fontSize?, casing?, currencyPrefix?, parenNegative?, alignment? }`.

## Tables

Positional cell grids. Columns declare `{ key, header }` — `key` is the spec-side name (identifier), `header` is the string as it appears in the PDF.

`keyColumns: [...]` enables key-based row diffing (row order in PDF doesn't matter). Omit for positional (row-order-sensitive) comparison.

## Check blocks (`checks:`)

Every block is opt-in. Declaring it turns on the validator for that phase. Absent blocks skip entirely.

**Phase 1 blocks** (cheap, no optional deps): `metadata`, `links`, `headerFooter`, `watermarks`, `layout`, `integrity`, `textQuality`.

**Phase 3 blocks**: `structural`, `interactive`, `attachments`, `tableDepth`.

**Phase 4 blocks**: `images`, `contrast`, `chartRegions`, `visualRegression` (needs `@napi-rs/canvas` + `pixelmatch` + `pngjs`).

**Phase 5 blocks**: `security`, `barcodes` (needs `@zxing/library`).

**Phase 6 blocks**: `versionDiff` (needs `diff` package for text-diff mode).

## Rules

- **Never fabricate expected values.** Read from the PDF (via the generator), from the DB, or from the source-of-truth data file. Making up values is the #1 cause of red-on-first-run scenarios.
- **No variant-specific presence markers in the shared spec.** If the Wells Fargo variant PDF doesn't contain "Computershare" but the standard variant does, the "Computershare" presence marker lives in `invoice-standard.json`, NOT in a shared file two variants use.
- **`presenceOfText` matches substrings.** `"Draft"` will match "DRAFT INVOICE - DO NOT PAY". Choose distinctive substrings.
- **`checks.textQuality.piiPatterns` is regex.** Default patterns catch SSN / 13-19 digit credit-card / IBAN (`[A-Z]{2}\d{2}[A-Z0-9]{11,30}`, tightened in v1.50.1 to avoid ISIN false-positives). Add project-specific patterns via `piiPatterns: [...]`.
- **`checks.versionDiff.baselinePdfPath` is workspace-relative.** Ensure the baseline PDF is committed under `test/**/tmp/pdfs/` or `samples/reports/`.
- **`checks.visualRegression.baselineDir`** stores PNGs one per page. First run records the baseline; subsequent runs diff. Never commit the entire baseline dir if it's regenerated per run — commit only the golden pages the spec asserts.
- **Never commit `.cct-qa/` outputs.** That directory holds run-scoped state (briefs, resources, ui-capture buffers, downloads). Add to `.gitignore`.

## Reserved shape

Do NOT add top-level keys other than `name`, `description`, `fields`, `tables`, `checks`. The loader rejects unknowns to prevent silent typos (`chekcs:` → nothing runs).
