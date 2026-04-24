---
name: legacy-example-jdbc-inline-sql
description: Reference — common legacy inline-SQL patterns in Java / C# so extract_db_calls can identify them and the agent can sanity-check the migration plan.
---

# Reference: common inline-SQL patterns in legacy code

Use when `extract_db_calls` returns a plan and the agent needs to verify that the extraction caught the right strings.

## Pattern 1 — raw JDBC with string concatenation

```java
String userId = row.get("userId");
String sql = "SELECT ID, NAME FROM USERS WHERE ID = " + userId;
PreparedStatement stmt = conn.prepareStatement(sql);
ResultSet rs = stmt.executeQuery();
```

`extract_db_calls` emits:
```
suggestedName: USERS_SELECT_01
parameterised: SELECT ID, NAME FROM USERS WHERE ID = :1
params: [userId]
returnShape: list   // SELECT without LIMIT 1 / ROWNUM <= 1
table: USERS
```

## Pattern 2 — PreparedStatement with `?` placeholders

```java
String sql = "UPDATE PAYMENTS SET STATUS = ? WHERE ID = ?";
PreparedStatement stmt = conn.prepareStatement(sql);
stmt.setString(1, newStatus);
stmt.setString(2, paymentId);
stmt.executeUpdate();
```

`extract_db_calls` emits:
```
suggestedName: PAYMENTS_UPDATE_01
parameterised: UPDATE PAYMENTS SET STATUS = :1 WHERE ID = :2
params: [newStatus, paymentId]
returnShape: void
table: PAYMENTS
```

## Pattern 3 — Hibernate HQL

```java
Query query = session.createQuery(
    "FROM User u WHERE u.role = :role AND u.active = true"
);
query.setParameter("role", "ACCOUNT_REP");
List<User> users = query.list();
```

Hibernate HQL is harder — `extract_db_calls` can identify the string but the migration plan notes "HQL, not SQL — map entity to table before registering as named query".

## Pattern 4 — Inline assertion against query result

```java
String sql = "SELECT COUNT(*) FROM USERS WHERE EMAIL = 'locked@example.com'";
int count = conn.createStatement().executeQuery(sql).getInt(1);
assertEquals(1, count);
```

`extract_db_calls` emits:
```
suggestedName: USERS_COUNT_BY_EMAIL
parameterised: SELECT COUNT(*) FROM USERS WHERE EMAIL = :1
params: ['locked@example.com']    // literal extracted
returnShape: single-row
table: USERS
```

## What the agent does with the plan

1. For each entry, call `schema_lookup` against the `table` field
2. If verified → add `DB_QUERY_<name>=<parameterised>` to `<project>-db-queries.env`
3. If unverified → emit `-- SCHEMA REFERENCE NEEDED` sentinel and escalate
4. Generate a typed helper method (via `db-helper-findby-id` / `db-helper-findall-matching` patterns)
5. Replace the original call site in the generated TS file with a helper invocation

## What to watch for

- Heredoc / multi-line SQL (`"""..."""` in Kotlin, verbatim strings in C#) — some may slip through regex extraction
- Dynamic SQL built via string manipulation — may need manual review and rewrite
- Stored procedure calls — treat as a separate migration pattern (named SP execution, not a SELECT)
