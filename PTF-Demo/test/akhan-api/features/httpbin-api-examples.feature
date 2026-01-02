Feature: HTTPBin API Testing Examples
  As a QA engineer
  I want to test HTTPBin API endpoints
  So that I can validate API responses and authentication

  Background:
    Given user is working with API context "httpbin"
    And user sets base URL to "https://httpbin.org"
    And user sets request timeout to 30 seconds

  @api @httpbin @get @simple
  Scenario: Test HTTPBin GET endpoint - Simple
    When user sends GET request to "/get"
    Then response status should be 200
    And response JSON path "$.url" should equal "https://httpbin.org/get"
    And response JSON path "$.headers" should exist
    And response JSON path "$.args" should exist
    And response JSON path "$.origin" should exist
    And response body should contain "httpbin.org"
    And response time should be less than 5000 ms

  @api @httpbin @get @validation
  Scenario: Verify HTTPBin GET response structure
    When user sends GET request to "/get"
    Then response status should be 200
    And response JSON path "$.headers.Host" should equal "httpbin.org"
    And response JSON path "$.headers.User-Agent" should exist
    And response body should contain "https://httpbin.org/get"

  @api @httpbin @post @json
  Scenario: Test HTTPBin POST with JSON data
    Given user sets request body to:
      """
      {
        "name": "John Doe",
        "email": "john@example.com",
        "age": 30,
        "active": true
      }
      """
    When user sends POST request to "/post"
    Then response status should be 200
    And response JSON path "$.json.name" should equal "John Doe"
    And response JSON path "$.json.email" should equal "john@example.com"
    And response JSON path "$.json.age" should equal 30
    And response JSON path "$.json.active" should equal true
    And response JSON path "$.headers.Content-Type" should contain "application/json"

  @api @httpbin @post @form
  Scenario: Test HTTPBin POST with form data
    Given user adds form field "username" with value "testuser"
    And user adds form field "password" with value "testpass"
    And user adds form field "remember" with value "true"
    When user sends POST request to "/post"
    Then response status should be 200
    And response JSON path "$.form.username" should equal "testuser"
    And response JSON path "$.form.password" should equal "testpass"
    And response JSON path "$.form.remember" should equal "true"

  @api @httpbin @headers
  Scenario: Test HTTPBin with custom headers
    Given user sets request header "X-Custom-Header" to "CustomValue123"
    And user sets request header "Authorization" to "Bearer test-token"
    And user sets request header "X-Request-ID" to "req-12345"
    When user sends GET request to "/headers"
    Then response status should be 200
    And response JSON path "$.headers.X-Custom-Header" should equal "CustomValue123"
    And response JSON path "$.headers.Authorization" should equal "Bearer test-token"
    And response JSON path "$.headers.X-Request-Id" should equal "req-12345"

  @api @httpbin @basic-auth
  Scenario: Test HTTPBin Basic Authentication
    Given user sets basic authentication with username "testuser" and password "testpass"
    When user sends GET request to "/basic-auth/testuser/testpass"
    Then response status should be 200
    And response JSON path "$.authenticated" should equal true
    And response JSON path "$.user" should equal "testuser"

  @api @httpbin @bearer-auth
  Scenario: Test HTTPBin Bearer Token Authentication
    Given user sets bearer token "test-bearer-token-123"
    When user sends GET request to "/bearer"
    Then response status should be 200
    And response JSON path "$.authenticated" should equal true
    And response JSON path "$.token" should equal "test-bearer-token-123"

  @api @httpbin @query-params
  Scenario: Test HTTPBin with query parameters
    Given user sets query parameter "name" to "John Doe"
    And user sets query parameter "age" to "30"
    And user sets query parameter "city" to "New York"
    When user sends GET request to "/get"
    Then response status should be 200
    And response JSON path "$.args.name" should equal "John Doe"
    And response JSON path "$.args.age" should equal "30"
    And response JSON path "$.args.city" should equal "New York"

  @api @httpbin @put
  Scenario: Test HTTPBin PUT method
    Given user sets request body to:
      """
      {
        "id": 123,
        "name": "Updated User",
        "email": "updated@example.com"
      }
      """
    When user sends PUT request to "/put"
    Then response status should be 200
    And response JSON path "$.json.id" should equal 123
    And response JSON path "$.json.name" should equal "Updated User"
    And response JSON path "$.json.email" should equal "updated@example.com"

  @api @httpbin @delete
  Scenario: Test HTTPBin DELETE method
    When user sends DELETE request to "/delete"
    Then response status should be 200
    And response JSON path "$.url" should equal "https://httpbin.org/delete"

  @api @httpbin @patch
  Scenario: Test HTTPBin PATCH method
    Given user sets request body to:
      """
      {
        "name": "Patched Name"
      }
      """
    When user sends PATCH request to "/patch"
    Then response status should be 200
    And response JSON path "$.json.name" should equal "Patched Name"

  @api @httpbin @status-codes
  Scenario Outline: Test different HTTP status codes
    When user sends GET request to "/status/<status_code>"
    Then response status should be <status_code>

    Examples:
      | status_code |
      | 200         |
      | 201         |
      | 400         |
      | 401         |
      | 403         |
      | 404         |
      | 500         |

  @api @httpbin @cookies
  Scenario: Test HTTPBin cookies
    When user sends GET request to "/cookies/set/session_id/abc123"
    Then response status should be 302
    When user sends GET request to "/cookies"
    Then response status should be 200
    And response JSON path "$.cookies.session_id" should equal "abc123"

  @api @httpbin @redirect
  Scenario: Test HTTPBin redirect
    When user sends GET request to "/redirect/3"
    Then response status should be 200
    And response JSON path "$.url" should equal "https://httpbin.org/get"

  @api @httpbin @delay
  Scenario: Test HTTPBin with delay
    Given user sets request timeout to 10 seconds
    When user sends GET request to "/delay/2"
    Then response status should be 200
    And response time should be greater than 2000 ms
    And response time should be less than 3000 ms

  @api @httpbin @gzip
  Scenario: Test HTTPBin gzip compression
    Given user sets request encoding to "gzip"
    When user sends GET request to "/gzip"
    Then response status should be 200
    And response JSON path "$.gzipped" should equal true

  @api @httpbin @user-agent
  Scenario: Test HTTPBin user agent
    Given user sets User-Agent to "CS-Test-Framework/1.0"
    When user sends GET request to "/user-agent"
    Then response status should be 200
    And response JSON path "$['user-agent']" should equal "CS-Test-Framework/1.0"

  @api @httpbin @variables @chaining
  Scenario: Test variable usage and response chaining
    # First request to get some data
    Given user sets query parameter "test_id" to "12345"
    When user sends GET request to "/get" and saves response as "initial-request"
    Then response status should be 200
    And user saves response JSON path "$.args.test_id" as "capturedId"

    # Second request using the captured data
    Given user sets request body to:
      """
      {
        "originalId": "{{capturedId}}",
        "message": "Using captured ID"
      }
      """
    When user sends POST request to "/post"
    Then response status should be 200
    And response JSON path "$.json.originalId" should equal "12345"
    And response JSON path "$.json.message" should equal "Using captured ID"