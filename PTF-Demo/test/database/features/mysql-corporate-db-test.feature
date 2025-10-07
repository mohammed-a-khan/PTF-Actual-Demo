Feature: MySQL Corporate Database Testing
  Complete testing of MySQL corporate database with real-world scenarios
  Testing actual database schema: departments, employees, projects, customers, orders

  Background:
    Given test execution starts for database testing

  @database @mysql @smoke
  Scenario: MySQL Corporate DB Connection and Basic Validation
    When user connects to "PRACTICE_MYSQL" database
    Then user validates database connection
    When user logs database statistics

    # Verify database tables exist
    When user executes query "SHOW TABLES"
    Then the query result should not be empty

    # Basic connectivity test
    When user executes query "SELECT DATABASE() as db_name, VERSION() as db_version, NOW() as current_time"
    Then the query result should have 1 rows
    And the value in row 1 column "db_name" should be "corporate_db"

    When user disconnects from "PRACTICE_MYSQL" database

  @database @mysql @departments
  Scenario: Department Table Operations and Validation
    When user connects to "PRACTICE_MYSQL" database

    # Get all departments
    When user executes query "SELECT * FROM departments ORDER BY department_id"
    Then the query result should have 8 rows

    # Verify specific departments
    When user executes query "SELECT department_name, location, budget FROM departments WHERE department_id = 1"
    Then the query result should have 1 rows
    And the value in row 1 column "department_name" should be "Engineering"
    And the value in row 1 column "location" should be "Hyderabad"
    And the value in row 1 column "budget" should be "5000000.00"

    # Test department count
    When user executes scalar query "SELECT COUNT(*) FROM departments"
    Then the scalar result should be "8"

    # Get departments by location
    When user executes query "SELECT department_name FROM departments WHERE location = 'Bangalore' ORDER BY department_name"
    Then the query result should have 2 rows
    And the value in row 1 column "department_name" should be "Marketing"
    And the value in row 2 column "department_name" should be "Research & Development"

    # Calculate total budget
    When user executes query "SELECT SUM(budget) as total_budget, AVG(budget) as avg_budget FROM departments"
    Then the query result should have 1 rows

    When user disconnects from "PRACTICE_MYSQL" database

  @database @mysql @employees
  Scenario: Employee Data Query and Analysis
    When user connects to "PRACTICE_MYSQL" database

    # Get total employee count
    When user executes scalar query "SELECT COUNT(*) FROM employees"
    Then the scalar result should be "50"

    # Get top 5 highest paid employees
    When user executes query "SELECT CONCAT(first_name, ' ', last_name) as full_name, job_title, salary FROM employees ORDER BY salary DESC LIMIT 5"
    Then the query result should have 5 rows
    And the value in row 1 column "job_title" should be "VP Finance"

    # Get employees by department
    When user executes query "SELECT COUNT(*) as eng_count FROM employees WHERE department_id = 1"
    Then the query result should have 1 rows
    And the value in row 1 column "eng_count" should be "15"

    # Get VPs (managers with no manager_id)
    When user executes query "SELECT first_name, last_name, job_title FROM employees WHERE manager_id IS NULL ORDER BY first_name"
    Then the query result should have 5 rows

    # Test salary statistics
    When user executes query "SELECT MIN(salary) as min_sal, MAX(salary) as max_sal, AVG(salary) as avg_sal FROM employees"
    Then the query result should have 1 rows

    # Verify specific employee
    When user executes query "SELECT email, phone, hire_date FROM employees WHERE first_name = 'Rajesh' AND last_name = 'Kumar'"
    Then the query result should have 1 rows
    And the value in row 1 column "email" should be "rajesh.kumar@company.com"
    And the value in row 1 column "phone" should be "+91-9876543210"

    When user disconnects from "PRACTICE_MYSQL" database

  @database @mysql @joins
  Scenario: Complex Joins - Employees with Department Details
    When user connects to "PRACTICE_MYSQL" database

    # Join employees with departments
    When user executes query:
      """
      SELECT
        e.first_name,
        e.last_name,
        e.job_title,
        e.salary,
        d.department_name,
        d.location
      FROM employees e
      INNER JOIN departments d ON e.department_id = d.department_id
      WHERE d.department_name = 'Engineering'
      ORDER BY e.salary DESC
      LIMIT 5
      """
    Then the query result should have 5 rows
    And the value in row 1 column "department_name" should be "Engineering"
    And the value in row 1 column "location" should be "Hyderabad"

    # Get department-wise employee count and average salary
    When user executes query:
      """
      SELECT
        d.department_name,
        COUNT(e.employee_id) as emp_count,
        AVG(e.salary) as avg_salary,
        MAX(e.salary) as max_salary
      FROM departments d
      LEFT JOIN employees e ON d.department_id = e.department_id
      GROUP BY d.department_id, d.department_name
      ORDER BY emp_count DESC
      LIMIT 3
      """
    Then the query result should have 3 rows

    # Manager-Employee relationship
    When user executes query:
      """
      SELECT
        CONCAT(e.first_name, ' ', e.last_name) as employee,
        CONCAT(m.first_name, ' ', m.last_name) as manager
      FROM employees e
      LEFT JOIN employees m ON e.manager_id = m.employee_id
      WHERE e.department_id = 1
      LIMIT 5
      """
    Then the query result should have 5 rows

    When user disconnects from "PRACTICE_MYSQL" database

  @database @mysql @projects
  Scenario: Project Management and Analysis
    When user connects to "PRACTICE_MYSQL" database

    # Get all active projects
    When user executes query "SELECT project_name, status, budget FROM projects WHERE status = 'Active' ORDER BY budget DESC"
    Then the query result should not be empty

    # Count projects by status
    When user executes query "SELECT status, COUNT(*) as project_count FROM projects GROUP BY status ORDER BY project_count DESC"
    Then the query result should have 2 rows

    # Get project with employee count
    When user executes query:
      """
      SELECT
        p.project_name,
        p.status,
        p.budget,
        COUNT(ep.employee_id) as team_size
      FROM projects p
      LEFT JOIN employee_projects ep ON p.project_id = ep.project_id
      GROUP BY p.project_id, p.project_name, p.status, p.budget
      ORDER BY team_size DESC
      LIMIT 5
      """
    Then the query result should have 5 rows

    # Get specific project details
    When user executes query "SELECT * FROM projects WHERE project_name = 'Cloud Migration Initiative'"
    Then the query result should have 1 rows
    And the value in row 1 column "status" should be "Active"

    # Calculate total project budget by department
    When user executes query:
      """
      SELECT
        d.department_name,
        SUM(p.budget) as total_project_budget,
        COUNT(p.project_id) as project_count
      FROM projects p
      INNER JOIN departments d ON p.department_id = d.department_id
      GROUP BY d.department_id, d.department_name
      ORDER BY total_project_budget DESC
      """
    Then the query result should not be empty

    When user disconnects from "PRACTICE_MYSQL" database

  @database @mysql @employee-projects
  Scenario: Employee Project Allocation Analysis
    When user connects to "PRACTICE_MYSQL" database

    # Get employees working on specific project
    When user executes query:
      """
      SELECT
        CONCAT(e.first_name, ' ', e.last_name) as employee_name,
        ep.role,
        ep.hours_allocated,
        p.project_name
      FROM employee_projects ep
      INNER JOIN employees e ON ep.employee_id = e.employee_id
      INNER JOIN projects p ON ep.project_id = p.project_id
      WHERE p.project_name = 'Cloud Migration Initiative'
      ORDER BY ep.hours_allocated DESC
      """
    Then the query result should have 6 rows

    # Get employees working on multiple projects
    When user executes query:
      """
      SELECT
        e.employee_id,
        CONCAT(e.first_name, ' ', e.last_name) as employee_name,
        COUNT(ep.project_id) as project_count,
        SUM(ep.hours_allocated) as total_hours
      FROM employees e
      INNER JOIN employee_projects ep ON e.employee_id = ep.employee_id
      GROUP BY e.employee_id, e.first_name, e.last_name
      HAVING project_count > 1
      ORDER BY project_count DESC
      """
    Then the query result should not be empty

    # Get project allocation statistics
    When user executes query:
      """
      SELECT
        p.project_name,
        COUNT(ep.employee_id) as team_members,
        SUM(ep.hours_allocated) as total_hours,
        AVG(ep.hours_allocated) as avg_hours
      FROM projects p
      INNER JOIN employee_projects ep ON p.project_id = ep.project_id
      GROUP BY p.project_id, p.project_name
      ORDER BY total_hours DESC
      LIMIT 5
      """
    Then the query result should have 5 rows

    When user disconnects from "PRACTICE_MYSQL" database

  @database @mysql @customers
  Scenario: Customer Data Management
    When user connects to "PRACTICE_MYSQL" database

    # Get total customer count
    When user executes scalar query "SELECT COUNT(*) FROM customers"
    Then the scalar result should be "12"

    # Get customers by country
    When user executes query "SELECT company_name, contact_name, city FROM customers WHERE country = 'India' ORDER BY city"
    Then the query result should have 12 rows

    # Get customers by city
    When user executes query:
      """
      SELECT
        city,
        COUNT(*) as customer_count
      FROM customers
      GROUP BY city
      ORDER BY customer_count DESC
      """
    Then the query result should not be empty

    # Get specific customer details
    When user executes query "SELECT * FROM customers WHERE company_name = 'Tech Solutions Pvt Ltd'"
    Then the query result should have 1 rows
    And the value in row 1 column "contact_name" should be "Arun Khanna"
    And the value in row 1 column "email" should be "contact@techsolutions.com"

    When user disconnects from "PRACTICE_MYSQL" database

  @database @mysql @orders
  Scenario: Order Processing and Revenue Analysis
    When user connects to "PRACTICE_MYSQL" database

    # Get total orders
    When user executes scalar query "SELECT COUNT(*) FROM orders"
    Then the scalar result should be "90"

    # Get orders by status
    When user executes query:
      """
      SELECT
        status,
        COUNT(*) as order_count,
        SUM(total_amount) as total_revenue
      FROM orders
      GROUP BY status
      ORDER BY total_revenue DESC
      """
    Then the query result should have 5 rows

    # Get delivered orders statistics
    When user executes query:
      """
      SELECT
        COUNT(*) as delivered_count,
        SUM(total_amount) as total_revenue,
        AVG(total_amount) as avg_order_value,
        MIN(total_amount) as min_order,
        MAX(total_amount) as max_order
      FROM orders
      WHERE status = 'Delivered'
      """
    Then the query result should have 1 rows

    # Get orders with customer details
    When user executes query:
      """
      SELECT
        o.order_id,
        c.company_name,
        o.order_date,
        o.total_amount,
        o.status
      FROM orders o
      INNER JOIN customers c ON o.customer_id = c.customer_id
      WHERE o.status = 'Pending'
      ORDER BY o.order_date DESC
      LIMIT 10
      """
    Then the query result should have 10 rows

    # Monthly revenue analysis
    When user executes query:
      """
      SELECT
        DATE_FORMAT(order_date, '%Y-%m') as month,
        COUNT(*) as order_count,
        SUM(total_amount) as monthly_revenue
      FROM orders
      WHERE status != 'Cancelled'
      GROUP BY DATE_FORMAT(order_date, '%Y-%m')
      ORDER BY month DESC
      LIMIT 6
      """
    Then the query result should not be empty

    When user disconnects from "PRACTICE_MYSQL" database

  @database @mysql @complex-analysis
  Scenario: Advanced Business Intelligence Queries
    When user connects to "PRACTICE_MYSQL" database

    # Employee performance - orders handled
    When user executes query:
      """
      SELECT
        CONCAT(e.first_name, ' ', e.last_name) as employee_name,
        d.department_name,
        COUNT(o.order_id) as orders_handled,
        SUM(o.total_amount) as total_sales
      FROM employees e
      INNER JOIN departments d ON e.department_id = d.department_id
      LEFT JOIN orders o ON e.employee_id = o.employee_id
      WHERE o.status = 'Delivered'
      GROUP BY e.employee_id, e.first_name, e.last_name, d.department_name
      ORDER BY total_sales DESC
      LIMIT 10
      """
    Then the query result should have 5 rows

    # Customer order history
    When user executes query:
      """
      SELECT
        c.company_name,
        c.city,
        COUNT(o.order_id) as total_orders,
        SUM(CASE WHEN o.status = 'Delivered' THEN 1 ELSE 0 END) as delivered_orders,
        SUM(o.total_amount) as total_spent
      FROM customers c
      LEFT JOIN orders o ON c.customer_id = o.customer_id
      GROUP BY c.customer_id, c.company_name, c.city
      ORDER BY total_spent DESC
      LIMIT 10
      """
    Then the query result should have 10 rows

    # Department-wise revenue contribution
    When user executes query:
      """
      SELECT
        d.department_name,
        COUNT(DISTINCT e.employee_id) as employee_count,
        COUNT(o.order_id) as orders_processed,
        SUM(o.total_amount) as revenue_generated
      FROM departments d
      INNER JOIN employees e ON d.department_id = e.department_id
      LEFT JOIN orders o ON e.employee_id = o.employee_id
      WHERE o.status = 'Delivered'
      GROUP BY d.department_id, d.department_name
      ORDER BY revenue_generated DESC
      """
    Then the query result should have 1 rows
    And the value in row 1 column "department_name" should be "Sales"

    When user disconnects from "PRACTICE_MYSQL" database

  @database @mysql @transactions
  Scenario: MySQL Transaction Testing with Real Data
    When user connects to "PRACTICE_MYSQL" database

    # Start transaction
    When user begins database transaction
    Then database should have active transaction

    # Query within transaction
    When user executes query "SELECT COUNT(*) as employee_count FROM employees" within transaction
    Then the query result should have 1 rows

    # Create savepoint
    When user creates savepoint "before_query"

    # Execute another query
    When user executes query "SELECT COUNT(*) as dept_count FROM departments" within transaction
    Then the query result should have 1 rows

    # Rollback to savepoint
    When user rolls back to savepoint "before_query"

    # Commit transaction
    When user commits database transaction
    Then database should not have active transaction

    When user disconnects from "PRACTICE_MYSQL" database

  @database @mysql @parameterized
  Scenario: Parameterized Queries for Security
    When user connects to "PRACTICE_MYSQL" database

    # Test parameterized query with employee search
    When user executes parameterized query "SELECT first_name, last_name, email FROM employees WHERE department_id = ? LIMIT 5" with parameters:
      | name          | value |
      | department_id | 1     |
    Then the query result should have 5 rows

    # Test with string parameter
    When user executes parameterized query "SELECT * FROM departments WHERE location = ?" with parameters:
      | name     | value      |
      | location | Hyderabad  |
    Then the query result should have 2 rows

    When user disconnects from "PRACTICE_MYSQL" database

  @database @mysql @export
  Scenario: Export Query Results to Files
    When user connects to "PRACTICE_MYSQL" database

    # Query employee data for export
    When user executes query:
      """
      SELECT
        e.first_name,
        e.last_name,
        e.email,
        e.job_title,
        e.salary,
        d.department_name
      FROM employees e
      INNER JOIN departments d ON e.department_id = d.department_id
      ORDER BY e.salary DESC
      LIMIT 10
      """
    Then the query result should have 10 rows

    # Export to CSV
    When user exports query result to "reports/top_employees.csv"

    # Export to JSON
    When user exports query result to "reports/top_employees.json"

    # Query project data for export
    When user executes query:
      """
      SELECT
        p.project_name,
        p.status,
        p.budget,
        d.department_name,
        COUNT(ep.employee_id) as team_size
      FROM projects p
      INNER JOIN departments d ON p.department_id = d.department_id
      LEFT JOIN employee_projects ep ON p.project_id = ep.project_id
      GROUP BY p.project_id, p.project_name, p.status, p.budget, d.department_name
      ORDER BY p.budget DESC
      """
    Then the query result should not be empty

    When user exports query result to "reports/projects_summary.csv"

    When user disconnects from "PRACTICE_MYSQL" database

  @database @mysql @data-validation
  Scenario: Advanced Data Validation
    When user connects to "PRACTICE_MYSQL" database

    # Get salary data for validation
    When user executes query "SELECT salary FROM employees WHERE department_id = 1 ORDER BY salary DESC LIMIT 10"
    Then the query result should have 10 rows

    # Validate all salaries are unique in result
    And all values in column "salary" should be unique

    # Get department budgets
    When user executes query "SELECT budget FROM departments ORDER BY budget DESC"
    Then the query result should have 8 rows

    # Validate statistics
    And the sum of column "budget" should be 25300000.00
    And the average of column "budget" should be 3162500.0

    # Check project names
    When user executes query "SELECT project_name FROM projects"
    Then column "project_name" should contain value "Cloud Migration Initiative"
    And column "project_name" should not contain value "Non-Existent Project"

    When user disconnects from "PRACTICE_MYSQL" database

  @database @mysql @error-handling
  Scenario: Error Handling and Edge Cases
    When user connects to "PRACTICE_MYSQL" database

    # Test invalid query
    When user executes invalid query "SELECT * FROM non_existent_table_xyz"

    # Test empty result set
    When user executes query "SELECT * FROM employees WHERE employee_id = 99999"
    Then the query result should be empty

    # Test NULL values
    When user executes query "SELECT manager_id FROM employees WHERE manager_id IS NULL LIMIT 1"
    Then the query result should have 1 rows
    And the value in row 1 column "manager_id" should be null

    # Test with timeout
    When user executes query "SELECT COUNT(*) as total FROM employees" with timeout 30 seconds
    Then the query result should have 1 rows

    When user disconnects from "PRACTICE_MYSQL" database

  @database @mysql @performance
  Scenario: Query Performance and Execution Plan
    When user connects to "PRACTICE_MYSQL" database

    # Execute complex query with plan analysis
    When user executes query with plan:
      """
      SELECT
        d.department_name,
        COUNT(e.employee_id) as emp_count,
        AVG(e.salary) as avg_salary
      FROM departments d
      LEFT JOIN employees e ON d.department_id = e.department_id
      GROUP BY d.department_id, d.department_name
      ORDER BY avg_salary DESC
      """

    # Log execution plan
    When user logs query execution plan

    # Test query timing
    When user executes query:
      """
      SELECT COUNT(*) as total_records
      FROM orders o
      INNER JOIN customers c ON o.customer_id = c.customer_id
      WHERE o.status = 'Delivered'
      """
    Then the query result should have 1 rows

    # Log database statistics
    When user logs database statistics

    When user disconnects from "PRACTICE_MYSQL" database
