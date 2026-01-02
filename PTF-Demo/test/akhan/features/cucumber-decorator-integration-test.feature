@cucumber-decorator-test @integration @TestPlanId:500 @TestSuiteId:501
Feature: Cucumber Decorator Integration Test
  This feature comprehensively tests the new Cucumber-compatible decorators (@Given, @When, @Then, @And, @But)
  with all CS Framework features including:
  - Normal parameters ({string}, {int}, {float})
  - Data tables
  - Examples with inline data
  - Examples with JSON data source
  - Variable interpolation (<random>, <timestamp>, <generate:xxx>)
  - ADO tags integration
  - Page injection
  - Context management

  Background:
    Given the test framework is initialized with new decorators
    And I navigate to OrangeHRM test application

  # Test 1: Basic Given/When/Then with normal parameters
  @TestCaseId:502 @smoke @basic-parameters
  Scenario: Test basic Cucumber decorators with string parameters
    Given I am testing new decorator "Given" with value "test1"
    When I perform test action with decorator "When" and value "action1"
    Then I should verify decorator "Then" shows result "success"
    And I verify additional check with "And" decorator
    But the error count should not be "5"

  # Test 2: Multiple parameter types (string, int, float)
  @TestCaseId:503 @regression @parameter-types
  Scenario: Test decorators with multiple parameter types
    Given I have test counter initialized to 0
    When I increment counter by 5
    And I add decimal value 2.5 to calculation
    Then the counter should be 5
    And the decimal result should be 2.5
    But the counter should not be 10

  # Test 3: Data Tables with new decorators
  @TestCaseId:504 @data-table @smoke
  Scenario: Test data table handling with Given decorator
    Given I have the following test data for new decorators:
      | key           | value              |
      | testName      | Cucumber Test      |
      | framework     | CS Framework       |
      | decorator     | @Given             |
      | version       | 3.0.21             |
    When I process the test data table with When decorator
    Then I should see 4 rows processed successfully

  # Test 4: Scenario Outline with inline Examples
  @TestCaseId:505 @scenario-outline @inline-examples
  Scenario Outline: Test scenario outline with new decorators and inline examples
    Given I setup test case "<testCase>" with decorator type "<decoratorType>"
    When I execute test action "<action>" using new decorator
    Then the test result should be "<expectedResult>"
    And the execution status should be "<status>"

    Examples:
      | testCase        | decoratorType | action      | expectedResult | status  |
      | TC001          | @Given        | login       | passed        | active  |
      | TC002          | @When         | logout      | passed        | active  |
      | TC003          | @Then         | validate    | passed        | active  |
      | TC004          | @And          | verify      | passed        | active  |
      | TC005          | @But          | check       | failed        | inactive|

  # Test 5: Scenario Outline with JSON data source
  @TestCaseId:506 @json-data-source @external-data
  Scenario Outline: Test decorators with JSON external data source
    Given I am testing with username "<username>" from JSON data
    When I use password "<password>" for authentication test
    Then the expected outcome should be "<expectedResult>"
    And the role should be "<role>"
    And the description should match "<description>"

    Examples: {"type": "json", "source": "test/orangehrm/data/users.json", "path": "$.data[*]"}

  # Test 6: Variable Interpolation - Random values
  @TestCaseId:507 @variable-interpolation @random
  Scenario: Test variable interpolation with random values
    Given I create test user with random username "<random>"
    When I generate random password "<random>"
    Then the username should be unique
    And the password should be unique

  # Test 7: Variable Interpolation - Timestamps
  @TestCaseId:508 @variable-interpolation @timestamp
  Scenario: Test variable interpolation with timestamps
    Given I create test record with timestamp "<timestamp>"
    When I save the record with date "<date:YYYY-MM-DD>"
    Then the timestamp should be current
    And the date format should be valid

  # Test 8: Variable Interpolation - Generated values
  @TestCaseId:509 @variable-interpolation @generated
  Scenario: Test variable interpolation with generated values
    Given I generate test email "<generate:email>"
    When I generate test phone number "<generate:phone>"
    And I generate test username "<generate:username>"
    Then all generated values should be valid
    And all values should be unique

  # Test 9: Variable Interpolation - Config values
  @TestCaseId:510 @variable-interpolation @config
  Scenario: Test variable interpolation with config values
    Given I load admin password from config "<config:ADMIN_PASSWORD>"
    When I load base URL from config "<config:BASE_URL>"
    Then the config values should be loaded correctly
    And the values should not be empty

  # Test 10: Variable Interpolation - Encrypted values
  @TestCaseId:511 @variable-interpolation @encrypted @security
  Scenario: Test variable interpolation with encrypted values
    Given I load encrypted admin password "<config:ADMIN_PASSWORD_ENCRYPTED>"
    When I decrypt the password for testing
    Then the decrypted value should be valid
    And I should be able to authenticate with it

  # Test 11: Scenario Outline with @DataProvider tag
  @TestCaseId:512 @data-provider @excel
  @DataProvider(source="test/orangehrm/data/users.xlsx", type="excel", sheet="Users")
  Scenario Outline: Test decorators with @DataProvider Excel data
    Given I test with Excel user "<username>" using new decorators
    When I authenticate with Excel password "<password>"
    Then the Excel result should be "<expectedResult>"
    And the role from Excel should be "<role>"

  # Test 12: Multiple data tables in single scenario
  @TestCaseId:513 @multiple-tables @advanced
  Scenario: Test multiple data table handling with new decorators
    Given I have test configuration:
      | setting         | value              |
      | timeout         | 30000              |
      | retry           | 3                  |
      | headless        | false              |
    When I have test users:
      | username        | role               |
      | testuser1       | Admin              |
      | testuser2       | User               |
      | testuser3       | Guest              |
    Then both tables should be processed correctly
    And configuration should have 3 settings
    And users should have 3 entries

  # Test 13: ADO tags with scenario outline
  @TestPlanId:501 @TestSuiteId:502 @TestCaseId:{513,514,515} @ado-integration
  Scenario Outline: Test ADO tag integration with new decorators
    Given I run test "<testId>" mapped to ADO test case
    When I execute the test with new decorator
    Then the result should be reported to ADO
    And ADO test case "<testCaseId>" should be updated

    Examples:
      | testId | testCaseId |
      | T001   | 513        |
      | T002   | 514        |
      | T003   | 515        |

  # Test 14: Page injection with new decorators
  @TestCaseId:516 @page-injection @framework-feature
  Scenario: Test page injection works with new decorators
    Given I verify page object injection with Given decorator
    When I interact with injected page using When decorator
    Then the page actions should work with Then decorator
    And page state should be maintained with And decorator

  # Test 15: Context management with new decorators
  @TestCaseId:517 @context-management @framework-feature
  Scenario: Test context management with new decorators
    Given I save value "testValue123" to scenario context with key "testKey"
    When I retrieve value from scenario context using key "testKey"
    Then the retrieved value should be "testValue123"
    And I save value "featureValue456" to feature context with key "featureKey"
    And I can retrieve feature context value using key "featureKey"

  # Test 16: Retry logic with new decorators
  @TestCaseId:518 @retry-logic @framework-feature
  Scenario: Test retry logic works with new decorators
    Given I setup a flaky test step that may fail
    When I execute the flaky step with retry enabled
    Then the step should eventually succeed after retries
    And the retry count should be tracked correctly

  # Test 17: Doc string with new decorators
  @TestCaseId:519 @doc-string @advanced
  Scenario: Test doc string handling with new decorators
    Given I have the following JSON test data:
      """
      {
        "testName": "Cucumber Decorator Test",
        "framework": "CS Framework",
        "version": "3.0.21",
        "decorators": ["@Given", "@When", "@Then", "@And", "@But"],
        "features": {
          "pageInjection": true,
          "contextManagement": true,
          "variableInterpolation": true,
          "dataProvider": true
        }
      }
      """
    When I parse the JSON doc string with When decorator
    Then the JSON should contain 5 decorators
    And all framework features should be enabled

  # Test 18: Complex scenario with all features combined
  @TestCaseId:520 @comprehensive @all-features @critical
  Scenario Outline: Comprehensive test with all decorator and framework features
    Given I initialize comprehensive test "<testId>" with random user "<random>"
    And I setup test timestamp "<timestamp>"
    And I load config value "<config:BASE_URL>"
    When I execute test action "<action>" using decorator "<decorator>"
    And I process the following test configuration:
      | parameter       | value              |
      | timeout         | <timeout>          |
      | retry           | <retry>            |
    Then the test should complete with status "<expectedStatus>"
    And all decorators should work correctly
    But there should be no errors

    Examples:
      | testId | action    | decorator | timeout | retry | expectedStatus |
      | CT001  | validate  | @Given    | 30000   | 3     | passed        |
      | CT002  | process   | @When     | 45000   | 2     | passed        |
      | CT003  | verify    | @Then     | 60000   | 1     | passed        |
      | CT004  | check     | @And      | 30000   | 3     | passed        |
      | CT005  | exclude   | @But      | 30000   | 1     | passed        |

  # Test 19: Mixed decorator styles (old and new)
  @TestCaseId:521 @mixed-decorators @backward-compatibility
  Scenario: Test mixing old CSBDDStepDef and new Cucumber decorators
    Given I use new Given decorator for this step
    When I use old CSBDDStepDef decorator for action step
    Then I use new Then decorator for verification
    And both decorator styles should work together seamlessly

  # Test 20: Error handling with new decorators
  @TestCaseId:522 @error-handling @negative-test
  Scenario: Test error handling with new decorators
    Given I setup test that will intentionally fail
    When I catch the expected error with When decorator
    Then the error should be handled gracefully
    And error details should be captured correctly
    But the test execution should continue
