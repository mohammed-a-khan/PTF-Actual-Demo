# Report Validation — Engine Switch and Extensions

| | |
|---|---|
| **Status** | Draft for review (supersedes the earlier "separate `pdf-verify` module" draft) |
| **Owner** | mohammed-a-khan |
| **Builds on** | `DESIGN.md` (CS PDF Engine: our own PDF → JSON converter) |
| **Scope** | The existing `src/report-validation` module |

---

## 1. Decision: no second validation stack

The framework already has a working PDF validation module, `src/report-validation`. It is about 16 k lines covering text extraction, layout analysis, label/value fields, tables, PDF-vs-PDF, PDF-vs-DB, a spec pipeline, 18 checks and reporters. An earlier draft of this document proposed a new `src/pdf-verify` module next to it. That would have **duplicated** most of the existing functionality, so it has been dropped.

The plan has three parts:

1. **Swap the converter.** Our own engine (`src/pdf`, see `DESIGN.md`) replaces `pdfjs-dist` everywhere in the module. The swap goes through **one** provider, so nothing above it has to know.
2. **Existing code must not break.** Every step, MCP tool, export, spec and rules file keeps working unchanged. Existing behaviour is captured as golden output **before** the swap and checked after it.
3. **New features are built inside the existing components.** Each feature extends the component that already owns that job. No component is duplicated.

The only new module is the engine itself (`src/pdf`). It has no knowledge of reports.

---

## 2. What already exists, and what owns each job

| Job | Existing owner | Status |
|---|---|---|
| PDF → text items | `CSReportPdfExtractor` (pdfjs-dist) | **Swapped to our engine** (§3) |
| Layout: lines, columns, headers, cells, sections, totals, TOC, charts | `CSReportPdfLayoutAnalyzer` + `layout/*` | Kept. Retuned only where `dual` diffs show a need (§4). Gains engine data: rulings, real font names, colour. |
| Label → value fields (below, right, inline, leftOf) | `CSReportSimpleFieldExtractor` | Kept; extended (§5.1) |
| Simple tables | `CSReportSimpleTableExtractor` | Kept; extended (§5.1) |
| Presence ("text appears") | `CSReportSimplePresenceDetector` | Kept |
| Formatting (bold, italic, size, alignment, casing, currency, parentheses) | `CSReportSimpleFormattingValidator` | Kept. **Starts working fully**, because the engine supplies real font names, bold/italic and colour (§5.4). |
| Spec-driven validation | `CSReportSimpleValidator` + `CSReportSimpleSpec` | Kept |
| Data-first validation (expected JSON keyed by PDF labels, spec optional) | `CSReportSimpleValidatorFromData` | Kept; **this is the "no spec needed" path**. Its planned-but-no-op `_tables` and `_formatting` keys get finished (§5.1). |
| Spec generation (infer a spec from a PDF) | `CSReportSimpleSpecGenerator` (+ CLI, MCP tool) | Kept; switched to the engine |
| PDF vs PDF | `CSPdfPairReconciler` + `CSPdfReconcileReporter` | Kept; open defects fixed (§5.3) |
| PDF vs DB (consumer helper; result-set index already supported) | `CSPdfDbReconciler` | Kept; adds a **built-in query/procedure source** (§5.2) |
| Full spec pipeline (ingest PDF/Excel/CSV/DB → canonical → reconcile; checksum, coverage, footing) | `CSReportValidationService`, `CSReportSpec`, mapper, reconciler, validators | Kept; switched to the engine |
| Value normalisation | `CSReportNormalizer` | Kept; extended (§5.5) |
| 18 checks (metadata, links, security, structure …) | `checks/*` | Kept. **Their 12 separate pdfjs loaders are replaced by the one provider** (§3.2). |
| Steps / MCP tools | `steps/report-validation/*`, `mcp/v6/tools/report_*` | Unchanged wording and names. New capabilities appear as options, plus a few new steps. |

---

## 3. The converter swap (one seam)

### 3.1 Where pdfjs is used today
`pdfjs-dist` is loaded in **14 files**:
- `CSReportPdfExtractor`
- `CSReportSimpleSpecGenerator`
- 12 checks: attachment, barcode, image inventory, integrity, interactive, layout, link, metadata, security, structural, version diff, visual regression

