Feature: Certificate Authentication Example
  As a QA engineer
  I want to test API endpoints with certificate authentication
  So that I can validate secure certificate-based access

  Background:
    Given user is working with API context "httpbin"
    And user sets base URL to "https://httpbin.org"
    And user sets API timeout to 30 seconds

  @api @httpbin @get @certificate
  Scenario: Test HTTPBin GET endpoint with certificate authentication - Simple
    Given user loads certificate from "certificates/client.pfx" with password "test123"
    When user sends GET request to "/get"
    Then response status should be 200
    And response JSON path "$.url" should equal "https://httpbin.org/get"
    And response JSON path "$.headers" should exist
    And response JSON path "$.args" should exist
    And response JSON path "$.origin" should exist
    And response body should contain "httpbin.org"
    And response time should be less than 5000 ms

  @api @httpbin @get @certificate @validation
  Scenario: Verify HTTPBin GET response basic structure with certificate auth
    Given user loads certificate from "certificates/client.pfx" with password "test123"
    When user sends GET request to "/get"
    Then response status should be 200
    And response JSON path "$.headers.Host" should equal "httpbin.org"
    And response JSON path "$.headers.User-Agent" should exist
    And response body should contain "https://httpbin.org/get"

  @api @httpbin @post @certificate
  Scenario: Test HTTPBin POST endpoint with certificate authentication
    Given user loads certificate from "certificates/client.pfx" with password "test123"
    And user sets request body to:
      """
      {
        "message": "Hello from certificate auth test",
        "timestamp": "2024-01-01T00:00:00Z",
        "testType": "certificate-authentication"
      }
      """
    When user sends POST request to "/post"
    Then response status should be 200
    And response JSON path "$.url" should equal "https://httpbin.org/post"
    And response JSON path "$.json.message" should equal "Hello from certificate auth test"
    And response JSON path "$.json.testType" should equal "certificate-authentication"
    And response JSON path "$.headers" should exist

  @api @certificate @auth @headers
  Scenario: Certificate authentication with custom headers
    Given user loads certificate from "certificates/client.pfx" with password "test123"
    And user sets request header "X-Test-Client" to "certificate-client"
    And user sets request header "X-Auth-Type" to "mutual-tls"
    When user sends GET request to "/headers"
    Then response status should be 200
    And response JSON path "$.headers.X-Test-Client" should equal "certificate-client"
    And response JSON path "$.headers.X-Auth-Type" should equal "mutual-tls"

  @api @certificate @auth @secure
  Scenario: Certificate authentication secure endpoint test
    Given user loads certificate from "certificates/client.pfx" with password "test123"
    And user sets query parameter "secure" to "true"
    And user sets query parameter "client-cert" to "required"
    When user sends GET request to "/get"
    Then response status should be 200
    And response JSON path "$.args.secure" should equal "true"
    And response JSON path "$.args.client-cert" should equal "required"
    And response time should be less than 10000 ms