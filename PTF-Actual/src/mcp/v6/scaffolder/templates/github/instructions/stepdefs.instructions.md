---
applyTo: "**/steps/**/*.ts"
---

# Step-definition rules

- Class decorated `@StepDefinitions`.
- Every step method decorated `@CSBDDStepDef('<gherkin phrase>')`.
- Step regex text must be UNIQUE across the entire project. Prefix generic
  verbs with the tab/screen (`user clicks Save on the Payments tab`, not
  `user clicks Save`).
- Method names must ALSO be unique across the project (avoid `clickSave` in
  two step-def files; use `paymentsTabClickSave`, `wireTabClickSave`).
- Steps are ONE-LINERS: exactly one delegation to a page-object method.
  ```typescript
  @CSBDDStepDef('user clicks Save on the Payments tab')
  async userClicksSaveOnPaymentsTab(): Promise<void> {
      await this.paymentsPage.clickSaveButton();
  }
  ```
- Element waits / xpath construction / polling loops MUST NOT be in step files.
  If you're tempted to write `while (Date.now() - start < timeout)` in a step,
  add a method to the page instead.
- No `page.evaluate` / `page.waitForTimeout` / `CSElementFactory.createByXPath`
  in step files. Zero exceptions.
- Never use `page.on('dialog', ...)` — use `this.basePage.acceptNextDialog()`
  before the click that triggers the dialog.
- Reuse existing step definitions — grep the repo before writing a new one.
