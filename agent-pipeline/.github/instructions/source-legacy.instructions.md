---
applyTo: "legacy-source/**/*"
---

# Instructions for reading legacy source

These rules layer on top of the project-wide Copilot instructions and
apply whenever Copilot is reading files under the legacy source folder
(by default `legacy-source/`; change the `applyTo` pattern above to
match your project's actual folder name).

## Read-only discipline

- Legacy source files are READ-ONLY. Never edit, refactor, rename, or
  reformat a legacy file. You are here to understand the intent, not
  to modernise the original.
- Never write new files inside the legacy source tree.
- Never delete files from the legacy source tree.
- If a legacy file has a typo in an identifier name, the typo is
  preserved when you reference that identifier. Clean names appear
  only in the generated target code.

## Reading order

When asked to analyse a legacy folder or file:

1. First call `legacy_ast_parse` on the file. This gives you a
   deterministic structural view: every class, method, field,
   annotation, and import.
2. Then call `read_file` to get the full source for content-level
   inspection, especially for in-method logic, string literals, and
   inline comments that may reveal test intent.
3. For legacy test classes that reference a page object class, read
   the page object file next. For page objects that extend a base
   class, read the base class too. Walk the inheritance chain until
   you've seen all field declarations that matter.
4. For legacy test classes that reference a data source (an Excel
   file, a CSV, a JSON, or a database query), locate the file or
   query and read it. A canonical spec with missing data is
   incomplete.

## What counts as a legacy test

- A method annotated with the legacy test framework's test-method
  annotation AND a metadata annotation carrying a test case ID.
- The test case ID is ground truth for the test identifier. The
  method name is advisory only — it may or may not match the ID.
- Comments that look like test case IDs (for example a number
  embedded in a comment near the top of a method body) are NOT
  test cases. They are section markers inside a larger method.

## Enumeration is mandatory

- Before migrating anything from a legacy test class, enumerate all
  test methods in the file. Not some of them — all of them. If the
  class has twelve test methods, your canonical spec lists twelve
  entries.
- If a test method delegates most of its body to a support method in
  a shared utility class, read the support method too. The support
  method's logic is part of the test's logic.

## Data source discipline

- When a legacy test uses an Excel data provider, every column and
  every row in the Excel sheet (for the keyed data set) must appear
  in the generated JSON data file. Count columns first, then rows.
  No silent truncation.
- Column headers from Excel are converted to camelCase keys in JSON.
  Empty cells become empty strings, not missing keys.
- If a legacy test uses a database query as its data source, the
  query text is extracted verbatim and placed in a named query
  entry in the target config's db queries env file. The query
  itself is never inlined into the generated test code.

## When unsure

- Prefer re-reading to guessing. Reads are cheap.
- Prefer escalation over invention. If the legacy source is
  incomplete or contradictory, the analyzer should return a canonical
  spec with a `gaps` field listing what is missing — never fabricate.
