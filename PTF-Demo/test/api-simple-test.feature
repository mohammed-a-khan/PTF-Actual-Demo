Feature: Simple API Test

  Background:
    Given user is working with "API Test Suite" API

  Scenario: Simple GET Request  
    Given the API base URL is "https://postman-echo.com"
    When I send a GET request to "/get"
    Then the response status should be 200
