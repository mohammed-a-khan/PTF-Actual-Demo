---
name: locator-reconciliation
description: >
  Protocol for reconciling element locators between legacy
  source, live application DOM (via Playwright MCP accessibility
  tree), and prior pattern memory. Covers evidence sources,
  confidence scoring, conflict resolution, role-based selector
  preference, and the multi-evidence consensus rule. Load when
  analysing page objects or when healing locator-related test
  failures.
---

# Locator Reconciliation Protocol

## When this skill applies

- During analysis of a legacy page object, when the analyzer
  needs to decide whether to preserve the legacy locator or
  replace it with a more durable selector
- During healing, when a generated test fails because an
  element isn't found and the healer needs to reconcile
  against the live application state

## The three sources of truth

Every locator decision is backed by evidence from up to three
sources:

1. **Legacy source AST** — what the original page object
   declared, extracted by `read_file`. This is what the
   test WAS testing against.
2. **Live application accessibility tree** — what the real
   application exposes right now, captured via Playwright MCP
   `snapshot_accessibility`. This is what the test MUST work
   against.
3. **Correction memory** — what prior migrations have already
   solved for the same or similar elements, retrieved via
   the correction log at `.agent-runs/correction-patterns.md`.

Multi-evidence means: cross-check sources before committing to
a locator. Agreement between two sources is high confidence.
Disagreement triggers a resolution step.

## Source A — legacy source AST

Extracted via `read_file`. For each element declared in
the legacy page object:

- Field name
- Locator type (`xpath`, `css`, `id`, `name`, `text`, `role`,
  `testId`)
- Locator value as a literal string
- Description if present in the annotation

Rules:
- Preserve the legacy field name in the spec's `legacy_names`
  map
- Preserve the literal locator value verbatim — including
  typos in DOM IDs, because the real DOM may have the same
  typo
- Record the inferred element type (text box, button,
  dropdown, etc.) from the description and the legacy framework
  convention

## Source B — live accessibility tree

Captured via Playwright MCP:

1. `playwright_navigate(url)` — open the page hosting the
   element (URL is inferred from the page object's identifier
   and config)
2. `playwright_snapshot_accessibility` — returns the structured
   tree with `{ role, name, description, ref, children }`
   nodes

Match a candidate from the tree to the legacy element by:
- Role matching the element type (button, textbox, link,
  combobox, etc.)
- Name matching the element's description or label
- Structural position matching the legacy neighbourhood (if
  the legacy xpath targets a button inside a specific dialog,
  find the same button inside the same dialog in the tree)

If the live app is unreachable, skip this source and flag
every locator as `confidence: "source-only"`.

## Source C — correction memory

