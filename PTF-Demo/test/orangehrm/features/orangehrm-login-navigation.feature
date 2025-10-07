@orangehrm @login @navigation @demo
Feature: Orange HRM Demo Site - Login and Navigation
  As a QA Engineer using CS Test Automation Framework  
  I want to test the Orange HRM demo application
  So that I can verify login functionality and navigation features using CS Framework standards

  Background:
    Given I navigate to the Orange HRM application

  @TC501 @smoke @high @critical
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

  @TC503 @regression @medium
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

  @TC504 @negative @security
  Scenario: Login with invalid credentials - duplicate
    When I enter username "InvalidUser" and password "wrongpassword"  
    And I click on the Login button
    Then I should see an error message "Invalid credentials"
    And I should remain on the login page

  @TC505 @smoke @logout
  Scenario: User logout functionality - duplicate
    Given I am logged in to Orange HRM application
    When I click on user profile dropdown
    And I click on Logout option
    Then I should be redirected to login page
    And I should see the login form