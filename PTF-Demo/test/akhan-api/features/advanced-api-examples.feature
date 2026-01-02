Feature: Advanced API Testing Examples
  As a QA engineer
  I want to demonstrate advanced API testing capabilities
  So that I can validate complex API scenarios

  Background:
    Given user is working with API context "advanced-api"
    And user sets base URL to "https://jsonplaceholder.typicode.com"
    And user sets request timeout to 30 seconds

  @api @advanced @crud @chaining
  Scenario: Complete CRUD operations with data chaining
    # CREATE - Post new user
    Given user sets request body to:
      """
      {
        "name": "John Doe",
        "username": "johndoe",
        "email": "john.doe@example.com",
        "phone": "1-770-736-8031 x56442",
        "website": "john.org",
        "company": {
          "name": "Doe Industries",
          "catchPhrase": "Quality first"
        }
      }
      """
    When user sends POST request to "/users" and saves response as "create-user"
    Then response status should be 201
    And response JSON path "$.name" should equal "John Doe"
    And response JSON path "$.email" should equal "john.doe@example.com"
    And user saves response JSON path "$.id" as "newUserId"

    # READ - Get the created user
    When user sends GET request to "/users/{{newUserId}}" and saves response as "get-user"
    Then response status should be 200
    And response JSON path "$.id" should equal "{{newUserId}}"

    # UPDATE - Update the user
    Given user sets request body to:
      """
      {
        "id": "{{newUserId}}",
        "name": "John Updated",
        "username": "johndoe_updated",
        "email": "john.updated@example.com"
      }
      """
    When user sends PUT request to "/users/{{newUserId}}" and saves response as "update-user"
    Then response status should be 200
    And response JSON path "$.name" should equal "John Updated"

    # DELETE - Delete the user
    When user sends DELETE request to "/users/{{newUserId}}"
    Then response status should be 200

  @api @advanced @parallel @performance
  Scenario: Parallel API requests for performance testing
    When user executes parallel requests:
      | GET | /users   | users-list   |
      | GET | /posts   | posts-list   |
      | GET | /albums  | albums-list  |
      | GET | /todos   | todos-list   |
      | GET | /comments| comments-list|

    Then response from "users-list" status should be 200
    And response from "posts-list" status should be 200
    And response from "albums-list" status should be 200
    And response from "todos-list" status should be 200
    And response from "comments-list" status should be 200

    # Validate response structures
    And response from "users-list" JSON path "$" should be of type "array"
    And response from "posts-list" JSON path "$[0].userId" should exist
    And response from "albums-list" JSON path "$[0].title" should exist
    And response from "todos-list" JSON path "$[0].completed" should be of type "boolean"

  @api @advanced @authentication @oauth2
  Scenario: OAuth2 authentication flow simulation
    Given user is working with API context "oauth-test"
    And user sets base URL to "https://httpbin.org"

    # Simulate OAuth2 token request
    Given user sets request body to:
      """
      {
        "grant_type": "client_credentials",
        "client_id": "test-client-id",
        "client_secret": "test-client-secret",
        "scope": "read write"
      }
      """
    And user sets Content-Type to "application/x-www-form-urlencoded"
    When user sends POST request to "/post" and saves response as "token-response"
    Then response status should be 200

    # Simulate using the token (we'll create a mock token for demonstration)
    Given user saves "mock-access-token-12345" as "accessToken"
    And user sets bearer token "{{accessToken}}"
    When user sends GET request to "/bearer"
    Then response status should be 200
    And response JSON path "$.token" should equal "{{accessToken}}"

  @api @advanced @data-validation @schema
  Scenario: Advanced data validation with schema
    When user sends GET request to "/users/1" and saves response as "user-details"
    Then response status should be 200

    # Validate specific field types and formats
    And response JSON path "$.id" should be of type "number"
    And response JSON path "$.name" should be of type "string"
    And response JSON path "$.email" should be of type "string"
    And response JSON path "$.phone" should be of type "string"
    And response JSON path "$.website" should be of type "string"
    And response JSON path "$.address.geo.lat" should be of type "string"
    And response JSON path "$.address.geo.lng" should be of type "string"
    And response JSON path "$.company.name" should exist

  @api @advanced @error-handling @retry
  Scenario: Error handling and retry mechanisms
    Given user is working with API context "error-handling"
    And user sets base URL to "https://httpbin.org"
    And user sets retry count to 3
    And user sets retry delay to 1000 milliseconds

    # Test 404 error handling
    When user sends GET request to "/status/404"
    Then response status should be 404

    # Test 500 error handling
    When user sends GET request to "/status/500"
    Then response status should be 500

    # Test timeout handling
    Given user sets request timeout to 2 seconds
    When user sends GET request to "/delay/5"
    # This should timeout, but the framework should handle it gracefully

  @api @advanced @conditional @business-logic
  Scenario: Conditional API requests based on business logic
    # Get user details
    When user sends GET request to "/users/1" and saves response as "user-info"
    Then response status should be 200
    And user saves response JSON path "$.company.name" as "companyName"

    # Conditional request based on company
    Given user compares "{{companyName}}" with "Romaguera-Crona" and saves result as "isTargetCompany"
    When user executes conditional request if "isTargetCompany" equals "true"
    And user sends GET request to "/users/1/posts"
    Then response status should be 200

  @api @advanced @file-operations @multipart
  Scenario: File upload and download operations
    Given user is working with API context "file-ops"
    And user sets base URL to "https://httpbin.org"

    # Simulate file upload with multipart form data
    Given user adds form field "description" with value "Test file upload"
    And user adds form field "category" with value "documents"
    And user sets request body to:
      """
      {
        "filename": "test-document.txt",
        "content": "VGhpcyBpcyBhIHRlc3QgZmlsZSBjb250ZW50",
        "size": 1024
      }
      """
    When user sends POST request to "/post" and saves response as "upload-response"
    Then response status should be 200
    And response JSON path "$.json.filename" should equal "test-document.txt"
    And response JSON path "$.json.size" should equal 1024

  @api @advanced @pagination @data-aggregation
  Scenario: Pagination and data aggregation
    # Get first page of posts
    Given user sets query parameter "userId" to "1"
    And user sets query parameter "_limit" to "5"
    When user sends GET request to "/posts" and saves response as "posts-page1"
    Then response status should be 200
    And response JSON path "$" array should have length 5

    # Get user details for aggregation
    When user sends GET request to "/users/1" and saves response as "user-data"
    Then response status should be 200

    # Aggregate data from both requests
    When user chains from "user-data" to request body:
      | $.name     | authorName  |
      | $.email    | authorEmail |
      | $.company.name | companyName |

    # Create aggregated response
    Given user sets request body to:
      """
      {
        "author": {
          "name": "{{authorName}}",
          "email": "{{authorEmail}}",
          "company": "{{companyName}}"
        },
        "totalPosts": 5,
        "aggregatedAt": "{{timestamp}}"
      }
      """
    When user sends POST request to "/posts" and saves response as "aggregated-data"
    Then response status should be 201

  @api @advanced @monitoring @performance-thresholds
  Scenario: API performance monitoring with thresholds
    # Test various endpoints with performance expectations
    When user executes request and measures performance
    And user sends GET request to "/users"
    Then response status should be 200
    And response time should be less than 2000 ms

    When user executes request and measures performance
    And user sends GET request to "/posts"
    Then response status should be 200
    And response time should be less than 3000 ms

    When user executes request and measures performance
    And user sends GET request to "/users/1"
    Then response status should be 200
    And response time should be less than 1500 ms

  @api @advanced @security @input-validation
  Scenario: Security testing - Input validation
    # Test SQL injection prevention
    Given user sets query parameter "id" to "1' OR '1'='1"
    When user sends GET request to "/users"
    Then response status should be 200
    # Should return normal response, not all users

    # Test XSS prevention in request body
    Given user sets request body to:
      """
      {
        "title": "<script>alert('xss')</script>",
        "body": "Test post with potential XSS",
        "userId": 1
      }
      """
    When user sends POST request to "/posts"
    Then response status should be 201
    # The script should be escaped or sanitized

  @api @advanced @circuit-breaker @resilience
  Scenario: Circuit breaker and resilience testing
    Given user is working with API context "resilience-test"
    And user sets base URL to "https://httpbin.org"
    And user sets circuit breaker threshold to 3
    And user sets circuit breaker timeout to 5000 milliseconds

    # Test normal operation first
    When user sends GET request to "/get"
    Then response status should be 200

    # Test circuit breaker with failing requests
    When user executes request with circuit breaker
    And user sends GET request to "/status/500"
    # Circuit breaker should handle this gracefully

  @api @advanced @data-transformation @json-manipulation
  Scenario: Complex data transformation and JSON manipulation
    # Get user data
    When user sends GET request to "/users/1" and saves response as "raw-user"
    Then response status should be 200

    # Get user's posts
    When user sends GET request to "/users/1/posts" and saves response as "user-posts"
    Then response status should be 200

    # Transform and combine data
    When user uses response JSON path "$.name" from "raw-user" as request body field "profile.fullName"
    And user uses response JSON path "$.email" from "raw-user" as request body field "profile.contactEmail"
    And user uses response JSON path "$.company.name" from "raw-user" as request body field "profile.organization"

    # Add post count from posts response
    Given user saves "{{user-posts.length}}" as "postCount"
    And user sets request body to:
      """
      {
        "profile": {
          "fullName": "{{profile.fullName}}",
          "contactEmail": "{{profile.contactEmail}}",
          "organization": "{{profile.organization}}"
        },
        "statistics": {
          "totalPosts": "{{postCount}}",
          "lastUpdated": "{{timestamp}}"
        }
      }
      """

    # Send transformed data
    When user sends POST request to "/posts"
    Then response status should be 201