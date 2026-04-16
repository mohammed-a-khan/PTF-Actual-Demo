---
name: data-file-patterns
description: >
  Canonical patterns for JSON and CSV data files consumed by
  Scenario Outline Examples in the target test framework. Covers
  file placement, naming, scenario metadata fields (scenarioId,
  scenarioName, runFlag), config reference syntax ({config:VAR}),
  camelCase key convention, multi-dataset nested structures,
  row/column audit rules, Excel-to-JSON conversion, and
  forbidden patterns. Load when generating, auditing, or healing
  any data file.
---

# Data File Patterns

## When this skill applies

Any generated or modified data file under `test/<project>/data/`
that feeds an `Examples:` block in a feature file. Usually JSON
(most common) or CSV. Legacy Excel data is converted to JSON
during migration.

## File placement and naming

- Directory: `test/<project>/data/`
- Filename: kebab-case or snake_case, ending in `.json` or `.csv`
- Convention suffixes that carry semantic meaning:
  - `-scenarios.json` — scenario rows with metadata fields
    (scenarioId, scenarioName, runFlag)
  - `-data.json` — plain reference data without scenario
    metadata (used by helpers, not by Examples directly)
  - `-config.json` — static configuration lookups
- Prefer one file per feature or per module, not one monolithic
  data file for the whole project

## JSON array shape (most common)

The standard shape: an array of row objects. Each row is one
scenario iteration when referenced via `Examples:` with
`path: "$"`.

```
[
    {
        "scenarioId": "<id>",
        "scenarioName": "<human-readable name>",
        "runFlag": "Yes",
        "userName": "{config:APP_USERNAME}",
        "password": "{config:APP_PASSWORD}",
        "orderNumber": "ORD-12345",
        "expectedStatus": "Confirmed"
    },
    {
        "scenarioId": "<id>",
        "scenarioName": "<another name>",
        "runFlag": "No",
        "userName": "{config:APP_USERNAME}",
        "password": "{config:APP_PASSWORD}",
        "orderNumber": "ORD-67890",
        "expectedStatus": "Cancelled"
    }
]
```

## Mandatory metadata fields

Every scenario row must include these three fields:

- `scenarioId` — unique identifier for the scenario iteration.
  When migrating from legacy, preserve the legacy test case id
  exactly. For new scenarios, use a sequential id scoped to the
  feature (e.g., `TC01-01`, `TC01-02`).
- `scenarioName` — short human-readable description of what this
  iteration tests. Used in the run log and HTML report.
- `runFlag` — `"Yes"` to include this iteration in the run,
  `"No"` to skip. Default to `"Yes"`. The `Examples:` filter
  typically reads this field.

These three are mandatory. A row without them is a rejected
pattern and the audit will fail.

## Scenario body fields (camelCase)

Fields that map to `<parameters>` in the feature file use
camelCase keys:

- `userName` (not `user_name`, `UserName`, or `username`)
- `orderNumber`, `productCode`, `customerEmail`
- `expectedOrderId`, `expectedStatus`
- `inputFilePath`, `outputFilePath`

Camel case matches the `<paramName>` syntax in the feature file
exactly. If a feature uses `<userName>`, the data file key is
`userName` — same case, same spelling.

When migrating from legacy data sources with different casing
(spaces, snake_case, or TitleCase), convert to camelCase:

- `User Name` → `userName`
- `order_id` → `orderId`
- `CustomerEmail` → `customerEmail`

Preserve the legacy names in a separate mapping file if the
migration audit needs a source-of-truth cross-reference.

## Config and environment references

Values that should be resolved from config at runtime use
placeholder syntax. The step definition calls
`CSValueResolver.resolve(...)` to substitute the real value.

- `{config:VAR_NAME}` — read from the configuration hierarchy
  (env files, command-line overrides, etc.)
- `{env:VAR_NAME}` — read from the process environment
- `{ctx:key}` — read from the current BDD context (values set by
  earlier steps in the same scenario)
- `{data:field}` — read from another field in the same data row

Use config references for sensitive values (credentials, API
keys, URLs) and for values that vary by environment. Example:

```
{
    "scenarioId": "LOGIN_01",
    "userName": "{config:APP_USERNAME}",
    "password": "{config:APP_PASSWORD}",
    "role": "tester",
    "runFlag": "Yes"
}
```

Never hardcode credentials in the data file. The audit rejects
any field name matching `*password*`, `*secret*`, `*token*`, or
`*apikey*` that doesn't use a `{config:...}` or `{env:...}`
reference.

## Empty and null values

- For an empty string, use `""` — not `null`, not missing
- For a genuinely absent value that should resolve at runtime
  (from a database query or another step), use `""` as the
  placeholder and document in `scenarioName` or a comment that
  it will be filled in dynamically
- Never omit a key that is referenced by the feature file. Every
  `<paramName>` must appear in every row of the data file.

## Boolean values

- Use JavaScript booleans: `true` and `false`
- Never use string booleans: `"true"`, `"false"`, `"Yes"`, `"No"`
  — except for `runFlag`, which uses `"Yes"` / `"No"` by
  convention
- The step definition or helper is responsible for coercing
  strings to booleans if needed

## Numeric values

- Use JavaScript numbers: `42`, `3.14`, `1000`
- Never wrap numbers in quotes unless they represent
  identifiers that happen to be numeric strings (e.g., order
  numbers that preserve leading zeros)

