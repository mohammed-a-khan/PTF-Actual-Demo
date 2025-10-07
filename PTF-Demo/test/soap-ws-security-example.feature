@soap @ws-security @authentication
Feature: SOAP Web Services with WS-Security Authentication
  As a QA Engineer
  I want to test SOAP services with various authentication methods
  So that I can validate security implementations

  # NOTE: These are example scenarios demonstrating authentication patterns
  # Replace endpoints and credentials with your actual SOAP services

  @TC001 @basic-auth
  Scenario: SOAP request with HTTP Basic Authentication
    Given I set SOAP version to "1.1"
    And I set SOAP endpoint to "https://secure-api.example.com/service"
    And I set SOAP namespace to "http://example.com/services"
    And I set SOAP action to "http://example.com/GetSecureData"
    When I send SOAP request with Basic Authentication using username "testuser" and password "testpass"
    # Note: Actual request would be sent here if endpoint was real
    # Then the SOAP response status should be 200
    # And the SOAP response should not contain fault

  @TC002 @ws-security-password-text
  Scenario: SOAP request with WS-Security UsernameToken (PasswordText)
    Given I set SOAP version to "1.2"
    And I set SOAP endpoint to "https://secure-api.example.com/service"
    And I set SOAP namespace to "http://example.com/services/v2"
    And I set variable "soapOperation" to "GetUserProfile"
    And I set variable "soap_operation" to "GetUserProfile"
    And I add WS-Security UsernameToken with username "apiuser" and password "apipass123"
    # When I send SOAP request with WS-Security username "apiuser" password "apipass123" type "PasswordText"
    # Then the SOAP response status should be 200
    # And the SOAP response should not contain fault
    # And the SOAP response element "UserProfile" should exist

  @TC003 @ws-security-password-digest
  Scenario: SOAP request with WS-Security UsernameToken (PasswordDigest)
    Given I set SOAP version to "1.2"
    And I set SOAP endpoint to "https://secure-api.example.com/service"
    And I set SOAP namespace to "http://example.com/services/v2"
    And I set variable "soapOperation" to "GetAccountInfo"
    And I set variable "soap_operation" to "GetAccountInfo"
    And I add WS-Security UsernameToken with username "apiuser" and password "apipass123"
    # WS-Security with PasswordDigest is more secure
    # Password is sent as Base64(SHA-1(nonce + created + password))
    # When I send SOAP request with WS-Security username "apiuser" password "apipass123" type "PasswordDigest"
    # Then the SOAP response status should be 200
    # And the SOAP response should not contain fault

  @TC004 @ws-security-timestamp
  Scenario: SOAP request with WS-Security Timestamp
    Given I set SOAP version to "1.1"
    And I set SOAP endpoint to "https://time-sensitive.example.com/service"
    And I set SOAP namespace to "http://example.com/timesensitive"
    And I add WS-Security Timestamp with TTL 300 seconds
    # Timestamp ensures message is fresh and prevents replay attacks
    # TTL = Time to Live in seconds
    # Then SOAP request should include timestamp with created and expires

  @TC005 @ws-security-combined
  Scenario: SOAP request with combined WS-Security (UsernameToken + Timestamp)
    Given I set SOAP version to "1.2"
    And I set SOAP endpoint to "https://secure-api.example.com/banking"
    And I set SOAP namespace to "http://example.com/banking/v3"
    And I set SOAP action to "TransferFunds"
    And I add WS-Security UsernameToken with username "${BANKING_USERNAME}" and password "${BANKING_PASSWORD}"
    And I add WS-Security Timestamp with TTL 120 seconds
    # Combined security headers provide both authentication and freshness
    # When I send SOAP request to "${SOAP_ENDPOINT}" with operation "GetBalance" and parameters:
    #   | parameter   | value      |
    #   | accountId   | ACC-12345  |
    # Then the SOAP response status should be 200
    # And the SOAP response should not contain fault

  @TC006 @auth-failure
  Scenario: SOAP request with invalid credentials should fail
    Given I set SOAP version to "1.1"
    And I set SOAP endpoint to "https://secure-api.example.com/service"
    And I set SOAP namespace to "http://example.com/services"
    And I set variable "soapOperation" to "GetSecureData"
    And I set variable "soap_operation" to "GetSecureData"
    # When I send SOAP request with WS-Security username "invalid" password "wrong" type "PasswordText"
    # Then the SOAP response should contain fault with code "AuthenticationFailed"
    # And the SOAP response should contain fault with message "Invalid credentials"

  @TC007 @token-expiry
  Scenario: SOAP request with expired timestamp should fail
    Given I set SOAP version to "1.2"
    And I set SOAP endpoint to "https://time-sensitive.example.com/service"
    And I set SOAP namespace to "http://example.com/timesensitive"
    And I add WS-Security Timestamp with TTL 1 seconds
    # Wait for timestamp to expire
    # When I wait 2 seconds
    # And I send SOAP request to "${SOAP_ENDPOINT}" with operation "GetData"
    # Then the SOAP response should contain fault with code "MessageExpired"

  @TC008 @environment-variables
  Scenario: Use environment variables for credentials
    Given I set SOAP version to "1.2"
    And I set SOAP endpoint to "${SOAP_SECURE_ENDPOINT}"
    And I set SOAP namespace to "${SOAP_NAMESPACE}"
    And I set SOAP action to "${SOAP_ACTION}"
    # Credentials from environment variables (config/global.env)
    # SOAP_USERNAME=your_username
    # SOAP_PASSWORD=your_password
    # When I send SOAP request with WS-Security username "${SOAP_USERNAME}" password "${SOAP_PASSWORD}" type "PasswordDigest"
    # Then the SOAP response status should be 200

  @TC009 @security-header-validation
  Scenario: Validate WS-Security header in SOAP request
    Given I set SOAP version to "1.1"
    And I set SOAP endpoint to "https://echo.example.com/service"
    And I add WS-Security UsernameToken with username "testuser" and password "testpass"
    And I add WS-Security Timestamp with TTL 300 seconds
    # When I send SOAP request to "${SOAP_ENDPOINT}" with operation "Echo"
    # Then I print SOAP request
    # And SOAP request should contain "wsse:Security"
    # And SOAP request should contain "wsse:UsernameToken"
    # And SOAP request should contain "wsu:Timestamp"

  @TC010 @multiple-auth-methods
  Scenario Outline: Test multiple authentication methods
    Given I set SOAP version to "<soapVersion>"
    And I set SOAP endpoint to "<endpoint>"
    And I set SOAP namespace to "<namespace>"
    And I set variable "soapOperation" to "<operation>"
    And I set variable "soap_operation" to "<operation>"
    # Different auth methods would be tested here
    # When I send SOAP request with <authMethod>
    # Then the SOAP response status should be <expectedStatus>

    Examples:
      | soapVersion | endpoint                           | namespace                    | operation       | authMethod      | expectedStatus |
      | 1.1         | https://api.example.com/service    | http://example.com/v1        | GetUser         | Basic Auth      | 200            |
      | 1.2         | https://api.example.com/service    | http://example.com/v2        | GetUser         | WS-Security     | 200            |
      | 1.1         | https://api.example.com/service    | http://example.com/v1        | GetUser         | No Auth         | 401            |

