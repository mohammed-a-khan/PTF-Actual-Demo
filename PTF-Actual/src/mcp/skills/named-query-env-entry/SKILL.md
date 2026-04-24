---
name: named-query-env-entry
description: Use when adding a SQL query to the project's db-queries env file. Covers naming, parameterisation, and comment conventions.
---

# Pattern: named query in `<project>-db-queries.env`

## When to use

Every SQL query the test suite runs lives in this file. Helpers invoke them by name via `CSDBUtils.executeQuery(alias, queryName, params)`.

## File location

`config/<project>/common/<project>-db-queries.env`

## Example

```
# ----------------------------------------------------------------------------
# Users
# ----------------------------------------------------------------------------

DB_QUERY_USER_FIND_BY_ID=SELECT ID, NAME, EMAIL, ROLE FROM USERS WHERE ID = :1

DB_QUERY_USER_FIND_BY_EMAIL=SELECT ID, NAME, EMAIL, ROLE FROM USERS WHERE LOWER(EMAIL) = LOWER(:1)

DB_QUERY_USER_FIND_ACTIVE_BY_ROLE=SELECT ID, NAME, EMAIL, ROLE FROM USERS WHERE ROLE = :1 AND ACTIVE_FLAG = 'Y' AND ROWNUM <= 10

# ----------------------------------------------------------------------------
# Payments
# ----------------------------------------------------------------------------

DB_QUERY_PAYMENT_FIND_BY_STATUS=SELECT PAYMENT_ID, AMOUNT, STATUS FROM PAYMENTS WHERE STATUS = :1
```

## Rules

- Key format: `DB_QUERY_<ENTITY>_<VERB>_[<QUALIFIER>]` all UPPER_SNAKE_CASE
- Verb one of: `FIND_BY_<FIELD>`, `FIND_ALL_<QUALIFIER>`, `COUNT_BY_<FIELD>`, `INSERT`, `UPDATE_<FIELD>`, `DELETE_BY_<FIELD>`
- Bind parameters use `:1`, `:2`, `:3` (1-indexed) — never inline string values
- Each SQL must have been verified via `schema_lookup` against the project schema reference
- Never fabricate table names; if unverified, mark with `-- SCHEMA REFERENCE NEEDED` and escalate
- Group by entity with a comment header — makes the file browseable as it grows
- Never leave commented-out queries — delete instead
