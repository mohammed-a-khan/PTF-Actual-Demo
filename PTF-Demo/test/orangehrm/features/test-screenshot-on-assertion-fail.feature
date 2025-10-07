Feature: Test Screenshot Capture on Assertion Failure
  Testing that screenshots and actions are captured on assertion failure after browser is open

  Scenario: Test with assertion failure after browser is open
    When I navigate to "https://opensource-demo.orangehrmlive.com/"
    And I wait for 2 seconds
    Then I verify page title contains "WRONG TITLE THAT WILL FAIL"