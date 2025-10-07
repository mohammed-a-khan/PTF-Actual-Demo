Feature: Test Login with Deliberate Assertion Failure
  Testing that screenshots are captured properly when assertion fails after successful login

  Scenario: Login successfully then fail on deliberate assertion
    Given I navigate to the Orange HRM application
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully
    # This should fail and capture the dashboard page properly
    And I verify page title contains "WRONG TITLE THAT WILL FAIL"