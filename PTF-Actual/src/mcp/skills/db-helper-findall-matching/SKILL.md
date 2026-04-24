---
name: db-helper-findall-matching
description: Use when authoring a database helper that returns a list of matching rows. Covers typed-array return, empty-array default, CSReporter logging.
---

# Pattern: DB helper — findAll (list)

## When to use

Any helper that returns zero-or-more rows for a given criterion — list of users with a role, list of active deals, list of payments in a status.

## Example

```typescript
import { CSDBUtils } from '@mdakhan.mak/cs-playwright-test-framework/database-utils';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';

export interface PaymentRow {
    paymentId: string;
    amount: number;
    status: string;
}

export class PaymentDatabaseHelper {
    private static readonly DB_ALIAS = 'my-project';

    public static async findPaymentsByStatus(status: string): Promise<PaymentRow[]> {
        const result = await CSDBUtils.executeQuery(
            this.DB_ALIAS,
            'PAYMENT_FIND_BY_STATUS',
            [status]
        );
        const rows = result.rows || [];
        CSReporter.info(`Found ${rows.length} payments with status=${status}`);
        return rows.map((r: any) => ({
            paymentId: r.payment_id ?? r.PAYMENT_ID,
            amount: Number(r.amount ?? r.AMOUNT),
            status: r.status ?? r.STATUS,
        }));
    }
}
```

Matching entry in `<project>-db-queries.env`:

```
DB_QUERY_PAYMENT_FIND_BY_STATUS=SELECT PAYMENT_ID, AMOUNT, STATUS FROM PAYMENTS WHERE STATUS = :1
```

## Rules

- Return `Promise<RowType[]>` — never `Promise<any[]>`
- Empty result → return `[]`, not `null`
- Always `CSReporter.info(...)` the count — surfaces in reports
- Map every row through explicit field extraction (case-tolerant: `r.col ?? r.COL`)
- Method is static; no constructor needed
