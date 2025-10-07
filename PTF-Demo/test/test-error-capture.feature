@test-error-capture
Feature: Test Error Capture for Data-Driven Tests
  Test that errors are properly captured in sequential data-driven execution

  Scenario Outline: Test with deliberate failures
    When I test with "<action>"
    Then the test should "<result>"

    Examples:
      | action  | result |
      | pass    | pass   |
      | fail    | fail   |
      | error   | error  |