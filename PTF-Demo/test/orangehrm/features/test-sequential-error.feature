@TestPlanId:417 @TestSuiteId:418 @TestCaseId:419
Feature: Test Sequential Error Handling

  Scenario Outline: Test with deliberate failures for ADO
    Given I navigate to the Orange HRM application
    When I enter username "<username>" and password "<password>"
    Then I should see the dashboard page

    Examples:
      | username | password |
      | Admin    | admin123 |
      | Invalid  | wrong    |