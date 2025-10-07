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