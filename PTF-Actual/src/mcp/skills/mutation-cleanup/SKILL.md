---
name: mutation-cleanup
description: Use when a scenario CREATES or MODIFIES backend data — new user, new payment, status change, file upload. Without cleanup the test fails on second run because the data already exists. Pattern: unique IDs + After-step DB cleanup.
---

# Pattern: mutation cleanup

## When to use

The scenario isn't read-only. It clicks "Create user", "Submit payment",
"Approve", "Upload" — actions that write to the backend. Two problems
to solve:

1. **Idempotency:** the test must work on its first run AND every
   subsequent run. If the first run created `user-001`, the second
   run must either delete `user-001` first or use a different ID.
2. **Test isolation:** parallel scenarios must not collide. Two
   workers creating "user-001" simultaneously will race.

## Strategy 1 — Unique IDs via timestamp (simplest)

Append a unique suffix to every test-generated identifier. Use
`CSDateTimeUtility.timestamp()` for ms precision, optionally with a
random suffix for parallel safety.

```typescript
import { CSDateTimeUtility, CSStringUtility } from '@mdakhan.mak/cs-playwright-test-framework/utilities';

const uniqueSuffix = `${CSDateTimeUtility.timestamp()}-${CSStringUtility.random(4)}`;
const newUserId = `TEST-${uniqueSuffix}`;
const newOrderRef = `ORD-${uniqueSuffix}`;
```

This is the lightest pattern — no cleanup needed, every run gets a
fresh ID. Downside: rows accumulate in the test DB over time.
Schedule a periodic sweep (Strategy 3 below) to clear them.

## Strategy 2 — After-step cleanup with @CSAfter hook

For scenarios that need a specific ID (e.g., the legacy data file
hardcodes `TEST-USER-1`), clean up in an After hook so the next run
starts fresh.

```typescript
import {
    CSBDDStepDef, CSReporter, StepDefinitions, Page,
    CSAfter,
} from '@mdakhan.mak/cs-playwright-test-framework';
import { CSDBUtils } from '@mdakhan.mak/cs-playwright-test-framework/database-utils';
import { CSDateTimeUtility } from '@mdakhan.mak/cs-playwright-test-framework/utilities';

@StepDefinitions
export class UserCreateSteps {
    @CSBDDStepDef('I create a user with id {string}')
    async createUser(userId: string): Promise<void> {
        await this.userCreatePage.fillUserId(userId);
        await this.userCreatePage.submit();
    }

    @CSAfter()
    async cleanupCreatedUsers(): Promise<void> {
        // Delete every TEST- prefixed user this scenario might have made.
        // Idempotent — DELETE never fails if no rows match.
        const affected = await CSDBUtils.executeUpdate('APP_DB',
            "DELETE FROM users WHERE userid LIKE 'TEST-%' AND created_at >= :since",
            { since: CSDateTimeUtility.toISO(CSDateTimeUtility.startOfDay(CSDateTimeUtility.now())) },
        );
        CSReporter.info(`Cleanup deleted ${affected} test user(s)`);
    }
}
```

## Strategy 3 — Periodic sweep (out-of-band)

For data that's hard to attribute to a specific scenario (e.g.,
ID generated server-side, no naming convention), schedule a daily
job that deletes all "TEST-*" rows older than 24 hours. Out of scope
for individual scenarios but document it in the project README so
the team knows it exists.

## Strategy 4 — Capture and undo via context

For complex flows where create-and-rollback is the cleanest pattern:

```typescript
import {
    CSBDDStepDef, StepDefinitions, CSAfter, CSBDDContext,
    CSReporter,
} from '@mdakhan.mak/cs-playwright-test-framework';
import { CSDBUtils } from '@mdakhan.mak/cs-playwright-test-framework/database-utils';

@StepDefinitions
export class OrderSteps {
    @CSBDDStepDef('I create an order')
    async createOrder(): Promise<void> {
        const orderId = await this.orderCreatePage.submit();
        // Stash the ID in scenario context for the After hook to delete.
        CSBDDContext.getInstance().set('createdOrderId', orderId);
        CSReporter.info(`Created order ${orderId}`);
    }

    @CSAfter()
    async undoCreatedOrder(): Promise<void> {
        const orderId = CSBDDContext.getInstance().get<string>('createdOrderId');
        if (!orderId) return;  // scenario didn't create one — nothing to undo
        await CSDBUtils.executeUpdate('APP_DB',
            'DELETE FROM orders WHERE id = :id', { id: orderId });
        CSReporter.info(`Cleaned up created order ${orderId}`);
    }
}
```

## Decision flowchart

```
Does the scenario CREATE backend data?
├─ No (read-only) → no cleanup needed
└─ Yes
   ├─ Can the ID be made unique per run?
   │  └─ Yes → Strategy 1 (timestamp suffix). Plus Strategy 3 sweep.
   └─ No (must reuse fixed ID) → Strategy 2 (After-hook DELETE).
   
Multi-step mutation (create → modify → delete)?
└─ Yes → Strategy 4 (capture state in CSBDDContext + targeted undo).
```

## Common gotchas

1. **DELETE in After hook is best-effort.** If the After hook itself
   fails, the data leaks. Keep the DELETE simple — single SQL,
   parameterised, no joins. Catch and log errors but don't re-throw.
2. **`@CSAfter` runs even on scenario failure** — that's the point.
   Test failed mid-create? The cleanup still runs.
3. **Soft-delete columns** — if the schema uses `deleted_at IS NOT
   NULL` semantics, a hard `DELETE` may not be what you want. Check
   the schema; use `UPDATE ... SET deleted_at = NOW()` instead if
   appropriate.
4. **Foreign keys** — deleting a user cascades to orders, etc. Either
   delete in the right order or rely on `ON DELETE CASCADE`. Check
   the schema before assuming.
5. **Don't cleanup global fixture data.** If a row is shared by
   multiple scenarios (or pre-loaded by a setup script), don't
   delete it in After. Only clean what THIS scenario created.
