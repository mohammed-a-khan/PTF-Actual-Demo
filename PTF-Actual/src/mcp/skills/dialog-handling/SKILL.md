---
name: dialog-handling
description: Use when a page object or step needs to interact with browser dialogs (alert, confirm, prompt). Always use CSBasePage's wrapper methods, never page.on('dialog'). Pairs with audit rule DG100.
---

# Pattern: dialog handling

## When to use

Any flow that triggers a JavaScript `alert()`, `confirm()`, or `prompt()` —
delete confirmations, save warnings, navigation-away prompts, custom JS
dialogs. The dialog wrappers live on `CSBasePage` itself; page objects
inherit them automatically.

## Working example

```typescript
import { CSBasePage, CSElement, CSGetElement, CSPage, CSReporter } from '@mdakhan.mak/cs-playwright-test-framework';

@CSPage('users-list')
export class UsersListPage extends CSBasePage {
    @CSGetElement({
        xpath: "//button[normalize-space()='Delete']",
        description: 'Delete user button',
        selfHeal: true,
    })
    private deleteButton!: CSElement;

    /** Single-shot accept: arms the handler for the next dialog only. */
    public async deleteAndConfirm(): Promise<void> {
        await this.acceptNextDialog();             // arm handler before action
        await this.deleteButton.clickWithTimeout(30000);
        CSReporter.info(`Deleted user; dialog accepted: ${this.getLastDialogMessage()}`);
    }

    /** Single-shot accept with text (prompts only). */
    public async deleteAndConfirmWithReason(reason: string): Promise<void> {
        await this.acceptNextDialogWithText(reason);
        await this.deleteButton.clickWithTimeout(30000);
    }

    /** Single-shot dismiss: cancels the next dialog. */
    public async cancelDelete(): Promise<void> {
        await this.dismissNextDialog();
        await this.deleteButton.clickWithTimeout(30000);
    }

    /** Always-on for entire scenario (call once in Background or Before-step). */
    public async armAlwaysAccept(): Promise<void> {
        await this.alwaysAcceptDialogs();
    }
}
```

## Available wrapper methods (all on CSBasePage)

| Method | Behavior |
|---|---|
| `acceptNextDialog()` | Arms once. Next dialog is accepted. |
| `dismissNextDialog()` | Arms once. Next dialog is dismissed. |
| `acceptNextDialogWithText(text)` | For `prompt()` dialogs — supplies text and accepts. |
| `alwaysAcceptDialogs()` | Persistent — every dialog this scenario sees is accepted. |
| `alwaysDismissDialogs()` | Persistent — every dialog dismissed. |
| `getLastDialogMessage()` | The text shown in the last dialog the page captured. |
| `getLastDialogType()` | `alert` / `confirm` / `prompt` |
| `resetDialogHandler()` | Clears single-shot and always-on handlers. Call in After hooks. |

## Forbidden patterns (audit rule DG100 fails the file)

```typescript
// ❌ NEVER — direct Playwright dialog API
this.page.on('dialog', async d => await d.accept());
this.page.on('dialog', async d => await d.dismiss());
await dialog.accept();
await dialog.dismiss();
```

These bypass the framework's dialog tracking, never populate
`getLastDialogMessage()`, leak listeners across scenarios, and fail
the pre-gate audit (`DG100: Direct page.on('dialog')`).

## Common gotchas

1. **Arm before the action.** `acceptNextDialog()` registers a handler;
   it doesn't itself trigger anything. Call it on the line above the
   click that produces the dialog.
2. **One dialog per arm.** `acceptNextDialog()` consumes itself after
   the next dialog. Call again before the next dialog-producing action.
3. **Always-on bleeds.** `alwaysAcceptDialogs()` persists for the rest
   of the scenario. Call `resetDialogHandler()` in your After step if
   later steps shouldn't auto-accept.
