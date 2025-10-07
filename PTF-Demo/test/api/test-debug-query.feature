Feature: Debug Query Parameters

  Background:
    Given user is working with "API Test Suite" API

  Scenario: Debug Query Parameter Handling
    Given the API base URL is "https://postman-echo.com"
    When user sets query parameter "test1" to "value1"
    And user sets query parameter "test2" to "value2"
    When I send a GET request to "/get"
    Then the response status should be 200
    And the response body JSON path "$.args.test1" should be "value1"
    And the response body JSON path "$.args.test2" should be "value2"