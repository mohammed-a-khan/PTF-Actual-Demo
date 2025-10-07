@ado-integration @TestPlanId:417 @TestSuiteId:418
Feature: Data-Driven Test with ADO Integration
  Demonstrates data-driven test handling with multiple iterations for a single test case

  Background:
    Given I navigate to the Orange HRM application

  @TestCaseId:419 @data-driven
  Scenario Outline: Login with CSV Examples configuration
    When I enter username "<username>" and password "<password>"
    And I click on the Login button
    Then I should see login result as "<expectedResult>"

    Examples: {"type": "csv", "source": "test/orangehrm/data/users.csv"}

  @TestPlanId:413 @TestSuiteId:414 @TestCaseId:{415,416} @smoke @high @critical
  Scenario: Standard user login with valid credentials
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully
    And I should see the Dashboard page
    And I should see the main navigation menu

  @TC502 @regression @medium
  Scenario: Verify main menu navigation items are visible
    Given I am logged in to Orange HRM application
    Then I should see the following menu items
      | Admin       |
      | PIM         |
      | Leave       |
      | Time        |
      | Recruitment |
      | My Info     |
      | Performance |
      | Dashboard   |
      | Directory   |

  @TestCaseId:420 @TC503 @regression @medium
  Scenario Outline: Verify navigation to each module
    Given I am logged in to Orange HRM application
    When I click on "<moduleName>" menu item
    Then I should see the "<expectedHeader>" page header
    And the URL should contain "<urlFragment>"

    Examples:
      | moduleName  | expectedHeader | urlFragment   |
      | Admin       | Admin          | admin         |
      | PIM         | PIM            | pim           |
      | Leave       | Leave          | leave         |
      | Time        | Time           | time          |
      | Recruitment | Recruitment    | recruitment   |

  @TC504 @negative @security
  Scenario: Login with invalid credentials
    When I enter username "InvalidUser" and password "wrongpassword"  
    And I click on the Login button
    Then I should see an error message "Invalid credentials"
    And I should remain on the login page

  @TC505 @smoke @logout
  Scenario: User logout functionality
    Given I am logged in to Orange HRM application
    When I click on user profile dropdown
    And I click on Logout option
    Then I should be redirected to login page
    And I should see the login form