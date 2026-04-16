---
name: legacy-source-parsing
description: >
  Canonical protocol for reading legacy test framework source
  files during migration analysis. Covers AST-first discipline,
  test method enumeration, annotation extraction, support class
  traversal, data provider resolution, inheritance chain walking,
  legacy typo preservation, and when to escalate vs when to
  guess. Load when analysing any legacy source file.
---

# Legacy Source Parsing Protocol

## When this skill applies

Any analysis of a legacy test framework source file — typically
Java/Selenium/TestNG/QAF files being migrated to the target
TypeScript framework. This skill defines HOW the analyzer agent
reads legacy code to produce a canonical spec.

## Core discipline

- **Read completely.** Always call `read_file` on the full
  legacy source file. For large files, read in chunks — never
  paraphrase.
- **Enumerate completely.** If a class has twelve test methods,
  the canonical spec lists twelve entries. Partial enumeration
  produces partial migrations, which is worse than no migration.
- **Preserve legacy names verbatim.** Typos, abbreviations, and
  inconsistent casing in the legacy source are preserved in
  `legacy_names` for traceability. Clean names appear only in
  the canonical spec's `canonical_names` field.
- **Never fabricate.** If part of the file is unreadable or
  corrupted, record a gap — never guess what "probably" should
  be there.
- **Walk the inheritance chain.** A test class that extends a
  base class inherits fields and methods — read the base too.

## Step 1 — Read the file

Call `read_file(filePath)` to load the full source. Scan for:

- Package declaration and imports
- Class declarations (name, modifiers, `extends`, `implements`)
- Class-level annotations (including parameters)
- Field declarations (modifiers, type, name, annotations,
  initializer)
- Method declarations (modifiers, return type, name, parameters,
  annotations, body line range)

You produce this structured view from the text directly. There
is no dedicated AST parser — Copilot reads the Java text and
extracts the structure using the skill's conventions.

- `classes` — every class defined in the file (name, modifiers,
  extends, implements)
- `methods` — every method (name, modifiers, parameters, return
  type, annotations, line range)
- `fields` — every field (name, type, modifiers, annotations,
  initialiser)
- `annotations` — every annotation on the file's elements
  (class-level, method-level, field-level) with parameters
- `imports` — every import statement

If the AST parser errors (unsupported syntax, corrupted file),
record a `gaps` entry and stop. Do not proceed to text inspection
— without structural ground truth, you can't verify your
transcription.

## Step 2 — Enumerate test methods

For each class that matches "is a test class" criteria:

### What counts as a test class

- Has at least one method annotated with the legacy framework's
  test annotation (e.g., `@Test`)
- Extends the legacy framework's base test class (if any)
- Lives under the legacy test source tree (typical directory
  names include `testsuites`, `tests`, `test`)

### What counts as a test method

A method is a test case if and only if:
- It carries the framework's test annotation (`@Test` or
  equivalent)
- It is public (legacy test frameworks require public visibility
  for test methods)
- It is a top-level method of the class, not an inner method

Comments that look like test IDs embedded inside a method body
(e.g., a line `// TC_1234: verify X` in the middle of a larger
method) are NOT separate tests. They're section markers within
a single test case. This is a common misreading that leads to
invented test cases that don't actually exist.

### Extract for each test method

- Test case ID (from `@MetaData`, `@TestCaseId`, or equivalent
  annotation). If the annotation has multiple fields, extract
  all of them.
- Display name / title (usually a separate annotation field)
- Data provider reference (annotation field pointing to an
  external data source)
- Dependency methods or groups (`dependsOnMethods`,
  `dependsOnGroups`)
- Priority or order number if declared
- Tag / category list if declared
- The full method body as an ordered list of statements

### Preserve counts

Every test method found goes into the spec. If you found 12
methods, your spec has 12 entries. A spec with fewer entries
than the AST shows is a validation error and the audit rejects
it.

## Step 3 — Walk the method body

For each test method body, extract:

### Navigation actions

Statements that open a page or navigate the browser:
- Page object constructor calls (`new SomePage(...)`)
- Navigation method calls (`page.open()`, `page.navigate(...)`)
- URL assignments

### UI actions

Statements that interact with an element:
- Click, fill, select, check, upload, download
- Each action noted with: element field, action type,
  parameter value (literal or variable)

### Assertions

Statements that verify an expected state:
- The legacy framework's assertion methods
  (`assertTrue`, `assertEquals`, `verifyText`, etc.)
- Element state checks (`isVisible()`, `isEnabled()`, etc.)
- Data comparisons
- Each assertion noted with: target (element or value), verb
  (equals / contains / visible / not-visible / enabled /
  disabled), expected value

### Support method calls

Calls into shared utility classes:
- Method call syntax (`SupportClass.doSomething(...)`)
- Instance method calls on shared objects
- Record the support class name and method name; these need
  their own analysis pass

### Database operations

Calls to database utilities in the legacy code:
- Query execution methods
- SQL string literals (legacy may have hardcoded queries)
- Expected behaviour: migration moves these to named queries
  in the target config's db queries file

### API calls

Calls to HTTP clients:
- REST client method calls
- URL construction
- Auth setup

