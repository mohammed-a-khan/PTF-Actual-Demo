@data-driven @comprehensive
Feature: Complete Data-Driven Testing with Both Patterns
  This feature demonstrates all data-driven testing patterns supported by CS Framework:
  1. @DataProvider tag at feature level
  2. @DataProvider tag at scenario level
  3. Examples: {} with external data configuration
  4. Standard inline Examples table

  Background:
    Given I navigate to the Orange HRM application

  # Pattern 1: Scenario-level @DataProvider tag
  @DataProvider(source="test/orangehrm/data/users.xlsx", type="excel", sheet="Users")
  @excel-scenario
  Scenario Outline: Login test with scenario-level @DataProvider tag
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"
    And the test description is "<description>"
    # No Examples section needed - data comes from @DataProvider

  # Pattern 2: Examples with JSON configuration for CSV
  @csv-examples
  Scenario Outline: Login test with CSV via Examples configuration
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

    Examples: {"type": "csv", "source": "test/orangehrm/data/users.csv", "delimiter": ","}

  # Pattern 3: Examples with JSON configuration for JSON file
  @json-examples
  Scenario Outline: Login test with JSON via Examples configuration
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

    Examples: {"type": "json", "source": "test/orangehrm/data/users.json", "path": "$.data[*]"}

  # Pattern 4: Examples with JSON configuration for XML
  @xml-examples
  Scenario Outline: Login test with XML via Examples configuration
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

    Examples: {"type": "xml", "source": "test/orangehrm/data/users.xml", "xpath": "//user"}

  # Pattern 5: Standard inline Examples (traditional Gherkin)
  @inline-examples @smoke
  Scenario Outline: Login test with standard inline Examples
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

    Examples:
      | username    | password    | expectedResult |
      | Admin       | admin123    | success        |
      | InvalidUser | wrongpass   | failure        |
      | EmptyUser   |             | failure        |

  # Pattern 6: @DataProvider with filter
  @DataProvider(source="test/orangehrm/data/users.xlsx", type="excel", sheet="Users", filter="role=Admin")
  @filtered-data
  Scenario Outline: Login test with filtered @DataProvider
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"
    # Only rows where role=Admin will be used

  # Pattern 7: Multiple sheets from Excel
  @DataProvider(source="test/orangehrm/data/users.xlsx", type="excel", sheet="Performance")
  @performance-data
  Scenario Outline: Performance test with different Excel sheet
    When I measure login performance for "<testCase>"
    And I login with username "<username>"
    Then response time "<responseTime>" should be within threshold "<threshold>"
    And test status should be "<status>"

@data-driven-navigation
Feature: Navigation Testing with Feature-Level @DataProvider
  # Pattern 8: Feature-level @DataProvider applies to all scenarios
  @DataProvider(source="test/orangehrm/data/navigation.xlsx", type="excel", sheet="Modules")

  Background:
    Given I am logged in to Orange HRM application

  @navigation-test
  Scenario Outline: Navigate to module
    When I click on "<moduleName>" menu item
    Then I should see the "<expectedHeader>" page header
    And the URL should contain "<urlFragment>"
    # Data comes from feature-level @DataProvider

  @navigation-breadcrumb
  Scenario Outline: Verify breadcrumb for module
    When I click on "<moduleName>" menu item
    Then the breadcrumb should show "<moduleName>"
    # Same data source from feature-level @DataProvider