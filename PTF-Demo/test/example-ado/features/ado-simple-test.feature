@TestPlanId:417 @TestSuiteId:418
Feature: ADO Simple Data Driven Test
  Simple test for subResults

  @TestCaseId:419 @data-driven
  Scenario Outline: Simple Test - <testName>
    Given I skip this step
    When I skip this step
    Then I skip this step

    Examples:
      | testName |
      | Test1    |
      | Test2    |
      | Test3    |