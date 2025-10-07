@ado-integration @TestPlanId:417 @TestSuiteId:418
Feature: Azure DevOps Integration Example
  Example feature demonstrating Azure DevOps test case mapping
  These tests will update results in Azure DevOps Test Plan 417, Test Suite 418

  Background:
    Given I navigate to the Orange HRM application

  @TestCaseId:419 @smoke @login
  Scenario: Login with invalid credentials
    When I enter username "InvalidUser" and password "wrongpassword"  
    And I click on the Login button
    Then I should see an error message "Invalid credentials"
    And I should remain on the login page

  @TestCaseId:420 @regression @login
  Scenario: User logout functionality
    Given I am logged in to Orange HRM application
    When I click on user profile dropdown
    And I click on Logout option
    Then I should be redirected to login page
    And I should see the login form
  
  @TestPlanId:413 @TestSuiteId:414 @TestCaseId:{415,416} @smoke @high @critical
  Scenario: Standard user login with valid credentials
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully
    And I should see the Dashboard page
    And I should see the main navigation menu

# Feature-level tags will be inherited by all scenarios
# Use @TestPlanId and @TestSuiteId at feature level for common mapping
# Use @TestCaseId at scenario level for specific test case mapping
# Support single test case: @TestCaseId:419
# Support multiple test cases: @TestCaseId:{419,420,421}

# Configuration in global.env or project-specific .env:
# ADO_INTEGRATION_ENABLED=true
# ADO_ORGANIZATION=your-organization
# ADO_PROJECT=your-project
# ADO_PAT=your-personal-access-token
# ADO_TEST_PLAN_ID=417 (optional if using tags)
# ADO_TEST_SUITE_ID=418 (optional if using tags)