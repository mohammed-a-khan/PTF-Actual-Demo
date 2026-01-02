@data-driven-comprehensive
Feature: Comprehensive Data-Driven Testing Patterns
  Demonstrate all ACTUAL data-driven patterns implemented in CS Framework

  Background:
    Given I navigate to the Orange HRM application

  # Pattern 1: @DataProvider tag with CSV
  @DataProvider(source="test/orangehrm/data/users.csv",type="csv")
  Scenario Outline: Login with DataProvider CSV tag
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

  # Pattern 2: @DataProvider tag with JSON
  @DataProvider(source="test/orangehrm/data/users.json",type="json")
  Scenario Outline: Login with DataProvider JSON tag
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

  # Pattern 3: @DataProvider tag with XML
  @DataProvider(source="test/orangehrm/data/users.xml",type="xml")
  Scenario Outline: Login with DataProvider XML tag
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

  # Pattern 4: @DataProvider tag with Excel and sheet
  @DataProvider(source="test/orangehrm/data/users.xlsx",type="excel",sheet="Users")
  Scenario Outline: Login with DataProvider Excel tag
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

  # Pattern 5: @DataProvider with filter (equals)
  @DataProvider(source="test/orangehrm/data/users-with-filter.csv",type="csv",filter="executeTest=true")
  Scenario Outline: Login with filtered data (executeTest=true)
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

  # Pattern 6: @DataProvider with filter (not equals)
  @DataProvider(source="test/orangehrm/data/users-with-filter.csv",type="csv",filter="status!=disabled")
  Scenario Outline: Login with filtered data (status not disabled)
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

  # Pattern 7: @DataProvider with filter (greater than)
  @DataProvider(source="test/orangehrm/data/users-with-filter.csv",type="csv",filter="priority>2")
  Scenario Outline: Login with filtered data (priority > 2)
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

  # Pattern 8: @DataProvider with filter (less than or equal)
  @DataProvider(source="test/orangehrm/data/users-with-filter.csv",type="csv",filter="priority<=3")
  Scenario Outline: Login with filtered data (priority <= 3)
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

  # Pattern 9: @DataProvider with filter (in list)
  @DataProvider(source="test/orangehrm/data/users-with-filter.csv",type="csv",filter="role:Admin,Manager")
  Scenario Outline: Login with filtered data (role in Admin,Manager)
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

  # Pattern 10: @DataProvider with filter (contains)
  @DataProvider(source="test/orangehrm/data/users-with-filter.csv",type="csv",filter="tags~smoke")
  Scenario Outline: Login with filtered data (tags contains smoke)
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

  # Pattern 11: @DataProvider with filter (starts with)
  @DataProvider(source="test/orangehrm/data/users-with-filter.csv",type="csv",filter="username^Test")
  Scenario Outline: Login with filtered data (username starts with Test)
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

  # Pattern 12: @DataProvider with filter (ends with)
  @DataProvider(source="test/orangehrm/data/users-with-filter.csv",type="csv",filter="password$123")
  Scenario Outline: Login with filtered data (password ends with 123)
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

  # Pattern 13: @DataProvider with multiple filters (AND)
  @DataProvider(source="test/orangehrm/data/users-with-filter.csv",type="csv",filter="executeTest=true&priority<=2")
  Scenario Outline: Login with multiple AND filters
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

  # Pattern 14: @DataProvider with multiple filters (OR)
  @DataProvider(source="test/orangehrm/data/users-with-filter.csv",type="csv",filter="role=Admin|role=Manager")
  Scenario Outline: Login with multiple OR filters
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

  # Pattern 15: @DataProvider with complex filters
  @DataProvider(source="test/orangehrm/data/users-with-filter.csv",type="csv",filter="executeTest=true&status=active&priority<3")
  Scenario Outline: Login with complex filters
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

  # Pattern 16: Examples with external CSV configuration
  Scenario Outline: Login with CSV Examples configuration
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

    Examples: {"type": "csv", "source": "test/orangehrm/data/users.csv"}

  # Pattern 17: Examples with JSON configuration
  Scenario Outline: Login with JSON Examples configuration
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

    Examples: {"type": "json", "source": "test/orangehrm/data/users.json", "path": "$.data[*]"}

  # Pattern 18: Examples with XML configuration
  Scenario Outline: Login with XML Examples configuration
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

    Examples: {"type": "xml", "source": "test/orangehrm/data/users.xml", "xpath": "//user"}

  # Pattern 19: Examples with Excel configuration
  Scenario Outline: Login with Excel Examples configuration
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

    Examples: {"type": "excel", "source": "test/orangehrm/data/users.xlsx", "sheet": "Users"}

  # Pattern 20: Examples with CSV and delimiter
  Scenario Outline: Login with CSV Examples and custom delimiter
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

    Examples: {"type": "csv", "source": "test/orangehrm/data/users.csv", "delimiter": ","}

  # Pattern 21: Examples with filter in configuration
  Scenario Outline: Login with filtered Examples configuration
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

    Examples: {"type": "csv", "source": "test/orangehrm/data/users-with-filter.csv", "filter": "tags~regression"}

  # Pattern 22: Examples with Excel filter
  Scenario Outline: Login with filtered Excel Examples
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

    Examples: {"type": "excel", "source": "test/orangehrm/data/users.xlsx", "sheet": "Users", "filter": "role=Admin"}

  # Pattern 23: Standard inline Examples table
  Scenario Outline: Login with standard inline Examples
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

    Examples:
      | username | password | expectedResult |
      | Admin    | admin123 | success        |
      | Invalid  | wrong    | failure        |
      | Test     | test123  | failure        |