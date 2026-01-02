Feature: API Authentication Examples
  As a QA engineer
  I want to test various authentication methods
  So that I can validate secure API access patterns

  @api @auth @basic
  Scenario: Basic Authentication
    Given user is working with API context "basic-auth"
    And user sets base URL to "https://httpbin.org"
    And user sets basic authentication with username "testuser" and password "testpass"
    When user sends GET request to "/basic-auth/testuser/testpass"
    Then response status should be 200
    And response JSON path "$.authenticated" should equal true
    And response JSON path "$.user" should equal "testuser"

  @api @auth @bearer
  Scenario: Bearer Token Authentication
    Given user is working with API context "bearer-auth"
    And user sets base URL to "https://httpbin.org"
    And user sets bearer token "test-bearer-token-12345"
    When user sends GET request to "/bearer"
    Then response status should be 200
    And response JSON path "$.authenticated" should equal true
    And response JSON path "$.token" should equal "test-bearer-token-12345"

  @api @auth @api-key @header
  Scenario: API Key in Header
    Given user is working with API context "api-key-header"
    And user sets base URL to "https://httpbin.org"
    And user sets API key "abc123xyz789" in header "X-API-Key"
    When user sends GET request to "/headers"
    Then response status should be 200
    And response JSON path "$.headers.X-Api-Key" should equal "abc123xyz789"

  @api @auth @api-key @query
  Scenario: API Key in Query Parameter
    Given user is working with API context "api-key-query"
    And user sets base URL to "https://httpbin.org"
    And user sets query parameter "api_key" to "secret-api-key-123"
    When user sends GET request to "/get"
    Then response status should be 200
    And response JSON path "$.args.api_key" should equal "secret-api-key-123"

  @api @auth @oauth2 @client-credentials
  Scenario: OAuth2 Client Credentials Flow
    Given user is working with API context "oauth2-client-creds"
    And user configures OAuth2 with client ID "test-client-id" and secret "test-client-secret"

    # Simulate token request
    Given user sets base URL to "https://httpbin.org"
    And user sets request body to:
      """
      {
        "grant_type": "client_credentials",
        "client_id": "test-client-id",
        "client_secret": "test-client-secret",
        "scope": "read write"
      }
      """
    When user sends POST request to "/post" and saves response as "token-request"
    Then response status should be 200
    And response JSON path "$.json.grant_type" should equal "client_credentials"

    # Simulate using the obtained token
    Given user saves "mock-oauth2-access-token" as "accessToken"
    And user sets bearer token "{{accessToken}}"
    When user sends GET request to "/bearer"
    Then response status should be 200

  @api @auth @jwt @token
  Scenario: JWT Token Authentication
    Given user is working with API context "jwt-auth"
    And user sets base URL to "https://httpbin.org"

    # Simulate JWT token (normally this would be obtained from login)
    Given user saves "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c" as "jwtToken"
    And user sets JWT token "{{jwtToken}}"
    When user sends GET request to "/bearer"
    Then response status should be 200

  @api @auth @digest
  Scenario: Digest Authentication
    Given user is working with API context "digest-auth"
    And user sets base URL to "https://httpbin.org"
    And user configures digest authentication with username "testuser" and password "testpass"
    When user sends GET request to "/digest-auth/auth/testuser/testpass"
    Then response status should be 200
    And response JSON path "$.authenticated" should equal true

  @api @auth @certificate @mutual-tls
  Scenario: Certificate-based Authentication (mTLS) - PFX Certificate
    Given user is working with API context "cert-auth"
    And user sets base URL to "https://httpbin.org"
    And user loads certificate from "certificates/client.pfx" with password "test123"
    When user sends GET request to "/get"
    Then response status should be 200
    And response JSON path "$.url" should equal "https://httpbin.org/get"
    And response JSON path "$.headers" should exist
    And response JSON path "$.args" should exist
    And response JSON path "$.origin" should exist
    And response body should contain "httpbin.org"
    And response time should be less than 5000 ms

  @api @auth @aws-signature-v4
  Scenario: AWS Signature V4 Authentication
    Given user is working with API context "aws-sig-v4"
    And user configures AWS Signature V4 with:
      | accessKeyId     | AKIAIOSFODNN7EXAMPLE      |
      | secretAccessKey | wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY |
      | region          | us-east-1                 |
      | service         | execute-api               |

    # Simulate AWS API Gateway call
    Given user sets base URL to "https://httpbin.org"
    When user sends GET request to "/get"
    Then response status should be 200

  @api @auth @ntlm
  Scenario: NTLM Authentication
    Given user is working with API context "ntlm-auth"
    And user sets base URL to "https://httpbin.org"
    And user configures NTLM authentication with:
      | username | testuser    |
      | password | testpass    |
      | domain   | TESTDOMAIN  |
      | workstation | TESTWS   |
    When user sends GET request to "/get"
    Then response status should be 200

  @api @auth @hawk
  Scenario: Hawk Authentication
    Given user is working with API context "hawk-auth"
    And user sets base URL to "https://httpbin.org"
    And user configures Hawk authentication with:
      | id        | dh37fgj492je          |
      | key       | werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn |
      | algorithm | sha256                |
    When user sends GET request to "/get"
    Then response status should be 200

  @api @auth @custom @header-based
  Scenario: Custom Authentication Pattern
    Given user is working with API context "custom-auth"
    And user sets base URL to "https://httpbin.org"
    And user configures custom authentication with function "customAuthHandler"
    And user sets request header "X-Timestamp" with timestamp
    And user sets request header "X-Nonce" with UUID
    And user sets request header "X-Signature" with MD5 hash of "secret-key-{{timestamp}}-{{nonce}}"
    When user sends GET request to "/headers"
    Then response status should be 200
    And response JSON path "$.headers.X-Timestamp" should exist
    And response JSON path "$.headers.X-Nonce" should exist
    And response JSON path "$.headers.X-Signature" should exist

  @api @auth @token-refresh
  Scenario: Token Refresh Flow
    Given user is working with API context "token-refresh"
    And user sets base URL to "https://httpbin.org"

    # Initial login to get tokens
    Given user sets request body to:
      """
      {
        "username": "testuser",
        "password": "testpass"
      }
      """
    When user sends POST request to "/post" and saves response as "login"
    Then response status should be 200

    # Simulate saving tokens from login response
    Given user saves "access-token-12345" as "accessToken"
    And user saves "refresh-token-67890" as "refreshToken"

    # Use access token for protected request
    Given user sets bearer token "{{accessToken}}"
    When user sends GET request to "/bearer" and saves response as "protected-request"
    Then response status should be 200

    # Simulate token expiry and refresh
    Given user sets request body to:
      """
      {
        "grant_type": "refresh_token",
        "refresh_token": "{{refreshToken}}"
      }
      """
    When user sends POST request to "/post" and saves response as "refresh-response"
    Then response status should be 200

    # Use new token
    Given user saves "new-access-token-54321" as "newAccessToken"
    And user sets bearer token "{{newAccessToken}}"
    When user sends GET request to "/bearer"
    Then response status should be 200

  @api @auth @session-cookies
  Scenario: Session Cookie Authentication
    Given user is working with API context "session-auth"
    And user sets base URL to "https://httpbin.org"

    # Login to establish session
    Given user sets request body to:
      """
      {
        "username": "testuser",
        "password": "testpass"
      }
      """
    When user sends POST request to "/cookies/set/sessionid/abc123session"
    Then response status should be 302

    # Subsequent request should include session cookie automatically
    When user sends GET request to "/cookies"
    Then response status should be 200
    And response JSON path "$.cookies.sessionid" should equal "abc123session"

  @api @auth @multi-factor @totp
  Scenario: Multi-Factor Authentication with TOTP
    Given user is working with API context "mfa-auth"
    And user sets base URL to "https://httpbin.org"

    # First factor: username/password
    Given user sets request body to:
      """
      {
        "username": "testuser",
        "password": "testpass"
      }
      """
    When user sends POST request to "/post" and saves response as "first-factor"
    Then response status should be 200

    # Second factor: TOTP code (simulated)
    Given user generates random number between 100000 and 999999 and saves as "totpCode"
    And user sets request body to:
      """
      {
        "totp_code": "{{totpCode}}",
        "session_token": "temp-session-token-123"
      }
      """
    When user sends POST request to "/post" and saves response as "mfa-verification"
    Then response status should be 200

  @api @auth @role-based-access
  Scenario: Role-Based Access Control Testing
    Given user is working with API context "rbac-test"
    And user sets base URL to "https://jsonplaceholder.typicode.com"

    # Test as regular user
    Given user sets bearer token "user-token-123"
    And user sets request header "X-User-Role" to "user"
    When user sends GET request to "/posts/1"
    Then response status should be 200

    # Test as admin user
    Given user sets bearer token "admin-token-456"
    And user sets request header "X-User-Role" to "admin"
    When user sends GET request to "/users"
    Then response status should be 200

    # Test unauthorized access
    Given user sets bearer token "user-token-123"
    And user sets request header "X-User-Role" to "user"
    When user sends DELETE request to "/posts/1"
    # This would normally return 403 for insufficient permissions

  @api @auth @scoped-permissions
  Scenario: Scoped Permission Testing
    Given user is working with API context "scoped-auth"
    And user sets base URL to "https://httpbin.org"

    # Token with read scope
    Given user sets bearer token "read-only-token"
    And user sets request header "X-Scope" to "read"
    When user sends GET request to "/get"
    Then response status should be 200

    # Token with write scope
    Given user sets bearer token "read-write-token"
    And user sets request header "X-Scope" to "read write"
    When user sends POST request to "/post"
    Then response status should be 200

    # Test scope validation
    Given user sets bearer token "read-only-token"
    And user sets request header "X-Scope" to "read"
    When user sends POST request to "/post"
    # This would normally return 403 for insufficient scope