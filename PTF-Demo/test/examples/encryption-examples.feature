Feature: Automatic Encryption and Variable Resolution Examples
  As a test automation engineer
  I want to see practical examples of automatic value resolution
  So that I can understand how to use encrypted values and variables

  # ================================================================
  # EXAMPLE 1: Basic Password Encryption
  # ================================================================
  @example @encryption @basic
  Scenario: Login with encrypted password
    # The password below is encrypted but will be automatically decrypted
    # Original value: "MySecretPass123!"
    Given user navigates to login page
    When user enters username "testuser@example.com"
    And user enters password "ENCRYPTED:U2FsdGVkX1+5K3M9Lz8Nw6J4VZ2H8Qm7xY9Rt5Ua2Bc="
    And user clicks login button
    Then user should be logged in successfully

  # ================================================================
  # EXAMPLE 2: API Authentication with Encrypted Tokens
  # ================================================================
  @example @encryption @api @bearer
  Scenario: API call with encrypted bearer token
    Given user is working with API context "production"
    # Token is encrypted and automatically decrypted before use
    # Original value: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
    And user sets bearer token "ENCRYPTED:U2FsdGVkX1+7L4N6Ma9Px8K5WY3J9Rn8yZ0St6Vb3Cd="
    When user sends GET request to "/api/v1/users/profile"
    Then response status should be 200
    And response should contain user profile data

  # ================================================================
  # EXAMPLE 3: Certificate Authentication with Encrypted Password
  # ================================================================
  @example @encryption @certificate
  Scenario: mTLS authentication with encrypted certificate password
    Given user is working with API context "secure-api"
    # Certificate password is encrypted and automatically decrypted
    # Original password: "CertPass#2024"
    And user loads certificate from "certificates/client.pfx" with password "ENCRYPTED:U2FsdGVkX1+9M5P7Ob0Ry9L6XZ4K0So9aB1Tu7Wc4De="
    When user sends GET request to "/secure/data"
    Then response status should be 200

  # ================================================================
  # EXAMPLE 4: Database Connection with Encrypted Credentials
  # ================================================================
  @example @encryption @database
  Scenario: Connect to database with encrypted password
    Given user connects to database with configuration:
      | property | value                                                      |
      | host     | db.example.com                                           |
      | port     | 5432                                                      |
      | database | testdb                                                    |
      | username | db_admin                                                  |
      | password | ENCRYPTED:U2FsdGVkX1+0N6Q8Pc1Sz0M7YA5L1Tp0bC2Uv8Xd5Ef= |
    When user executes query "SELECT COUNT(*) FROM users"
    Then query should return results

  # ================================================================
  # EXAMPLE 5: Variable Substitution - Clear Distinction
  # ================================================================
  @example @variables @config @env
  Scenario: Using different variable sources with clear distinction
    # Test context variables
    Given user saves "john.doe" as "username"
    And user saves "ENCRYPTED:U2FsdGVkX1+2O7R9Qd2Ta1N8ZB6M2Uq1cD3Vw9Ye6Fg=" as "apiKey"

    # Use test variables (from context)
    When user logs in as "{{username}}"
    And user sets API key to "{{apiKey}}"  # Auto-decrypted

    # Use configuration values (from .env file)
    # Assume .env has: BASE_URL=https://api.example.com
    And user sets base URL to "{{config:BASE_URL}}"
    And user sets timeout to "{{config:TIMEOUT}}"

    # Use environment variables (from OS)
    And user sets proxy to "{{env:HTTP_PROXY}}"
    And user sets home to "{{env:HOME}}"

    # No conflicts - same name, different sources
    Given user saves "my-custom-token" as "API_TOKEN"
    When user uses test token "{{API_TOKEN}}"           # -> "my-custom-token" (test var)
    And user uses config token "{{config:API_TOKEN}}"   # -> from .env file
    And user uses env token "{{env:API_TOKEN}}"        # -> from OS environment

  # ================================================================
  # EXAMPLE 6: Loading Encrypted Test Data from CSV
  # ================================================================
  @example @encryption @testdata @csv
  Scenario: Load and use encrypted test data from CSV
    # Assume we have test-users.csv with encrypted passwords:
    # username,password,apiToken
    # john.doe,ENCRYPTED:U2FsdGVkX1+...,ENCRYPTED:U2FsdGVkX1+...
    # jane.smith,ENCRYPTED:U2FsdGVkX1+...,ENCRYPTED:U2FsdGVkX1+...

    Given user loads test data from "test-data/encrypted-users.csv"
    When user logs in with test data row 1
    # The password from CSV is automatically decrypted
    Then login should be successful

    When user uses API token from test data row 1
    # The API token from CSV is automatically decrypted
    Then API call should be authenticated

  # ================================================================
  # EXAMPLE 7: Environment-Specific Encrypted Configuration
  # ================================================================
  @example @encryption @environment
  Scenario: Use environment-specific encrypted values
    # In .env.staging:
    # API_KEY=ENCRYPTED:U2FsdGVkX1+4Q9T1Sf4Vc3P0bD8O4Ws3eF5Xy1Ag8Hi=
    # DB_PASSWORD=ENCRYPTED:U2FsdGVkX1+5R0U2Tg5Wd4Q1cE9P5Xt4fG6Yz2Bh9Ij=

    Given user loads environment "staging"
    When user uses API key from config "API_KEY"
    # Automatically decrypted from environment config
    And user uses database password from config "DB_PASSWORD"
    # Automatically decrypted from environment config
    Then both services should be accessible

  # ================================================================
  # EXAMPLE 8: Mixed Encrypted and Plain Values
  # ================================================================
  @example @encryption @mixed
  Scenario: Handle mixed encrypted and plain values
    Given user has the following configuration:
      | key          | value                                                      |
      | username     | testuser                                                   |
      | password     | ENCRYPTED:U2FsdGVkX1+6S1V3Uh6Xe5R2dF0Q6Yu5gH7Za3Ck0Jk= |
      | apiUrl       | https://api.example.com                                   |
      | apiKey       | ENCRYPTED:U2FsdGVkX1+7T2W4Vi7Yf6S3eG1R7Zv6hI8Ab4Dl1Kl= |
      | timeout      | 30000                                                      |
    # Plain values remain as-is, encrypted values are decrypted
    When user configures the system
    Then all values should be properly resolved

  # ================================================================
  # EXAMPLE 9: Nested Variable Resolution with Encryption
  # ================================================================
  @example @encryption @nested @advanced
  Scenario: Complex nested variable and encryption resolution
    # Save an encrypted value
    Given user saves "ENCRYPTED:U2FsdGVkX1+8U3X5Wj8Zg7T4fH2S8Aw7iJ9Bc5Em2Lm=" as "secret"
    # Save a reference to the variable
    And user saves "secret" as "secretRef"
    # Save another reference
    And user saves "secretRef" as "secretRefRef"

    # Multiple resolution levels - still works!
    When user uses password "$$$secretRefRef"
    # Resolves: secretRefRef -> secretRef -> secret -> decrypted value
    Then password should be fully resolved and decrypted

  # ================================================================
  # EXAMPLE 10: Parallel Execution with Encrypted Values
  # ================================================================
  @example @encryption @parallel
  Scenario Outline: Parallel API tests with encrypted tokens
    Given user is working with API context "<context>"
    And user sets bearer token "<token>"
    When user sends GET request to "<endpoint>"
    Then response status should be <status>

    Examples:
      | context | token                                                           | endpoint        | status |
      | api1    | ENCRYPTED:U2FsdGVkX1+9V4Y6Xk9ah8U5gI3T9Bx8jK0Cd6Fn3Mn=      | /api/v1/health | 200    |
      | api2    | ENCRYPTED:U2FsdGVkX1+0W5Z7Yl0bi9V6hJ4U0Cy9kL1De7Go4No=      | /api/v2/status | 200    |
      | api3    | ENCRYPTED:U2FsdGVkX1+1X6A8Zm1cj0W7iK5V1Dz0lM2Ef8Hp5Op=      | /api/v3/info   | 200    |

  # ================================================================
  # EXAMPLE 11: Data Table with Encrypted Values
  # ================================================================
  @example @encryption @datatable
  Scenario: Process data table with encrypted values
    Given user has the following accounts:
      | accountType | username   | password                                                      | apiKey                                                        |
      | Admin       | admin      | ENCRYPTED:U2FsdGVkX1+2Y7B9An2dk1X8jL6W2Ea1mN3Fg9Iq6Pq=     | ENCRYPTED:U2FsdGVkX1+3Z8C0Bo3el2Y9kM7X3Fb2nO4Gh0Jr7Qr=     |
      | User        | user1      | ENCRYPTED:U2FsdGVkX1+4A9D1Cp4fm3Z0lN8Y4Gc3oP5Hi1Ks8Rs=     | ENCRYPTED:U2FsdGVkX1+5B0E2Dq5gn4A1mO9Z5Hd4pQ6Ij2Lt9St=     |
      | Guest       | guest      | plaintext_password                                           | plaintext_key                                                |
    # All encrypted values in the table are automatically decrypted
    When user processes all accounts
    Then all accounts should be accessible

  # ================================================================
  # EXAMPLE 12: Dynamic Value Generation with Encryption
  # ================================================================
  @example @encryption @dynamic
  Scenario: Combine dynamic values with encryption
    # Generate a UUID
    Given user generates UUID and saves as "sessionId"
    # Use encrypted token
    And user saves "ENCRYPTED:U2FsdGVkX1+6C1F3Er6ho5B2nP0A6Ie5qR7Jk3Mu0Tu=" as "authToken"

    # Combine both in a request
    When user sends request with headers:
      | X-Session-ID | {{sessionId}} |
      | Authorization | Bearer {{authToken}} |
    Then request should include both dynamic and decrypted values

  # ================================================================
  # EXAMPLE 13: Encryption with Special Characters
  # ================================================================
  @example @encryption @special
  Scenario: Handle encrypted values with special characters
    # Original password: "P@$$w0rd!#2024<>{}[]"
    Given user sets password to "ENCRYPTED:U2FsdGVkX1+7D2G4Fs7ip6C3oQ1B7Jf6rS8Kl4Nv1Uv="
    # Special characters are preserved after decryption
    When user logs in
    Then login should handle special characters correctly

  # ================================================================
  # EXAMPLE 14: Bulk Data Operations with Encryption
  # ================================================================
  @example @encryption @bulk
  Scenario: Process bulk encrypted data
    Given user loads JSON test data:
      """
      {
        "users": [
          {
            "id": 1,
            "username": "user1",
            "password": "ENCRYPTED:U2FsdGVkX1+8E3H5Gt8jq7D4pR2C8Kg7sT9Lm5Ow2Vw=",
            "token": "ENCRYPTED:U2FsdGVkX1+9F4I6Hu9kr8E5qS3D9Lh8tU0Mn6Px3Wx="
          },
          {
            "id": 2,
            "username": "user2",
            "password": "ENCRYPTED:U2FsdGVkX1+0G5J7Iv0ls9F6rT4E0Mi9uV1No7Qy4Xy=",
            "token": "ENCRYPTED:U2FsdGVkX1+1H6K8Jw1mt0G7sU5F1Nj0vW2Op8Rz5Yz="
          }
        ]
      }
      """
    # All encrypted fields are automatically decrypted
    When user processes all users
    Then all user credentials should be valid

  # ================================================================
  # EXAMPLE 15: Conditional Encryption Based on Environment
  # ================================================================
  @example @encryption @conditional
  Scenario: Use encryption conditionally based on environment
    Given user checks current environment
    When environment is "production"
    Then user uses encrypted password "ENCRYPTED:U2FsdGVkX1+2I7L9Kx2nu1H8tV6G2Ok1wX3Pq9Sa6Az="
    When environment is "development"
    Then user uses plain password "devPassword123"
    # Framework handles both encrypted and plain values transparently