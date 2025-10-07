Feature: API Response Validation Examples
  As a QA engineer
  I want to validate API responses comprehensively
  So that I can ensure data quality and correctness

  Background:
    Given user is working with API context "validation-test"
    And user sets base URL to "https://jsonplaceholder.typicode.com"

  @api @validation @status-codes
  Scenario: Status Code Validation
    When user sends GET request to "/users/1"
    Then response status should be 200
    And response status should be between 200 and 299

    When user sends GET request to "/users/999"
    Then response status should be 404

    When user sends POST request to "/posts"
    Then response status should be 201

  @api @validation @headers
  Scenario: Header Validation
    When user sends GET request to "/users"
    Then response status should be 200
    And response header "Content-Type" should contain "application/json"
    And response header "Content-Type" should exist

    # Custom headers (if API supports them)
    Given user sets request header "X-Request-ID" to "test-12345"
    When user sends GET request to "/users/1"
    Then response status should be 200

  @api @validation @json-path @basic
  Scenario: Basic JSONPath Validation
    When user sends GET request to "/users/1"
    Then response status should be 200
    And response JSON path "$.id" should equal 1
    And response JSON path "$.name" should exist
    And response JSON path "$.email" should exist
    And response JSON path "$.phone" should exist
    And response JSON path "$.website" should exist

  @api @validation @json-path @advanced
  Scenario: Advanced JSONPath Validation
    When user sends GET request to "/users"
    Then response status should be 200
    And response JSON path "$" should be of type "array"
    And response JSON path "$" array should have length 10
    And response JSON path "$[0].id" should exist
    And response JSON path "$[0].name" should be of type "string"
    And response JSON path "$[0].address.geo.lat" should exist

  @api @validation @json-path @nested
  Scenario: Nested Object Validation
    When user sends GET request to "/users/1"
    Then response status should be 200
    And response JSON path "$.address.street" should exist
    And response JSON path "$.address.city" should exist
    And response JSON path "$.address.geo.lat" should be of type "string"
    And response JSON path "$.address.geo.lng" should be of type "string"
    And response JSON path "$.company.name" should exist
    And response JSON path "$.company.catchPhrase" should exist

  @api @validation @array @operations
  Scenario: Array Validation Operations
    When user sends GET request to "/users/1/posts"
    Then response status should be 200
    And response JSON path "$" should be of type "array"
    And response JSON path "$" array should have length greater than 0
    And response JSON path "$[0].id" should exist
    And response JSON path "$[0].title" should exist
    And response JSON path "$[0].body" should exist
    And response JSON path "$[0].userId" should equal 1

  @api @validation @data-types
  Scenario: Data Type Validation
    When user sends GET request to "/users/1"
    Then response status should be 200
    And response JSON path "$.id" should be of type "number"
    And response JSON path "$.name" should be of type "string"
    And response JSON path "$.email" should be of type "string"
    And response JSON path "$.address" should be of type "object"

    When user sends GET request to "/users/1/todos"
    Then response status should be 200
    And response JSON path "$[0].completed" should be of type "boolean"
    And response JSON path "$[0].id" should be of type "number"

  @api @validation @string-patterns
  Scenario: String Pattern Validation
    When user sends GET request to "/users/1"
    Then response status should be 200
    And response JSON path "$.email" should match regex "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"
    And response JSON path "$.website" should match regex "^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"
    And response JSON path "$.phone" should match regex "^[0-9\-\.\s\x\(\)]+$"

  @api @validation @response-body @content
  Scenario: Response Body Content Validation
    When user sends GET request to "/users/1/posts"
    Then response status should be 200
    And response body should contain "sunt aut"
    And response body should contain "userId"
    And response body should be valid JSON

    # Validate response size
    And response size should be less than 10240 bytes

  @api @validation @performance @timing
  Scenario: Performance and Timing Validation
    When user executes request and measures performance
    And user sends GET request to "/users"
    Then response status should be 200
    And response time should be less than 3000 ms

    When user executes request and measures performance
    And user sends GET request to "/posts"
    Then response status should be 200
    And response time should be less than 3000 ms
    And user prints variable "lastRequestDuration"

  @api @validation @schema @json-schema
  Scenario: JSON Schema Validation
    When user sends GET request to "/users/1"
    Then response status should be 200
    # Note: You would need to create actual schema files
    # And response body should match JSON schema in "user-schema.json"

    # Validate basic structure without schema file
    And response JSON path "$.id" should exist
    And response JSON path "$.name" should exist
    And response JSON path "$.username" should exist
    And response JSON path "$.email" should exist
    And response JSON path "$.address" should exist
    And response JSON path "$.phone" should exist
    And response JSON path "$.website" should exist
    And response JSON path "$.company" should exist

  @api @validation @conditional
  Scenario: Conditional Validation
    When user sends GET request to "/users/1"
    Then response status should be 200
    And user saves response JSON path "$.name" as "userName"

    # Conditional validation based on response data
    When user compares "{{userName}}" with "Leanne Graham" and saves result as "isLeanne"
    Then variable "isLeanne" should equal "true"

  @api @validation @cross-field
  Scenario: Cross-Field Validation
    When user sends GET request to "/users/1"
    Then response status should be 200
    And user saves response JSON path "$.id" as "userId"

    When user sends GET request to "/users/1/posts"
    Then response status should be 200
    And response JSON path "$[0].userId" should equal "{{userId}}"

  @api @validation @negative @error-responses
  Scenario: Error Response Validation
    When user sends GET request to "/users/999"
    Then response status should be 404

    When user sends POST request to "/posts"
    # Missing required fields
    Then response status should be 201
    # Note: JSONPlaceholder is permissive, but normally this would be 400

  @api @validation @multiple-assertions
  Scenario: Multiple Assertions on Single Response
    When user sends GET request to "/users/1" and saves response as "user-data"
    Then response from "user-data" status should be 200
    And response from "user-data" JSON path "$.id" should equal 1
    And response from "user-data" JSON path "$.name" should equal "Leanne Graham"
    And response from "user-data" JSON path "$.username" should equal "Bret"
    And response from "user-data" JSON path "$.email" should equal "Sincere@april.biz"

  @api @validation @batch @responses
  Scenario: Batch Response Validation
    When user executes parallel requests:
      | GET | /users/1 | user1 |
      | GET | /users/2 | user2 |
      | GET | /users/3 | user3 |

    Then response from "user1" status should be 200
    And response from "user2" status should be 200
    And response from "user3" status should be 200

    And response from "user1" JSON path "$.id" should equal 1
    And response from "user2" JSON path "$.id" should equal 2
    And response from "user3" JSON path "$.id" should equal 3

  @api @validation @data-integrity
  Scenario: Data Integrity Validation
    # Get user and their posts to verify data consistency
    When user sends GET request to "/users/1" and saves response as "user-info"
    Then response status should be 200
    And user saves response JSON path "$.id" as "userId"

    When user sends GET request to "/posts?userId={{userId}}" and saves response as "user-posts"
    Then response status should be 200
    And response JSON path "$[0].userId" should equal "{{userId}}"

    # Verify all posts belong to the same user
    When user validates all posts belong to user "{{userId}}"

  @api @validation @custom @business-rules
  Scenario: Custom Business Rule Validation
    When user sends GET request to "/users/1/albums" and saves response as "user-albums"
    Then response status should be 200
    And response JSON path "$" should be of type "array"

    # Custom validation: User should have at least 1 album
    And response JSON path "$" array should have length greater than 0

    # Custom validation: All albums should belong to the user
    When user validates response "user-albums" with custom rule "allAlbumsBelongToUser"

  @api @validation @empty @responses
  Scenario: Empty Response Validation
    # Create a scenario that might return empty response
    When user sends GET request to "/users/999/posts"
    Then response status should be 200
    And response JSON path "$" should be of type "array"
    And response JSON path "$" array should have length 0

  @api @validation @null @values
  Scenario: Null Value Validation
    When user sends GET request to "/users/1"
    Then response status should be 200
    And response JSON path "$.id" should exist
    And response JSON path "$.name" should not be null
    And response JSON path "$.email" should not be null

  @api @validation @regex @patterns
  Scenario: Advanced Regex Pattern Validation
    When user sends GET request to "/users"
    Then response status should be 200

    # Validate email format for all users
    And response body should match regex "\"email\":\s*\"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\""

    # Validate phone number patterns
    And response body should match regex "\"phone\":\s*\"[0-9\-\.\s\x\(\)]+"

  @api @validation @checksum @hash
  Scenario: Data Checksum and Hash Validation
    When user sends GET request to "/users/1" and saves response as "user-data"
    Then response status should be 200

    # Calculate MD5 hash of response body
    When user calculates MD5 hash of response body and saves as "responseHash"
    Then variable "responseHash" should exist

    # Verify response integrity by checking hash
    When user calculates SHA256 hash of "{{userName}}" and saves as "userNameHash"
    Then variable "userNameHash" should exist