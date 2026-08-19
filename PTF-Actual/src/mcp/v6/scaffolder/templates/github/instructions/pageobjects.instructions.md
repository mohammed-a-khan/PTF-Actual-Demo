---
applyTo: "**/pages/**/*.ts"
---

# Page-object rules

- Class extends `CSBasePage`.
- Decorated `@CSPage('<slug>')` — the slug is the URL fragment or logical name.
  Slug, NOT class name. Getting this wrong emits a silent WARN at load time.
- Class name matches filename (`WireMatchProcessPage.ts` → `class WireMatchProcessPage`).
- Watch trailing `Page` / `Helper` in the filename; the class must match exactly.
- Elements declared with `@CSGetElement({xpath: '...', description: '...',
  selfHeal: true, alternativeLocators: [...]})` — never raw `page.locator`.
- Locator priority: data-testid > id > name > aria-label > placeholder > text.
- Element waits (`waitForVisible`, `expect.poll`, `while (Date.now() - start < timeout)`)
  MUST live on the page as methods — never in step files.
- Public methods use `clickWithTimeout(ms)`, `fillWithTimeout(value, ms)`,
  `selectOptionByLabel(label)`, `evaluate(fn)`, etc. from the framework
  wrappers. Never call the underlying Playwright method directly.
- `protected initializeElements(): void {}` must be declared even if empty
  (the framework requires the hook exists).
- No JSDoc. No block comments describing what the code does. Names are the doc.
- One class per file. No default exports unless a helper file.
