Feature: Simple Parallel Test

  Scenario: Test 1
    Given I navigate to the Orange HRM application
    When I enter username "Admin" and password "admin123"
    Then I should see the dashboard page

  Scenario: Test 2
    Given I navigate to the Orange HRM application
    When I enter username "Invalid" and password "wrong"
    Then I should see the dashboard page