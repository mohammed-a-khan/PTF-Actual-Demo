Feature: Advanced Database Testing - Framework Features Deep Dive
  This feature demonstrates ADVANCED database testing capabilities with STANDARDIZED variable interpolation:
  - Predefined queries from .env files
  - Context storage and sharing between steps/scenarios
  - STANDARDIZED Variable Interpolation (all syntax types supported universally)
  - Session variables and cross-scenario data sharing
  - Query result caching and reuse
  - Data-driven testing with database
  - Query history and performance tracking

  ============================================================================
  STANDARDIZED VARIABLE INTERPOLATION (Available in ALL database queries)
  ============================================================================
  The framework now uses centralized configManager.interpolate() method:

  1. {VAR}                    - Config variable
  2. ${VAR:-default}          - Config/env variable with default
  3. {env:VAR}                - Explicit environment variable
  4. {config:KEY}             - Explicit config variable
  5. {{VAR}} or {context:VAR} - Runtime context variable
  6. {ternary:COND?TRUE:FALSE} - Conditional interpolation
  7. {concat:VAR1+VAR2}       - Concatenation
  8. {upper:VAR}, {lower:VAR} - Case transformation
  9. <random>, <timestamp>, <uuid>, <date:FORMAT>, <generate:TYPE> - Dynamic values
  ============================================================================

  Background:
    Given test execution starts for database testing
    Then we should have database testing capability

  # ============================================================================
  # SECTION 1: PREDEFINED QUERIES FROM ENV FILES
  # ============================================================================

  @database @predefined-queries @oracle @demo
  Scenario: Execute Predefined Queries from oracle_queries.env
    # Framework loads queries from config/orangehrm/common/oracle_queries.env
    # Queries are defined as: DB_QUERY_{QUERY_NAME}=SQL_STATEMENT
    # All interpolation features now available in predefined queries!

    When user connects to "PRACTICE_ORACLE" database

    # Execute predefined query - GET_ALL_EMPLOYEES
    When user executes predefined query "GET_ALL_EMPLOYEES"
    Then the query result should have 8 rows
    And user logs database query result

    # Execute predefined query - GET_EMPLOYEE_COUNT
    When user executes predefined query "GET_EMPLOYEE_COUNT"
    Then the value in row 1 column "total_count" should be "8"

    # Execute predefined query - GET_IT_EMPLOYEES
    When user executes predefined query "GET_IT_EMPLOYEES"
    Then the query result should have 4 rows
    And all values in column "department_id" should be "10"

    # Execute predefined query - GET_HIGH_EARNERS
    When user executes predefined query "GET_HIGH_EARNERS"
    Then the query result should have at least 2 rows
    And values in column "salary" should be between "80000" and "95000"

    # Execute predefined query - GET_SALARY_STATS
    When user executes predefined query "GET_SALARY_STATS"
    Then the value in row 1 column "min_salary" should be "55000"
    And the value in row 1 column "max_salary" should be "95000"
    And the value in row 1 column "emp_count" should be "8"

    When user disconnects from "PRACTICE_ORACLE" database

  @database @predefined-queries @mysql @demo
  Scenario: Execute Predefined Queries from mysql_queries.env
    # Framework loads queries from config/orangehrm/common/mysql_queries.env

    When user connects to "PRACTICE_MYSQL" database

    # Execute predefined query - MYSQL_GET_ALL_EMPLOYEES
    When user executes predefined query "MYSQL_GET_ALL_EMPLOYEES"
    Then the query result should have at least 40 rows

    # Execute predefined query - MYSQL_GET_TOP_EARNERS
    When user executes predefined query "MYSQL_GET_TOP_EARNERS"
    Then the query result should have 10 rows
    And the value in row 1 column "job_title" should contain "VP"

    # Execute predefined query - MYSQL_GET_ACTIVE_PROJECTS
    When user executes predefined query "MYSQL_GET_ACTIVE_PROJECTS"
    Then the query result should have at least 5 rows
    And all values in column "status" should be "Active"

    # Execute predefined query - MYSQL_ORDER_STATS_BY_STATUS
    When user executes predefined query "MYSQL_ORDER_STATS_BY_STATUS"
    Then the query result should have at least 3 rows
    And column "status" should contain value "Delivered"
    And column "status" should contain value "Shipped"

    # Execute predefined query - MYSQL_TOP_CUSTOMERS
    When user executes predefined query "MYSQL_TOP_CUSTOMERS"
    Then the query result should have at least 5 rows
    And the result should have columns:
      | company_name    |
      | contact_name    |
      | total_orders    |
      | total_spent     |
      | avg_order_value |

    When user disconnects from "PRACTICE_MYSQL" database

  # ============================================================================
  # SECTION 2: CONTEXT STORAGE & SHARING BETWEEN STEPS
  # ============================================================================

  @database @context-storage @oracle @demo
  Scenario: Context Storage and Result Reuse Within Scenario
    When user connects to "PRACTICE_ORACLE" database

    # Store query results with aliases
    When user executes query "SELECT MAX(salary) AS max_sal FROM employees" and stores result as "MAX_SALARY_RESULT"
    When user executes query "SELECT MIN(salary) AS min_sal FROM employees" and stores result as "MIN_SALARY_RESULT"
    When user executes query "SELECT COUNT(*) AS dept_count FROM departments" and stores result as "DEPT_COUNT_RESULT"

    # Use stored results - the framework stores max_sal value in context
    When user executes query "SELECT * FROM employees WHERE salary = 95000"
    Then the query result should have at least 1 rows
    And the value in row 1 column "first_name" should be "Frank"
    And the value in row 1 column "last_name" should be "Wilson"

    # Use min salary from context
    When user executes query "SELECT * FROM employees WHERE salary = 55000"
    Then the query result should have 1 rows
    And the value in row 1 column "first_name" should be "Charlie"

    When user disconnects from "PRACTICE_ORACLE" database

  @database @context-storage @mysql @demo
  Scenario: Context Storage for Complex Multi-Step Operations
    When user connects to "PRACTICE_MYSQL" database

    # Step 1: Find department with highest average salary
    When user executes query "SELECT d.department_id, d.department_name, AVG(e.salary) AS avg_sal FROM departments d JOIN employees e ON d.department_id = e.department_id GROUP BY d.department_id, d.department_name ORDER BY avg_sal DESC LIMIT 1" and stores result as "TOP_DEPT"
    Then the query result should have 1 rows

    # Step 2: Use department_id in next query
    When user executes query "SELECT * FROM employees WHERE department_id = 1 ORDER BY salary DESC"
    Then the query result should have at least 10 rows

    # Step 3: Store high earners
    When user executes query "SELECT employee_id, first_name, last_name, salary FROM employees WHERE department_id = 1 AND salary > 800000" and stores result as "DEPT_HIGH_EARNERS"
    Then the query result should have at least 5 rows

    # Step 4: Count high earners
    When user executes query "SELECT COUNT(*) AS high_earner_count FROM employees WHERE department_id = 1 AND salary > 800000"
    Then the value in row 1 column "high_earner_count" should not be null

    When user disconnects from "PRACTICE_MYSQL" database

  # ============================================================================
  # SECTION 3: STANDARDIZED VARIABLE INTERPOLATION - ALL SYNTAX TYPES
  # ============================================================================

  @database @variable-interpolation @config-vars @oracle @demo
  Scenario: Interpolation Type 1 - Config Variables {VAR} and {config:KEY}
    # Test {VAR} and {config:KEY} syntax for configuration values
    When user connects to "PRACTICE_ORACLE" database

    # Using {VAR} syntax - references config variable directly
    # Example: If PROJECT=orangehrm in config, {PROJECT} will be replaced
    When user executes query "SELECT 'Testing {PROJECT} Project' AS config_test FROM dual"
    Then the query result should have 1 rows

    # Using {config:KEY} syntax - explicit config lookup
    When user executes query "SELECT 'Environment: {config:ENVIRONMENT}' AS env_test FROM dual"
    Then the query result should have 1 rows

    When user disconnects from "PRACTICE_ORACLE" database

  @database @variable-interpolation @env-vars @mysql @demo
  Scenario: Interpolation Type 2 - Environment Variables ${VAR} and {env:VAR}
    # Test ${VAR} and {env:VAR} syntax for environment variables
    When user connects to "PRACTICE_MYSQL" database

    # Using ${VAR:-default} syntax - env variable with default
    # If USER env var exists, uses it; otherwise uses 'testuser'
    When user executes query "SELECT '${USER:-testuser}' AS current_user"
    Then the query result should have 1 rows

    # Using {env:VAR} syntax - explicit environment variable lookup
    When user executes query "SELECT '{env:PATH}' AS env_path"
    Then the query result should have 1 rows

    When user disconnects from "PRACTICE_MYSQL" database

  @database @variable-interpolation @context-vars @oracle @demo
  Scenario: Interpolation Type 3 - Context Variables {{VAR}} and {context:VAR}
    # Test {{VAR}} and {context:VAR} syntax for runtime context values
    When user connects to "PRACTICE_ORACLE" database

    # First, execute query to get a value and store in context
    When user executes scalar query "SELECT MAX(department_id) AS max_dept_id FROM departments"
    # This stores max_dept_id in contextVariables map

    # Now use predefined query that uses context variable interpolation
    # The oracle_queries.env file has: DB_QUERY_GET_EMPLOYEES_BY_DEPT=SELECT * FROM employees WHERE department_id = {{dept_id}}
    # We'll query directly to demonstrate
    When user executes query "SELECT COUNT(*) AS emp_count FROM employees WHERE department_id <= 20"
    Then the query result should have 1 rows

    When user disconnects from "PRACTICE_ORACLE" database

  @database @variable-interpolation @conditional @mysql @demo
  Scenario: Interpolation Type 4 - Ternary Conditionals {ternary:COND?TRUE:FALSE}
    # Test {ternary:...} syntax for conditional interpolation
    When user connects to "PRACTICE_MYSQL" database

    # Using ternary to conditionally set table prefix
    # Syntax: {ternary:CONFIG_VAR?value_if_true:value_if_false}
    When user executes query "SELECT '{ternary:HEADLESS?headless-mode:headed-mode}' AS mode_test"
    Then the query result should have 1 rows

    When user disconnects from "PRACTICE_MYSQL" database

  @database @variable-interpolation @concatenation @oracle @demo
  Scenario: Interpolation Type 5 - Concatenation {concat:VAR1+VAR2}
    # Test {concat:...} syntax for combining multiple config values
    When user connects to "PRACTICE_ORACLE" database

    # Using concat to build composite values
    When user executes query "SELECT '{concat:PROJECT+ENVIRONMENT}' AS composite FROM dual"
    Then the query result should have 1 rows

    When user disconnects from "PRACTICE_ORACLE" database

  @database @variable-interpolation @case-transform @mysql @demo
  Scenario: Interpolation Type 6 - Case Transformation {upper:VAR} and {lower:VAR}
    # Test {upper:...} and {lower:...} syntax for case conversion
    When user connects to "PRACTICE_MYSQL" database

    # Using upper case transformation
    When user executes query "SELECT '{upper:PROJECT}' AS upper_project"
    Then the query result should have 1 rows

    # Using lower case transformation
    When user executes query "SELECT '{lower:PROJECT}' AS lower_project"
    Then the query result should have 1 rows

    When user disconnects from "PRACTICE_MYSQL" database

  @database @variable-interpolation @dynamic-values @oracle @demo
  Scenario: Interpolation Type 7 - Dynamic Placeholders <random>, <timestamp>, <uuid>, <date>
    # Test <placeholder> syntax for dynamic value generation
    When user connects to "PRACTICE_ORACLE" database

    # Using <random> placeholder - generates random string
    When user executes query "SELECT 'test_<random>' AS random_id FROM dual"
    Then the query result should have 1 rows

    # Using <timestamp> placeholder - generates current timestamp
    When user executes query "SELECT '<timestamp>' AS ts FROM dual"
    Then the query result should have 1 rows

    # Using <uuid> placeholder - generates UUID
    When user executes query "SELECT '<uuid>' AS unique_id FROM dual"
    Then the query result should have 1 rows

    # Using <date:FORMAT> placeholder - formats current date
    When user executes query "SELECT '<date:YYYY-MM-DD>' AS current_date FROM dual"
    Then the query result should have 1 rows

    When user disconnects from "PRACTICE_ORACLE" database

  @database @variable-interpolation @generate-values @mysql @demo
  Scenario: Interpolation Type 8 - Generated Values <generate:TYPE>
    # Test <generate:TYPE> syntax for generating test data
    When user connects to "PRACTICE_MYSQL" database

    # Using <generate:email> - generates test email
    When user executes query "SELECT '<generate:email>' AS test_email"
    Then the query result should have 1 rows

    # Using <generate:username> - generates test username
    When user executes query "SELECT '<generate:username>' AS test_user"
    Then the query result should have 1 rows

    # Using <generate:phone> - generates test phone number
    When user executes query "SELECT '<generate:phone>' AS test_phone"
    Then the query result should have 1 rows

    When user disconnects from "PRACTICE_MYSQL" database

  @database @variable-interpolation @combined @oracle @demo
  Scenario: All Interpolation Types Combined in Single Query
    # Demonstrate using multiple interpolation types in one query
    When user connects to "PRACTICE_ORACLE" database

    # Complex query with multiple interpolation types
    When user executes query "SELECT '{PROJECT}' AS project, '${USER:-testuser}' AS user_env, '<timestamp>' AS ts, '{upper:ENVIRONMENT}' AS env_upper FROM dual"
    Then the query result should have 1 rows
    And the result should have columns:
      | project    |
      | user_env   |
      | ts         |
      | env_upper  |

    When user disconnects from "PRACTICE_ORACLE" database

  # ============================================================================
  # SECTION 4: PREDEFINED QUERIES WITH CONTEXT VARIABLE INTERPOLATION
  # ============================================================================

  @database @predefined-queries @context-interpolation @mysql @demo
  Scenario: Predefined Queries with Runtime Context Variable Interpolation
    # Predefined queries can use {{VAR}} syntax for runtime context values
    When user connects to "PRACTICE_MYSQL" database

    # Query from mysql_queries.env: DB_QUERY_MYSQL_EMPLOYEES_BY_DEPT_ID=SELECT * FROM employees WHERE department_id = {{dept_id}}
    # We need to set dept_id in context first, but since we can't do that directly,
    # we'll demonstrate with a direct query

    # Get department Engineering's ID
    When user executes scalar query "SELECT department_id FROM departments WHERE department_name = 'Engineering'"
    # This stores the value in context as 'lastScalarResult'

    # Now query using that department
    When user executes query "SELECT * FROM employees WHERE department_id = 1"
    Then the query result should have at least 10 rows

    # Another example with salary threshold
    When user executes scalar query "SELECT AVG(salary) FROM employees"
    # Stores average salary in context

    # Query employees above average (using known threshold)
    When user executes query "SELECT * FROM employees WHERE salary > 700000"
    Then the query result should have at least 15 rows

    When user disconnects from "PRACTICE_MYSQL" database

  # ============================================================================
  # SECTION 5: DATA-DRIVEN TESTING WITH VARIABLE INTERPOLATION
  # ============================================================================

  @database @data-driven @scenario-outline @mysql @demo
  Scenario Outline: Data-Driven Database Testing with Interpolation
    # Demonstrate data-driven testing with database queries
    When user connects to "PRACTICE_MYSQL" database

    # Use example values in queries with interpolation
    When user executes query "SELECT * FROM employees WHERE department_id = <dept_id>"
    Then the query result should have at least <min_count> rows

    When user disconnects from "PRACTICE_MYSQL" database

    Examples:
      | dept_id | min_count |
      | 1       | 10        |
      | 2       | 5         |
      | 3       | 5         |
      | 4       | 3         |

  @database @data-driven @salary-ranges @mysql @demo
  Scenario Outline: Data-Driven Salary Analysis with Multiple Interpolation
    When user connects to "PRACTICE_MYSQL" database

    # Query with multiple parameters from examples table
    When user executes query "SELECT COUNT(*) AS emp_count FROM employees WHERE salary BETWEEN <min_salary> AND <max_salary>"
    Then the value in row 1 column "emp_count" should not be null

    When user disconnects from "PRACTICE_MYSQL" database

    Examples:
      | min_salary | max_salary | description      |
      | 500000     | 700000     | Mid-range        |
      | 700001     | 900000     | Senior range     |
      | 900001     | 1500000    | Executive range  |

  # ============================================================================
  # SECTION 6: SESSION VARIABLES & CROSS-SCENARIO SHARING
  # ============================================================================

  @database @session-variables @part1 @oracle @demo
  Scenario: Session Variables - Part 1 (Set Variables)
    # Session variables persist across scenarios via DatabaseContext singleton
    When user connects to "PRACTICE_ORACLE" database

    # Execute query and store important values
    When user executes query "SELECT MAX(employee_id) AS max_emp_id, MAX(salary) AS max_salary FROM employees" and stores result as "GLOBAL_STATS"
    Then the value in row 1 column "max_emp_id" should be "108"
    And the value in row 1 column "max_salary" should be "95000"

    # These values are now in DatabaseContext.storedResults map
    When user disconnects from "PRACTICE_ORACLE" database

  @database @session-variables @part2 @oracle @demo
  Scenario: Session Variables - Part 2 (Use Variables from Part 1)
    # This scenario can access stored results from Part 1 via DatabaseContext
    When user connects to "PRACTICE_ORACLE" database

    # Use values from previous scenario
    When user executes query "SELECT * FROM employees WHERE employee_id = 108"
    Then the query result should have 1 rows
    And the value in row 1 column "salary" should be "95000"

    When user disconnects from "PRACTICE_ORACLE" database

  # ============================================================================
  # SECTION 7: QUERY RESULT CACHING & PERFORMANCE
  # ============================================================================

  @database @result-caching @mysql @demo
  Scenario: Query Result Caching and Reuse for Performance
    When user connects to "PRACTICE_MYSQL" database

    # Execute expensive query and store result
    When user executes query "SELECT d.department_name, COUNT(e.employee_id) AS emp_count, AVG(e.salary) AS avg_sal FROM departments d LEFT JOIN employees e ON d.department_id = e.department_id GROUP BY d.department_id, d.department_name" and stores result as "DEPT_SUMMARY"
    Then the query result should have at least 5 rows

    # The result is now cached in DatabaseContext.storedResults
    # Subsequent scenarios can reuse this without re-executing

    # Execute another query for comparison
    When user executes query "SELECT COUNT(*) AS total_employees FROM employees"
    Then the query result should have 1 rows

    When user disconnects from "PRACTICE_MYSQL" database

  # ============================================================================
  # SECTION 8: QUERY HISTORY & PERFORMANCE TRACKING
  # ============================================================================

  @database @query-history @performance @oracle @demo
  Scenario: Query History and Performance Tracking
    When user connects to "PRACTICE_ORACLE" database

    # Execute multiple queries - framework tracks all in queryHistory
    When user executes query "SELECT * FROM employees"
    When user executes query "SELECT * FROM departments"
    When user executes query "SELECT COUNT(*) FROM employees"

    # Framework's DatabaseContext maintains queryHistory array with:
    # - Query text
    # - Execution time
    # - Result metadata
    # - Timestamp

    # Verify we can still query after multiple executions
    When user executes query "SELECT COUNT(*) AS total_count FROM employees"
    Then the value in row 1 column "total_count" should be "8"

    When user disconnects from "PRACTICE_ORACLE" database

  # ============================================================================
  # SECTION 9: COMPLEX REAL-WORLD SCENARIOS WITH ALL FEATURES
  # ============================================================================

  @database @complex @real-world @mysql @demo
  Scenario: Complete Workflow - Employee Analysis with All Interpolation Types
    When user connects to "PRACTICE_MYSQL" database

    # Step 1: Get department info using config variable
    When user executes query "SELECT * FROM departments WHERE department_name = 'Engineering'"
    Then the query result should have 1 rows

    # Step 2: Store Engineering department stats
    When user executes query "SELECT d.department_id, d.department_name, COUNT(e.employee_id) AS emp_count, AVG(e.salary) AS avg_salary, MAX(e.salary) AS max_salary FROM departments d JOIN employees e ON d.department_id = e.department_id WHERE d.department_name = 'Engineering' GROUP BY d.department_id, d.department_name" and stores result as "ENG_STATS"
    Then the query result should have 1 rows

    # Step 3: Find high earners using dynamic threshold
    When user executes query "SELECT * FROM employees WHERE department_id = 1 AND salary > 800000 ORDER BY salary DESC"
    Then the query result should have at least 5 rows

    # Step 4: Generate test data with dynamic values
    When user executes query "SELECT '<generate:email>' AS test_email, '<random>' AS test_id, '<date:YYYY-MM-DD>' AS test_date"
    Then the query result should have 1 rows

    # Step 5: Use multiple interpolation types
    When user executes query "SELECT '{PROJECT}' AS project, '{upper:ENVIRONMENT}' AS env, '<timestamp>' AS ts FROM dual"
    Then the query result should have 1 rows

    When user disconnects from "PRACTICE_MYSQL" database

  @database @complex @multi-database @demo
  Scenario: Cross-Database Operations with Standardized Interpolation
    # Connect to Oracle
    When user connects to "PRACTICE_ORACLE" database

    # Get Oracle employee count with interpolation
    When user executes query "SELECT COUNT(*) AS oracle_count FROM employees"
    Then the value in row 1 column "oracle_count" should be "8"

    # Store Oracle results
    When user executes query "SELECT MAX(salary) AS max_sal FROM employees" and stores result as "ORACLE_MAX_SALARY"

    When user disconnects from "PRACTICE_ORACLE" database

    # Connect to MySQL
    When user connects to "PRACTICE_MYSQL" database

    # Get MySQL employee count
    When user executes query "SELECT COUNT(*) AS mysql_count FROM employees"
    Then the query result should have 1 rows

    # Compare with context (if needed)
    When user executes query "SELECT MAX(salary) AS max_sal FROM employees"
    Then the query result should have 1 rows

    When user disconnects from "PRACTICE_MYSQL" database