## Step 4 — Walk the inheritance chain

If the test class extends a base class:

1. Read the base class via `read_file`
2. Walk its methods for shared setup / teardown hooks
3. Walk its fields for shared page object instances, utility
   handles, configuration pointers
4. Continue up the chain until you reach a framework-provided
   root class

Fields and methods inherited from the base class are part of
the logical test state. Omitting them produces a spec where
referenced fields "don't exist", which causes generation
failures downstream.

## Step 5 — Data provider resolution

For each test method with a data provider annotation:

1. Identify the data source type:
   - Excel file (typical in QAF-style legacy) — rows keyed by
     a "TD_Key" column or similar
   - CSV file
   - Database query
   - In-memory array of arrays
   - Provider method returning structured data

2. Locate the data file:
   - Usually under `resources/<env>/testdata/` or similar
   - Path may include variable interpolation (`${environment.name}`)
     — resolve it against the legacy config

3. Read the data:
   - For Excel: every column in the keyed block, every row
   - For CSV: every column, every row
   - For database queries: the literal SQL text, parameters,
     and expected output shape (you can't execute the query
     at analysis time; capture the SQL)
   - For in-memory: the array contents

4. Count rows and columns exactly. The canonical spec must
   match. Missing rows or dropped columns is a spec failure.

## Step 6 — Page object classes referenced

Every page object class referenced by the test class needs its
own analysis pass:

- Walk the test method body's constructor calls and field
  declarations to find page object types
- For each page object class, call `read_file` and
  extract its element declarations
- Record each element's field name, locator type, locator
  value (preserving typos in DOM IDs), and description
- Walk the page object's inheritance chain for inherited
  elements
- Record any in-method helper logic the page object contains

## Step 7 — Legacy typo preservation

Legacy source often contains typos in identifier names,
field names, or DOM IDs:

- `buttonSuccces` instead of `buttonSuccess`
- `primAryAsset` instead of `primaryAsset`
- `recieveMessage` instead of `receiveMessage`

### Rules

- The canonical spec's `legacy_names` field maps every
  misspelled identifier to its clean form:

```
"legacy_names": {
    "buttonSuccces": "buttonSuccess",
    "primAryAsset": "primaryAsset"
}
```

- The rest of the canonical spec uses the CLEAN names. The
  generator produces target code with clean names.
- If the misspelling is in a DOM ID (`id="userNmae"` in the
  HTML of the real application), the LEGACY XPath is
  preserved verbatim because the DOM really has that ID.
  The clean name applies to the TypeScript field name only,
  not the locator string.
- If uncertain whether a typo is in the source or the real
  DOM, reconcile against the live accessibility tree. See
  `locator-reconciliation`.

## Step 8 — Comments and context markers

Legacy source often carries context in comments:
- Test intent (what is being verified)
- Workarounds for known bugs
- Historical notes about why a step exists
- References to external documentation or tickets

These are valuable for generating descriptive feature file
titles and scenario narratives. Extract them into the spec's
`notes` field. They inform the generator but are not part of
the generated code.

Do NOT treat comments as executable logic. A comment that
says "verifies the user is redirected" is a clue, not a
verification step — the actual verification must be in the
code.

## Step 9 — When to escalate vs when to proceed

### Proceed when

- AST parse succeeds and you have a structural view of the file
- All referenced classes and data sources exist and can be read
- Locator strings and assertion verbs are deterministic
- Only minor gaps exist (a comment that hints at intent but
  doesn't affect code)

### Escalate when

- AST parse fails on the file or on a required base class
- A referenced data file doesn't exist
- A referenced page object class doesn't exist
- The test method body contains calls to methods that don't
  exist in any resolvable class
- The data file has fewer rows or columns than a hardcoded
  index in the test expects
- Locator strings reference DOM structures that would need
  live verification and the live application is unreachable

Escalation means: return a spec with `status: "incomplete"` and
a `gaps` array listing exactly what's missing. The planner
decides whether to retry analysis with additional input or
escalate to a human.

## Step 10 — Self-audit before returning

- [ ] Every `@Test`-annotated method in the AST appears in the
      canonical spec
- [ ] Method count in the spec equals method count in the AST
- [ ] Every element field in every page object appears in the
      canonical spec
- [ ] Every row and column in the data file appears in the
      data spec
- [ ] Legacy typos are recorded in `legacy_names`
- [ ] No fabricated methods, fields, or assertions
- [ ] Every locator has a confidence tag (high / live-only /
      source-only / conflict)
- [ ] Every gap is recorded in the `gaps` array with enough
      detail for a human to understand what's missing
- [ ] Inheritance chain has been walked to the framework root
- [ ] Support method calls are recorded with their class and
      method name for later analysis

## Forbidden practices

Never do any of these during legacy analysis:

- Skim the source text without an AST parse first
- Assume a method does what its name suggests — read the body
- Treat in-method comments as test cases
- Invent a test case that's not annotated
- Drop assertions when they seem redundant
- Silently correct legacy typos without recording them
- Merge two distinct test methods into one spec entry because
  they "look similar"
- Return an empty `gaps` array without verifying completeness
- Fabricate locator XPaths that aren't in the source
- Guess data row values when the data file is unreadable
