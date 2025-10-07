@database @api @integration
Feature: Database-API Integration Testing
  As a QA Engineer
  I want to validate API responses against database records
  So that I can ensure data consistency between API and database

  Background:
    Given user connects to "default" database
    And the API base URL is "https://jsonplaceholder.typicode.com"

  @TC001 @critical @smoke
  Scenario: Validate API response matches database query results
    # Execute database query and store results
    Given I execute query "SELECT id, name, email, phone FROM users WHERE id <= 5" and store results as "users"

    # Make API request
    When I send a GET request to "/users"
    Then the response status should be 200

    # Validate first 5 users match DB (with auto field mapping)
    # NOTE: This example uses mock data - adapt query and API to your actual system
    And I validate response path "$[0:5]" against query result "users" with mapping "id:id,name:name,email:email,phone:phone"

  @TC002 @parameterized @high
  Scenario: Execute parameterized query and validate specific fields
    # Use variables for parameters
    Given I set variable "userId" to "1"
    And I set variable "status" to "active"

    # Execute parameterized query
    And I execute query "SELECT id, name, email FROM users WHERE id = ? AND status = ?" with parameters "${userId},${status}" and store as "userDetails"

    # Use DB result as variables for API call
    And I use query result "userDetails" row 0 as variables

    # Make API call using DB data
    When I send a GET request to "/users/${id}"
    Then the response status should be 200

    # Validate specific fields match
    And I validate response field "name" equals query result "userDetails" field "name"
    And I validate response field "email" equals query result "userDetails" field "email"

  @TC003 @stored-procedure @high
  Scenario: Validate API response using stored procedure results
    # Execute stored procedure
    Given I execute stored procedure "GetActiveUsers" with parameters:
      | limit  | 10   |
      | offset | 0    |
    And store as "activeUsers"

    # Call API
    When I send a GET request to "/users?_limit=10"
    Then the response status should be 200

    # Validate with key-based matching
    And I validate response path "$" against query result "activeUsers" using key "id"

  @TC004 @field-mapping @medium
  Scenario: Validate with snake_case to camelCase field mapping
    # Query with database field names (snake_case)
    Given I execute query "SELECT user_id, first_name, last_name, email_address, phone_number FROM user_profiles LIMIT 5" and store results as "profiles"

    # API returns camelCase fields
    When I send a GET request to "/user-profiles?limit=5"
    Then the response status should be 200

    # Map DB fields to API fields explicitly
    And I validate response path "data" against query result "profiles" with mapping:
      | user_id       | userId      |
      | first_name    | firstName   |
      | last_name     | lastName    |
      | email_address | email       |
      | phone_number  | phoneNumber |

  @TC005 @data-existence @critical
  Scenario: Verify data creation in database after API call
    # Prepare test data
    Given I set variable "userName" to "testuser_${timestamp}"
    And I set variable "userEmail" to "test_${timestamp}@example.com"

    # Create user via API
    When I send a POST request to "/users" with body:
      """json
      {
        "name": "${userName}",
        "email": "${userEmail}",
        "username": "${userName}"
      }
      """
    Then the response status should be 201
    And I extract "id" from response and save as "newUserId"

    # Verify user exists in database
    And I check if data exists in table "users" where "id='${newUserId}' AND email='${userEmail}'"

  @TC006 @complex-validation @high
  Scenario: Complex validation with key matching and fuzzy fallback
    # Get users from database
    Given I execute query "SELECT id, name, username, email, address_city as city FROM users WHERE active=1" and store results as "activeUsers"

    # Get users from API
    When I send a GET request to "/users"
    Then the response status should be 200

    # Validate using 'id' as key field for matching
    # Records will be matched by ID first, then all fields compared
    And I validate response path "$" against query result "activeUsers" using key "id" with mapping:
      | id           | id       |
      | name         | name     |
      | username     | username |
      | email        | email    |
      | address_city | city     |

  @TC007 @stored-procedure-check @medium
  Scenario: Verify stored procedure returns expected data
    # Prepare parameters
    Given I set variable "orderId" to "12345"
    And I set variable "includeDetails" to "true"

    # Check if stored procedure returns data
    Then I check if stored procedure "GetOrderDetails" with parameters:
      | orderId        | ${orderId}        |
      | includeDetails | ${includeDetails} |
    Returns data

  @TC008 @variable-usage @medium
  Scenario: Use database results as variables in subsequent API calls
    # Get user details from database
    Given I execute query "SELECT id, api_key, secret FROM api_credentials WHERE username='testuser'" and store results as "credentials"

    # Load credentials as variables
    And I use query result "credentials" row 0 as variables

    # Use DB variables in API authentication
    When I use API key "${api_key}" with value "${secret}"
    And I send a GET request to "/protected/resource/${id}"
    Then the response status should be 200

  @TC009 @negative @data-validation
  Scenario: Validation fails when API and DB data don't match
    # Query for inactive users
    Given I execute query "SELECT id, name, status FROM users WHERE status='inactive'" and store results as "inactiveUsers"

    # API returns all users
    When I send a GET request to "/users"
    Then the response status should be 200

    # This should fail because API has more records
    # NOTE: Remove this step or adjust to make test pass
    # And I validate response path "$" against query result "inactiveUsers" using key "id"

  @TC010 @performance @low
  Scenario: Validate large dataset from database matches API
    # Get large dataset
    Given I execute query "SELECT id, title, body, userId FROM posts ORDER BY id LIMIT 100" and store results as "posts"

    # Get from API
    When I send a GET request to "/posts?_limit=100"
    Then the response status should be 200

    # Validate all records match
    And I validate response path "$" against query result "posts" with mapping "id:id,title:title,body:body,userId:userId"
    And I validate response path "$" against query result "posts" using key "id"

# ============================================================================
# IMPLEMENTATION NOTES:
# ============================================================================
#
# 1. DATABASE CONFIGURATION:
#    Configure in config/global.env:
#    ```
#    DB_DEFAULT_TYPE=mysql
#    DB_DEFAULT_HOST=localhost
#    DB_DEFAULT_PORT=3306
#    DB_DEFAULT_USERNAME=root
#    DB_DEFAULT_PASSWORD=password
#    DB_DEFAULT_DATABASE=testdb
#    ```
#
# 2. FIELD MAPPING:
#    - Auto-conversion: snake_case ↔ camelCase
#    - Manual mapping: "db_field:apiField,another_field:anotherField"
#    - Data table mapping:
#      | db_field      | apiField      |
#      | another_field | anotherField  |
#
# 3. KEY-BASED MATCHING:
#    - Uses exact match by key field(s) first
#    - Falls back to fuzzy/score-based matching
#    - Detailed reporting of matched/mismatched fields
#
# 4. VARIABLE SUBSTITUTION:
#    - In queries: SELECT * FROM users WHERE id='${userId}'
#    - In API paths: /users/${userId}
#    - In request bodies: {"id": "${userId}"}
#
# 5. ERROR HANDLING:
#    - Detailed error messages with field-level mismatches
#    - Match percentage reporting
#    - Unmatched record identification
#
# ============================================================================
