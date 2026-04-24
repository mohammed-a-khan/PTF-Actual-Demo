---
name: heal-cascade-revert
description: Use when a fix for one failing scenario breaks a previously-green scenario. Revert, reclassify, escalate.
---

# Healing pattern: cascade regression

## When to apply

The Healer applies a fix, re-runs the failing scenario (green), but the cascade check reports a previously-green scenario is now red. The fix introduced a regression elsewhere.

Classification of the original failure: was LOW or MEDIUM; the cascade event reclassifies it to HIGH.

## Contract

Cascade regression is **not** a second fix attempt — it's a **revert + escalate**. The Healer does not try a second fix that might break yet another scenario.

## Sequence

```
1. baseline_green = snapshot of currently-passing scenarios (captured before the heal loop started)
2. fix applied; target scenario now green
3. cascade = test_run(baseline_green)
4. if any baseline_green scenario is now failing:
      a. revert the fix (restore the file from pre-fix state)
      b. re-run the target scenario to confirm it's back to its original failing state
      c. escalate with a structured report
      d. do NOT try another fix
      e. do NOT record the (failed) pattern to correction memory
```

## What the escalation report includes

- Original failure id + signature
- Fix attempted (file edited, exact diff)
- Cascade scenarios that regressed (ids + new error messages)
- Classification: HIGH (cascade-induced)
- Recommendation: the original failure likely requires a broader refactor (e.g. page-object restructure, shared helper change) — beyond the Healer's single-file fix scope
- Pointer to where the human should look

## Example

Failing target: `TS_LOGIN_01`. Fix proposed: changed `signInButton` locator from `//button[@id="signin-btn"]` to `//button[@data-testid="loginSubmit"]`.

Cascade check: `TS_PASSWORD_RESET_01` (previously green) now fails with the same locator because it reuses the same `LoginPage`. The underlying DOM change affects both — but the generated fix only considered the target scenario's context.

Action: revert, escalate. Human needs to decide whether the page-object change is the right fix (which would update `TS_PASSWORD_RESET_01` too) or whether the UI change is unexpected and should be reverted in the app.

## Rules

- **Revert is mandatory** when cascade detected — do not ship a fix that regressed green scenarios
- Revert restores the exact pre-fix content — use `read_file` to snapshot before applying, then `edit_file` to restore on revert
- After revert, confirm the target scenario is again in its ORIGINAL failing state (sanity-check — if it now passes with no fix, the original failure may have been flaky, not deterministic)
- Never retry with a different fix after a cascade regression in the same loop — escalate and let a human judge
- The failed attempt is NOT recorded to correction memory (memory only records verified-green patterns)
