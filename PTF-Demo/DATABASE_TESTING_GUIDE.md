# Database Testing Framework - Complete Guide

## Overview
This guide covers ALL database testing capabilities provided by the **cs-playwright-test-framework** (version 1.0.0+). The framework supports Oracle, MySQL, PostgreSQL, SQL Server, MongoDB, and Redis databases with comprehensive step definitions for BDD-style testing.

---

## Table of Contents
1. [Configuration](#configuration)
2. [Connection Management](#connection-management)
3. [Query Execution](#query-execution)
4. [Data Validation](#data-validation)
5. [Transaction Management](#transaction-management)
6. [Stored Procedures & Functions](#stored-procedures--functions)
7. [Utility Functions](#utility-functions)
8. [Variable Interpolation](#variable-interpolation)
9. [Complete Step Reference](#complete-step-reference)
10. [Example Scenarios](#example-scenarios)

---

## Configuration

### Database Configuration in `config/global.env`

The framework uses an **alias-based multi-database system**. Each database is configured using `DB_{ALIAS}_*` properties:

```properties
# Enable database features
DB_ENABLED=true

# List of database aliases to connect at startup
DATABASE_CONNECTIONS=PRACTICE_MYSQL,PRACTICE_ORACLE

# MySQL Configuration (PRACTICE_MYSQL alias)
DB_PRACTICE_MYSQL_TYPE=mysql
DB_PRACTICE_MYSQL_HOST=localhost
DB_PRACTICE_MYSQL_PORT=3306
DB_PRACTICE_MYSQL_USERNAME=dbuser
DB_PRACTICE_MYSQL_PASSWORD=SecurePassword123!
DB_PRACTICE_MYSQL_DATABASE=corporate_db
DB_PRACTICE_MYSQL_CONNECTION_TIMEOUT=60000
DB_PRACTICE_MYSQL_REQUEST_TIMEOUT=15000
DB_PRACTICE_MYSQL_POOL_MAX=5
DB_PRACTICE_MYSQL_POOL_MIN=0
DB_PRACTICE_MYSQL_POOL_IDLE_TIMEOUT=30000

# Oracle Configuration (PRACTICE_ORACLE alias)
DB_PRACTICE_ORACLE_TYPE=oracle
DB_PRACTICE_ORACLE_HOST=localhost
DB_PRACTICE_ORACLE_PORT=1521
DB_PRACTICE_ORACLE_USERNAME=testuser
DB_PRACTICE_ORACLE_PASSWORD=ENCRYPTED:eyJlbmNyeXB0ZWQiOi...
DB_PRACTICE_ORACLE_DATABASE=XEPDB1
DB_PRACTICE_ORACLE_CONNECTION_TIMEOUT=60000
DB_PRACTICE_ORACLE_REQUEST_TIMEOUT=15000
DB_PRACTICE_ORACLE_POOL_MAX=3
DB_PRACTICE_ORACLE_POOL_MIN=0
DB_PRACTICE_ORACLE_POOL_IDLE_TIMEOUT=30000
```

### Supported Database Types
- `mysql` - MySQL/MariaDB
- `postgresql` - PostgreSQL
- `oracle` - Oracle Database
- `sqlserver` / `mssql` - Microsoft SQL Server
- `mongodb` - MongoDB
- `redis` - Redis

---

## Connection Management

### 1. Basic Connection
```gherkin
When user connects to "PRACTICE_ORACLE" database
Then user validates database connection
```

### 2. Connection with Timeout
```gherkin
When user connects to "PRACTICE_MYSQL" database with timeout 30 seconds
```

### 3. Set Connection Pool Size
```gherkin
When user sets database connection pool size to 10
```

### 4. Multi-Database Connections
```gherkin
When user connects to "PRACTICE_ORACLE" database
And user connects to "PRACTICE_MYSQL" database
# Switch between databases
When user switches to database "PRACTICE_ORACLE"
When user switches to database "PRACTICE_MYSQL"
```

### 5. Connection String-Based
```gherkin
When user connects with connection string "mysql://user:pass@localhost:3306/dbname"
```

### 6. Connection with Options
```gherkin
When user connects to database with options:
  | type     | mysql     |
  | host     | localhost |
  | port     | 3306      |
  | username | root      |
  | password | password  |
  | database | testdb    |
```

### 7. Disconnect Operations
```gherkin
When user disconnects from "PRACTICE_MYSQL" database
When user disconnects from database
When user disconnects from all databases
```

### 8. Connection Validation
```gherkin
Then user verifies database connection
Then user validates database connection
```

---

## Query Execution

### 1. Basic Query Execution
```gherkin
When user executes query "SELECT * FROM employees"
Then the query result should have 10 rows
```

### 2. Execute and Store Result
```gherkin
When user executes query "SELECT * FROM employees WHERE dept_id = 10" and stores result as "IT_EMPLOYEES"
```

### 3. Parameterized Query
```gherkin
When user executes parameterized query "SELECT * FROM employees WHERE salary > ? AND dept_id = ?" with parameters:
  | 50000 |
  | 10    |
```

### 4. Scalar Query (Single Value)
```gherkin
When user executes scalar query "SELECT MAX(salary) FROM employees"
Then the scalar result should be "95000"
```

### 5. Count Query
```gherkin
When user executes count query "SELECT COUNT(*) FROM employees"
Then the scalar result should be "100"
```

### 6. Query with Limit
```gherkin
When user executes query "SELECT * FROM employees" with limit 10
Then the query result should have 10 rows
```

### 7. Query with Timeout
```gherkin
When user executes query "SELECT * FROM large_table" with timeout 60 seconds
```

### 8. Query and Fetch First Row
```gherkin
When user executes query "SELECT * FROM employees ORDER BY salary DESC" and fetches first row
Then the value in row 1 column "salary" should be "95000"
```

### 9. Batch Queries
```gherkin
When user executes batch queries:
  """
  SELECT COUNT(*) FROM employees;
  SELECT COUNT(*) FROM departments;
  SELECT COUNT(*) FROM projects
  """
```

### 10. Query from File
```gherkin
When user executes query from file "queries/get_employees.sql"
```

### 11. Predefined Query (from config)
```gherkin
# In config: DB_QUERY_GET_ALL_EMPLOYEES=SELECT * FROM employees
When user executes predefined query "GET_ALL_EMPLOYEES"
```

### 12. Invalid Query (Error Testing)
```gherkin
When user executes invalid query "SELECT * FROM non_existent_table"
```

### 13. Query Profiling
```gherkin
When user profiles query "SELECT * FROM employees e JOIN departments d ON e.dept_id = d.dept_id"
Then user logs query execution plan
```

### 14. Cancel Running Query
```gherkin
When user cancels running query
```

---

## Data Validation

### 1. Row Count Validation
```gherkin
Then the query result should have 10 rows
Then the query result should have at least 5 rows
Then the query result should have at most 20 rows
Then the query result should be empty
Then the query result should have 0 rows
```

### 2. Cell Value Validation
```gherkin
# Exact match
Then the value in row 1 column "first_name" should be "John"

# Contains
Then the value in row 1 column "email" should contain "@company.com"

# Pattern match (regex)
Then the value in row 1 column "email" should match pattern "^[a-z]+@company\\.com$"

# Null checks
Then the value in row 1 column "middle_name" should be null
Then the value in row 1 column "first_name" should not be null
```

### 3. Column-Level Validation
```gherkin
# All values match
Then all values in column "department_id" should be "10"

# Column contains specific value
Then column "status" should contain value "Active"
Then column "status" should not contain value "Deleted"

# Uniqueness
Then all values in column "employee_id" should be unique
```

### 4. Aggregate Validations
```gherkin
# Sum
Then the sum of column "salary" should be 500000

# Average
Then the average of column "salary" should be 50000

# Min/Max
Then the minimum value in column "salary" should be "30000"
Then the maximum value in column "salary" should be "95000"
```

### 5. Range Validation
```gherkin
Then values in column "salary" should be between "30000" and "100000"
Then values in column "hire_date" should be between "2020-01-01" and "2025-12-31"
```

### 6. Data Type Validation
```gherkin
Then column "salary" should have data type "number"
Then column "first_name" should have data type "string"
Then column "hire_date" should have data type "date"
```

### 7. Result Structure Validation
```gherkin
# Validate columns exist
Then the result should have columns:
  | employee_id |
  | first_name  |
  | last_name   |
  | email       |
  | salary      |

# Validate complete result data
Then the result should match:
  | employee_id | first_name | last_name | salary |
  | 101         | John       | Doe       | 75000  |
  | 102         | Jane       | Smith     | 82000  |
```

### 8. Scalar Result Validation
```gherkin
Then the scalar result should be "42"
Then the scalar result should be "Active"
```

---

## Transaction Management

### 1. Basic Transaction
```gherkin
When user begins database transaction
Then database should have active transaction

# Execute queries within transaction
When user executes query "INSERT INTO ..." within transaction
When user executes query "UPDATE ..." within transaction

# Commit or rollback
When user commits database transaction
When user rolls back database transaction

Then database should not have active transaction
```

### 2. Transaction with Isolation Level
```gherkin
When user begins database transaction with isolation level "READ COMMITTED"
# Other levels: READ_UNCOMMITTED, REPEATABLE_READ, SERIALIZABLE
```

### 3. Savepoints
```gherkin
When user begins database transaction

When user creates savepoint "checkpoint1"
# Do some work
When user creates savepoint "checkpoint2"
# Do more work

# Rollback to specific savepoint
When user rolls back to savepoint "checkpoint1"

# Release savepoint
When user releases savepoint "checkpoint1"

When user commits database transaction
```

### 4. Transaction Timeout
```gherkin
When user begins database transaction
And user sets transaction timeout to 30 seconds
```

---

## Stored Procedures & Functions

### 1. Execute Stored Procedure
```gherkin
When user executes stored procedure "sp_GetEmployees"
```

### 2. Execute Stored Procedure with Parameters
```gherkin
When user executes stored procedure "sp_GetEmployeesByDept" with parameters:
  | department_id | 10     |
  | status        | Active |
```

### 3. Execute Function and Store Result
```gherkin
When user calls function "fn_GetEmployeeCount" and stores result as "emp_count"
```

### 4. Validate Output Parameters
```gherkin
Then the output parameter "total_count" should be "100"
Then the output parameter "status_code" should be "0"
```

### 5. Validate Return Value
```gherkin
Then the return value should be "SUCCESS"
Then the return value should be "0"
```

---

## Utility Functions

### 1. Query Logging
```gherkin
When user enables database query logging
When user disables database query logging
When user logs database query result
```

### 2. Cache Management
```gherkin
When user clears database cache
```

### 3. Export Query Results
```gherkin
When user exports query result to "output/employees.csv"
When user exports query result to "output/employees.json"
When user exports query result to "output/employees.xml"

# Custom delimiter for CSV
When user exports query result as CSV with delimiter "|"
```

### 4. Database Statistics
```gherkin
When user logs database statistics
```

### 5. Execution Plan
```gherkin
When user logs query execution plan
```

---

## Variable Interpolation

The framework supports **three types of variable interpolation**:

### 1. Environment Variables (`${VAR}`)
```gherkin
When user executes query "SELECT * FROM ${TABLE_NAME}"
```

### 2. Configuration Variables (`%VAR%`)
```gherkin
When user executes query "SELECT * FROM employees WHERE dept = %DEPARTMENT_ID%"
```

### 3. Context Variables (`{{var}}`)
```gherkin
When user executes query "SELECT * FROM employees WHERE id = {{employee_id}}"
```

### Example Usage
```gherkin
# Store value in context
When user executes query "SELECT MAX(id) AS max_id FROM employees"
# Framework auto-stores in context

# Use in next query
When user executes query "SELECT * FROM employees WHERE id = {{max_id}}"
```

---

## Complete Step Reference

### Connection Steps
```gherkin
When user connects to {string} database
When user connects to {string} database with timeout {int} seconds
When user connects with connection string {string}
When user connects to database with options:
When user switches to database {string}
When user disconnects from database
When user disconnects from {string} database
When user disconnects from all databases
Then user verifies database connection
Then user validates database connection
When user sets database timeout to {int} seconds
When user sets database connection pool size to {int}
```

### Query Execution Steps
```gherkin
When user executes query {string}
When user executes query {string} and stores result as {string}
When user executes query from file {string}
When user executes parameterized query {string} with parameters:
When user executes predefined query {string}
When user executes batch queries:
When user executes query {string} with timeout {int} seconds
When user executes invalid query {string}
When user executes scalar query {string}
When user executes count query {string}
When user executes query {string} and fetches first row
When user executes query {string} with limit {int}
When user profiles query {string}
When user cancels running query
```

### Validation Steps
```gherkin
Then the query result should have {int} rows
Then the query result should have at least {int} rows
Then the query result should have at most {int} rows
Then the query result should be empty
Then the value in row {int} column {string} should be {string}
Then the value in row {int} column {string} should contain {string}
Then the value in row {int} column {string} should match pattern {string}
Then the value in row {int} column {string} should be null
Then the value in row {int} column {string} should not be null
Then all values in column {string} should be unique
Then all values in column {string} should be {string}
Then column {string} should contain value {string}
Then column {string} should not contain value {string}
Then the sum of column {string} should be {float}
Then the average of column {string} should be {float}
Then the minimum value in column {string} should be {string}
Then the maximum value in column {string} should be {string}
Then column {string} should have data type {string}
Then values in column {string} should be between {string} and {string}
Then the result should have columns:
Then the result should match:
Then the scalar result should be {string}
```

### Transaction Steps
```gherkin
When user begins database transaction
When user begins database transaction with isolation level {string}
When user commits database transaction
When user rolls back database transaction
When user creates savepoint {string}
When user rolls back to savepoint {string}
When user releases savepoint {string}
Then database should have active transaction
Then database should not have active transaction
When user executes query {string} within transaction
When user sets transaction timeout to {int} seconds
```

### Stored Procedure Steps
```gherkin
When user executes stored procedure {string}
When user executes stored procedure {string} with parameters:
When user calls function {string} and stores result as {string}
Then the output parameter {string} should be {string}
Then the return value should be {string}
```

### Utility Steps
```gherkin
When user enables database query logging
When user disables database query logging
When user logs database query result
When user clears database cache
When user exports query result to {string}
When user exports query result as CSV with delimiter {string}
When user logs query execution plan
When user logs database statistics
```

### Framework Steps
```gherkin
Given test execution starts for database testing
Then we should have database testing capability
```

---

## Example Scenarios

### Example 1: Basic Query and Validation
```gherkin
@database @mysql
Scenario: Verify Employee Count
  When user connects to "PRACTICE_MYSQL" database
  And user executes query "SELECT COUNT(*) AS emp_count FROM employees"
  Then the query result should have 1 rows
  And the value in row 1 column "emp_count" should be "45"
  When user disconnects from "PRACTICE_MYSQL" database
```

### Example 2: Transaction with Rollback
```gherkin
@database @transaction
Scenario: Update Salary with Rollback
  When user connects to "PRACTICE_MYSQL" database
  And user begins database transaction

  # Update salary
  When user executes query "UPDATE employees SET salary = 100000 WHERE id = 1" within transaction

  # Verify update
  When user executes query "SELECT salary FROM employees WHERE id = 1" within transaction
  Then the value in row 1 column "salary" should be "100000"

  # Rollback
  When user rolls back database transaction

  # Verify rollback
  When user executes query "SELECT salary FROM employees WHERE id = 1"
  Then the value in row 1 column "salary" should be "75000"

  When user disconnects from "PRACTICE_MYSQL" database
```

### Example 3: Complex Join with Validation
```gherkin
@database @join
Scenario: Employee Department Analysis
  When user connects to "PRACTICE_MYSQL" database

  When user executes query "SELECT e.first_name, e.last_name, d.department_name FROM employees e JOIN departments d ON e.department_id = d.department_id WHERE d.department_id = 1"
  Then the query result should have at least 10 rows
  And all values in column "department_name" should be "Engineering"
  And column "first_name" should contain value "Rajesh"

  When user disconnects from "PRACTICE_MYSQL" database
```

### Example 4: Multi-Database Operations
```gherkin
@database @multi-db
Scenario: Cross-Database Data Comparison
  When user connects to "PRACTICE_ORACLE" database
  And user connects to "PRACTICE_MYSQL" database

  # Get Oracle employee count
  When user switches to database "PRACTICE_ORACLE"
  And user executes query "SELECT COUNT(*) AS oracle_count FROM employees" and stores result as "ORACLE_DATA"

  # Get MySQL employee count
  When user switches to database "PRACTICE_MYSQL"
  And user executes query "SELECT COUNT(*) AS mysql_count FROM employees" and stores result as "MYSQL_DATA"

  When user disconnects from all databases
```

---

## Running Database Tests

### Run All Database Tests
```bash
npx cs-playwright-run --project=orangehrm --features=test/orangehrm/features/database-comprehensive-demo.feature
```

### Run Specific Scenario by Tag
```bash
# Run only Oracle tests
npx cs-playwright-run --project=orangehrm --features=test/orangehrm/features/database-comprehensive-demo.feature --tags="@oracle"

# Run only MySQL tests
npx cs-playwright-run --project=orangehrm --features=test/orangehrm/features/database-comprehensive-demo.feature --tags="@mysql"

# Run transaction tests
npx cs-playwright-run --project=orangehrm --features=test/orangehrm/features/database-comprehensive-demo.feature --tags="@transaction"

# Run validation tests
npx cs-playwright-run --project=orangehrm --features=test/orangehrm/features/database-comprehensive-demo.feature --tags="@validation"
```

### Run Specific Scenario by Line
```bash
npx cs-playwright-run --project=orangehrm --features=test/orangehrm/features/database-comprehensive-demo.feature:15
```

---

## Troubleshooting

### Connection Issues
```bash
# Enable debug logging
LOG_LEVEL=DEBUG npx cs-playwright-run --project=orangehrm --features=test/orangehrm/features/database-comprehensive-demo.feature
```

### Timeout Issues
- Increase connection timeout: `DB_{ALIAS}_CONNECTION_TIMEOUT=120000`
- Increase query timeout: `DB_{ALIAS}_REQUEST_TIMEOUT=60000`

### Pool Issues
- Increase pool size: `DB_{ALIAS}_POOL_MAX=20`

---

## Best Practices

1. **Use Transactions for Data Modification**
   - Always wrap INSERT/UPDATE/DELETE in transactions
   - Rollback after tests to avoid data pollution

2. **Use Result Storage**
   - Store complex query results with aliases
   - Reuse stored results in validations

3. **Use Configuration Variables**
   - Store database credentials in `.env` files
   - Use `ENCRYPTED:` prefix for sensitive data

4. **Clean Up Connections**
   - Always disconnect after scenarios
   - Use `user disconnects from all databases` in Background

5. **Use Appropriate Tags**
   - Tag by database type (@oracle, @mysql)
   - Tag by operation type (@transaction, @query, @validation)

---

## Database Schema Reference

### Oracle Database (PRACTICE_ORACLE)

**employees** table:
- employee_id (NUMBER) - Primary Key
- first_name (VARCHAR2)
- last_name (VARCHAR2)
- email (VARCHAR2)
- phone (VARCHAR2)
- salary (NUMBER)
- hire_date (DATE)
- department_id (NUMBER) - Foreign Key

**departments** table:
- department_id (NUMBER) - Primary Key
- department_name (VARCHAR2)
- location (VARCHAR2)

**products** table:
- product_id (NUMBER) - Primary Key
- product_name (VARCHAR2)
- category (VARCHAR2)
- price (NUMBER)
- stock_quantity (NUMBER)

### MySQL Database (PRACTICE_MYSQL)

**employees** table:
- employee_id (INT) - Primary Key
- first_name (VARCHAR)
- last_name (VARCHAR)
- email (VARCHAR) - Unique
- phone (VARCHAR)
- hire_date (DATE)
- job_title (VARCHAR)
- salary (DECIMAL)
- department_id (INT) - Foreign Key
- manager_id (INT) - Foreign Key

**departments** table:
- department_id (INT) - Primary Key
- department_name (VARCHAR)
- location (VARCHAR)
- budget (DECIMAL)

**projects** table:
- project_id (INT) - Primary Key
- project_name (VARCHAR)
- description (TEXT)
- start_date (DATE)
- end_date (DATE)
- status (ENUM: Planning, Active, Completed, On Hold)
- budget (DECIMAL)
- department_id (INT) - Foreign Key

**employee_projects** table:
- employee_id (INT) - Composite Primary Key
- project_id (INT) - Composite Primary Key
- role (VARCHAR)
- hours_allocated (DECIMAL)

**customers** table:
- customer_id (INT) - Primary Key
- company_name (VARCHAR)
- contact_name (VARCHAR)
- email (VARCHAR)
- phone (VARCHAR)
- city (VARCHAR)
- country (VARCHAR)

**orders** table:
- order_id (INT) - Primary Key
- customer_id (INT) - Foreign Key
- employee_id (INT) - Foreign Key
- order_date (DATE)
- shipped_date (DATE)
- total_amount (DECIMAL)
- status (ENUM: Pending, Processing, Shipped, Delivered, Cancelled)

---

## Framework Features Demonstrated

The comprehensive demo feature file (`database-comprehensive-demo.feature`) demonstrates:

✅ **49 Complete Scenarios** covering:
- Connection management (basic, timeout, multi-db, switching)
- Query execution (basic, parameterized, scalar, batch, from file)
- Row-level validations (count, range, empty results)
- Cell-level validations (exact, contains, pattern, null)
- Column-level validations (all values, uniqueness, contains)
- Aggregate validations (sum, average, min, max)
- Data type validations
- Result structure validations
- Transaction management (commit, rollback, savepoints, isolation)
- Complex queries (joins, subqueries, aggregations)
- DML operations (insert, update, delete)
- Error handling (invalid queries, timeouts)
- Utility functions (logging, export, cache)
- Configuration interpolation (%VAR%, ${VAR}, {{var}})
- Real-world scenarios (HR analytics, sales analysis, project tracking)

---

## Support

For questions or issues:
1. Check framework documentation: https://docs.claude.com/
2. Review step definitions in `/mnt/e/PTF-ADO/src/steps/database/`
3. Check configuration in `/mnt/e/PTF-Demo-Project/config/global.env`

---

**Created:** 2025-10-10
**Framework Version:** cs-playwright-test-framework 1.0.0+
**Author:** CS Framework Team
