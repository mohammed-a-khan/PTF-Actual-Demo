---
name: db-helper-findby-id
description: Use when authoring a database helper method that reads a single row by id. Covers CSDBUtils.executeQuery, named-query reference, typed return, case-tolerant row access.
---

# Pattern: DB helper — findByX (single row)

## When to use

Any scenario preamble that needs to resolve a row from the test database before driving the UI. Common: "Given an active deal exists", "Given user with role X exists", "Given a payment in status Y exists".

## Example

```typescript
import { CSDBUtils } from '@mdakhan.mak/cs-playwright-test-framework/database-utils';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';

export interface UserRow {
    id: string;
    name: string;
    email: string;
    role: string;
}

export class UserDatabaseHelper {
    private static readonly DB_ALIAS = 'my-project';

    public static async findUserById(id: string): Promise<UserRow | null> {
        const result = await CSDBUtils.executeQuery(
            this.DB_ALIAS,
            'USER_FIND_BY_ID',
            [id]
        );
        const rows = result.rows || [];
        if (rows.length === 0) {
            CSReporter.info(`No user found for id=${id}`);
            return null;
        }
        const r = rows[0] as any;
        return {
            id: r.id ?? r.ID,
            name: r.name ?? r.NAME,
            email: r.email ?? r.EMAIL,
            role: r.role ?? r.ROLE,
        };
    }

    public static async findUserByEmail(email: string): Promise<UserRow | null> {
        const result = await CSDBUtils.executeQuery(
            this.DB_ALIAS,
            'USER_FIND_BY_EMAIL',
            [email]
        );
        const rows = result.rows || [];
        if (rows.length === 0) return null;
        const r = rows[0] as any;
        return {
            id: r.id ?? r.ID,
            name: r.name ?? r.NAME,
            email: r.email ?? r.EMAIL,
            role: r.role ?? r.ROLE,
        };
    }
}
```

And the matching entry in `config/my-project/common/my-project-db-queries.env`:

```
DB_QUERY_USER_FIND_BY_ID=SELECT ID, NAME, EMAIL, ROLE FROM USERS WHERE ID = :1
DB_QUERY_USER_FIND_BY_EMAIL=SELECT ID, NAME, EMAIL, ROLE FROM USERS WHERE EMAIL = :1
```

## Rules

- All helper methods are **`static`** — never instantiate the class
- Return a typed interface — `Promise<UserRow | null>`, never `Promise<any>`
- Null for single-row miss; empty array for list miss — never throw on empty
- Case-tolerant column access: `r.col ?? r.COL` for every field (Oracle/SQL Server drivers differ)
- The `DB_ALIAS` constant is the alias key from the pipeline config
- Query name is a **key** into the `<project>-db-queries.env` file — never inline SQL in the helper
- `CSReporter.info(...)` for empty-result logging (no fail, just note)
- Imports exclusively from `@mdakhan.mak/cs-playwright-test-framework/*`
- No raw `console.log`, no `any` return types, no string-concat SQL
