Feature: Debug API Response

  @api @debug
  Scenario: Test Simple JSON Response
    Given user is working with "Debug API" API
    When I send a GET request to "https://postman-echo.com/get"
    Then the response status should be 200
    And the response body should contain "args"

  @api @debug
  Scenario: Test Basic Auth Response
    Given user is working with "Debug Auth API" API
    And I use basic authentication with username "postman" and password "password"
    When I send a GET request to "https://postman-echo.com/basic-auth"
    Then the response status should be 200
    And the response body should contain "authenticated"
    And the response body JSON path "$.authenticated" should be true