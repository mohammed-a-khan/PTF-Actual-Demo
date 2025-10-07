Feature: Debug Status Code as Query Parameter

  Background:
    Given user is working with "API Test Suite" API

  Scenario: Test Status Code as Query Parameter
    Given the API base URL is "https://postman-echo.com"
    When I send a GET request to "/get"
    Then the response status should be 200
    And API response should be saved as "statusResponse"
    And user uses status code from "statusResponse" as query parameter "previousStatus"
    When I send a GET request to "/get"
    Then the response status should be 200
    And the response body JSON path "$.args.previousStatus" should be "200"