
Feature: Test Failure
  Testing screenshot and action capture

  Scenario: Test with deliberate failure
    Given I navigate to "https://opensource-demo.orangehrmlive.com/"
    When I wait for 2 seconds
    Then I verify page title contains "WRONG TITLE THAT WILL FAIL"
