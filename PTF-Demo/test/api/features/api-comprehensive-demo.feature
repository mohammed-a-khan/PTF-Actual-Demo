@api @comprehensive @demo
Feature: Comprehensive API Testing Demonstration
  This feature demonstrates the complete API testing capabilities of the CS Framework
  Including authentication, validation, chaining, and various request/response patterns

  Background:
    Given user is working with "API Test Suite" API

  # Scenario 1: Basic Authentication Test (Postman Echo)
  @basic-auth
  Scenario: Test Basic Authentication with Postman Echo
    Given the API base URL is "https://postman-echo.com"
    And I use basic authentication with username "postman" and password "password"
    When I send a GET request to "/basic-auth"
    Then the response status should be 200
    And the response body should contain "authenticated"
    And the response body JSON path "$.authenticated" should be true
    And API response should be saved as "basicAuthResponse"
    And I print the last response

  # Scenario 2: Weather API with Query Parameters
  @weather-api @query-params
  Scenario: Test Weather API with Query Parameters
    Given the API base URL is "https://api.openweathermap.org"
    And I set query parameter "q" to "London"
    And I set query parameter "appid" to "c88f33016de85c421268ed269fdd3aac"
    When I send a GET request to "/data/2.5/weather"
    Then the response status should be 200
    And the response body JSON path "$.coord.lon" should exist
    And the response body JSON path "$.coord.lat" should exist
    And the response body JSON path "$.weather[0].main" should exist
    And the response body JSON path "$.main.temp" should exist
    And the response body JSON path "$.sys.country" should be "GB"
    And the response body JSON path "$.name" should be "London"
    And the response body JSON path "$.cod" should be 200
    And the response time should be less than 3000 ms
    And API response should be saved as "weatherResponse"

  # Scenario 3: API Chaining - Login and Use Token
  @api-chaining @bearer-token
  Scenario: Test API Chaining with Bearer Token Authentication
    Given the API base URL is "https://api.escuelajs.co"
    And I set request header "Content-Type" to "application/json"
    And I set request body to:
      """
      {
        "email": "john@mail.com",
        "password": "changeme"
      }
      """
    When I send a POST request to "/api/v1/auth/login"
    Then the response status should be 201
    And the response body JSON path "$.access_token" should exist
    And the response body JSON path "$.refresh_token" should exist
    And API response should be saved as "loginResponse"

    # Extract token and use in next request
    Given I extract "$.access_token" from response and save as "accessToken"
    And I use bearer token "{{accessToken}}"
    When I send a GET request to "/api/v1/auth/profile"
    Then the response status should be 200
    And the response body JSON path "$.id" should be 1
    And the response body JSON path "$.email" should be "john@mail.com"
    And the response body JSON path "$.name" should be "Jhon"
    And the response body JSON path "$.role" should be "customer"
    And API response should be saved as "profileResponse"

  # Scenario 4: GitHub API with Bearer Token (PAT)
  @github-api @oauth2
  Scenario: Test GitHub API with Personal Access Token
    Given the API base URL is "https://api.github.com"
    And I use bearer token "ENCRYPTED:eyJlbmNyeXB0ZWQiOiJXN2FPdUZlVnpMaktKNmxjM2dmMGN2aTMwQ21jakdpVGVEWXV2cjRwTW1XNjNhYjNla1NQeEE9PSIsIml2IjoicHJ3UnQxUW1hMEFUMTBGcTYvK3U3QT09IiwidGFnIjoiZitNbU1DelNzbU5sdytUS250bTFSQT09In0="
    And I set request header "Accept" to "application/vnd.github.v3+json"
    When I send a GET request to "/user"
    Then the response status should be 200
    And the response body JSON path "$.login" should be "mohammed-a-khan"
    And the response body JSON path "$.id" should be 70121022
    And the response body JSON path "$.type" should be "User"
    And the response body JSON path "$.public_repos" should exist
    And the response header "X-RateLimit-Limit" should exist
    And API response should be saved as "githubUserResponse"

  # Scenario 5: Certificate-based Authentication
  @certificate-auth
  Scenario: Test Certificate-based Authentication with badssl.com
    Given the API base URL is "https://client.badssl.com"
    And I set request header "Content-Type" to "application/json"
    And I use certificate authentication with cert "test/api/certificates/badssl/badssl.com-client (1).pem" and key "/mnt/e/PTF-main/test/api/certificates/badssl/badssl.com-client (1).pem"
    And user loads certificate from "test/api/certificates/badssl/badssl.com-client (1).pem" with password "badssl.com"
    When I send a GET request to "/"
    Then the response status should be 200
    And the response body should contain "client.badssl.com"
    And the response body should contain "green"
    And API response should be saved as "certificateAuthResponse"

  # Scenario 6: POST Request with JSON Body
  @post-json
  Scenario: Test POST Request with JSON Body
    Given the API base URL is "https://jsonplaceholder.typicode.com"
    And I set request header "Content-Type" to "application/json"
    And user sets JSON body:
      """
      {
        "title": "Test Post",
        "body": "This is a test post created by CS Framework",
        "userId": 1
      }
      """
    When I send a POST request to "/posts"
    Then the response status should be 201
    And the response body JSON path "$.id" should exist
    And the response body JSON path "$.title" should be "Test Post"
    And the response body JSON path "$.userId" should be "1"

  # Scenario 7: PUT Request to Update Resource
  @put-request
  Scenario: Test PUT Request to Update Resource
    Given the API base URL is "https://jsonplaceholder.typicode.com"
    And I set request header "Content-Type" to "application/json"
    And I set request body to:
      """
      {
        "id": 1,
        "title": "Updated Post",
        "body": "This post has been updated",
        "userId": 1
      }
      """
    When I send a PUT request to "/posts/1"
    Then the response status should be 200
    And the response body JSON path "$.title" should be "Updated Post"

  # Scenario 8: DELETE Request
  @delete-request
  Scenario: Test DELETE Request
    Given the API base URL is "https://jsonplaceholder.typicode.com"
    When I send a DELETE request to "/posts/1"
    Then the response status should be 200
    And the response body should be empty

  # Scenario 9: PATCH Request for Partial Update
  @patch-request
  Scenario: Test PATCH Request for Partial Update
    Given the API base URL is "https://jsonplaceholder.typicode.com"
    And I set request header "Content-Type" to "application/json"
    And I set request body to:
      """
      {
        "title": "Partially Updated Title"
      }
      """
    When I send a PATCH request to "/posts/1"
    Then the response status should be 200
    And the response body JSON path "$.title" should be "Partially Updated Title"

  # Scenario 10: Form Data Submission
  @form-data
  Scenario: Test Form Data Submission
    Given the API base URL is "https://postman-echo.com"
    And user sets form field "field1" to "value1"
    And user sets form field "field2" to "value2"
    When I send a POST request to "/post"
    Then the response status should be 200
    And the response body should contain "value1"
    And the response body should contain "value2"

  # Scenario 11: Multiple Query Parameters with Data Table
  @query-params-table
  Scenario: Test Multiple Query Parameters using Data Table
    Given the API base URL is "https://postman-echo.com"
    And user sets query parameters:
      | param1 | value1 |
      | param2 | value2 |
      | param3 | value3 |
    When I send a GET request to "/get"
    Then the response status should be 200
    And the response body JSON path "$.args.param1" should be "value1"
    And the response body JSON path "$.args.param2" should be "value2"
    And the response body JSON path "$.args.param3" should be "value3"

  # Scenario 12: Request Headers Validation
  @headers-validation
  Scenario: Test Request Headers Setting and Validation
    Given the API base URL is "https://postman-echo.com"
    And I set request headers:
      | X-Custom-Header | CustomValue |
      | X-Test-Header   | TestValue   |
    When I send a GET request to "/headers"
    Then the response status should be 200
    And the response body should contain "CustomValue"
    And the response body should contain "TestValue"

  # Scenario 13: Response Status Range Validation
  @status-range
  Scenario: Test Response Status Range Validation
    Given the API base URL is "https://postman-echo.com"
    When I send a GET request to "/get"
    Then the response status should be between 200 and 299
    And the response header "Content-Type" should exist

  # Scenario 14: API Timeout Configuration
  @timeout-config
  Scenario: Test API Timeout Configuration
    Given the API base URL is "https://postman-echo.com"
    And the API timeout is 5 seconds
    And user sets request timeout to 3 seconds
    When I send a GET request to "/delay/1"
    Then the response status should be 200

  # Scenario 15: Variable Management
  @variable-management
  Scenario: Test Variable Setting and Usage
    Given the API base URL is "https://postman-echo.com"
    And I set variable "testVar" to "testValue123"
    And I set request header "X-Test-Variable" to "{{testVar}}"
    When I send a GET request to "/headers"
    Then the response status should be 200
    And the response body should contain "testValue123"

  # Scenario 16: Chaining Response to Request Body
  @response-chaining
  Scenario: Test Response Data Chaining to Request Body
    # First request to get data
    Given the API base URL is "https://jsonplaceholder.typicode.com"
    When I send a GET request to "/posts/1"
    Then the response status should be 200
    And API response should be saved as "firstPost"

    # Use response data in next request
    Given user uses response JSON path "$.userId" from "firstPost" as request body field "authorId"
    And user uses response JSON path "$.title" from "firstPost" as request body field "originalTitle"
    And user sets form field "newTitle" to "Modified Title"
    When I send a POST request to "https://postman-echo.com/post"
    Then the response status should be 200

  # Scenario 17: Wait and Retry
  @wait-retry
  Scenario: Test Wait Between Requests
    Given the API base URL is "https://postman-echo.com"
    When I send a GET request to "/get"
    Then the response status should be 200
    And I wait for 2 seconds
    When I send a GET request to "/get"
    Then the response status should be 200

  # Scenario 18: Clear Context and Variables
  @context-management
  Scenario: Test Context Management
    Given the API base URL is "https://postman-echo.com"
    And I set variable "tempVar" to "tempValue"
    And I print the current context
    When I send a GET request to "/get"
    Then the response status should be 200
    And I clear the API context
    And I print the current context

  # Scenario 19: GraphQL Query
  @graphql
  Scenario: Test GraphQL Query
    Given the API base URL is "https://countries.trevorblades.com"
    And user sets GraphQL query:
      """
      query {
        country(code: "US") {
          name
          capital
          currency
        }
      }
      """
    When I send a POST request to "/graphql"
    Then the response status should be 200
    And the response body JSON path "$.data.country.name" should be "United States"
    And the response body JSON path "$.data.country.capital" should be "Washington D.C."

  # Scenario 20: XML Body Request
  @xml-body
  Scenario: Test XML Body Request
    Given the API base URL is "https://postman-echo.com"
    And user sets XML body:
      """
      <?xml version="1.0" encoding="UTF-8"?>
      <root>
        <name>Test XML</name>
        <value>123</value>
      </root>
      """
    When I send a POST request to "/post"
    Then the response status should be 200
    And the response body should contain "Test XML"

  # Scenario 21: Disable Redirect Following
  @redirect-control
  Scenario: Test Redirect Control
    Given the API base URL is "https://httpbin.org"
    And user disables redirect following for request
    When I send a GET request to "/redirect/1"
    Then the response status should be 302
    And the response header "Location" should exist

  # Scenario 22: Enable Redirect Following
  @redirect-follow
  Scenario: Test Redirect Following
    Given the API base URL is "https://postman-echo.com"
    And user enables redirect following for request
    When I send a GET request to "/redirect-to?url=https://postman-echo.com/get"
    Then the response status should be 200

  # Scenario 23: Response Body Not Contains Validation
  @negative-validation
  Scenario: Test Negative Response Validation
    Given the API base URL is "https://postman-echo.com"
    When I send a GET request to "/get"
    Then the response status should be 200
    And the response body should not contain "error"
    And the response body should not contain "failed"

  # Scenario 24: OAuth2 Client Credentials
  @oauth2-client
  Scenario: Test OAuth2 Client Credentials Flow
    Given the API base URL is "https://httpbin.org"
    And I use OAuth2 with client credentials:
      | clientId     | test-client-id     |
      | clientSecret | test-client-secret |
      | tokenUrl     | https://httpbin.org/post |
      | scope        | read write         |
    When I send a GET request to "/bearer"
    Then the response status should be 200

  # Scenario 25: API Key Authentication
  @api-key
  Scenario: Test API Key Authentication
    Given the API base URL is "https://postman-echo.com"
    And I use API key "X-API-Key" with value "test-api-key-12345"
    When I send a GET request to "/headers"
    Then the response status should be 200
    And the response body should contain "test-api-key-12345"

  # Scenario 26: Clear Query Parameters
  @clear-params
  Scenario: Test Clearing Query Parameters
    Given the API base URL is "https://postman-echo.com"
    And I set query parameter "param1" to "value1"
    And I set query parameter "param2" to "value2"
    And user clears all query parameters
    And I set query parameter "newParam" to "newValue"
    When I send a GET request to "/get"
    Then the response status should be 200
    And the response body JSON path "$.args.newParam" should be "newValue"
    And the response body JSON path "$.args.param1" should not contain "value1"

  # Scenario 27: Multiple Form Fields with Data Table
  @form-fields-table
  Scenario: Test Multiple Form Fields using Data Table
    Given the API base URL is "https://postman-echo.com"
    And user sets form fields:
      | username | john_doe           |
      | email    | john@example.com   |
      | age      | 30                 |
      | country  | USA                |
    When I send a POST request to "/post"
    Then the response status should be 200
    And the response body should contain "john_doe"
    And the response body should contain "john@example.com"

  # Scenario 28: Remove Query Parameter
  @remove-param
  Scenario: Test Removing Specific Query Parameter
    Given the API base URL is "https://postman-echo.com"
    And I set query parameter "keep" to "yes"
    And I set query parameter "remove" to "no"
    And user removes query parameter "remove"
    When I send a GET request to "/get"
    Then the response status should be 200
    And the response body JSON path "$.args.keep" should be "yes"
    And the response body JSON path "$.args.remove" should not contain "no"

  # Scenario 29: Clear Request Body
  @clear-body
  Scenario: Test Clearing Request Body
    Given the API base URL is "https://postman-echo.com"
    And I set request body to:
      """
      {"initial": "body"}
      """
    And user clears request body
    And user sets JSON body:
      """
      {"new": "body"}
      """
    When I send a POST request to "/post"
    Then the response status should be 200
    And the response body should contain "new"
    And the response body should not contain "initial"

  # Scenario 30: Print Chain History (for debugging)
  @chain-history
  Scenario: Test Chain History Printing
    Given the API base URL is "https://jsonplaceholder.typicode.com"
    When I send a GET request to "/posts/1"
    Then the response status should be 200
    And API response should be saved as "post1"
    When I send a GET request to "/posts/2"
    Then the response status should be 200
    And API response should be saved as "post2"
    And user prints chain history

  # Scenario 31: Clear Authentication
  @clear-auth
  Scenario: Test Clearing Authentication
    Given the API base URL is "https://postman-echo.com"
    And I use basic authentication with username "user" and password "pass"
    And I clear authentication
    When I send a GET request to "/basic-auth"
    Then the response status should be 401

  # Scenario 32: Custom Authentication Header
  @custom-auth-header
  Scenario: Test Custom Authentication Header
    Given the API base URL is "https://postman-echo.com"
    And I add custom authentication header "X-Custom-Auth" with value "custom-token-xyz"
    When I send a GET request to "/headers"
    Then the response status should be 200
    And the response body should contain "custom-token-xyz"

  # Scenario 33: Set Request Encoding
  @request-encoding
  Scenario: Test Request Encoding
    Given the API base URL is "https://postman-echo.com"
    And user sets request encoding to "gzip"
    When I send a GET request to "/headers"
    Then the response status should be 200
    And the response body should contain "gzip"

  # Scenario 34: Set Retry Count
  @retry-config
  Scenario: Test Retry Configuration
    Given the API base URL is "https://postman-echo.com"
    And user sets retry count to 3
    When I send a GET request to "/get"
    Then the response status should be 200

  # Scenario 35: Multipart Form Data
  @multipart
  Scenario: Test Multipart Form Data
    Given the API base URL is "https://postman-echo.com"
    And user sets multipart field "field1" to "value1"
    And user sets multipart field "field2" to "value2"
    When I send a POST request to "/post"
    Then the response status should be 200

  # Scenario 36: Raw Body
  @raw-body
  Scenario: Test Raw Body
    Given the API base URL is "https://postman-echo.com"
    And user sets raw body to "This is raw text content"
    When I send a POST request to "/post"
    Then the response status should be 200
    And the response body should contain "This is raw text content"

  # Scenario 37: Response Header Validation
  @header-validation
  Scenario: Test Response Header Validation
    Given the API base URL is "https://postman-echo.com"
    When I send a GET request to "/response-headers?Content-Type=application/json"
    Then the response status should be 200
    And the response header "Content-Type" should contain "application/json"

  # Scenario 38: JSON Path Validation
  @jsonpath-validation
  Scenario: Test JSON Path Existence
    Given the API base URL is "https://jsonplaceholder.typicode.com"
    When I send a GET request to "/posts/1"
    Then the response status should be 200
    And the response body JSON path "$.userId" should exist
    And the response body JSON path "$.id" should exist
    And the response body JSON path "$.title" should exist
    And the response body JSON path "$.body" should exist

  # Scenario 39: Set Request Method
  @request-method
  Scenario: Test Setting Request Method
    Given the API base URL is "https://postman-echo.com"
    And user sets request method to "OPTIONS"
    When I send a GET request to "/"
    Then the response status should be 200

  # Scenario 40: HTTP/2 Configuration
  @http2
  Scenario: Test HTTP/2 Configuration
    Given the API base URL is "https://httpbin.org"
    And user enables HTTP/2 for request
    When I send a GET request to "/get"
    Then the response status should be 200
    And the response body should contain "headers"

  # Scenario 41: Set Maximum Response Size
  @max-response-size
  Scenario: Test Maximum Response Size Configuration
    Given the API base URL is "https://postman-echo.com"
    And user sets maximum response size to 10 MB
    When I send a GET request to "/get"
    Then the response status should be 200

  # Scenario 42: Digest Authentication
  @digest-auth
  Scenario: Test Digest Authentication
    Given the API base URL is "https://httpbin.org"
    And I use digest authentication with username "user" and password "pass"
    When I send a GET request to "/digest-auth/auth/user/pass"
    Then the response status should be 200

  # Scenario 43: JWT Authentication
  @jwt-auth
  Scenario: Test JWT Authentication
    Given the API base URL is "https://postman-echo.com"
    And I use JWT authentication with token "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    When I send a GET request to "/headers"
    Then the response status should be 200

  # Scenario 44: NTLM Authentication
  @ntlm-auth
  Scenario: Test NTLM Authentication
    Given the API base URL is "https://postman-echo.com"
    And I use NTLM authentication with domain "DOMAIN" username "user" and password "pass"
    When I send a GET request to "/get"
    Then the response status should be 200
    And the response body should contain "headers"

  # Scenario 45: AWS Signature Authentication
  @aws-auth
  Scenario: Test AWS Signature Authentication
    Given the API base URL is "https://httpbin.org"
    And I use AWS signature authentication with access key "ACCESS_KEY" and secret key "SECRET_KEY"
    And I use AWS signature authentication with region "us-east-1" and service "execute-api"
    When I send a GET request to "/get"
    Then the response status should be 200

  # Scenario 46: Merge Response Into Request Body
  @merge-response
  Scenario: Test Merging Response into Request Body
    Given the API base URL is "https://jsonplaceholder.typicode.com"
    When I send a GET request to "/posts/1"
    Then the response status should be 200
    And API response should be saved as "originalPost"

    Given user merges response from "originalPost" into request body
    When I send a POST request to "https://postman-echo.com/post"
    Then the response status should be 200

  # Scenario 47: Append to Body Array
  @append-array
  Scenario: Test Appending to Body Array
    Given the API base URL is "https://jsonplaceholder.typicode.com"
    When I send a GET request to "/posts/1"
    Then the response status should be 200
    And API response should be saved as "post1"

    Given user sets JSON body:
      """
      {"items": []}
      """
    And user appends JSON path "$.title" from "post1" to request body array "items"
    When I send a POST request to "https://postman-echo.com/post"
    Then the response status should be 200

  # Scenario 48: Use Status Code as Query Parameter
  @status-as-param
  Scenario: Test Using Status Code as Query Parameter
    Given the API base URL is "https://postman-echo.com"
    When I send a GET request to "/get"
    Then the response status should be 200
    And API response should be saved as "statusResponse"
    And user uses status code from "statusResponse" as query parameter "previousStatus"
    When I send a GET request to "/get"
    Then the response status should be 200
    And the response body JSON path "$.args.previousStatus" should be "200"

  # Scenario 49: Clear Chain Context
  @clear-chain
  Scenario: Test Clearing Chain Context
    Given the API base URL is "https://jsonplaceholder.typicode.com"
    When I send a GET request to "/posts/1"
    Then the response status should be 200
    And API response should be saved as "cachedPost"
    And user clears chain context
    # After clearing, the saved response should still be available in the API context

  # Scenario 50: Set Request Path
  @request-path
  Scenario: Test Setting Request Path
    Given the API base URL is "https://jsonplaceholder.typicode.com"
    And user sets request path to "/posts/5"
    When I send a GET request to "{{requestPath}}"
    Then the response status should be 200

  # Scenario 51: PFX Certificate Authentication - Simple
  @pfx-certificate @certificate-auth
  Scenario: Test HTTPBin GET endpoint with PFX certificate authentication - Simple
    Given the API base URL is "https://httpbin.org"
    And the API timeout is 30 seconds
    And user loads certificate from "test/api/certificates/client.pfx" with password "test123"
    When I send a GET request to "/get"
    Then the response status should be 200
    And the response body JSON path "$.url" should be "https://httpbin.org/get"
    And the response body JSON path "$.headers" should exist
    And the response body JSON path "$.args" should exist
    And the response body JSON path "$.origin" should exist
    And the response body should contain "httpbin.org"
    And the response time should be less than 5000 ms

  # Scenario 52: PFX Certificate Authentication - Response Validation
  @pfx-certificate @certificate-auth @validation
  Scenario: Verify HTTPBin GET response structure with PFX certificate
    Given the API base URL is "https://httpbin.org"
    And the API timeout is 30 seconds
    And user loads certificate from "test/api/certificates/client.pfx" with password "test123"
    When I send a GET request to "/get"
    Then the response status should be 200
    And the response body JSON path "$.headers.Host" should be "httpbin.org"
    And the response body JSON path "$.headers.User-Agent" should exist
    And the response body should contain "https://httpbin.org/get"
    And I print the last response

  # ============================================================================
  # SECTION: STANDARDIZED VARIABLE INTERPOLATION IN API TESTING
  # ============================================================================
  # All API steps now use centralized configManager.interpolate() method
  # Supporting ALL interpolation syntax types universally:
  #
  # 1. {VAR}                     - Config variable
  # 2. ${VAR:-default}           - Config/env variable with default
  # 3. {env:VAR}                 - Explicit environment variable
  # 4. {config:KEY}              - Explicit config variable
  # 5. {{VAR}} or {context:VAR}  - Runtime context variable
  # 6. {ternary:COND?TRUE:FALSE} - Conditional interpolation
  # 7. {concat:VAR1+VAR2}        - Concatenation
  # 8. {upper:VAR}, {lower:VAR}  - Case transformation
  # 9. <random>, <timestamp>, <uuid>, <date:FORMAT>, <generate:TYPE> - Dynamic values
  # ============================================================================

  @api @variable-interpolation @config-vars @demo
  Scenario: API Interpolation Type 1 - Config Variables {VAR} and {config:KEY}
    # Test {VAR} and {config:KEY} syntax in API requests
    Given the API base URL is "https://postman-echo.com"

    # Using {VAR} syntax - references config variable
    And I set request header "X-Project" to "{PROJECT}"
    And I set request header "X-Environment" to "{ENVIRONMENT}"

    # Using {config:KEY} syntax - explicit config lookup
    And I set request header "X-Config-Project" to "{config:PROJECT}"

    When I send a GET request to "/headers"
    Then the response status should be 200
    And the response body should contain "orangehrm"

  @api @variable-interpolation @env-vars @demo
  Scenario: API Interpolation Type 2 - Environment Variables ${VAR} and {env:VAR}
    # Test ${VAR} and {env:VAR} syntax in API requests
    Given the API base URL is "https://postman-echo.com"

    # Using ${VAR:-default} syntax - env variable with default
    And I set request header "X-User" to "${USER:-testuser}"

    # Using {env:VAR} syntax - explicit environment variable
    And I set request header "X-Home" to "{env:HOME}"

    When I send a GET request to "/headers"
    Then the response status should be 200

  @api @variable-interpolation @context-vars @demo
  Scenario: API Interpolation Type 3 - Context Variables {{VAR}} and {context:VAR}
    # Test {{VAR}} and {context:VAR} syntax with runtime values
    Given the API base URL is "https://jsonplaceholder.typicode.com"

    # First request to get data
    When I send a GET request to "/posts/1"
    Then the response status should be 200

    # Extract and save to context
    Given I extract "$.userId" from response and save as "userId"
    Given I extract "$.id" from response and save as "postId"

    # Use context variables with {{VAR}} syntax
    Given the API base URL is "https://postman-echo.com"
    And I set request header "X-User-Id" to "{{userId}}"
    And I set request header "X-Post-Id" to "{{postId}}"

    When I send a GET request to "/headers"
    Then the response status should be 200
    And the response body should contain "1"

  @api @variable-interpolation @conditional @demo
  Scenario: API Interpolation Type 4 - Ternary Conditionals {ternary:COND?TRUE:FALSE}
    # Test {ternary:...} syntax for conditional values
    Given the API base URL is "https://postman-echo.com"

    # Use ternary to set header value based on config
    And I set request header "X-Mode" to "{ternary:HEADLESS?automated:manual}"
    And I set request header "X-Browser-Type" to "{ternary:BROWSER?{BROWSER}:chrome}"

    When I send a GET request to "/headers"
    Then the response status should be 200

  @api @variable-interpolation @concatenation @demo
  Scenario: API Interpolation Type 5 - Concatenation {concat:VAR1+VAR2}
    # Test {concat:...} syntax for combining values
    Given the API base URL is "https://postman-echo.com"

    # Use concat to build composite header values
    And I set request header "X-Full-Context" to "{concat:PROJECT+ENVIRONMENT}"
    And I set query parameter "context" to "{concat:PROJECT+ENVIRONMENT}"

    When I send a GET request to "/get"
    Then the response status should be 200
    And the response body should contain "orangehrm"

  @api @variable-interpolation @case-transform @demo
  Scenario: API Interpolation Type 6 - Case Transformation {upper:VAR} and {lower:VAR}
    # Test {upper:...} and {lower:...} syntax
    Given the API base URL is "https://postman-echo.com"

    # Use case transformations
    And I set request header "X-Project-Upper" to "{upper:PROJECT}"
    And I set request header "X-Project-Lower" to "{lower:PROJECT}"
    And I set query parameter "project_upper" to "{upper:PROJECT}"

    When I send a GET request to "/get"
    Then the response status should be 200
    And the response body should contain "ORANGEHRM"

  @api @variable-interpolation @dynamic-values @demo
  Scenario: API Interpolation Type 7 - Dynamic Placeholders <random>, <timestamp>, <uuid>
    # Test <placeholder> syntax for dynamic value generation
    Given the API base URL is "https://postman-echo.com"

    # Generate dynamic values
    And I set request header "X-Request-Id" to "<uuid>"
    And I set request header "X-Timestamp" to "<timestamp>"
    And I set query parameter "random_id" to "test_<random>"
    And I set query parameter "date" to "<date:YYYY-MM-DD>"

    When I send a GET request to "/get"
    Then the response status should be 200

  @api @variable-interpolation @generate-values @demo
  Scenario: API Interpolation Type 8 - Generated Test Data <generate:TYPE>
    # Test <generate:TYPE> syntax for test data generation
    Given the API base URL is "https://postman-echo.com"

    # Generate test data
    And I set JSON body:
      """
      {
        "email": "<generate:email>",
        "username": "<generate:username>",
        "phone": "<generate:phone>",
        "password": "<generate:password>"
      }
      """

    When I send a POST request to "/post"
    Then the response status should be 200
    And the response body JSON path "$.json.email" should exist
    And the response body JSON path "$.json.username" should exist

  @api @variable-interpolation @combined-all @demo
  Scenario: API Interpolation Type 9 - All Interpolation Types Combined
    # Demonstrate using multiple interpolation types in single request
    Given the API base URL is "https://postman-echo.com"

    # Combine all interpolation types
    And I set request headers:
      | X-Project          | {PROJECT}                                  |
      | X-Environment      | {config:ENVIRONMENT}                       |
      | X-User             | ${USER:-testuser}                          |
      | X-Mode             | {ternary:HEADLESS?automated:manual}        |
      | X-Composite        | {concat:PROJECT+ENVIRONMENT}               |
      | X-Project-Upper    | {upper:PROJECT}                            |
      | X-Request-Id       | <uuid>                                     |
      | X-Timestamp        | <timestamp>                                |
      | X-Test-Email       | <generate:email>                           |

    When I send a GET request to "/headers"
    Then the response status should be 200
    And the response body should contain "orangehrm"
    And the response body should contain "ORANGEHRM"

  @api @variable-interpolation @request-body @demo
  Scenario: Interpolation in Request Body - JSON with All Types
    # Test interpolation in JSON request body
    Given the API base URL is "https://postman-echo.com"

    And I set JSON body:
      """
      {
        "project": "{PROJECT}",
        "environment": "{config:ENVIRONMENT}",
        "user": "${USER:-testuser}",
        "mode": "{ternary:HEADLESS?automated:manual}",
        "context": "{concat:PROJECT+ENVIRONMENT}",
        "project_upper": "{upper:PROJECT}",
        "request_id": "<uuid>",
        "timestamp": "<timestamp>",
        "random_id": "test_<random>",
        "test_email": "<generate:email>",
        "test_username": "<generate:username>",
        "test_phone": "<generate:phone>",
        "current_date": "<date:YYYY-MM-DD>",
        "current_datetime": "<date:YYYY-MM-DD HH:mm:ss>"
      }
      """

    When I send a POST request to "/post"
    Then the response status should be 200
    And the response body JSON path "$.json.project" should be "orangehrm"
    And the response body JSON path "$.json.project_upper" should be "ORANGEHRM"
    And the response body JSON path "$.json.test_email" should exist
    And the response body JSON path "$.json.request_id" should exist

  @api @variable-interpolation @query-params @demo
  Scenario: Interpolation in Query Parameters with All Syntax Types
    # Test interpolation in query parameters
    Given the API base URL is "https://postman-echo.com"

    And user sets query parameters:
      | project         | {PROJECT}                             |
      | env             | {config:ENVIRONMENT}                  |
      | user            | ${USER:-testuser}                     |
      | mode            | {ternary:HEADLESS?auto:manual}        |
      | context         | {concat:PROJECT+ENVIRONMENT}          |
      | project_upper   | {upper:PROJECT}                       |
      | random_id       | <random>                              |
      | timestamp       | <timestamp>                           |
      | uuid            | <uuid>                                |
      | date            | <date:YYYY-MM-DD>                     |

    When I send a GET request to "/get"
    Then the response status should be 200
    And the response body JSON path "$.args.project" should be "orangehrm"
    And the response body JSON path "$.args.project_upper" should be "ORANGEHRM"

  @api @variable-interpolation @url-interpolation @demo
  Scenario: Interpolation in URL Path and Endpoint
    # Test interpolation in URL paths
    Given the API base URL is "https://jsonplaceholder.typicode.com"

    # Set a post ID in context
    And I set variable "postId" to "1"

    # Use interpolation in URL path
    When I send a GET request to "/posts/{{postId}}"
    Then the response status should be 200
    And the response body JSON path "$.id" should be 1

  @api @variable-interpolation @chaining-with-interpolation @demo
  Scenario: API Chaining with Standardized Interpolation
    # Demonstrate chaining with all interpolation types
    Given the API base URL is "https://jsonplaceholder.typicode.com"

    # First request - get a post
    When I send a GET request to "/posts/1"
    Then the response status should be 200
    And I extract "$.userId" from response and save as "userId"
    And I extract "$.id" from response and save as "postId"
    And I extract "$.title" from response and save as "postTitle"

    # Second request - use extracted values with interpolation
    Given the API base URL is "https://postman-echo.com"
    And I set JSON body:
      """
      {
        "extracted_user_id": "{{userId}}",
        "extracted_post_id": "{{postId}}",
        "extracted_title": "{{postTitle}}",
        "project": "{PROJECT}",
        "environment": "{config:ENVIRONMENT}",
        "test_mode": "{ternary:HEADLESS?automated:manual}",
        "composite": "{concat:PROJECT+ENVIRONMENT}",
        "request_id": "<uuid>",
        "timestamp": "<timestamp>",
        "test_email": "<generate:email>"
      }
      """

    When I send a POST request to "/post"
    Then the response status should be 200
    And the response body JSON path "$.json.extracted_user_id" should be "1"
    And the response body JSON path "$.json.project" should be "orangehrm"

  @api @variable-interpolation @form-data-interpolation @demo
  Scenario: Interpolation in Form Data
    # Test interpolation in form fields
    Given the API base URL is "https://postman-echo.com"

    And user sets form fields:
      | project       | {PROJECT}                          |
      | environment   | {config:ENVIRONMENT}               |
      | mode          | {ternary:HEADLESS?auto:manual}     |
      | context       | {concat:PROJECT+ENVIRONMENT}       |
      | timestamp     | <timestamp>                        |
      | random_id     | test_<random>                      |
      | test_email    | <generate:email>                   |

    When I send a POST request to "/post"
    Then the response status should be 200
    And the response body should contain "orangehrm"

  @api @variable-interpolation @authentication-interpolation @demo
  Scenario: Interpolation in Authentication Headers
    # Test interpolation in auth configuration
    Given the API base URL is "https://postman-echo.com"

    # Set token using interpolation
    And I set variable "apiToken" to "test_token_<random>"
    And I use bearer token "{{apiToken}}"

    When I send a GET request to "/headers"
    Then the response status should be 200
    And the response body should contain "test_token"

  @api @variable-interpolation @multipart-interpolation @demo
  Scenario: Interpolation in Multipart Form Data
    # Test interpolation in multipart fields
    Given the API base URL is "https://postman-echo.com"

    And user sets multipart field "project" to "{PROJECT}"
    And user sets multipart field "env" to "{config:ENVIRONMENT}"
    And user sets multipart field "request_id" to "<uuid>"
    And user sets multipart field "email" to "<generate:email>"

    When I send a POST request to "/post"
    Then the response status should be 200

  @api @variable-interpolation @xml-body-interpolation @demo
  Scenario: Interpolation in XML Request Body
    # Test interpolation in XML body
    Given the API base URL is "https://postman-echo.com"

    And user sets XML body:
      """
      <?xml version="1.0" encoding="UTF-8"?>
      <request>
        <project>{PROJECT}</project>
        <environment>{config:ENVIRONMENT}</environment>
        <mode>{ternary:HEADLESS?automated:manual}</mode>
        <timestamp><timestamp></timestamp>
        <uuid><uuid></uuid>
        <email><generate:email></email>
      </request>
      """

    When I send a POST request to "/post"
    Then the response status should be 200
    And the response body should contain "orangehrm"

  @api @variable-interpolation @graphql-interpolation @demo
  Scenario: Interpolation in GraphQL Queries
    # Test interpolation in GraphQL query
    Given the API base URL is "https://countries.trevorblades.com"

    # Set country code using interpolation
    And I set variable "countryCode" to "US"

    And user sets GraphQL query:
      """
      query {
        country(code: "{{countryCode}}") {
          name
          capital
          currency
        }
      }
      """

    When I send a POST request to "/graphql"
    Then the response status should be 200
    And the response body JSON path "$.data.country.name" should be "United States"