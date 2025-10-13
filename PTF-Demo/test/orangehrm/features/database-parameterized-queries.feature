@database @parameterized @prepared-statements
Feature: Parameterized Queries (Prepared Statements) for All Databases
  Demonstrates secure parameterized queries (like prepared statements) to prevent SQL injection
  and improve performance. Works with MySQL, PostgreSQL, Oracle, SQL Server, and MongoDB.

  IMPORTANT: All databases now support UNIVERSAL ? placeholders!
  The framework automatically converts ? to the database-specific format:
  - MySQL: ? (native)
  - PostgreSQL: ? → $1, $2, $3
  - SQL Server: ? → @p0, @p1, @p2
  - Oracle: ? → :1, :2, :3
  - MongoDB: ? (used in filter documents)

  Background:
    Given test execution starts for database testing
    And database connection pool is initialized

  # ================================================================
  # MySQL Parameterized Queries (Universal ? placeholders)
  # ================================================================

  @mysql @security @sql-injection-prevention
  Scenario: MySQL - Basic Parameterized SELECT with Single Parameter
    Given user connects to "TEST_DB" database
    # Using ? placeholder (MySQL style)
    When user executes parameterized query "SELECT * FROM employees WHERE employee_id = ?" with parameters:
      | 101 |
    Then query result should have 1 rows
    And query result should contain column "employee_id"
    And result column "employee_id" should have value "101"
    And database connection to "TEST_DB" is closed

  @mysql @multiple-parameters
  Scenario: MySQL - Parameterized SELECT with Multiple Parameters
    Given user connects to "TEST_DB" database
    # Multiple ? placeholders for WHERE conditions
    When user executes parameterized query "SELECT * FROM employees WHERE department_id = ? AND salary > ?" with parameters:
      | 1     |
      | 50000 |
    Then query result should have at least 1 rows
    And all result rows should have column "department_id" with value "1"
    And database connection to "TEST_DB" is closed

  @mysql @parameterized-insert
  Scenario: MySQL - Parameterized INSERT Statement
    Given user connects to "TEST_DB" database
    # Parameterized INSERT for security
    When user executes parameterized query "INSERT INTO employees (employee_id, first_name, last_name, email, hire_date, salary) VALUES (?, ?, ?, ?, ?, ?)" with parameters:
      | 9999             |
      | Test             |
      | User             |
      | test@example.com |
      | 2024-01-01       |
      | 45000            |
    Then query should execute successfully
    # Verify insertion
    When user executes parameterized query "SELECT * FROM employees WHERE employee_id = ?" with parameters:
      | 9999 |
    Then query result should have 1 rows
    # Cleanup
    And user executes parameterized query "DELETE FROM employees WHERE employee_id = ?" with parameters:
      | 9999 |
    And database connection to "TEST_DB" is closed

  @mysql @parameterized-update
  Scenario: MySQL - Parameterized UPDATE Statement
    Given user connects to "TEST_DB" database
    # Parameterized UPDATE for safe modifications
    When user executes parameterized query "UPDATE employees SET salary = ? WHERE employee_id = ?" with parameters:
      | 75000 |
      | 101   |
    Then query should execute successfully
    # Verify update
    When user executes parameterized query "SELECT salary FROM employees WHERE employee_id = ?" with parameters:
      | 101 |
    Then result column "salary" should have value "75000"
    # Rollback to original
    When user executes parameterized query "UPDATE employees SET salary = ? WHERE employee_id = ?" with parameters:
      | 50000 |
      | 101   |
    And database connection to "TEST_DB" is closed

  @mysql @like-parameter
  Scenario: MySQL - Parameterized Query with LIKE Operator
    Given user connects to "TEST_DB" database
    # Using LIKE with parameterized value
    When user executes parameterized query "SELECT * FROM employees WHERE first_name LIKE ?" with parameters:
      | John% |
    Then query result should have at least 1 rows
    And database connection to "TEST_DB" is closed

  @mysql @in-clause
  Scenario: MySQL - Parameterized Query with IN Clause
    Given user connects to "TEST_DB" database
    # Using IN clause with multiple parameters
    When user executes parameterized query "SELECT * FROM employees WHERE employee_id IN (?, ?, ?)" with parameters:
      | 101 |
      | 102 |
      | 103 |
    Then query result should have 3 rows
    And database connection to "TEST_DB" is closed

  # ================================================================
  # PostgreSQL Parameterized Queries (Universal ? placeholders)
  # ================================================================

  @postgresql @universal-placeholders
  Scenario: PostgreSQL - Parameterized Query with Universal ? Placeholders
    Given user connects to "POSTGRES_DB" database
    # Using universal ? placeholder (automatically converted to $1, $2, $3)
    When user executes parameterized query "SELECT * FROM employees WHERE employee_id = ?" with parameters:
      | 101 |
    Then query result should have 1 rows
    And result column "employee_id" should have value "101"
    And database connection to "POSTGRES_DB" is closed

  @postgresql @complex-where
  Scenario: PostgreSQL - Complex WHERE with Multiple Universal Placeholders
    Given user connects to "POSTGRES_DB" database
    # All ? placeholders are converted to $1, $2, $3 internally
    When user executes parameterized query "SELECT * FROM employees WHERE department_id = ? AND salary > ? AND hire_date > ?" with parameters:
      | 1          |
      | 50000      |
      | 2020-01-01 |
    Then query result should have at least 0 rows
    And database connection to "POSTGRES_DB" is closed

  @postgresql @json-parameter
  Scenario: PostgreSQL - Parameterized Query with JSON Data
    Given user connects to "POSTGRES_DB" database
    # PostgreSQL supports JSON parameters with universal ? placeholder
    When user executes parameterized query "INSERT INTO employees (employee_id, first_name, metadata) VALUES (?, ?, ?::jsonb)" with parameters:
      | 8888        |
      | TestUser    |
      | {"age": 30} |
    Then query should execute successfully
    # Cleanup
    And user executes parameterized query "DELETE FROM employees WHERE employee_id = ?" with parameters:
      | 8888 |
    And database connection to "POSTGRES_DB" is closed

  # ================================================================
  # SQL Server Parameterized Queries (Universal ? placeholders)
  # ================================================================

  @sqlserver @universal-placeholders
  Scenario: SQL Server - Parameterized Query with Universal ? Placeholders
    Given user connects to "SQLSERVER_DB" database
    # Using universal ? placeholder (automatically converted to @p0, @p1, etc.)
    When user executes parameterized query "SELECT * FROM employees WHERE employee_id = ?" with parameters:
      | 101 |
    Then query result should have 1 rows
    And database connection to "SQLSERVER_DB" is closed

  @sqlserver @multiple-params
  Scenario: SQL Server - Multiple Universal Placeholders
    Given user connects to "SQLSERVER_DB" database
    # All ? placeholders are converted to @p0, @p1, @p2 internally
    When user executes parameterized query "SELECT * FROM employees WHERE department_id = ? AND salary > ?" with parameters:
      | 1     |
      | 50000 |
    Then query result should have at least 0 rows
    And database connection to "SQLSERVER_DB" is closed

  # ================================================================
  # Oracle Parameterized Queries (Universal ? placeholders)
  # ================================================================

  @oracle @universal-placeholders
  Scenario: Oracle - Parameterized Query with Universal ? Placeholders
    Given user connects to "ORACLE_DB" database
    # Using universal ? placeholder (automatically converted to :1, :2, etc.)
    When user executes parameterized query "SELECT * FROM employees WHERE employee_id = ?" with parameters:
      | 101 |
    Then query result should have 1 rows
    And database connection to "ORACLE_DB" is closed

  @oracle @date-parameter
  Scenario: Oracle - Parameterized Query with Date Parameter
    Given user connects to "ORACLE_DB" database
    # All ? placeholders are converted to :1, :2, :3 internally
    When user executes parameterized query "SELECT * FROM employees WHERE hire_date > TO_DATE(?, 'YYYY-MM-DD')" with parameters:
      | 2020-01-01 |
    Then query result should have at least 0 rows
    And database connection to "ORACLE_DB" is closed

  # ================================================================
  # MongoDB Parameterized Queries (Document-based)
  # ================================================================

  @mongodb @document-params
  Scenario: MongoDB - Parameterized Find Query
    Given user connects to "MONGO_DB" database
    # MongoDB uses document-based parameterized queries
    When user executes parameterized query "db.employees.find({employee_id: ?})" with parameters:
      | 101 |
    Then query result should have 1 rows
    And database connection to "MONGO_DB" is closed

  @mongodb @multiple-fields
  Scenario: MongoDB - Parameterized Query with Multiple Fields
    Given user connects to "MONGO_DB" database
    When user executes parameterized query "db.employees.find({department_id: ?, salary: {$gt: ?}})" with parameters:
      | 1     |
      | 50000 |
    Then query result should have at least 0 rows
    And database connection to "MONGO_DB" is closed

  # ================================================================
  # Security: SQL Injection Prevention Demo
  # ================================================================

  @security @sql-injection
  Scenario: Security - Parameterized Query Prevents SQL Injection
    Given user connects to "TEST_DB" database
    # Attempting SQL injection with parameterized query (safe!)
    # The malicious input will be treated as literal string, not SQL
    When user executes parameterized query "SELECT * FROM employees WHERE first_name = ?" with parameters:
      | John' OR '1'='1 |
    Then query result should have 0 rows
    # Confirms: SQL injection attempt failed because input is parameterized
    And database connection to "TEST_DB" is closed

  # ================================================================
  # Performance: Prepared Statement Reuse
  # ================================================================

  @performance @prepared-statements
  Scenario: Performance - Reusing Prepared Statements
    Given user connects to "TEST_DB" database
    # Execute same parameterized query multiple times with different values
    # Database reuses the prepared statement for better performance
    When user executes parameterized query "SELECT * FROM employees WHERE employee_id = ?" with parameters:
      | 101 |
    Then query result should have 1 rows

    When user executes parameterized query "SELECT * FROM employees WHERE employee_id = ?" with parameters:
      | 102 |
    Then query result should have 1 rows

    When user executes parameterized query "SELECT * FROM employees WHERE employee_id = ?" with parameters:
      | 103 |
    Then query result should have 1 rows
    And database connection to "TEST_DB" is closed

  # ================================================================
  # Advanced: Combining Configuration Variables with Parameters
  # ================================================================

  @advanced @config-interpolation
  Scenario: Advanced - Parameterized Query with Config Variables
    Given user connects to "TEST_DB" database
    # You can use config variables in the query AND parameters
    When user executes parameterized query "SELECT * FROM {DB_TABLE_EMPLOYEES} WHERE employee_id = ?" with parameters:
      | 101 |
    Then query result should have 1 rows
    And database connection to "TEST_DB" is closed

  @advanced @context-variables
  Scenario: Advanced - Parameterized Query with Context Variables
    Given user connects to "TEST_DB" database
    # Store a value in context
    And user stores value "101" in context as "targetEmployeeId"
    # Use context variable in parameters
    When user executes parameterized query "SELECT * FROM employees WHERE employee_id = ?" with parameters:
      | {context:targetEmployeeId} |
    Then query result should have 1 rows
    And database connection to "TEST_DB" is closed

  # ================================================================
  # Data Types: Testing Different Parameter Types
  # ================================================================

  @data-types
  Scenario: Data Types - Integer, String, Date, Boolean, Decimal Parameters
    Given user connects to "TEST_DB" database
    When user executes parameterized query "SELECT * FROM employees WHERE employee_id = ? AND first_name = ? AND hire_date > ? AND salary > ?" with parameters:
      | 101        |
      | John       |
      | 2019-01-01 |
      | 45000.50   |
    Then query result should have at least 0 rows
    And database connection to "TEST_DB" is closed

  @null-parameters
  Scenario: NULL Parameters - Handling NULL Values
    Given user connects to "TEST_DB" database
    # Using NULL as parameter value
    When user executes parameterized query "SELECT * FROM employees WHERE manager_id IS NULL" with parameters:
    Then query result should have at least 0 rows
    And database connection to "TEST_DB" is closed

  # ================================================================
  # NOTES ON UNIVERSAL ? PLACEHOLDER SYNTAX
  # ================================================================

  # UNIVERSAL PARAMETERIZED QUERY SYNTAX:
  # All databases now support the SAME ? placeholder syntax!
  #
  # Examples using universal ? placeholders:
  #   SELECT * FROM table WHERE id = ?
  #   SELECT * FROM table WHERE id = ? AND name = ?
  #   INSERT INTO table (col1, col2, col3) VALUES (?, ?, ?)
  #   UPDATE table SET col1 = ? WHERE id = ?
  #   DELETE FROM table WHERE id = ?
  #
  # How it works behind the scenes:
  # - MySQL:       ? → ? (native, no conversion)
  # - PostgreSQL:  ? → $1, $2, $3 (automatic conversion)
  # - SQL Server:  ? → @p0, @p1, @p2 (automatic conversion)
  # - Oracle:      ? → :1, :2, :3 (automatic conversion)
  # - MongoDB:     ? → used in filter documents
  #
  # Parameters Table Format:
  #   | value1 |                  → Single positional parameter
  #   | value1 | value2 | value3 | → Multiple positional parameters
  #
  # Benefits of Universal ? Placeholders:
  # ✅ SQL Injection Prevention (security)
  # ✅ Performance (prepared statement reuse)
  # ✅ Type Safety (automatic type conversion)
  # ✅ Code Clarity (separate logic from data)
  # ✅ Database Independence (same syntax for all databases)
  # ✅ Easy to Learn (no need to memorize different placeholder syntax)