Each of those files has its **own** `new Function('return import("pdfjs-dist/…")')`. That is already duplicated code.

Across them, the pdfjs API surface used is small:
- `getDocument`, `numPages`, `getPage`, `destroy`, `cleanup`
- page level: `view`, `getViewport`, `getTextContent`, `getAnnotations`, `getOperatorList`, `render`
- document level: `getMetadata`, `getAttachments`, `getPermissions`, `getOutline`, `getPageLabels`, `getOptionalContentConfig`, `getJSActions`

### 3.2 One provider
`src/report-validation/CSPdfDocumentProvider.ts` becomes the only place in the module that opens a PDF.

```ts
export async function openPdfDocument(data: Uint8Array, opts?): Promise<PdfJsDocument>  // same interface the module already uses
```

- **Engine selection.** `REPORT_PDF_ENGINE=native|pdfjs|dual` decides which engine opens the PDF.
  - `native` uses our engine through a **pdfjs-compatible adapter**: the existing `PdfJsLoader` / `PdfJsDocument` / `PdfJsPage` interfaces in `CSReportPdfExtractor.ts:32-86`, plus the document-level methods listed in §3.1.
  - `pdfjs` is today's behaviour. It stays available as a rollback during the transition.
  - `dual` runs both engines, returns pdfjs results, and writes a diff (§4).
- **Call sites.** All 14 files change from a private dynamic import to `openPdfDocument(…)`. That is a one-line change per file, and no logic above it changes.
- **Rendering.** Barcode, visual regression and OCR need page pixels. `render()` goes through Playwright Chromium, which the framework already depends on, instead of pdfjs canvas.
  - `CSPdfImageInventoryValidator` no longer needs to render. The engine lists image XObjects directly.
- **Result.** After the switch, `pdfjs-dist` is no longer needed. It was never declared in `package.json`, so there's no dependency entry to remove.

### 3.3 Shape guarantees for existing code
- `TextItem` / `PageContent` (`CSReportPdfTypes.ts`) keep every field, with the same meaning and units: PDF user space, y up.
- `fontName` stays an **opaque id**, exactly as pdfjs returns it today (e.g. `g_d0_f1`), so existing behaviour is unchanged.
  - Real font information arrives in **new optional fields**: `baseFont`, `bold`, `italic`.
  - Code that wants that information reads the new fields; the existing regexes on `fontName` are left alone.
- `color`, which is always `undefined` today, gets filled in. `rotation` and `hasEOL` keep their semantics.

---

## 4. "Existing code must not break": how it is enforced

1. **Golden capture first.** Before the swap, every existing mode is run on PDFs with pdfjs, and its full output is saved under `test/report-validation/golden/`. The modes are: simple spec, data-first, spec generator, PDF-vs-PDF auto and with rules, PDF-vs-DB, the spec pipeline, and all 18 checks. The PDFs used are your real reports, the SSRS/Crystal part of the 985-file corpus, and synthetic fixtures.
2. **Dual mode.** `REPORT_PDF_ENGINE=dual` runs both engines on the same PDF and writes a diff to `<run>/report-validation/engine-diff.json`. The diff compares three levels:
   - the text items;
   - the `analyzeReport` output: sections, columns and rows;
   - the final findings.
3. **The gate.** `native` becomes the default only when the native engine reproduces every golden output. The only allowed differences are entries on an **approved list**: each one is a documented improvement, such as a correct result where pdfjs or the old code was wrong. That list goes into the changelog.
4. **Layout analyzer thresholds.** The analyzer was tuned on pdfjs geometry; its own comments say a shift in item x or width can drop table rows. Where the dual diff shows such a shift, the fix goes into the **engine's compatibility output** first, so its text items match what the analyzer expects. The analyzer itself is retuned only as a last resort, and then with golden tests covering the change.
5. **Rollback.** `REPORT_PDF_ENGINE=pdfjs` stays available until a major version, as a one-line rollback.

---

## 5. New features, each inside its existing owner

### 5.1 Validation without a spec, using user-supplied expected data
**Owner:** `CSReportSimpleValidatorFromData`. It is already the "data in, no spec" entry point; data keys are PDF labels.

