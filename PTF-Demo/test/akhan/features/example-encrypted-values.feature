@example @encryption @interpolation
Feature: Example - Using Encrypted Values and Variable Interpolation
  This feature demonstrates how to use encrypted credentials and variable interpolation
  in the CS Framework test automation

  # IMPORTANT: This is an example feature to demonstrate framework capabilities
  # 
  # 1. ENCRYPTED VALUES:
  #    - Use tools/encryption-tool.html or npx ts-node tools/encrypt-value.ts to encrypt passwords
  #    - Store encrypted values in .env files with ENCRYPTED: prefix
  #    - The framework automatically decrypts them when accessed via config.get()
  #
  # 2. VARIABLE INTERPOLATION:
  #    - Use ${VARIABLE_NAME} syntax in .env files to reference other variables
  #    - Variables are resolved recursively during configuration initialization
  #
  # 3. ACCESSING CONFIG VALUES IN STEP DEFINITIONS:
  #    - Import CSConfigurationManager
  #    - Use config.get('KEY_NAME') to retrieve values (decrypted automatically)

  Background:
    Given I navigate to the Orange HRM application

  @encrypted-credentials
  Scenario: Login with encrypted password from configuration
    # This example shows how to use encrypted passwords stored in config
    # The step definition would use: config.get('ADMIN_PASSWORD_ENCRYPTED')
    # which automatically returns the decrypted value: "admin123"
    When I login with encrypted credentials from config
    Then I should be logged in successfully
    And I should see the Dashboard page

  @variable-interpolation
  Scenario: Navigate using interpolated URLs
    # This example shows how interpolated variables work
    # DASHBOARD_URL in .env is defined as: ${BASE_URL}/dashboard
    # The framework resolves this to the full URL automatically
    When I navigate to the dashboard using interpolated URL
    Then the current URL should match the interpolated dashboard URL

  @config-values
  Scenario: Using configuration values in tests
    # Example of accessing various configuration values
    When I access configuration values in my test
    Then I should see the following resolved values:
      | Config Key                  | Expected Value (Example)                              |
      | APP_NAME                    | OrangeHRM                                             |
      | ENVIRONMENT                 | demo                                                  |
      | BASE_URL                    | https://opensource-demo.orangehrmlive.com/...        |
      | ADMIN_PASSWORD_ENCRYPTED    | admin123 (automatically decrypted)                   |
      | REPORT_TITLE                | OrangeHRM Test Report - demo (interpolated)          |