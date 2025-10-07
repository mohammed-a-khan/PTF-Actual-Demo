Feature: Data Sharing Examples - Complete Guide
  As a test automation engineer
  I want to understand how to share data between steps and scenarios
  So that I can write efficient and maintainable tests

  # ================================================================
  # BASIC DATA SHARING WITHIN A SCENARIO
  # ================================================================

  @example @data-sharing @basic
  Scenario: Basic data sharing within a scenario
    # Save simple values
    Given user saves "john.doe" as "username"
    And user saves "test@example.com" as "email"
    And user saves "ENCRYPTED:U2FsdGVkX1+pass123..." as "password"

    # Use saved values - framework auto-resolves {{variableName}}
    When user navigates to login page
    And user enters "{{username}}" in username field
    And user enters "{{email}}" in email field
    And user enters "{{password}}" in password field  # Auto-decrypted!
    Then login should be successful

  # ================================================================
  # UI TESTING - CAPTURING AND REUSING VALUES
  # ================================================================

  @example @ui @capture
  Scenario: Capture values from UI and reuse them
    Given user navigates to order page

    # Capture values from the page
    When user captures text from "#order-number" and saves as "orderId"
    And user captures value from "#customer-name-input" and saves as "customerName"
    And user captures "href" attribute from "#invoice-link" and saves as "invoiceUrl"
    And user captures current URL and saves as "orderPageUrl"

    # Use captured values in subsequent steps
    Then user navigates to search page
    And user searches for order "{{orderId}}"
    And user verifies customer name is "{{customerName}}"

    # Navigate to captured URL
    When user navigates to "{{invoiceUrl}}"
    Then invoice should be displayed

  # ================================================================
  # DATABASE TESTING - USING QUERY RESULTS
  # ================================================================

  @example @database @query
  Scenario: Use database query results in subsequent steps
    # Execute a query and capture results
    Given user connects to database
    When user executes query "SELECT user_id, username, email FROM users WHERE status = 'active' LIMIT 1"
    And user saves query result as "activeUser"
    And user saves column "user_id" from result as "userId"

    # Use the captured database values in UI testing
    When user navigates to admin panel
    And user searches for user ID "{{userId}}"
    Then user details should match database record "{{activeUser}}"

    # Use in another database query
    When user executes query "SELECT * FROM orders WHERE user_id = {{userId}}"
    Then orders should be displayed

  # ================================================================
  # COMPLEX DATA TYPES - MAPS, LISTS, JSON
  # ================================================================

  @example @complex @datatypes
  Scenario: Working with complex data types - Two Column Tables
    # Save a Map/Dictionary (2-column table -> Map)
    Given user saves the following data as "userProfile":
      | firstName   | John              |
      | lastName    | Doe               |
      | age         | 30                |
      | department  | Engineering       |
      | role        | Senior Developer  |

    # This creates a Map that can be accessed with .get()
    # In step definitions: userProfile.get('firstName') returns 'John'

    # Save a List/Array
    And user saves the following list as "productIds":
      | PROD-001 |
      | PROD-002 |
      | PROD-003 |
      | PROD-004 |

    # Save JSON object
    And user saves the following JSON as "apiConfig":
      """
      {
        "baseUrl": "https://api.example.com",
        "timeout": 30000,
        "retries": 3,
        "headers": {
          "Content-Type": "application/json",
          "X-API-Version": "v2"
        }
      }
      """

    # These complex objects are available for use
    When user processes user profile "{{userProfile}}"
    And user validates products "{{productIds}}"
    And user configures API with "{{apiConfig}}"

  # ================================================================
  # MULTI-COLUMN TABLES - AUTO-DETECTED AS ARRAY OF OBJECTS
  # ================================================================

  @example @complex @multi-column
  Scenario: Working with multi-column tables
    # Multi-column table (>2 columns) - automatically saved as array of objects
    Given user saves the following data as "products":
      | productId | productName      | price  | quantity | category     | inStock |
      | PROD-001  | Laptop Pro       | 1299   | 5        | Electronics  | true    |
      | PROD-002  | Wireless Mouse   | 29.99  | 25       | Accessories  | true    |
      | PROD-003  | USB-C Cable      | 15.99  | 100      | Accessories  | true    |
      | PROD-004  | Monitor 4K       | 599    | 3        | Electronics  | false   |
      | PROD-005  | Keyboard Mech    | 149    | 12       | Accessories  | true    |

    # This creates an array of objects:
    # [
    #   { productId: 'PROD-001', productName: 'Laptop Pro', price: '1299', ... },
    #   { productId: 'PROD-002', productName: 'Wireless Mouse', price: '29.99', ... },
    #   ...
    # ]

    # Use explicit table method for clarity
    And user saves the following table as "orders":
      | orderId  | customerName  | orderDate  | amount   | status    | paymentMethod |
      | ORD-1001 | John Smith    | 2024-01-15 | 1299.00  | pending   | credit_card   |
      | ORD-1002 | Jane Doe      | 2024-01-16 | 45.98    | completed | paypal        |
      | ORD-1003 | Bob Johnson   | 2024-01-17 | 614.99   | shipped   | debit_card    |

    # Save a single record as object
    And user saves the following record as "currentCustomer":
      | customerId | firstName | lastName | email              | phone        | memberSince |
      | CUST-789   | Alice     | Williams | alice@example.com  | 555-0123     | 2023-06-15  |

    # These can be used in subsequent steps
    When user processes products "{{products}}"
    And user validates orders "{{orders}}"
    And user sends notification to "{{currentCustomer}}"

  # ================================================================
  # SHARING DATA BETWEEN SCENARIOS (SAME FEATURE)
  # ================================================================

  @example @feature-context
  Scenario: First scenario - Save to feature context
    # Save to feature context (available across scenarios)
    Given user saves "AUTH-TOKEN-123456" as "authToken" in feature context
    And user saves "SESSION-ABC-789" as "sessionId" in feature context
    And user saves "john.doe@example.com" as "testEmail" in feature context

    When user performs authentication
    Then authentication should succeed

  @example @feature-context
  Scenario: Second scenario - Use data from first scenario
    # These values were saved in feature context by previous scenario
    Given user sets authorization header to "{{authToken}}"
    And user sets session ID to "{{sessionId}}"
    When user sends request to "/api/user/{{testEmail}}"
    Then response should be successful

  # ================================================================
  # GLOBAL DATA SHARING (ACROSS FEATURES)
  # ================================================================

  @example @global
  Scenario: Save data globally for use in other features
    # Generate and save globally
    Given user generates UUID and saves as "globalSessionId"
    And user saves "{{globalSessionId}}" as "sharedSession" globally

    # Save test configuration globally
    And user saves the following JSON as "globalConfig" globally:
      """
      {
        "environment": "staging",
        "testRun": "regression",
        "timestamp": "2024-01-01T10:00:00Z"
      }
      """

    # This data is now available in ANY feature file
    Then global data should be available

  # ================================================================
  # DYNAMIC VALUE GENERATION
  # ================================================================

  @example @dynamic @generation
  Scenario: Generate dynamic values for testing
    # Generate various types of values
    Given user generates UUID and saves as "transactionId"
    And user generates timestamp and saves as "startTime"
    And user generates random number between 1000 and 9999 and saves as "orderId"
    And user generates random string of length 12 and saves as "tempPassword"

    # Use generated values
    When user creates order with ID "{{orderId}}"
    And user sets transaction ID to "{{transactionId}}"
    And user sets temporary password to "{{tempPassword}}"
    Then order should be created at timestamp "{{startTime}}"

  # ================================================================
  # CAPTURING MULTIPLE ELEMENTS
  # ================================================================

  @example @multiple @elements
  Scenario: Capture data from multiple elements
    Given user navigates to product listing page

    # Capture all text from multiple elements
    When user captures all text from ".product-name" and saves as "productNames"
    And user captures all text from ".product-price" and saves as "productPrices"
    And user captures all text from ".product-sku" and saves as "productSkus"

    # The saved arrays can be used for validation
    Then user validates product data:
      | names  | {{productNames}}  |
      | prices | {{productPrices}} |
      | skus   | {{productSkus}}   |

  # ================================================================
  # COMBINING WITH ENCRYPTION
  # ================================================================

  @example @encryption @combined
  Scenario: Combine data sharing with encryption
    # Save encrypted values
    Given user saves "ENCRYPTED:U2FsdGVkX1+apikey..." as "apiKey"
    And user saves "ENCRYPTED:U2FsdGVkX1+dbpass..." as "dbPassword"

    # Save regular values
    And user saves "staging-server.example.com" as "serverHost"
    And user saves "5432" as "dbPort"

    # When used, encrypted values are auto-decrypted
    When user connects to database:
      | host     | {{serverHost}}  |
      | port     | {{dbPort}}      |
      | password | {{dbPassword}}  |  # Auto-decrypted!

    And user sets API key to "{{apiKey}}"  # Auto-decrypted!
    Then connection should be secure

  # ================================================================
  # CONDITIONAL DATA USAGE
  # ================================================================

  @example @conditional
  Scenario: Use data conditionally based on environment
    # Save environment-specific data
    Given user saves "dev-api.example.com" as "devUrl"
    And user saves "prod-api.example.com" as "prodUrl"
    And user saves "{{config:ENVIRONMENT}}" as "currentEnv"

    # Use appropriate URL based on environment
    When current environment is "{{currentEnv}}"
    Then user selects appropriate URL for testing

  # ================================================================
  # DATA TRANSFORMATION
  # ================================================================

  @example @transform
  Scenario: Transform and manipulate saved data
    # Save initial data
    Given user saves "John Doe" as "fullName"
    And user saves "john.doe@example.com" as "email"

    # Capture and transform
    When user captures text from "#price" and saves as "priceText"
    # Assume priceText = "$99.99"

    # In your step definitions, you can transform this data
    # For example, extract numeric value, split names, etc.
    Then user processes transformed data

  # ================================================================
  # ERROR HANDLING AND VALIDATION
  # ================================================================

  @example @validation
  Scenario: Validate saved variables exist
    Given user saves "test-value" as "myVariable"

    # Verify variable exists
    Then user verifies variable "myVariable" exists

    # Clear scenario variables
    When user clears all scenario variables

    # This would fail now as variable was cleared
    # Then user verifies variable "myVariable" exists

  # ================================================================
  # DEBUGGING DATA
  # ================================================================

  @example @debug
  Scenario: Debug and inspect saved data
    # Save various types of data
    Given user saves "test-user" as "username"
    And user saves "test@example.com" as "email"
    And user saves the following data as "config":
      | url     | https://example.com |
      | timeout | 30000               |

    # Print all variables for debugging
    Then user prints all saved variables

  # ================================================================
  # PRACTICAL MULTI-COLUMN TABLE USAGE
  # ================================================================

  @example @practical @multi-column-usage
  Scenario: Using multi-column data in real tests
    # Save test users with multiple attributes
    Given user saves the following data as "testUsers":
      | userId | username  | password                                         | role   | status |
      | USR001 | johndoe   | ENCRYPTED:U2FsdGVkX1+pass1...                  | admin  | active |
      | USR002 | janesmith | ENCRYPTED:U2FsdGVkX1+pass2...                  | editor | active |
      | USR003 | bobwilson | ENCRYPTED:U2FsdGVkX1+pass3...                  | viewer | inactive |

    # In step definitions, you can access this as:
    # const users = this.scenarioContext.get('testUsers');
    # users[0].username === 'johndoe'
    # users[0].password is auto-decrypted!
    # users[0].role === 'admin'

    # Test each user login
    When user tests login for all users in "{{testUsers}}"

    # Or access specific user by index
    When user logs in with first user from "{{testUsers}}"

    # Save product inventory with multiple attributes
    Given user saves the following table as "inventory":
      | sku      | product        | price | stock | warehouse | minStock | maxStock |
      | SKU-A001 | Laptop         | 999   | 50    | NYC       | 10       | 100      |
      | SKU-A002 | Mouse          | 25    | 200   | NYC       | 50       | 500      |
      | SKU-B001 | Keyboard       | 75    | 150   | LAX       | 30       | 300      |
      | SKU-B002 | Monitor        | 399   | 25    | LAX       | 5        | 50       |

    # Check low stock items (in step definition, filter where stock < minStock)
    Then user validates inventory levels for "{{inventory}}"

  # ================================================================
  # REAL-WORLD E2E EXAMPLE
  # ================================================================

  @example @e2e @complete
  Scenario: Complete E2E test with data sharing
    # 1. Generate test data
    Given user generates UUID and saves as "testRunId"
    And user generates random string of length 8 and saves as "username"
    And user saves "test_{{username}}@example.com" as "email"

    # 2. Create user via API
    When user sends POST request to "/api/users" with:
      """
      {
        "username": "{{username}}",
        "email": "{{email}}",
        "testRunId": "{{testRunId}}"
      }
      """
    And user saves response JSON path "$.id" as "userId"

    # 3. Verify in database
    When user executes query "SELECT * FROM users WHERE id = {{userId}}"
    And user saves query result as "dbUser"

    # 4. Login via UI
    When user navigates to login page
    And user enters "{{email}}" in email field
    And user enters "defaultPassword123" in password field
    And user clicks login button

    # 5. Capture session from UI
    And user captures text from "#session-id" and saves as "sessionId"

    # 6. Use session in API calls
    When user sets header "X-Session-ID" to "{{sessionId}}"
    And user sends GET request to "/api/profile"
    Then response should contain user "{{userId}}"

    # 7. Cleanup
    Finally user sends DELETE request to "/api/users/{{userId}}"
    And user verifies deletion in database