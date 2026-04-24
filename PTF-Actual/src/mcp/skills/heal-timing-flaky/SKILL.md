---
name: heal-timing-flaky
description: Use when a test fails intermittently with timing / visibility errors — action fires before the page has rendered or settled.
---

# Healing pattern: timing flakiness

## When to apply

Failure signatures:
- `Element is not visible` / `Element is not attached to DOM` (but IS visible on re-run)
- `Navigation timeout exceeded`
- `waitForLoadState` timeouts
- Intermittent `Element is detached`

Classification: LOW.

## Root causes in priority order

1. **Action fired before page settled** — e.g., click happens while a navigation is still in-flight
2. **Element waits for AJAX** but test proceeds on first paint
3. **Animation / transition** — button is visible but not yet interactive
4. **Implicit default timeout too short** for server round-trip clicks

## Diagnostic sequence

1. Re-run the failing scenario alone — confirm flakiness (passes sometimes)
2. Check the action method — is there an explicit `waitForVisible` before the action?
3. Check the click's timeout — is it 5000 on a navigation-triggering click?
4. Check if there's a loading overlay that wasn't awaited

## Fix variants

### Variant A — raise the click timeout

```typescript
// Before
await this.submitButton.clickWithTimeout(5000);

// After — navigation-triggering click
await this.submitButton.clickWithTimeout(30000);
```

### Variant B — add an explicit readiness wait

```typescript
public async submitAndWait(): Promise<void> {
    await this.submitButton.waitForVisible(10000);
    await this.submitButton.clickWithTimeout(30000);
    await this.page.waitForLoadState('networkidle');
}
```

### Variant C — wait for a loading overlay to disappear

```typescript
public async submit(): Promise<void> {
    await this.submitButton.clickWithTimeout(30000);
    await this.loadingOverlay.waitForHidden(30000);   // explicit overlay wait
}
```

### Variant D — wait for the NEXT page's anchor element

```typescript
// Prefer this — actionable vs. arbitrary sleep
public async submitAndExpectDashboard(): Promise<void> {
    await this.submitButton.clickWithTimeout(30000);
    const dashboard = new DashboardPage(this.browserManager);
    await dashboard.pageTitle.waitForVisible(30000);
}
```

## Rules

- **Never** use `this.page.waitForTimeout(N)` as a fix — that's a band-aid, not a solution. The audit may allow it as a warning, but it's the wrong approach
- Raise specific element timeouts rather than blanket increasing the default
- Prefer waiting for the next meaningful element over waiting for "the page to settle"
- If flakiness persists after a correct fix, the failure is no longer LOW — reclassify and escalate