Retrieved by reading `.agent-runs/correction-patterns.md` with
`read_file` (create the file with `write_file` on first run if
it doesn't exist). The log is a plain markdown file with one
section per recorded fix:

```
## 2026-04-16 — Save button locator drift on order detail page

**Context:** page-object, locator-drift

**Before:**
    xpath: //button[@id='saveBtn']

**After:**
    role: button, name: Save

**Why:** The legacy xpath referenced an id that no longer
exists in the current DOM. Role-based selector is more durable.
```

Scan the file for entries whose description matches the current
situation (same element type, same page archetype). Apply a
hit only when:

- The description closely matches the current failure
- The context tags match (same file type, same category)
- The fix snippet can be transplanted to the current code

## Confidence levels

Every locator in the canonical spec carries a confidence tag:

- `high` — legacy source AND live tree agree, or the memory
  hit was high-confidence
- `live-only` — only the live tree produced a match; legacy
  source either disagreed or was unreadable
- `source-only` — only the legacy source has the locator; live
  app unreachable or couldn't find a matching element
- `conflict` — both sources produced candidates but they
  disagree; resolution deferred to the healer

## Reconciliation rules

### Both sources agree

Record the element with `confidence: "high"` and prefer the
role-based selector from the accessibility tree over the
legacy xpath:

```
"elements": {
    "buttonSave": {
        "role": "button",
        "name": "Save",
        "legacy_locator": "//button[@id='saveBtn']",
        "confidence": "high",
        "description": "Save order button"
    }
}
```

Role-based selectors are more durable — they survive DOM
restructuring, class renames, and ID changes. When both
sources agree on the semantic element, use the semantic
selector.

### Legacy matches, live unreachable

Record `confidence: "source-only"` with the legacy xpath and
note that live reconciliation is deferred:

```
"elements": {
    "buttonSave": {
        "xpath": "//button[@id='saveBtn']",
        "legacy_locator": "//button[@id='saveBtn']",
        "confidence": "source-only",
        "description": "Save order button (live unreachable)"
    }
}
```

The healer performs live reconciliation at test execution
time if needed.

### Live matches, legacy doesn't

This happens when the legacy xpath is stale or was never
correct. Record `confidence: "live-only"` using the tree's
selector and flag the legacy locator in the gaps:

```
"elements": {
    "buttonSave": {
        "role": "button",
        "name": "Save",
        "legacy_locator": "//button[@class='btn primary']",
        "confidence": "live-only",
        "description": "Save button (legacy locator obsolete)"
    }
},
"gaps": [
    {
        "field": "buttonSave",
        "issue": "Legacy xpath does not match live DOM — replaced with role selector"
    }
]
```

### Both disagree

Record `confidence: "conflict"` with both candidates and defer
resolution to the healer. The generator will use the live
selector as the primary and the legacy xpath as an
`alternativeLocators` fallback:

```
"elements": {
    "buttonSave": {
        "role": "button",
        "name": "Save",
        "legacy_locator": "//button[@id='oldSaveBtn']",
        "confidence": "conflict",
        "description": "Save button (locator drift - needs runtime verification)"
    }
}
```

At test execution, the healer tries the primary first; if it
fails, it tries the fallback; if both fail, it re-snapshots
the accessibility tree and picks a new candidate.

## Selector preference order

When choosing a selector, prefer in this order (most durable
first):

1. `role` + `name` — accessibility-based, most durable
2. `testId` — stable test-specific attribute
3. `id` — stable DOM ID
4. `name` — form field name attribute
5. `css` with a stable class and structural context
6. `text` — visible text match (brittle to copy changes)
7. `xpath` with absolute path — last resort

Avoid:
- Absolute xpaths starting with `/html/body/...`
- CSS selectors based on auto-generated class names
  (`css-1a2b3c`)
- Text-only selectors for elements whose text changes
  frequently
- Index-based selectors (`:nth-child(4)`) unless the index is
  semantically meaningful

## Dynamic element strategy

For elements with locators that depend on runtime values
(grid rows, dynamically labeled buttons), the spec records a
LOCATOR TEMPLATE rather than a static selector:

```
"dynamicElements": {
    "resultRow": {
        "locatorTemplate": "//table[@id='results']//tr[td[normalize-space(text())='${value}']]",
        "parameters": ["value"],
        "description": "Result row matching the given value"
    }
}
```

The generator emits a method on the page object that
constructs the locator using `CSElementFactory.createByXPath`
with the interpolated template.

## Healer-side reconciliation

When a test fails with "element not found", the healer:

1. Re-snapshots the accessibility tree at the failure point
2. Searches for candidate elements near the logical location
   (same page, similar role, similar name, similar surrounding
   structure)
3. If a high-confidence candidate is found, updates the page
   object's locator and re-runs
4. If no candidate is found, classifies as HIGH-risk and
   escalates

The healer records successful fixes to correction memory so
future runs benefit from the resolution.

## Forbidden practices

Never do any of these in locator reconciliation:

- Accept a legacy locator as-is without attempting live
  reconciliation when the app is reachable
- Invent an xpath that isn't in the legacy source AND isn't
  in the live tree
- Use a role-based selector with `name` that differs from
  both the legacy description and the live label
- Record `confidence: "high"` without two agreeing sources
- Skip memory query when high-confidence prior art exists
- Use index-based selectors without explicit justification
- Apply a memory hit with a mismatched context
- Silently drop an element because you couldn't reconcile it
  — record it with `confidence: "source-only"` and let the
  healer decide

## Self-check after reconciliation

- [ ] Every element in the spec has a `confidence` tag
- [ ] Every `high`-confidence element is backed by two agreeing
      sources
- [ ] Every `conflict` element has both candidates recorded
- [ ] Every `live-only` element notes the legacy locator in
      `legacy_locator` for reference
- [ ] Role-based selectors are preferred where the accessibility
      tree provides them
- [ ] Dynamic elements are recorded as templates with
      parameters
- [ ] No absolute xpaths starting with `/html/body`
- [ ] No memory hits applied outside their context match
- [ ] The `gaps` array lists any elements that could not be
      reconciled
