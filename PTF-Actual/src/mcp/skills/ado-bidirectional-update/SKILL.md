---
name: ado-bidirectional-update
description: Use when the user has edited a generated test (changed a step, fixed an assertion, added a verification) and wants to push the change back to the original Azure DevOps test case. The existing `ado_work_items_update` tool handles the write — this skill documents the BDD-feature → Microsoft.VSTS.TCM.Steps conversion the LLM needs to perform first.
---

# Pattern: bidirectional update (code → ADO)

## When to use

The migration originally came FROM ADO (mode `ado_test_case_id` /
`ado_test_suite_id` / `ado_test_plan_id`). The user has since edited
the generated `.feature` file or step file and wants the change to
flow back to the ADO test case. The framework's
`ado_work_items_update` MCP tool accepts an arbitrary `fields` map,
including `Microsoft.VSTS.TCM.Steps` — but it expects the steps as
ADO's HTML-XML format, not Gherkin. This skill walks through the
conversion and the call.

## End-to-end flow

```
1. User edits  test/<project>/features/login.feature
2. User asks Copilot:
     "Push the changes for TC#3430 back to ADO"
3. Copilot:
   a. Reads the .feature file via read_file
   b. Locates the @TS_3430 (or @TC#3430) tagged scenario
   c. Converts the Given/When/Then steps to Microsoft.VSTS.TCM.Steps XML
   d. Calls ado_work_items_update with id=3430 + fields.Microsoft.VSTS.TCM.Steps=<xml>
4. ADO test case is updated; revision number bumps; comment appended.
```

## Microsoft.VSTS.TCM.Steps XML format (what ADO expects)

```xml
<steps id="0" last="3">
  <step id="2" type="ActionStep">
    <parameterizedString isformatted="true">&lt;P&gt;Navigate to login page&lt;/P&gt;</parameterizedString>
    <parameterizedString isformatted="true">&lt;P&gt;Login page is shown&lt;/P&gt;</parameterizedString>
    <description/>
  </step>
  <step id="3" type="ActionStep">
    <parameterizedString isformatted="true">&lt;P&gt;Enter credentials and submit&lt;/P&gt;</parameterizedString>
    <parameterizedString isformatted="true">&lt;P&gt;Dashboard is shown&lt;/P&gt;</parameterizedString>
    <description/>
  </step>
</steps>
```

Each `<step>` has two `parameterizedString` elements: action then expected.
The framework's `CSAdoTestCaseParser.serializeSteps()` produces this XML
shape from a `ParsedTestCase`. For programmatic use, convert the BDD
scenario to a `ParsedTestCase` first (action = `Given/When/X`, expected
= the immediately-following `Then`), then call `serializeSteps()`.

## Tool-call shape

```typescript
// What Copilot actually calls (after reading the feature + converting):
{
    tool: 'ado_work_items_update',
    arguments: {
        id: 3430,
        organization: '${input:adoOrganization}',  // or env-resolved
        project: '${input:adoProject}',
        pat: '${input:adoPat}',
        comment: 'Updated via cs-ai-auto-assist after edit to features/login.feature',
        fields: {
            'Microsoft.VSTS.TCM.Steps': '<steps id="0" last="3">...</steps>',
        },
    }
}
```

The `comment` lands in `System.History` so the test case audit log
shows where the change came from.

## Conversion rules — Gherkin → ADO steps

| Gherkin keyword | ADO step `parameterizedString[0]` (action) | ADO step `parameterizedString[1]` (expected) |
|---|---|---|
| `Given <text>` | `<text>` | (empty `<P/>`) |
| `When <text>` | `<text>` | (empty `<P/>`) |
| `Then <text>` | (merged into prior step's expected) | `<text>` |
| `And <text>` | continues prior keyword's mode | continues prior keyword's mode |
| `But <text>` | continues prior keyword's mode | continues prior keyword's mode |

So a `When ... Then ...` pair fills both halves of one ADO step. A
`Given` followed by another `Given` produces two ADO steps each
with empty `expected`. Keep this 1-to-1 mapping; ADO testers expect
each ADO step to have one action + one expected, not freeform prose.

## Conversion rules — Scenario Outline `Examples:` blocks

ADO test cases support **shared parameters** via `<parameters>` and
`Microsoft.VSTS.TCM.LocalDataSource`. For Phase 3, when pushing a
Scenario Outline back, prefer to:

1. Push the **template** scenario (with `<placeholder>` references) to
   `Microsoft.VSTS.TCM.Steps`
2. Push the **rows** to a referenced data source (out of scope for
   v1 — this skill only updates the steps; data-row sync stays
   manual through the ADO web UI for now)

If the original ADO test case had `LocalDataSource` set, leave it
untouched in the update (don't include it in the `fields` map).

## Forbidden patterns

```typescript
// ❌ NEVER push raw Gherkin text into Microsoft.VSTS.TCM.Steps —
// ADO renders the field as HTML and expects the <steps> XML envelope.
fields: {
    'Microsoft.VSTS.TCM.Steps': 'Given I login\nWhen I click Save\nThen success',
}

// ❌ NEVER push without a comment — the audit trail loses the
// "where did this change come from" context.
{ id: 3430, fields: { ... } }   // missing comment
```

## Common gotchas

1. **HTML-encoded inner `<P>` tags** — ADO expects the inner
   `<P>action</P>` markers to be HTML-encoded inside the
   `parameterizedString` element (`&lt;P&gt;`, not raw `<P>`).
   `CSAdoTestCaseParser.serializeSteps()` handles this; if you
   build the XML manually, encode entities first.
2. **`last` attribute** must equal the highest `step id` in the doc.
   Off-by-one errors here cause the ADO web UI to silently drop
   the last step on save.
3. **Step `id` numbering starts at 2**, not 1. ADO reserves id 1
   internally. The serializer auto-handles this; manual construction
   needs the same convention.
4. **Comment goes in `System.History`, not the steps XML.** Use the
   tool's `comment` parameter; never embed it in the XML.
5. **Revision bump** — every successful update increments the work
   item's `System.Rev`. If you want optimistic concurrency, fetch
   `System.Rev` first and add a `System.Rev` field to the update;
   ADO returns 409 if the revision is stale.

## Existing tooling reference

| Tool | Use |
|---|---|
| `ado_work_items_get` | Fetch current state before update (e.g., for revision check) |
| `ado_work_items_update` | The actual write — accepts `fields` map |
| `ado_work_items_get_batch` | Batch refresh after multiple updates to confirm |
| `CSAdoTestCaseParser.parseSteps()` | XML → ParsedTestCase (the inverse direction) |
| `CSAdoTestCaseParser.serializeSteps()` | ParsedTestCase → XML (this direction) |
| `ado_test_runs_list` / `ado_test_results_*` | Verify the test case still has historical results after the update |
