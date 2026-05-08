---
name: db-state-assertion
description: Use when a step verifies backend database state — count, single value, row contents — after a UI action. Always use CSDBUtils with named queries. Never import a DB driver directly. Pairs with audit rule DB200.
---

# Pattern: database state assertion

## When to use

The scenario clicks "Submit", "Save", "Approve" — and the test must
verify the right rows landed in the database with the right column
values. UI-only assertions miss data-layer bugs (rounding, truncation,
charset issues, soft-delete behaviour). The framework's `CSDBUtils`
gives a consistent API across MSSQL / Postgres / MySQL / Oracle /
MongoDB / Redis with named queries stored in the env file.

## Working example — count + single-value + single-row

```typescript
import {
    CSBDDStepDef, CSReporter, StepDefinitions, Page,
} from '@mdakhan.mak/cs-playwright-test-framework';
import { CSDBUtils } from '@mdakhan.mak/cs-playwright-test-framework/database-utils';

@StepDefinitions
export class OrderDbSteps {
    @CSBDDStepDef('the database has {int} order(s) for customer {string}')
    async assertOrderCount(expected: number, customerId: string): Promise<void> {
        const actual = await CSDBUtils.count('APP_DB',
            'SELECT COUNT(*) FROM orders WHERE customer_id = :id',
            { id: customerId },
        );
        if (actual !== expected) {
            CSReporter.fail(`Order count for ${customerId}: expected ${expected}, got ${actual}`);
            throw new Error(`Order count mismatch`);
        }
        CSReporter.pass(`Order count for ${customerId}: ${actual}`);
    }

    @CSBDDStepDef('the order {string} has total {string}')
    async assertOrderTotal(orderId: string, expectedTotal: string): Promise<void> {
        const total = await CSDBUtils.executeSingleValue<string>('APP_DB',
            'SELECT total FROM orders WHERE id = :id',
            { id: orderId },
        );
        if (String(total) !== expectedTotal) {
            CSReporter.fail(`Order ${orderId} total: expected ${expectedTotal}, got ${total}`);
            throw new Error(`Total mismatch`);
        }
        CSReporter.pass(`Order ${orderId} total = ${total}`);
    }

    @CSBDDStepDef('the order {string} record matches')
    async assertOrderRow(orderId: string): Promise<void> {
        const row = await CSDBUtils.executeSingleRowOrNull('APP_DB',
            'SELECT id, status, customer_id, total FROM orders WHERE id = :id',
            { id: orderId },
        );
        if (!row) {
            CSReporter.fail(`No order found with id=${orderId}`);
            throw new Error('Order missing');
        }
        // case-tolerant access: works with mssql (lowercase), Oracle (uppercase), pg (preserved)
        const status = (row.status ?? row.STATUS) as string;
        if (status !== 'COMPLETED') {
            CSReporter.fail(`Order ${orderId} status is ${status}, expected COMPLETED`);
            throw new Error('Status not COMPLETED');
        }
        CSReporter.pass(`Order ${orderId} fully verified`);
    }
}
```

## Named queries — the preferred shape

Don't inline SQL strings in test code. Store them in the env file
under the `DB_QUERY_<KEY>` prefix and reference by key:

**`config/myproject/environments/dev.env`:**
```
APP_DB_HOST=db.example.com
APP_DB_USER=app
APP_DB_PASSWORD=ENCRYPTED:base64encryptedvalue
APP_DB_NAME=APPDB

DB_QUERY_GET_ORDER_BY_ID=SELECT id, status, customer_id, total FROM orders WHERE id = :id
DB_QUERY_COUNT_ORDERS_FOR_CUSTOMER=SELECT COUNT(*) FROM orders WHERE customer_id = :id
DB_QUERY_DELETE_TEST_ORDERS=DELETE FROM orders WHERE customer_id LIKE 'TEST-%'
```

**Step file:**
```typescript
const order = await CSDBUtils.executeNamedQuery('APP_DB', 'GET_ORDER_BY_ID', { id: orderId });
const count = await CSDBUtils.count('APP_DB',
    await CSDBUtils.resolveNamedQuery('COUNT_ORDERS_FOR_CUSTOMER'),
    { id: customerId },
);
```

Or load from a SQL file directly:

```typescript
const rows = await CSDBUtils.executeFromFile(
    'APP_DB',
    'sql/orders/active-since.sql',
    { since: '2026-01-01' },
);
```

## CSDBUtils cheat sheet

| Need | Call |
|---|---|
| Run any SQL with params | `CSDBUtils.executeQuery(alias, sql, params?)` |
| Named query by key | `CSDBUtils.executeNamedQuery(alias, 'QUERY_KEY', params?)` |
| First-column-first-row scalar | `CSDBUtils.executeSingleValue<T>(alias, sql, params)` |
| First row | `CSDBUtils.executeSingleRow(alias, sql, params)` |
| First row or null (no throw) | `CSDBUtils.executeSingleRowOrNull(alias, sql, params)` |
| COUNT(*) returning number | `CSDBUtils.count(alias, sql, params)` |
| Row exists (boolean) | `CSDBUtils.exists(alias, sql, params)` |
| One column as array | `CSDBUtils.extractColumn<T>(alias, sql, 'colName', params)` |
| key→value Map | `CSDBUtils.getMap<K,V>(alias, sql, 'keyCol', 'valCol', params)` |
| INSERT/UPDATE/DELETE → affected rows | `CSDBUtils.executeUpdate(alias, sql, params)` |
| Multi-statement transaction | `CSDBUtils.executeTransaction(alias, [{sql, params}, ...])` |
| Stored proc | `CSDBUtils.executeStoredProcedure(alias, 'sp_name', params)` |
| Pagination | `CSDBUtils.executePaginated(alias, sql, page, pageSize, params)` |
| Read SQL from file | `CSDBUtils.executeFromFile(alias, path, params)` |
| Cleanup | `CSDBUtils.closeAllConnections()` (call in After hook for long runs) |

## Forbidden patterns (audit rule DB200 fails the file)

```typescript
// ❌ NEVER
import * as mssql from 'mssql';
import { Client } from 'pg';
import mysql from 'mysql2';
import oracledb from 'oracledb';
import { MongoClient } from 'mongodb';
const sql = require('mssql');
```

These bypass the framework's connection pool, named-query resolution,
case-tolerant column access, and per-test connection lifecycle. Audit
`DB200` fails the file.

## Common gotchas

1. **Case-tolerant column access.** Different drivers return columns
   in different cases — Oracle uppercases, MSSQL lowercases, Postgres
   preserves. Always use `r.col ?? r.COL` for portability.
2. **Parameterise — never concatenate.** Always use `:name` /
   `@name` / `?` placeholders with the params object. String-concat
   SQL is a SQL-injection vector and fails the framework's safety
   gate.
3. **Connection alias** is the env-key prefix. `APP_DB` resolves to
   `APP_DB_HOST`, `APP_DB_USER`, `APP_DB_PASSWORD`, `APP_DB_NAME`.
4. **Cleanup test data.** Tests that INSERT need a corresponding
   DELETE — use the mutation-cleanup pattern in After hooks. Otherwise
   the test fails on second run because the row already exists.