## Date values

- Use ISO-8601 string format: `"2026-01-15"` or
  `"2026-01-15T10:30:00Z"`
- The step definition or helper parses via `CSDateTimeUtility`
- Never use locale-specific formats like `"1/15/2026"` or
  `"15-Jan-2026"`

## Multi-dataset (nested) structure

For projects where one feature needs multiple keyed data sets,
use a nested JSON object with top-level keys naming each set.
The `Examples:` tag references the set via the `path` field.

```
{
    "TD_Key_Search": [
        {
            "scenarioId": "SEARCH_01",
            "scenarioName": "Search by id",
            "runFlag": "Yes",
            "searchField": "orderId",
            "searchValue": "ORD-001"
        },
        {
            "scenarioId": "SEARCH_02",
            "scenarioName": "Search by email",
            "runFlag": "Yes",
            "searchField": "customerEmail",
            "searchValue": "test@example.test"
        }
    ],
    "TD_Key_Export": [
        {
            "scenarioId": "EXPORT_01",
            "scenarioName": "Export all results",
            "runFlag": "Yes",
            "exportFormat": "xlsx"
        }
    ]
}
```

Feature file:

```
Examples: {"type": "json", "source": "test/<project>/data/search-scenarios.json", "path": "$.TD_Key_Search", "filter": "runFlag=Yes"}
```

Use nested structure when multiple feature scenarios share the
same data file but need distinct data sets. Use flat array
structure when a single feature scenario iterates over one data
set.

## Row and column audit rules

When converting from a legacy data source (Excel, CSV, database
dump):

- **Row count must match.** If the legacy source has 47 rows in a
  data set, the JSON file has 47 objects. No silent truncation.
- **Column count must match.** Every column header in the legacy
  source becomes a key in every JSON object. No silent column
  drops.
- **Empty cells become empty strings.** Never drop the key for
  an empty cell — the object still has the key with value `""`.
- **Column order preserved.** JSON object key order is not
  significant to JavaScript but is significant to readers and
  diff tools. Preserve the source's column order in the object
  literal.
- **Header renaming rules are deterministic.** Convert spaces to
  camelCase, preserve numeric suffixes, lowercase first
  character. Record the legacy-to-canonical mapping.

The audit checklist runs a row and column count verification
when given a legacy source reference alongside the generated
data file.

## Excel (XLSX) conversion to JSON

Legacy Excel data with a keyed-block structure (multiple data
sets per sheet, each bracketed by a key cell) converts to
either:

1. **One JSON file per block**, each with a flat array shape.
   Filename suffix reflects the block key, e.g.,
   `order-search-td-key-search.json`.

2. **One JSON file with nested structure**, keys at the top
   matching the block names.

Option 2 is usually preferred for features that switch between
data sets within one flow.

Conversion audit checks:
- Total row count across all output files equals total row count
  across all input blocks
- Every non-blank column header appears as a key in every output
  row
- Empty cells in the source become `""` in the output, never
  omitted
- Cell values are trimmed of leading/trailing whitespace but
  preserve internal whitespace
- Boolean string values (`"Y"`, `"N"`, `"Yes"`, `"No"`) are
  either converted to proper JSON booleans or kept as strings
  consistently across the file — pick one and document the
  choice

## CSV shape

For projects using CSV data sources, the file has:

- A header row with camelCase column names
- One data row per scenario iteration
- Empty cells allowed (just consecutive commas or explicit empty
  strings)
- UTF-8 encoding
- Unix line endings
- Quoted strings for values containing commas, quotes, or
  newlines

CSV files follow the same mandatory metadata field rule: every
row has `scenarioId`, `scenarioName`, and `runFlag` columns.

## Forbidden patterns

Never do any of these in a data file:

- Omit the `scenarioId`, `scenarioName`, or `runFlag` fields
- Use snake_case or TitleCase keys (always camelCase)
- Hardcode credentials, API keys, or database passwords
- Reference a missing config variable (`{config:NOT_DEFINED}`)
- Drop rows or columns from a legacy source without audit
  justification
- Use comments in JSON (JSON does not support comments; use a
  separate documentation file)
- Mix flat and nested structures in the same file
- Use inconsistent key names across rows (every row has the same
  keys)
- Use trailing commas (valid in some parsers but not universal)
- Use Windows CRLF line endings in JSON files (Unix LF only)
- Include BOM (byte order mark) in JSON or CSV files

## Self-check before returning a data file

- [ ] Filename ends in `.json` or `.csv`, kebab-case or
      snake_case
- [ ] Every row has `scenarioId`, `scenarioName`, `runFlag`
- [ ] All keys are camelCase and match feature `<parameters>`
- [ ] Sensitive values use `{config:...}` references, never
      hardcoded
- [ ] Empty cells from legacy become `""`, not `null`, not missing
- [ ] Row count matches the legacy source exactly
- [ ] Column count matches the legacy source exactly
- [ ] All referenced config variables are defined in the
      environment env files
- [ ] Booleans are JSON `true`/`false`, not `"true"`/`"false"`
      (except `runFlag`)
- [ ] Dates are ISO-8601 strings
- [ ] No trailing commas, no comments, Unix line endings
- [ ] Nested structure path matches the feature's Examples
      `path` field exactly

If any item fails, fix it before returning. The audit checklist
tool enforces most of these rules and compares against the
legacy source when one is provided.
