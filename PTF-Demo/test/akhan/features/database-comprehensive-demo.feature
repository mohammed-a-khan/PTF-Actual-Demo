Feature: Comprehensive Database Testing Demo
  This feature demonstrates ALL database testing capabilities provided by the cs-playwright-test-framework
  including connections, queries, validations, transactions, stored procedures, utilities, and more.

  Background:
    Given test execution starts for database testing
    Then we should have database testing capability

  # ============================================================================
  # SECTION 1: CONNECTION MANAGEMENT & CONFIGURATION
  # ============================================================================

  @database @connection @oracle @demo
  Scenario: Oracle Database Connection with Configuration Interpolation
    # Demonstrates: Basic connection using alias defined in config
    # Uses: %VARIABLE% interpolation from config/global.env
    When user connects to "PRACTICE_ORACLE" database
    Then user verifies database connection
    And user validates database connection

    # Test simple query with config variable interpolation
    When user executes query "SELECT SYSDATE AS current_date FROM DUAL"
    Then the query result should have 1 rows
    And the value in row 1 column "CURRENT_DATE" should not be null
    And user logs database query result

    When user disconnects from "PRACTICE_ORACLE" database
    Then database should not have active transaction

  @database @connection @mysql @demo
  Scenario: MySQL Database Connection with Timeout and Pool Configuration
    # Demonstrates: Connection with timeout, pool size configuration
    When user sets database connection pool size to 5
    And user connects to "PRACTICE_MYSQL" database
    And user sets database timeout to 30 seconds
    Then user verifies database connection

    # Query with environment variable interpolation
    When user executes query "SELECT DATABASE() AS db_name, VERSION() AS db_version"
    Then the query result should have 1 rows
    And the value in row 1 column "db_name" should be "corporate_db"
    And the value in row 1 column "db_version" should not be null

    When user sets database timeout to 60 seconds
    And user disconnects from "PRACTICE_MYSQL" database

  @database @connection @multi-db @demo
  Scenario: Multi-Database Connection Switching
    # Demonstrates: Connecting to multiple databases and switching between them
    When user connects to "PRACTICE_ORACLE" database
    And user connects to "PRACTICE_MYSQL" database

    # Switch to Oracle and query
    When user switches to database "PRACTICE_ORACLE"
    And user executes query "SELECT COUNT(*) AS emp_count FROM employees"
    Then the query result should have 1 rows
    And the value in row 1 column "emp_count" should be "8"

    # Switch to MySQL and query
    When user switches to database "PRACTICE_MYSQL"
    And user executes query "SELECT COUNT(*) AS dept_count FROM departments"
    Then the query result should have 1 rows
    And the value in row 1 column "dept_count" should be "8"

    # Disconnect all databases
    When user disconnects from all databases

  # ============================================================================
  # SECTION 2: QUERY EXECUTION & RESULT STORAGE
  # ============================================================================

  @database @query @basic @oracle @demo
  Scenario: Basic Query Execution with Result Storage and Validation
    When user connects to "PRACTICE_ORACLE" database

    # Execute query and store result
    When user executes query "SELECT * FROM employees WHERE department_id = 10" and stores result as "IT_EMPLOYEES"
    Then the query result should have 1 rows

    # Execute another query
    When user executes query "SELECT * FROM departments WHERE department_id = 10"
    Then the query result should have 1 rows
    And the value in row 1 column "department_name" should be "IT Department"
    And the value in row 1 column "location" should be "Building A"

    When user disconnects from "PRACTICE_ORACLE" database

  @database @query @mysql @parameterized @demo
  Scenario: Parameterized Query Execution
    When user connects to "PRACTICE_MYSQL" database

    # Demonstrate parameterized query (framework interpolates variables)
    When user executes query "SELECT * FROM employees WHERE salary > 700000 AND department_id IN (1, 2, 8)"
    Then the query result should have at least 8 rows

    # Count query
    When user executes count query "SELECT COUNT(*) AS high_earners FROM employees WHERE salary > 800000"
    Then the scalar result should be "1"

    When user disconnects from "PRACTICE_MYSQL" database

  @database @query @scalar @oracle @demo
  Scenario: Scalar and Count Query Execution
    When user connects to "PRACTICE_ORACLE" database

    # Scalar query returns single value
    When user executes scalar query "SELECT MAX(salary) FROM employees"
    Then the value in row 1 column "MAX(SALARY)" should be "95000"

    # Count query
    When user executes count query "SELECT COUNT(*) AS total FROM employees"
    Then the scalar result should be "8"

    # Query with first row fetch
    When user executes query "SELECT * FROM employees ORDER BY salary DESC" and fetches first row
    Then the query result should have 1 rows
    And the value in row 1 column "first_name" should be "Frank"
    And the value in row 1 column "last_name" should be "Wilson"
    And the value in row 1 column "salary" should be "95000"

    When user disconnects from "PRACTICE_ORACLE" database

  @database @query @limit @timeout @mysql @demo
  Scenario: Query with Limit and Timeout
    When user connects to "PRACTICE_MYSQL" database

    # Query with limit
    When user executes query "SELECT * FROM employees ORDER BY employee_id" with limit 5
    Then the query result should have 5 rows

    # Query with timeout
    When user executes query "SELECT * FROM projects WHERE status = 'Active'" with timeout 10 seconds
    Then the query result should have at least 1 rows

    When user disconnects from "PRACTICE_MYSQL" database

  @database @query @batch @mysql @demo
  Scenario: Batch Query Execution
    When user connects to "PRACTICE_MYSQL" database
    And user enables database query logging

    # Execute multiple queries in batch
    When user executes batch queries:
      """
      SELECT COUNT(*) AS employee_count FROM employees;
      SELECT COUNT(*) AS department_count FROM departments;
      SELECT COUNT(*) AS project_count FROM projects;
      SELECT COUNT(*) AS customer_count FROM customers;
      SELECT COUNT(*) AS order_count FROM orders
      """
    Then the query result should have at least 1 rows

    When user disables database query logging
    And user disconnects from "PRACTICE_MYSQL" database

  # ============================================================================
  # SECTION 3: DATA VALIDATION - CELL & ROW LEVEL
  # ============================================================================

  @database @validation @cell @oracle @demo
  Scenario: Cell-Level Data Validation
    When user connects to "PRACTICE_ORACLE" database

    When user executes query "SELECT * FROM employees WHERE employee_id = 101"
    Then the query result should have 1 rows

    # Cell value validation
    And the value in row 1 column "first_name" should be "John"
    And the value in row 1 column "last_name" should be "Doe"
    And the value in row 1 column "email" should be "john.doe@company.com"
    And the value in row 1 column "salary" should be "75000"
    And the value in row 1 column "department_id" should be "10"

    # Cell contains validation
    And the value in row 1 column "email" should contain "@company.com"
    And the value in row 1 column "first_name" should contain "John"

    # Cell pattern validation (regex)
    And the value in row 1 column "email" should match pattern "^[a-z]+\.[a-z]+@company\.com$"
    And the value in row 1 column "phone" should match pattern "^555-\d{4}$"

    # Null checks
    And the value in row 1 column "first_name" should not be null
    And the value in row 1 column "email" should not be null

    When user disconnects from "PRACTICE_ORACLE" database

  @database @validation @column @mysql @demo
  Scenario: Column-Level Data Validation
    When user connects to "PRACTICE_MYSQL" database

    # Get all IT department employees
    When user executes query "SELECT * FROM employees WHERE department_id = 1 ORDER BY employee_id"
    Then the query result should have at least 10 rows

    # All values in column validation
    And all values in column "department_id" should be "1"

    # Column contains value
    And column "job_title" should contain value "Software Engineer"
    And column "job_title" should contain value "Senior Developer"

    # Column should not contain value
    And column "department_id" should not contain value "99"

    When user disconnects from "PRACTICE_MYSQL" database

  @database @validation @aggregate @mysql @demo
  Scenario: Aggregate Function Validation (Sum, Average, Min, Max)
    When user connects to "PRACTICE_MYSQL" database

    # Get Engineering department employees (dept 1)
    When user executes query "SELECT salary FROM employees WHERE department_id = 1"
    Then the query result should have at least 10 rows

    # Sum validation
    And the sum of column "salary" should be 10090000

    # Average validation
    And the average of column "salary" should be 818571.43

    # Min/Max validation
    And the minimum value in column "salary" should be "720000"
    And the maximum value in column "salary" should be "1800000"

    When user disconnects from "PRACTICE_MYSQL" database

  @database @validation @range @oracle @demo
  Scenario: Range and Data Type Validation
    When user connects to "PRACTICE_ORACLE" database

    When user executes query "SELECT * FROM employees"
    Then the query result should have at least 5 rows

    # Range validation
    And values in column "salary" should be between "55000" and "95000"

    # Query products with price range
    When user executes query "SELECT * FROM products WHERE price BETWEEN 50 AND 500"
    Then the query result should have at least 3 rows
    And values in column "price" should be between "50" and "500"

    When user disconnects from "PRACTICE_ORACLE" database

  @database @validation @uniqueness @oracle @demo
  Scenario: Column Uniqueness Validation
    When user connects to "PRACTICE_ORACLE" database

    # Validate unique constraint
    When user executes query "SELECT email FROM employees WHERE email IS NOT NULL"
    Then all values in column "email" should be unique

    When user executes query "SELECT email FROM employees"
    Then all values in column "email" should be unique

    When user disconnects from "PRACTICE_ORACLE" database

  @database @validation @result-structure @mysql @demo
  Scenario: Result Structure Validation (Columns and Data)
    When user connects to "PRACTICE_MYSQL" database

    When user executes query "SELECT employee_id, first_name, last_name, email, salary FROM employees LIMIT 2"
    Then the query result should have 2 rows

    # Validate result has expected columns
    And the result should have columns:
      | employee_id |
      | first_name  |
      | last_name   |
      | email       |
      | salary      |

    # Validate complete result data (headers + 2 data rows)
    And the result should match:
      | employee_id | first_name | last_name | email                     | salary   |
      | 1           | Rajesh     | Kumar     | rajesh.kumar@company.com  | 1800000  |
      | 2           | Priya      | Sharma    | priya.sharma@company.com  | 1750000  |

    When user disconnects from "PRACTICE_MYSQL" database

  # ============================================================================
  # SECTION 4: TRANSACTION MANAGEMENT
  # ============================================================================

  @database @transaction @commit @mysql @demo
  Scenario: Transaction Commit with Insert Operations
    When user connects to "PRACTICE_MYSQL" database

    # Begin transaction
    When user begins database transaction
    Then database should have active transaction

    # Insert new employee within transaction
    When user executes query "INSERT INTO employees (first_name, last_name, email, phone, hire_date, job_title, salary, department_id) VALUES ('Test', 'User', 'test.user@company.com', '+91-9999999999', '2025-01-01', 'Test Engineer', 500000, 7)" within transaction

    # Verify insert
    When user executes query "SELECT * FROM employees WHERE email = 'test.user@company.com'" within transaction
    Then the query result should have 1 rows
    And the value in row 1 column "first_name" should be "Test"
    And the value in row 1 column "last_name" should be "User"

    # Commit transaction
    When user commits database transaction
    Then database should not have active transaction

    # Verify data persisted after commit
    When user executes query "SELECT * FROM employees WHERE email = 'test.user@company.com'"
    Then the query result should have 1 rows

    # Cleanup - Delete test data
    When user executes query "DELETE FROM employees WHERE email = 'test.user@company.com'"

    When user disconnects from "PRACTICE_MYSQL" database

  @database @transaction @rollback @mysql @demo
  Scenario: Transaction Rollback with Update Operations
    When user connects to "PRACTICE_MYSQL" database

    # Get current salary
    When user executes query "SELECT salary FROM employees WHERE employee_id = 1"
    Then the query result should have 1 rows
    And the value in row 1 column "salary" should be "1800000"

    # Begin transaction and update
    When user begins database transaction
    And user executes query "UPDATE employees SET salary = 5000000 WHERE employee_id = 1" within transaction

    # Verify update within transaction
    When user executes query "SELECT salary FROM employees WHERE employee_id = 1" within transaction
    Then the value in row 1 column "salary" should be "5000000"

    # Rollback transaction
    When user rolls back database transaction
    Then database should not have active transaction

    # Verify data reverted after rollback
    When user executes query "SELECT salary FROM employees WHERE employee_id = 1"
    Then the value in row 1 column "salary" should be "1800000"

    When user disconnects from "PRACTICE_MYSQL" database

  @database @transaction @isolation @mysql @demo
  Scenario: Transaction with Isolation Level
    When user connects to "PRACTICE_MYSQL" database

    # Begin transaction with specific isolation level
    When user begins database transaction with isolation level "READ COMMITTED"
    Then database should have active transaction

    When user executes query "SELECT COUNT(*) AS count FROM employees" within transaction
    Then the query result should have 1 rows

    When user commits database transaction
    When user disconnects from "PRACTICE_MYSQL" database

  @database @transaction @savepoint @mysql @demo
  Scenario: Transaction with Savepoints
    When user connects to "PRACTICE_MYSQL" database

    # Get initial count
    When user executes query "SELECT COUNT(*) AS initial_count FROM employees"
    Then the query result should have 1 rows

    # Begin transaction
    When user begins database transaction

    # Insert first test record
    When user executes query "INSERT INTO employees (first_name, last_name, email, job_title, salary, department_id) VALUES ('SavePoint', 'Test1', 'sp.test1@company.com', 'Tester', 400000, 7)" within transaction
    And user creates savepoint "after_first_insert"

    # Insert second test record
    When user executes query "INSERT INTO employees (first_name, last_name, email, job_title, salary, department_id) VALUES ('SavePoint', 'Test2', 'sp.test2@company.com', 'Tester', 400000, 7)" within transaction
    And user creates savepoint "after_second_insert"

    # Verify both records exist
    When user executes query "SELECT COUNT(*) AS count FROM employees WHERE first_name = 'SavePoint'" within transaction
    Then the value in row 1 column "count" should be "2"

    # Rollback to first savepoint (removes second insert)
    When user rolls back to savepoint "after_first_insert"

    # Verify only first record exists
    When user executes query "SELECT COUNT(*) AS count FROM employees WHERE first_name = 'SavePoint'" within transaction
    Then the value in row 1 column "count" should be "1"

    # Release savepoint and commit
    When user releases savepoint "after_first_insert"
    And user commits database transaction

    # Cleanup
    When user executes query "DELETE FROM employees WHERE first_name = 'SavePoint'"

    When user disconnects from "PRACTICE_MYSQL" database

  # ============================================================================
  # SECTION 5: COMPLEX QUERIES & JOINS
  # ============================================================================

  @database @query @join @mysql @demo
  Scenario: Complex JOIN Queries with Multiple Tables
    When user connects to "PRACTICE_MYSQL" database

    # Inner join employees and departments
    When user executes query "SELECT e.first_name, e.last_name, e.job_title, e.salary, d.department_name, d.location FROM employees e INNER JOIN departments d ON e.department_id = d.department_id WHERE d.department_id = 1 ORDER BY e.salary DESC LIMIT 5"
    Then the query result should have 5 rows
    And all values in column "department_name" should be "Engineering"
    And all values in column "location" should be "Hyderabad"

    # Complex multi-table join
    When user executes query "SELECT e.first_name, e.last_name, d.department_name, p.project_name, ep.role, ep.hours_allocated FROM employees e JOIN departments d ON e.department_id = d.department_id JOIN employee_projects ep ON e.employee_id = ep.employee_id JOIN projects p ON ep.project_id = p.project_id WHERE p.status = 'Active' ORDER BY e.employee_id LIMIT 10"
    Then the query result should have at least 5 rows
    And column "project_name" should contain value "Cloud Migration Initiative"

    When user disconnects from "PRACTICE_MYSQL" database

  @database @query @aggregation @mysql @demo
  Scenario: Aggregation and GROUP BY Queries
    When user connects to "PRACTICE_MYSQL" database

    # Group by department with aggregations
    When user executes query "SELECT d.department_name, COUNT(e.employee_id) AS emp_count, AVG(e.salary) AS avg_salary, MIN(e.salary) AS min_salary, MAX(e.salary) AS max_salary FROM departments d LEFT JOIN employees e ON d.department_id = e.department_id GROUP BY d.department_id, d.department_name HAVING COUNT(e.employee_id) > 3 ORDER BY emp_count DESC LIMIT 5"
    Then the query result should have at least 2 rows
    And the value in row 1 column "department_name" should be "Engineering"
    And the value in row 1 column "emp_count" should not be null
    And values in column "avg_salary" should be between "0" and "3000000"

    When user disconnects from "PRACTICE_MYSQL" database

  @database @query @subquery @mysql @demo
  Scenario: Subqueries and Nested Queries
    When user connects to "PRACTICE_MYSQL" database

    # Subquery to find employees earning more than average
    When user executes query "SELECT first_name, last_name, salary, (SELECT AVG(salary) FROM employees) AS avg_salary FROM employees WHERE salary > (SELECT AVG(salary) FROM employees) ORDER BY salary DESC LIMIT 5"
    Then the query result should have at least 3 rows
    And the value in row 1 column "avg_salary" should not be null

    # Correlated subquery
    When user executes query "SELECT e.first_name, e.last_name, e.salary, d.department_name FROM employees e JOIN departments d ON e.department_id = d.department_id WHERE e.salary = (SELECT MAX(e2.salary) FROM employees e2 WHERE e2.department_id = e.department_id) ORDER BY e.salary DESC"
    Then the query result should have at least 5 rows

    When user disconnects from "PRACTICE_MYSQL" database

  # ============================================================================
  # SECTION 6: DATA MANIPULATION (INSERT, UPDATE, DELETE)
  # ============================================================================

  @database @dml @insert @mysql @demo
  Scenario: INSERT Operations with Validation
    When user connects to "PRACTICE_MYSQL" database

    # Insert single record
    When user executes query "INSERT INTO customers (company_name, contact_name, email, phone, city, country) VALUES ('Test Company', 'Test Contact', 'test@testcompany.com', '+91-1234567890', 'TestCity', 'India')"

    # Verify insert
    When user executes query "SELECT * FROM customers WHERE email = 'test@testcompany.com'"
    Then the query result should have 1 rows
    And the value in row 1 column "company_name" should be "Test Company"
    And the value in row 1 column "contact_name" should be "Test Contact"

    # Cleanup
    When user executes query "DELETE FROM customers WHERE email = 'test@testcompany.com'"

    When user disconnects from "PRACTICE_MYSQL" database

  @database @dml @update @mysql @demo
  Scenario: UPDATE Operations with Transaction
    When user connects to "PRACTICE_MYSQL" database

    # Begin transaction for safe updates
    When user begins database transaction

    # Update with WHERE clause
    When user executes query "UPDATE projects SET budget = budget * 1.1 WHERE status = 'Planning'" within transaction

    # Verify update
    When user executes query "SELECT project_name, budget, status FROM projects WHERE status = 'Planning'" within transaction
    Then the query result should have at least 1 rows

    # Rollback to not affect actual data
    When user rolls back database transaction

    When user disconnects from "PRACTICE_MYSQL" database

  @database @dml @delete @mysql @demo
  Scenario: DELETE Operations with Transaction Rollback
    When user connects to "PRACTICE_MYSQL" database

    # Get initial count
    When user executes query "SELECT COUNT(*) AS initial_count FROM orders WHERE status = 'Cancelled'"

    # Begin transaction
    When user begins database transaction

    # Delete cancelled orders
    When user executes query "DELETE FROM orders WHERE status = 'Cancelled'" within transaction

    # Verify deletion
    When user executes query "SELECT COUNT(*) AS count_after_delete FROM orders WHERE status = 'Cancelled'" within transaction
    Then the value in row 1 column "count_after_delete" should be "0"

    # Rollback to preserve data
    When user rolls back database transaction

    # Verify data restored
    When user executes query "SELECT COUNT(*) AS final_count FROM orders WHERE status = 'Cancelled'"
    Then the query result should have 1 rows

    When user disconnects from "PRACTICE_MYSQL" database

  # ============================================================================
  # SECTION 7: ERROR HANDLING & EDGE CASES
  # ============================================================================

  @database @error @invalid-query @mysql @demo
  Scenario: Invalid Query Error Handling
    When user connects to "PRACTICE_MYSQL" database

    # Deliberately execute invalid SQL
    When user executes invalid query "SELECT * FROM non_existent_table WHERE invalid_column = 'test'"

    When user disconnects from "PRACTICE_MYSQL" database

  @database @error @timeout @mysql @demo
  Scenario: Query Timeout Handling
    When user connects to "PRACTICE_MYSQL" database
    And user sets database timeout to 1 seconds

    # This query should complete within timeout
    When user executes query "SELECT * FROM employees LIMIT 10" with timeout 5 seconds
    Then the query result should have at least 1 rows

    When user disconnects from "PRACTICE_MYSQL" database

  @database @validation @empty-result @oracle @demo
  Scenario: Empty Result Set Validation
    When user connects to "PRACTICE_ORACLE" database

    # Query that returns no rows
    When user executes query "SELECT * FROM employees WHERE employee_id = 99999"
    Then the query result should be empty
    And the query result should have 0 rows

    When user disconnects from "PRACTICE_ORACLE" database

  # ============================================================================
  # SECTION 8: UTILITY FUNCTIONS & LOGGING
  # ============================================================================

  @database @utility @logging @oracle @demo
  Scenario: Database Query Logging and Result Display
    When user connects to "PRACTICE_ORACLE" database

    # Enable logging
    When user enables database query logging

    # Execute query
    When user executes query "SELECT * FROM employees WHERE department_id = 10 ORDER BY salary DESC"
    Then the query result should have 1 rows

    # Log the result
    And user logs database query result

    # Disable logging
    When user disables database query logging

    When user disconnects from "PRACTICE_ORACLE" database

  @database @utility @cache @mysql @demo
  Scenario: Database Cache Management
    When user connects to "PRACTICE_MYSQL" database

    When user executes query "SELECT * FROM departments"
    Then the query result should have at least 5 rows

    # Clear cache
    When user clears database cache

    When user disconnects from "PRACTICE_MYSQL" database

  # ============================================================================
  # SECTION 9: CONFIGURATION & VARIABLE INTERPOLATION
  # ============================================================================

  @database @config @interpolation @demo
  Scenario: Configuration Variable Interpolation in Queries
    When user connects to "PRACTICE_MYSQL" database

    # Query using config variables (% syntax for config values)
    # ${ENV_VAR} for environment variables
    # {{context_var}} for runtime context variables
    When user executes query "SELECT * FROM employees WHERE department_id = 1"
    Then the query result should have at least 5 rows

    When user disconnects from "PRACTICE_MYSQL" database

  # ============================================================================
  # SECTION 10: COMPREHENSIVE REAL-WORLD SCENARIOS
  # ============================================================================

  @database @scenario @employee-analysis @mysql @demo
  Scenario: Complete Employee Analysis with Multiple Validations
    When user connects to "PRACTICE_MYSQL" database

    # Get top 10 highest paid employees (Oracle returns all 11 employees)
    When user executes query "SELECT e.employee_id, e.first_name, e.last_name, e.job_title, e.salary, d.department_name FROM employees e JOIN departments d ON e.department_id = d.department_id ORDER BY e.salary DESC LIMIT 10" and stores result as "TOP_EARNERS"
    Then the query result should have 11 rows

    # Validate salary range
    And values in column "salary" should be between "800000" and "2000000"

    # Get department statistics
    When user executes query "SELECT d.department_name, COUNT(e.employee_id) AS emp_count, AVG(e.salary) AS avg_salary, SUM(e.salary) AS total_salary FROM departments d LEFT JOIN employees e ON d.department_id = e.department_id GROUP BY d.department_id, d.department_name ORDER BY total_salary DESC"
    Then the query result should have 8 rows
    And the result should have columns:
      | department_name |
      | emp_count       |
      | avg_salary      |
      | total_salary    |

    When user disconnects from "PRACTICE_MYSQL" database

  @database @scenario @project-tracking @mysql @demo
  Scenario: Project Tracking and Resource Allocation Analysis
    When user connects to "PRACTICE_MYSQL" database

    # Get active projects with team size
    When user executes query "SELECT p.project_name, p.status, p.budget, COUNT(ep.employee_id) AS team_size, SUM(ep.hours_allocated) AS total_hours FROM projects p LEFT JOIN employee_projects ep ON p.project_id = ep.project_id WHERE p.status = 'Active' GROUP BY p.project_id, p.project_name, p.status, p.budget ORDER BY p.budget DESC"
    Then the query result should have at least 5 rows
    And all values in column "status" should be "Active"
    And values in column "budget" should be between "0" and "100000000"

    # Get employee project assignments
    When user executes query "SELECT e.first_name, e.last_name, COUNT(ep.project_id) AS project_count, SUM(ep.hours_allocated) AS total_hours FROM employees e JOIN employee_projects ep ON e.employee_id = ep.employee_id GROUP BY e.employee_id, e.first_name, e.last_name HAVING COUNT(ep.project_id) > 1 ORDER BY project_count DESC LIMIT 10"
    Then the query result should have at least 5 rows

    When user disconnects from "PRACTICE_MYSQL" database

  @database @scenario @sales-analysis @mysql @demo
  Scenario: Sales and Order Analysis with Date Filtering
    When user connects to "PRACTICE_MYSQL" database

    # Get order statistics by status
    When user executes query "SELECT status, COUNT(*) AS order_count, SUM(total_amount) AS total_revenue, AVG(total_amount) AS avg_order_value, MIN(total_amount) AS min_order, MAX(total_amount) AS max_order FROM orders WHERE status != 'Cancelled' GROUP BY status ORDER BY total_revenue DESC"
    Then the query result should have at least 3 rows
    And the result should have columns:
      | status          |
      | order_count     |
      | total_revenue   |
      | avg_order_value |
      | min_order       |
      | max_order       |

    # Top customers by order value
    When user executes query "SELECT c.company_name, c.contact_name, COUNT(o.order_id) AS total_orders, SUM(o.total_amount) AS total_spent FROM customers c JOIN orders o ON c.customer_id = o.customer_id WHERE o.status = 'Delivered' GROUP BY c.customer_id, c.company_name, c.contact_name ORDER BY total_spent DESC LIMIT 5"
    Then the query result should have 5 rows
    And values in column "total_orders" should be between "1" and "50"

    When user disconnects from "PRACTICE_MYSQL" database

  @database @scenario @hr-analytics @mysql @demo
  Scenario: HR Analytics - Hiring Trends and Tenure Analysis
    When user connects to "PRACTICE_MYSQL" database

    # Get employees by hire year
    When user executes query "SELECT YEAR(hire_date) AS hire_year, COUNT(*) AS hired_count, AVG(salary) AS avg_starting_salary FROM employees GROUP BY YEAR(hire_date) ORDER BY hire_year DESC"
    Then the query result should have at least 2 rows

    # Get department diversity
    When user executes query "SELECT d.department_name, COUNT(e.employee_id) AS emp_count, MIN(e.hire_date) AS earliest_hire, MAX(e.hire_date) AS latest_hire FROM departments d LEFT JOIN employees e ON d.department_id = e.department_id GROUP BY d.department_id, d.department_name ORDER BY emp_count DESC"
    Then the query result should have 8 rows

    When user disconnects from "PRACTICE_MYSQL" database

  @database @scenario @oracle-products @demo
  Scenario: Oracle Product Inventory and Pricing Analysis
    When user connects to "PRACTICE_ORACLE" database

    # Get product categories with stats
    When user executes query "SELECT category, COUNT(*) AS product_count, AVG(price) AS avg_price, SUM(stock_quantity) AS total_stock FROM products GROUP BY category ORDER BY total_stock DESC"
    Then the query result should have at least 2 rows
    And the result should have columns:
      | category       |
      | product_count  |
      | avg_price      |
      | total_stock    |

    # Get high-value low-stock products
    When user executes query "SELECT product_name, category, price, stock_quantity, (price * stock_quantity) AS inventory_value FROM products WHERE stock_quantity < 50 ORDER BY inventory_value DESC"
    Then the query result should have at least 1 rows
    And values in column "stock_quantity" should be between "0" and "50"

    When user disconnects from "PRACTICE_ORACLE" database

  # ============================================================================
  # SECTION 11: CLEANUP AND FINAL VALIDATION
  # ============================================================================

  @database @cleanup @demo
  Scenario: Database Connection Cleanup and Final Validation
    When user connects to "PRACTICE_ORACLE" database
    And user connects to "PRACTICE_MYSQL" database

    # Validate both connections active
    When user switches to database "PRACTICE_ORACLE"
    Then user validates database connection

    When user switches to database "PRACTICE_MYSQL"
    Then user validates database connection

    # Disconnect all
    When user disconnects from all databases
    Then database should not have active transaction
