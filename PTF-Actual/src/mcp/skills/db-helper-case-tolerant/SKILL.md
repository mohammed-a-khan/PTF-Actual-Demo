---
name: db-helper-case-tolerant
description: Use for every DB helper — case-tolerant column access, because Oracle and SQL Server drivers disagree on column-name case.
---

# Pattern: case-tolerant column access in DB helpers

## When to use

Every time you read a value from a DB result row, regardless of which database. Same pattern for single-row helpers, list helpers, count helpers.

## The rule

**Always** access via `r.<lowerCase> ?? r.<UPPER_CASE>`. Never write just `r.user_id` or just `r.USER_ID`.

## Why

- Oracle JDBC returns column names in UPPER_CASE by default
- Microsoft SQL Server and PostgreSQL drivers can return either case depending on driver config
- Framework test runs may switch databases; code that assumes one case breaks on the other
- The `??` nullish coalesce is free — one undefined access, no performance cost

## Example

```typescript
return {
    id: r.id ?? r.ID,                       // ✓ tolerant
    userName: r.user_name ?? r.USER_NAME,   // ✓ tolerant
    lastLoginAt: r.last_login_at ?? r.LAST_LOGIN_AT,
    status: r.status ?? r.STATUS,
};
```

NOT:

```typescript
return {
    id: r.ID,                // ✗ fails on lower-case driver
    userName: r.user_name,   // ✗ fails on Oracle upper-case
};
```

## Rules

- Every mapped field uses `r.col ?? r.COL`
- Number / boolean / date columns may still need conversion after the access (`Number(...)`, `Boolean(...)`, `new Date(...)`)
- If a column is legitimately case-mixed in source (rare), include both variants: `r.firstName ?? r.first_name ?? r.FIRST_NAME`