- **Generic keys.** Keys don't have to match the label text exactly any more. `invoiceTotal`, `INVOICE_TOTAL` and "Invoice Total" all resolve. The matching works in this order:
  1. split the key into words;
  2. match against labels exactly;
  3. match by word set;
  4. match fuzzily, using a synonym list (`qty`/`quantity`, `amt`/`amount`, `no`/`number`/`#`).

  The existing extraction cascade (`extractField`) then reads the value.
- **Finish `_tables`** (documented today as planned, no-op). Expected rows are matched to a PDF table found by `CSReportSimpleTableExtractor` / the layout analyzer:
  - columns are mapped by header name plus **value overlap**;
  - the key column is picked by uniqueness;
  - modes are keyed, ordered, subset or exact.
- **Finish `_formatting`** (planned, no-op today). It routes to the existing formatting validator.
- **No guessing.** When a key matches more than one candidate, the finding is `AMBIGUOUS` and lists the candidates. The result always includes the **mapping used**.
- **Optional hints.** The existing object-shape value (`{ expected, readFrom }`) is extended with `label`, `table` and `column`. Hints are needed only for ambiguous items, and no spec file is required.

### 5.2 Expected data from a DB query or stored procedure
**Owner:** `CSPdfDbReconciler`. It already reconciles a PDF against DB rows and already supports multiple result sets (`resultSetIndex`), but only through a consumer-written helper class.

- **New built-in source.** A new `referenceDataSource.kind` sits next to the existing `consumer-helper`, which stays as it is:
  ```jsonc
  { "kind": "query",     "connection": "ORDERS_DB", "query": "DB_QUERY_INVOICE_LINES", "params": { "InvoiceId": 42 } }
  { "kind": "procedure", "connection": "ORDERS_DB", "procedure": "usp_GetInvoice",     "params": { "InvoiceId": 42 } }
  ```
- **Data-first path too.** The same source is accepted by the data-first validator (§5.1), so a DB result can fill `fields` and `_tables` there as well.
- **How results map:**

  | Result | Becomes |
  |---|---|
  | Scalar value, output parameters, return value | Fields |
  | Single row | Fields, one per column |
  | Multiple rows | A table |
  | Multiple result sets (procedures, multi-statement batches) | Each result set is matched to the PDF section or table it overlaps best with. `resultSetIndex` keeps working as an explicit hint. |

  An ordinary single-`SELECT` query returns one result set, so this is just the common case of the same rule.
- **Database-agnostic.** The connection is an alias. Type, host and authentication (including Windows auth) come from `DB_<ALIAS>_*` config through `CSDBUtils` / `CSDatabaseManager`. The reconciler contains no database-specific code.
- **Gaps in the shared DB layer.** These are fixed once, in the DB layer itself, not worked around in report-validation:
  1. `CSDBUtils.executeStoredProcedure` runs `EXEC proc ?,?` as a plain query instead of using the adapter's procedure path (`utils/CSDBUtils.ts:843-889`).
  2. The SQL Server query path returns only the first result set (`adapters/SQLServerAdapter.ts:407-417`).
  3. `ResultSetParser` drops output parameters and the return value (`client/ResultSetParser.ts:22-60`).
  4. Named and `OUTPUT` parameters aren't passed by name on SQL Server; Oracle, PostgreSQL and MySQL need the same.
  5. Pooled connections are never released.

  Execution always binds parameters, runs read-only (rolled back) and releases the connection.

### 5.3 PDF vs PDF
**Owner:** `CSPdfPairReconciler`. It already has auto mode and rules mode, section matching, row keying and cell comparison.

- **Fix the defects found in review:**
  - `compareSections` reports deliberately skipped sections as `SECTION_MISSING_CANDIDATE` (`:1104`);
  - an empty section on one side passes silently;
  - `ignoreColumns` is ignored in the column-coverage loop;
  - in rule generation, the column index is taken from the list after empty headers are filtered out, but used on the unfiltered row cells;
  - non-Latin text collapses to empty in `normalizeForMatch`;
  - fuzzy key pairing at 0.85 can join different IDs;
  - rows are lost when sub-tables merge;
  - heading-row removal can drop real rows;
  - dead code from commits 11 and 12.
