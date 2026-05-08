---
name: heal-loop-driver
description: Use after a generated test fails. Documents the end-to-end heal flow the host LLM should drive: run scenario → on fail capture state → inspect live DOM → propose locator/timing fix → apply via replace_string_in_file → re-run until green or hit retry cap.
---

# Pattern: agent-driven heal loop

## When to use

A generated test failed (compile passed, audit passed, but the test
itself didn't pass against the real app). Two failure shapes:

1. **Locator drift** — the page object's xpath doesn't match the live
   DOM (most common; happens when the app's HTML changes between when
   the test was written and now)
2. **Timing flake** — element exists but the test doesn't wait long
   enough, races against an animation, or hits a stale-state read

The host LLM (Copilot) drives the heal loop. The MCP server provides
two primitives — `csaa_run_scenario` and `csaa_capture_failure_state`
— plus the existing `browser_generate_locator` tool. The framework's
runtime self-healing (`CSSelfHealingEngine` with 4 strategies) catches
many drift cases automatically; this loop handles the cases the
runtime engine can't fix.

## End-to-end flow

```
1. Generate completes (cs_ai_auto_assist returns READY-with-warnings).
2. User asks: "run the migrated tests and fix anything that fails"
3. Copilot calls csaa_run_scenario for each scenario id.
4. For each FAIL:
   a. csaa_capture_failure_state(scenarioId, project)
      → returns screenshot, dom snapshot, last URL, console errors
   b. Copilot reads the artefacts (read_file the screenshot path,
      open the DOM snapshot if present) and identifies the failed
      element from the failed step.
   c. browser_generate_locator(url=lastPageUrl, intent="<failed element>")
      → returns ranked candidate xpaths from live DOM
   d. Copilot picks the best candidate, edits the page object via
      replace_string_in_file.
   e. csaa_run_scenario again. If still failing and < 3 attempts for
      this scenario, loop back to step 4a. Else escalate.
5. Once all scenarios pass, summarize results to user.
```

## Bounded retry policy

- **3 attempts per scenario.** After 3 failed fix attempts on the
  same scenario, escalate (surface a clear summary to the user; do
  not loop indefinitely).
- **20 attempts total per migration run.** Even if individual
  scenarios are still under their per-scenario cap, stop the loop
  globally to prevent runaway cost.
- **Cascade revert.** If a fix to scenario A breaks scenario B that
  was previously passing, revert the fix and try a different
  approach. Never trade green for new red.

## Concrete tool sequences

### Sequence 1 — locator drift, one attempt fixes it

```
> csaa_run_scenario { scenarioId: "TS_001", project: "myproject" }
< { passed: false, failedStep: "I click Save on the form", failureMessage: "Timeout 30000ms exceeded" }

> csaa_capture_failure_state { scenarioId: "TS_001", project: "myproject" }
< { screenshot: "...", lastPageUrl: "https://app.example.com/users/edit",
    domSnapshot: "...", artefactDir: "..." }

> read_file { path: "...screenshot.png" }
< (Copilot sees the page; identifies the Save button moved class names)

> browser_generate_locator { url: "https://app.example.com/users/edit",
                              intent: "Save button on the user edit form" }
< { candidates: [
    { xpath: "//button[normalize-space()='Save Changes']", score: 0.94,
      reason: "id-anchored, visible, enabled" },
    { xpath: "//form//button[@type='submit']", score: 0.78 },
    ...
  ] }

> replace_string_in_file {
    file: "test/myproject/pages/user-edit.page.ts",
    old_string: "xpath: \"//button[normalize-space()='Save']\"",
    new_string: "xpath: \"//button[normalize-space()='Save Changes']\""
  }

> csaa_run_scenario { scenarioId: "TS_001", project: "myproject" }
< { passed: true }
```

### Sequence 2 — timing flake

```
> csaa_run_scenario { scenarioId: "TS_002", project: "myproject" }
< { passed: false, failedStep: "I see the success message",
    failureMessage: "Expected element to be visible" }

> csaa_capture_failure_state { scenarioId: "TS_002", project: "myproject" }
< { screenshot: shows the message present but partially rendered,
    lastPageUrl: "...", domSnapshot: "..." }

(The element exists in the DOM but appeared after the test's wait window.
 Fix: increase the click timeout on the action that triggers the message,
 or add an explicit wait before the assertion.)

> replace_string_in_file {
    file: "test/myproject/pages/users.page.ts",
    old_string: "await this.submitButton.clickWithTimeout(5000);",
    new_string: "await this.submitButton.clickWithTimeout(30000);"
  }

> csaa_run_scenario { scenarioId: "TS_002", project: "myproject" }
< { passed: true }
```

### Sequence 3 — three-attempt escalation

```
attempt 1: csaa_run_scenario → fail. capture → inspect → patch → run → fail
attempt 2: capture → inspect (different element) → patch → run → fail
attempt 3: capture → inspect → patch → run → fail

> Surface to user:
"Scenario TS_005 failed 3 attempts. The action 'I click the Approve button'
 cannot complete. The button appears in the DOM but is disabled — likely a
 prerequisite (e.g. fill required fields first) is missing from the
 scenario. Manual review needed."
```

## When NOT to loop

- **Compile errors** — `commit_ready_check` / `compile_check` failures
  must be fixed FIRST via the audit loop. Don't try to heal a test
  that won't compile.
- **Audit failures** — pre-gate audit (PO/SD/FF rule violations)
  must be fixed before the test runs at all. Heal loop is post-audit.
- **HIGH severity classification** — environment-related failures
  (DNS, certs, app-down) are not the test's fault. Escalate, don't
  retry.

## Diagnostic priorities

When `csaa_capture_failure_state` returns the artefact paths, read
in this order:

1. **The screenshot** — fastest signal of "what went wrong visually"
2. **The console log** — JS errors, network failures, redirects to
   error pages
3. **The DOM snapshot** — only if screenshot + console didn't tell
   you which element drifted
4. **The trace zip** — only as a last resort; opens in Playwright
   trace viewer; useful for timing / waterfall analysis

## Forbidden patterns

```typescript
// ❌ NEVER patch the test scenario's GHERKIN to match a buggy app
//   (changing "I see success" to "I don't see success" hides the bug)

// ❌ NEVER `@skip` a failing scenario — use `runFlag: No` in the data
//   JSON if the user explicitly wants to defer

// ❌ NEVER retry the same fix more than once — if the same patch
//   doesn't pass on attempt 1 and 2, the diagnosis is wrong
```

## Common gotchas

1. **`csaa_capture_failure_state` requires the scenario was actually
   run.** Calling it before `csaa_run_scenario` returns "no
   test-results directory" — surface the active-imperative reason.
2. **Screenshots are post-failure** — they show the page AFTER the
   step failed, not what the user expected. The DOM may have moved on
   to an error page or modal.
3. **`browser_generate_locator` opens a real browser.** It honours
   `--headed` from the framework config. Long-running locator
   inspections accumulate Playwright contexts — check
   `CSBrowserManager` lifecycle if you suspect leaks.
4. **Cascade revert is YOUR responsibility, not the framework's.**
   Run the previously-passing scenarios after each fix to confirm
   they still pass. The heal loop's per-scenario cap means individual
   scenarios are bounded, but globally cascading regression must be
   caught here.
5. **Ambiguous element intent.** If `browser_generate_locator`
   returns multiple candidates with similar scores (within 0.05 of
   each other), the intent string was too vague. Re-call with a
   more specific intent ("Save Changes button on the user edit
   form, primary submit") and pick the highest-scored result.
