---
name: heal-locator-drift
description: Use when a test fails because an element locator no longer matches the DOM. The Healer uses this pattern to propose a targeted fix.
---

# Healing pattern: locator drift

## When to apply

Failure signatures:
- `TimeoutError: locator.click: Locator did not match …`
- `Element not found for selector …`
- `Waiting for locator("…") failed: <timeout>`

Classification: LOW.

## The diagnostic sequence

1. Call `browser_snapshot` on the failing page to capture the live accessibility tree
2. Find the element that semantically matches the failing locator's description
3. Call `browser_generate_locator` on that element — get ranked strategies (testId > role+name > label > text > id > css)
4. Call `correction_memory_query` with the failure signature — if a prior fix for a similar drift exists, prefer its strategy
5. Propose the fix: update `@CSGetElement` in the page object with the new primary xpath + carry old value into `alternativeLocators` as a fallback

## Example fix (before → after)

Before — locator stopped matching:
```typescript
@CSGetElement({
    xpath: '//button[@id="signin-btn"]',
    description: 'Sign In submit button',
    selfHeal: true,
})
public signInButton!: CSWebElement;
```

Live snapshot reveals: element now has `data-testid="loginSubmit"` and role `button` with name `Sign in`. The old `id="signin-btn"` was removed.

After — fix preserves the old form as a fallback and uses testId-based xpath primary:
```typescript
@CSGetElement({
    xpath: '//button[@data-testid="loginSubmit"]',
    description: 'Sign In submit button',
    selfHeal: true,
    alternativeLocators: [
        'css:[data-testid="loginSubmit"]',
        'role:button|name:Sign in',
        'css:button#signin-btn',    // old form, kept as final fallback
    ],
})
public signInButton!: CSWebElement;
```

## Rules

- **xpath primary** — if the ranked strategy is role-based, wrap it: `//button[@data-testid="loginSubmit"]`
- **Preserve the old locator** in `alternativeLocators` as the last entry — helps if the change was partial / reverted
- **Audit before apply** — the proposed fix must pass `audit_file` (still xpath-primary, still selfHeal true on interactive elements)
- **Compile before re-run** — `compile_check` must remain clean
- **Cascade-check after re-run** — other scenarios using the same page object must still pass
- **Record on green** — call `correction_memory_record` with the signature + fix strategy once the final full-suite re-run is green
