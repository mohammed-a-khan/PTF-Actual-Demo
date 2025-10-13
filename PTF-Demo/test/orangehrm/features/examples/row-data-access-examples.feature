@row-data @examples @data-driven
Feature: Access Complete Row Data in Step Definitions
  This feature demonstrates how to access the entire data row from Examples table
  in your step definitions, enabling powerful data-driven testing scenarios.

  Background:
    # Setup if needed
    Given user is on the test page

  # ================================================================
  # PATTERN 1: Access Individual Fields (Traditional Way)
  # ================================================================

  @individual-fields
  Scenario Outline: Verify employee details using individual fields
    When I verify employee "<employee_id>"
    Then name should be "<first_name> <last_name>"
    And email should be "<email>"
    And salary should be "<salary>"

    Examples:
      | employee_id | first_name | last_name | email              | salary |
      | 101         | John       | Doe       | john.doe@test.com  | 50000  |
      | 102         | Jane       | Smith     | jane.smith@test.com| 60000  |


  # ================================================================
  # PATTERN 2: Access Complete Row as JSON using {currentRow}
  # ================================================================

  @complete-row-json
  Scenario Outline: Verify employee using complete row data
    # You can pass the entire row as JSON to your step definition
    When I verify employee details with data "{currentRow}"
    Then employee should match expected data

    Examples:
      | employee_id | first_name | last_name | email              | salary | department |
      | 101         | John       | Doe       | john.doe@test.com  | 50000  | IT         |
      | 102         | Jane       | Smith     | jane.smith@test.com| 60000  | HR         |
      | 103         | Bob        | Johnson   | bob.j@test.com     | 55000  | Finance    |

    # In your step definition, you'll receive:
    # {"employee_id":"101","first_name":"John","last_name":"Doe","email":"john.doe@test.com","salary":"50000","department":"IT"}


  # ================================================================
  # PATTERN 3: Mix Individual Fields with Complete Row
  # ================================================================

  @mixed-access
  Scenario Outline: Process employee using mixed approach
    # You can use both individual fields AND the complete row
    When I search for employee "<employee_id>"
    And I compare with expected data "{currentRow}"
    Then all fields should match

    Examples:
      | employee_id | first_name | last_name | email              | salary |
      | 101         | John       | Doe       | john.doe@test.com  | 50000  |
      | 102         | Jane       | Smith     | jane.smith@test.com| 60000  |


  # ================================================================
  # PATTERN 4: Real-World Example - Database Validation
  # ================================================================

  @database-validation @practical
  Scenario Outline: Validate database record against test data
    Given user connects to "TEST_DB" database
    When I execute query "SELECT * FROM employees WHERE id = <id>"
    # Pass complete row data to validation step
    And I validate result matches expected data "{currentRow}"
    Then validation should pass with all fields

    Examples:
      | id  | name    | email           | department | salary | status |
      | 101 | John    | john@test.com   | IT         | 50000  | Active |
      | 102 | Jane    | jane@test.com   | HR         | 60000  | Active |


  # ================================================================
  # PATTERN 5: Real-World Example - API Testing
  # ================================================================

  @api-testing @practical
  Scenario Outline: Validate API response against test data
    Given I have a REST client
    When I send GET request to "/api/users/<user_id>"
    # Use complete row for comprehensive validation
    And I validate response matches "{currentRow}"
    Then response status should be 200

    Examples:
      | user_id | username | email           | role  | active |
      | 1       | admin    | admin@test.com  | Admin | true   |
      | 2       | user1    | user1@test.com  | User  | true   |


  # ================================================================
  # PATTERN 6: Real-World Example - Excel/CSV Comparison
  # ================================================================

  @file-comparison @practical
  Scenario Outline: Compare Excel data with test data
    When I read Excel file "employees.xlsx" sheet "Employees"
    And I find row where "employee_id" equals "<employee_id>"
    # Pass complete expected row for validation
    And I compare Excel row with expected data "{currentRow}"
    Then all fields should match exactly

    Examples:
      | employee_id | first_name | last_name | email              | salary | department |
      | 101         | John       | Doe       | john.doe@test.com  | 50000  | IT         |
      | 102         | Jane       | Smith     | jane.smith@test.com| 60000  | HR         |


  # ================================================================
  # NOTES AND BEST PRACTICES
  # ================================================================

  # Available Syntax for Accessing Test Data:
  # 1. {currentRow} - Complete row as JSON (use this for comprehensive validation)
  # 2. <field> - Individual field (e.g., <email>, <employee_id>)
  # 3. {testData} - Deprecated: Use {currentRow} instead (kept for backward compatibility)

  # Use Cases:
  # ✅ When you need to validate ALL fields at once
  # ✅ When passing test data to validation utilities
  # ✅ When comparing database/API responses with expected data
  # ✅ When you want to log complete test data for debugging
  # ✅ When implementing generic validation steps

  # Step Definition Examples:
  #
  # @Given('I verify employee details with data {string}')
  # async verifyEmployeeDetails(testDataJson: string) {
  #     const testData = JSON.parse(testDataJson);
  #     console.log('Expected employee:', testData);
  #     // Access fields: testData.employee_id, testData.email, etc.
  #     // Perform validation...
  # }
  #
  # @When('I compare Excel row with expected data {string}')
  # async compareExcelRow(testDataJson: string) {
  #     const expected = JSON.parse(testDataJson);
  #     const actual = this.getExcelRowData();
  #     // Compare all fields
  #     Object.keys(expected).forEach(field => {
  #         expect(actual[field]).toBe(expected[field]);
  #     });
  # }

  # Benefits:
  # - Reduces repetitive step definitions
  # - Makes tests more maintainable
  # - Enables generic, reusable validation steps
  # - Perfect for comprehensive data validation
  # - Easy to debug (you can see all test data)
