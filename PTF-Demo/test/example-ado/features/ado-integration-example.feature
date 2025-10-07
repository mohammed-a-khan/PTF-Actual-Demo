@ado-integration @TestPlanId:417 @TestSuiteId:418
Feature: Azure DevOps Integration Example
  Example feature demonstrating Azure DevOps test case mapping
  These tests will update results in Azure DevOps Test Plan 417, Test Suite 418

  Background:
    Given I am on the OrangeHRM login page

  @TestCaseId:419 @smoke @login
  Scenario: Valid Login Test - Single Test Case Mapping
    When I enter username "Admin" and password "admin123"
    And I click the login button
    Then I should see the dashboard page
    And the dashboard header should display "Dashboard"

  @TestCaseId:{420,421,422} @regression @login
  Scenario: Invalid Login Test - Multiple Test Case Mapping
    """
    This scenario validates multiple ADO test cases:
    - TC 420: Invalid username validation
    - TC 421: Invalid password validation
    - TC 422: Empty credentials validation
    """
    When I enter username "invalid" and password "wrongpassword"
    And I click the login button
    Then I should see an error message containing "Invalid credentials"
    And I should remain on the login page

  @TestCaseId:423 @navigation
  Scenario: Navigate to Admin Module
    Given I am logged in to Orange HRM application
    When I click on "Admin" menu item
    Then I should see the "Admin" page header
    And the URL should contain "admin"

  @TestCaseId:{424,425} @data-driven
  Scenario Outline: Navigation to Multiple Modules - <moduleName>
    """
    Validates navigation to different modules
    Each row maps to different test cases in ADO
    """
    Given I am logged in to Orange HRM application
    When I click on "<moduleName>" menu item
    Then I should see the "<expectedHeader>" page header
    And the URL should contain "<urlFragment>"

    Examples:
      | moduleName   | expectedHeader | urlFragment  |
      | Admin        | Admin          | admin        |
      | PIM          | PIM            | pim          |
      | Leave        | Leave          | leave        |
      | Time         | Time           | time         |
      | Recruitment  | Recruitment    | recruitment  |

  @TestCaseId:426 @logout
  Scenario: User Logout
    Given I am logged in to Orange HRM application
    When I click on user profile dropdown
    And I click on Logout option
    Then I should be redirected to login page
    And I should see the login form

  @TestCaseId:{427,428,429} @boundary @negative
  Scenario: Login with Special Characters - Multiple Test Cases
    """
    This scenario validates three test cases:
    - TC 427: SQL injection attempt
    - TC 428: XSS attempt
    - TC 429: Special character handling
    """
    When I enter username "admin' OR '1'='1" and password "<script>alert('XSS')</script>"
    And I click the login button
    Then I should see an error message
    And the application should handle special characters safely
    And no security breach should occur

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