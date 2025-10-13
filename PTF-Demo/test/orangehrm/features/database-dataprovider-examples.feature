@database @dataprovider @examples
Feature: Database DataProvider Examples
  Comprehensive examples showing database as datasource for data-driven testing
  Following the same pattern as CSV, JSON, XML, and Excel datasources

  Background:
    # IMPORTANT: Establish database connection first
    Given user connects to "PRACTICE_ORACLE" database

  # ================================================================
  # PATTERN 1: Examples with JSON Configuration (Direct Query)
  # ================================================================

  @dataprovider @direct-query @oracle
  Scenario Outline: Validate employees with direct SQL query
    When I verify employee "<employee_id>" exists
    Then employee name should be "<first_name>"
    And employee email should be "<email>"

    Examples: {"type": "database", "source": "database", "dbname": "PRACTICE_ORACLE", "query": "SELECT employee_id, first_name, email FROM employees WHERE department_id = 10"}


  # ================================================================
  # PATTERN 2: Examples with JSON Configuration (Named Query)
  # ================================================================

  # Define in .env file:
  # GET_ACTIVE_EMPLOYEES=SELECT employee_id, first_name, last_name, salary FROM employees WHERE salary > 50000 ORDER BY salary DESC

  @dataprovider @named-query @oracle
  Scenario Outline: Process high-earning employees using named query
    When I open employee profile for "<employee_id>"
    Then employee full name should be "<first_name> <last_name>"
    And salary should be "<salary>"

    Examples: {"type": "database", "source": "database", "dbname": "PRACTICE_ORACLE", "query": "GET_ACTIVE_EMPLOYEES"}


  # ================================================================
  # PATTERN 3: Examples with Filters
  # ================================================================

  @dataprovider @filtered @oracle
  Scenario Outline: Test high-salary engineering employees with filters
    When I search for employee "<employee_id>"
    Then employee should be in department "<department_id>"
    And salary should be "<salary>"
    And employee name should be "<first_name> <last_name>"

    Examples: {"type": "database", "source": "database", "dbname": "PRACTICE_ORACLE", "query": "SELECT * FROM employees", "filter": "salary>80000;department_id=1"}


  # ================================================================
  # PATTERN 4: @DataProvider Tag at Scenario Level
  # ================================================================

  @DataProvider(source="database", type="oracle", dbname="PRACTICE_ORACLE", query="SELECT employee_id, first_name, email FROM employees WHERE department_id = 10")
  @dataprovider @tag-syntax @oracle
  Scenario Outline: Validate employees using @DataProvider tag
    When I verify employee "<employee_id>" exists
    Then employee name should be "<first_name>"
    And employee email should be "<email>"


  # ================================================================
  # PATTERN 5: MySQL Database with Examples
  # ================================================================

  @dataprovider @mysql
  Scenario Outline: Validate active projects from MySQL
    When I open project "<project_id>"
    Then project name should be "<project_name>"
    And budget should be "<budget>"
    And status should be "<status>"

    Examples: {"type": "database", "source": "database", "dbname": "PRACTICE_MYSQL", "query": "SELECT project_id, project_name, budget, status FROM projects WHERE status = 'Active' LIMIT 5"}


  # ================================================================
  # PATTERN 6: Complex Join Query
  # ================================================================

  @dataprovider @joins @mysql
  Scenario Outline: Validate high-earner department assignments
    When I check employee "<employee_id>" assignment
    Then employee "<first_name> <last_name>" should be in "<department_name>" department
    And salary should be "<salary>"

    Examples: {"type": "database", "source": "database", "dbname": "PRACTICE_MYSQL", "query": "SELECT e.employee_id, e.first_name, e.last_name, d.department_name, e.salary FROM employees e INNER JOIN departments d ON e.department_id = d.department_id WHERE e.salary > 75000 ORDER BY e.salary DESC LIMIT 10"}


  # ================================================================
  # PATTERN 7: Aggregation Query
  # ================================================================

  @dataprovider @aggregation @oracle
  Scenario Outline: Validate department statistics
    When I review department "<department_id>" analytics
    Then employee count should be "<emp_count>"
    And average salary should be approximately "<avg_salary>"
    And highest salary should be "<max_salary>"

    Examples: {"type": "database", "source": "database", "dbname": "PRACTICE_ORACLE", "query": "SELECT department_id, COUNT(*) as emp_count, AVG(salary) as avg_salary, MAX(salary) as max_salary FROM employees GROUP BY department_id HAVING COUNT(*) > 2"}


  # ================================================================
  # PATTERN 8: Multiple Filter Operators
  # ================================================================

  @dataprovider @numeric-filters @mysql
  Scenario Outline: Validate mid-career high earners
    When I evaluate employee "<employee_id>"
    Then "<first_name>" should have salary of "<salary>"
    And experience should be between 5 and 15 years

    Examples: {"type": "database", "source": "database", "dbname": "PRACTICE_MYSQL", "query": "SELECT employee_id, first_name, salary, experience_years FROM employees", "filter": "salary>=80000;experience_years>5;experience_years<=15"}

  # Filter operators supported:
  # = (equals)           - department_id=10
  # != or <> (not equal) - status!=inactive
  # > (greater than)     - salary>50000
  # < (less than)        - age<65
  # >= (greater or equal)- salary>=80000
  # <= (less or equal)   - experience<=5


  # ================================================================
  # PATTERN 9: String Filter Matching
  # ================================================================

  @dataprovider @string-filter @oracle
  Scenario Outline: Validate software engineers only
    When I review engineer "<employee_id>"
    Then name should be "<first_name>"
    And email should be "<email>"
    And title should be "Software Engineer"

    Examples: {"type": "database", "source": "database", "dbname": "PRACTICE_ORACLE", "query": "SELECT employee_id, first_name, email, job_title FROM employees", "filter": "job_title=Software Engineer"}


  # ================================================================
  # PATTERN 10: Named Query with DB_QUERY_ Prefix
  # ================================================================

  # Define in .env file:
  # DB_QUERY_GET_DEPARTMENTS=SELECT department_id, department_name, manager_id FROM departments

  @dataprovider @db-query-prefix @oracle
  Scenario Outline: Validate department structure
    When I navigate to department "<department_id>"
    Then department name should be "<department_name>"
    And manager ID should be "<manager_id>"

    Examples: {"type": "database", "source": "database", "dbname": "PRACTICE_ORACLE", "query": "GET_DEPARTMENTS"}

  # Framework will look for:
  # 1. GET_DEPARTMENTS in config
  # 2. DB_QUERY_GET_DEPARTMENTS in config (if first not found)


  # ================================================================
  # PATTERN 11: @DataProvider with Filters
  # ================================================================

  @DataProvider(source="database", type="oracle", dbname="PRACTICE_ORACLE", query="SELECT * FROM employees", filter="salary>80000;status=active")
  @dataprovider @tag-with-filter
  Scenario Outline: Test active high earners using tag
    When I verify employee "<employee_id>"
    Then salary should be greater than 80000
    And status should be "active"


  # ================================================================
  # PATTERN 12: Combined with Multiple Databases
  # ================================================================

  @dataprovider @multi-db @oracle
  Scenario Outline: Oracle employee validation
    When I validate Oracle employee "<employee_id>"
    Then first name should be "<first_name>"

    Examples: {"type": "database", "source": "database", "dbname": "PRACTICE_ORACLE", "query": "SELECT employee_id, first_name FROM employees LIMIT 3"}

  @dataprovider @multi-db @mysql
  Scenario Outline: MySQL employee validation
    # Switch to MySQL database
    Given user connects to "PRACTICE_MYSQL" database

    When I validate MySQL employee "<employee_id>"
    Then first name should be "<first_name>"

    Examples: {"type": "database", "source": "database", "dbname": "PRACTICE_MYSQL", "query": "SELECT employee_id, first_name FROM employees LIMIT 3"}


  # ================================================================
  # NOTES AND BEST PRACTICES
  # ================================================================

  # 1. ALWAYS establish database connection in Background or before Scenario Outline
  # 2. Use named queries for better maintainability (define in .env)
  # 3. Apply filters to reduce data volume and focus tests
  # 4. Use LIMIT clause in queries to avoid excessive iterations
  # 5. Column names in query results become placeholder names (<column_name>)
  # 6. Filter syntax: "column=value;column>value;column<value" (semicolon-separated)

  # TWO SYNTAX OPTIONS:
  #
  # Option 1: Examples with JSON (like CSV, JSON, XML, Excel)
  #   Examples: {"type": "database", "source": "database", "dbname": "PRACTICE_ORACLE", "query": "SELECT * FROM employees"}
  #
  # Option 2: @DataProvider tag
  #   @DataProvider(source="database", type="oracle", dbname="PRACTICE_ORACLE", query="SELECT * FROM employees")
  #   Scenario Outline: ...

  # FILTER OPERATORS:
  # =   equals (case-insensitive for strings)
  # !=  not equal
  # <>  not equal (alternative)
  # >   greater than
  # <   less than
  # >=  greater than or equal
  # <=  less than or equal

  # CONFIGURATION (.env):
  # GET_EMPLOYEES=SELECT employee_id, first_name, last_name, email, salary FROM employees WHERE status = 'active'
  # DB_QUERY_GET_DEPARTMENTS=SELECT * FROM departments WHERE active = 1
  # GET_RECENT_ORDERS=SELECT * FROM orders WHERE order_date > SYSDATE - 7

  # SUPPORTED DATABASES:
  # - SQL Server (type="sqlserver")
  # - MySQL (type="mysql")
  # - PostgreSQL (type="postgresql")
  # - Oracle (type="oracle")
  # - MongoDB (type="mongodb")
  # - Redis (type="redis")

  # ERROR HANDLING:
  # - "No active database connection" → Add: Given user connects to "DB_NAME" database
  # - "Named query 'X' not found" → Define X or DB_QUERY_X in .env
  # - "Column 'X' not found" → Check filter column names match query result columns
  # - "Database connection 'X' not found" → Verify connection name and ensure connected first
