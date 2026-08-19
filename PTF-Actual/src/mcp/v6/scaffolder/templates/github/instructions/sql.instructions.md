---
applyTo: "**/*.sql"
---

# SQL rules

- READ-ONLY. Only `SELECT` and `WITH` (CTE) statements are allowed. Any
  `INSERT` / `UPDATE` / `DELETE` / `CREATE` / `DROP` / `ALTER` / `TRUNCATE`
  / `GRANT` / `MERGE` is a policy violation.
- SQL used by tests lives in named queries under
  `config/{project}/common/{project}-db-queries.env`. Never inline in TS.
- Query names use kebab-case: `db-query-cdo-get-facility-transaction-by-id`.
- Column names use UPPERCASE aliases (`AS FACILITY_TRANS_ID`) to match ADO
  test-plan step conventions.
- Verify column existence in the app source's hbm mapping or JDBC layer BEFORE
  writing the SQL — derived getters are NOT columns.
- SQL must match the real schema. Never invent table names or column prefixes.
