@TestPlanId:417 @TestSuiteId:418
Feature: Test Screenshot Capture on Failure
  Testing that screenshots and actions are captured on failure

  @TestCaseId:420
  Scenario: Test with deliberate assertion failure
    Given I open the browser
    When I navigate to "https://opensource-demo.orangehrmlive.com/"
    And I wait for 2 seconds
    Then I verify page title contains "WRONG TITLE THAT WILL FAIL"