# ============================================================================
# WS-SECURITY IMPLEMENTATION NOTES:
# ============================================================================
#
# 1. WS-SECURITY STANDARD:
#    - OASIS Web Services Security (WS-Security)
#    - Specification: SOAP Message Security 1.1
#    - Namespace: http://docs.oasis-open.org/wss/2004/01/...
#
# 2. AUTHENTICATION TYPES:
#
#    a) HTTP Basic Authentication:
#       - Username:Password in Authorization header
#       - Base64 encoded
#       - Transport over HTTPS recommended
#       - Step: I send SOAP request with Basic Authentication...
#
#    b) WS-Security UsernameToken (PasswordText):
#       - Username and password in SOAP header
#       - Password sent in clear text (use with HTTPS)
#       - Includes nonce for replay protection
#       - Step: ...type "PasswordText"
#
#    c) WS-Security UsernameToken (PasswordDigest):
#       - Password as Base64(SHA-1(nonce + created + password))
#       - More secure than PasswordText
#       - Includes nonce and timestamp
#       - Step: ...type "PasswordDigest"
#
#    d) WS-Security Timestamp:
#       - Created and Expires timestamps
#       - Prevents replay attacks
#       - TTL (Time To Live) in seconds
#       - Step: I add WS-Security Timestamp with TTL N seconds
#
#    e) Binary Security Token (X.509):
#       - X.509 certificate authentication
#       - For certificate-based security
#       - Requires certificate and private key
#       - (Programmatic usage in code)
#
# 3. SECURITY HEADER STRUCTURE:
#
#    <soap:Envelope>
#      <soap:Header>
#        <wsse:Security>
#          <!-- Timestamp (optional) -->
#          <wsu:Timestamp wsu:Id="Timestamp">
#            <wsu:Created>2025-10-01T12:00:00Z</wsu:Created>
#            <wsu:Expires>2025-10-01T12:05:00Z</wsu:Expires>
#          </wsu:Timestamp>
#
#          <!-- UsernameToken -->
#          <wsse:UsernameToken>
#            <wsse:Username>user</wsse:Username>
#            <wsse:Password Type="...#PasswordDigest">digest</wsse:Password>
#            <wsse:Nonce>base64nonce</wsse:Nonce>
#            <wsu:Created>2025-10-01T12:00:00Z</wsu:Created>
#          </wsse:UsernameToken>
#        </wsse:Security>
#      </soap:Header>
#      <soap:Body>
#        <!-- Operation content -->
#      </soap:Body>
#    </soap:Envelope>
#
# 4. PASSWORD DIGEST CALCULATION:
#    - Algorithm: Base64(SHA-1(nonce + created + password))
#    - nonce: Random bytes, Base64 encoded
#    - created: ISO 8601 timestamp
#    - Implemented in CSSoapSecurityHandler
#
# 5. CONFIGURATION:
#    In config/global.env:
#    ```
#    SOAP_SECURE_ENDPOINT=https://your-service.com/service
#    SOAP_NAMESPACE=http://your-namespace.com
#    SOAP_ACTION=http://your-namespace.com/Operation
#    SOAP_USERNAME=your_username
#    SOAP_PASSWORD=your_password
#    ```
#
# 6. BEST PRACTICES:
#    - Always use HTTPS for SOAP services with authentication
#    - Use PasswordDigest instead of PasswordText when possible
#    - Include Timestamp to prevent replay attacks
#    - Set appropriate TTL (typically 300-600 seconds)
#    - Store credentials in environment variables
#    - Rotate credentials regularly
#    - Validate SOAP faults for authentication errors
#
# 7. COMMON FAULT CODES:
#    - AuthenticationFailed: Invalid credentials
#    - MessageExpired: Timestamp expired
#    - InvalidSecurity: Security header validation failed
#    - InvalidSecurityToken: Token validation failed
#
# 8. DEBUGGING:
#    - Use: I print SOAP request
#    - Use: I print SOAP response
#    - Check security headers in request
#    - Validate timestamp creation/expiry
#    - Check nonce generation
#    - Verify password digest calculation
#
# ============================================================================
