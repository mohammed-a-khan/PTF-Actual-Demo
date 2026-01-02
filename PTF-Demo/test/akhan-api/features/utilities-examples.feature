Feature: API Testing Utilities and Data Manipulation Examples
  As a QA engineer
  I want to use utility functions and data manipulation
  So that I can create dynamic and flexible test scenarios

  Background:
    Given user is working with API context "utilities-test"
    And user sets base URL to "https://jsonplaceholder.typicode.com"

  @api @utilities @variables @basic
  Scenario: Basic Variable Management
    # Save static values
    Given user saves "12345" as "testId"
    And user saves "john.doe@example.com" as "testEmail"
    And user saves "John Doe" as "testName"

    # Use variables in request
    Given user sets request body to:
      """
      {
        "id": "{{testId}}",
        "name": "{{testName}}",
        "email": "{{testEmail}}"
      }
      """
    When user sends POST request to "/users"
    Then response status should be 201
    And response JSON path "$.name" should equal "John Doe"

    # Print variables for debugging
    Then user prints variable "testId"
    And user prints variable "testEmail"

  @api @utilities @data-generation
  Scenario: Dynamic Data Generation
    # Generate UUID
    Given user generates UUID and saves as "correlationId"
    And user generates UUID and saves as "requestId"

    # Generate timestamp
    Given user generates timestamp and saves as "requestTime"

    # Generate random data
    Given user generates random number between 1000 and 9999 and saves as "randomId"
    And user generates random string of length 10 and saves as "randomCode"

    # Use generated data in request
    Given user sets request header "X-Correlation-ID" to "{{correlationId}}"
    And user sets request header "X-Request-ID" to "{{requestId}}"
    And user sets request body to:
      """
      {
        "code": "{{randomCode}}",
        "timestamp": {{requestTime}},
        "id": {{randomId}}
      }
      """

    When user sends POST request to "/posts"
    Then response status should be 201

    # Verify generated data was used
    And response JSON path "$.code" should exist
    And response JSON path "$.timestamp" should exist

  @api @utilities @response-extraction
  Scenario: Response Data Extraction
    # Get user data
    When user sends GET request to "/users/1" and saves response as "user-response"
    Then response status should be 200

    # Extract various fields from response
    And user saves response JSON path "$.id" as "userId"
    And user saves response JSON path "$.name" as "userName"
    And user saves response JSON path "$.email" as "userEmail"
    And user saves response JSON path "$.company.name" as "companyName"
    And user saves response header "Content-Type" as "contentType"

    # Use extracted data in subsequent request
    Given user sets query parameter "userId" to "{{userId}}"
    And user sets query parameter "userName" to "{{userName}}"
    When user sends GET request to "/posts"
    Then response status should be 200

    # Print extracted values
    Then user prints variable "userId"
    And user prints variable "userName"
    And user prints variable "companyName"

  @api @utilities @string-manipulation
  Scenario: String Manipulation and Transformation
    Given user saves "john doe" as "originalName"

    # Transform strings
    When user transforms "{{originalName}}" to uppercase and saves as "upperName"
    And user transforms "{{originalName}}" to lowercase and saves as "lowerName"

    # Use transformed strings
    Given user sets request body to:
      """
      {
        "originalName": "{{originalName}}",
        "upperName": "{{upperName}}",
        "lowerName": "{{lowerName}}"
      }
      """
    When user sends POST request to "/posts"
    Then response status should be 201

    # Verify transformations
    And response JSON path "$.upperName" should equal "JOHN DOE"
    And response JSON path "$.lowerName" should equal "john doe"

  @api @utilities @encoding-decoding
  Scenario: Encoding and Decoding Operations
    Given user saves "username:password" as "credentials"
    And user saves "Hello World!" as "message"

    # Base64 encoding
    When user base64 encodes "{{credentials}}" and saves as "encodedCredentials"
    And user base64 encodes "{{message}}" and saves as "encodedMessage"

    # Use encoded data in request
    Given user sets request header "Authorization" to "Basic {{encodedCredentials}}"
    And user sets request body to:
      """
      {
        "message": "{{encodedMessage}}",
        "encoding": "base64"
      }
      """
    When user sends POST request to "/posts"
    Then response status should be 201

    # Decode data for verification
    When user base64 decodes "{{encodedCredentials}}" and saves as "decodedCredentials"
    And user base64 decodes "{{encodedMessage}}" and saves as "decodedMessage"
    Then user prints variable "decodedCredentials"
    And user prints variable "decodedMessage"

  @api @utilities @url-encoding
  Scenario: URL Encoding Operations
    Given user saves "hello world & special chars!" as "originalText"
    And user saves "user@example.com" as "emailAddress"

    # URL encoding
    When user URL encodes "{{originalText}}" and saves as "urlEncodedText"
    And user URL encodes "{{emailAddress}}" and saves as "urlEncodedEmail"

    # Use URL encoded data in query parameters
    Given user sets query parameter "text" to "{{urlEncodedText}}"
    And user sets query parameter "email" to "{{urlEncodedEmail}}"
    When user sends GET request to "/posts"
    Then response status should be 200

    # URL decoding for verification
    When user URL decodes "{{urlEncodedText}}" and saves as "decodedText"
    And user URL decodes "{{urlEncodedEmail}}" and saves as "decodedEmail"
    Then variable "decodedText" should equal "hello world & special chars!"
    And variable "decodedEmail" should equal "user@example.com"

  @api @utilities @hashing
  Scenario: Hashing and Checksum Operations
    Given user saves "sensitive-data-123" as "secretData"
    And user saves "user-password" as "userPassword"

    # Generate hashes
    When user calculates MD5 hash of "{{secretData}}" and saves as "md5Hash"
    And user calculates SHA256 hash of "{{userPassword}}" and saves as "sha256Hash"

    # Use hashes in request
    Given user sets request header "X-Data-Hash" to "{{md5Hash}}"
    And user sets request body to:
      """
      {
        "passwordHash": "{{sha256Hash}}",
        "algorithm": "SHA256"
      }
      """
    When user sends POST request to "/posts"
    Then response status should be 201

    # Verify hash generation
    Then user prints variable "md5Hash"
    And user prints variable "sha256Hash"

  @api @utilities @string-operations
  Scenario: String Concatenation and Comparison
    Given user saves "Hello" as "greeting"
    And user saves "World" as "target"
    And user saves "API" as "service"

    # Concatenate strings
    When user concatenates "{{greeting}}" and " {{target}}!" and saves as "fullGreeting"
    And user concatenates "{{service}}" and " Testing" and saves as "testType"

    # Compare strings
    When user compares "{{greeting}}" with "Hello" and saves result as "greetingMatch"
    And user compares "{{service}}" with "WEB" and saves result as "serviceMatch"

    # Use concatenated and compared data
    Given user sets request body to:
      """
      {
        "message": "{{fullGreeting}}",
        "type": "{{testType}}",
        "greetingIsCorrect": {{greetingMatch}},
        "isWebService": {{serviceMatch}}
      }
      """
    When user sends POST request to "/posts"
    Then response status should be 201

    # Verify results
    And response JSON path "$.message" should equal "Hello World!"
    And response JSON path "$.greetingIsCorrect" should equal true
    And response JSON path "$.isWebService" should equal false

  @api @utilities @timing-delays
  Scenario: Timing and Delay Operations
    # Record start time
    Given user generates timestamp and saves as "startTime"

    # Add delay
    When user waits for 2 seconds

    # Record end time and calculate duration
    Given user generates timestamp and saves as "endTime"

    # Use timing data in request
    Given user sets request body to:
      """
      {
        "startTime": {{startTime}},
        "endTime": {{endTime}},
        "testDuration": "2 seconds"
      }
      """
    When user sends POST request to "/posts"
    Then response status should be 201

  @api @utilities @file-operations
  Scenario: File Operations for Test Data
    # Save response data to file for analysis
    When user sends GET request to "/users/1" and saves response as "user-data"
    Then response status should be 200
    And user saves response to file "user-1-data.json"

    # Load variables from file (if file exists)
    # Given user loads variables from file "test-variables.json"

    # Export context for debugging
    When user exports context to file "debug-context.json"

    # Save current variables to file
    And user saves variables to file "current-variables.json"

  @api @utilities @context-management
  Scenario: Context and Variable Management
    # Set up test data
    Given user saves "test-session-123" as "sessionId"
    And user saves "admin@example.com" as "adminEmail"

    # Print all current variables
    Then user prints variable "sessionId"
    And user prints variable "adminEmail"

    # Clear specific variable
    When user clears variable "sessionId"

    # Verify variable is cleared
    Then variable "sessionId" should not exist

    # Clear all variables
    When user clears all variables
    And user generates UUID and saves as "newSessionId"

  @api @utilities @debugging @logging
  Scenario: Debugging and Logging Utilities
    # Make request and capture response for debugging
    When user sends GET request to "/users/1" and saves response as "debug-response"
    Then response status should be 200

    # Print response details for debugging
    Then user prints response body
    And user prints response headers

    # Print specific JSON paths
    Then user prints JSON path "$.name" from response
    And user prints JSON path "$.email" from response

    # Save response for later analysis
    When user saves response to file "debug-user-response.json"

  @api @utilities @conditional-logic
  Scenario: Conditional Logic and Flow Control
    # Get user data
    When user sends GET request to "/users/1" and saves response as "user-info"
    Then response status should be 200
    And user saves response JSON path "$.id" as "userId"

    # Conditional execution based on user ID
    When user executes conditional request if "userId" equals "1"
    And user sends GET request to "/users/1/posts"
    Then response status should be 200

    # Another conditional based on different criteria
    Given user saves "admin" as "userRole"
    When user executes conditional request if "userRole" equals "admin"
    And user sends GET request to "/users"
    Then response status should be 200

  @api @utilities @data-validation-helpers
  Scenario: Data Validation Helper Functions
    When user sends GET request to "/users/1" and saves response as "user-data"
    Then response status should be 200

    # Validate email format using helper
    When user saves response JSON path "$.email" as "userEmail"
    And user validates email format of "{{userEmail}}" and saves result as "emailValid"
    Then variable "emailValid" should equal true

    # Validate phone number format
    When user saves response JSON path "$.phone" as "userPhone"
    And user validates phone format of "{{userPhone}}" and saves result as "phoneValid"
    Then variable "phoneValid" should equal true

  @api @utilities @performance-helpers
  Scenario: Performance Measurement Utilities
    # Measure single request performance
    When user executes request and measures performance
    And user sends GET request to "/users"
    Then response status should be 200
    And response time should be less than 3000 ms
    And user prints variable "lastRequestDuration"

    # Measure multiple requests
    When user executes request and measures performance
    And user sends GET request to "/posts"
    Then response status should be 200

    When user executes request and measures performance
    And user sends GET request to "/comments"
    Then response status should be 200

  @api @utilities @cleanup
  Scenario: Test Cleanup and Resource Management
    # Create test data
    Given user generates UUID and saves as "testResourceId"
    And user sets request body to:
      """
      {
        "id": "{{testResourceId}}",
        "name": "Test Resource",
        "temporary": true
      }
      """
    When user sends POST request to "/posts" and saves response as "created-resource"
    Then response status should be 201

    # Use the resource
    When user sends GET request to "/posts/{{testResourceId}}"
    # This would normally work with a real API

    # Cleanup - clear variables and context
    When user clears all variables
    And user exports context to file "final-test-context.json"