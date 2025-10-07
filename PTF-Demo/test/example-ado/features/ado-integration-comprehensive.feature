@ado-integration @TestPlanId:417 @TestSuiteId:418
Feature: Comprehensive Azure DevOps Integration
  This feature demonstrates all ADO integration scenarios including tag inheritance
  Feature-level tags will be inherited by scenarios unless overridden

  Background:
    Given I navigate to the Orange HRM application

  @TestCaseId:419 @smoke @login
  Scenario: Scenario with single test case - inherits feature plan/suite
    """
    This scenario will use:
    - Plan ID: 417 (from feature)
    - Suite ID: 418 (from feature)
    - Test Case: 419
    """
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should see the dashboard page

  @TestCaseId:420 @regression @login
  Scenario: Another scenario inheriting feature plan/suite
    """
    This scenario will use:
    - Plan ID: 417 (from feature)
    - Suite ID: 418 (from feature)
    - Test Case: 420
    """
    When I enter username "InvalidUser" and password "wrongpassword"
    And I click on the Login button
    Then I should see an error message "Invalid credentials"
    And I should remain on the login page

  @TestPlanId:413 @TestSuiteId:414 @TestCaseId:{415,416} @smoke @critical
  Scenario: Scenario overriding feature plan/suite with multiple test cases
    """
    This scenario overrides feature-level tags:
    - Plan ID: 413 (overrides feature 417)
    - Suite ID: 414 (overrides feature 418)
    - Test Cases: 415, 416
    """
    Given I am logged in to Orange HRM application
    When I click on user profile dropdown
    And I click on Logout option
    Then I should be redirected to login page
    And I should see the login form