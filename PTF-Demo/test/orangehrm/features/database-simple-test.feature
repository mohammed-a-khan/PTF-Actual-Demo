Feature: Simple Database Test
  Basic database connection and query test

  @database @simple @mysql
  Scenario: Simple MySQL Connection Test
    When user connects to "PRACTICE_MYSQL" database
    Then user validates database connection
    When user executes query "SELECT COUNT(*) FROM employees"
    Then the query result should have 1 rows
    When user disconnects from "PRACTICE_MYSQL" database

  @database @simple @oracle
  Scenario: Simple Oracle Connection Test
    When user connects to "PRACTICE_ORACLE" database
    Then user validates database connection
    When user executes query "SELECT COUNT(*) FROM employees"
    Then the query result should have 1 rows
    When user disconnects from "PRACTICE_ORACLE" database