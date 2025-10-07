Feature: Database Testing Comprehensive Demo
  Comprehensive testing of database functionality using CS Test Automation Framework
  Testing multiple database types and operations including:
  - Connection management
  - Query execution and validation
  - Transaction handling
  - Data validation
  - Utility operations

  Background:
    Given test execution starts for database testing

  @database @connection @mysql
  Scenario: MySQL Database Connection Test
    When user connects to "PRACTICE_MYSQL" database
    Then user validates database connection
    When user executes query "SELECT 1 as test_value, 'MySQL' as db_type, NOW() as current_time"
    Then the query result should have 1 rows
    And the value in row 1 column "test_value" should be "1"
    And the value in row 1 column "db_type" should be "MySQL"
    When user disconnects from "PRACTICE_MYSQL" database
    Then database should not have active transaction

  @database @connection @postgresql
  Scenario: PostgreSQL Database Connection Test
    When user connects to "PRACTICE_POSTGRES" database
    Then user validates database connection
    When user executes query "SELECT 1 as test_value, 'PostgreSQL' as db_type, CURRENT_TIMESTAMP as current_time"
    Then the query result should have 1 rows
    And the value in row 1 column "test_value" should be "1"
    And the value in row 1 column "db_type" should be "PostgreSQL"
    When user logs database statistics
    When user disconnects from "PRACTICE_POSTGRES" database

  @database @validation @mysql
  Scenario: MySQL Data Validation and Query Operations
    When user connects to "PRACTICE_MYSQL" database
    # Test basic query execution
    When user executes query "SELECT 10 as num_value, 'test' as text_value, 1.5 as float_value"
    Then the query result should have 1 rows
    And the value in row 1 column "num_value" should be "10"
    And the value in row 1 column "text_value" should be "test"
    And the value in row 1 column "float_value" should be "1.5"

    # Test query with parameters
    When user executes parameterized query "SELECT ? as param1, ? as param2" with parameters:
      | name   | value |
      | param1 | hello |
      | param2 | world |
    Then the query result should have 1 rows
    And the value in row 1 column "param1" should be "hello"
    And the value in row 1 column "param2" should be "world"

    # Test multiple rows validation
    When user executes query "SELECT 1 as id, 'Alice' as name UNION SELECT 2, 'Bob' UNION SELECT 3, 'Charlie'"
    Then the query result should have 3 rows
    And the value in row 1 column "id" should be "1"
    And the value in row 1 column "name" should be "Alice"
    And the value in row 2 column "name" should be "Bob"
    And the value in row 3 column "name" should be "Charlie"

    When user disconnects from "PRACTICE_MYSQL" database

  @database @transactions @mysql
  Scenario: MySQL Transaction Management
    When user connects to "PRACTICE_MYSQL" database

    # Test transaction basics
    When user begins database transaction
    Then database should have active transaction

    When user executes query "SELECT 'transaction test' as message" within transaction
    Then the query result should have 1 rows
    And the value in row 1 column "message" should be "transaction test"

    # Test savepoints
    When user creates savepoint "test_savepoint"
    When user executes query "SELECT 'after savepoint' as status" within transaction

    # Test rollback to savepoint
    When user rolls back to savepoint "test_savepoint"
    When user executes query "SELECT 'rolled back' as status" within transaction

    # Commit transaction
    When user commits database transaction
    Then database should not have active transaction

    When user disconnects from "PRACTICE_MYSQL" database

  @database @export @mysql
  Scenario: Database Export and Utility Functions
    When user connects to "PRACTICE_MYSQL" database

    # Generate test data
    When user executes query "SELECT 1 as id, 'John' as name, 25 as age, 50000.00 as salary UNION SELECT 2, 'Jane', 30, 60000.00 UNION SELECT 3, 'Bob', 35, 70000.00"
    Then the query result should have 3 rows

    # Test data validation
    And the sum of column "age" should be 90.0
    And the average of column "salary" should be 60000.0
    And the minimum value in column "age" should be "25"
    And the maximum value in column "salary" should be "70000.00"

    # Test column validation
    And all values in column "id" should be unique
    And column "name" should contain value "John"
    And column "name" should not contain value "Tom"

    # Test export functionality
    When user exports query result to "test_export.csv"
    When user exports query result to "test_export.json"

    # Test query profiling
    When user executes query with plan "SELECT COUNT(*) as total_records FROM (SELECT 1 UNION SELECT 2 UNION SELECT 3) as temp"
    When user logs query execution plan

    When user disconnects from "PRACTICE_MYSQL" database

  @database @error-handling @mysql
  Scenario: Database Error Handling and Edge Cases
    When user connects to "PRACTICE_MYSQL" database

    # Test invalid query handling
    When user executes invalid query "SELECT * FROM non_existent_table"

    # Test empty results
    When user executes query "SELECT 1 as value WHERE 1=0"
    Then the query result should be empty

    # Test null value validation
    When user executes query "SELECT NULL as null_value, 'not null' as text_value"
    Then the value in row 1 column "null_value" should be null
    And the value in row 1 column "text_value" should not be null

    # Test timeout (this should work quickly)
    When user executes query "SELECT 1 as fast_query" with timeout 30 seconds

    When user disconnects from "PRACTICE_MYSQL" database

  @database @multi-connection
  Scenario: Multiple Database Connections
    # Connect to MySQL
    When user connects to "PRACTICE_MYSQL" database
    When user executes query "SELECT 'MySQL connection' as db_info"
    And user stores query result as "mysql_result"

    # Connect to PostgreSQL (if available)
    When user connects to "PRACTICE_POSTGRES" database
    When user executes query "SELECT 'PostgreSQL connection' as db_info"
    And user stores query result as "postgres_result"

    # Switch back to MySQL
    When user switches to "PRACTICE_MYSQL" database
    When user executes query "SELECT 'Back to MySQL' as db_info"

    # Disconnect all
    When user disconnects from "PRACTICE_MYSQL" database
    When user disconnects from "PRACTICE_POSTGRES" database

  @database @batch-operations @mysql
  Scenario: Batch Query Operations
    When user connects to "PRACTICE_MYSQL" database

    # Test batch query execution
    When user executes batch queries:
      """
      SELECT 1 as batch_test;
      SELECT 2 as batch_test;
      SELECT 3 as batch_test
      """
    Then the query result should have 1 rows
    And the value in row 1 column "batch_test" should be "3"

    # Test query with limit
    When user executes query "SELECT number FROM (SELECT 1 as number UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5) as numbers ORDER BY number" with limit 3
    Then the query result should have 3 rows

    # Test scalar query
    When user executes scalar query "SELECT COUNT(*) FROM (SELECT 1 UNION SELECT 2 UNION SELECT 3) as temp"
    Then the scalar result should be "3"

    When user disconnects from "PRACTICE_MYSQL" database

  @database @wait-operations
  Scenario: Database Wait and Timing Operations
    When user connects to "PRACTICE_MYSQL" database

    # Test basic wait
    When user waits for database 2 seconds

    # Test query execution timing
    When user executes query "SELECT 'timing test' as message, SLEEP(1) as delay"
    Then the query result should have 1 rows

    # Log final statistics
    When user logs database statistics

    When user disconnects from "PRACTICE_MYSQL" database

  @database @connection-string
  Scenario: Connection String Testing
    # Test connection using connection string (MySQL example)
    When user connects with connection string "mysql://root@localhost:3306/testdb"
    Then user validates database connection
    When user executes query "SELECT 'Connection string test' as connection_type"
    Then the query result should have 1 rows
    When user disconnects from current database

  @database @health-check
  Scenario: Database Health Monitoring
    When user connects to "PRACTICE_MYSQL" database with timeout 30 seconds
    Then user validates database connection

    # Test connection health
    When user checks database connection health
    When user logs database statistics

    # Test query result logging
    When user executes query "SELECT 'health check' as status, NOW() as check_time"
    When user logs database query result

    When user disconnects from "PRACTICE_MYSQL" database