@database @sqlserver @corporate @smoke
Feature: Microsoft SQL Server Database Testing - CorporateDB
  Comprehensive SQL Server database testing using the CorporateDB database.
  Tests SQL Authentication, Windows Authentication, stored procedures, transactions, and more.

  Database: Corporate DB
  Host: localhost
  Port: 1433
  User: corpuser / Windows Authentication

  Background:
    Given test execution starts for database testing
    Then we should have database testing capability

  # ============================================================================
  # SECTION 1: CONNECTION & BASIC QUERIES
  # ============================================================================

  @sqlserver @connection @sql-auth
  Scenario: SQL Server Connection with SQL Authentication
    When user connects to "CORPORATE_SQLSERVER" database
    Then user verifies database connection
    And user validates database connection

    # Verify database details
    When user executes query "SELECT DB_NAME() AS DatabaseName, @@VERSION AS Version"
    Then the query result should have 1 rows
    And the value in row 1 column "DatabaseName" should be "CorporateDB"

    When user disconnects from "CORPORATE_SQLSERVER" database

  @sqlserver @query @basic
  Scenario: SQL Server Basic Query Execution
    When user connects to "CORPORATE_SQLSERVER" database

    # Test basic SELECT
    When user executes query "SELECT * FROM Employees WHERE EmployeeID = 1"
    Then the query result should have 1 rows
    And the value in row 1 column "FirstName" should be "Rajesh"
    And the value in row 1 column "LastName" should be "Kumar"
    And the value in row 1 column "Email" should be "rajesh.kumar@company.com"
    And the value in row 1 column "JobTitle" should be "VP Engineering"
    And the value in row 1 column "Salary" should be "1800000.00"

    When user disconnects from "CORPORATE_SQLSERVER" database

  @sqlserver @query @joins
  Scenario: SQL Server JOIN Queries
    When user connects to "CORPORATE_SQLSERVER" database

    # Test INNER JOIN
    When user executes query "SELECT e.EmployeeID, e.FirstName, e.LastName, d.DepartmentName, d.Location FROM Employees e INNER JOIN Departments d ON e.DepartmentID = d.DepartmentID WHERE e.EmployeeID = 6"
    Then the query result should have 1 rows
    And the value in row 1 column "DepartmentName" should be "Engineering"
    And the value in row 1 column "Location" should be "Hyderabad"

    # Test LEFT JOIN with GROUP BY
    When user executes query "SELECT d.DepartmentName, COUNT(e.EmployeeID) AS EmployeeCount FROM Departments d LEFT JOIN Employees e ON d.DepartmentID = e.DepartmentID GROUP BY d.DepartmentName ORDER BY EmployeeCount DESC"
    Then the query result should have at least 8 rows

    When user disconnects from "CORPORATE_SQLSERVER" database

  @sqlserver @query @aggregation
  Scenario: SQL Server Aggregate Functions
    When user connects to "CORPORATE_SQLSERVER" database

    # Test COUNT
    When user executes count query "SELECT COUNT(*) AS TotalEmployees FROM Employees"
    Then the scalar result should be "45"

    # Test AVG, MIN, MAX
    When user executes query "SELECT AVG(Salary) AS AvgSalary, MIN(Salary) AS MinSalary, MAX(Salary) AS MaxSalary FROM Employees"
    Then the query result should have 1 rows
    And the value in row 1 column "MaxSalary" should be "1900000.00"

    When user disconnects from "CORPORATE_SQLSERVER" database

  @sqlserver @query @cte
  Scenario: SQL Server Common Table Expressions
    When user connects to "CORPORATE_SQLSERVER" database

    # Test CTE
    When user executes query "WITH HighEarners AS (SELECT EmployeeID, FirstName, LastName, Salary FROM Employees WHERE Salary > 1000000) SELECT * FROM HighEarners ORDER BY Salary DESC"
    Then the query result should have at least 5 rows

    When user disconnects from "CORPORATE_SQLSERVER" database

  # ============================================================================
  # SECTION 2: PARAMETERIZED QUERIES
  # ============================================================================

  @sqlserver @parameterized @security
  Scenario: SQL Server Parameterized Queries
    When user connects to "CORPORATE_SQLSERVER" database

    # Test single parameter
    When user executes parameterized query "SELECT * FROM Employees WHERE EmployeeID = ?" with parameters:
      | 1 |
    Then the query result should have 1 rows
    And the value in row 1 column "FirstName" should be "Rajesh"

    # Test multiple parameters
    When user executes parameterized query "SELECT * FROM Employees WHERE DepartmentID = ? AND Salary > ?" with parameters:
      | 1      |
      | 700000 |
    Then the query result should have at least 2 rows
    And all values in column "DepartmentID" should be "1"

    # Test INSERT with parameters (EmployeeID auto-generated)
    When user executes parameterized query "INSERT INTO Employees (FirstName, LastName, Email, JobTitle, Salary, DepartmentID, HireDate) VALUES (?, ?, ?, ?, ?, ?, ?)" with parameters:
      | Test                      |
      | User                      |
      | test.user@company.com     |
      | Test Engineer             |
      | 500000                    |
      | 1                         |
      | 2024-01-01                |

    # Verify insertion using unique email
    When user executes parameterized query "SELECT * FROM Employees WHERE Email = ?" with parameters:
      | test.user@company.com |
    Then the query result should have 1 rows
    And the value in row 1 column "FirstName" should be "Test"
    And the value in row 1 column "LastName" should be "User"

    # Cleanup using email
    When user executes parameterized query "DELETE FROM Employees WHERE Email = ?" with parameters:
      | test.user@company.com |

    When user disconnects from "CORPORATE_SQLSERVER" database

  @sqlserver @parameterized @injection
  Scenario: SQL Server SQL Injection Prevention
    When user connects to "CORPORATE_SQLSERVER" database

    # Attempt SQL injection (prevented by parameterization)
    When user executes parameterized query "SELECT * FROM Employees WHERE FirstName = ?" with parameters:
      | Rajesh' OR '1'='1 |
    Then the query result should have 0 rows

    # Verify normal query works
    When user executes parameterized query "SELECT * FROM Employees WHERE FirstName = ?" with parameters:
      | Rajesh |
    Then the query result should have 1 rows

    When user disconnects from "CORPORATE_SQLSERVER" database

  # ============================================================================
  # SECTION 3: STORED PROCEDURES
  # ============================================================================

  @sqlserver @stored-procedure
  Scenario: SQL Server Stored Procedure Execution
    When user connects to "CORPORATE_SQLSERVER" database

    # Test sp_GetEmployeeByID
    When user executes stored procedure "sp_GetEmployeeByID" with parameters:
      | 1 |
    Then the query result should have 1 rows
    And the value in row 1 column "FullName" should be "Rajesh Kumar"
    And the value in row 1 column "Email" should be "rajesh.kumar@company.com"
    And the value in row 1 column "JobTitle" should be "VP Engineering"
    And the value in row 1 column "DepartmentName" should be "Engineering"

    # Test sp_GetEmployeesByDepartment
    When user executes stored procedure "sp_GetEmployeesByDepartment" with parameters:
      | Engineering |
    Then the query result should have at least 5 rows

    # Test sp_GetDepartmentSummary
    When user executes stored procedure "sp_GetDepartmentSummary"
    Then the query result should have 8 rows

    # Test sp_GetProjectTeam
    When user executes stored procedure "sp_GetProjectTeam" with parameters:
      | 1 |
    Then the query result should have at least 1 rows

    When user disconnects from "CORPORATE_SQLSERVER" database

  @sqlserver @stored-procedure @update
  Scenario: SQL Server Update via Stored Procedure
    When user connects to "CORPORATE_SQLSERVER" database

    # Update salary using stored procedure
    When user executes stored procedure "sp_UpdateEmployeeSalary" with parameters:
      | 7      |
      | 800000 |
      | Admin  |
    Then the query result should have 1 rows
    And the value in row 1 column "Status" should be "Success"
    And the value in row 1 column "NewSalary" should be "800000.00"

    # Verify salary was updated
    When user executes query "SELECT Salary FROM Employees WHERE EmployeeID = 7"
    Then the value in row 1 column "Salary" should be "800000.00"

    # Restore original salary
    When user executes parameterized query "UPDATE Employees SET Salary = ? WHERE EmployeeID = ?" with parameters:
      | 750000 |
      | 7      |

    When user disconnects from "CORPORATE_SQLSERVER" database

  # ============================================================================
  # SECTION 4: TRANSACTIONS
  # ============================================================================

  @sqlserver @transaction @commit
  Scenario: SQL Server Transaction with COMMIT
    When user connects to "CORPORATE_SQLSERVER" database
    And user begins database transaction

    # Insert test data (EmployeeID auto-generated)
    When user executes query "INSERT INTO Employees (FirstName, LastName, Email, JobTitle, Salary, DepartmentID, HireDate) VALUES ('Transaction', 'Test', 'transaction.test@company.com', 'Test Engineer', 550000, 1, '2024-01-01')"

    # Verify data exists
    When user executes query "SELECT * FROM Employees WHERE Email = 'transaction.test@company.com'"
    Then the query result should have 1 rows

    # Commit
    When user commits database transaction
    Then database should not have active transaction

    # Verify data persists
    When user executes query "SELECT * FROM Employees WHERE Email = 'transaction.test@company.com'"
    Then the query result should have 1 rows

    # Cleanup
    When user executes query "DELETE FROM Employees WHERE Email = 'transaction.test@company.com'"

    When user disconnects from "CORPORATE_SQLSERVER" database

  @sqlserver @transaction @rollback
  Scenario: SQL Server Transaction with ROLLBACK
    When user connects to "CORPORATE_SQLSERVER" database

    # Cleanup any existing test data from previous runs
    When user executes query "DELETE FROM Employees WHERE Email = 'rollback.test@company.com'"

    And user begins database transaction

    # Insert test data
    When user executes query "INSERT INTO Employees (FirstName, LastName, Email, JobTitle, Salary, DepartmentID, HireDate) VALUES ('Rollback', 'Test', 'rollback.test@company.com', 'Test Engineer', 550000, 1, '2024-01-01')"

    # Verify data exists
    When user executes query "SELECT * FROM Employees WHERE Email = 'rollback.test@company.com'"
    Then the query result should have 1 rows

    # Rollback
    When user rolls back database transaction
    Then database should not have active transaction

    # Verify data was rolled back
    When user executes query "SELECT * FROM Employees WHERE Email = 'rollback.test@company.com'"
    Then the query result should have 0 rows

    When user disconnects from "CORPORATE_SQLSERVER" database

  @sqlserver @transaction @savepoint
  Scenario: SQL Server Transaction with Savepoints
    When user connects to "CORPORATE_SQLSERVER" database

    # Cleanup any existing test data from previous runs
    When user executes query "DELETE FROM Employees WHERE Email IN ('savepoint1@company.com', 'savepoint2@company.com')"

    And user begins database transaction

    # Insert first employee
    When user executes query "INSERT INTO Employees (FirstName, LastName, Email, JobTitle, Salary, DepartmentID, HireDate) VALUES ('Savepoint', 'One', 'savepoint1@company.com', 'Engineer', 600000, 1, '2024-01-01')"

    # Create savepoint
    When user creates savepoint "SP1"

    # Insert second employee
    When user executes query "INSERT INTO Employees (FirstName, LastName, Email, JobTitle, Salary, DepartmentID, HireDate) VALUES ('Savepoint', 'Two', 'savepoint2@company.com', 'Engineer', 650000, 1, '2024-01-01')"

    # Rollback to savepoint
    When user rolls back to savepoint "SP1"

    # Verify first exists, second does not
    When user executes query "SELECT * FROM Employees WHERE Email = 'savepoint1@company.com'"
    Then the query result should have 1 rows

    When user executes query "SELECT * FROM Employees WHERE Email = 'savepoint2@company.com'"
    Then the query result should have 0 rows

    # Rollback entire transaction
    When user rolls back database transaction

    When user disconnects from "CORPORATE_SQLSERVER" database

  # ============================================================================
  # SECTION 5: VIEWS
  # ============================================================================

  @sqlserver @views
  Scenario: SQL Server Views
    When user connects to "CORPORATE_SQLSERVER" database

    # Query vw_EmployeeFullDetails
    When user executes query "SELECT * FROM vw_EmployeeFullDetails WHERE EmployeeID = 1"
    Then the query result should have 1 rows
    And the value in row 1 column "FullName" should be "Rajesh Kumar"
    And the value in row 1 column "DepartmentName" should be "Engineering"

    # Query vw_ProjectSummary
    When user executes query "SELECT * FROM vw_ProjectSummary WHERE Status = 'Active' ORDER BY Budget DESC"
    Then the query result should have at least 5 rows

    # Query vw_CustomerOrderSummary
    When user executes query "SELECT TOP 10 * FROM vw_CustomerOrderSummary ORDER BY TotalRevenue DESC"
    Then the query result should have 10 rows

    When user disconnects from "CORPORATE_SQLSERVER" database

  # ============================================================================
  # SECTION 6: DATA VALIDATION
  # ============================================================================

  @sqlserver @validation @cell
  Scenario: SQL Server Cell-Level Validation
    When user connects to "CORPORATE_SQLSERVER" database

    When user executes query "SELECT * FROM Employees WHERE EmployeeID = 6"
    Then the query result should have 1 rows

    # Exact match
    And the value in row 1 column "FirstName" should be "Anita"
    And the value in row 1 column "LastName" should be "Iyer"
    And the value in row 1 column "Salary" should be "950000.00"

    # Contains
    And the value in row 1 column "Email" should contain "@company.com"
    And the value in row 1 column "JobTitle" should contain "Developer"

    # Pattern (regex)
    And the value in row 1 column "Email" should match pattern "^[a-z.]+@company\.com$"
    And the value in row 1 column "Phone" should match pattern "^\+91-\d{10}$"

    # Null checks
    And the value in row 1 column "FirstName" should not be null
    And the value in row 1 column "Email" should not be null

    When user disconnects from "CORPORATE_SQLSERVER" database

  @sqlserver @validation @column
  Scenario: SQL Server Column-Level Validation
    When user connects to "CORPORATE_SQLSERVER" database

    # Get Engineering employees
    When user executes query "SELECT * FROM Employees WHERE DepartmentID = 1 ORDER BY EmployeeID"
    Then the query result should have at least 10 rows

    # All values in column
    And all values in column "DepartmentID" should be "1"

    # Column contains value
    And column "JobTitle" should contain value "Software Engineer"
    And column "JobTitle" should contain value "Senior Developer"

    # Unique values
    And all values in column "Email" should be unique
    And all values in column "EmployeeID" should be unique

    When user disconnects from "CORPORATE_SQLSERVER" database

  # ============================================================================
  # SECTION 7: PERFORMANCE
  # ============================================================================

  @sqlserver @performance
  Scenario: SQL Server Query with Limit and Timeout
    When user connects to "CORPORATE_SQLSERVER" database

    # Query with limit
    When user executes query "SELECT TOP 5 * FROM Employees ORDER BY EmployeeID" with limit 5
    Then the query result should have 5 rows

    # Query with timeout
    When user executes query "SELECT * FROM Projects WHERE Status = 'Active'" with timeout 10 seconds
    Then the query result should have at least 1 rows

    When user disconnects from "CORPORATE_SQLSERVER" database

  @sqlserver @performance @batch
  Scenario: SQL Server Batch Queries
    When user connects to "CORPORATE_SQLSERVER" database
    And user enables database query logging

    # Execute batch
    When user executes batch queries:
      """
      SELECT COUNT(*) AS EmployeeCount FROM Employees;
      SELECT COUNT(*) AS DepartmentCount FROM Departments;
      SELECT COUNT(*) AS ProjectCount FROM Projects;
      """
    Then the query result should have at least 1 rows

    When user disables database query logging
    And user disconnects from "CORPORATE_SQLSERVER" database

  # ============================================================================
  # SECTION 8: T-SQL FEATURES
  # ============================================================================

  @sqlserver @tsql @variables
  Scenario: SQL Server T-SQL Variables
    When user connects to "CORPORATE_SQLSERVER" database

    # Use T-SQL variables
    When user executes query "DECLARE @MinSalary MONEY = 1000000; SELECT * FROM Employees WHERE Salary > @MinSalary ORDER BY Salary DESC"
    Then the query result should have at least 3 rows

    When user disconnects from "CORPORATE_SQLSERVER" database

  @sqlserver @tsql @string-functions
  Scenario: SQL Server String Functions
    When user connects to "CORPORATE_SQLSERVER" database

    When user executes query "SELECT CONCAT(FirstName, ' ', LastName) AS FullName, UPPER(Email) AS UpperEmail, LEN(JobTitle) AS TitleLength FROM Employees WHERE EmployeeID = 1"
    Then the query result should have 1 rows
    And the value in row 1 column "FullName" should be "Rajesh Kumar"

    When user disconnects from "CORPORATE_SQLSERVER" database

  @sqlserver @tsql @case
  Scenario: SQL Server CASE Statements
    When user connects to "CORPORATE_SQLSERVER" database

    When user executes query "SELECT EmployeeID, FirstName, LastName, Salary, CASE WHEN Salary < 600000 THEN 'Low' WHEN Salary BETWEEN 600000 AND 1000000 THEN 'Medium' ELSE 'High' END AS SalaryBand FROM Employees ORDER BY Salary DESC"
    Then the query result should have 45 rows
    And column "SalaryBand" should contain value "High"
    And column "SalaryBand" should contain value "Medium"
    And column "SalaryBand" should contain value "Low"

    When user disconnects from "CORPORATE_SQLSERVER" database

  # ============================================================================
  # SECTION 9: PREDEFINED QUERIES
  # ============================================================================

  @sqlserver @predefined
  Scenario: SQL Server Predefined Queries from ENV
    When user connects to "CORPORATE_SQLSERVER" database

    When user executes predefined query "SQLSERVER_GET_ALL_EMPLOYEES"
    Then the query result should have 45 rows

    When user executes predefined query "SQLSERVER_GET_EMPLOYEE_COUNT"
    Then the query result should have 1 rows

    When user executes predefined query "SQLSERVER_GET_TOP_EARNERS"
    Then the query result should have 10 rows

    When user executes predefined query "SQLSERVER_GET_ACTIVE_PROJECTS"
    Then the query result should have at least 5 rows

    When user disconnects from "CORPORATE_SQLSERVER" database
