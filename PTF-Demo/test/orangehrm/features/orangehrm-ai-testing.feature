@orangehrm @ai @demo
Feature: Orange HRM - AI Step Engine Testing (Zero-Step)
  As a QA Engineer using the AI Step Engine
  I want to test the Orange HRM demo application using natural language AI steps
  So that I can verify the zero-step capability without writing custom step definitions

  # =========================================================================
  # SCENARIO 1: Pure AI Steps - Login and Dashboard Verification
  # =========================================================================
  @ai-login @smoke
  Scenario: AI Login - Verify login and dashboard with pure AI steps
    When AI "Navigate to '{config:BASE_URL}'"
    And AI "Type 'Admin' in the Username field"
    And AI "Type '{config:ORANGEHRM_PASSWORD}' in the Password field"
    And AI "Click the Login button"
    Then AI "Verify the Dashboard heading is displayed"

  # =========================================================================
  # SCENARIO 2: Pure AI Steps - Navigation to different modules
  # =========================================================================
  @ai-navigation @regression
  Scenario: AI Navigation - Navigate to Admin module using AI steps
    Given I navigate to the Orange HRM application
    And I enter username "Admin" and password "{config:ORANGEHRM_PASSWORD}"
    And I click on the Login button
    Then AI "Verify the Dashboard heading is displayed"
    When AI "Click the Admin menu item"
    Then AI "Verify the Admin heading is displayed"

  @ai-navigation @regression
  Scenario: AI Navigation - Navigate to PIM module using AI steps
    Given I am logged in to Orange HRM application
    When AI "Click the PIM menu item"
    Then AI "Verify the PIM heading is displayed"

  @ai-navigation @regression
  Scenario: AI Navigation - Navigate to Leave module using AI steps
    Given I am logged in to Orange HRM application
    When AI "Click the Leave menu item"
    Then AI "Verify the Leave heading is displayed"

  # =========================================================================
  # SCENARIO 3: AI Query Steps - Extract information from the page
  # =========================================================================
  @ai-query @regression
  Scenario: AI Query - Get and store the dashboard heading text
    Given I am logged in to Orange HRM application
    When AI "Get the text from the Dashboard heading" and store as "dashboardTitle"
    Then AI "Verify the Dashboard heading is displayed"

  # =========================================================================
  # SCENARIO 4: Hybrid - Mix AI steps with custom steps
  # =========================================================================
  @ai-hybrid @smoke
  Scenario: Hybrid - Login with custom steps, verify with AI steps
    Given I navigate to the Orange HRM application
    When I enter username "Admin" and password "{config:ORANGEHRM_PASSWORD}"
    And I click on the Login button
    # AI steps for assertions - no custom step code needed
    Then AI "Verify the Dashboard heading is displayed"
    When AI "Click the PIM menu item"
    Then AI "Verify the PIM heading is displayed"
    # Back to custom step for URL verification
    And the URL should contain "pim"

  # =========================================================================
  # SCENARIO 5: AI Steps - Invalid login verification
  # =========================================================================
  @ai-negative @negative
  Scenario: AI Negative - Verify error message on invalid login
    When AI "Navigate to '{config:BASE_URL}'"
    And AI "Type 'InvalidUser' in the Username field"
    And AI "Type 'wrongpassword' in the Password field"
    And AI "Click the Login button"
    Then AI "Verify the 'Invalid credentials' message is displayed"

  # =========================================================================
  # SCENARIO 6: AI Steps with value injection
  # =========================================================================
  @ai-value @regression
  Scenario: AI Value - Type using explicit value parameter
    Given I navigate to the Orange HRM application
    When AI "Type in the Username field" with value "Admin"
    And AI "Type in the Password field" with value "{config:ORANGEHRM_PASSWORD}"
    And AI "Click the Login button"
    Then AI "Verify the Dashboard heading is displayed"

  # =========================================================================
  # SCENARIO 7: Data-driven AI steps with Scenario Outline
  # =========================================================================
  @ai-data-driven @regression
  Scenario Outline: AI Data-Driven - Navigate to <moduleName> module
    Given I am logged in to Orange HRM application
    When AI "Click the <moduleName> menu item"
    Then AI "Verify the <moduleName> heading is displayed"

    Examples:
      | moduleName  |
      | Admin       |
      | PIM         |
      | Leave       |
      | Time        |
      | Recruitment |

  # =========================================================================
  # SCENARIO 8: AI Steps - Logout flow
  # =========================================================================
  @ai-logout @smoke
  Scenario: AI Logout - Full login and logout cycle using AI steps
    Given I am logged in to Orange HRM application
    Then AI "Verify the Dashboard heading is displayed"
    When AI "Click the user dropdown"
    And AI "Click the Logout menu item"
    Then AI "Verify the Login button is displayed"

  # =========================================================================
  # SCENARIO 9: AI Steps with Browser Switch
  # =========================================================================
  @ai-browser-switch @regression
  Scenario: AI Browser Switch - Login in Chrome then switch to Firefox and verify
    # Login using AI steps in default browser (Chrome)
    Given I am logged in to Orange HRM application
    Then AI "Verify the Dashboard heading is displayed"
    When AI "Click the PIM menu item"
    Then AI "Verify the PIM heading is displayed"

    # Switch browser - session is NOT preserved (new browser = fresh context)
    When user switches to "firefox" browser
    Then I should be on the login page
    And the current browser should be "firefox"

    # Login again in Firefox using AI steps
    When AI "Type 'Admin' in the Username field"
    And AI "Type '{config:ORANGEHRM_PASSWORD}' in the Password field"
    And AI "Click the Login button"
    Then AI "Verify the Dashboard heading is displayed"

  # =========================================================================
  # SCENARIO 10: AI Steps with Browser Switch and Context Clear
  # =========================================================================
  @ai-browser-switch-context @regression
  Scenario: AI Browser Switch Context - Clear context and re-authenticate using AI
    Given I am logged in to Orange HRM application
    Then AI "Verify the Dashboard heading is displayed"

    # Clear browser context (logout without clicking logout)
    When user clears browser context for re-authentication
    Then I should be on the login page

    # Re-authenticate using AI steps
    When AI "Type 'Admin' in the Username field"
    And AI "Type '{config:ORANGEHRM_PASSWORD}' in the Password field"
    And AI "Click the Login button"
    Then AI "Verify the Dashboard heading is displayed"

  # =========================================================================
  # SCENARIO 11: AI Steps with External CSV Data Source
  # =========================================================================
  @ai-csv-data @data-driven @regression
  Scenario Outline: AI CSV Data-Driven - Navigate to <moduleName> module using CSV data
    Given I am logged in to Orange HRM application
    When AI "Click the <menuItem> menu item"
    Then AI "Verify the <expectedHeading> heading is displayed"

    Examples: {"type": "csv", "source": "test/orangehrm/data/ai-navigation.csv", "delimiter": ","}

  # =========================================================================
  # SCENARIO 12: AI Steps with External JSON Data Source
  # =========================================================================
  @ai-json-data @data-driven @regression
  Scenario Outline: AI JSON Data-Driven - Navigate to <moduleName> module using JSON data
    Given I am logged in to Orange HRM application
    When AI "Click the <menuItem> menu item"
    Then AI "Verify the <expectedHeading> heading is displayed"

    Examples: {"type": "json", "source": "test/orangehrm/data/ai-navigation.json", "path": "$.modules[*]"}

  # =========================================================================
  # SCENARIO 13: AI Steps with External XML Data Source
  # =========================================================================
  @ai-xml-data @data-driven @regression
  Scenario Outline: AI XML Data-Driven - Navigate to <moduleName> module using XML data
    Given I am logged in to Orange HRM application
    When AI "Click the <menuItem> menu item"
    Then AI "Verify the <expectedHeading> heading is displayed"

    Examples: {"type": "xml", "source": "test/orangehrm/data/ai-navigation.xml", "xpath": "//module"}

  # =========================================================================
  # SCENARIO 14: AI Steps with @DataProvider Tag
  # =========================================================================
  @ai-dataprovider @data-driven @regression
  @DataProvider(source="test/orangehrm/data/ai-login.csv", type="csv", filter="expectedResult=success")
  Scenario Outline: AI DataProvider - Login with filtered CSV data
    When AI "Navigate to '{config:BASE_URL}'"
    And AI "Type '<username>' in the Username field"
    And AI "Type '<password>' in the Password field"
    And AI "Click the Login button"
    Then AI "Verify the Dashboard heading is displayed"

  # =========================================================================
  # SCENARIO 15: AI Steps with Conditional Execution
  # =========================================================================
  @ai-conditional @regression
  Scenario: AI Conditional - Execute steps based on runtime flags
    Given I am logged in to Orange HRM application
    Then AI "Verify the Dashboard heading is displayed"
    # Store a flag to control conditional execution
    When AI "Get the text from the Dashboard heading" and store as "currentPage"
    # This step only runs if currentPage stored successfully
    Then AI "Click the Admin menu item" if "currentPage" is "Dashboard"
    And AI "Verify the Admin heading is displayed"

  # =========================================================================
  # SCENARIO 16: AI Steps with Query and Variable Reuse
  # =========================================================================
  @ai-query-reuse @regression
  Scenario: AI Query Reuse - Extract data and use in subsequent steps
    Given I am logged in to Orange HRM application
    # Extract page title using AI query
    When AI "Get the text from the Dashboard heading" and store as "pageTitle"
    # Navigate to another module
    And AI "Click the PIM menu item"
    Then AI "Verify the PIM heading is displayed"
    # Extract new page title
    When AI "Get the text from the PIM heading" and store as "newPageTitle"
    # Navigate to another module to verify continued operation
    And AI "Click the Leave menu item"
    Then AI "Verify the Leave heading is displayed"
