@data-driven-comprehensive @TestPlanId:413 @TestSuiteId:414 
Feature: Comprehensive Data-Driven Testing Patterns
  Demonstrate all ACTUAL data-driven patterns implemented in CS Framework

  Background:
    Given I navigate to the Orange HRM application

  # Pattern 4: @DataProvider tag with Excel and sheet
  # @TestPlanId:413 @TestSuiteId:414 @TestCaseId:{415}
  # @DataProvider(source="test/orangehrm/data/users.xlsx",type="excel",sheet="Users")
  # Scenario Outline: Login with DataProvider Excel tag
  #   When I enter username "<username>" and password "<password>"
  #   And I click on the Login button
  #   Then I should see login result as "<expectedResult>"

  @regression @smoke @TestCaseId:415
  Scenario Outline: Login with JSON Examples configuration
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    # Then I should see login result as "<expectedResult>"

    Examples: {"type": "json", "source": "test/orangehrm/data/users.json", "path": "$.data[*]"}

  # Pattern 16: Examples with external CSV configuration
  @regression @csv
  Scenario Outline: Login with CSV Examples configuration
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

    Examples: {"type": "csv", "source": "test/orangehrm/data/users.csv"}
