@data-driven-comprehensive
Feature: Comprehensive Data-Driven Testing Patterns
  Demonstrate all ACTUAL data-driven patterns implemented in CS Framework

  Background:
    Given I navigate to the Orange HRM application

  # Pattern 4: @DataProvider tag with Excel and sheet
  @DataProvider(source="test/orangehrm/data/users.xlsx",type="excel",sheet="Users")
  Scenario Outline: Login with DataProvider Excel tag
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"