- **Add a dynamic-content ignore set**, on by default: run dates, `Page X of Y`, GUIDs. It is extended through the existing `knownDifferences`.
- **Add optional `text` and `structure` comparison modes.** These reuse the checks' version-diff and structural validators rather than new code.
- **Visual comparison stays in** `CSPdfVisualRegressionValidator`, now rendered through Chromium.

### 5.4 Formatting and layout get the engine's richer data
The engine supplies real font names, bold/italic, colour and drawn **rulings** (table lines). With that:
- `CSReportSimpleFormattingValidator` gains reliable bold, italic and colour checks. Its `fontName` regexes probably never match with pdfjs today.
- `CSPdfContrastValidator` gets real text colour.
- The layout analyzer can **optionally** use rulings as column and row anchors. This is opt-in, behind golden tests, and off by default until proven.

### 5.5 Normalisation
**Owner:** `CSReportNormalizer`. It is extended, not replaced:
- locale-aware numbers and currency (`1.234,50`, `1 234,50`, Indian grouping);
- parenthesised and trailing-minus negatives;
- decimal-safe equality;
- rounding to the decimal places shown in the PDF;
- blank equivalents (`—`, `N/A`, `NULL`);
- boolean vocabularies;
- explicit date formats.

---

## 6. Steps and MCP tools

- **Existing steps** keep their exact wording and behaviour, and so do the `report_*` MCP tools.
- **New behaviour** comes as **options on existing steps and tools** wherever possible. For example, the data-first step accepts a `{ kind: "procedure", … }` source.
- **Genuinely new phrasing** is added only where nothing exists today:

```gherkin
Then the PDF at "{scenario:pdfPath}" matches stored procedure "usp_GetInvoice" on "ORDERS_DB" with params:
  | InvoiceId | 42 |
Then the PDF at "{scenario:pdfPath}" matches query "DB_QUERY_INVOICE_LINES" on "ORDERS_DB" with params:
  | InvoiceId | {scenario:invoiceId} |
```

These are thin wrappers over `CSPdfDbReconciler` with the built-in source (§5.2). They aren't a new pipeline.

---

## 7. Milestones (after engine milestones M0–M3 in `DESIGN.md`)

| Milestone | Scope | Exit criteria | Est. |
|---|---|---|---|
| **R1 Golden capture** | Capture today's outputs for every mode and check on real, corpus and synthetic PDFs | Golden suite runs green on `pdfjs` | 1 wk |
| **R2 Provider + swap** | `CSPdfDocumentProvider`; pdfjs-compatible adapter on the engine (text and document APIs); 14 call sites switched; Chromium rendering for barcode, visual regression and OCR; `dual` diff | Golden suite green on `native`; diffs only on the approved list; native is the default | 2.5 wk |
| **R3 DB layer** | The 5 shared DB-layer fixes; built-in `query` / `procedure` source in `CSPdfDbReconciler` and data-first | Multi-result-set and OUTPUT-param procedures verified on SQL Server, Oracle, PostgreSQL and MySQL test schemas | 2 wk |
| **R4 Extensions** | §5.1 generic keys, `_tables`, `_formatting`, ambiguity, mapping output; §5.3 reconciler fixes and ignore set; §5.4 formatting and colour; §5.5 normaliser | Golden suite still green, apart from approved fixes; new feature tests pass | 3 wk |
| **R5 Cleanup** | Remove the pdfjs code path (major version); docs | No `pdfjs-dist` references; user guide updated | 0.5 wk |
| | | **Total (on top of the engine)** | **≈ 9 weeks** |

This replaces the earlier ~16-week estimate. Most of that time went into rebuilding things that already exist.

---

## 8. Questions for you

1. **Real reports for the golden suite.** Can you share anonymised SSRS and Crystal PDFs, plus the specs or rules files and expected data you use today? They make the "nothing breaks" gate meaningful.
2. ~~**Formatting differences.**~~ **Decided (owner, 2026-11-07):** when the values are equal they pass by default, even if formatted differently (`1250` vs `$1,250.00`). Formatting is checked only when the test asks for it. All other recommendations in this document were also accepted.
